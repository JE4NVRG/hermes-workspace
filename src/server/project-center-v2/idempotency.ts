/**
 * Idempotência client-owned, outbox e unidade de trabalho atômica (PR 4).
 *
 * Regras canônicas do contrato (`components.parameters.IdempotencyKey`) e do
 * plano:
 * - toda mutação carrega `Idempotency-Key` gerada/persistida pelo cliente antes
 *   da primeira tentativa; o servidor persiste **somente o hash** da chave,
 *   vinculado a ator, rota e hash canônico do payload, por 24 horas;
 * - replay com a mesma chave, ator, rota e payload devolve exatamente a
 *   resposta registrada;
 * - mesma chave com payload/ator/rota diferentes é conflito fechado
 *   `IDEMPOTENCY_KEY_REUSED` (409) — nunca reexecução silenciosa;
 * - operação, auditoria, outbox e escritas de aprovação entram em um **único
 *   bloco síncrono**: qualquer falha compensa o que já foi aplicado antes de
 *   propagar o erro, então nunca existe operação sem outbox (nem o contrário);
 * - o registro guarda o `operation_id` no commit durável e só depois recebe a
 *   resposta: uma queda entre os dois passos deixa o registro pendente e a
 *   próxima tentativa com a mesma chave **recupera** a resposta em vez de
 *   reexecutar o efeito.
 *
 * Nada aqui abre conexão: os stores são in-memory por contrato do PR (o
 * adapter durável chega no PR 6) e só recebem dados já validados.
 */
import { createHash, randomUUID } from 'node:crypto'
import { idempotencyKeySchema } from './domain'
import { hashCanonical } from './drivers/types'
import type { AuditAppendInput, AuditStore } from './audit-store'
import type { Environment, Operation } from './domain'
import type { CreateOperationInput, OperationStore } from './operation-store'
import type { OperationState } from './state-machine'

/** Validade do registro de idempotência (contrato): 24 horas. */
export const IDEMPOTENCY_TTL_SECONDS = 86_400
/** Prefixo do hash persistido; a chave crua nunca é guardada. */
export const IDEMPOTENCY_KEY_HASH_PREFIX = 'idem_'

/** Operações que a camada HTTP enfileira no outbox (consumido no PR 6). */
export const OUTBOX_KINDS = ['execute', 'verify', 'rollback_execute'] as const
export type OutboxKind = (typeof OUTBOX_KINDS)[number]

export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly status = 400
  readonly reason: string

  constructor(reason: string) {
    super('chave de idempotencia invalida')
    this.name = 'InvalidIdempotencyKeyError'
    this.reason = reason
  }
}

/** Mesma chave reaproveitada com ator, rota ou payload diferente. */
export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED'
  readonly status = 409

  constructor() {
    super('chave de idempotencia reutilizada com payload diferente')
    this.name = 'IdempotencyKeyReusedError'
  }
}

/** Claim inconsistente: uso incorreto do store (bug interno, fail closed). */
export class IdempotencyClaimError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly status = 500
  readonly reason: string

  constructor(reason: string) {
    super('claim de idempotencia inconsistente')
    this.name = 'IdempotencyClaimError'
    this.reason = reason
  }
}

/** Falha de commit atômico depois da compensação (nunca parcial silencioso). */
export class AtomicCommitError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly status = 500
  readonly step: string
  readonly compensated: boolean

  constructor(step: string, compensated: boolean, cause: unknown) {
    super('commit atomico falhou', { cause })
    this.name = 'AtomicCommitError'
    this.step = step
    this.compensated = compensated
  }
}

// ---------------------------------------------------------------------------
// Hash da chave e do payload
// ---------------------------------------------------------------------------

/** Valida a chave crua e devolve **somente** o hash persistível. */
export function hashIdempotencyKey(rawKey: unknown): string {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new InvalidIdempotencyKeyError('missing')
  }
  const parsed = idempotencyKeySchema.safeParse(rawKey)
  if (!parsed.success) throw new InvalidIdempotencyKeyError('malformed')
  return `${IDEMPOTENCY_KEY_HASH_PREFIX}${createHash('sha256')
    .update(parsed.data)
    .digest('hex')}`
}

/**
 * Hash canônico do payload efetivo da requisição (corpo + parâmetro de rota).
 * É a amarração que detecta reaproveitamento de chave com payload diferente.
 */
export function hashRequestPayload(payload: unknown): string {
  return hashCanonical(payload)
}

