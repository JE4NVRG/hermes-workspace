/**
 * Cliente tipado da API v2 do Project Center (PR 5).
 *
 * Contrato: `specs/contracts/project-center-v2.openapi.yaml` (nove
 * `operationId`, cabeçalhos `Idempotency-Key`/`If-Match`, catálogo fechado de
 * erros) e `docs/design/project-center-v2-ux.md` (chave client-owned, máscaras
 * e ausência de credencial no browser).
 *
 * Garantias deste módulo:
 * - a `Idempotency-Key` é gerada e **persistida antes do primeiro POST**,
 *   amarrada ao payload canônico, e reutilizada em retry/timeout; mudar a
 *   intenção gera e persiste uma nova chave antes da nova tentativa;
 * - o cliente **nunca** constrói, analisa, normaliza ou deriva `SecretRef`;
 * - o cliente **nunca** aceita path absoluto, DSN ou credencial em payload;
 * - o browser não lê token de `env`, storage ou qualquer fonte local: a
 *   autorização vem da sessão server-side (`credentials: 'same-origin'`) e
 *   toda decisão de permissão é do servidor;
 * - a flag de superfície é **server-projected** e falha fechada (rede
 *   indisponível ⇒ experiência atual preservada).
 */
import {
  ENVIRONMENTS,
  OPERATION_STATES,
  containsSensitiveValue,
  isErrorCode,
  sanitizeForDisplay,
} from './project-center-v2-types'
import type {
  ApiErrorBody,
  ApprovalRequest,
  AuditPage,
  DryRunRequest,
  ErrorCode,
  ErrorDetail,
  Operation,
  OperationResponse,
  ProjectIntent,
  RollbackApprovalRequest,
  RollbackExecuteRequest,
  VerificationCheckName,
  VerifyRequest,
} from './project-center-v2-types'

export const PROJECT_CENTER_V2_API_PREFIX = '/api/project-center/v2'
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
export const IF_MATCH_HEADER = 'If-Match'
export const REQUEST_ID_HEADER = 'X-Request-Id'
export const FEATURE_DISABLED_SIGNAL = 'feature_disabled'
export const IDEMPOTENCY_KEY_HEADER_REPLAYED = 'Idempotency-Replayed'

/**
 * UUID nulo usado **somente** como sonda read-only da flag server-projected.
 *
 * O servidor checa a flag antes de casar rota, antes de autenticar e antes de
 * qualquer I/O de store (`http.ts`, passo 1). Com a flag desligada a sonda
 * recebe `403 FORBIDDEN` com `message: 'feature_disabled'`; com a flag ligada
 * a mesma sonda recebe `401 UNAUTHORIZED` (o browser não carrega token scoped).
 * A sonda não cria, altera nem lê nada e não consome rate limit (só mutações
 * têm teto).
 */
export const SURFACE_PROBE_OPERATION_ID = '00000000-0000-0000-0000-000000000000'

export const IDEMPOTENCY_KEY_MIN_LENGTH = 16
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/

export const DEFAULT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Erros tipados
// ---------------------------------------------------------------------------

export class ProjectCenterV2InputError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`entrada rejeitada em ${field}: ${message}`)
    this.name = 'ProjectCenterV2InputError'
    this.field = field
  }
}

export class ProjectCenterV2TransportError extends Error {
  readonly retryable = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProjectCenterV2TransportError'
  }
}

/** Erro sanitizado do catálogo fechado do contrato. */
export class ProjectCenterV2ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly requestId: string
  readonly retryable: boolean
  readonly retryAfterSeconds: number | null
  readonly details: ReadonlyArray<ErrorDetail>

  constructor(input: {
    readonly code: ErrorCode
    readonly status: number
    readonly requestId: string
    readonly retryable: boolean
    readonly retryAfterSeconds: number | null
    readonly details: ReadonlyArray<ErrorDetail>
    readonly message: string
  }) {
    super(sanitizeForDisplay(input.message))
    this.name = 'ProjectCenterV2ApiError'
    this.code = input.code
    this.status = input.status
    this.requestId = input.requestId
    this.retryable = input.retryable
    this.retryAfterSeconds = input.retryAfterSeconds
    this.details = input.details
  }

  /** Flag desligada: superfície fechada, nenhuma ação privilegiada existe. */
  get featureDisabled(): boolean {
    return (
      this.status === 403 &&
      (this.message === FEATURE_DISABLED_SIGNAL ||
        this.details.some(
          (detail) => detail.reason === FEATURE_DISABLED_SIGNAL,
        ))
    )
  }
}

