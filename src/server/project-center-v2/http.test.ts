/**
 * Testes da superfície HTTP v2 do Project Center (PR 4).
 *
 * Cobrem o pipeline fechado (flag, rota, content-type, autenticação, política,
 * limite, cabeçalhos e corpo), a idempotência client-owned na borda, as
 * decisões de aprovação com segregação de ator, o enfileiramento de
 * execução/verificação sem worker e o rollback em três fases — sempre com
 * dublês injetados, sem banco, sem Docker e sem I/O privilegiado.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { observedStateSchema } from './drivers/types'
import {
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
} from './drivers/postgresql-isolated'
import { resolveProjectCenterV2Flags } from './feature-flags'
import { ROLE_DEFINITIONS } from './policy'
import {
  IDEMPOTENCY_HEADER,
  IF_MATCH_HEADER,
  InMemoryRateLimitPort,
  OPEN_LEASE_GUARD,
  PROJECT_CENTER_V2_OPERATIONS_PATH,
  PROJECT_CENTER_V2_ROUTES,
  createDenyAllVerifier,
  handleProjectCenterV2Request,
} from './http'
import {
  createIdempotencyStore,
  createInMemoryOutboxStore,
  hashIdempotencyKey,
} from './idempotency'
import { createInMemoryAuditStore } from './audit-store'
import { createInMemoryOperationStore } from './operation-store'
import {
  RollbackObservationUnavailableError,
  actorRefFor,
  createInMemoryOperationApprovalStore,
  createInMemoryOperationOwnershipStore,
  createInMemoryRollbackPlanStore,
  expectedApprovalConfirmation,
  expectedRollbackConfirmation,
} from './approval-service'
import { planProject } from './planner'
import { buildNamingSnapshot } from './naming'
import type {
  DryRunObservationPort,
  ProjectCenterV2Deps,
  ProjectCenterV2TokenClaims,
  ProjectCenterV2TokenVerifier,
  RateLimitPort,
} from './http'
import type { AuditStore } from './audit-store'
import type { OperationStore } from './operation-store'
import type { OperationState } from './state-machine'
import type { OutboxStore } from './idempotency'
import type {
  OperationApprovalStore,
  OperationOwnershipStore,
  RollbackObservation,
  RollbackPlanStore,
  RollbackPlanningPort,
} from './approval-service'
import type { ProjectIntent } from './domain'
import type { ObservedState } from './drivers/types'

const CLOCK = '2026-09-25T12:05:00.000Z'
const OBSERVED_AT = '2026-09-25T12:00:00.000Z'
const OPERATION_ID = '7c3d3e2a-4f5b-4a6c-9d1e-2b3c4d5e6f70'
const OUTBOX_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
/** Contador de identificadores do outbox (o in-memory usa Map por id). */
let outboxSeq = 0
const KEY = 'idem-0123456789abcdef'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
  description: 'site institucional',
  driver: POSTGRESQL_DRIVER_ID,
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
const FLAGS_FULL = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

const OBSERVED: ObservedState = observedStateSchema.parse({
  driver: POSTGRESQL_DRIVER_ID,
  driver_version: POSTGRESQL_DRIVER_VERSION,
  observer_version: 'pcv2-pg-observer-v1',
  host_target: INTENT.host_target,
  environment: INTENT.environment,
  project_id: NAMING.project_id,
  observed_at: OBSERVED_AT,
  revision: `obsrev_${'a'.repeat(32)}`,
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
})

const CANONICAL = planProject({
  intent: INTENT,
  observed: OBSERVED,
  flags: FLAGS_ON,
})

const OPERATOR = 'user:operador@example.com'
const APPROVER = 'user:aprovador@example.com'
const AGENT = 'agent:automacao@example.com'

const TOKEN_OPERATOR = 'tok-operator-000000000000'
const TOKEN_READER = 'tok-reader-00000000000000'
const TOKEN_AUDITOR = 'tok-auditor-0000000000000'
const TOKEN_APPROVER = 'tok-approver-000000000000'
const TOKEN_AGENT = 'tok-agent-0000000000000'
const TOKEN_INVALID = 'tok-inexistente-000000000'

function claims(
  role: keyof typeof ROLE_DEFINITIONS,
  subject: string,
  overrides: Partial<ProjectCenterV2TokenClaims> = {},
): ProjectCenterV2TokenClaims {
  return {
    subject,
    actorType: 'human',
    role,
    scopes: [...ROLE_DEFINITIONS[role].scopes],
    environment: 'development',
    tokenId: `token-${role}`,
    ...overrides,
  }
}

const VERIFIER: ProjectCenterV2TokenVerifier = {
  verify: (raw) => {
    if (raw === TOKEN_OPERATOR) return claims('project_operator', OPERATOR)
    if (raw === TOKEN_READER)
      return claims('project_reader', 'user:leitor@example.com')
    if (raw === TOKEN_AUDITOR)
      return claims('project_auditor', 'user:auditor@example.com')
    if (raw === TOKEN_APPROVER) return claims('project_approver', APPROVER)
    if (raw === TOKEN_AGENT) {
      return claims('project_approver', AGENT, {
        actorType: 'agent',
        tokenId: 'token-agent',
      })
    }
    return null
  },
}

type Json = Record<string, unknown>

function asJson(value: unknown): Json {
  return value as Json
}

function operationOf(body: Json): Json {
  return asJson(body.operation)
}

function errorOf(body: Json): Json {
  return asJson(body.error)
}

function stateOf(body: Json): string {
  return String(operationOf(body).state)
}