// ---------------------------------------------------------------------------
// Outbox (escrito de forma atômica com a operação; consumido no PR 6)
// ---------------------------------------------------------------------------

export interface OutboxAppendInput {
  readonly operationId: string
  readonly kind: OutboxKind
  readonly planHash: string
  readonly projectId: string
  readonly environment: Environment
  readonly outboxId?: string
  readonly enqueuedAt?: string
}

export interface OutboxEntry {
  readonly outbox_id: string
  readonly operation_id: string
  readonly kind: OutboxKind
  readonly plan_hash: string
  readonly project_id: string
  readonly environment: Environment
  readonly enqueued_at: string
  /** Tentativa inicial; incrementada apenas pelo worker (PR 6). */
  readonly attempt: number
  /** `pending` enquanto nenhum worker reivindicou a entrada. */
  readonly state: 'pending'
}

export interface OutboxStore {
  append: (input: OutboxAppendInput) => OutboxEntry
  list: () => ReadonlyArray<OutboxEntry>
  listFor: (operationId: string) => ReadonlyArray<OutboxEntry>
  /** Compensação do commit atômico; nunca exposto à superfície HTTP. */
  discard: (outboxId: string) => void
}

export interface InMemoryOutboxStoreOptions {
  readonly now?: () => string
  readonly generateId?: () => string
}

export function createInMemoryOutboxStore(
  options: InMemoryOutboxStoreOptions = {},
): OutboxStore {
  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => randomUUID())
  const entries = new Map<string, OutboxEntry>()

  return {
    append(input: OutboxAppendInput): OutboxEntry {
      if (
        typeof input.operationId !== 'string' ||
        input.operationId.length === 0 ||
        !(OUTBOX_KINDS as ReadonlyArray<string>).includes(input.kind) ||
        !/^[a-f0-9]{64}$/.test(input.planHash)
      ) {
        throw new IdempotencyClaimError('outbox_input')
      }
      const entry: OutboxEntry = Object.freeze({
        outbox_id: input.outboxId ?? generateId(),
        operation_id: input.operationId,
        kind: input.kind,
        plan_hash: input.planHash,
        project_id: input.projectId,
        environment: input.environment,
        enqueued_at: input.enqueuedAt ?? now(),
        attempt: 1,
        state: 'pending',
      })
      entries.set(entry.outbox_id, entry)
      return entry
    },

    list(): ReadonlyArray<OutboxEntry> {
      return Object.freeze([...entries.values()])
    },

    listFor(operationId: string): ReadonlyArray<OutboxEntry> {
      return Object.freeze(
        [...entries.values()].filter(
          (entry) => entry.operation_id === operationId,
        ),
      )
    },

    discard(outboxId: string): void {
      entries.delete(outboxId)
    },
  }
}

// ---------------------------------------------------------------------------
// Registro de idempotência
// ---------------------------------------------------------------------------

/** Resposta registrada no commit; replay devolve exatamente esta forma. */
export interface StoredResponse {
  readonly status: number
  readonly body: unknown
}

export interface IdempotencyRecord {
  readonly key_hash: string
  readonly actor_ref: string
  readonly route_id: string
  readonly request_hash: string
  readonly state: 'pending' | 'completed'
  readonly operation_id: string | null
  readonly response: StoredResponse | null
  readonly created_at: string
  readonly expires_at: string
}

export interface IdempotencyClaim {
  readonly key_hash: string
  readonly actor_ref: string
  readonly route_id: string
  readonly request_hash: string
}

export type IdempotencyBeginOutcome =
  | { readonly kind: 'new'; readonly claim: IdempotencyClaim }
  | {
      readonly kind: 'replay'
      readonly claim: IdempotencyClaim
      readonly response: StoredResponse
    }
  | {
      readonly kind: 'recover'
      readonly claim: IdempotencyClaim
      readonly operation_id: string
    }

export interface BeginInput {
  readonly rawKey: string
  readonly actorRef: string
  readonly routeId: string
  readonly requestHash: string
}

// ---------------------------------------------------------------------------
// Unidade de trabalho
// ---------------------------------------------------------------------------

export type PendingOperation =
  | { readonly kind: 'create'; readonly input: CreateOperationInput }
  | {
      readonly kind: 'transition'
      readonly operationId: string
      readonly next: OperationState
      readonly expectedRevision: number
    }

