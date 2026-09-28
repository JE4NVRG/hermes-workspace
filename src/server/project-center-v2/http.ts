/**
 * Camada HTTP do Project Center v2 (PR 4).
 *
 * Expõe os nove `operationId` do contrato canônico com o pipeline fechado:
 *
 * 1. flag `PROJECT_CENTER_V2_ENABLED` (default desligado) — desligada, nenhuma
 *    rota v2 abre store, observer ou executor (`feature_disabled`, 403);
 * 2. roteamento pelo manifest (método + caminho contratual);
 * 3. `Content-Type: application/json` em toda mutação;
 * 4. **teto de corpo** (64 KiB, spec §10): `Content-Length` acima do teto é
 *    recusado antes de ler; sem `Content-Length`, a leitura é incremental e
 *    para no teto — nos dois casos antes de qualquer I/O de store;
 * 5. bearer token com as claims canônicas (`sub`, `actor_type`) — 401 sem
 *    identidade válida;
 * 6. **segregação de ator**: operação de decisão exige `actor_type = human`
 *    (403 `FORBIDDEN`, zero side effect) antes de qualquer leitura de estado;
 * 7. policy engine do PR 1 (default deny): role/scope/ambiente por
 *    `operationId`;
 * 8. leitura do corpo com teto, **antes** de idempotência, observer e limite;
 * 9. `Idempotency-Key` obrigatória nas 7 mutações + limite por ator com o
 *    teto canônico por `operationId` (10/min no dry-run e 5/min nas outras
 *    seis, spec §10.1) → 429 com `Retry-After` em segundos;
 * 10. `If-Match` obrigatório nas operações sobre uma operação existente;
 * 11. corpo validado por schema estrito (`additionalProperties: false`);
 * 12. toda operação sobre uma operação existente confere a claim
 *    `environment` do token contra o ambiente alvo (403 sem side effect);
 * 13. escrita atômica (operação + auditoria + outbox + aprovação) pela unidade
 *    de trabalho do `idempotency.ts`; `execute`/`verify`/`rollback execute`
 *    apenas **enfileiram** — nenhum executor existe no PR 4.
 *
 * Toda resposta (inclusive de erro) é sanitizada antes de sair: o corpo passa
 * pelo catálogo de redaction e nenhum `SecretRef` integral aparece fora de um
 * campo tipado `ArtifactRef`. Violação disso falha fechado (500) em vez de
 * vazar o valor.
 */
