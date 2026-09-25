/**
 * Lease store do Project Center v2 (PR 6).
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §9 — lock
 * exclusivo por `environment + project_id`, aquisição atômica com `lease_id`,
 * **fencing token monotônico** e TTL de 60 s (renovação a cada 20 s). Apenas o
 * maior fencing token pode persistir resultado; writer stale é recusado.
 *
 * Falha de aquisição é `409 OPERATION_LOCKED` com `retry_after_seconds`, sem
 * revelar o outro ator (§9). A única reaquisição concedida é a do próprio dono
 * **com prova de posse** (`lease_id` apresentado por quem recebeu o grant):
 * `holder_ref` + `operation_id` idênticos não reabrem o lock, porque a
 * identidade do worker nunca pode ser uma constante compartilhada entre
 * processos. Este módulo é puro em relação a I/O: nenhum
 * banco, Docker, shell, secret ou path. A persistência durável do deployment é
 * injetada por interface (`LeaseStore`) e o in-memory é o fixture de teste.
 *
 * Nada aqui ativa execução: quem chama (worker) só existe com
 * `PROJECT_CENTER_V2_WORKER_ENABLED=true`, revalidada antes de cada ação.
 */
import { randomUUID } from 'node:crypto'
import { ENVIRONMENTS } from './domain'
import type { Environment } from './domain'
import type { LeaseGuard } from './http'

/** TTL canônico do lease (§9). */
export const LEASE_TTL_SECONDS = 60
/** Intervalo de renovação declarado (§9); o worker renova antes de expirar. */
export const LEASE_RENEW_INTERVAL_SECONDS = 20
/** Faixa aceita de TTL: nunca maior que o teto nem menor que uma execução. */
export const LEASE_MIN_TTL_SECONDS = 5
export const LEASE_MAX_TTL_SECONDS = 300
/** Primeiro fencing token emitido por escopo (nunca retrocede). */
export const LEASE_FIRST_FENCING_TOKEN = 1
/**
 * Tetos de referência de escopo: `project_id` do contrato tem no máximo 48
 * caracteres e `holder_ref` no máximo 128. Nada de identificador livre.
 */
export const LEASE_PROJECT_ID_MAX_LENGTH = 48
export const LEASE_HOLDER_REF_MAX_LENGTH = 128
export const LEASE_OPERATION_ID_MAX_LENGTH = 128
export const LEASE_LEASE_ID_MAX_LENGTH = 128
export const LEASE_SCOPE_SEPARATOR = ':'

export interface LeaseScope {
  readonly projectId: string
  readonly environment: Environment
}

/** Erro de uso do store (entrada malformada) — nunca chega à HTTP pública. */
export class LeaseInputError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly field: string

  constructor(field: string) {
    super(`entrada de lease invalida: ${field}`)
    this.name = 'LeaseInputError'
    this.field = field
  }
}

/** Escopo já possui lease vivo de outro holder/operação (§9). */
export class LeaseHeldError extends Error {
  readonly code = 'OPERATION_LOCKED'
  readonly status = 409
  readonly retry_after_seconds: number

  constructor(retryAfterSeconds: number) {
    super('operacao com lease exclusivo')
    this.name = 'LeaseHeldError'
    this.retry_after_seconds = retryAfterSeconds
  }
}

/** Lease sumiu (expirado, liberado ou entregue a outro holder). */
export class LeaseLostError extends Error {
  readonly code = 'OPERATION_LOCKED'
  readonly status = 409
  readonly reason:
    | 'unknown'
    | 'expired'
    | 'released'
    | 'holder_mismatch'
    | 'lease_mismatch'
    | 'operation_mismatch'

  constructor(reason: LeaseLostError['reason']) {
    super('lease perdido')
    this.name = 'LeaseLostError'
    this.reason = reason
  }
}

/**
 * Writer stale: apresentou fencing token anterior ao lease vigente. É o
 * controle que impede dois workers concorrentes de persistirem resultado
 * (§9: "apenas o maior fencing token pode persistir resultado").
 */
export class StaleWriterError extends Error {
  readonly code = 'OPERATION_LOCKED'
  readonly status = 409
  readonly reason = 'stale_fencing_token'
  readonly presented: number
  readonly current: number

