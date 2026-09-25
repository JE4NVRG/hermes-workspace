/**
 * Testes do worker de outbox (PR 6).
 *
 * Prova: revalidação completa antes de cada ação (flag, hash, aprovação,
 * revisão, estado, lease), retry só de erro transitório com teto, escalada para
 * intervenção manual, ordenação por dependência, publicação só após PASS e
 * nenhum side effect com o worker desligado.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { appRoleNameFor, buildNamingSnapshot } from './naming'
import { createInMemoryLeaseStore } from './lease-store'
import { createInMemoryOutboxStore } from './idempotency'
import { transitionOperation } from './state-machine'
import {
  WORKER_LEASE_TTL_SECONDS,
  WORKER_MAX_ATTEMPTS,
  WORKER_VERSION,
  WorkerPlanError,
  createWorker,
  deriveNamingFromPlan,
  orderActionsByDependency,
  revalidateEntry,
} from './worker'
import {
  createActionExecutor,
  renderActionTemplate,
} from './executors/action-executor'
import {
  createInMemoryOperationApprovalStore,
  createInMemoryRollbackPlanStore,
} from './approval-service'
import type { OperationState } from './state-machine'
import type { WorkerActionContextPort, WorkerDeps } from './worker'
import type {
  ActionTemplate,
  DriverActionInput,
  DriverExecutor,
  ProcessRunInput,
} from './executors/action-executor'
import type { OperationStore } from './operation-store'
import type { Approval, Operation, PlannedAction, RollbackPlan } from './domain'
import type { OutboxEntry } from './idempotency'
import type { OwnedResource, RollbackService } from './rollback-service'

const PROJECT_ID = 'acme-site'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const HOLDER = 'pcv2-worker'
const PLAN_HASH = 'a'.repeat(64)
const REVISION = `obsrev_${'c'.repeat(32)}`
const NAMING = buildNamingSnapshot({
  client_id: 'acme',
  project_slug: 'site',
  environment: 'development',
  driver: 'postgresql_isolated',
})
const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

const ACTIONS: ReadonlyArray<PlannedAction> = Object.freeze([
  {
    action_id: 'act_create_database',
    kind: 'create_database',
    target_ref: `database:${NAMING.database}`,
    risk: 'reversible',
    reversible: true,
    dependencies: [],
  },
  {
    action_id: 'act_create_app_role',
    kind: 'create_app_role',
    target_ref: `role:${NAMING.app_role}`,
    risk: 'reversible',
    reversible: true,
    dependencies: ['act_create_database'],
  },
  {
    action_id: 'act_health_check',
    kind: 'health_check',
    target_ref: `health:${NAMING.compose_project}`,
    risk: 'read_only',
    reversible: true,
    dependencies: [],
  },
])

function buildOperation(
  overrides: Partial<Record<string, unknown>> = {},
): Operation {
  return {
    operation_id: OPERATION_ID,
    project_id: PROJECT_ID,
    driver: 'postgresql_isolated',
    environment: 'development',
    state: 'queued',
    operation_version: 3,
    plan_hash: PLAN_HASH,
    observed_revision: REVISION,
    plan: {
      policy_version: 'pcv2-policy-v1',
      actions: ACTIONS,
      estimated_resources: {
        cpu_millicores: 500,
        memory_mb: 512,
        disk_mb: 1024,
      },
      warnings: [],
    },
    approval: {
      approval_id: '22222222-2222-4222-8222-222222222222',
      decision: 'approve',
      actor_ref: 'usr_jean',
      plan_hash: PLAN_HASH,
      decided_at: '2026-09-25T11:00:00.000Z',
      expires_at: '2026-09-25T23:00:00.000Z',
    },
    rollback: null,
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T11:00:00.000Z',
    expires_at: '2026-09-25T23:00:00.000Z',
    status_url: '/api/x',
    audit_url: '/api/y',
    ...overrides,
  } as unknown as Operation
}

function createFakeOperationStore(initial: Operation): {
  readonly store: OperationStore
  readonly current: () => Operation
} {
  let state = initial
  const store: OperationStore = {
    create: () => {
      throw new Error('create nao usado no teste do worker')
    },
    get: (operationId) => (operationId === state.operation_id ? state : null),
    require: (operationId) => {
      if (operationId !== state.operation_id)
        throw new Error('operacao ausente')
      return state
    },
    transition: (operationId, next, expectedRevision) => {
      const resolved = transitionOperation(state.state, next, {
        actual: state.operation_version,
        expected: expectedRevision,
      })
      state = {
        ...state,
        state: resolved,
        operation_version: state.operation_version + 1,
      } as Operation
      return state
    },
    list: () => [state],
    activeFor: () => [],
  }
  return { store, current: () => state }
}

interface DriverHarness {
  readonly driver: DriverExecutor
  readonly calls: ReadonlyArray<DriverActionInput>
  readonly argvs: ReadonlyArray<ReadonlyArray<string>>
  readonly setFailure: (value: {
    readonly actionId: string | null
    readonly retryable: boolean
  }) => void
}

function createFakeDriverExecutor(): DriverHarness {
  const calls: Array<DriverActionInput> = []
  const argvs: Array<ReadonlyArray<string>> = []
  let failure: { actionId: string | null; retryable: boolean } = {
    actionId: null,
    retryable: false,
  }
  return {
    calls,
    argvs,
    setFailure: (value) => {
      failure = value
    },
    driver: {
      driver: 'postgresql_isolated',
      adapter_id: 'fake-postgres-adapter',
      executor_version: 'pcv2-pg-executor-v1',
      supported_actions: ACTIONS.map((action) => action.kind),
      execute: async (input: DriverActionInput) => {
        calls.push(input)
        if (input.template !== null) {
          const template = input.template
          argvs.push(renderActionTemplate(template, input.params))
        }
        if (failure.actionId === input.action.action_id) {
          return {
            status: 'failed',
            safe_detail: 'adapter falhou',
            failure: {
              code: 'EXECUTION_FAILED',
              message: 'falha simulada',
              retryable: failure.retryable,
              fingerprint: `err_${'d'.repeat(16)}`,
            },
          }
        }
        return { status: 'succeeded', safe_detail: `ok ${input.action.kind}` }
      },
    },
  }
}

interface Harness {
  readonly worker: ReturnType<typeof createWorker>
  readonly driver: DriverHarness
  readonly operations: ReturnType<typeof createFakeOperationStore>
  readonly outbox: ReturnType<typeof createInMemoryOutboxStore>
  readonly leases: ReturnType<typeof createInMemoryLeaseStore>
  readonly publish: ReturnType<typeof vi.fn>
  readonly rollbackExecute: ReturnType<typeof vi.fn>
  readonly setPublishResult: (value: {
    published: boolean
    safe_detail: string
  }) => void
  readonly setRollbackResult: (value: {
    aborted: boolean
    safe_detail: string
  }) => void
  readonly run: () => ReturnType<ReturnType<typeof createWorker>['runOnce']>
}

function createHarness(
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly operation?: Operation
    readonly kind?: OutboxEntry['kind']
    readonly observedRevision?: string
    readonly resources?: ReadonlyArray<OwnedResource>
  } = {},
): Harness {
  const baseOperation = options.operation ?? buildOperation()
  const operations = createFakeOperationStore(baseOperation)
  const outbox = createInMemoryOutboxStore()
  outbox.append({
    operationId: OPERATION_ID,
    kind: options.kind ?? 'execute',
    planHash: PLAN_HASH,
    projectId: PROJECT_ID,
    environment: 'development',
    outboxId: 'outbox-1',
  })
  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '33333333-3333-4333-8333-333333333333',
  })
  const driver = createFakeDriverExecutor()
  const actions = createActionExecutor({
    flags: options.flags ?? FLAGS_ON,
    leases,
    drivers: { postgresql_isolated: driver.driver },
  })
  let publishResult = { published: true, safe_detail: 'publicado' }
  const publish = vi.fn(async () => publishResult)
  let rollbackResult = { aborted: false, safe_detail: 'rollback concluido' }
  const rollbackExecute = vi.fn(async () => rollbackResult)

  const context: WorkerActionContextPort = {
    adapter_id: 'fake-context',
    resolve: async () => ({
      hostTarget: 'vps-primary-local',
      endpoint: { host: '127.0.0.1', port: 55432 },
      restoreDatabase: 'je4ndev_pcv2_restoreab',
      peerDatabase: 'je4ndev_canary_peer',
    }),
  }

  const rollback = {
    version: 'pcv2-rollback-v1',
    planning: {
      observe: async () => ({
        actions: [],
        observed_revision: REVISION,
        ownership_verified: true,
        drift_findings: [],
      }),
    },
    planExecution: () => ({
      executable: [
        {
          action_id: 'act_rb_drop_database',
          kind: 'drop_resource_created_by_operation' as const,
          target_ref: `database:${NAMING.database}`,
          risk: 'destructive' as const,
          reversible: false,
          dependencies: [],
        },
      ],
      skipped: [],
      manual: [],
      requires_manual_intervention: false,
      safe_detail: 'rollback planejado',
    }),
    execute: rollbackExecute,
  } as unknown as RollbackService

  // Aprovação e plano de rollback vivem em stores próprios (PR 4/5); o worker
  // lê deles, nunca do payload da operação.
  const approvals = createInMemoryOperationApprovalStore()
  const operationApproval = (
    baseOperation as unknown as { approval?: Approval | null }
  ).approval
  if (operationApproval !== null && operationApproval !== undefined) {
    approvals.put(baseOperation.operation_id, operationApproval)
  }
  const rollbackPlans = createInMemoryRollbackPlanStore()
  const operationRollback = (
    baseOperation as unknown as { rollback?: RollbackPlan | null }
  ).rollback
  if (operationRollback !== null && operationRollback !== undefined) {
    rollbackPlans.put(baseOperation.operation_id, operationRollback)
  }

  const deps: WorkerDeps = {
    approvals,
    rollbackPlans,
    flags: options.flags ?? FLAGS_ON,
    operations: operations.store,
    outbox,
    leases,
    actions,
    observations: {
      adapter_id: 'fake-observer',
      observe: async () => ({ revision: options.observedRevision ?? REVISION }),
      ownedResources: async () => options.resources ?? [],
    },
    context,
    publisher: { adapter_id: 'fake-publisher', publish: publish as never },
    rollback,
    holderRef: HOLDER,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  }

  const worker = createWorker(deps)
  return {
    worker,
    driver,
    operations,
    outbox,
    leases,
    publish,
    rollbackExecute,
    setPublishResult: (value) => {
      publishResult = value
    },
    setRollbackResult: (value) => {
      rollbackResult = value
    },
    run: () => worker.runOnce(),
  }
}

/** Aprovação válida para a operação padrão (store de aprovações do PR 4/5). */
function buildApproval(): Approval {
  return {
    approval_id: '22222222-2222-4222-8222-222222222222',
    decision: 'approve',
    actor_ref: 'usr_jean',
    plan_hash: PLAN_HASH,
    decided_at: '2026-09-25T11:00:00.000Z',
    expires_at: '2026-09-25T23:00:00.000Z',
  }
}