import { randomUUID } from 'node:crypto'
import {
  ERROR_CODES,
  approvalRequestSchema,
  dryRunRequestSchema,
  executeRequestSchema,
  rollbackApprovalRequestSchema,
  rollbackDryRunRequestSchema,
  rollbackExecuteRequestSchema,
  verifyRequestSchema,
} from './domain'
import {
  PROJECT_CENTER_V2_FLAG,
  PROJECT_CENTER_V2_WORKER_FLAG,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { hashIdempotencyKey, hashRequestPayload } from './idempotency'
import { buildNamingSnapshot } from './naming'
import { planProject } from './planner'
import { OPERATION_REQUIRED_SCOPES, evaluatePolicy } from './policy'
import { isSecretRef, redactText, toSafePayload } from './redaction'
import { assertTransition } from './state-machine'
import {
  ApprovalHashMismatchError,
  ApprovalSegregationError,
  ApprovalStateError,
  OperationLockedError,
  RollbackUnsafeError,
  actorRefFor,
  assertApprovalUsable,
  assertRollbackApprovalUsable,
  buildRollbackPlan,
  createOperationProjection,
  evaluateOperationApproval,
  evaluateRollbackApproval,
} from './approval-service'
import type {
  ActorType,
  ApprovalRequest,
  Driver,
  DryRunRequest,
  Environment,
  ErrorCode,
  ExecuteRequest,
  Operation,
  ProjectIntent,
  RollbackApprovalRequest,
  RollbackDryRunRequest,
  RollbackExecuteRequest,
  VerifyRequest,
} from './domain'
import type { AuditAppendInput, AuditStore } from './audit-store'
import type {
  CompensableWrite,
  IdempotencyStore,
  OutboxStore,
  TransactionPlan,
} from './idempotency'
import type { CreateOperationInput, OperationStore } from './operation-store'
import type { DryRunDriver, ObservedState } from './drivers/types'
import type { ProjectCenterV2Flags } from './feature-flags'
import type {
  OperationApprovalStore,
  OperationOwnershipStore,
  RollbackObservation,
  RollbackPlanStore,
  RollbackPlanningPort,
} from './approval-service'
import type {
  PolicyActorClaims,
  ProjectRole,
  ProjectScope,
  SegregationPolicyName,
} from './policy'
import type { OperationState } from './state-machine'

// ---------------------------------------------------------------------------
// URLs e limites
// ---------------------------------------------------------------------------

/** Prefixo da superfície v2 na aplicação (plano, regra global 4). */
export const PROJECT_CENTER_V2_API_PREFIX = '/api/project-center/v2'
/** Raiz das operações; também é a base dos `status_url`/`audit_url`. */
export const PROJECT_CENTER_V2_OPERATIONS_PATH = `${PROJECT_CENTER_V2_API_PREFIX}/operations`
/** Nome contratual do cabeçalho de idempotência. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
/** Cabeçalho de versão otimista. */
export const IF_MATCH_HEADER = 'If-Match'
/** Cabeçalho de correlação. */
export const REQUEST_ID_HEADER = 'X-Request-Id'
/**
 * Teto global do limite por ator (default do port in-memory).
 *
 * O teto efetivo de uma mutação é o **menor** entre este valor e o teto
 * canônico da operação (`RATE_LIMIT_MAX_BY_OPERATION`, spec §10.1): um port
 * injetado nunca afrouxa o contrato, só aperta.
 */
export const RATE_LIMIT_MAX_REQUESTS = 30
/** Janela do limite por ator, em segundos (o `Retry-After` sai nesta unidade). */
export const RATE_LIMIT_WINDOW_SECONDS = 60
/** Teto de `createProjectDryRun`: `dry-runs por ator` = 10/min (spec §10.1). */
export const RATE_LIMIT_MAX_DRY_RUN = 10
/** Teto das outras seis mutações: `mutações por ator` = 5/min (spec §10.1). */
export const RATE_LIMIT_MAX_MUTATION = 5
/** Teto de corpo HTTP: `body HTTP` = 64 KiB (spec §10). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024
/** Cabeçalho de tamanho declarado do corpo. */
export const CONTENT_LENGTH_HEADER = 'content-length'
/** Teto de itens por página de auditoria (contrato). */
export const AUDIT_MAX_LIMIT = 500
/** Corpo literal quando a superfície está desligada (plano, deploy passo 2). */
export const FEATURE_DISABLED_MESSAGE = 'feature_disabled'

// ---------------------------------------------------------------------------
// Manifest das nove operações
// ---------------------------------------------------------------------------

export interface OperationRouteDefinition {
  readonly operationId: string
  readonly method: 'GET' | 'POST'
  /** Caminho relativo ao `servers[0].url` do contrato. */
  readonly contractPath: string
  /** Caminho montado na aplicação (prefixo v2 + caminho contratual). */
  readonly path: string
  /** Arquivo de rota correspondente (evidência do contract test). */
  readonly file: string
  /** Schema do request body no OpenAPI (`null` quando não há corpo). */
  readonly requestSchema: string | null
  /** Schema 2xx de resposta declarado para a operação. */
  readonly responseSchema: string
  readonly successStatuses: ReadonlyArray<number>
  /** Status do replay idempotente (declarado no contrato). */
  readonly replayStatus: number
  readonly requiresIdempotencyKey: boolean
  readonly requiresIfMatch: boolean
  readonly segregation: SegregationPolicyName | null
  readonly requestBodyRequired: boolean
}

const ROUTE_FILES = {
  dryRun: 'src/routes/api/project-center/v2/operations/dry-run.ts',
  operation: 'src/routes/api/project-center/v2/operations/$operationId.ts',
  approval:
    'src/routes/api/project-center/v2/operations/$operationId/approve.ts',
  execute:
    'src/routes/api/project-center/v2/operations/$operationId/execute.ts',
  verify: 'src/routes/api/project-center/v2/operations/$operationId/verify.ts',
  audit: 'src/routes/api/project-center/v2/operations/$operationId/audit.ts',
  rollbackDryRun:
    'src/routes/api/project-center/v2/operations/$operationId/rollback/dry-run.ts',
  rollbackApproval:
    'src/routes/api/project-center/v2/operations/$operationId/rollback/approve.ts',
  rollbackExecute:
    'src/routes/api/project-center/v2/operations/$operationId/rollback/execute.ts',
} as const

function route(definition: OperationRouteDefinition): OperationRouteDefinition {
  return Object.freeze({ ...definition })
}

/**
 * As nove operações do contrato, na ordem em que aparecem no OpenAPI.
 *
 * `contractPath` é comparado literalmente com `paths` do contrato e `path` é o
 * caminho montado (`PROJECT_CENTER_V2_OPERATIONS_PATH` + sufixo contratual).
 */
export const PROJECT_CENTER_V2_ROUTES: ReadonlyArray<OperationRouteDefinition> =
  Object.freeze([
    route({
      operationId: 'createProjectDryRun',
      method: 'POST',
      contractPath: '/operations/dry-run',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/dry-run`,
      file: ROUTE_FILES.dryRun,
      requestSchema: 'DryRunRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [201, 200],
      replayStatus: 200,
      requiresIdempotencyKey: true,
      requiresIfMatch: false,
      segregation: null,
      requestBodyRequired: true,
    }),
    route({
      operationId: 'decideProjectOperationApproval',
      method: 'POST',
      contractPath: '/operations/{operation_id}/approve',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/approve`,
      file: ROUTE_FILES.approval,
      requestSchema: 'ApprovalRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [200],
      replayStatus: 200,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: 'production_approval',
      requestBodyRequired: true,
    }),
    route({
      operationId: 'executeProjectOperation',
      method: 'POST',
      contractPath: '/operations/{operation_id}/execute',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/execute`,
      file: ROUTE_FILES.execute,
      requestSchema: 'ExecuteRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [202],
      replayStatus: 202,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: null,
      requestBodyRequired: true,
    }),
    route({
      operationId: 'getProjectOperation',
      method: 'GET',
      contractPath: '/operations/{operation_id}',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}`,
      file: ROUTE_FILES.operation,
      requestSchema: null,
      responseSchema: 'OperationResponse',
      successStatuses: [200],
      replayStatus: 200,
      requiresIdempotencyKey: false,
      requiresIfMatch: false,
      segregation: null,
      requestBodyRequired: false,
    }),
    route({
      operationId: 'verifyProjectOperation',
      method: 'POST',
      contractPath: '/operations/{operation_id}/verify',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/verify`,
      file: ROUTE_FILES.verify,
      requestSchema: 'VerifyRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [202],
      replayStatus: 202,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: null,
      requestBodyRequired: false,
    }),
    route({
      operationId: 'createProjectRollbackDryRun',
      method: 'POST',
      contractPath: '/operations/{operation_id}/rollback/dry-run',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/rollback/dry-run`,
      file: ROUTE_FILES.rollbackDryRun,
      requestSchema: 'RollbackDryRunRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [201],
      replayStatus: 201,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: null,
      requestBodyRequired: true,
    }),
    route({
      operationId: 'decideProjectRollbackApproval',
      method: 'POST',
      contractPath: '/operations/{operation_id}/rollback/approve',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/rollback/approve`,
      file: ROUTE_FILES.rollbackApproval,
      requestSchema: 'RollbackApprovalRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [200],
      replayStatus: 200,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: 'destructive_rollback',
      requestBodyRequired: true,
    }),
    route({
      operationId: 'executeProjectRollback',
      method: 'POST',
      contractPath: '/operations/{operation_id}/rollback/execute',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/rollback/execute`,
      file: ROUTE_FILES.rollbackExecute,
      requestSchema: 'RollbackExecuteRequest',
      responseSchema: 'OperationResponse',
      successStatuses: [202],
      replayStatus: 202,
      requiresIdempotencyKey: true,
      requiresIfMatch: true,
      segregation: null,
      requestBodyRequired: true,
    }),
    route({
      operationId: 'listProjectOperationAudit',
      method: 'GET',
      contractPath: '/operations/{operation_id}/audit',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/{operation_id}/audit`,
      file: ROUTE_FILES.audit,
      requestSchema: null,
      responseSchema: 'AuditPage',
      successStatuses: [200],
      replayStatus: 200,
      requiresIdempotencyKey: false,
      requiresIfMatch: false,
      segregation: null,
      requestBodyRequired: false,
    }),
  ])

export function projectCenterV2RouteFor(
  operationId: string,
): OperationRouteDefinition {
  const found = PROJECT_CENTER_V2_ROUTES.find(
    (candidate) => candidate.operationId === operationId,
  )
  if (found === undefined) {
    throw new Error(`operacao contratual desconhecida: ${operationId}`)
  }
  return found
}

/** Rotas mutantes: as sete que exigem `Idempotency-Key` e limite por ator. */
export const PROJECT_CENTER_V2_MUTATIONS: ReadonlyArray<OperationRouteDefinition> =
  Object.freeze(
    PROJECT_CENTER_V2_ROUTES.filter((candidate) => candidate.method === 'POST'),
  )

/**
 * Teto canônico por ator+minuto das sete mutações (spec §10.1).
 *
 * Fonte única do limite de borda: `createProjectDryRun` 10/min e as outras
 * seis 5/min. Mutação sem entrada aqui é furo de configuração e a borda falha
 * fechado (500) em vez de liberar tráfego sem limite.
 */
export const RATE_LIMIT_MAX_BY_OPERATION: Readonly<
  Partial<Record<string, number>>
> = Object.freeze({
  createProjectDryRun: RATE_LIMIT_MAX_DRY_RUN,
  decideProjectOperationApproval: RATE_LIMIT_MAX_MUTATION,
  executeProjectOperation: RATE_LIMIT_MAX_MUTATION,
  verifyProjectOperation: RATE_LIMIT_MAX_MUTATION,
  createProjectRollbackDryRun: RATE_LIMIT_MAX_MUTATION,
  decideProjectRollbackApproval: RATE_LIMIT_MAX_MUTATION,
  executeProjectRollback: RATE_LIMIT_MAX_MUTATION,
})

function segmentsOf(path: string): ReadonlyArray<string> {
  return path.split('/').filter((segment) => segment.length > 0)
}

export interface RouteMatch {
  readonly route: OperationRouteDefinition
  readonly params: { readonly operation_id?: string }
}

/** Casa método + caminho com o manifest, capturando `operation_id`. */
export function matchProjectCenterV2Route(
  method: string,
  pathname: string,
): RouteMatch | null {
  const expectedSegments = segmentsOf(pathname)
  for (const candidate of PROJECT_CENTER_V2_ROUTES) {
    if (candidate.method !== method.toUpperCase()) continue
    const candidateSegments = segmentsOf(candidate.path)
    if (candidateSegments.length !== expectedSegments.length) continue
    let operationId: string | undefined
    let matched = true
    for (const [index, segment] of candidateSegments.entries()) {
      const actual = expectedSegments[index]
      if (segment === '{operation_id}') {
        if (actual.length === 0) matched = false
        else operationId = actual
        continue
      }
      if (segment !== actual) {
        matched = false
        break
      }
    }
    if (!matched) continue
    return {
      route: candidate,
      params: operationId === undefined ? {} : { operation_id: operationId },
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Portas injetadas (nenhum I/O real neste PR)
// ---------------------------------------------------------------------------

export interface ProjectCenterV2TokenClaims {
  readonly subject: string
  readonly actorType: ActorType
  readonly role: ProjectRole
  readonly scopes: ReadonlyArray<ProjectScope>
  /** Ambiente ao qual o token está restrito. */
  readonly environment: Environment
  /** Identificador opaco do token, usado só para o limite por ator. */
  readonly tokenId: string
}

/** Verificador de token scoped; `null` significa token inválido. */
export interface ProjectCenterV2TokenVerifier {
  verify: (rawToken: string) => ProjectCenterV2TokenClaims | null
}

export interface RateLimitPort {
  /**
   * `true` quando a requisição é permitida.
   *
   * `maxPerWindow` é o teto canônico da operação (spec §10.1); o port aplica no
   * máximo esse teto — nunca mais — e pode ser configurado com um teto global
   * menor (ver `InMemoryRateLimitPort`).
   */
  allow: (key: string, maxPerWindow: number) => boolean
}

export interface LeaseGuard {
  /** Holder atual do lease exclusivo, ou `null` quando livre. */
  holder: (operationId: string) => { readonly holder_ref: string } | null
}

export interface DryRunObservationPort {
  observe: (input: {
    readonly intent: ProjectIntent
    readonly naming: ReturnType<typeof buildNamingSnapshot>
  }) => Promise<ObservedState>
}

/** Porta fechada: o PR 4 não abre conexão administrativa nenhuma. */
export class ObservationUnavailableError extends Error {
  readonly code: ErrorCode = 'DRIVER_UNAVAILABLE'
  readonly status = 422

  constructor() {
    super('porta de observacao nao configurada')
    this.name = 'ObservationUnavailableError'
  }
}

export function createClosedObservationPort(): DryRunObservationPort {
  return {
    observe: () => Promise.reject(new ObservationUnavailableError()),
  }
}

/**
 * Verificador default do runtime: nenhum provedor de token scoped está
 * configurado neste PR, então **todo** token é recusado (fail closed, 401).
 * O provedor real (claims `sub`/`actor_type`) é injetado pelo deployment.
 */
export function createDenyAllVerifier(): ProjectCenterV2TokenVerifier {
  return { verify: () => null }
}

export function createOpenRateLimitPort(): RateLimitPort {
  return { allow: () => true }
}

export interface CommitHooksPort {
  readonly afterCommit?: (result: unknown) => void
}

export interface ProjectCenterV2Deps {
  readonly flags: ProjectCenterV2Flags
  readonly verifier: ProjectCenterV2TokenVerifier
  readonly operations: OperationStore
  readonly audit: AuditStore
  readonly idempotency: IdempotencyStore
  readonly outbox: OutboxStore
  readonly approvals: OperationApprovalStore
  readonly rollbackPlans: RollbackPlanStore
  readonly ownership: OperationOwnershipStore
  readonly observations: DryRunObservationPort
  readonly rollbackObservations: RollbackPlanningPort
  /** Registro de drivers de dry-run usado pelo planner (default: PR 2). */
  readonly drivers?: Readonly<Partial<Record<Driver, DryRunDriver>>>
  readonly lease: LeaseGuard
  readonly rateLimiter: RateLimitPort
  readonly now?: () => Date
  readonly generateId?: () => string
  /** Hook de teste: executa entre o commit durável e o registro da resposta. */
  readonly commitHooks?: CommitHooksPort
}

export class InMemoryRateLimitPort implements RateLimitPort {
  private readonly hits = new Map<string, Array<number>>()

  constructor(
    private readonly max = RATE_LIMIT_MAX_REQUESTS,
    private readonly windowSeconds = RATE_LIMIT_WINDOW_SECONDS,
  ) {}

  allow(key: string, maxPerWindow: number): boolean {
    const now = Date.now()
    const windowMs = this.windowSeconds * 1000
    // O teto configurado é um piso de aperto: nunca acima do teto canônico.
    const limit = Math.min(this.max, maxPerWindow)
    const current = (this.hits.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    )
    if (current.length >= limit) {
      this.hits.set(key, current)
      return false
    }
    current.push(now)
    this.hits.set(key, current)
    return true
  }
}

export const OPEN_LEASE_GUARD: LeaseGuard = Object.freeze({
  holder: () => null,
})

// ---------------------------------------------------------------------------
// Normalização de erro e respostas
// ---------------------------------------------------------------------------

/** Status canônico por código de erro do contrato. */
export const ERROR_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> =
  Object.freeze({
    INVALID_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    POLICY_DENIED: 422,
    NAMING_CONFLICT: 409,
    QUOTA_EXCEEDED: 422,
    IDEMPOTENCY_KEY_REUSED: 409,
    PLAN_STALE: 409,
    APPROVAL_REQUIRED: 409,
    APPROVAL_EXPIRED: 410,
    INVALID_STATE_TRANSITION: 409,
    OPERATION_LOCKED: 423,
    DRIVER_UNAVAILABLE: 422,
    EXECUTION_FAILED: 500,
    VERIFICATION_FAILED: 500,
    ROLLBACK_NOT_SAFE: 422,
    MANUAL_INTERVENTION_REQUIRED: 409,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
  })

/** Mensagem pública por código: catálogo fechado, nunca a mensagem interna. */
const PUBLIC_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'requisicao invalida',
  UNAUTHORIZED: 'token ausente ou invalido',
  FORBIDDEN: 'acesso negado',
  NOT_FOUND: 'recurso nao encontrado',
  POLICY_DENIED: 'intencao fora da policy',
  NAMING_CONFLICT: 'conflito de identificacao',
  QUOTA_EXCEEDED: 'cota excedida',
  IDEMPOTENCY_KEY_REUSED: 'chave de idempotencia reutilizada',
  PLAN_STALE: 'plano obsoleto',
  APPROVAL_REQUIRED: 'aprovacao obrigatoria',
  APPROVAL_EXPIRED: 'aprovacao ou plano expirado',
  INVALID_STATE_TRANSITION: 'transicao de estado invalida',
  OPERATION_LOCKED: 'operacao com lease exclusivo',
  DRIVER_UNAVAILABLE: 'driver indisponivel',
  EXECUTION_FAILED: 'falha na execucao',
  VERIFICATION_FAILED: 'falha na verificacao',
  ROLLBACK_NOT_SAFE: 'rollback nao seguro',
  MANUAL_INTERVENTION_REQUIRED: 'intervencao manual necessaria',
  RATE_LIMITED: 'limite por ator excedido',
  INTERNAL_ERROR: 'erro interno',
})

export interface ErrorDetail {
  readonly field?: string
  readonly reason: string
}

export interface SanitizedError {
  readonly status: number
  readonly code: ErrorCode
  readonly details: ReadonlyArray<ErrorDetail>
  /** Motivo interno (nunca serializado) para log do chamador. */
  readonly internal_reason: string
}

/** Erro de corpo inválido (schema estrito do contrato). */
export class InvalidRequestBodyError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly status = 400
  readonly details: ReadonlyArray<ErrorDetail>

  constructor(details: ReadonlyArray<ErrorDetail>) {
    super('corpo da requisicao invalido')
    this.name = 'InvalidRequestBodyError'
    this.details = details
  }
}

/**
 * Corpo acima do teto do contrato (`body HTTP` 64 KiB, spec §10).
 *
 * O contrato declara `400` (nunca `413`) para corpo grande demais. O campo do
 * detalhe é `content-length` quando o tamanho foi declarado e `body` quando só
 * a leitura incremental revelou o excesso.
 */
export class RequestBodyTooLargeError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly status = 400
  readonly details: ReadonlyArray<ErrorDetail>
  readonly field: string

  constructor(field: string) {
    super('corpo da requisicao acima do teto')
    this.name = 'RequestBodyTooLargeError'
    this.field = field
    this.details = [{ field, reason: 'too_large' }]
  }
}

/** Operação inexistente ou invisível ao ator. */
export class OperationNotFoundFailure extends Error {
  readonly code: ErrorCode = 'NOT_FOUND'
  readonly status = 404

  constructor() {
    super('operacao nao encontrada')
    this.name = 'OperationNotFoundFailure'
  }
}

/** Ambiente do token diferente do ambiente alvo da requisição. */
export class EnvironmentMismatchError extends Error {
  readonly code: ErrorCode = 'FORBIDDEN'
  readonly status = 403

  constructor() {
    super('ambiente do token diferente do alvo')
    this.name = 'EnvironmentMismatchError'
  }
}

function codeOf(error: unknown): ErrorCode | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = (error as { code?: unknown }).code
  if (
    typeof candidate === 'string' &&
    (ERROR_CODES as ReadonlyArray<string>).includes(candidate)
  ) {
    return candidate as ErrorCode
  }
  return null
}

function statusOf(error: unknown, code: ErrorCode): number {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { status?: unknown }).status
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate
    }
  }
  return ERROR_STATUS_BY_CODE[code]
}

function detailsOf(error: unknown): ReadonlyArray<ErrorDetail> {
  if (typeof error !== 'object' || error === null) return []
  const candidate = (error as { details?: unknown }).details
  if (!Array.isArray(candidate)) return []
  return candidate
    .filter(
      (detail): detail is Record<string, unknown> =>
        typeof detail === 'object' && detail !== null,
    )
    .map((detail) => ({
      ...(typeof detail.field === 'string' ? { field: detail.field } : {}),
      reason: typeof detail.reason === 'string' ? detail.reason : 'unknown',
    }))
}

/**
 * Converte qualquer falha em resposta tipada sem vazar detalhe interno.
 * Código fora do catálogo do contrato (inclusive `feature_disabled`) é tratado
 * como falha fechada e nunca é ecoado ao cliente.
 */
export function normalizeError(error: unknown): SanitizedError {
  const code = codeOf(error) ?? 'INTERNAL_ERROR'
  const details = [
    ...(error instanceof InvalidRequestBodyError ? error.details : []),
    ...detailsOf(error),
  ]
  return {
    status: statusOf(error, code),
    code,
    details,
    internal_reason:
      code === 'INTERNAL_ERROR'
        ? `unmapped:${error instanceof Error ? error.name : typeof error}`
        : code,
  }
}

/** Sanitiza texto (catálogo de redaction) aplicando teto do contrato. */
function sanitizeDetail(detail: ErrorDetail): ErrorDetail {
  return {
    ...(detail.field === undefined
      ? {}
      : { field: redactText(detail.field).slice(0, 120) }),
    reason: redactText(detail.reason).slice(0, 120),
  }
}

export function sanitizeError(error: unknown): SanitizedError {
  const normalized = normalizeError(error)
  return Object.freeze({
    status: normalized.status,
    code: normalized.code,
    details: Object.freeze(normalized.details.slice(0, 20).map(sanitizeDetail)),
    internal_reason: normalized.internal_reason,
  })
}

export interface JsonResponseInit {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Serializa a resposta garantindo que nenhum `SecretRef` integral saia fora de
 * um campo tipado. Violação falha fechado com 500 `INTERNAL_ERROR`.
 */
export function buildJsonResponse(
  body: unknown,
  init: JsonResponseInit,
): Response {
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  }
  if (!hasUnboundSecretRef(body)) {
    return new Response(JSON.stringify(body), {
      status: init.status,
      headers,
    })
  }
  return new Response(
    JSON.stringify(
      errorBody(
        {
          status: 500,
          code: 'INTERNAL_ERROR',
          details: [],
          internal_reason: 'unbound_secret_ref',
        },
        'redacted',
      ),
    ),
    { status: 500, headers },
  )
}

/**
 * Verdadeiro quando o corpo contém token `sref_` fora de campo tipado.
 * Campo permitido: `operation.artifacts[<n>].ref` (schema condicional do
 * contrato garante `type: secret_ref` nesse caminho).
 */
export function hasUnboundSecretRef(value: unknown): boolean {
  return scanForUnboundSecretRef(value, [])
}

/**
 * Sequência exata (raiz + coleção + índice + folha) do único caminho que o
 * contrato tipa como `ArtifactRef` com `type: secret_ref`.
 *
 * Comparar o caminho inteiro — e não apenas os três últimos segmentos — é o
 * que impede que um `sref_` escondido em `plan.x.artifacts[0].ref`, em
 * qualquer profundidade, atravesse a borda: fora desta raiz o valor é texto
 * livre e falha fechado (500 `INTERNAL_ERROR`).
 */
function isAllowedSecretRefPath(path: ReadonlyArray<string | number>): boolean {
  if (path.length !== 4) return false
  const [root, collection, index, leaf] = path
  return (
    root === 'operation' &&
    collection === 'artifacts' &&
    typeof index === 'number' &&
    leaf === 'ref'
  )
}

function scanForUnboundSecretRef(
  value: unknown,
  path: ReadonlyArray<string | number>,
): boolean {
  if (typeof value === 'string') {
    return isSecretRef(value) && !isAllowedSecretRefPath(path)
  }
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item, index) =>
      scanForUnboundSecretRef(item, [...path, index]),
    )
  }
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    scanForUnboundSecretRef(entry, [...path, key]),
  )
}

export function errorBody(
  sanitized: SanitizedError,
  requestId: string,
  options: {
    readonly retryAfterSeconds?: number
    readonly message?: string
  } = {},
): Record<string, unknown> {
  return {
    error: {
      code: sanitized.code,
      message: options.message ?? PUBLIC_MESSAGES[sanitized.code],
      request_id: requestId,
      retryable: sanitized.status === 429 || sanitized.status === 423,
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: options.retryAfterSeconds }),
      ...(sanitized.details.length === 0
        ? {}
        : { details: [...sanitized.details] }),
    },
  }
}

export interface FailureOptions {
  readonly status?: number
  readonly internalReason?: string
  readonly details?: ReadonlyArray<ErrorDetail>
  readonly message?: string
}

function failureResponse(
  sanitized: SanitizedError,
  requestId: string,
  options: FailureOptions = {},
): Response {
  const status = options.status ?? sanitized.status
  const retryAfterSeconds =
    status === 429 || status === 423 ? RATE_LIMIT_WINDOW_SECONDS : undefined
  const headers: Record<string, string> = {}
  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(retryAfterSeconds)
  }
  return buildJsonResponse(
    errorBody(sanitized, requestId, {
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(options.message === undefined ? {} : { message: options.message }),
    }),
    { status, headers },
  )
}

function fail(
  code: ErrorCode,
  requestId: string,
  options: FailureOptions = {},
): Response {
  return failureResponse(
    {
      status: options.status ?? ERROR_STATUS_BY_CODE[code],
      code,
      details: options.details ?? [],
      internal_reason: options.internalReason ?? code,
    },
    requestId,
    options,
  )
}

// ---------------------------------------------------------------------------
// Validação de corpo, claims e cabeçalhos
// ---------------------------------------------------------------------------

const REQUEST_BODY_SCHEMAS = {
  createProjectDryRun: dryRunRequestSchema,
  decideProjectOperationApproval: approvalRequestSchema,
  executeProjectOperation: executeRequestSchema,
  verifyProjectOperation: verifyRequestSchema,
  createProjectRollbackDryRun: rollbackDryRunRequestSchema,
  decideProjectRollbackApproval: rollbackApprovalRequestSchema,
  executeProjectRollback: rollbackExecuteRequestSchema,
} as const

type RequestBody =
  | DryRunRequest
  | ApprovalRequest
  | ExecuteRequest
  | VerifyRequest
  | RollbackDryRunRequest
  | RollbackApprovalRequest
  | RollbackExecuteRequest

function validateBody(operationId: string, raw: unknown): RequestBody {
  const schema =
    REQUEST_BODY_SCHEMAS[operationId as keyof typeof REQUEST_BODY_SCHEMAS]
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new InvalidRequestBodyError(
      parsed.error.issues.slice(0, 20).map((issue) => ({
        field: issue.path.join('.') || 'body',
        reason: issue.code,
      })),
    )
  }
  return parsed.data as RequestBody
}

function requestIdOf(request: Request, generateId: () => string): string {
  const header = request.headers.get(REQUEST_ID_HEADER)?.trim()
  if (header !== undefined && header.length >= 8 && header.length <= 128) {
    return header
  }
  return generateId()
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header === null) return null
  const match = /^Bearer ([A-Za-z0-9._:-]{16,512})$/.exec(header.trim())
  return match === null ? null : match[1]
}

/** `Content-Length` declarado, ou `null` quando ausente/inválido. */
function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get(CONTENT_LENGTH_HEADER)
  if (raw === null) return null
  const parsed = Number(raw.trim())
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/** `400 INVALID_REQUEST` fechado para corpo acima do teto do contrato. */
function bodyTooLargeResponse(requestId: string, field: string): Response {
  return fail('INVALID_REQUEST', requestId, {
    internalReason: 'body_too_large',
    details: [{ field, reason: 'too_large' }],
  })
}

/**
 * Lê o corpo em fluxo e aborta no teto do contrato (spec §10: 64 KiB).
 *
 * Sem `Content-Length` confiável o teto é aplicado **durante** a leitura: o
 * primeiro chunk que ultrapassa o teto encerra o stream (produtor cancelado),
 * então o resto do corpo nunca é consumido e o JSON nunca é parseado.
 */
async function readBodyTextWithinLimit(request: Request): Promise<string> {
  const declared = declaredContentLength(request)
  if (declared !== null && declared > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(CONTENT_LENGTH_HEADER)
  }
  const body = request.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        throw new RequestBodyTooLargeError('body')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text + decoder.decode()
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function policyActor(claims: ProjectCenterV2TokenClaims): PolicyActorClaims {
  return { subject: claims.subject, actorType: claims.actorType }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface PipelineContext {
  readonly deps: ProjectCenterV2Deps
  readonly requestId: string
  readonly route: OperationRouteDefinition
  readonly claims: ProjectCenterV2TokenClaims
  readonly params: { readonly operation_id?: string }
  readonly now: () => Date
  readonly generateId: () => string
  readonly projection: (operationId: string) => Operation | null
}

/**
 * Executa o pipeline completo para uma requisição v2.
 *
 * Devolve sempre um `Response`; qualquer falha vira resposta tipada sanitizada.
 */
export async function handleProjectCenterV2Request(
  request: Request,
  deps: ProjectCenterV2Deps,
): Promise<Response> {
  const generateId = deps.generateId ?? (() => randomUUID())
  const requestId = requestIdOf(request, generateId)

  // 1. Feature flag: desligada, a superfície inteira fecha antes de qualquer I/O.
  if (!deps.flags.apiEnabled) {
    return fail('FORBIDDEN', requestId, {
      internalReason: `feature_disabled:${PROJECT_CENTER_V2_FLAG}`,
      details: [{ reason: 'feature_disabled' }],
      message: FEATURE_DISABLED_MESSAGE,
    })
  }

  const url = new URL(request.url)
  const match = matchProjectCenterV2Route(request.method, url.pathname)
  if (match === null) {
    return fail('NOT_FOUND', requestId, { internalReason: 'unknown_route' })
  }
  const { route, params } = match

  // 2. Content-Type em mutação, antes de autenticar/desserializar.
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      return fail('INVALID_REQUEST', requestId, {
        internalReason: 'invalid_content_type',
        details: [{ field: 'content-type', reason: 'json_required' }],
      })
    }
  }

  // 3. Teto de corpo declarado (64 KiB): recusa sem ler um único byte.
  if (request.method === 'POST') {
    const declared = declaredContentLength(request)
    if (declared !== null && declared > MAX_REQUEST_BODY_BYTES) {
      return bodyTooLargeResponse(requestId, CONTENT_LENGTH_HEADER)
    }
  }

  // 4. Autenticação: bearer token verificável com claims canônicas.
  const rawToken = bearerToken(request)
  const claims = rawToken === null ? null : deps.verifier.verify(rawToken)
  if (claims === null) {
    return fail('UNAUTHORIZED', requestId, {
      internalReason: rawToken === null ? 'missing_token' : 'invalid_token',
    })
  }
  if (
    typeof claims.subject !== 'string' ||
    claims.subject.length === 0 ||
    typeof claims.actorType !== 'string' ||
    typeof claims.role !== 'string'
  ) {
    return fail('UNAUTHORIZED', requestId, {
      internalReason: 'invalid_claims',
    })
  }

  // 5. Segregação de ator: decisão é ato humano. Antes de qualquer estado.
  if (route.segregation !== null && claims.actorType !== 'human') {
    return fail('FORBIDDEN', requestId, {
      internalReason: `non_human_actor:${route.operationId}`,
      details: [{ reason: 'non_human_actor' }],
    })
  }

  // 6. Policy engine (default deny) por operationId + scopes + ambiente.
  const policyDecision = evaluatePolicy({
    operationId: route.operationId,
    actor: policyActor(claims),
    role: claims.role,
    scopes: claims.scopes,
    environment: claims.environment,
  })
  if (!policyDecision.allowed) {
    const code: ErrorCode =
      policyDecision.code === 'ALLOW' ? 'FORBIDDEN' : policyDecision.code
    return failureResponse(
      {
        status: ERROR_STATUS_BY_CODE[code],
        code,
        details: policyDecision.reasons.map((reason) => ({ reason })),
        internal_reason: `policy:${policyDecision.reasons.join('+')}`,
      },
      requestId,
    )
  }

  // 7. Corpo: leitura incremental com teto, **antes** de qualquer I/O de
  //    store (idempotência, observer, limite) e antes de parsear.
  let rawBodyText = ''
  if (request.method === 'POST') {
    try {
      rawBodyText = await readBodyTextWithinLimit(request)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return bodyTooLargeResponse(requestId, error.field)
      }
      throw error
    }
  }

  // 8. Limite por ator+operação nas 7 mutações, com o teto canônico do spec.
  if (route.requiresIdempotencyKey) {
    const maxPerWindow = RATE_LIMIT_MAX_BY_OPERATION[route.operationId]
    if (maxPerWindow === undefined) {
      // Mutação sem teto declarado é furo de configuração: falha fechado.
      return fail('INTERNAL_ERROR', requestId, {
        internalReason: `rate_limit_missing:${route.operationId}`,
      })
    }
    const allowed = deps.rateLimiter.allow(
      `pcv2:${claims.tokenId}:${route.operationId}`,
      maxPerWindow,
    )
    if (!allowed) {
      return fail('RATE_LIMITED', requestId, {
        internalReason: 'rate_limited',
        details: [
          {
            reason: `scope:${
              OPERATION_REQUIRED_SCOPES[
                route.operationId as keyof typeof OPERATION_REQUIRED_SCOPES
              ]
            }`.slice(0, 120),
          },
        ],
      })
    }
  }

  // 9. Cabeçalhos contratuais: If-Match e Idempotency-Key.
  const ifMatch = request.headers.get(IF_MATCH_HEADER)
  if (route.requiresIfMatch && ifMatch === null) {
    return fail('INVALID_REQUEST', requestId, {
      internalReason: 'missing_if_match',
      details: [{ field: 'if-match', reason: 'required' }],
    })
  }
  const rawIdempotencyKey = request.headers.get(IDEMPOTENCY_HEADER)
  if (route.requiresIdempotencyKey) {
    if (rawIdempotencyKey === null) {
      return fail('INVALID_REQUEST', requestId, {
        internalReason: 'missing_idempotency_key',
        details: [{ field: IDEMPOTENCY_HEADER, reason: 'required' }],
      })
    }
    try {
      hashIdempotencyKey(rawIdempotencyKey)
    } catch {
      return fail('INVALID_REQUEST', requestId, {
        internalReason: 'invalid_idempotency_key',
        details: [{ field: IDEMPOTENCY_HEADER, reason: 'invalid_pattern' }],
      })
    }
  }

  // 10. Corpo já lido sob teto: parse estrito e ausência tratada como `{}`.
  let rawBody: unknown = null
  if (request.method === 'POST') {
    if (rawBodyText.length > 0) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown
      } catch {
        return fail('INVALID_REQUEST', requestId, {
          internalReason: 'invalid_json',
          details: [{ field: 'body', reason: 'invalid_json' }],
        })
      }
    }
    if (route.requestBodyRequired && rawBody === null) {
      // Corpo obrigatório mas ausente: valida `{}` para produzir o detalhe
      // fechado do schema (nunca aceita mutação sem corpo).
      rawBody = {}
    }
  }

  const operationId = params.operation_id
  if (operationId !== undefined && !isUuid(operationId)) {
    return fail('INVALID_REQUEST', requestId, {
      internalReason: 'invalid_operation_id',
      details: [{ field: 'operation_id', reason: 'uuid_required' }],
    })
  }

  const context: PipelineContext = {
    deps,
    requestId,
    route,
    claims,
    params,
    now: deps.now ?? (() => new Date()),
    generateId,
    projection: createOperationProjection({
      operations: deps.operations,
      approvals: deps.approvals,
      rollbackPlans: deps.rollbackPlans,
    }),
  }

  try {
    return await dispatch(context, request, rawBody, rawIdempotencyKey, ifMatch)
  } catch (error) {
    return failureResponse(sanitizeError(error), requestId)
  }
}

async function dispatch(
  context: PipelineContext,
  request: Request,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  switch (context.route.operationId) {
    case 'createProjectDryRun':
      return createProjectDryRun(context, rawBody, rawIdempotencyKey)
    case 'decideProjectOperationApproval':
      return decideProjectOperationApproval(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'executeProjectOperation':
      return executeProjectOperation(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'getProjectOperation':
      return getProjectOperation(context)
    case 'verifyProjectOperation':
      return verifyProjectOperation(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'createProjectRollbackDryRun':
      return createProjectRollbackDryRun(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'decideProjectRollbackApproval':
      return decideProjectRollbackApproval(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'executeProjectRollback':
      return executeProjectRollback(
        context,
        rawBody,
        rawIdempotencyKey,
        ifMatch,
      )
    case 'listProjectOperationAudit':
      return listProjectOperationAudit(context, request)
    default:
      return fail('NOT_FOUND', context.requestId, {
        internalReason: 'unmapped_operation',
      })
  }
}

// ---------------------------------------------------------------------------
// Idempotência na borda HTTP
// ---------------------------------------------------------------------------

export interface FinishInput {
  readonly plan: TransactionPlan
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly buildBody: (operation: Operation | null) => Record<string, unknown>
}

type IdempotencyStart =
  | { readonly kind: 'replay'; readonly response: Response }
  | {
      readonly kind: 'fresh'
      readonly finish: (input: FinishInput) => Response
    }

/**
 * Abre (ou recupera) o registro de idempotência.
 *
 * - `replay`: devolve a resposta registrada sem tocar em nenhum store;
 * - `fresh`: aplica o plano de escrita atômico e registra a resposta;
 * - registro pendente com `operation_id` (queda entre commit e resposta): a
 *   resposta é reconstruída do estado durável em vez de reexecutar o efeito.
 */
function openIdempotency(
  context: PipelineContext,
  rawIdempotencyKey: string | null,
  payload: unknown,
): IdempotencyStart {
  const route = context.route
  const outcome = context.deps.idempotency.begin({
    rawKey: rawIdempotencyKey ?? '',
    actorRef: actorRefFor(context.claims.subject),
    routeId: route.operationId,
    requestHash: hashRequestPayload(payload),
  })

  if (outcome.kind === 'replay') {
    // Respostas de erro são replicadas com o status original (410, 409, ...):
    // só as mutações bem-sucedidas são rebaixadas para `replayStatus`.
    const storedStatus = outcome.response.status
    return {
      kind: 'replay',
      // Replay é byte a byte: mesma resposta, mesmo `request_id` original.
      response: buildJsonResponse(outcome.response.body, {
        status: storedStatus >= 400 ? storedStatus : route.replayStatus,
        headers: { 'Idempotency-Replayed': 'true' },
      }),
    }
  }

  const recoverId = outcome.kind === 'recover' ? outcome.operation_id : null
  const claim = outcome.claim

  return {
    kind: 'fresh',
    finish: (input) => {
      if (recoverId !== null) {
        const operation = context.projection(recoverId)
        if (operation === null) {
          throw new OperationNotFoundFailure()
        }
        const body = input.buildBody(operation)
        context.deps.idempotency.complete(claim, recoverId, {
          status: input.status,
          body,
        })
        return buildJsonResponse(body, {
          status: input.status,
          headers: {
            ...(input.headers ?? {}),
            'Idempotency-Replayed': 'true',
          },
        })
      }

      const result = context.deps.idempotency.commit(
        claim,
        input.plan,
        context.deps.commitHooks,
      )
      const operationId =
        result.operation?.operation_id ?? context.params.operation_id
      if (operationId === undefined) {
        throw new Error('transacao sem operacao associada')
      }
      const projected = context.projection(operationId)
      const body = input.buildBody(projected)
      context.deps.idempotency.complete(claim, operationId, {
        status: input.status,
        body,
      })
      return buildJsonResponse(body, {
        status: input.status,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      })
    },
  }
}

function requireOperation(
  context: PipelineContext,
  projected: boolean,
): Operation {
  const operationId = context.params.operation_id
  if (operationId === undefined) {
    throw new InvalidRequestBodyError([
      { field: 'operation_id', reason: 'required' },
    ])
  }
  const operation = projected
    ? context.projection(operationId)
    : (context.deps.operations.get(operationId) ?? null)
  if (operation === null) throw new OperationNotFoundFailure()
  return operation
}

function revisionFrom(ifMatch: string | null): number {
  if (ifMatch === null) {
    throw new InvalidRequestBodyError([
      { field: 'if-match', reason: 'required' },
    ])
  }
  if (!/^"[1-9][0-9]*"$/.test(ifMatch)) {
    throw new InvalidRequestBodyError([
      { field: 'if-match', reason: 'invalid_pattern' },
    ])
  }
  const revision = Number.parseInt(ifMatch.slice(1, -1), 10)
  if (!Number.isInteger(revision) || revision < 1) {
    throw new InvalidRequestBodyError([
      { field: 'if-match', reason: 'invalid_revision' },
    ])
  }
  return revision
}

function assertLockFree(context: PipelineContext, operationId: string): void {
  const holder = context.deps.lease.holder(operationId)
  if (holder !== null) {
    throw new OperationLockedError('operacao com lease exclusivo', [
      { reason: 'lease_held' },
    ])
  }
}

/**
 * Claim `environment` do token precisa bater com o ambiente alvo.
 *
 * Vale para o dry-run (que cria a operação) e para **toda** operação que atua
 * sobre uma operação existente — approve/execute/verify/rollback/audit: um
 * token restrito a `development` nunca decide nem dispara `production`.
 *
 * A checagem roda antes de idempotência, observer, lease e qualquer escrita:
 * divergência é `403 FORBIDDEN` (`http.ts:388-389` — "ambiente ao qual o token
 * está restrito") sem side effect nenhum.
 */
function assertEnvironmentMatch(
  claims: ProjectCenterV2TokenClaims,
  environment: string,
): void {
  if (claims.environment !== environment) throw new EnvironmentMismatchError()
}

// ---------------------------------------------------------------------------
// Auditoria e escritas auxiliares
// ---------------------------------------------------------------------------

interface AuditEventInput {
  readonly type: string
  readonly outcome: AuditAppendInput['outcome']
  readonly fromState: OperationState | null
  readonly toState: OperationState | null
  readonly safePayload: Record<string, unknown>
}

function auditEvent(
  context: PipelineContext,
  operationId: string,
  input: AuditEventInput,
): AuditAppendInput {
  return {
    operationId,
    requestId: context.requestId,
    type: input.type,
    actorRef: actorRefFor(context.claims.subject),
    outcome: input.outcome,
    fromState: input.fromState,
    toState: input.toState,
    attempt: 1,
    safePayload: toSafePayload(input.safePayload),
  }
}

function operationResponseBody(
  context: PipelineContext,
  operation: Operation,
): Record<string, unknown> {
  return { request_id: context.requestId, operation }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createProjectDryRun(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
): Promise<Response> {
  const body = validateBody(context.route.operationId, rawBody) as DryRunRequest
  const intent = body.intent
  assertEnvironmentMatch(context.claims, intent.environment)

  const naming = buildNamingSnapshot(intent)
  const observed = await context.deps.observations.observe({ intent, naming })
  const canonical = planProject({
    intent,
    observed,
    flags: context.deps.flags,
    ...(context.deps.drivers === undefined
      ? {}
      : { drivers: context.deps.drivers }),
  })

  const operationId = context.generateId()
  const operationInput: CreateOperationInput = {
    intent,
    plan: canonical.plan,
    planHash: canonical.plan_hash,
    expiresAt: canonical.expires_at,
    statusUrl: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/${operationId}`,
    auditUrl: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/${operationId}/audit`,
    observedRevision: canonical.observed_revision,
    driverVersion: canonical.driver_version,
    operationId,
  }

  const start = openIdempotency(context, rawIdempotencyKey, {
    intent,
    reason: body.reason ?? null,
    operation_id: null,
  })
  if (start.kind === 'replay') return start.response

  const ownership: CompensableWrite = {
    label: 'operation_ownership',
    apply: () => {
      context.deps.ownership.record(operationId, context.claims.subject)
    },
    compensate: () => {
      context.deps.ownership.discard(operationId)
    },
  }

  const dryRunAudit = (
    from: OperationState | null,
    to: OperationState,
  ): AuditAppendInput =>
    auditEvent(context, operationId, {
      type: 'project_center.dry_run',
      outcome: 'accepted',
      fromState: from,
      toState: to,
      safePayload: {
        driver: canonical.driver,
        driver_version: canonical.driver_version,
        plan_hash: canonical.plan_hash,
        action_count: canonical.plan.actions.length,
        environment: intent.environment,
        project_id: canonical.project_id,
        has_reason: body.reason !== undefined,
      },
    })

  return start.finish({
    status: 201,
    headers: {
      'Idempotency-Replayed': 'false',
      Location: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/${operationId}`,
    },
    plan: {
      operations: [
        { kind: 'create', input: operationInput },
        {
          kind: 'transition',
          operationId,
          next: 'awaiting_approval',
          expectedRevision: 1,
        },
      ],
      extra: [ownership],
      audit: [
        dryRunAudit(null, 'planned'),
        dryRunAudit('planned', 'awaiting_approval'),
      ],
    },
    buildBody: (operation) => {
      if (operation === null) throw new OperationNotFoundFailure()
      return operationResponseBody(context, operation)
    },
  })
}

async function decideProjectOperationApproval(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, true)
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody,
  ) as ApprovalRequest
  const ownership = context.deps.ownership.get(operation.operation_id)

  // A chave de idempotência vem antes da avaliação de estado: um replay devolve
  // a resposta original mesmo que a operação já tenha transicionado (por
  // exemplo, `expired`) e a reavaliação falharia com conflito de estado.
  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  const decision = evaluateOperationApproval({
    operation,
    actor: policyActor(context.claims),
    expectedRevision: revision,
    request: body,
    requesterSubject: ownership?.requester_subject ?? null,
    now: context.now(),
    generateId: context.generateId,
  })

  if (decision.approval === null) {
    // Plano vencido: transição preguiçosa para `expired`; a resposta 410 fica
    // registrada na chave de idempotência (replay devolve o mesmo 410).
    const sanitized = sanitizeError({
      code: 'APPROVAL_EXPIRED',
      status: 410,
      details: [{ field: 'expires_at', reason: 'plan_expired' }],
    })
    return start.finish({
      status: 410,
      plan: {
        operations: [
          {
            kind: 'transition',
            operationId: operation.operation_id,
            next: 'expired',
            expectedRevision: revision,
          },
        ],
        audit: [
          auditEvent(context, operation.operation_id, {
            type: 'project_center.approval',
            outcome: 'expired',
            fromState: operation.state,
            toState: 'expired',
            safePayload: { decision: body.decision, reason: 'plan_expired' },
          }),
        ],
      },
      buildBody: () => errorBody(sanitized, context.requestId),
    })
  }

  const approval = decision.approval
  const approvalWrite: CompensableWrite = {
    label: 'operation_approval',
    apply: () => {
      context.deps.approvals.put(operation.operation_id, approval)
    },
    compensate: () => {
      context.deps.approvals.discard(operation.operation_id)
    },
  }

  return start.finish({
    status: 200,
    plan: {
      operations: [
        {
          kind: 'transition',
          operationId: operation.operation_id,
          next: decision.next,
          expectedRevision: revision,
        },
      ],
      extra: [approvalWrite],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.approval',
          outcome: 'accepted',
          fromState: operation.state,
          toState: decision.next,
          safePayload: {
            decision: body.decision,
            plan_hash: operation.plan_hash,
            actor_ref: approval.actor_ref,
            approval_id: approval.approval_id,
          },
        }),
      ],
    },
    buildBody: (updated) => {
      if (updated === null) throw new OperationNotFoundFailure()
      return operationResponseBody(context, updated)
    },
  })
}