/** Escrita adicional (aprovação, plano de rollback) com compensação própria. */
export interface CompensableWrite {
  readonly label: string
  apply: () => void
  compensate: () => void
}

export interface TransactionPlan {
  /**
   * Passos de operação aplicados em ordem (ex.: criar em `planned` e mover
   * para `awaiting_approval` no mesmo commit). Ausente quando a transação só
   * grava artefatos derivados (verificação, rollback).
   */
  readonly operations?: ReadonlyArray<PendingOperation>
  /**
   * Operação à qual a transação se vincula quando não há passo de operação
   * (verificação, rollback de uma operação existente). Amarra o registro de
   * idempotência ao alvo, habilitando a recuperação após timeout.
   */
  readonly operationId?: string
  readonly audit?: ReadonlyArray<AuditAppendInput>
  readonly outbox?: ReadonlyArray<OutboxAppendInput>
  readonly extra?: ReadonlyArray<CompensableWrite>
}

export interface TransactionResult {
  readonly operation: Operation | null
  readonly outbox: ReadonlyArray<OutboxEntry>
}

export interface CommitHooks {
  /**
   * Executado depois do bloco durável e **antes** do registro da resposta.
   * Existe para que o teste possa simular queda/timeout entre os dois passos e
   * provar que a próxima tentativa recupera a resposta registrada.
   */
  readonly afterCommit?: (result: TransactionResult) => void
}

export interface IdempotencyStore {
  begin: (input: BeginInput) => IdempotencyBeginOutcome
  commit: (
    claim: IdempotencyClaim,
    plan: TransactionPlan,
    hooks?: CommitHooks,
  ) => TransactionResult
  complete: (
    claim: IdempotencyClaim,
    operationId: string,
    response: StoredResponse,
  ) => IdempotencyRecord
  get: (keyHash: string) => IdempotencyRecord | null
  prune: (nowMs?: number) => number
}

export interface IdempotencyStoreOptions {
  readonly operations: OperationStore
  readonly audit: AuditStore
  readonly outbox: OutboxStore
  readonly now?: () => Date
  readonly ttlSeconds?: number
}

function freezeResponse(response: StoredResponse): StoredResponse {
  return Object.freeze({
    status: response.status,
    body: response.body,
  })
}

