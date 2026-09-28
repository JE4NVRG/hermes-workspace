/**
 * Testes de auditoria append-only: sequência monotônica, correlação,
 * paginação, redaction e negação de update/delete.
 */
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, auditEventSchema, auditPageSchema } from './domain'
import {
  AUDIT_PAGE_DEFAULT_LIMIT,
  AUDIT_PAGE_MAX_LIMIT,
  AppendOnlyViolationError,
  AuditCursorError,
  InvalidAuditEventError,
  createInMemoryAuditStore,
} from './audit-store'
import type { AuditStore } from './audit-store'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const EVENT_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = 'req-123456'
const OCCURRED_AT = '2026-09-25T00:00:00.000Z'

// Fixtures sensíveis montadas em runtime (nada com formato real no commit).
const CREDENTIAL_VALUE = ['credencial', 'sintetica'].join('-')
const DSN_VALUE = `postgres://app:${CREDENTIAL_VALUE}@db.interno:5432/app`
const SECRET_REF_VALUE = `sref_${'D'.repeat(43)}`
const ABSOLUTE_PATH_VALUE = ['', 'srv', 'pcv2', 'logs'].join('/')
const CREDENTIAL_KEY = ['pass', 'word'].join('')

function newStore(): AuditStore {
  return createInMemoryAuditStore({
    now: () => OCCURRED_AT,
    generateId: () => EVENT_ID,
  })
}

function append(
  store: AuditStore,
  overrides: Partial<Parameters<AuditStore['append']>[0]> = {},
) {
  return store.append({
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    type: 'operation.transitioned',
    actorRef: 'humano-1',
    outcome: 'accepted',
    fromState: 'planned',
    toState: 'awaiting_approval',
    safePayload: { revision: 1 },
    ...overrides,
  })
}

describe('sequencia e correlacao', () => {
  it('atribui sequencia monotônica por operacao', () => {
    const store = newStore()
    expect(append(store).event.sequence).toBe(1)
    expect(append(store).event.sequence).toBe(2)
    expect(append(store, { type: 'operation.executed' }).event.sequence).toBe(3)
    expect(store.lastSequence(OPERATION_ID)).toBe(3)

    expect(
      append(store, { operationId: OTHER_OPERATION_ID }).event.sequence,
    ).toBe(1)
    expect(store.lastSequence(OTHER_OPERATION_ID)).toBe(1)
    expect(store.lastSequence(OPERATION_ID)).toBe(3)
  })

  it('nunca reutiliza sequencia depois de falha de validacao', () => {
    const store = newStore()
    append(store)
    expect(() =>
      append(store, { outcome: 'inexistente' as 'accepted' }),
    ).toThrow(InvalidAuditEventError)
    expect(() => append(store, { attempt: 0 })).toThrow(InvalidAuditEventError)
    expect(append(store).event.sequence).toBe(2)
  })

  it('correlaciona operacao, request id e ator', () => {
    const store = newStore()
    const record = append(store, {
      actorRef: 'agente-9',
      actionKind: 'create_database',
      attempt: 2,
    })
    expect(record.correlation).toEqual({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
    })
    expect(record.event.actor_ref).toBe('agente-9')
    expect(record.event.action_kind).toBe('create_database')
    expect(record.event.attempt).toBe(2)
    expect(record.event.from_state).toBe('planned')
    expect(record.event.to_state).toBe('awaiting_approval')
    expect(record.event.occurred_at).toBe(OCCURRED_AT)
  })

  it('devolve evento valido segundo o contrato', () => {
    const store = newStore()
    const page = store.list(OPERATION_ID, { requestId: REQUEST_ID })
    expect(auditEventSchema.safeParse(append(store).event).success).toBe(true)
    expect(page.request_id).toBe(REQUEST_ID)
    expect(page.operation_id).toBe(OPERATION_ID)
    expect(page.events).toEqual([])
  })
})