async function executeProjectOperation(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, true)
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody,
  ) as ExecuteRequest

  // Chave antes da reavaliação de estado: o replay devolve a resposta original
  // mesmo com a operação já em `queued`.
  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  assertApprovalUsable(
    operation,
    context.deps.approvals.get(operation.operation_id),
    context.now(),
  )
  if (body.plan_hash !== operation.plan_hash) {
    throw new ApprovalStateError('plan hash divergente', [
      { field: 'plan_hash', reason: 'plan_hash_mismatch' },
    ])
  }
  assertTransition(operation.state, 'queued')
  assertLockFree(context, operation.operation_id)

  return start.finish({
    status: 202,
    headers: {
      Location: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/${operation.operation_id}`,
    },
    plan: {
      operations: [
        {
          kind: 'transition',
          operationId: operation.operation_id,
          next: 'queued',
          expectedRevision: revision,
        },
      ],
      outbox: [
        {
          operationId: operation.operation_id,
          kind: 'execute',
          planHash: operation.plan_hash,
          projectId: operation.project_id,
          environment: operation.environment,
        },
      ],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.execute',
          outcome: 'accepted',
          fromState: operation.state,
          toState: 'queued',
          // Worker desligado: nada além de enfileiramento acontece no PR 4.
          safePayload: {
            worker_enabled: context.deps.flags.workerEnabled,
            worker_flag: PROJECT_CENTER_V2_WORKER_FLAG,
            plan_hash: operation.plan_hash,
          },
        }),
      ],
    },
    buildBody: (updated) => {
      if (updated === null) throw new OperationNotFoundFailure()
      return operationResponseBody(context, updated)
    },
  })
}

async function getProjectOperation(
  context: PipelineContext,
): Promise<Response> {
  const operation = requireOperation(context, true)
  return buildJsonResponse(operationResponseBody(context, operation), {
    status: 200,
  })
}

async function verifyProjectOperation(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, true)
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody ?? {},
  ) as VerifyRequest

  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  if (operation.state !== 'succeeded' && operation.state !== 'failed') {
    throw new ApprovalStateError('operacao nao esta pronta para verificacao', [
      { reason: `state_${operation.state}` },
    ])
  }
  assertLockFree(context, operation.operation_id)
  return start.finish({
    status: 202,
    plan: {
      operationId: operation.operation_id,
      outbox: [
        {
          operationId: operation.operation_id,
          kind: 'verify',
          planHash: operation.plan_hash,
          projectId: operation.project_id,
          environment: operation.environment,
        },
      ],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.verify',
          outcome: 'accepted',
          fromState: operation.state,
          toState: operation.state,
          safePayload: {
            checks: (body.checks ?? []).join(','),
            revision,
            plan_hash: operation.plan_hash,
            worker_enabled: context.deps.flags.workerEnabled,
          },
        }),
      ],
    },
    buildBody: () => {
      const projected = requireOperation(context, true)
      return operationResponseBody(context, projected)
    },
  })
}

async function createProjectRollbackDryRun(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, true)
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody,
  ) as RollbackDryRunRequest
  if (
    operation.state !== 'succeeded' &&
    operation.state !== 'failed' &&
    operation.state !== 'rollback_pending'
  ) {
    throw new ApprovalStateError('operacao nao pode entrar em rollback', [
      { reason: `state_${operation.state}` },
    ])
  }
  assertLockFree(context, operation.operation_id)

  const observation = await context.deps.rollbackObservations.observe(
    operation,
    { preserveData: body.preserve_data },
  )
  const rollbackPlan = buildRollbackPlan({
    operation,
    observation,
    preserveData: body.preserve_data,
    now: context.now(),
  })

  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  const planWrite: CompensableWrite = {
    label: 'rollback_plan',
    apply: () => {
      context.deps.rollbackPlans.put(operation.operation_id, rollbackPlan)
    },
    compensate: () => {
      context.deps.rollbackPlans.discard(operation.operation_id)
    },
  }
  const requesterWrite: CompensableWrite = {
    label: 'rollback_requester',
    apply: () => {
      context.deps.ownership.setRollbackRequester(
        operation.operation_id,
        context.claims.subject,
      )
    },
    compensate: () => {
      context.deps.rollbackPlans.discard(operation.operation_id)
    },
  }

  return start.finish({
    status: 201,
    plan: {
      operationId: operation.operation_id,
      extra: [planWrite, requesterWrite],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.rollback_dry_run',
          outcome: 'accepted',
          fromState: operation.state,
          toState: operation.state,
          safePayload: {
            rollback_plan_hash: rollbackPlan.rollback_plan_hash,
            destructive: rollbackPlan.destructive,
            preserve_data: rollbackPlan.preserve_data,
            action_count: rollbackPlan.actions.length,
            observed_revision: rollbackPlan.observed_revision,
            revision,
          },
        }),
      ],
    },
    buildBody: () => {
      const projected = requireOperation(context, true)
      return operationResponseBody(context, projected)
    },
  })
}

async function decideProjectRollbackApproval(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, false)
  const projected = context.projection(operation.operation_id) ?? operation
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody,
  ) as RollbackApprovalRequest

  // Idempotência antes da avaliação: replay devolve a resposta original.
  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  const decision = evaluateRollbackApproval({
    operation: projected,
    rollbackPlan: context.deps.rollbackPlans.get(operation.operation_id),
    actor: policyActor(context.claims),
    expectedRevision: revision,
    request: body,
    ownership: context.deps.ownership.get(operation.operation_id),
    now: context.now(),
    generateId: context.generateId,
  })

  const approvalWrite: CompensableWrite = {
    label: 'rollback_approval',
    apply: () => {
      context.deps.rollbackPlans.put(
        operation.operation_id,
        decision.rollbackPlan,
      )
    },
    compensate: () => {
      context.deps.rollbackPlans.discard(operation.operation_id)
    },
  }

  return start.finish({
    status: 200,
    plan: {
      operationId: operation.operation_id,
      extra: [approvalWrite],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.rollback_approval',
          outcome: 'accepted',
          fromState: projected.state,
          toState: projected.state,
          safePayload: {
            decision: body.decision,
            rollback_plan_hash: decision.rollbackPlan.rollback_plan_hash,
            approval_id: decision.approval.approval_id,
            actor_ref: decision.approval.actor_ref,
          },
        }),
      ],
    },
    buildBody: () => {
      const updated = requireOperation(context, true)
      return operationResponseBody(context, updated)
    },
  })
}

async function executeProjectRollback(
  context: PipelineContext,
  rawBody: unknown,
  rawIdempotencyKey: string | null,
  ifMatch: string | null,
): Promise<Response> {
  const operation = requireOperation(context, true)
  assertEnvironmentMatch(context.claims, operation.environment)
  const revision = revisionFrom(ifMatch)
  const body = validateBody(
    context.route.operationId,
    rawBody,
  ) as RollbackExecuteRequest

  // Chave antes de revalidar ownership/drift: o replay devolve a resposta
  // original mesmo com a operação já em `rollback_pending`.
  const start = openIdempotency(context, rawIdempotencyKey, {
    body,
    operation_id: operation.operation_id,
  })
  if (start.kind === 'replay') return start.response

  const rollbackPlan = context.deps.rollbackPlans.get(operation.operation_id)
  assertRollbackApprovalUsable(rollbackPlan, body, context.now())
  const approvedPlan = rollbackPlan as NonNullable<typeof rollbackPlan>

  // Revalidação de ownership/drift antes do lease: nada destrutivo entra em
  // fila sem prova de que o recurso ainda pertence a esta operação.
  const observation: RollbackObservation =
    await context.deps.rollbackObservations.observe(operation, {
      preserveData: approvedPlan.preserve_data,
    })
  if (!observation.ownership_verified) {
    throw new RollbackUnsafeError('ownership nao comprovado', [
      { reason: 'ownership_not_verified' },
    ])
  }
  if (observation.drift_findings.length > 0) {
    throw new RollbackUnsafeError('drift detectado', [
      { reason: 'drift_detected' },
    ])
  }
  if (observation.observed_revision !== approvedPlan.observed_revision) {
    throw new ApprovalHashMismatchError(
      'revisao observada mudou desde o plano de rollback',
      [{ field: 'observed_revision', reason: 'observed_revision_changed' }],
    )
  }
  assertTransition(operation.state, 'rollback_pending')
  assertLockFree(context, operation.operation_id)

  return start.finish({
    status: 202,
    plan: {
      operations: [
        {
          kind: 'transition',
          operationId: operation.operation_id,
          next: 'rollback_pending',
          expectedRevision: revision,
        },
      ],
      outbox: [
        {
          operationId: operation.operation_id,
          kind: 'rollback_execute',
          planHash: approvedPlan.rollback_plan_hash,
          projectId: operation.project_id,
          environment: operation.environment,
        },
      ],
      audit: [
        auditEvent(context, operation.operation_id, {
          type: 'project_center.rollback_execute',
          outcome: 'accepted',
          fromState: operation.state,
          toState: 'rollback_pending',
          safePayload: {
            rollback_plan_hash: approvedPlan.rollback_plan_hash,
            approval_id: body.approval_id,
            destructive: approvedPlan.destructive,
            preserve_data: approvedPlan.preserve_data,
            worker_enabled: context.deps.flags.workerEnabled,
          },
        }),
      ],
    },
    buildBody: (updated) => {
      if (updated === null) throw new OperationNotFoundFailure()
      return operationResponseBody(context, updated)
    },
  })
}

async function listProjectOperationAudit(
  context: PipelineContext,
  request: Request,
): Promise<Response> {
  const operation = requireOperation(context, false)
  assertEnvironmentMatch(context.claims, operation.environment)
  const url = new URL(request.url)
  const cursorParam = url.searchParams.get('cursor')
  const limitParam = url.searchParams.get('limit')
  const cursor =
    cursorParam === null || cursorParam.length === 0
      ? null
      : cursorParam.slice(0, 256)
  let limit = 100
  if (limitParam !== null && limitParam.length > 0) {
    const parsed = Number.parseInt(limitParam, 10)
    if (
      !Number.isInteger(parsed) ||
      String(parsed) !== limitParam.trim() ||
      parsed < 1 ||
      parsed > AUDIT_MAX_LIMIT
    ) {
      return fail('INVALID_REQUEST', context.requestId, {
        internalReason: 'invalid_limit',
        details: [{ field: 'limit', reason: 'out_of_range' }],
      })
    }
    limit = parsed
  }

  const page = context.deps.audit.list(operation.operation_id, {
    requestId: context.requestId,
    cursor,
    limit,
  })
  return buildJsonResponse(page, { status: 200 })
}

// ---------------------------------------------------------------------------
// Superfície auxiliar
// ---------------------------------------------------------------------------

/** Retrato das flags para health e log (nunca valores sensíveis). */
export function describeProjectCenterV2Surface(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly api: boolean; readonly worker: boolean } {
  const flags = resolveProjectCenterV2Flags(env)
  return { api: flags.apiEnabled, worker: flags.workerEnabled }
}

/** Escopos exigidos por uma operação do manifest (paridade com o contrato). */
export function requiredScopesFor(
  operationId: string,
): ReadonlyArray<ProjectScope> {
  if (!Object.hasOwn(OPERATION_REQUIRED_SCOPES, operationId)) {
    throw new Error(`operacao contratual desconhecida: ${operationId}`)
  }
  return OPERATION_REQUIRED_SCOPES[
    operationId as keyof typeof OPERATION_REQUIRED_SCOPES
  ]
}