interface Harness {
  readonly deps: ProjectCenterV2Deps
  readonly operations: OperationStore
  readonly audit: AuditStore
  readonly outbox: OutboxStore
  readonly approvals: OperationApprovalStore
  readonly rollbackPlans: RollbackPlanStore
  readonly ownership: OperationOwnershipStore
  readonly observationCalls: Array<{ readonly intent: ProjectIntent }>
  setNow: (iso: string) => void
  setObserved: (next: ObservedState | null) => void
  setRollback: (next: RollbackObservation | 'closed' | null) => void
  setLease: (holder: string | null) => void
  setRateLimiter: (port: RateLimitPort) => void
  setFlags: (flags: ProjectCenterV2Deps['flags']) => void
  setAfterCommit: (hook: (() => void) | null) => void
  send: (input: {
    readonly method: 'GET' | 'POST'
    readonly path: string
    readonly token?: string | null
    readonly body?: unknown
    readonly key?: string | null
    readonly ifMatch?: string | null
    readonly contentType?: string | null
    readonly query?: string
    readonly headers?: Readonly<Record<string, string>>
  }) => Promise<Response>
}

function makeHarness(): Harness {
  let nowMs = Date.parse(CLOCK)
  const iso = () => new Date(nowMs).toISOString()
  const operations = createInMemoryOperationStore({
    now: iso,
    generateId: () => OPERATION_ID,
  })
  const audit = createInMemoryAuditStore({ now: iso })
  const outbox = createInMemoryOutboxStore({
    now: iso,
    generateId: () => {
      outboxSeq += 1
      return outboxSeq === 1
        ? OUTBOX_ID
        : `${OUTBOX_ID.slice(0, -1)}${outboxSeq}`
    },
  })
  const approvals = createInMemoryOperationApprovalStore()
  const rollbackPlans = createInMemoryRollbackPlanStore()
  const ownership = createInMemoryOperationOwnershipStore()
  const observationCalls: Array<{ readonly intent: ProjectIntent }> = []
  let observed: ObservedState | null = OBSERVED
  let rollback: RollbackObservation | 'closed' | null = {
    actions: CANONICAL.plan.actions,
    observed_revision: CANONICAL.observed_revision,
    ownership_verified: true,
    drift_findings: [],
  }
  let leaseHolder: string | null = null
  let limiter: RateLimitPort = { allow: () => true }
  let flags = FLAGS_ON
  let afterCommit: (() => void) | null = null

  const observations: DryRunObservationPort = {
    observe: (input) => {
      observationCalls.push(input)
      if (observed === null) {
        return Promise.reject(new Error('observer indisponivel'))
      }
      return Promise.resolve(observed)
    },
  }
  const rollbackObservations: RollbackPlanningPort = {
    observe: () => {
      if (rollback === 'closed' || rollback === null) {
        return Promise.reject(new RollbackObservationUnavailableError())
      }
      return Promise.resolve(rollback)
    },
  }

  const idempotency = createIdempotencyStore({
    operations,
    audit,
    outbox,
    now: () => new Date(nowMs),
  })

  const deps: ProjectCenterV2Deps = {
    flags,
    verifier: VERIFIER,
    operations,
    audit,
    idempotency,
    outbox,
    approvals,
    rollbackPlans,
    ownership,
    observations,
    rollbackObservations,
    lease: {
      holder: () => (leaseHolder === null ? null : { holder_ref: leaseHolder }),
    },
    rateLimiter: {
      allow: (key) => limiter.allow(key),
    },
    now: () => new Date(nowMs),
    generateId: () => OPERATION_ID,
    commitHooks: {
      afterCommit: () => {
        afterCommit?.()
      },
    },
  }

  return {
    deps,
    operations,
    audit,
    outbox,
    approvals,
    rollbackPlans,
    ownership,
    observationCalls,
    setNow(next) {
      nowMs = Date.parse(next)
    },
    setObserved(next) {
      observed = next
    },
    setRollback(next) {
      rollback = next
    },
    setLease(holder) {
      leaseHolder = holder
    },
    setRateLimiter(port) {
      limiter = port
    },
    setFlags(next) {
      flags = next
      ;(deps as { flags: ProjectCenterV2Deps['flags'] }).flags = next
    },
    setAfterCommit(hook) {
      afterCommit = hook
    },
    async send(input) {
      const url = `http://localhost${input.path}${
        input.query === undefined ? '' : `?${input.query}`
      }`
      const headers: Record<string, string> = { ...(input.headers ?? {}) }
      if (input.token !== null && input.token !== undefined) {
        headers.authorization = `Bearer ${input.token}`
      }
      if (input.method === 'POST') {
        headers['content-type'] =
          input.contentType === undefined
            ? 'application/json'
            : (input.contentType ?? '')
      }
      if (input.key !== null && input.key !== undefined) {
        headers[IDEMPOTENCY_HEADER] = input.key
      }
      if (input.ifMatch !== null && input.ifMatch !== undefined) {
        headers[IF_MATCH_HEADER] = input.ifMatch
      }
      return handleProjectCenterV2Request(
        new Request(url, {
          method: input.method,
          headers,
          ...(input.method === 'POST'
            ? { body: JSON.stringify(input.body ?? {}) }
            : {}),
        }),
        deps,
      )
    },
  }
}

async function parse(response: Response): Promise<Json> {
  return asJson(await response.json())
}

function dryRunBody(overrides: Partial<ProjectIntent> = {}): Json {
  return { intent: { ...INTENT, ...overrides }, reason: 'planejamento inicial' }
}

const DRY_RUN_PATH = `${PROJECT_CENTER_V2_OPERATIONS_PATH}/dry-run`
const OPERATION_PATH = `${PROJECT_CENTER_V2_OPERATIONS_PATH}/${OPERATION_ID}`