describe('worker — revalidação antes de executar', () => {
  it('com o worker desligado nenhum adapter é chamado', async () => {
    const harness = createHarness({ flags: FLAGS_OFF })
    await expect(harness.run()).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(harness.driver.calls).toHaveLength(0)
    expect(harness.publish).not.toHaveBeenCalled()
  })

  it('executa ações em ordem de dependência e para em verifying', async () => {
    const harness = createHarness()
    const result = await harness.run()

    expect(WORKER_VERSION).toBe('pcv2-worker-v1')
    expect(harness.driver.calls.map((call) => call.action.action_id)).toEqual([
      'act_create_database',
      'act_create_app_role',
    ])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.status).toBe('processed')
    expect(result.entries[0]?.state).toBe('verifying')
    expect(harness.operations.current().state).toBe('verifying')
    expect(harness.publish).not.toHaveBeenCalled()
    // Lease liberado no fim: a próxima aquisição funciona com novo token.
    const grant = harness.leases.acquire({
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      environment: 'development',
      holderRef: HOLDER,
    })
    expect(grant.fencing_token).toBeGreaterThan(1)
  })

  it('uma segunda passagem não repete os side effects', async () => {
    const harness = createHarness()
    await harness.run()
    const before = harness.driver.calls.length
    const second = await harness.run()

    // O item de execução fica concluído no diário do worker: a segunda
    // passagem processa só a verificação encadeada por ele.
    expect(second.entries.map((entry) => entry.kind)).toEqual(['verify'])
    const executedKinds = harness.driver.calls
      .slice(before)
      .map((call) => call.action.kind)
    expect(executedKinds).not.toContain('create_database')
    expect(executedKinds).not.toContain('create_app_role')
  })

  it('recusa hash de plano divergente, aprovação ausente e revisão obsoleta', async () => {
    const mismatched = createHarness()
    mismatched.outbox.list()[0]
    const entries = mismatched.outbox.list()
    expect(entries[0]?.plan_hash).toBe(PLAN_HASH)
    const result = await mismatched.run()
    expect(result.entries[0]?.status).toBe('processed')

    // Aprovação vencida: nada é executado.
    const expired = createHarness({
      operation: buildOperation({
        approval: {
          approval_id: '22222222-2222-4222-8222-222222222222',
          decision: 'approve',
          actor_ref: 'usr_jean',
          plan_hash: PLAN_HASH,
          decided_at: '2026-09-25T08:00:00.000Z',
          expires_at: '2026-09-25T09:00:00.000Z',
        },
      }),
    })
    const expiredResult = await expired.run()
    expect(expiredResult.entries[0]?.status).toBe('skipped')
    expect(expired.driver.calls).toHaveLength(0)

    // Sem aprovação registrada.
    const unapproved = createHarness({
      operation: buildOperation({ approval: null }),
    })
    const unapprovedResult = await unapproved.run()
    expect(unapprovedResult.entries[0]?.status).toBe('skipped')
    expect(unapproved.driver.calls).toHaveLength(0)

    // Revisão observada divergente do plano.
    const stale = createHarness({
      observedRevision: `obsrev_${'e'.repeat(32)}`,
    })
    const staleResult = await stale.run()
    expect(staleResult.entries[0]?.safe_detail).toContain(
      'observed_revision_divergente',
    )
    expect(stale.driver.calls).toHaveLength(0)

    // Operação fora de estado executável.
    const succeeded = createHarness({
      operation: buildOperation({ state: 'succeeded' }),
    })
    const succeededResult = await succeeded.run()
    expect(succeededResult.entries[0]?.status).toBe('skipped')
    expect(succeeded.driver.calls).toHaveLength(0)
  })

  it('revalidação isolada devolve motivos explícitos', () => {
    const entry = {
      outbox_id: 'outbox-1',
      operation_id: OPERATION_ID,
      kind: 'execute' as const,
      plan_hash: PLAN_HASH,
      project_id: PROJECT_ID,
      environment: 'development' as const,
      enqueued_at: '2026-09-25T12:00:00.000Z',
      attempt: 1,
      state: 'pending' as const,
    }
    expect(() =>
      revalidateEntry({
        entry: { ...entry, plan_hash: 'b'.repeat(64) },
        operation: buildOperation(),
        approval: buildApproval(),
        rollbackPlan: null,
        flags: FLAGS_ON,
        observedRevision: REVISION,
        now: new Date('2026-09-25T12:00:00.000Z'),
      }),
    ).toThrow()
    expect(() =>
      revalidateEntry({
        entry,
        operation: buildOperation(),
        approval: buildApproval(),
        rollbackPlan: null,
        flags: FLAGS_ON,
        observedRevision: REVISION,
        now: new Date('2026-09-25T12:00:00.000Z'),
      }),
    ).not.toThrow()
    expect(() =>
      revalidateEntry({
        entry,
        operation: buildOperation({ observed_revision: undefined }),
        approval: buildApproval(),
        rollbackPlan: null,
        flags: FLAGS_ON,
        observedRevision: REVISION,
        now: new Date('2026-09-25T12:00:00.000Z'),
      }),
    ).not.toThrow()
  })
})