// ---------------------------------------------------------------------------
// Sessão: chave de idempotência client-owned
// ---------------------------------------------------------------------------

export interface IdempotencyBinding {
  readonly key: string
  /** Payload canônico ao qual a chave está amarrada. */
  readonly intent: string
}

export interface IdempotencyStore {
  read: (scope: string) => IdempotencyBinding | null
  write: (scope: string, binding: IdempotencyBinding) => void
  clear: (scope: string) => void
}

export const IDEMPOTENCY_STORAGE_PREFIX = 'pcv2.idempotency.'

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const bindings = new Map<string, IdempotencyBinding>()
  return {
    clear: (scope) => {
      bindings.delete(scope)
    },
    read: (scope) => bindings.get(scope) ?? null,
    write: (scope, binding) => {
      bindings.set(scope, binding)
    },
  }
}

/**
 * Store de sessão (`sessionStorage`). Guarda apenas chave + payload canônico
 * público; nunca credencial. Sem `storage` disponível, degrada para memória.
 */
export function createSessionIdempotencyStore(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): IdempotencyStore {
  const resolved = storage ?? browserSessionStorage()
  if (resolved === null) return createMemoryIdempotencyStore()
  return {
    clear: (scope) => {
      try {
        resolved.removeItem(`${IDEMPOTENCY_STORAGE_PREFIX}${scope}`)
      } catch {
        // storage bloqueado (modo privado/quota): a chave segue em memória
      }
    },
    read: (scope) => {
      try {
        const raw = resolved.getItem(`${IDEMPOTENCY_STORAGE_PREFIX}${scope}`)
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as IdempotencyBinding).key === 'string' &&
          typeof (parsed as IdempotencyBinding).intent === 'string'
        ) {
          const typed = parsed as IdempotencyBinding
          return { intent: typed.intent, key: typed.key }
        }
        return null
      } catch {
        return null
      }
    },
    write: (scope, binding) => {
      try {
        resolved.setItem(
          `${IDEMPOTENCY_STORAGE_PREFIX}${scope}`,
          JSON.stringify(binding),
        )
      } catch {
        // storage bloqueado: mantém comportamento sem persistência durável
      }
    },
  }
}

function browserSessionStorage(): Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Bytes CSPRNG; falha fechado quando não existe fonte criptográfica. */
function defaultRandomBytes(length: number): Uint8Array {
  // Lido como opcional de propósito: o guard precisa valer em runtime, mesmo
  // onde o tipo de `globalThis.crypto` é declarado como presente.
  const cryptoApi = (globalThis as { readonly crypto?: Crypto }).crypto
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new ProjectCenterV2InputError(
      'idempotency_key',
      'CSPRNG indisponível para gerar a chave antes do primeiro POST',
    )
  }
  const bytes = new Uint8Array(length)
  cryptoApi.getRandomValues(bytes)
  return bytes
}

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Gera a `Idempotency-Key` (24 caracteres base64url = 144 bits, dentro de
 * 16..128 e do pattern do contrato) a partir de 24 bytes CSPRNG. O mapeamento
 * `byte % 64` é uniforme porque 256 é múltiplo exato de 64.
 */
export function generateIdempotencyKey(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  const bytes = randomBytes(24)
  let key = ''
  for (const byte of bytes) key += BASE64URL_ALPHABET[byte % 64]
  return key
}

export function isValidIdempotencyKey(value: string): boolean {
  return (
    value.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  )
}