async function createOperation(
  harness: Harness,
  options: { readonly key?: string; readonly body?: Json } = {},
): Promise<Json> {
  const response = await harness.send({
    method: 'POST',
    path: DRY_RUN_PATH,
    token: TOKEN_OPERATOR,
    key: options.key ?? KEY,
    body: options.body ?? dryRunBody(),
  })
  expect(response.status).toBe(201)
  return parse(response)
}

function advance(
  harness: Harness,
  states: ReadonlyArray<OperationState>,
): void {
  let revision = harness.operations.get(OPERATION_ID)?.operation_version ?? 1
  for (const state of states) {
    harness.operations.transition(OPERATION_ID, state, revision)
    revision += 1
  }
}

const SUCCEEDED_PATH: ReadonlyArray<OperationState> = [
  'approved',
  'queued',
  'executing',
  'verifying',
  'succeeded',
]

describe('gates do pipeline', () => {
  let harness: Harness
  beforeEach(() => {
    harness = makeHarness()
  })

  it('fecha a superfície inteira quando a flag está desligada', async () => {
    harness.setFlags(FLAGS_OFF)
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody(),
    })
    expect(response.status).toBe(403)
    const body = await parse(response)
    expect(errorOf(body).code).toBe('FORBIDDEN')
    expect(errorOf(body).message).toBe('feature_disabled')
    expect(harness.observationCalls).toHaveLength(0)
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(0)
  })

  it('responde 404 para rota desconhecida ou método errado', async () => {
    const unknown = await harness.send({
      method: 'POST',
      path: '/api/project-center/v2/desconhecido',
      token: TOKEN_OPERATOR,
      key: KEY,
      body: {},
    })
    expect(unknown.status).toBe(404)

    const wrongMethod = await harness.send({
      method: 'GET',
      path: DRY_RUN_PATH,
      token: TOKEN_READER,
    })
    // Sobreposição contratual documentada: `/operations/dry-run` (GET) casa com
    // `/operations/{operation_id}` e falha na validação de uuid — nunca executa
    // o handler de dry-run.
    expect(wrongMethod.status).toBe(400)
    expect(errorOf(await parse(wrongMethod)).code).toBe('INVALID_REQUEST')
  })

  it('exige token válido em todas as nove operações', async () => {
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const path = route.path.replace('{operation_id}', OPERATION_ID)
      const response = await harness.send({
        method: route.method,
        path,
        token: null,
        key: KEY,
        ifMatch: '"2"',
        body: dryRunBody(),
      })
      expect(response.status, route.operationId).toBe(401)
    }

    const invalid = await harness.send({
      method: 'GET',
      path: OPERATION_PATH,
      token: TOKEN_INVALID,
    })
    expect(invalid.status).toBe(401)
    expect(errorOf(await parse(invalid)).code).toBe('UNAUTHORIZED')
  })

  it('recusa content-type que não seja JSON em mutação', async () => {
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      contentType: 'text/plain',
      body: dryRunBody(),
    })
    expect(response.status).toBe(400)
    expect(errorOf(await parse(response)).code).toBe('INVALID_REQUEST')
  })

  it('recusa corpo inválido com detalhe fechado', async () => {
    const missing = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: {},
    })
    expect(missing.status).toBe(400)
    const details = asJson(errorOf(await parse(missing)).details)
    expect(Array.isArray(details)).toBe(true)

    const extra = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: { ...dryRunBody(), command: 'rm -rf /' },
    })
    expect(extra.status).toBe(400)
  })

  it('nega por scope ausente e por role fora da tabela do contrato', async () => {
    const verifier: ProjectCenterV2TokenVerifier = {
      verify: () => ({
        ...claims('project_reader', OPERATOR),
        scopes: [],
      }),
    }
    const deps: ProjectCenterV2Deps = { ...harness.deps, verifier }
    const response = await handleProjectCenterV2Request(
      new Request(`http://localhost${DRY_RUN_PATH}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-scope-ausente-0000',
          'content-type': 'application/json',
          [IDEMPOTENCY_HEADER]: KEY,
        },
        body: JSON.stringify(dryRunBody()),
      }),
      deps,
    )
    expect(response.status).toBe(403)
    expect(errorOf(await parse(response)).code).toBe('FORBIDDEN')
  })

  it('nega ambiente inválido (default deny) e ambiente divergente do alvo', async () => {
    const invalidEnvironment = await handleProjectCenterV2Request(
      new Request(`http://localhost${OPERATION_PATH}`, {
        headers: { authorization: 'Bearer tok-ambiente-invalido-000' },
      }),
      {
        ...harness.deps,
        verifier: {
          verify: () => ({
            ...claims('project_reader', OPERATOR),
            environment: 'sandbox' as never,
          }),
        },
      },
    )
    expect(invalidEnvironment.status).toBe(422)
    expect(errorOf(await parse(invalidEnvironment)).code).toBe('POLICY_DENIED')

    const mismatch = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody({ environment: 'production' }),
    })
    expect(mismatch.status).toBe(403)
    expect(errorOf(await parse(mismatch)).code).toBe('FORBIDDEN')
    expect(harness.observationCalls).toHaveLength(0)
  })

  it('limita por ator+operação com Retry-After', async () => {
    harness.setRateLimiter(new InMemoryRateLimitPort(1, 60))
    const first = await createOperation(harness)
    expect(operationOf(first).operation_id).toBe(OPERATION_ID)

    const limited = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: 'idem-outra-chave-000001',
      body: dryRunBody({ project_slug: 'outro' }),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('60')
    const body = await parse(limited)
    expect(errorOf(body).code).toBe('RATE_LIMITED')
    expect(errorOf(body).retryable).toBe(true)
    expect(errorOf(body).retry_after_seconds).toBe(60)
  })

  it('exige Idempotency-Key e If-Match com formato contratual', async () => {
    const noKey = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: null,
      body: dryRunBody(),
    })
    expect(noKey.status).toBe(400)

    const badKey = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: 'curta',
      body: dryRunBody(),
    })
    expect(badKey.status).toBe(400)

    await createOperation(harness)

    const noIfMatch = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000001',
      body: {
        decision: 'approve',
        plan_hash: CANONICAL.plan_hash,
        confirmation: expectedApprovalConfirmation(
          CANONICAL.project_id,
          CANONICAL.plan_hash,
        ),
      },
    })
    expect(noIfMatch.status).toBe(400)

    const badIfMatch = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000002',
      ifMatch: 'dois',
      body: {
        decision: 'approve',
        plan_hash: CANONICAL.plan_hash,
        confirmation: expectedApprovalConfirmation(
          CANONICAL.project_id,
          CANONICAL.plan_hash,
        ),
      },
    })
    expect(badIfMatch.status).toBe(400)
  })

  it('recusa operation_id fora do formato uuid', async () => {
    const response = await harness.send({
      method: 'GET',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/nao-e-uuid`,
      token: TOKEN_READER,
    })
    expect(response.status).toBe(400)
  })

  it('responde 404 para operação inexistente', async () => {
    const response = await harness.send({
      method: 'GET',
      path: `${PROJECT_CENTER_V2_OPERATIONS_PATH}/11111111-2222-3333-4444-555555555555`,
      token: TOKEN_READER,
    })
    expect(response.status).toBe(404)
    expect(errorOf(await parse(response)).code).toBe('NOT_FOUND')
  })
})

describe('dry-run e idempotência', () => {
  let harness: Harness
  beforeEach(() => {
    harness = makeHarness()
  })

  it('cria a operação em awaiting_approval com plano, prazo e auditoria', async () => {
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody(),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('Idempotency-Replayed')).toBe('false')
    expect(response.headers.get('Location')).toBe(OPERATION_PATH)

    const body = await parse(response)
    const operation = operationOf(body)
    expect(operation.operation_id).toBe(OPERATION_ID)
    expect(operation.state).toBe('awaiting_approval')
    expect(operation.operation_version).toBe(2)
    expect(operation.plan_hash).toBe(CANONICAL.plan_hash)
    expect(operation.status_url).toBe(OPERATION_PATH)
    expect(operation.audit_url).toBe(`${OPERATION_PATH}/audit`)
    expect(operation.approval).toBeNull()
    expect(operation.rollback).toBeNull()

    const events = harness.audit.list(OPERATION_ID).events
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(events.map((event) => event.to_state)).toEqual([
      'planned',
      'awaiting_approval',
    ])
    expect(harness.ownership.get(OPERATION_ID)?.requester_subject).toBe(
      OPERATOR,
    )
    expect(harness.outbox.list()).toHaveLength(0)
  })

  it('replay da mesma chave devolve a mesma resposta sem novo efeito', async () => {
    const first = await createOperation(harness)
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody(),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Idempotency-Replayed')).toBe('true')
    const replayed = await parse(response)
    expect(operationOf(replayed).operation_id).toBe(
      operationOf(first).operation_id,
    )
    expect(operationOf(replayed).operation_version).toBe(2)
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(2)
  })

  it('mesma chave com payload diferente é conflito 409', async () => {
    await createOperation(harness)
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: { ...dryRunBody(), reason: 'mesma intencao, outro motivo' },
    })
    expect(response.status).toBe(409)
    expect(errorOf(await parse(response)).code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('recupera a resposta quando a queda acontece depois do commit', async () => {
    harness.setAfterCommit(() => {
      throw new Error('queda simulada na borda')
    })
    const failed = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody(),
    })
    expect(failed.status).toBe(500)
    expect(harness.operations.get(OPERATION_ID)?.state).toBe(
      'awaiting_approval',
    )

    harness.setAfterCommit(null)
    const recovered = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: KEY,
      body: dryRunBody(),
    })
    expect(recovered.status).toBe(201)
    expect(recovered.headers.get('Idempotency-Replayed')).toBe('true')
    const body = await parse(recovered)
    expect(operationOf(body).state).toBe('awaiting_approval')
    // Nenhum efeito duplicado: dois eventos, uma operação.
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(2)
  })

  it('registra somente o hash da chave, nunca a chave bruta', async () => {
    await createOperation(harness)
    const record = harness.deps.idempotency.get(hashIdempotencyKey(KEY))
    expect(record?.key_hash).toMatch(/^idem_[a-f0-9]{64}$/)
    expect(JSON.stringify(record)).not.toContain(KEY)
    expect(record?.operation_id).toBe(OPERATION_ID)
  })
})

describe('aprovação de provisionamento', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = makeHarness()
    await createOperation(harness)
  })

  function approveRequest(overrides: Json = {}): Json {
    return {
      decision: 'approve',
      plan_hash: CANONICAL.plan_hash,
      confirmation: expectedApprovalConfirmation(
        CANONICAL.project_id,
        CANONICAL.plan_hash,
      ),
      ...overrides,
    }
  }

  it('aprova com hash, revisão e novo approval_id', async () => {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000010',
      ifMatch: '"2"',
      body: approveRequest(),
    })
    expect(response.status).toBe(200)
    const operation = operationOf(await parse(response))
    expect(operation.state).toBe('approved')
    expect(operation.operation_version).toBe(3)
    const approval = asJson(operation.approval)
    expect(approval.decision).toBe('approve')
    expect(approval.plan_hash).toBe(CANONICAL.plan_hash)
    expect(approval.actor_ref).toBe(actorRefFor(APPROVER))
    expect(String(approval.approval_id)).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.stringify(operation)).not.toContain(APPROVER)
  })

  it('recusa token de agente com project:approve sem side effect', async () => {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_AGENT,
      key: 'idem-approve-0000000011',
      ifMatch: '"2"',
      body: approveRequest(),
    })
    expect(response.status).toBe(403)
    const body = await parse(response)
    expect(errorOf(body).code).toBe('FORBIDDEN')
    const raw = JSON.stringify(body)
    expect(raw).toContain('non_human_actor')
    expect(raw).not.toContain(AGENT)
    expect(raw).not.toContain(TOKEN_AGENT)

    // Zero side effect: estado, aprovação e auditoria intactos.
    expect(harness.operations.get(OPERATION_ID)?.state).toBe(
      'awaiting_approval',
    )
    expect(harness.approvals.get(OPERATION_ID)).toBeNull()
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(2)
  })

  it('recusa dupla pessoa (mesmo solicitante) e requerente desconhecido', async () => {
    const sameRequester = await handleProjectCenterV2Request(
      new Request(`http://localhost${OPERATION_PATH}/approve`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_OPERATOR}`,
          'content-type': 'application/json',
          [IDEMPOTENCY_HEADER]: 'idem-approve-0000000012',
          [IF_MATCH_HEADER]: '"2"',
        },
        body: JSON.stringify(approveRequest()),
      }),
      {
        ...harness.deps,
        verifier: {
          verify: () => claims('project_approver', OPERATOR),
        },
      },
    )
    expect(sameRequester.status).toBe(403)

    harness.ownership.discard(OPERATION_ID)
    const unknown = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000013',
      ifMatch: '"2"',
      body: approveRequest(),
    })
    expect(unknown.status).toBe(403)
    expect(harness.approvals.get(OPERATION_ID)).toBeNull()
  })

  it('recusa hash divergente e revisão divergente', async () => {
    const divergent = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000014',
      ifMatch: '"2"',
      body: approveRequest({
        plan_hash: 'b'.repeat(64),
        confirmation: `APROVAR ${CANONICAL.project_id} ${'b'.repeat(8)}`,
      }),
    })
    expect(divergent.status).toBe(403)
    expect(errorOf(await parse(divergent)).code).toBe('FORBIDDEN')

    const stale = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000015',
      ifMatch: '"7"',
      body: approveRequest(),
    })
    expect(stale.status).toBe(409)
    expect(errorOf(await parse(stale)).code).toBe('PLAN_STALE')
    expect(harness.approvals.get(OPERATION_ID)).toBeNull()
  })

  it('recusa confirmação fora do pattern e rejeição com frase', async () => {
    const wrongPhrase = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000016',
      ifMatch: '"2"',
      body: approveRequest({
        confirmation: `APROVAR outro-projeto ${CANONICAL.plan_hash.slice(0, 8)}`,
      }),
    })
    expect(wrongPhrase.status).toBe(400)
    expect(errorOf(await parse(wrongPhrase)).code).toBe('INVALID_REQUEST')

    const rejectedWithPhrase = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000017',
      ifMatch: '"2"',
      body: {
        decision: 'reject',
        reason: 'custo acima do previsto',
        confirmation: expectedApprovalConfirmation(
          CANONICAL.project_id,
          CANONICAL.plan_hash,
        ),
      },
    })
    expect(rejectedWithPhrase.status).toBe(400)
  })

  it('rejeita com motivo registrando a decisão', async () => {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000018',
      ifMatch: '"2"',
      body: { decision: 'reject', reason: 'custo acima do previsto' },
    })
    expect(response.status).toBe(200)
    const operation = operationOf(await parse(response))
    expect(operation.state).toBe('rejected')
    expect(asJson(operation.approval).decision).toBe('reject')
  })

  it('expira o plano vencido com 410 e nenhuma aprovação', async () => {
    harness.setNow('2026-09-25T12:45:00.000Z')
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000019',
      ifMatch: '"2"',
      body: approveRequest(),
    })
    expect(response.status).toBe(410)
    const expiredBody = await parse(response)
    expect(errorOf(expiredBody).code, JSON.stringify(expiredBody)).toBe(
      'APPROVAL_EXPIRED',
    )
    expect(harness.operations.get(OPERATION_ID)?.state).toBe('expired')
    expect(harness.approvals.get(OPERATION_ID)).toBeNull()

    const replay = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000019',
      ifMatch: '"2"',
      body: approveRequest(),
    })
    expect(replay.status).toBe(410)
  })
})