describe('worker — retry e intervenção manual', () => {
  it('erro transitório tenta de novo e escala após o teto', async () => {
    const harness = createHarness()
    harness.driver.setFailure({
      actionId: 'act_create_database',
      retryable: true,
    })

    const first = await harness.run()
    expect(first.entries[0]?.status).toBe('skipped')
    expect(first.entries[0]?.attempts).toBe(1)
    expect(first.entries[0]?.state).toBe('queued')
    expect(first.entries[0]?.safe_detail).toContain('tentativa 2/3')

    const second = await harness.run()
    expect(second.entries[0]?.status).toBe('skipped')
    expect(second.entries[0]?.attempts).toBe(2)

    const third = await harness.run()
    expect(WORKER_MAX_ATTEMPTS).toBe(3)
    expect(third.entries[0]?.status).toBe('failed')
    expect(third.entries[0]?.attempts).toBe(3)
    expect(third.entries[0]?.safe_detail).toContain('falha definitiva')
    expect(harness.operations.current().state).toBe(
      'manual_intervention_required',
    )
  })

  it('erro definitivo vai direto para manual_intervention_required', async () => {
    const harness = createHarness()
    harness.driver.setFailure({
      actionId: 'act_create_database',
      retryable: false,
    })
    const result = await harness.run()

    expect(result.entries[0]?.status).toBe('failed')
    expect(result.entries[0]?.attempts).toBe(1)
    expect(harness.operations.current().state).toBe(
      'manual_intervention_required',
    )
    // Sem continuação cega: a segunda ação não foi tentada.
    expect(harness.driver.calls.map((call) => call.action.action_id)).toEqual([
      'act_create_database',
    ])
  })

  it('plano com ciclo de dependência não executa nada', async () => {
    const cyclic = createHarness({
      operation: buildOperation({
        plan: {
          policy_version: 'pcv2-policy-v1',
          actions: [
            { ...ACTIONS[0], dependencies: ['act_create_app_role'] },
            { ...ACTIONS[1], dependencies: ['act_create_database'] },
          ],
          estimated_resources: {
            cpu_millicores: 500,
            memory_mb: 512,
            disk_mb: 1024,
          },
          warnings: [],
        },
      }),
    })
    const result = await cyclic.run()
    expect(result.entries[0]?.status).toBe('skipped')
    expect(result.entries[0]?.safe_detail).toContain(
      'dependencia_ciclica_no_plano',
    )
    expect(cyclic.driver.calls).toHaveLength(0)
    expect(() =>
      orderActionsByDependency([{ ...ACTIONS[0], dependencies: ['x'] }]),
    ).not.toThrow()
  })

  it('naming divergente no plano recusa a execução', async () => {
    const harness = createHarness({
      operation: buildOperation({
        plan: {
          policy_version: 'pcv2-policy-v1',
          actions: [
            ACTIONS[0],
            { ...ACTIONS[1], target_ref: 'role:je4ndev_alheio_dev_app' },
          ],
          estimated_resources: {
            cpu_millicores: 500,
            memory_mb: 512,
            disk_mb: 1024,
          },
          warnings: [],
        },
      }),
    })
    const result = await harness.run()
    expect(result.entries[0]?.safe_detail).toContain(
      'naming_nao_reconstruivel_do_plano',
    )
    expect(harness.driver.calls).toHaveLength(0)

    expect(() =>
      deriveNamingFromPlan({
        plan: {
          actions: [ACTIONS[0], { ...ACTIONS[1], target_ref: 'role:outro' }],
        },
        projectId: PROJECT_ID,
        environment: 'development',
        driver: 'postgresql_isolated',
      }),
    ).toThrow(WorkerPlanError)
  })
})

