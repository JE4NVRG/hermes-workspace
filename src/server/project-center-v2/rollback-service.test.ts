/**
 * Testes do serviço de rollback (PR 6).
 *
 * Prova: só se reverte o que a operação criou; recurso preexistente/estrangeiro
 * vai para intervenção manual; drift e revisão divergente bloqueiam; produção
 * exige aprovação de rollback válida; ordem é disable antes de drop; a primeira
 * falha interrompe o rollback (sem apagar às cegas).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { buildNamingSnapshot } from './naming'
import { createInMemoryLeaseStore } from './lease-store'
import {
  ROLLBACK_EXECUTABLE_KINDS,
  ROLLBACK_SERVICE_VERSION,
  RollbackServiceError,
  assertRollbackActionShape,
  createRollbackService,
  isDisableFirstTarget,
  orderRollbackActions,
} from './rollback-service'
import {
  assertFixedArgv,
  createActionExecutor,
  renderActionTemplate,
} from './executors/action-executor'
import type { OwnedResource, RollbackObservationPort } from './rollback-service'
import type {
  ActionTemplate,
  DriverActionInput,
  DriverExecutor,
  ProcessRunInput,
} from './executors/action-executor'
import type { Operation, PlannedAction, RollbackPlan } from './domain'
import type { RollbackObservation } from './approval-service'

const PROJECT_ID = 'acme-site'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_OPERATION = '22222222-2222-4222-8222-222222222222'
const HOLDER = 'pcv2-worker'
const PLAN_HASH = 'a'.repeat(64)
const OBSERVED_REVISION = `obsrev_${'c'.repeat(32)}`
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

const DATABASE_TARGET = `database:${NAMING.database}`
const ROLE_TARGET = `role:${NAMING.app_role}`
const STACK_TARGET = `stack:${NAMING.compose_project}`

function buildOperation(
  overrides: Partial<{ environment: Operation['environment'] }> = {},
): Operation {
  return {
    operation_id: OPERATION_ID,
    project_id: PROJECT_ID,
    driver: 'postgresql_isolated',
    environment: overrides.environment ?? 'development',
    state: 'succeeded',
    operation_version: 1,
    plan_hash: PLAN_HASH,
    plan: {
      policy_version: 'pcv2-policy-v1',
      actions: [],
      estimated_resources: { cpu: 1, memory_mb: 256, disk_mb: 1024 },
      warnings: [],
    },
    created_at: '2026-09-25T12:00:00.000Z',
    updated_at: '2026-09-25T12:00:00.000Z',
    expires_at: '2026-09-25T13:00:00.000Z',
    status_url: '/api/x',
    audit_url: '/api/y',
  } as unknown as Operation
}

function buildAction(overrides: Partial<PlannedAction>): PlannedAction {
  return {
    action_id: 'act_rb_drop_database',
    kind: 'drop_resource_created_by_operation',
    target_ref: DATABASE_TARGET,
    risk: 'destructive',
    reversible: false,
    dependencies: [],
    ...overrides,
  }
}

function buildRollbackPlan(input: {
  readonly actions: ReadonlyArray<PlannedAction>
  readonly observedRevision?: string
  readonly approval?: RollbackPlan['approval']
  readonly ownershipVerified?: boolean
}): RollbackPlan {
  return {
    rollback_plan_hash: PLAN_HASH,
    actions: input.actions,
    preserve_data: false,
    destructive: true,
    ownership_verified: input.ownershipVerified ?? true,
    observed_revision: input.observedRevision ?? OBSERVED_REVISION,
    approval: input.approval === undefined ? null : input.approval,
    expires_at: '2026-09-25T13:00:00.000Z',
  } as unknown as RollbackPlan
}

function buildObservation(
  overrides: Partial<RollbackObservation> = {},
): RollbackObservation {
  return {
    actions: [],
    observed_revision: OBSERVED_REVISION,
    ownership_verified: true,
    drift_findings: [],
    ...overrides,
  }
}

function ownedResource(overrides: Partial<OwnedResource> = {}): OwnedResource {
  return {
    target_ref: DATABASE_TARGET,
    resource_name: NAMING.database,
    project_id: PROJECT_ID,
    environment: 'development',
    driver: 'postgresql_isolated',
    ownership_marker: NAMING.ownership_marker,
    created_by_operation_id: OPERATION_ID,
    exists: true,
    ...overrides,
  }
}

interface ExecutorHarness {
  readonly driver: DriverExecutor
  readonly calls: ReadonlyArray<DriverActionInput>
  readonly argvs: ReadonlyArray<ReadonlyArray<string>>
  readonly setFailTarget: (targetRef: string | null) => void
}

function createFakeDriverExecutor(): ExecutorHarness {
  const calls: Array<DriverActionInput> = []
  const argvs: Array<ReadonlyArray<string>> = []
  let failTarget: string | null = null
  return {
    calls,
    argvs,
    setFailTarget: (targetRef) => {
      failTarget = targetRef
    },
    driver: {
      driver: 'postgresql_isolated',
      adapter_id: 'fake-postgres-adapter',
      executor_version: 'pcv2-pg-executor-v1',
      supported_actions: ROLLBACK_EXECUTABLE_KINDS,
      execute: async (input: DriverActionInput) => {
        calls.push(input)
        const template = input.template as ActionTemplate
        const argv = renderActionTemplate(template, input.params)
        assertFixedArgv({ binary: template.binary, argv })
        argvs.push(argv)
        if (input.action.target_ref === failTarget) {
          return {
            status: 'failed',
            safe_detail: 'adapter falhou',
            failure: {
              code: 'EXECUTION_FAILED',
              message: 'falha simulada',
              retryable: false,
              fingerprint: `err_${'d'.repeat(16)}`,
            },
          }
        }
        return { status: 'succeeded', safe_detail: 'ok' }
      },
    },
  }
}

interface Harness {
  readonly service: ReturnType<typeof createRollbackService>
  readonly observe: ReturnType<typeof vi.fn>
  readonly driver: ExecutorHarness
  readonly lease: { leaseId: string; fencingToken: number; holderRef: string }
  readonly leases: ReturnType<typeof createInMemoryLeaseStore>
  readonly execute: (
    plan: ReturnType<ReturnType<typeof createRollbackService>['planExecution']>,
    overrides?: Partial<{ environment: Operation['environment'] }>,
  ) => Promise<
    Awaited<ReturnType<ReturnType<typeof createRollbackService>['execute']>>
  >
}

function createHarness(
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly resources?: ReadonlyArray<OwnedResource>
    readonly observedRevision?: string
    readonly driftFindings?: ReadonlyArray<string>
  } = {},
): Harness {
  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '44444444-4444-4444-8444-444444444444',
  })
  const grant = leases.acquire({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    holderRef: HOLDER,
  })
  const observe = vi.fn(async () => ({
    resources: options.resources ?? [ownedResource()],
    observed_revision: options.observedRevision ?? OBSERVED_REVISION,
    drift_findings: options.driftFindings ?? [],
  }))
  const observations: RollbackObservationPort = {
    adapter_id: 'fake-observation',
    observe,
  }
  const driver = createFakeDriverExecutor()
  const actions = createActionExecutor({
    flags: options.flags ?? FLAGS_ON,
    leases,
    drivers: { postgresql_isolated: driver.driver },
  })
  const service = createRollbackService({
    flags: options.flags ?? FLAGS_ON,
    leases,
    observations,
    actions,
    now: () => new Date('2026-09-25T12:30:00.000Z'),
  })
  const lease = {
    leaseId: grant.lease_id,
    fencingToken: grant.fencing_token,
    holderRef: HOLDER,
  }

  return {
    service,
    observe,
    driver,
    leases,
    lease,
    execute: (plan, overrides = {}) =>
      service.execute({
        operation: buildOperation(overrides),
        rollbackPlan: buildRollbackPlan({ actions: plan.executable }),
        plan,
        environment: overrides.environment ?? 'development',
        driver: 'postgresql_isolated',
        host_target: 'vps-primary-local',
        observedRevision: options.observedRevision ?? OBSERVED_REVISION,
        naming: NAMING,
        lease,
        endpoint: { host: '127.0.0.1', port: 55432 },
      }),
  }
}

describe('rollback service — observação e ownership', () => {
  it('marca como revertível apenas o que a operação criou', async () => {
    const harness = createHarness({
      resources: [
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
        ownedResource({ target_ref: DATABASE_TARGET }),
        ownedResource({
          target_ref: ROLE_TARGET,
          resource_name: NAMING.app_role,
        }),
      ],
    })
    const observation = await harness.service.planning.observe(
      buildOperation(),
      {
        preserveData: false,
      },
    )

    expect(observation.ownership_verified).toBe(true)
    expect(observation.drift_findings).toEqual([])
    expect(observation.actions).toHaveLength(3)
    expect(
      observation.actions.find((action) => action.target_ref === STACK_TARGET)
        ?.kind,
    ).toBe('disable_resource')
    expect(
      observation.actions.find(
        (action) => action.target_ref === DATABASE_TARGET,
      )?.kind,
    ).toBe('drop_resource_created_by_operation')
    expect(ROLLBACK_SERVICE_VERSION).toBe('pcv2-rollback-v1')
  })

  it('recurso preexistente ou de outra operação impede o ownership', async () => {
    const harness = createHarness({
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: ROLE_TARGET,
          resource_name: NAMING.app_role,
          created_by_operation_id: null,
        }),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
          created_by_operation_id: OTHER_OPERATION,
        }),
      ],
    })
    const observation = await harness.service.planning.observe(
      buildOperation(),
      {
        preserveData: false,
      },
    )

    expect(observation.ownership_verified).toBe(false)
    expect(observation.drift_findings.length).toBeGreaterThanOrEqual(2)
    expect(observation.actions.map((action) => action.target_ref)).toEqual([
      DATABASE_TARGET,
    ])
  })

  it('com flags desligadas a observação de rollback não corre', async () => {
    const harness = createHarness({ flags: FLAGS_OFF })
    await expect(
      harness.service.planning.observe(buildOperation(), {
        preserveData: false,
      }),
    ).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(harness.observe).not.toHaveBeenCalled()
  })
})

describe('rollback service — planejamento de execução', () => {
  it('ordena disable antes de drop e mantém só ações do plano', () => {
    const plan = buildRollbackPlan({
      actions: [
        buildAction({
          action_id: 'act_rb_drop_database',
          target_ref: DATABASE_TARGET,
        }),
        buildAction({
          action_id: 'act_rb_disable_stack',
          kind: 'disable_resource',
          target_ref: STACK_TARGET,
        }),
      ],
    })
    const harness = createHarness({
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })
    const execution = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: plan,
      observation: buildObservation(),
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })

    expect(execution.executable.map((action) => action.kind)).toEqual([
      'disable_resource',
      'drop_resource_created_by_operation',
    ])
    expect(execution.requires_manual_intervention).toBe(false)
    expect(execution.safe_detail).toBe(
      'rollback planejado: executar=2 pulado=0 manual=0',
    )
    expect(
      orderRollbackActions([
        buildAction({ action_id: 'act_rb_drop_role', target_ref: ROLE_TARGET }),
        buildAction({
          action_id: 'act_rb_disable_net',
          kind: 'disable_resource',
          target_ref: `network:${NAMING.network}`,
        }),
      ]).map((action) => action.target_ref),
    ).toEqual([`network:${NAMING.network}`, ROLE_TARGET])
    expect(isDisableFirstTarget(`data-store:${NAMING.data_store}`)).toBe(true)
    expect(isDisableFirstTarget(DATABASE_TARGET)).toBe(false)
  })

  it('recurso já inexistente é pulado e preexistente vai para manual', () => {
    const harness = createHarness()
    const plan = buildRollbackPlan({
      actions: [
        buildAction({
          action_id: 'act_rb_drop_database',
          target_ref: DATABASE_TARGET,
        }),
        buildAction({ action_id: 'act_rb_drop_role', target_ref: ROLE_TARGET }),
      ],
    })
    const execution = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: plan,
      observation: buildObservation(),
      resources: [
        ownedResource({ target_ref: DATABASE_TARGET, exists: false }),
        ownedResource({
          target_ref: ROLE_TARGET,
          resource_name: NAMING.app_role,
          created_by_operation_id: null,
        }),
      ],
    })

    expect(execution.executable).toHaveLength(0)
    expect(execution.skipped).toEqual([
      { target_ref: DATABASE_TARGET, reason: 'already_gone' },
    ])
    expect(execution.manual).toEqual([
      { target_ref: ROLE_TARGET, reason: 'preexistente_ou_sem_marker' },
    ])
    expect(execution.requires_manual_intervention).toBe(true)
  })

  it('ownership de outra operação e marker ausente vão para manual', () => {
    const plan = buildRollbackPlan({
      actions: [
        buildAction({
          action_id: 'act_rb_drop_database',
          target_ref: DATABASE_TARGET,
        }),
        buildAction({ action_id: 'act_rb_drop_role', target_ref: ROLE_TARGET }),
      ],
    })
    const execution = createHarness().service.planExecution({
      operation: buildOperation(),
      rollbackPlan: plan,
      observation: buildObservation(),
      resources: [
        ownedResource({ created_by_operation_id: OTHER_OPERATION }),
        ownedResource({
          target_ref: ROLE_TARGET,
          resource_name: NAMING.app_role,
          ownership_marker: null,
        }),
      ],
    })

    expect(execution.manual).toEqual([
      { target_ref: DATABASE_TARGET, reason: 'ownership_de_outra_operacao' },
      { target_ref: ROLE_TARGET, reason: 'ownership_divergente' },
    ])
    expect(execution.executable).toHaveLength(0)
  })

  it('drift de revisão e drift de observação bloqueiam o planejamento', () => {
    const service = createHarness().service
    const plan = buildRollbackPlan({
      actions: [buildAction({ action_id: 'act_rb_drop_database' })],
    })
    expect(() =>
      service.planExecution({
        operation: buildOperation(),
        rollbackPlan: plan,
        observation: buildObservation({
          observed_revision: `obsrev_${'e'.repeat(32)}`,
        }),
        resources: [ownedResource()],
      }),
    ).toThrow(RollbackServiceError)

    expect(() =>
      service.planExecution({
        operation: buildOperation(),
        rollbackPlan: plan,
        observation: buildObservation({ drift_findings: ['drift'] }),
        resources: [ownedResource()],
      }),
    ).toThrow(RollbackServiceError)
  })

  it('plano sem ownership comprovado é recusado como não seguro', () => {
    const service = createHarness().service
    expect(() =>
      service.planExecution({
        operation: buildOperation(),
        rollbackPlan: buildRollbackPlan({
          actions: [buildAction({ action_id: 'act_rb_drop_database' })],
          ownershipVerified: false,
        }),
        observation: buildObservation(),
        resources: [ownedResource()],
      }),
    ).toThrow(RollbackServiceError)
  })

  it('produção exige aprovação de rollback válida e não expirada', () => {
    const service = createHarness().service
    const action = buildAction({ action_id: 'act_rb_drop_database' })
    const production = buildOperation({ environment: 'production' })

    expect(() =>
      service.planExecution({
        operation: production,
        rollbackPlan: buildRollbackPlan({ actions: [action] }),
        observation: buildObservation(),
        resources: [ownedResource({ environment: 'production' })],
      }),
    ).toThrow(RollbackServiceError)

    expect(() =>
      service.planExecution({
        operation: production,
        rollbackPlan: buildRollbackPlan({
          actions: [action],
          approval: {
            approval_id: '55555555-5555-4555-8555-555555555555',
            decision: 'approve',
            actor_ref: 'usr_jean',
            rollback_plan_hash: PLAN_HASH,
            decided_at: '2026-09-25T10:00:00.000Z',
            expires_at: '2026-09-25T11:00:00.000Z',
          },
        }),
        observation: buildObservation(),
        resources: [ownedResource({ environment: 'production' })],
      }),
    ).toThrow(RollbackServiceError)

    const approved = service.planExecution({
      operation: production,
      rollbackPlan: buildRollbackPlan({
        actions: [action],
        approval: {
          approval_id: '55555555-5555-4555-8555-555555555555',
          decision: 'approve',
          actor_ref: 'usr_jean',
          rollback_plan_hash: PLAN_HASH,
          decided_at: '2026-09-25T12:00:00.000Z',
          expires_at: '2026-09-25T13:00:00.000Z',
        },
      }),
      observation: buildObservation(),
      resources: [ownedResource({ environment: 'production' })],
    })
    expect(approved.executable).toHaveLength(1)
  })

  it('recusa alvo curinga, global ou kind não reversível', () => {
    expect(() =>
      assertRollbackActionShape(buildAction({ target_ref: 'database:*' })),
    ).toThrow(RollbackServiceError)
    expect(() =>
      assertRollbackActionShape(
        buildAction({ target_ref: 'database:postgres' }),
      ),
    ).toThrow(RollbackServiceError)
    expect(() =>
      assertRollbackActionShape(
        buildAction({ kind: 'start_stack', target_ref: STACK_TARGET }),
      ),
    ).toThrow(RollbackServiceError)

    const service = createHarness().service
    expect(() =>
      service.planExecution({
        operation: buildOperation(),
        rollbackPlan: buildRollbackPlan({
          actions: [
            buildAction({
              action_id: 'act_rb_start_stack',
              kind: 'start_stack',
              target_ref: STACK_TARGET,
            }),
          ],
        }),
        observation: buildObservation(),
        resources: [ownedResource()],
      }),
    ).toThrow(RollbackServiceError)
  })
})

describe('rollback service — execução', () => {
  function buildPlanWithBothActions(): RollbackPlan {
    return buildRollbackPlan({
      actions: [
        buildAction({
          action_id: 'act_rb_drop_database',
          target_ref: DATABASE_TARGET,
        }),
        buildAction({
          action_id: 'act_rb_disable_stack',
          kind: 'disable_resource',
          target_ref: STACK_TARGET,
        }),
      ],
    })
  }

  it('executa as ações na ordem do plano e devolve o resultado', async () => {
    const harness = createHarness({
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })
    const plan = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: buildPlanWithBothActions(),
      observation: buildObservation(),
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })
    const result = await harness.execute(plan)

    expect(result.aborted).toBe(false)
    expect(result.failed_action_id).toBeNull()
    expect(result.completed).toHaveLength(2)
    expect(harness.driver.calls.map((call) => call.action.kind)).toEqual([
      'disable_resource',
      'drop_resource_created_by_operation',
    ])
    expect(harness.driver.argvs[0]?.[0]).toBe('psql')
  })

  it('interrompe o rollback na primeira falha, sem continuar a apagar', async () => {
    const harness = createHarness({
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })
    const plan = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: buildPlanWithBothActions(),
      observation: buildObservation(),
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: STACK_TARGET,
          resource_name: NAMING.compose_project,
        }),
      ],
    })
    harness.driver.setFailTarget(STACK_TARGET)
    const result = await harness.execute(plan)

    expect(result.aborted).toBe(true)
    expect(result.failed_action_id).toBe('act_rb_disable_stack')
    expect(harness.driver.calls).toHaveLength(1)
  })

  it('não executa nada quando há recurso sem ownership comprovado', async () => {
    const harness = createHarness()
    const plan = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: buildRollbackPlan({
        actions: [
          buildAction({
            action_id: 'act_rb_drop_database',
            target_ref: DATABASE_TARGET,
          }),
          buildAction({
            action_id: 'act_rb_drop_role',
            target_ref: ROLE_TARGET,
          }),
        ],
      }),
      observation: buildObservation(),
      resources: [
        ownedResource(),
        ownedResource({
          target_ref: ROLE_TARGET,
          resource_name: NAMING.app_role,
          ownership_marker: null,
        }),
      ],
    })

    await expect(harness.execute(plan)).rejects.toBeInstanceOf(
      RollbackServiceError,
    )
    expect(harness.driver.calls).toHaveLength(0)
  })

  it('rollback sem ações executáveis devolve resultado vazio', async () => {
    const harness = createHarness()
    const plan = harness.service.planExecution({
      operation: buildOperation(),
      rollbackPlan: buildRollbackPlan({
        actions: [
          buildAction({
            action_id: 'act_rb_drop_database',
            target_ref: DATABASE_TARGET,
          }),
        ],
      }),
      observation: buildObservation(),
      resources: [ownedResource({ exists: false })],
    })
    const result = await harness.execute(plan)

    expect(result.aborted).toBe(false)
    expect(result.completed).toHaveLength(0)
    expect(harness.driver.calls).toHaveLength(0)
  })

  it('com flags desligadas a execução do rollback é recusada', async () => {
    const harness = createHarness({ flags: FLAGS_OFF })
    const plan = {
      executable: [buildAction({ action_id: 'act_rb_drop_database' })],
      skipped: [],
      manual: [],
      requires_manual_intervention: false,
      safe_detail: 'x',
    }
    await expect(harness.execute(plan)).rejects.toBeInstanceOf(
      FeatureDisabledError,
    )
    expect(harness.driver.calls).toHaveLength(0)
  })
})

void ((): ReadonlyArray<ProcessRunInput> => [])
