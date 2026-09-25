/**
 * Auditoria append-only do Project Center v2 (PR 1).
 *
 * Interface + implementação in-memory para testes unitários. Nenhum store de
 * runtime é instanciado neste PR: quem constrói a instância real é o PR 4/6.
 *
 * Invariantes garantidas pelo adapter:
 * - sequência monotônica por operação, começando em 1 e nunca reutilizada;
 * - correlação obrigatória (operação + request id + ator);
 * - paginação por cursor opaco com limite contratual (default 100, máximo 500);
 * - `update`/`delete` sempre negados (append-only);
 * - payload passa por redaction antes de ser persistido e o evento fica
 *   congelado (não há mutação posterior).
 */
import { randomUUID } from 'node:crypto'
import { AUDIT_OUTCOMES, auditEventSchema } from './domain'
import { toSafePayload } from './redaction'
import type { AuditEvent, AuditOutcome } from './domain'
import type { OperationState } from './state-machine'

export const AUDIT_PAGE_DEFAULT_LIMIT = 100
export const AUDIT_PAGE_MAX_LIMIT = 500
export const AUDIT_PAGE_MIN_LIMIT = 1
const CURSOR_PREFIX = 'pcv2-audit:v1'

/** Toda mutação de evento é negada: a trilha é append-only. */
export class AppendOnlyViolationError extends Error {
  readonly code = 'FORBIDDEN'
  readonly operation: string

  constructor(operation: string) {
    super(`auditoria append-only: ${operation} negado`)
    this.name = 'AppendOnlyViolationError'
    this.operation = operation
  }
}

/** Cursor fora do formato/da operação consultada. */
export class AuditCursorError extends Error {
  readonly code = 'INVALID_REQUEST'

  constructor(message: string) {
    super(message)
    this.name = 'AuditCursorError'
  }
}

/** Evento/payload fora do contrato. */
export class InvalidAuditEventError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly issues: number

  constructor(issues: number) {
    super('evento de auditoria invalido')
    this.name = 'InvalidAuditEventError'
    this.issues = issues
  }
}

export interface AuditCorrelation {
  readonly operationId: string
  readonly requestId: string
}

/** Registro interno: evento do contrato + correlação (não serializada). */
export interface AuditRecord {
  readonly event: AuditEvent
  readonly correlation: AuditCorrelation
}

export interface AuditAppendInput {
  readonly operationId: string
  readonly requestId: string
  readonly type: string
  readonly actorRef: string
  readonly outcome: AuditOutcome
  readonly fromState?: OperationState | null
  readonly toState?: OperationState | null
  readonly actionKind?: string
  readonly attempt?: number
  readonly safePayload?: Record<string, unknown>
  readonly occurredAt?: string
  readonly eventId?: string
}

export interface AuditQuery {
  readonly requestId?: string
  readonly cursor?: string | null
  readonly limit?: number
}

export interface AuditListPage {
  readonly request_id: string
  readonly operation_id: string
  readonly events: ReadonlyArray<AuditEvent>
  readonly next_cursor: string | null
}

export interface AuditStore {
  append: (input: AuditAppendInput) => AuditRecord
  list: (operationId: string, query?: AuditQuery) => AuditListPage
  lastSequence: (operationId: string) => number
  update: () => never
  delete: () => never
}

export interface InMemoryAuditStoreOptions {
  readonly now?: () => string
  readonly generateId?: () => string
}

function encodeCursor(operationId: string, sequence: number): string {
  return Buffer.from(
    `${CURSOR_PREFIX}:${operationId}:${sequence}`,
    'utf8',
  ).toString('base64url')
}

function decodeCursor(cursor: string, operationId: string): number {
  let decoded: string
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw new AuditCursorError('cursor de auditoria invalido')
  }
  const parts = decoded.split(':')
  const [prefix, version, owner, rawSequence] = parts
  if (
    parts.length !== 4 ||
    prefix !== 'pcv2-audit' ||
    version !== 'v1' ||
    owner !== operationId
  ) {
    throw new AuditCursorError('cursor de auditoria invalido')
  }
  const parsed = Number.parseInt(rawSequence, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AuditCursorError('cursor de auditoria invalido')
  }
  return parsed
}

function assertLimit(limit: number | undefined): number {
  if (limit === undefined) return AUDIT_PAGE_DEFAULT_LIMIT
  if (
    !Number.isInteger(limit) ||
    limit < AUDIT_PAGE_MIN_LIMIT ||
    limit > AUDIT_PAGE_MAX_LIMIT
  ) {
    throw new AuditCursorError('limite de paginacao fora do contrato')
  }
  return limit
}

/**
 * Cria o store append-only in-memory. Uso exclusivo de teste: mantenha os
 * stores de runtime fora deste PR.
 */
export function createInMemoryAuditStore(
  options: InMemoryAuditStoreOptions = {},
): AuditStore {
  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => randomUUID())
  const byOperation = new Map<string, Array<AuditRecord>>()

  function recordsOf(operationId: string): Array<AuditRecord> {
    const existing = byOperation.get(operationId)
    if (existing) return existing
    const created: Array<AuditRecord> = []
    byOperation.set(operationId, created)
    return created
  }

  return {
    append(input: AuditAppendInput): AuditRecord {
      const records = recordsOf(input.operationId)
      const safePayload = toSafePayload(input.safePayload)
      const candidate = {
        event_id: input.eventId ?? generateId(),
        sequence: records.length + 1,
        occurred_at: input.occurredAt ?? now(),
        type: input.type,
        actor_ref: input.actorRef,
        ...(input.fromState === undefined
          ? {}
          : { from_state: input.fromState }),
        ...(input.toState === undefined ? {} : { to_state: input.toState }),
        ...(input.actionKind === undefined
          ? {}
          : { action_kind: input.actionKind }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        outcome: input.outcome,
        safe_payload: safePayload,
      }

      const parsed = auditEventSchema.safeParse(candidate)
      if (!parsed.success)
        throw new InvalidAuditEventError(parsed.error.issues.length)
      if (!(AUDIT_OUTCOMES as ReadonlyArray<string>).includes(input.outcome)) {
        throw new InvalidAuditEventError(1)
      }
      if (
        typeof input.requestId !== 'string' ||
        input.requestId.length === 0 ||
        typeof input.operationId !== 'string' ||
        input.operationId.length === 0
      ) {
        throw new InvalidAuditEventError(1)
      }

      const event = Object.freeze(parsed.data)
      const record: AuditRecord = Object.freeze({
        event,
        correlation: Object.freeze({
          operationId: input.operationId,
          requestId: input.requestId,
        }),
      })
      records.push(record)
      return record
    },

    list(operationId: string, query: AuditQuery = {}): AuditListPage {
      const limit = assertLimit(query.limit)
      const after =
        query.cursor === undefined || query.cursor === null
          ? 0
          : decodeCursor(query.cursor, operationId)
      const records = recordsOf(operationId)
      const remaining = records.filter(
        (record) => record.event.sequence > after,
      )
      const page = remaining.slice(0, limit)
      const hasMore = remaining.length > page.length
      const lastSequence =
        page.length > 0 ? page[page.length - 1].event.sequence : after
      return {
        request_id: query.requestId ?? generateId(),
        operation_id: operationId,
        events: page.map((record) => record.event),
        next_cursor: hasMore ? encodeCursor(operationId, lastSequence) : null,
      }
    },

    lastSequence(operationId: string): number {
      return recordsOf(operationId).length
    },

    update(): never {
      throw new AppendOnlyViolationError('update')
    },

    delete(): never {
      throw new AppendOnlyViolationError('delete')
    },
  }
}