  constructor(presented: number, current: number) {
    super('fencing token anterior ao lease vigente')
    this.name = 'StaleWriterError'
    this.presented = presented
    this.current = current
  }
}

export interface LeaseGrant {
  readonly lease_id: string
  readonly scope_key: string
  readonly project_id: string
  readonly environment: Environment
  readonly operation_id: string
  readonly holder_ref: string
  /** Monotônico por escopo: cresce a cada nova aquisição, mesmo após liberar. */
  readonly fencing_token: number
  readonly acquired_at: string
  readonly expires_at: string
  readonly ttl_seconds: number
  readonly renew_count: number
}

export interface AcquireLeaseInput {
  readonly operationId: string
  readonly projectId: string
  readonly environment: Environment
  readonly holderRef: string
  readonly ttlSeconds?: number
  /**
   * Prova de posse do lease vigente: o `lease_id` que o próprio dono recebeu.
   *
   * A reaquisição idempotente (retry do mesmo dono, sem token novo) só é
   * concedida a quem apresenta esta prova. `holder_ref` + `operation_id`
   * iguais **não** bastam: duas réplicas do mesmo worker com identidade
   * compartilhada receberiam o mesmo `lease_id`/`fencing_token` e o fencing
   * deixaria de detectar a execução dupla (F1 do cross-review de Security).
   * Sem a prova, a resposta é `409 OPERATION_LOCKED`, sem revelar o outro ator.
   */
  readonly leaseId?: string
}

export interface RenewLeaseInput {
  readonly leaseId: string
  readonly fencingToken: number
  readonly holderRef: string
  readonly ttlSeconds?: number
}

export interface ReleaseLeaseInput {
  readonly leaseId: string
  readonly fencingToken: number
  readonly holderRef: string
}

/** Guarda de escrita: prova posse do lease vigente antes de qualquer efeito. */
export interface LeaseWriterInput {
  readonly scope: LeaseScope
  readonly leaseId: string
  readonly fencingToken: number
  readonly holderRef: string
}

export interface LeaseStore {
  acquire: (input: AcquireLeaseInput) => LeaseGrant
  renew: (input: RenewLeaseInput) => LeaseGrant
  release: (input: ReleaseLeaseInput) => void
  current: (scope: LeaseScope) => LeaseGrant | null
  holder: (operationId: string) => { readonly holder_ref: string } | null
  assertWriter: (input: LeaseWriterInput) => LeaseGrant
  highestFencingToken: (scope: LeaseScope) => number
  expire: (nowMs?: number) => number
  list: () => ReadonlyArray<LeaseGrant>
}

export interface InMemoryLeaseStoreOptions {
  readonly now?: () => Date
  readonly generateId?: () => string
}

function isEnvironment(value: unknown): value is Environment {
  return (
    typeof value === 'string' &&
    (ENVIRONMENTS as ReadonlyArray<string>).includes(value)
  )
}

/**
 * Chave de escopo normalizada (`<environment>:<project_id>`). Só aceita
 * ambiente do contrato e `project_id` no formato canônico — nada de path,
 * barra, espaço ou URI.
 */
export function leaseScopeKey(scope: LeaseScope): string {
  if (!isEnvironment(scope.environment)) {
    throw new LeaseInputError('environment')
  }
  const projectId = scope.projectId
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.length > LEASE_PROJECT_ID_MAX_LENGTH ||
    !/^[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/.test(projectId)
  ) {
    throw new LeaseInputError('project_id')
  }
  return `${scope.environment}${LEASE_SCOPE_SEPARATOR}${projectId}`
}

function assertHolderRef(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LEASE_HOLDER_REF_MAX_LENGTH ||
    /\s/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new LeaseInputError('holder_ref')
  }
  return value
}

function assertOperationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > LEASE_OPERATION_ID_MAX_LENGTH ||
    /\s/.test(value)
  ) {
    throw new LeaseInputError('operation_id')
  }
  return value
}

/**
 * Prova de posse apresentada na reaquisição: quando informada, precisa ter
 * forma de identificador de lease (nunca path, espaço ou URI).
 */