describe('execute e verify (enfileiramento sem worker)', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = makeHarness()
    await createOperation(harness)
  })

  async function approve(): Promise<void> {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-approve-0000000021',
      ifMatch: '"2"',
      body: {
        decision: 'approve',
        plan_hash: CANONICAL.plan_hash,
        confirmation: expectedApprovalConfirmation(
          CANONICAL.project_id,
          CANONICAL.plan_hash,
        ),
      },
    })
    expect(response.status).toBe(200)
  }

  it('recusa executar sem aprovação válida', async () => {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000022',
      ifMatch: '"2"',
      body: { plan_hash: CANONICAL.plan_hash },
    })
    expect(response.status).toBe(409)
    expect(errorOf(await parse(response)).code).toBe('APPROVAL_REQUIRED')
    expect(harness.outbox.list()).toHaveLength(0)
  })

  it('enfileira a execução aprovada sem executor e sem side effect', async () => {
    await approve()
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000023',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    })
    expect(response.status).toBe(202)
    expect(response.headers.get('Location')).toBe(OPERATION_PATH)
    const operation = operationOf(await parse(response))
    expect(operation.state).toBe('queued')
    expect(operation.verification ?? null).toBeNull()
    expect(operation.artifacts ?? []).toEqual([])

    const entries = harness.outbox.listFor(OPERATION_ID)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('execute')
    expect(entries[0]?.state).toBe('pending')
    expect(entries[0]?.plan_hash).toBe(CANONICAL.plan_hash)

    const last = harness.audit.list(OPERATION_ID).events.at(-1)
    expect(last?.type).toBe('project_center.execute')
    expect(last?.to_state).toBe('queued')
    expect(asJson(last?.safe_payload).worker_enabled).toBe(false)
  })

  it('mantém o enfileiramento como único efeito mesmo com worker ligado', async () => {
    harness.setFlags(FLAGS_FULL)
    await approve()
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000024',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    })
    expect(response.status).toBe(202)
    expect(operationOf(await parse(response)).state).toBe('queued')
    expect(harness.outbox.listFor(OPERATION_ID)).toHaveLength(1)
    const last = harness.audit.list(OPERATION_ID).events.at(-1)
    expect(asJson(last?.safe_payload).worker_enabled).toBe(true)
  })

  it('replay da execução não duplica o item de outbox', async () => {
    await approve()
    const request = {
      method: 'POST' as const,
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000030',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    }
    const first = await harness.send(request)
    expect(first.status).toBe(202)

    const replay = await harness.send(request)
    expect(replay.status).toBe(202)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(operationOf(await parse(replay)).state).toBe('queued')
    expect(harness.outbox.listFor(OPERATION_ID)).toHaveLength(1)
    // planned, awaiting_approval, approval e execute — sem evento novo no replay.
    expect(harness.audit.lastSequence(OPERATION_ID)).toBe(4)
  })

  it('mantém o enfileiramento como único efeito mesmo com worker ligado (duplicado)', async () => {
    harness.setFlags(FLAGS_FULL)
    await approve()
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000024',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    })
    expect(response.status).toBe(202)
    expect(operationOf(await parse(response)).state).toBe('queued')
    expect(harness.outbox.listFor(OPERATION_ID)).toHaveLength(1)
    const last = harness.audit.list(OPERATION_ID).events.at(-1)
    expect(asJson(last?.safe_payload).worker_enabled).toBe(true)
  })

  it('recusa plano divergente e operação com lease de outro worker', async () => {
    await approve()
    const divergent = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000025',
      ifMatch: '"3"',
      body: { plan_hash: 'c'.repeat(64) },
    })
    expect(divergent.status).toBe(409)

    harness.setLease('worker-pcv2-1')
    const locked = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000026',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    })
    expect(locked.status).toBe(423)
    expect(locked.headers.get('Retry-After')).toBe('60')
    const body = await parse(locked)
    expect(errorOf(body).code).toBe('OPERATION_LOCKED')
    expect(errorOf(body).retryable).toBe(true)
    expect(harness.outbox.list()).toHaveLength(0)
  })

  it('só verifica operação concluída e apenas enfileira a verificação', async () => {
    await approve()
    await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-execute-0000000027',
      ifMatch: '"3"',
      body: { plan_hash: CANONICAL.plan_hash },
    })

    const tooEarly = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/verify`,
      token: TOKEN_OPERATOR,
      key: 'idem-verify-0000000028',
      ifMatch: '"4"',
      body: {},
    })
    expect(tooEarly.status).toBe(409)

    advance(harness, ['executing', 'verifying', 'succeeded'])
    const revision = harness.operations.get(OPERATION_ID)?.operation_version
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/verify`,
      token: TOKEN_OPERATOR,
      key: 'idem-verify-0000000029',
      ifMatch: `"${revision}"`,
      body: { checks: ['health', 'ownership'] },
    })
    expect(response.status).toBe(202)
    const operation = operationOf(await parse(response))
    expect(operation.state).toBe('succeeded')
    const kinds = harness.outbox
      .listFor(OPERATION_ID)
      .map((entry) => entry.kind)
    expect(kinds).toEqual(['execute', 'verify'])
  })
})

