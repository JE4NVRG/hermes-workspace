/**
 * Testes do lease store (PR 6).
 *
 * Prova o exigido pela spec §9 e pelo critério do card: lease exclusivo com
 * expiração, fencing token crescente, recusa de writer stale, `409
 * OPERATION_LOCKED` sem revelar outro ator e nenhuma escrita sem lease vivo.
 */
import { describe, expect, it } from 'vitest'
import {
  LEASE_FIRST_FENCING_TOKEN,
  LEASE_RENEW_INTERVAL_SECONDS,
  LEASE_TTL_SECONDS,
  LeaseHeldError,
  LeaseInputError,
  LeaseLostError,
  StaleWriterError,
  createInMemoryLeaseStore,
  createLeaseGuard,
  leaseScopeKey,
} from './lease-store'
import type { LeaseStore } from './lease-store'
import type { Environment } from './domain'

const PROJECT_A = 'acme-site'
const PROJECT_B = 'acme-blog'
const OPERATION_A = '11111111-1111-4111-8111-111111111111'
const OPERATION_B = '22222222-2222-4222-8222-222222222222'
const HOLDER_A = 'worker-a'
const HOLDER_B = 'worker-b'

const SCOPE_A = {
  projectId: PROJECT_A,
  environment: 'development' as Environment,
}
const SCOPE_B = {
  projectId: PROJECT_B,
  environment: 'development' as Environment,
}

interface Harness {
  readonly store: LeaseStore
  readonly advance: (seconds: number) => void
  readonly nowMs: () => number
}

function createHarness(start = 0): Harness {
  let clock = Date.parse('2026-09-25T12:00:00.000Z') + start
  let counter = 0
  const store = createInMemoryLeaseStore({
    now: () => new Date(clock),
    generateId: () => {
      counter += 1
      return `33333333-3333-4333-8333-${String(counter).padStart(12, '0')}`
    },
  })
  return {
    store,
    advance: (seconds) => {
      clock += seconds * 1000
    },
    nowMs: () => clock,
  }
}

function acquire(
  harness: Harness,
  overrides: Partial<Parameters<LeaseStore['acquire']>[0]> = {},
) {
  return harness.store.acquire({
    operationId: OPERATION_A,
    projectId: PROJECT_A,
    environment: 'development',
    holderRef: HOLDER_A,
    ...overrides,
  })
}