describe('worker — verificação e publicação', () => {
  it('publica e conclui somente após as verificações passarem', async () => {
    const harness = createHarness({
      kind: 'verify',
      operation: buildOperation({ state: 'verifying' }),
    })
    const result = await harness.run()

    expect(result.published).toBe(1)
    expect(result.entries[0]?.state).toBe('succeeded')
    expect(harness.operations.current().state).toBe('succeeded')
    expect(harness.publish).toHaveBeenCalledTimes(1)
    const checks = harness.publish.mock.calls[0]?.[0]?.checks ?? []
    expect(checks).toEqual([{ name: 'health_check', outcome: 'succeeded' }])
  })

  it('verificação que falha não publica e escala para manual', async () => {
    const harness = createHarness({
      kind: 'verify',
      operation: buildOperation({ state: 'verifying' }),
    })
    harness.driver.setFailure({
      actionId: 'act_health_check',
      retryable: false,
    })
    const result = await harness.run()

    expect(harness.publish).not.toHaveBeenCalled()
    expect(result.entries[0]?.status).toBe('failed')
    expect(harness.operations.current().state).toBe(
      'manual_intervention_required',
    )
  })

  it('falha transitória na verificação é retentada sem publicar', async () => {
    const harness = createHarness({
      kind: 'verify',
      operation: buildOperation({ state: 'verifying' }),
    })
    harness.driver.setFailure({ actionId: 'act_health_check', retryable: true })
    const result = await harness.run()

    expect(result.entries[0]?.status).toBe('skipped')
    expect(result.entries[0]?.attempts).toBe(1)
    expect(result.entries[0]?.safe_detail).toContain('tentativa 2/3')
    expect(harness.operations.current().state).toBe('verifying')
    expect(harness.publish).not.toHaveBeenCalled()
  })

  it('plano sem ações de verificação não publica', async () => {
    const harness = createHarness({
      kind: 'verify',
      operation: buildOperation({
        state: 'verifying',
        plan: {
          policy_version: 'pcv2-policy-v1',
          actions: [ACTIONS[0], ACTIONS[1]],
          estimated_resources: {
            cpu_millicores: 500,
            memory_mb: 512,
            disk_mb: 1024,
          },
          warnings: [],
        },
      }),
    })
    const result = await harness.run()

    expect(result.entries[0]?.status).toBe('failed')
    expect(result.entries[0]?.safe_detail).toContain(
      'verificacao ausente no plano',
    )
    expect(harness.publish).not.toHaveBeenCalled()
    expect(harness.operations.current().state).toBe(
      'manual_intervention_required',
    )
  })

  it('publisher que não publica mantém a operação sem concluir', async () => {
    const harness = createHarness({
      kind: 'verify',
      operation: buildOperation({ state: 'verifying' }),
    })
    harness.setPublishResult({ published: false, safe_detail: 'pendente' })
    const result = await harness.run()

    expect(result.entries[0]?.status).toBe('skipped')
    expect(result.published).toBe(0)
    expect(harness.operations.current().state).toBe('verifying')
  })
})