describe('rollback em três fases', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = makeHarness()
    await createOperation(harness)
    advance(harness, SUCCEEDED_PATH)
  })

  function revision(): number {
    return harness.operations.get(OPERATION_ID)?.operation_version ?? 1
  }

  async function rollbackDryRun(
    key = 'idem-rollback-dryrun-0001',
  ): Promise<Json> {
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/dry-run`,
      token: TOKEN_OPERATOR,
      key,
      ifMatch: `"${revision()}"`,
      body: { reason: 'restaurar estado anterior', preserve_data: true },
    })
    expect(response.status).toBe(201)
    return parse(response)
  }

  it('emite plano de rollback com hash próprio e ownership comprovado', async () => {
    const body = await rollbackDryRun()
    const rollback = asJson(operationOf(body).rollback)
    expect(String(rollback.rollback_plan_hash)).toMatch(/^[a-f0-9]{64}$/)
    expect(rollback.rollback_plan_hash).not.toBe(CANONICAL.plan_hash)
    expect(rollback.ownership_verified).toBe(true)
    expect(rollback.destructive).toBe(false)
    expect(rollback.preserve_data).toBe(true)
    expect(rollback.approval).toBeNull()
    expect(
      harness.ownership.get(OPERATION_ID)?.rollback_requester_subject,
    ).toBe(OPERATOR)
    expect(harness.operations.get(OPERATION_ID)?.state).toBe('succeeded')
  })

  it('recusa rollback sem porta de observação, com drift ou sem ownership', async () => {
    harness.setRollback('closed')
    const closed = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/dry-run`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-dryrun-0002',
      ifMatch: `"${revision()}"`,
      body: { reason: 'restaurar estado anterior' },
    })
    expect(closed.status).toBe(422)
    expect(errorOf(await parse(closed)).code).toBe('ROLLBACK_NOT_SAFE')

    harness.setRollback({
      actions: CANONICAL.plan.actions,
      observed_revision: CANONICAL.observed_revision,
      ownership_verified: true,
      drift_findings: ['recurso sem ownership'],
    })
    const drift = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/dry-run`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-dryrun-0003',
      ifMatch: `"${revision()}"`,
      body: { reason: 'restaurar estado anterior' },
    })
    expect(drift.status).toBe(422)

    harness.setRollback({
      actions: CANONICAL.plan.actions,
      observed_revision: CANONICAL.observed_revision,
      ownership_verified: false,
      drift_findings: [],
    })
    const unowned = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/dry-run`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-dryrun-0004',
      ifMatch: `"${revision()}"`,
      body: { reason: 'restaurar estado anterior' },
    })
    expect(unowned.status).toBe(422)
    expect(harness.rollbackPlans.get(OPERATION_ID)).toBeNull()
  })

  it('exige frase de rollback, novo approval_id e segregação dupla', async () => {
    const body = await rollbackDryRun('idem-rollback-dryrun-0005')
    const rollbackHash = String(
      asJson(operationOf(body).rollback).rollback_plan_hash,
    )

    const wrongKind = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-rollback-approve-0006',
      ifMatch: `"${revision()}"`,
      body: {
        decision: 'approve',
        rollback_plan_hash: rollbackHash,
        confirmation: expectedApprovalConfirmation(
          CANONICAL.project_id,
          rollbackHash,
        ),
      },
    })
    expect(wrongKind.status).toBe(400)
    expect(errorOf(await parse(wrongKind)).code).toBe('INVALID_REQUEST')

    const requesterApproves = await handleProjectCenterV2Request(
      new Request(`http://localhost${OPERATION_PATH}/rollback/approve`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_OPERATOR}`,
          'content-type': 'application/json',
          [IDEMPOTENCY_HEADER]: 'idem-rollback-approve-0007',
          [IF_MATCH_HEADER]: `"${revision()}"`,
        },
        body: JSON.stringify({
          decision: 'approve',
          rollback_plan_hash: rollbackHash,
          confirmation: expectedRollbackConfirmation(
            CANONICAL.project_id,
            rollbackHash,
          ),
        }),
      }),
      {
        ...harness.deps,
        verifier: {
          verify: () => claims('project_approver', OPERATOR),
        },
      },
    )
    expect(requesterApproves.status).toBe(403)

    const approved = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-rollback-approve-0008',
      ifMatch: `"${revision()}"`,
      body: {
        decision: 'approve',
        rollback_plan_hash: rollbackHash,
        confirmation: expectedRollbackConfirmation(
          CANONICAL.project_id,
          rollbackHash,
        ),
      },
    })
    expect(approved.status).toBe(200)
    const stored = harness.rollbackPlans.get(OPERATION_ID)
    expect(stored?.approval?.approval_id).toBeDefined()
    expect(stored?.approval?.rollback_plan_hash).toBe(rollbackHash)
    expect(stored?.approval?.actor_ref).toBe(actorRefFor(APPROVER))
    // Aprovação independente da aprovação de provisionamento.
    expect(stored?.approval?.approval_id).not.toBe(
      harness.approvals.get(OPERATION_ID)?.approval_id,
    )
  })

  it('exige aprovação para executar e revalida ownership/drift', async () => {
    const body = await rollbackDryRun('idem-rollback-dryrun-0009')
    const rollbackHash = String(
      asJson(operationOf(body).rollback).rollback_plan_hash,
    )

    const withoutApproval = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-execute-0010',
      ifMatch: `"${revision()}"`,
      body: { rollback_plan_hash: rollbackHash, approval_id: OPERATION_ID },
    })
    expect(withoutApproval.status).toBe(409)
    expect(errorOf(await parse(withoutApproval)).code).toBe('APPROVAL_REQUIRED')

    await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-rollback-approve-0011',
      ifMatch: `"${revision()}"`,
      body: {
        decision: 'approve',
        rollback_plan_hash: rollbackHash,
        confirmation: expectedRollbackConfirmation(
          CANONICAL.project_id,
          rollbackHash,
        ),
      },
    })
    const approvalId = harness.rollbackPlans.get(OPERATION_ID)?.approval
      ?.approval_id as string

    harness.setRollback({
      actions: CANONICAL.plan.actions,
      observed_revision: CANONICAL.observed_revision,
      ownership_verified: false,
      drift_findings: [],
    })
    const unowned = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-execute-0012',
      ifMatch: `"${revision()}"`,
      body: { rollback_plan_hash: rollbackHash, approval_id: approvalId },
    })
    expect(unowned.status).toBe(422)
    expect(errorOf(await parse(unowned)).code).toBe('ROLLBACK_NOT_SAFE')

    harness.setRollback({
      actions: CANONICAL.plan.actions,
      observed_revision: `obsrev_${'b'.repeat(32)}`,
      ownership_verified: true,
      drift_findings: [],
    })
    const drifted = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-execute-0013',
      ifMatch: `"${revision()}"`,
      body: { rollback_plan_hash: rollbackHash, approval_id: approvalId },
    })
    expect(drifted.status).toBe(409)
    expect(errorOf(await parse(drifted)).code).toBe('PLAN_STALE')

    harness.setRollback({
      actions: CANONICAL.plan.actions,
      observed_revision: CANONICAL.observed_revision,
      ownership_verified: true,
      drift_findings: [],
    })
    const response = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-execute-0014',
      ifMatch: `"${revision()}"`,
      body: { rollback_plan_hash: rollbackHash, approval_id: approvalId },
    })
    expect(response.status).toBe(202)
    const operation = operationOf(await parse(response))
    expect(operation.state).toBe('rollback_pending')
    expect(harness.outbox.listFor(OPERATION_ID).at(-1)?.kind).toBe(
      'rollback_execute',
    )
  })

  it('recusa approval_id divergente e hash de rollback divergente', async () => {
    const body = await rollbackDryRun('idem-rollback-dryrun-0015')
    const rollbackHash = String(
      asJson(operationOf(body).rollback).rollback_plan_hash,
    )
    await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/approve`,
      token: TOKEN_APPROVER,
      key: 'idem-rollback-approve-0016',
      ifMatch: `"${revision()}"`,
      body: {
        decision: 'approve',
        rollback_plan_hash: rollbackHash,
        confirmation: expectedRollbackConfirmation(
          CANONICAL.project_id,
          rollbackHash,
        ),
      },
    })

    const wrongHash = await harness.send({
      method: 'POST',
      path: `${OPERATION_PATH}/rollback/execute`,
      token: TOKEN_OPERATOR,
      key: 'idem-rollback-execute-0017',
      ifMatch: `"${revision()}"`,
      body: {
        rollback_plan_hash: 'e'.repeat(64),
        approval_id: OPERATION_ID,
      },
    })
    expect(wrongHash.status).toBe(409)
    expect(errorOf(await parse(wrongHash)).code).toBe('PLAN_STALE')
  })
})