export function createIdempotencyStore(
  options: IdempotencyStoreOptions,
): IdempotencyStore {
  const now = options.now ?? (() => new Date())
  const ttlSeconds = options.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS
  const records = new Map<string, IdempotencyRecord>()

  function claimOf(record: IdempotencyRecord): IdempotencyClaim {
    return Object.freeze({
      key_hash: record.key_hash,
      actor_ref: record.actor_ref,
      route_id: record.route_id,
      request_hash: record.request_hash,
    })
  }

  function isExpired(record: IdempotencyRecord, reference: number): boolean {
    return Date.parse(record.expires_at) <= reference
  }

  function requirePending(
    claim: IdempotencyClaim,
    reference: number,
  ): IdempotencyRecord {
    const record = records.get(claim.key_hash)
    if (record === undefined || isExpired(record, reference)) {
      throw new IdempotencyClaimError('unknown_claim')
    }
    if (
      record.actor_ref !== claim.actor_ref ||
      record.route_id !== claim.route_id ||
      record.request_hash !== claim.request_hash
    ) {
      throw new IdempotencyClaimError('claim_mismatch')
    }
    if (record.state !== 'pending') {
      throw new IdempotencyClaimError('not_pending')
    }
    return record
  }

  function applyPendingOperation(plan: PendingOperation): Operation {
    if (plan.kind === 'create') return options.operations.create(plan.input)
    return options.operations.transition(
      plan.operationId,
      plan.next,
      plan.expectedRevision,
    )
  }

  return {
    begin(input: BeginInput): IdempotencyBeginOutcome {
      const keyHash = hashIdempotencyKey(input.rawKey)
      const reference = now().getTime()
      const existing = records.get(keyHash)

      if (existing !== undefined && !isExpired(existing, reference)) {
        if (
          existing.actor_ref !== input.actorRef ||
          existing.route_id !== input.routeId ||
          existing.request_hash !== input.requestHash
        ) {
          throw new IdempotencyKeyReusedError()
        }
        if (existing.state === 'completed' && existing.response !== null) {
          return {
            kind: 'replay',
            claim: claimOf(existing),
            response: existing.response,
          }
        }
        if (existing.operation_id !== null) {
          return {
            kind: 'recover',
            claim: claimOf(existing),
            operation_id: existing.operation_id,
          }
        }
        // Pendente sem commit durável: a tentativa anterior falhou antes de
        // escrever qualquer efeito, então a mesma chave pode reexecutar.
        return { kind: 'new', claim: claimOf(existing) }
      }

      const createdAt = now()
      const record: IdempotencyRecord = Object.freeze({
        key_hash: keyHash,
        actor_ref: input.actorRef,
        route_id: input.routeId,
        request_hash: input.requestHash,
        state: 'pending',
        operation_id: null,
        response: null,
        created_at: createdAt.toISOString(),
        expires_at: new Date(
          createdAt.getTime() + ttlSeconds * 1000,
        ).toISOString(),
      })
      records.set(keyHash, record)
      return { kind: 'new', claim: claimOf(record) }
    },

    commit(
      claim: IdempotencyClaim,
      plan: TransactionPlan,
      hooks: CommitHooks = {},
    ): TransactionResult {
      const reference = now().getTime()
      requirePending(claim, reference)

      // Ordem deliberada: extras (compensáveis) -> operação (âncora da
      // auditoria) -> outbox -> auditoria. Cada passo registra sua compensação
      // antes de aplicar o próximo; a compensação roda em ordem inversa.
      const compensations: Array<{ step: string; undo: () => void }> = []
      let operation: Operation | null = null
      let outbox: ReadonlyArray<OutboxEntry> = Object.freeze([])

      try {
        for (const extra of plan.extra ?? []) {
          compensations.push({ step: extra.label, undo: extra.compensate })
          extra.apply()
        }

        for (const step of plan.operations ?? []) {
          const applied = applyPendingOperation(step)
          if (step.kind === 'create') {
            const createdId = applied.operation_id
            compensations.push({
              step: 'discard_operation',
              undo: () => {
                if (typeof options.operations.discard !== 'function') return
                options.operations.discard(createdId)
              },
            })
          }
          operation = applied
        }

        const appended: Array<OutboxEntry> = []
        for (const input of plan.outbox ?? []) {
          compensations.push({
            step: 'discard_outbox',
            undo: () => {
              for (const entry of appended)
                options.outbox.discard(entry.outbox_id)
            },
          })
          appended.push(options.outbox.append(input))
        }
        outbox = Object.freeze([...appended])

        for (const input of plan.audit ?? []) {
          options.audit.append(input)
        }
      } catch (error) {
        let compensated = true
        for (const compensation of [...compensations].reverse()) {
          try {
            compensation.undo()
          } catch {
            compensated = false
          }
        }
        throw new AtomicCommitError(
          compensations.at(-1)?.step ?? 'apply',
          compensated,
          error,
        )
      }

      // Commit durável: guarda a operação no registro. A resposta só entra no
      // passo seguinte — queda aqui é recuperável pela mesma chave.
      const current = records.get(claim.key_hash)
      if (current === undefined || current.state !== 'pending') {
        throw new IdempotencyClaimError('record_lost')
      }
      const boundOperationId =
        operation?.operation_id ?? plan.operationId ?? null
      if (boundOperationId === null) {
        throw new IdempotencyClaimError('transaction_without_operation')
      }
      records.set(
        current.key_hash,
        Object.freeze({ ...current, operation_id: boundOperationId }),
      )
      hooks.afterCommit?.({ operation, outbox })
      return Object.freeze({ operation, outbox })
    },

    complete(
      claim: IdempotencyClaim,
      operationId: string,
      response: StoredResponse,
    ): IdempotencyRecord {
      const reference = now().getTime()
      const record = requirePending(claim, reference)
      if (record.operation_id !== null && record.operation_id !== operationId) {
        throw new IdempotencyClaimError('operation_mismatch')
      }
      const completed: IdempotencyRecord = Object.freeze({
        ...record,
        state: 'completed',
        operation_id: operationId,
        response: freezeResponse(response),
      })
      records.set(completed.key_hash, completed)
      return completed
    },

    get(keyHash: string): IdempotencyRecord | null {
      return records.get(keyHash) ?? null
    },

    prune(nowMs?: number): number {
      const reference = nowMs ?? now().getTime()
      let removed = 0
      for (const [keyHash, record] of records) {
        if (isExpired(record, reference)) {
          records.delete(keyHash)
          removed += 1
        }
      }
      return removed
    },
  }
}