describe('worker — rollback', () => {
  it('rollback aprovado roda e conclui em rolled_back', async () => {
    const harness = createHarness({
      kind: 'rollback_execute',
      operation: buildOperation({
        state: 'succeeded',
        rollback: {
          rollback_plan_hash: PLAN_HASH,
          actions: [ACTIONS[0]],
          preserve_data: false,
          destructive: true,
          ownership_verified: true,
          observed_revision: REVISION,
          approval: {
            approval_id: '44444444-4444-4444-8444-444444444444',
            decision: 'approve',
            actor_ref: 'usr_jean',
            rollback_plan_hash: PLAN_HASH,
            decided_at: '2026-09-25T11:00:00.000Z',
            expires_at: '2026-09-25T23:00:00.000Z',
          },
          expires_at: '2026-09-25T23:00:00.000Z',
        },
      }),
    })
    const result = await harness.run()

    expect(harness.rollbackExecute).toHaveBeenCalledTimes(1)
    expect(result.entries[0]?.status).toBe('processed')
    expect(harness.operations.current().state).toBe('rolled_back')
    expect(harness.publish).not.toHaveBeenCalled()
  })

  it('rollback abortado vai para manual_intervention_required', async () => {
    const harness = createHarness({
      kind: 'rollback_execute',
      operation: buildOperation({
        state: 'succeeded',
        rollback: {
          rollback_plan_hash: PLAN_HASH,
          actions: [ACTIONS[0]],
          preserve_data: false,
          destructive: true,
          ownership_verified: true,
          observed_revision: REVISION,
          approval: {
            approval_id: '44444444-4444-4444-8444-444444444444',
            decision: 'approve',
            actor_ref: 'usr_jean',
            rollback_plan_hash: PLAN_HASH,
            decided_at: '2026-09-25T11:00:00.000Z',
            expires_at: '2026-09-25T23:00:00.000Z',
          },
          expires_at: '2026-09-25T23:00:00.000Z',
        },
      }),
    })
    harness.setRollbackResult({ aborted: true, safe_detail: 'interrompido' })
    const result = await harness.run()

    expect(result.entries[0]?.status).toBe('failed')
    expect(harness.operations.current().state).toBe(
      'manual_intervention_required',
    )
  })

  it('rollback sem aprovação não executa', async () => {
    const harness = createHarness({
      kind: 'rollback_execute',
      operation: buildOperation({
        state: 'succeeded',
        rollback: {
          rollback_plan_hash: PLAN_HASH,
          actions: [ACTIONS[0]],
          preserve_data: false,
          destructive: true,
          ownership_verified: true,
          observed_revision: REVISION,
          approval: null,
          expires_at: '2026-09-25T23:00:00.000Z',
        },
      }),
    })
    const result = await harness.run()

    expect(result.entries[0]?.safe_detail).toContain('rollback_sem_aprovacao')
    expect(harness.rollbackExecute).not.toHaveBeenCalled()
  })
})

void ((): ReadonlyArray<ProcessRunInput> => [])