describe('auditoria e sanitização', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = makeHarness()
    await createOperation(harness)
  })

  it('lista a trilha append-only com paginação por cursor', async () => {
    const response = await harness.send({
      method: 'GET',
      path: `${OPERATION_PATH}/audit`,
      token: TOKEN_AUDITOR,
    })
    expect(response.status).toBe(200)
    const page = await parse(response)
    expect(page.operation_id).toBe(OPERATION_ID)
    const events = page.events as ReadonlyArray<Json>
    expect(events).toHaveLength(2)
    expect(events[0]?.sequence).toBe(1)
    expect(page.next_cursor).toBeNull()

    const page2 = await harness.send({
      method: 'GET',
      path: `${OPERATION_PATH}/audit`,
      token: TOKEN_AUDITOR,
      query: 'limit=1',
    })
    const first = await parse(page2)
    expect(first.events as ReadonlyArray<Json>).toHaveLength(1)
    expect(typeof first.next_cursor).toBe('string')

    const page3 = await harness.send({
      method: 'GET',
      path: `${OPERATION_PATH}/audit`,
      token: TOKEN_AUDITOR,
      query: `limit=1&cursor=${String(first.next_cursor)}`,
    })
    const second = await parse(page3)
    expect((second.events as ReadonlyArray<Json>)[0]?.sequence).toBe(2)
    expect(second.next_cursor).toBeNull()
  })

  it('recusa limite e cursor fora do contrato', async () => {
    const tooBig = await harness.send({
      method: 'GET',
      path: `${OPERATION_PATH}/audit`,
      token: TOKEN_AUDITOR,
      query: 'limit=501',
    })
    expect(tooBig.status).toBe(400)

    const badCursor = await harness.send({
      method: 'GET',
      path: `${OPERATION_PATH}/audit`,
      token: TOKEN_AUDITOR,
      query: 'cursor=nao-e-cursor',
    })
    expect(badCursor.status).toBe(400)
    expect(errorOf(await parse(badCursor)).code).toBe('INVALID_REQUEST')
  })

  it('fecha falha de observação sem vazar DSN do erro original', async () => {
    harness.setObserved(null)
    const response = await harness.send({
      method: 'POST',
      path: DRY_RUN_PATH,
      token: TOKEN_OPERATOR,
      key: 'idem-dsn-00000000000001',
      body: dryRunBody({ project_slug: 'com-dsn' }),
    })
    expect(response.status).toBe(500)
    const raw = JSON.stringify(await parse(response))
    expect(raw).not.toContain('postgres://')
    expect(raw).not.toContain('senha')
    expect(errorOf(JSON.parse(raw) as Json).code).toBe('INTERNAL_ERROR')
  })

  it('falha fechado quando um SecretRef apareceria fora de campo tipado', async () => {
    const token = `sref_${'A'.repeat(43)}`
    const leaky: OperationStore = {
      ...harness.operations,
      get: (operationId: string) => {
        const operation = harness.operations.get(operationId)
        if (operation === null) return null
        return {
          ...operation,
          plan: {
            ...operation.plan,
            actions: operation.plan.actions.map((action, index) =>
              index === 0 ? { ...action, target_ref: token } : action,
            ),
          },
        }
      },
    }

    const response = await handleProjectCenterV2Request(
      new Request(`http://localhost${OPERATION_PATH}`, {
        headers: { authorization: `Bearer ${TOKEN_READER}` },
      }),
      { ...harness.deps, operations: leaky },
    )
    expect(response.status).toBe(500)
    const raw = JSON.stringify(await parse(response))
    expect(raw).not.toContain(token)
    expect(raw).toContain('INTERNAL_ERROR')
  })

  it('não expõe o token do agente nem o subject cru nas respostas', async () => {
    const response = await harness.send({
      method: 'GET',
      path: OPERATION_PATH,
      token: TOKEN_READER,
    })
    expect(response.status).toBe(200)
    const raw = JSON.stringify(await parse(response))
    expect(raw).not.toContain(TOKEN_OPERATOR)
    expect(raw).not.toContain(OPERATOR)
  })
})

describe('superfície de dublês', () => {
  it('o runtime real nasce com verificador fechado (401) e sem drivers extras', async () => {
    const verifier = createDenyAllVerifier()
    expect(verifier.verify('qualquer-token-000000')).toBeNull()
    expect(OPEN_LEASE_GUARD.holder('qualquer')).toBeNull()
  })
})