/** JSON canônico: chaves ordenadas em profundidade, sem depender de ordem. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// ---------------------------------------------------------------------------
// Guardas de entrada: nada de path, DSN, credencial ou SecretRef
// ---------------------------------------------------------------------------

const SENSITIVE_ALLOWED_FIELDS: ReadonlyArray<string> = [
  'client_id',
  'project_slug',
  'display_name',
  'description',
  'driver',
  'environment',
  'host_target',
  'repository',
  'capabilities',
  'requested_limits',
]

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/
const DISPLAY_NAME_MIN = 3
const DISPLAY_NAME_MAX = 80
const DESCRIPTION_MAX = 500

export interface PublicIntentInput {
  readonly client_id: string
  readonly project_slug: string
  readonly display_name: string
  readonly description?: string
  readonly driver: string
  readonly environment: string
  readonly repository?: { readonly registry_id?: string }
  readonly capabilities: ProjectIntent['capabilities']
  readonly requested_limits?: ProjectIntent['requested_limits']
}

function assertCleanText(
  value: string,
  field: string,
  limits: { readonly min?: number; readonly max: number },
): string {
  const min = limits.min ?? 0
  if (value.length < min || value.length > limits.max) {
    throw new ProjectCenterV2InputError(
      field,
      `tamanho fora de ${min}..${limits.max}`,
    )
  }
  if (containsSensitiveValue(value)) {
    throw new ProjectCenterV2InputError(
      field,
      'valor contém path absoluto, credencial ou referência opaca',
    )
  }
  return value
}

function assertPattern(value: string, field: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new ProjectCenterV2InputError(field, 'formato fora do contrato')
  }
  return assertCleanText(value, field, { max: 128 })
}

/**
 * Valida a intenção pública. Campo desconhecido é rejeitado — é assim que a UI
 * impede que um path/credencial entre por engano no payload.
 */
export function assertPublicIntent(input: PublicIntentInput): ProjectIntent {
  const extra = Object.keys(input).filter(
    (key) => !SENSITIVE_ALLOWED_FIELDS.includes(key),
  )
  if (extra.length > 0) {
    throw new ProjectCenterV2InputError(
      extra.join(','),
      'campo não permitido na intenção pública',
    )
  }
  const clientId = assertPattern(
    input.client_id,
    'client_id',
    CLIENT_ID_PATTERN,
  )
  const projectSlug = assertPattern(
    input.project_slug,
    'project_slug',
    CLIENT_ID_PATTERN,
  )
  const displayName = assertCleanText(input.display_name, 'display_name', {
    max: DISPLAY_NAME_MAX,
    min: DISPLAY_NAME_MIN,
  })
  if (
    input.driver !== 'postgresql_isolated' &&
    input.driver !== 'supabase_isolated'
  ) {
    throw new ProjectCenterV2InputError(
      'driver',
      'apenas postgresql_isolated e supabase_isolated são selecionáveis',
    )
  }
  if (!(ENVIRONMENTS as ReadonlyArray<string>).includes(input.environment)) {
    throw new ProjectCenterV2InputError(
      'environment',
      'ambiente fora do contrato',
    )
  }
  const repository =
    input.repository === undefined
      ? undefined
      : {
          registry_id:
            input.repository.registry_id === undefined
              ? undefined
              : assertCleanText(
                  input.repository.registry_id,
                  'repository.registry_id',
                  {
                    max: 128,
                    min: 3,
                  },
                ),
        }
  const intent: ProjectIntent = {
    capabilities: input.capabilities,
    client_id: clientId,
    display_name: displayName,
    driver: input.driver,
    environment: input.environment as ProjectIntent['environment'],
    host_target: 'vps-primary-local',
    project_slug: projectSlug,
    ...(input.description === undefined
      ? {}
      : {
          description: assertCleanText(input.description, 'description', {
            max: DESCRIPTION_MAX,
          }),
        }),
    ...(repository === undefined ? {} : { repository }),
    ...(input.requested_limits === undefined
      ? {}
      : { requested_limits: input.requested_limits }),
  }
  return intent
}

/** Motivo/justificativa livre, sempre sem valor sensível. */
export function assertFreeText(
  value: string,
  field: string,
  limits: { readonly min: number; readonly max: number },
): string {
  return assertCleanText(value, field, limits)
}

/**
 * O cliente não constrói `SecretRef`. Esta guarda existe para provar que um
 * valor opaco vindo de fora nunca é aceito como entrada pública.
 */
export function assertNoOpaqueReference(value: string, field: string): void {
  if (/sref_/.test(value)) {
    throw new ProjectCenterV2InputError(
      field,
      'referência opaca é emitida apenas pelo broker no servidor',
    )
  }
}

// ---------------------------------------------------------------------------
// Resultados e superfície
// ---------------------------------------------------------------------------

export interface OperationCallResult {
  readonly operation: Operation
  readonly requestId: string
  readonly replayed: boolean
}

/**
 * Ação tipada do fluxo, despachada pela UI. União discriminada: nenhuma ação
 * irreversível pode ser enviada sem `operationVersion` (`If-Match`).
 */