describe('lease store — aquisição exclusiva', () => {
  it('emite lease com fencing token inicial, escopo e TTL canônicos', () => {
    const harness = createHarness()
    const grant = acquire(harness)

    expect(grant.fencing_token).toBe(LEASE_FIRST_FENCING_TOKEN)
    expect(grant.scope_key).toBe(leaseScopeKey(SCOPE_A))
    expect(grant.ttl_seconds).toBe(LEASE_TTL_SECONDS)
    expect(grant.renew_count).toBe(0)
    expect(grant.holder_ref).toBe(HOLDER_A)
    expect(Date.parse(grant.expires_at) - Date.parse(grant.acquired_at)).toBe(
      LEASE_TTL_SECONDS * 1000,
    )
    expect(Object.isFrozen(grant)).toBe(true)
  })

  it('recusa segundo worker no mesmo escopo com 409 e retry_after, sem novo token', () => {
    const harness = createHarness()
    const first = acquire(harness)

    let error: unknown = null
    try {
      acquire(harness, {
        operationId: OPERATION_B,
        holderRef: HOLDER_B,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(LeaseHeldError)
    const held = error as LeaseHeldError
    expect(held.code).toBe('OPERATION_LOCKED')
    expect(held.status).toBe(409)
    expect(held.retry_after_seconds).toBeGreaterThanOrEqual(1)
    // A mensagem não revela holder nem operação do concorrente.
    expect(held.message).not.toContain(HOLDER_A)
    expect(held.message).not.toContain(OPERATION_A)
    expect(harness.store.list()).toHaveLength(1)
    expect(harness.store.highestFencingToken(SCOPE_A)).toBe(first.fencing_token)
  })

  it('reaquisição idempotente do mesmo holder/operação devolve o mesmo lease', () => {
    const harness = createHarness()
    const first = acquire(harness)
    harness.advance(LEASE_RENEW_INTERVAL_SECONDS)
    const again = acquire(harness)

    expect(again.lease_id).toBe(first.lease_id)
    expect(again.fencing_token).toBe(first.fencing_token)
    expect(harness.store.highestFencingToken(SCOPE_A)).toBe(
      LEASE_FIRST_FENCING_TOKEN,
    )
  })

  it('escopos distintos (projeto ou ambiente) não se bloqueiam', () => {
    const harness = createHarness()
    const a = acquire(harness)
    const b = harness.store.acquire({
      operationId: OPERATION_B,
      projectId: PROJECT_B,
      environment: 'staging',
      holderRef: HOLDER_B,
    })

    expect(b.fencing_token).toBe(LEASE_FIRST_FENCING_TOKEN)
    expect(b.scope_key).not.toBe(a.scope_key)
    expect(harness.store.current(SCOPE_A)?.holder_ref).toBe(HOLDER_A)
    expect(harness.store.list()).toHaveLength(2)
  })

  it('após expiração outro holder adquire com fencing token maior', () => {
    const harness = createHarness()
    const first = acquire(harness)
    harness.advance(LEASE_TTL_SECONDS + 1)

    expect(harness.store.current(SCOPE_A)).toBeNull()
    const second = acquire(harness, {
      operationId: OPERATION_B,
      holderRef: HOLDER_B,
    })

    expect(second.fencing_token).toBe(first.fencing_token + 1)
    expect(second.lease_id).not.toBe(first.lease_id)
  })
})

describe('lease store — renovação, liberação e fencing', () => {
  it('renova estendendo a expiração e contando a renovação', () => {
    const harness = createHarness()
    const grant = acquire(harness)
    harness.advance(LEASE_RENEW_INTERVAL_SECONDS)
    const renewed = harness.store.renew({
      leaseId: grant.lease_id,
      fencingToken: grant.fencing_token,
      holderRef: HOLDER_A,
    })

    expect(renewed.fencing_token).toBe(grant.fencing_token)
    expect(renewed.renew_count).toBe(1)
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(
      Date.parse(grant.expires_at),
    )
    expect(harness.store.current(SCOPE_A)?.expires_at).toBe(renewed.expires_at)
  })

  it('renovar lease expirado é recusado', () => {
    const harness = createHarness()
    const grant = acquire(harness)
    harness.advance(LEASE_TTL_SECONDS + 1)

    expect(() =>
      harness.store.renew({
        leaseId: grant.lease_id,
        fencingToken: grant.fencing_token,
        holderRef: HOLDER_A,
      }),
    ).toThrow(LeaseLostError)
  })

  it('renovar com fencing token errado recusa como writer stale', () => {
    const harness = createHarness()
    const grant = acquire(harness)

    expect(() =>
      harness.store.renew({
        leaseId: grant.lease_id,
        fencingToken: grant.fencing_token + 1,
        holderRef: HOLDER_A,
      }),
    ).toThrow(StaleWriterError)
  })

  it('release exige o token vigente e mantém o token já emitido', () => {
    const harness = createHarness()
    const grant = acquire(harness)

    expect(() =>
      harness.store.release({
        leaseId: grant.lease_id,
        fencingToken: grant.fencing_token + 5,
        holderRef: HOLDER_A,
      }),
    ).toThrow(StaleWriterError)

    harness.store.release({
      leaseId: grant.lease_id,
      fencingToken: grant.fencing_token,
      holderRef: HOLDER_A,
    })
    expect(harness.store.current(SCOPE_A)).toBeNull()
    // Token não retrocede: novo acquire continua a sequência.
    const second = acquire(harness, {
      operationId: OPERATION_B,
      holderRef: HOLDER_B,
    })
    expect(second.fencing_token).toBe(grant.fencing_token + 1)
  })

  it('assertWriter aceita somente o lease vigente e recusa writer stale', () => {
    const harness = createHarness()
    const first = acquire(harness)
    expect(
      harness.store.assertWriter({
        scope: SCOPE_A,
        leaseId: first.lease_id,
        fencingToken: first.fencing_token,
        holderRef: HOLDER_A,
      }).lease_id,
    ).toBe(first.lease_id)

    harness.advance(LEASE_TTL_SECONDS + 1)
    const second = acquire(harness, {
      operationId: OPERATION_B,
      holderRef: HOLDER_B,
    })

    let stale: unknown = null
    try {
      harness.store.assertWriter({
        scope: SCOPE_A,
        leaseId: first.lease_id,
        fencingToken: first.fencing_token,
        holderRef: HOLDER_A,
      })
    } catch (caught) {
      stale = caught
    }
    expect(stale).toBeInstanceOf(StaleWriterError)
    expect((stale as StaleWriterError).presented).toBe(first.fencing_token)
    expect((stale as StaleWriterError).current).toBe(second.fencing_token)

    expect(
      harness.store.assertWriter({
        scope: SCOPE_A,
        leaseId: second.lease_id,
        fencingToken: second.fencing_token,
        holderRef: HOLDER_B,
      }).lease_id,
    ).toBe(second.lease_id)
  })

  it('assertWriter distingue lease/holder errado de lease ausente', () => {
    const harness = createHarness()
    const grant = acquire(harness)

    expect(() =>
      harness.store.assertWriter({
        scope: SCOPE_A,
        leaseId: '44444444-4444-4444-8444-444444444444',
        fencingToken: grant.fencing_token,
        holderRef: HOLDER_A,
      }),
    ).toThrow(LeaseLostError)

    expect(() =>
      harness.store.assertWriter({
        scope: SCOPE_A,
        leaseId: grant.lease_id,
        fencingToken: grant.fencing_token,
        holderRef: HOLDER_B,
      }),
    ).toThrow(LeaseLostError)

    expect(() =>
      harness.store.assertWriter({
        scope: SCOPE_B,
        leaseId: grant.lease_id,
        fencingToken: grant.fencing_token,
        holderRef: HOLDER_A,
      }),
    ).toThrow(LeaseLostError)
  })

  it('expira leases vencidos e preserva os vivos', () => {
    const harness = createHarness()
    acquire(harness)
    harness.store.acquire({
      operationId: OPERATION_B,
      projectId: PROJECT_B,
      environment: 'staging',
      holderRef: HOLDER_B,
      ttlSeconds: 240,
    })
    harness.advance(LEASE_TTL_SECONDS + 1)

    expect(harness.store.expire()).toBe(1)
    expect(harness.store.list()).toHaveLength(1)
    expect(harness.store.expire()).toBe(0)
  })

  it('holder() responde pela operação viva e cai para null após expirar', () => {
    const harness = createHarness()
    const grant = acquire(harness)
    const guard = createLeaseGuard(harness.store)

    expect(guard.holder(OPERATION_A)).toEqual({ holder_ref: HOLDER_A })
    expect(guard.holder(OPERATION_B)).toBeNull()
    harness.advance(LEASE_TTL_SECONDS + 1)
    expect(guard.holder(OPERATION_A)).toBeNull()
    expect(grant.lease_id.length).toBeGreaterThan(0)
  })
})

describe('lease store — entradas fechadas', () => {
  it('recusa ambiente fora do contrato e project_id malformado', () => {
    const harness = createHarness()
    expect(() =>
      acquire(harness, { environment: 'local' as Environment }),
    ).toThrow(LeaseInputError)
    expect(() =>
      leaseScopeKey({ projectId: 'ACME', environment: 'development' }),
    ).toThrow(LeaseInputError)
    expect(() =>
      leaseScopeKey({ projectId: '../etc', environment: 'development' }),
    ).toThrow(LeaseInputError)
  })

  it('recusa holder_ref com path/espaço e TTL fora da faixa', () => {
    const harness = createHarness()
    expect(() => acquire(harness, { holderRef: 'worker a' })).toThrow(
      LeaseInputError,
    )
    expect(() => acquire(harness, { holderRef: 'worker/a' })).toThrow(
      LeaseInputError,
    )
    expect(() => acquire(harness, { holderRef: '' })).toThrow(LeaseInputError)
    expect(() => acquire(harness, { ttlSeconds: 1 })).toThrow(LeaseInputError)
    expect(() => acquire(harness, { ttlSeconds: 3600 })).toThrow(
      LeaseInputError,
    )
    expect(() => acquire(harness, { operationId: 'short' })).toThrow(
      LeaseInputError,
    )
  })
})