function assertLeaseProof(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LEASE_LEASE_ID_MAX_LENGTH ||
    /\s/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new LeaseInputError('lease_id')
  }
  return value
}

function assertFencingToken(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < LEASE_FIRST_FENCING_TOKEN
  ) {
    throw new LeaseInputError('fencing_token')
  }
  return value
}

function assertTtl(value: number | undefined): number {
  if (value === undefined) return LEASE_TTL_SECONDS
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < LEASE_MIN_TTL_SECONDS ||
    value > LEASE_MAX_TTL_SECONDS
  ) {
    throw new LeaseInputError('ttl_seconds')
  }
  return value
}

function freezeGrant(grant: LeaseGrant): LeaseGrant {
  return Object.freeze(grant)
}

/**
 * Lease store in-memory: fixture de teste e implementação de referência do
 * contrato. O adapter durável do deployment precisa reproduzir exatamente
 * estas invariantes (aquisição atômica, token monotônico, recusa de stale).
 */
export function createInMemoryLeaseStore(
  options: InMemoryLeaseStoreOptions = {},
): LeaseStore {
  const now = options.now ?? (() => new Date())
  const generateId = options.generateId ?? (() => randomUUID())
  /** Lease vivo por escopo. */
  const grants = new Map<string, LeaseGrant>()
  /** Maior fencing token já emitido por escopo (nunca decresce). */
  const issued = new Map<string, number>()

  function reference(): number {
    return now().getTime()
  }

  function isExpired(grant: LeaseGrant, at: number): boolean {
    return Date.parse(grant.expires_at) <= at
  }

  function live(scopeKey: string, at: number): LeaseGrant | null {
    const grant = grants.get(scopeKey)
    if (grant === undefined) return null
    if (isExpired(grant, at)) {
      grants.delete(scopeKey)
      return null
    }
    return grant
  }

  function nextFencingToken(scopeKey: string): number {
    const token = (issued.get(scopeKey) ?? 0) + 1
    issued.set(scopeKey, token)
    return token
  }

  function requireGrant(leaseId: string, at: number): LeaseGrant {
    for (const grant of grants.values()) {
      if (grant.lease_id !== leaseId) continue
      if (isExpired(grant, at)) {
        grants.delete(grant.scope_key)
        throw new LeaseLostError('expired')
      }
      return grant
    }
    throw new LeaseLostError('unknown')
  }

  return {
    acquire(input: AcquireLeaseInput): LeaseGrant {
      const scopeKey = leaseScopeKey({
        projectId: input.projectId,
        environment: input.environment,
      })
      const holderRef = assertHolderRef(input.holderRef)
      const operationId = assertOperationId(input.operationId)
      const ttlSeconds = assertTtl(input.ttlSeconds)
      const leaseProof = assertLeaseProof(input.leaseId)
      const at = reference()

      const currentGrant = live(scopeKey, at)
      if (currentGrant !== null) {
        // Reaquisição idempotente **só com prova de posse**: o retry do próprio
        // dono apresenta o `lease_id` que recebeu e não emite token novo (caso
        // contrário invalidaria a própria escrita). Identidade igual não é
        // prova — dois processos com a mesma `holder_ref` não compartilham o
        // lock, e a tentativa sem prova recebe 409 como qualquer concorrente.
        const provesPossession =
          leaseProof !== undefined && leaseProof === currentGrant.lease_id
        if (
          provesPossession &&
          currentGrant.holder_ref === holderRef &&
          currentGrant.operation_id === operationId
        ) {
          return currentGrant
        }
        const retryAfter = Math.max(
          1,
          Math.ceil((Date.parse(currentGrant.expires_at) - at) / 1000),
        )
        throw new LeaseHeldError(retryAfter)
      }

      const acquiredAt = now()
      const grant = freezeGrant({
        lease_id: generateId(),
        scope_key: scopeKey,
        project_id: input.projectId,
        environment: input.environment,
        operation_id: operationId,
        holder_ref: holderRef,
        fencing_token: nextFencingToken(scopeKey),
        acquired_at: acquiredAt.toISOString(),
        expires_at: new Date(
          acquiredAt.getTime() + ttlSeconds * 1000,
        ).toISOString(),
        ttl_seconds: ttlSeconds,
        renew_count: 0,
      })
      grants.set(scopeKey, grant)
      return grant
    },

    renew(input: RenewLeaseInput): LeaseGrant {
      const fencingToken = assertFencingToken(input.fencingToken)
      const holderRef = assertHolderRef(input.holderRef)
      const ttlSeconds = assertTtl(input.ttlSeconds)
      const at = reference()
      const grant = requireGrant(input.leaseId, at)
      if (grant.holder_ref !== holderRef)
        throw new LeaseLostError('holder_mismatch')
      if (grant.fencing_token !== fencingToken) {
        throw new StaleWriterError(fencingToken, grant.fencing_token)
      }
      const renewedAt = now()
      const renewed = freezeGrant({
        ...grant,
        expires_at: new Date(
          renewedAt.getTime() + ttlSeconds * 1000,
        ).toISOString(),
        ttl_seconds: ttlSeconds,
        renew_count: grant.renew_count + 1,
      })
      grants.set(grant.scope_key, renewed)
      return renewed
    },

    release(input: ReleaseLeaseInput): void {
      const fencingToken = assertFencingToken(input.fencingToken)
      const holderRef = assertHolderRef(input.holderRef)
      const at = reference()
      const grant = requireGrant(input.leaseId, at)
      if (grant.holder_ref !== holderRef)
        throw new LeaseLostError('holder_mismatch')
      if (grant.fencing_token !== fencingToken) {
        throw new StaleWriterError(fencingToken, grant.fencing_token)
      }
      grants.delete(grant.scope_key)
    },

    current(scope: LeaseScope): LeaseGrant | null {
      return live(leaseScopeKey(scope), reference())
    },

    holder(operationId: string): { readonly holder_ref: string } | null {
      const at = reference()
      for (const grant of grants.values()) {
        if (grant.operation_id !== operationId) continue
        if (isExpired(grant, at)) {
          grants.delete(grant.scope_key)
          return null
        }
        return { holder_ref: grant.holder_ref }
      }
      return null
    },

    assertWriter(input: LeaseWriterInput): LeaseGrant {
      const scopeKey = leaseScopeKey(input.scope)
      const fencingToken = assertFencingToken(input.fencingToken)
      const holderRef = assertHolderRef(input.holderRef)
      const at = reference()
      const grant = grants.get(scopeKey)

      if (grant === undefined) {
        // Sem lease vigente, qualquer escrita é recusada: ou expirou, ou foi
        // liberada, ou o escopo nunca foi adquirido.
        const everIssued = (issued.get(scopeKey) ?? 0) > 0
        throw new LeaseLostError(everIssued ? 'released' : 'unknown')
      }
      if (isExpired(grant, at)) {
        grants.delete(scopeKey)
        throw new LeaseLostError('expired')
      }
      // Somente o token exato do lease vigente escreve: token anterior é
      // writer stale e token maior é forjado — os dois são recusados.
      if (fencingToken !== grant.fencing_token) {
        throw new StaleWriterError(fencingToken, grant.fencing_token)
      }
      if (input.leaseId !== grant.lease_id)
        throw new LeaseLostError('lease_mismatch')
      if (holderRef !== grant.holder_ref)
        throw new LeaseLostError('holder_mismatch')
      return grant
    },

    highestFencingToken(scope: LeaseScope): number {
      return issued.get(leaseScopeKey(scope)) ?? 0
    },

    expire(nowMs?: number): number {
      const at = nowMs ?? reference()
      let removed = 0
      for (const [scopeKey, grant] of grants) {
        if (!isExpired(grant, at)) continue
        grants.delete(scopeKey)
        removed += 1
      }
      return removed
    },

    list(): ReadonlyArray<LeaseGrant> {
      return Object.freeze([...grants.values()])
    },
  }
}

/**
 * Adapta o store à porta `LeaseGuard` já consumida pela camada HTTP (PR 4):
 * `holder(operationId)` responde somente se existe lease vivo para a operação.
 */
export function createLeaseGuard(store: LeaseStore): LeaseGuard {
  return {
    holder: (operationId: string) => store.holder(operationId),
  }
}
