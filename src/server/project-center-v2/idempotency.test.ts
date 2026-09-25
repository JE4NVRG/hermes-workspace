/**
 * Testes da unidade de trabalho do Project Center v2 (PR 4).
 *
 * Provam o que o elo 4 promete no nível de serviço: chave de idempotência
 * client-owned com hash persistido, replay byte a byte, conflito por payload
 * diferente, outbox atômico com a operação e resposta recuperável quando o
 * processo cai entre o commit durável e o registro da resposta.
 */
import { describe, expect, it } from 'vitest'
import { observedStateSchema } from './drivers/types'
import {
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
} from './drivers/postgresql-isolated'
import { resolveProjectCenterV2Flags } from './feature-flags'
import { buildNamingSnapshot } from './naming'
import { planProject } from './planner'
import { createInMemoryAuditStore } from './audit-store'
import { createInMemoryOperationStore } from './operation-store'
import {
  AtomicCommitError,
  IDEMPOTENCY_KEY_HASH_PREFIX,
  IdempotencyClaimError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
  createIdempotencyStore,
  createInMemoryOutboxStore,
  hashIdempotencyKey,
  hashRequestPayload,
} from './idempotency'
import type { AuditStore } from './audit-store'
import type { OutboxStore, TransactionPlan } from './idempotency'
import type { CreateOperationInput, OperationStore } from './operation-store'
import type { ProjectIntent } from './domain'
import type { ObservedState } from './drivers/types'

const OBSERVED_AT = '2026-09-25T12:00:00.000Z'
const REVISION = `obsrev_${'a'.repeat(32)}`
const CLOCK = new Date('2026-09-25T12:05:00.000Z')
const OPERATION_ID = '7c3d3e2a-4f5b-4a6c-9d1e-2b3c4d5e6f70'
const KEY = 'idem-key-0123456789abcdef'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
  description: 'site institucional',
  driver: 'postgresql_isolated',
  environment: 'development',
  host_target: 'vps-primary-local',
  capabilities: {
    auth: false,
    storage: false,
    realtime: false,
    postgrest: false,
    backup: true,
  },
}

const NAMING = buildNamingSnapshot({
  client_id: INTENT.client_id,
  project_slug: INTENT.project_slug,
  environment: INTENT.environment,
  driver: INTENT.driver,
})

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
})

function makeObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return observedStateSchema.parse({
    driver: POSTGRESQL_DRIVER_ID,
    driver_version: POSTGRESQL_DRIVER_VERSION,
    observer_version: 'pcv2-pg-observer-v1',
    host_target: INTENT.host_target,
    environment: INTENT.environment,
    project_id: NAMING.project_id,
    observed_at: OBSERVED_AT,
    revision: REVISION,
    server_version: '16.13',
    database: {
      name: NAMING.database,
      exists: false,
      owner_role: null,
      ownership_marker: null,
      size_mb: null,
      is_template: false,
    },
    app_role: {
      name: NAMING.app_role,
      exists: false,
      can_login: false,
      is_superuser: false,
      can_create_db: false,
      can_create_role: false,
      can_replicate: false,
      bypass_rls: false,
      memberships: [],
    },
    privileges: [],
    extensions: [],
    disallowed_extensions: [],
    endpoint_masked: null,
    unsafe_findings: [],
    ownership_verified: false,
    backup_artifacts: [],
    warnings: [],
    ...overrides,
  })
}

const CANONICAL = planProject({
  intent: INTENT,
  observed: makeObserved(),
  flags: FLAGS_ON,
})

function operationInput(
  overrides: Partial<CreateOperationInput> = {},
): CreateOperationInput {
  return {
    intent: INTENT,
    plan: CANONICAL.plan,
    planHash: CANONICAL.plan_hash,
    expiresAt: CANONICAL.expires_at,
    statusUrl: `/api/project-center/v2/operations/${OPERATION_ID}`,
    auditUrl: `/api/project-center/v2/operations/${OPERATION_ID}/audit`,
    observedRevision: CANONICAL.observed_revision,
    driverVersion: CANONICAL.driver_version,
    operationId: OPERATION_ID,
    ...overrides,
  }
}

interface Harness {
  readonly operations: OperationStore
  readonly audit: AuditStore
  readonly outbox: OutboxStore
  readonly store: ReturnType<typeof createIdempotencyStore>
  keyHash: () => string
}

