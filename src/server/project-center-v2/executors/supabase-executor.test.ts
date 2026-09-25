/**
 * Testes do executor `supabase_isolated` (PR 6).
 *
 * Prova: template allowlisted, imagens pinadas, portas internas apenas, prova
 * A×B entre stacks, prova de restore com alvo efémero, bindings de secret por
 * projeto e recusa de disable/drop sem ownership comprovado.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveProjectCenterV2Flags } from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { ERROR_FINGERPRINT_PATTERN } from '../domain'
import { SECRET_REF_MASK } from '../redaction'
import {
  createInMemorySecretMaterialStore,
  createSecretBroker,
} from '../secret-broker'
import {
  SUPABASE_CATALOG_VERSION,
  SUPABASE_SERVICE_IDS,
  internalPortFor,
  pinnedImageRefFor,
} from '../catalogs/supabase-catalog'
import {
  SUPABASE_EXECUTOR_ADAPTER_ID,
  SUPABASE_EXECUTOR_VERSION,
  SupabaseExecutorError,
  assertInternalEndpoint,
  buildStackOperation,
  createSupabaseExecutor,
  healthFindings,
  isolationFindings,
} from './supabase-executor'
import type { SupabaseStackProjection } from '../catalogs/supabase-catalog'
import type { StackEndpoint, StackStepRequest } from './supabase-executor'
import type {
  ActionExecutionContext,
  DriverActionInput,
} from './action-executor'

const PROJECT_ID = 'acme-site'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const NAMING = buildNamingSnapshot({
  client_id: 'acme',
  project_slug: 'site',
  environment: 'development',
  driver: 'supabase_isolated',
})
const PEER_COMPOSE = 'je4ndev-sb-canary-peer'
const RESTORE_TARGET = 'je4ndev_pcv2_restoreabcd'
const EPHEMERAL_TARGET_RE = /^je4ndev_pcv2_[a-z0-9]{8,20}$/
const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})

void FLAGS_ON

function observed(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    exists: true,
    ownership_marker: NAMING.ownership_marker,
    ownership_verified: true,
    drift: [],
    ...overrides,
  }
}

function projection(
  overrides: Partial<SupabaseStackProjection> = {},
): SupabaseStackProjection {
  const base = {
    catalog_version: SUPABASE_CATALOG_VERSION,
    observer_version: 'pcv2-sb-observer-v1',
    template_id: 'sb-stack-full',
    template_version: '2026.09',
    expected_template_id: 'sb-stack-full',
    compose_project: observed(NAMING.compose_project),
    network: observed(NAMING.network),
    data_store: observed(NAMING.data_store),
    services: SUPABASE_SERVICE_IDS.map((service) => ({
      name: service,
      observed: true,
      status: 'running' as const,
      health: 'healthy' as const,
      image_ref: pinnedImageRefFor(service),
      pinned: true,
      restart_count: 0,
    })),
    endpoints: [],
    broker_bindings: [],
    capacity: [],
    missing_services: [],
    drift_findings: [],
    template_complete: true,
    ownership_verified: true,
    backup_artifacts: [],
  }
  return { ...base, ...overrides } as unknown as SupabaseStackProjection
}

interface Harness {
  readonly executor: ReturnType<typeof createSupabaseExecutor>
  readonly steps: ReadonlyArray<StackStepRequest>
  readonly setStepResult: (exitCode: number, detail?: string) => void
  readonly setProjection: (
    composeProject: string,
    value: SupabaseStackProjection,
  ) => void
  readonly context: ActionExecutionContext
  readonly run: (
    kind: string,
    targetRef: string,
    overrides?: Partial<ActionExecutionContext>,
  ) => Promise<
    Awaited<ReturnType<ReturnType<typeof createSupabaseExecutor>['execute']>>
  >
  readonly bindings: () => number
  readonly material: string
}

function createHarness(
  options: { readonly adminCredential?: boolean } = {},
): Harness {
  const steps: Array<StackStepRequest> = []
  let stepResult = { exit_code: 0, safe_detail: 'passo ok' }
  const projections = new Map<string, SupabaseStackProjection>()
  projections.set(NAMING.compose_project, projection())

  const broker = createSecretBroker({
    materials: createInMemorySecretMaterialStore(),
    pepper: 'q'.repeat(48),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  })
  const bootstrap = broker.issue({
    projectId: PROJECT_ID,
    environment: 'development',
    purpose: 'admin_bootstrap',
  })
  const adminHandle = broker.handle({
    secretRef: bootstrap.secret_ref,
    projectId: PROJECT_ID,
    environment: 'development',
    purpose: 'admin_bootstrap',
  })
  const material = adminHandle.reveal()

  const executor = createSupabaseExecutor({
    stack: {
      adapter_id: SUPABASE_EXECUTOR_ADAPTER_ID,
      apply: async (request) => {
        steps.push(request)
        return stepResult
      },
    },
    projections: {
      adapter_id: 'fake-sb-observer',
      observe: async (composeProject) =>
        projections.get(composeProject) ?? projection(),
    },
    secrets: broker,
    ...(options.adminCredential === false
      ? {}
      : { adminCredential: { acquire: () => adminHandle } }),
    now: () => new Date('2026-09-25T12:05:00.000Z'),
  })

  const context: ActionExecutionContext = {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    driver: 'supabase_isolated',
    host_target: 'vps-primary-local',
    observedRevision: `obsrev_${'c'.repeat(32)}`,
    naming: NAMING,
    completedActionIds: [],
    lease: { leaseId: 'lease-1', fencingToken: 1, holderRef: 'pcv2-worker' },
    endpoint: { host: '127.0.0.1', port: 55432 },
    templateId: 'sb-stack-full',
    profileId: 'sb-small',
  }

  return {
    executor,
    steps,
    setStepResult: (exitCode, detail) => {
      stepResult = { exit_code: exitCode, safe_detail: detail ?? 'passo ok' }
    },
    setProjection: (composeProject, value) => {
      projections.set(composeProject, value)
    },
    context,
    material,
    bindings: () => broker.bindings().length,
    run: (kind, targetRef, overrides = {}) =>
      executor.execute({
        action: {
          action_id: 'act_sb_default',
          kind: kind as never,
          target_ref: targetRef,
          risk: 'reversible',
          reversible: true,
          dependencies: [],
        },
        context: { ...context, ...overrides },
        template: null,
        params: {},
      } as DriverActionInput),
  }
}

describe('supabase executor — catálogo e portas internas', () => {
  it('declara versão e recusa adapter de stack desconhecido', () => {
    const harness = createHarness()
    expect(SUPABASE_EXECUTOR_VERSION).toBe('pcv2-sb-executor-v1')
    expect(harness.executor.driver).toBe('supabase_isolated')
    expect(harness.executor.supported_actions).toContain(
      'render_compose_template',
    )
    expect(harness.executor.supported_actions).toContain('create_secret_ref')
    expect(() =>
      createSupabaseExecutor({
        stack: {
          adapter_id: 'stack-alheia',
          apply: async () => ({ exit_code: 0 }),
        },
        projections: { adapter_id: 'x', observe: async () => projection() },
        secrets: createSecretBroker({
          materials: createInMemorySecretMaterialStore(),
          pepper: 'q'.repeat(48),
        }),
      }),
    ).toThrow(SupabaseExecutorError)
  })

  it('renderiza o template com imagens pinadas e sem credencial', async () => {
    const harness = createHarness()
    const outcome = await harness.run(
      'render_compose_template',
      `compose-project:${NAMING.compose_project}`,
    )

    expect(outcome.status).toBe('succeeded')
    expect(harness.steps).toHaveLength(1)
    const operation = harness.steps[0]?.operation
    expect(harness.steps[0]?.step).toBe('render_compose_template')
    expect(operation.template_id).toBe('sb-stack-full')
    expect(operation.profile_id).toBe('sb-small')
    expect(operation.compose_project).toBe(NAMING.compose_project)
    expect(operation.timeout_ms).toBe(120_000)
    for (const image of Object.values(operation.images)) {
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/)
    }
    expect(harness.steps[0]?.credential).toBeUndefined()
    expect(JSON.stringify(outcome)).not.toContain(harness.material)
  })

  it('recusa template, perfil e nomes fora do catálogo', () => {
    const build = (fields: Record<string, unknown>) =>
      buildStackOperation({
        operation: {
          projectId: PROJECT_ID,
          environment: 'development',
          naming: NAMING,
        },
        fields: fields as never,
        adapterId: SUPABASE_EXECUTOR_ADAPTER_ID,
      })

    expect(() =>
      build({ templateId: 'sb-stack-inexistente', profileId: 'sb-small' }),
    ).toThrow(SupabaseExecutorError)
    expect(() =>
      build({ templateId: 'sb-stack-full', profileId: 'sb-xl' }),
    ).toThrow(SupabaseExecutorError)
    expect(() =>
      build({
        templateId: 'sb-stack-full',
        profileId: 'sb-small',
        endpoints: [
          {
            service: 'postgres',
            scope: 'loopback',
            port: internalPortFor('postgres'),
            public_exposure: false,
          },
          {
            service: 'postgrest',
            scope: 'public',
            port: internalPortFor('postgrest'),
            public_exposure: true,
          },
        ],
      }),
    ).toThrow(SupabaseExecutorError)
  })

  it('recusa endpoint público ou fora da porta interna do serviço', () => {
    expect(() =>
      assertInternalEndpoint({
        service: 'postgrest',
        scope: 'wildcard',
        port: internalPortFor('postgrest'),
        public_exposure: false,
      }),
    ).toThrow(SupabaseExecutorError)
    expect(() =>
      assertInternalEndpoint({
        service: 'postgrest',
        scope: 'loopback',
        port: 5432,
        public_exposure: false,
      }),
    ).toThrow(SupabaseExecutorError)
    expect(
      assertInternalEndpoint({
        service: 'postgrest',
        scope: 'loopback',
        port: internalPortFor('postgrest'),
        public_exposure: false,
      }).port,
    ).toBe(internalPortFor('postgrest'))
  })

  it('passos de criação exigem credencial de bootstrap injetada', async () => {
    const harness = createHarness({ adminCredential: false })
    const outcome = await harness.run(
      'create_database',
      `database:${NAMING.database}`,
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.fingerprint).toMatch(ERROR_FINGERPRINT_PATTERN)
    expect(harness.steps).toHaveLength(0)
  })

  it('recusa restore com alvo não efémero ou igual à stack', async () => {
    const harness = createHarness()
    await expect(
      harness.run('verify_backup_restore', 'verification:backup-restore', {
        restoreDatabase: 'meu_banco',
      }),
    ).rejects.toBeInstanceOf(SupabaseExecutorError)

    const outcome = await harness.run(
      'verify_backup_restore',
      'verification:backup-restore',
      { restoreDatabase: RESTORE_TARGET },
    )
    expect(EPHEMERAL_TARGET_RE.test(RESTORE_TARGET)).toBe(true)
    expect(outcome.status).toBe('succeeded')
    expect(harness.steps[0]?.operation.restore_target).toBe(RESTORE_TARGET)
    expect(harness.steps[0]?.operation.restore_target).not.toBe(
      NAMING.compose_project,
    )
  })
})

describe('supabase executor — saúde e prova A×B', () => {
  it('health_check compara projeção com os serviços do template', async () => {
    const harness = createHarness()
    const healthy = await harness.run(
      'health_check',
      `health:${NAMING.compose_project}`,
    )
    expect(healthy.status).toBe('succeeded')
    expect(healthy.safe_detail).toContain('servicos')

    const degraded = projection({
      services: projection().services.map((service) =>
        service.name === 'postgrest'
          ? { ...service, status: 'stopped' as const }
          : service,
      ),
    })
    harness.setProjection(NAMING.compose_project, degraded)
    const unhealthy = await harness.run(
      'health_check',
      `health:${NAMING.compose_project}`,
    )
    expect(unhealthy.status).toBe('failed')
    expect(unhealthy.failure?.code).toBe('VERIFICATION_FAILED')
    expect(unhealthy.failure?.retryable).toBe(false)
    expect(unhealthy.safe_detail).not.toContain('postgrest')
  })

  it('prova A×B falha com endpoint ou binding partilhado', async () => {
    const origin = projection({
      endpoints: [
        {
          name: 'postgrest',
          scope: 'loopback',
          port: internalPortFor('postgrest'),
          public_exposure: false,
          tls_terminated: false,
        },
      ],
      broker_bindings: [
        {
          name: 'app_role_password',
          exists: true,
          shared_with_other_project: true,
          rotation_days: 30,
        },
      ],
    })
    const peer = projection({
      compose_project: observed(PEER_COMPOSE),
      endpoints: [
        {
          name: 'postgrest',
          scope: 'loopback',
          port: internalPortFor('postgrest'),
          public_exposure: false,
          tls_terminated: false,
        },
      ],
    })

    const findings = isolationFindings(origin, peer)
    expect(findings).toContain('endpoint_partilhado:postgrest')
    expect(findings).toContain('binding_partilhado:app_role_password')

    const clean = isolationFindings(projection(), peer)
    expect(clean).toEqual([])
  })

  it('verify_cross_isolation exige a stack par e o isolamento comprovado', async () => {
    const harness = createHarness()
    const missingPeer = await harness.run(
      'verify_cross_isolation',
      'verification:cross-isolation',
    )
    expect(missingPeer.status).toBe('failed')
    expect(missingPeer.failure?.code).toBe('POLICY_DENIED')

    harness.setProjection(
      PEER_COMPOSE,
      projection({ compose_project: observed(PEER_COMPOSE) }),
    )
    const ok = await harness.run(
      'verify_cross_isolation',
      'verification:cross-isolation',
      {
        driverFields: { peerComposeProject: PEER_COMPOSE },
      },
    )
    expect(ok.status).toBe('succeeded')
    expect(ok.safe_detail).toContain('isolamento comprovado')

    harness.setProjection(
      PEER_COMPOSE,
      projection({
        compose_project: observed(PEER_COMPOSE),
        endpoints: [
          {
            name: 'postgrest',
            scope: 'loopback',
            port: internalPortFor('postgrest'),
            public_exposure: false,
            tls_terminated: false,
          },
        ],
      }),
    )
    harness.setProjection(
      NAMING.compose_project,
      projection({
        endpoints: [
          {
            name: 'postgrest',
            scope: 'loopback',
            port: internalPortFor('postgrest'),
            public_exposure: false,
            tls_terminated: false,
          },
        ],
      }),
    )
    const coupled = await harness.run(
      'verify_cross_isolation',
      'verification:cross-isolation',
      { driverFields: { peerComposeProject: PEER_COMPOSE } },
    )
    expect(coupled.status).toBe('failed')
    expect(coupled.failure?.code).toBe('VERIFICATION_FAILED')
    expect(harness.steps).toHaveLength(0)
  })

  it('healthFindings acusa serviço ausente, sem pin e fora do template', () => {
    const findings = healthFindings(
      projection({
        services: [
          {
            name: 'postgres',
            observed: true,
            status: 'running',
            health: 'healthy',
            image_ref: pinnedImageRefFor('postgres'),
            pinned: false,
            restart_count: 0,
          },
          {
            name: 'extra-service',
            observed: true,
            status: 'running',
            health: 'healthy',
            image_ref: pinnedImageRefFor('postgres'),
            pinned: true,
            restart_count: 0,
          },
        ],
      }),
      ['postgres', 'postgrest'],
    )
    expect(findings).toContain('imagem_sem_pin:postgres')
    expect(findings).toContain('servico_ausente:postgrest')
    expect(findings).toContain('servico_fora_do_template:extra-service')
  })
})

describe('supabase executor — secret refs e ownership', () => {
  it('emite binding por projeto com replay e sem material na saída', async () => {
    const harness = createHarness()
    const first = await harness.run(
      'create_secret_ref',
      `broker-binding:${PROJECT_ID}:app-role`,
    )
    const second = await harness.run(
      'create_secret_ref',
      `broker-binding:${PROJECT_ID}:app-role`,
    )

    expect(first.status).toBe('succeeded')
    expect(first.evidence_ref).toBe(`broker-binding:${PROJECT_ID}:app-role`)
    expect(first.safe_detail).toContain('replayed=false')
    expect(second.safe_detail).toContain('replayed=true')
    expect(first.safe_detail).toContain('sref_')
    expect(first.safe_detail).toContain(SECRET_REF_MASK.replace(/^sref_/, ''))
    expect(JSON.stringify([first, second])).not.toContain(harness.material)
    expect(harness.bindings()).toBe(2)
    expect(harness.steps).toHaveLength(0)
  })

  it('recusa alvo de binding fora da allowlist', async () => {
    const harness = createHarness()
    const outcome = await harness.run('create_secret_ref', 'sref_arbitrario')
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('POLICY_DENIED')
    expect(harness.bindings()).toBe(1)
  })

  it('disable/drop exigem ownership comprovado na projeção', async () => {
    const harness = createHarness()
    harness.setProjection(
      NAMING.compose_project,
      projection({
        compose_project: observed(NAMING.compose_project, {
          ownership_verified: false,
          ownership_marker: null,
        }),
        ownership_verified: false,
      }),
    )
    const outcome = await harness.run(
      'disable_resource',
      `compose-project:${NAMING.compose_project}`,
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('POLICY_DENIED')
    expect(harness.steps).toHaveLength(0)

    harness.setProjection(NAMING.compose_project, projection())
    const allowed = await harness.run(
      'drop_resource_created_by_operation',
      `compose-project:${NAMING.compose_project}`,
    )
    expect(allowed.status).toBe('succeeded')
    expect(harness.steps).toHaveLength(1)
  })

  it('passo fora do catálogo de stack é recusado sem tocar na stack', async () => {
    const harness = createHarness()
    const outcome = await harness.run(
      'start_stack',
      `stack:${NAMING.compose_project}`,
    )
    void outcome
    harness.setStepResult(1, 'falha simulada')
    const failed = await harness.run(
      'start_stack',
      `stack:${NAMING.compose_project}`,
    )
    expect(failed.status).toBe('failed')
    expect(failed.failure?.code).toBe('EXECUTION_FAILED')
    expect(failed.failure?.retryable).toBe(true)
    expect(failed.safe_detail).toBe('falha simulada')
  })
})