describe('paginacao', () => {
  it('pagina por cursor opaco ate o fim', () => {
    const store = newStore()
    for (let index = 0; index < 5; index += 1) append(store)

    const first = store.list(OPERATION_ID, { limit: 2, requestId: REQUEST_ID })
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(first.next_cursor).not.toBeNull()

    const second = store.list(OPERATION_ID, {
      limit: 2,
      cursor: first.next_cursor,
      requestId: REQUEST_ID,
    })
    expect(second.events.map((event) => event.sequence)).toEqual([3, 4])
    expect(second.next_cursor).not.toBeNull()

    const third = store.list(OPERATION_ID, {
      limit: 2,
      cursor: second.next_cursor,
    })
    expect(third.events.map((event) => event.sequence)).toEqual([5])
    expect(third.next_cursor).toBeNull()
  })

  it('usa limite default de 100 e aceita ate o teto do contrato', () => {
    const store = newStore()
    expect(AUDIT_PAGE_DEFAULT_LIMIT).toBe(100)
    expect(AUDIT_PAGE_MAX_LIMIT).toBe(500)
    append(store)
    const page = store.list(OPERATION_ID)
    expect(page.events).toHaveLength(1)
    expect(() =>
      store.list(OPERATION_ID, { limit: AUDIT_PAGE_MAX_LIMIT }),
    ).not.toThrow()
  })

  it('recusa limite e cursor malformados', () => {
    const store = newStore()
    append(store)
    for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
      expect(() => store.list(OPERATION_ID, { limit })).toThrow(
        AuditCursorError,
      )
    }
    for (const cursor of ['nao-e-cursor', 'AAAA', `${'x'.repeat(300)}`]) {
      expect(() => store.list(OPERATION_ID, { cursor })).toThrow(
        AuditCursorError,
      )
    }
  })

  it('recusa cursor de outra operacao', () => {
    const store = newStore()
    for (let index = 0; index < 3; index += 1) append(store)
    const page = store.list(OPERATION_ID, { limit: 1 })
    expect(() =>
      store.list(OTHER_OPERATION_ID, { cursor: page.next_cursor }),
    ).toThrow(AuditCursorError)
  })

  it('devolve pagina valida segundo o contrato', () => {
    const store = newStore()
    for (let index = 0; index < 3; index += 1) append(store)
    const page = store.list(OPERATION_ID, { limit: 2 })
    expect(page.events).toHaveLength(2)
    expect(page.next_cursor).not.toBeNull()
    expect(auditPageSchema.safeParse(page).success).toBe(true)
  })
})

describe('append-only', () => {
  it('nega update e delete', () => {
    const store = newStore()
    append(store)
    expect(() => store.update()).toThrow(AppendOnlyViolationError)
    expect(() => store.delete()).toThrow(AppendOnlyViolationError)
    try {
      store.delete()
    } catch (error) {
      expect((error as AppendOnlyViolationError).code).toBe('FORBIDDEN')
      expect((error as AppendOnlyViolationError).operation).toBe('delete')
    }
    expect(store.lastSequence(OPERATION_ID)).toBe(1)
    expect(store.list(OPERATION_ID).events).toHaveLength(1)
  })

  it('congela eventos e nao permite mutacao posterior', () => {
    const store = newStore()
    const record = append(store)
    expect(Object.isFrozen(record.event)).toBe(true)
    expect(() => {
      record.event.sequence = 99
    }).toThrow()
    expect(store.list(OPERATION_ID).events[0].sequence).toBe(1)
  })

  it('emite apenas codigos do catalogo fechado', () => {
    for (const code of [
      new AppendOnlyViolationError('update').code,
      new AuditCursorError('x').code,
      new InvalidAuditEventError(1).code,
    ]) {
      expect(ERROR_CODES as ReadonlyArray<string>).toContain(code)
    }
  })
})

describe('redaction do payload de auditoria', () => {
  it('persiste payload sanitizado', () => {
    const store = newStore()
    const record = append(store, {
      safePayload: {
        [CREDENTIAL_KEY]: 'x',
        dsn: DSN_VALUE,
        secret_ref: SECRET_REF_VALUE,
        workdir: ABSOLUTE_PATH_VALUE,
        state: 'planned',
      },
    })
    const serialized = JSON.stringify(record.event)
    expect(serialized).not.toContain(DSN_VALUE)
    expect(serialized).not.toContain(CREDENTIAL_VALUE)
    expect(serialized).not.toContain(SECRET_REF_VALUE)
    expect(serialized).not.toContain(ABSOLUTE_PATH_VALUE)
    expect(record.event.safe_payload.state).toBe('planned')
    expect(auditEventSchema.safeParse(record.event).success).toBe(true)
  })

  it('trunca payload acima do limite do contrato', () => {
    const store = newStore()
    const oversized = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`campo_${index}`, index]),
    )
    const record = append(store, { safePayload: oversized })
    expect(Object.keys(record.event.safe_payload)).toHaveLength(30)
    expect(record.event.safe_payload.truncated_properties).toBe(16)
    expect(auditEventSchema.safeParse(record.event).success).toBe(true)
  })

  it('recusa evento fora do contrato sem vazar entrada', () => {
    const store = newStore()
    const attempts: Array<Partial<Parameters<AuditStore['append']>[0]>> = [
      { outcome: 'desconhecido' as 'accepted' },
      { attempt: 0 },
      { type: 'x'.repeat(101) },
      { actorRef: 'y'.repeat(129) },
      { requestId: '' },
      { operationId: '' },
      { fromState: 'inventado' as 'planned' },
    ]
    for (const overrides of attempts) {
      try {
        append(store, overrides)
        throw new Error('deveria ter falhado')
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidAuditEventError)
        expect((error as Error).message).not.toContain('desconhecido')
      }
    }
    expect(store.lastSequence(OPERATION_ID)).toBe(0)
  })
})