function makeHarness(
  overrides: {
    readonly audit?: AuditStore
    readonly outbox?: OutboxStore
    readonly ttlSeconds?: number
  } = {},
): Harness {
  const operations = createInMemoryOperationStore({
    now: () => CLOCK.toISOString(),
    generateId: () => OPERATION_ID,
  })
  const audit =
    overrides.audit ??
    createInMemoryAuditStore({ now: () => CLOCK.toISOString() })
  const outbox =
    overrides.outbox ??
    createInMemoryOutboxStore({
      now: () => CLOCK.toISOString(),
      generateId: () => '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    })
  const store = createIdempotencyStore({
    operations,
    audit,
    outbox,
    now: () => CLOCK,
    ...(overrides.ttlSeconds === undefined
      ? {}
      : { ttlSeconds: overrides.ttlSeconds }),
  })
  return {
    operations,
    audit,
    outbox,
    store,
    keyHash: () => hashIdempotencyKey(KEY),
  }
}

function begin(harness: Harness, payload: unknown = { intent: INTENT }) {
  return harness.store.begin({
    rawKey: KEY,
    actorRef: 'actor_deadbeefdeadbeef',
    routeId: 'createProjectDryRun',
    requestHash: hashRequestPayload(payload),
  })
}

function dryRunPlan(): TransactionPlan {
  return {
    operations: [
      { kind: 'create', input: operationInput() },
      {
        kind: 'transition',
        operationId: OPERATION_ID,
        next: 'awaiting_approval',
        expectedRevision: 1,
      },
    ],
    outbox: [
      {
        operationId: OPERATION_ID,
        kind: 'execute',
        planHash: CANONICAL.plan_hash,
        projectId: CANONICAL.project_id,
        environment: 'development',
      },
    ],
    audit: [
      {
        operationId: OPERATION_ID,
        requestId: 'req-1',
        type: 'project_center.dry_run',
        actorRef: 'actor_deadbeefdeadbeef',
        outcome: 'accepted',
        fromState: null,
        toState: 'planned',
        attempt: 1,
        safePayload: {},
      },
    ],
  }
}

describe('hash da chave e do payload', () => {
  it('recusa chave ausente, curta ou acima do contrato', () => {
    expect(() => hashIdempotencyKey(undefined)).toThrow(
      InvalidIdempotencyKeyError,
    )
    expect(() => hashIdempotencyKey('')).toThrow(InvalidIdempotencyKeyError)
    expect(() => hashIdempotencyKey('curta')).toThrow(
      InvalidIdempotencyKeyError,
    )
    expect(() => hashIdempotencyKey('a'.repeat(200))).toThrow(
      InvalidIdempotencyKeyError,
    )
  })

  it('é determinística e nunca ecoa a chave bruta', () => {
    const first = hashIdempotencyKey(KEY)
    expect(first).toBe(hashIdempotencyKey(KEY))
    expect(first).not.toBe(hashIdempotencyKey(`${KEY}x`))
    expect(first.startsWith(IDEMPOTENCY_KEY_HASH_PREFIX)).toBe(true)
    expect(first).toMatch(/^idem_[a-f0-9]{64}$/)
    expect(first).not.toContain(KEY)
  })

  it('canoniza o payload do request (ordem de chaves não muda o hash)', () => {
    const a = hashRequestPayload({ intent: INTENT, reason: null })
    const b = hashRequestPayload({ reason: null, intent: INTENT })
    const c = hashRequestPayload({ intent: INTENT, reason: 'outro motivo' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('unidade de trabalho atômica', () => {
  it('aplica operação, outbox e auditoria no mesmo commit', () => {
    const harness = makeHarness()
    const outcome = begin(harness)
    expect(outcome.kind).toBe('new')

    const result = harness.store.commit(outcome.claim, dryRunPlan())
    expect(result.operation?.operation_id).toBe(OPERATION_ID)
    expect(result.operation?.state).toBe('awaiting_approval')
    expect(result.operation?.operation_version).toBe(2)
    expect(result.outbox).toHaveLength(1)
    expect(result.outbox[0]?.state).toBe('pending')
    expect(harness.outbox.listFor(OPERATION_ID)).toHaveLength(1)
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(1)

    const record = harness.store.get(harness.keyHash())
    expect(record?.state).toBe('pending')
    expect(record?.operation_id).toBe(OPERATION_ID)
  })

  it('registra a resposta e devolve replay idêntico sem reaplicar efeito', () => {
    const harness = makeHarness()
    const outcome = begin(harness)
    if (outcome.kind !== 'new') throw new Error('esperava claim novo')
    harness.store.commit(outcome.claim, dryRunPlan())
    harness.store.complete(outcome.claim, OPERATION_ID, {
      status: 201,
      body: { request_id: 'req-1', operation: { operation_id: OPERATION_ID } },
    })

    const replay = begin(harness)
    expect(replay.kind).toBe('replay')
    if (replay.kind !== 'replay') throw new Error('esperava replay')
    expect(replay.response.status).toBe(201)
    expect(replay.response.body).toEqual({
      request_id: 'req-1',
      operation: { operation_id: OPERATION_ID },
    })
    // Nenhum efeito novo: um único outbox e uma única operação.
    expect(harness.outbox.list()).toHaveLength(1)
    expect(harness.operations.get(OPERATION_ID)?.operation_version).toBe(2)
  })

  it('a mesma chave com payload diferente é conflito', () => {
    const harness = makeHarness()
    expect(begin(harness).kind).toBe('new')
    expect(() => begin(harness, { intent: INTENT, reason: 'outro' })).toThrow(
      IdempotencyKeyReusedError,
    )
  })
})

describe('falha no meio da transação', () => {
  it('compensa tudo e libera a chave quando a auditoria falha', () => {
    const base = createInMemoryAuditStore({ now: () => CLOCK.toISOString() })
    const failingAudit: AuditStore = {
      ...base,
      append: () => {
        throw new Error('auditoria indisponivel')
      },
    }
    const harness = makeHarness({ audit: failingAudit })
    const outcome = begin(harness)
    if (outcome.kind !== 'new') throw new Error('esperava claim novo')

    let compensated = 0
    const plan: TransactionPlan = {
      ...dryRunPlan(),
      extra: [
        {
          label: 'extra_probe',
          apply: () => undefined,
          compensate: () => {
            compensated += 1
          },
        },
      ],
    }

    expect(() => harness.store.commit(outcome.claim, plan)).toThrow(
      AtomicCommitError,
    )
    expect(compensated).toBe(1)
    expect(harness.operations.get(OPERATION_ID)).toBeNull()
    expect(harness.outbox.list()).toHaveLength(0)

    // A chave continua utilizável: nada ficou aplicado pela metade.
    const retry = harness.store.begin({
      rawKey: KEY,
      actorRef: 'actor_deadbeefdeadbeef',
      routeId: 'createProjectDryRun',
      requestHash: hashRequestPayload({ intent: INTENT }),
    })
    expect(retry.kind).toBe('new')
  })

  it('recupera a resposta quando o processo cai depois do commit durável', () => {
    const harness = makeHarness()
    const outcome = begin(harness)
    if (outcome.kind !== 'new') throw new Error('esperava claim novo')

    expect(() =>
      harness.store.commit(outcome.claim, dryRunPlan(), {
        afterCommit: () => {
          throw new Error('queda simulada antes de registrar a resposta')
        },
      }),
    ).toThrow('queda simulada')

    // Efeito aplicado uma única vez e registro amarrado à operação.
    expect(harness.operations.get(OPERATION_ID)?.state).toBe(
      'awaiting_approval',
    )
    expect(harness.store.get(harness.keyHash())?.operation_id).toBe(
      OPERATION_ID,
    )

    const recovered = begin(harness)
    expect(recovered.kind).toBe('recover')
    if (recovered.kind !== 'recover') throw new Error('esperava recuperação')
    expect(recovered.operation_id).toBe(OPERATION_ID)

    const completed = harness.store.complete(recovered.claim, OPERATION_ID, {
      status: 201,
      body: { request_id: 'req-recuperado' },
    })
    expect(completed.state).toBe('completed')
    expect(begin(harness).kind).toBe('replay')
  })

  it('transação sem operação associada é recusada', () => {
    const harness = makeHarness()
    const outcome = begin(harness)
    if (outcome.kind !== 'new') throw new Error('esperava claim novo')
    expect(() =>
      harness.store.commit(outcome.claim, {
        audit: dryRunPlan().audit ?? [],
      }),
    ).toThrow(IdempotencyClaimError)
  })
})

describe('outbox', () => {
  it('recusa entrada fora do catálogo ou com hash inválido', () => {
    const outbox = createInMemoryOutboxStore()
    expect(() =>
      outbox.append({
        operationId: OPERATION_ID,
        kind: 'executar' as never,
        planHash: CANONICAL.plan_hash,
        projectId: CANONICAL.project_id,
        environment: 'development',
      }),
    ).toThrow(IdempotencyClaimError)
    expect(() =>
      outbox.append({
        operationId: OPERATION_ID,
        kind: 'execute',
        planHash: 'nao-e-hash',
        projectId: CANONICAL.project_id,
        environment: 'development',
      }),
    ).toThrow(IdempotencyClaimError)
  })
})

describe('expiração da chave', () => {
  it('poda registros vencidos e permite reexecução', () => {
    const harness = makeHarness({ ttlSeconds: 60 })
    const outcome = begin(harness)
    if (outcome.kind !== 'new') throw new Error('esperava claim novo')
    harness.store.commit(outcome.claim, dryRunPlan())
    harness.store.complete(outcome.claim, OPERATION_ID, {
      status: 201,
      body: { request_id: 'req-1' },
    })

    const later = new Date(CLOCK.getTime() + 61_000)
    expect(harness.store.prune(later.getTime())).toBe(1)
    expect(harness.store.get(harness.keyHash())).toBeNull()
  })
})