export type ProjectCenterV2ActionRequest =
  | { readonly kind: 'dryRun'; readonly request: DryRunRequest }
  | {
      readonly kind: 'approve'
      readonly operationId: string
      readonly request: ApprovalRequest
      readonly operationVersion: number
    }
  | {
      readonly kind: 'execute'
      readonly operationId: string
      readonly planHash: string
      readonly operationVersion: number
    }
  | {
      readonly kind: 'verify'
      readonly operationId: string
      readonly operationVersion: number
      readonly checks?: ReadonlyArray<VerificationCheckName>
    }
  | {
      readonly kind: 'rollbackDryRun'
      readonly operationId: string
      readonly request: {
        readonly reason: string
        readonly preserve_data: boolean
      }
      readonly operationVersion: number
    }
  | {
      readonly kind: 'rollbackApprove'
      readonly operationId: string
      readonly request: RollbackApprovalRequest
      readonly operationVersion: number
    }
  | {
      readonly kind: 'rollbackExecute'
      readonly operationId: string
      readonly request: RollbackExecuteRequest
      readonly operationVersion: number
    }

export interface ProjectCenterV2Surface {
  /** Projeção do servidor: `true` só quando o servidor confirmou a superfície. */
  readonly apiEnabled: boolean
  /** `null` quando o servidor não expõe o estado do worker na sonda. */
  readonly workerEnabled: boolean | null
  readonly source: 'server' | 'unavailable'
}

export interface ProjectCenterV2ClientOptions {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly idempotency?: IdempotencyStore
  readonly keyGenerator?: () => string
  readonly requestIdGenerator?: () => string
  readonly timeoutMs?: number
  readonly retries?: number
}

export interface ProjectCenterV2Client {
  surface: () => Promise<ProjectCenterV2Surface>
  dryRun: (request: DryRunRequest) => Promise<OperationCallResult>
  getOperation: (operationId: string) => Promise<OperationCallResult>
  approveOperation: (
    operationId: string,
    request: ApprovalRequest,
    operationVersion: number,
  ) => Promise<OperationCallResult>
  executeOperation: (
    operationId: string,
    planHash: string,
    operationVersion: number,
  ) => Promise<OperationCallResult>
  verifyOperation: (
    operationId: string,
    operationVersion: number,
    checks?: ReadonlyArray<VerificationCheckName>,
  ) => Promise<OperationCallResult>
  rollbackDryRun: (
    operationId: string,
    request: { readonly reason: string; readonly preserve_data: boolean },
    operationVersion: number,
  ) => Promise<OperationCallResult>
  rollbackApprove: (
    operationId: string,
    request: RollbackApprovalRequest,
    operationVersion: number,
  ) => Promise<OperationCallResult>
  rollbackExecute: (
    operationId: string,
    request: RollbackExecuteRequest,
    operationVersion: number,
  ) => Promise<OperationCallResult>
  listAudit: (
    operationId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<AuditPage>
  /** Chave persistida para um escopo (usada pela UI para exibir a máscara). */
  idempotencyKeyFor: (scope: string) => string | null
}

// ---------------------------------------------------------------------------
// Implementação
// ---------------------------------------------------------------------------

function parseJsonSafe(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readErrorBody(
  value: unknown,
  fallback: { readonly status: number; readonly requestId: string },
): ProjectCenterV2ApiError {
  const candidate =
    typeof value === 'object' && value !== null && 'error' in value
      ? (value as ApiErrorBody).error
      : null
  const code: ErrorCode =
    candidate !== null && isErrorCode(candidate.code)
      ? candidate.code
      : fallback.status === 401
        ? 'UNAUTHORIZED'
        : fallback.status === 403
          ? 'FORBIDDEN'
          : fallback.status === 404
            ? 'NOT_FOUND'
            : fallback.status === 429
              ? 'RATE_LIMITED'
              : 'INTERNAL_ERROR'
  const rawMessage =
    candidate !== null && typeof candidate.message === 'string'
      ? candidate.message
      : `HTTP ${fallback.status}`
  const details: ReadonlyArray<ErrorDetail> =
    candidate !== null && Array.isArray(candidate.details)
      ? candidate.details.flatMap((detail) =>
          typeof detail === 'object' && detail !== null && 'reason' in detail
            ? [
                {
                  field:
                    'field' in detail && typeof detail.field === 'string'
                      ? detail.field
                      : undefined,
                  reason: String(detail.reason),
                },
              ]
            : [],
        )
      : []
  return new ProjectCenterV2ApiError({
    code,
    details,
    message: rawMessage,
    requestId:
      candidate !== null && typeof candidate.request_id === 'string'
        ? candidate.request_id
        : fallback.requestId,
    retryAfterSeconds:
      candidate !== null && typeof candidate.retry_after_seconds === 'number'
        ? candidate.retry_after_seconds
        : null,
    retryable:
      candidate !== null && typeof candidate.retryable === 'boolean'
        ? candidate.retryable
        : false,
    status: fallback.status,
  })
}

function readOperationResponse(value: unknown): Operation {
  const candidate =
    typeof value === 'object' && value !== null && 'operation' in value
      ? (value as { readonly operation?: unknown }).operation
      : undefined
  if (typeof candidate === 'object' && candidate !== null) {
    return candidate as Operation
  }
  throw new ProjectCenterV2ApiError({
    code: 'INTERNAL_ERROR',
    details: [],
    message: 'resposta sem operação tipada',
    requestId: 'unknown',
    retryAfterSeconds: null,
    retryable: false,
    status: 502,
  })
}

export function createProjectCenterV2Client(
  options: ProjectCenterV2ClientOptions = {},
): ProjectCenterV2Client {
  const baseUrl = options.baseUrl ?? PROJECT_CENTER_V2_API_PREFIX
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const store = options.idempotency ?? createSessionIdempotencyStore()
  const generateKey = options.keyGenerator ?? (() => generateIdempotencyKey())
  const generateRequestId =
    options.requestIdGenerator ?? (() => generateIdempotencyKey())
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? 1

  /**
   * Chave da mutação: persistida **antes** do primeiro POST e reutilizada
   * enquanto o payload canônico não mudar. Intenção nova ⇒ nova chave.
   */
  function keyFor(scope: string, payload: unknown): string {
    const canonical = canonicalJson(payload)
    const existing = store.read(scope)
    if (existing !== null && existing.intent === canonical) return existing.key
    const key = generateKey()
    if (!isValidIdempotencyKey(key)) {
      throw new ProjectCenterV2InputError(
        'idempotency_key',
        'gerador devolveu chave fora do contrato (16..128, [A-Za-z0-9._:-])',
      )
    }
    store.write(scope, { intent: canonical, key })
    return key
  }

  async function send(
    request: RequestInit & { readonly url: string },
  ): Promise<{ readonly response: Response; readonly text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetchImpl(request.url, {
        ...request,
        credentials: 'same-origin',
        signal: controller.signal,
      })
      const text = await response.text()
      return { response, text }
    } catch (error) {
      throw new ProjectCenterV2TransportError('falha de transporte na API v2', {
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  function headersFor(input: {
    readonly idempotencyKey?: string
    readonly ifMatchVersion?: number
    readonly requestId: string
    readonly json: boolean
  }): Record<string, string> {
    const headers: Record<string, string> = {
      [REQUEST_ID_HEADER]: input.requestId,
    }
    if (input.json) headers['Content-Type'] = 'application/json'
    if (input.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_HEADER] = input.idempotencyKey
    }
    if (input.ifMatchVersion !== undefined) {
      headers[IF_MATCH_HEADER] = `"${input.ifMatchVersion}"`
    }
    return headers
  }

  /**
   * Executa uma requisição com retry de transporte reutilizando a **mesma**
   * chave de idempotência (replay seguro após timeout).
   */
  async function call(input: {
    readonly scope: string
    readonly method: 'GET' | 'POST'
    readonly path: string
    readonly payload?: unknown
    readonly idempotent: boolean
    readonly ifMatchVersion?: number
  }): Promise<OperationCallResult> {
    const requestId = generateRequestId()
    const serialized =
      input.payload === undefined ? null : canonicalJson(input.payload)
    const idempotencyKey =
      input.idempotent && serialized !== null
        ? keyFor(input.scope, input.payload)
        : undefined
    const url = `${baseUrl}${input.path}`
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        const { response, text } = await send({
          body: serialized === null ? undefined : serialized,
          headers: headersFor({
            ifMatchVersion: input.ifMatchVersion,
            idempotencyKey,
            json: input.method === 'POST',
            requestId,
          }),
          method: input.method,
          url,
        })
        const parsed = parseJsonSafe(text)
        if (!response.ok) {
          throw readErrorBody(parsed, {
            requestId,
            status: response.status,
          })
        }
        return {
          operation: readOperationResponse(parsed),
          replayed:
            response.headers.get(IDEMPOTENCY_KEY_HEADER_REPLAYED) === 'true',
          requestId,
        }
      } catch (error) {
        // Retry apenas de transporte, nunca de resposta tipada do servidor.
        if (
          error instanceof ProjectCenterV2TransportError &&
          attempt <= retries
        ) {
          continue
        }
        throw error
      }
    }
  }

  async function listAudit(
    operationId: string,
    query: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<AuditPage> {
    const params = new URLSearchParams()
    if (query.cursor !== undefined) params.set('cursor', query.cursor)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    const requestId = generateRequestId()
    const { response, text } = await send({
      headers: headersFor({ json: false, requestId }),
      method: 'GET',
      url: `${baseUrl}/operations/${operationId}/audit${suffix}`,
    })
    const parsed = parseJsonSafe(text)
    if (!response.ok) {
      throw readErrorBody(parsed, { requestId, status: response.status })
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'events' in parsed &&
      Array.isArray((parsed as AuditPage).events)
    ) {
      return parsed as AuditPage
    }
    throw new ProjectCenterV2ApiError({
      code: 'INTERNAL_ERROR',
      details: [],
      message: 'resposta de auditoria inválida',
      requestId,
      retryAfterSeconds: null,
      retryable: false,
      status: 502,
    })
  }

  return {
    approveOperation: (operationId, request, operationVersion) =>
      call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/approve`,
        payload: request,
        scope: `approve:${operationId}`,
      }),
    dryRun: (request) =>
      call({
        idempotent: true,
        method: 'POST',
        path: '/operations/dry-run',
        payload: request,
        scope: 'dry-run',
      }),
    executeOperation: (operationId, planHash, operationVersion) =>
      call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/execute`,
        payload: { plan_hash: planHash },
        scope: `execute:${operationId}`,
      }),
    getOperation: (operationId) =>
      call({
        idempotent: false,
        method: 'GET',
        path: `/operations/${operationId}`,
        scope: `read:${operationId}`,
      }),
    idempotencyKeyFor: (scope) => store.read(scope)?.key ?? null,
    listAudit,
    rollbackApprove: (operationId, request, operationVersion) =>
      call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/rollback/approve`,
        payload: request,
        scope: `rollback-approve:${operationId}`,
      }),
    rollbackDryRun: (operationId, request, operationVersion) =>
      call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/rollback/dry-run`,
        payload: request,
        scope: `rollback-dry-run:${operationId}`,
      }),
    rollbackExecute: (operationId, request, operationVersion) =>
      call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/rollback/execute`,
        payload: request,
        scope: `rollback-execute:${operationId}`,
      }),
    async surface() {
      try {
        const requestId = generateRequestId()
        const { response, text } = await send({
          headers: headersFor({ json: false, requestId }),
          method: 'GET',
          url: `${baseUrl}/operations/${SURFACE_PROBE_OPERATION_ID}`,
        })
        if (response.ok) {
          return { apiEnabled: true, source: 'server', workerEnabled: null }
        }
        const parsed = parseJsonSafe(text)
        const error = readErrorBody(parsed, {
          requestId,
          status: response.status,
        })
        return {
          apiEnabled: !error.featureDisabled,
          source: 'server',
          workerEnabled: null,
        }
      } catch {
        // Fail-closed: sem confirmação do servidor, a experiência atual fica.
        return { apiEnabled: false, source: 'unavailable', workerEnabled: null }
      }
    },
    verifyOperation: (operationId, operationVersion, checks) => {
      const payload: VerifyRequest = checks === undefined ? {} : { checks }
      return call({
        idempotent: true,
        ifMatchVersion: operationVersion,
        method: 'POST',
        path: `/operations/${operationId}/verify`,
        payload,
        scope: `verify:${operationId}`,
      })
    },
  }
}

/** Estados válidos conhecidos pelo cliente (paridade com o contrato). */
export function isKnownOperationState(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (OPERATION_STATES as ReadonlyArray<string>).includes(value)
  )
}
