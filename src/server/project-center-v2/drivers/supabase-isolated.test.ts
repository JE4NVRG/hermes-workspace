/**
 * Testes do driver `supabase_isolated` em dry-run (PR 3).
 *
 * Provam o que o elo 3 promete: stack planejada só com template/imagem/digest/
 * porta/target do catálogo; entrada livre (hostname, path, rede, porta, volume,
 * imagem, template, comando) recusada antes de qualquer ação; defesa de dry-run
 * — nenhum adapter de execução é chamado mesmo quando injetado por engano;
 * cada recurso carrega o ownership marker esperado; e `schema_shared` continua
 * não sendo driver selecionável. O último bloco é o guarda de arquitetura dos
 * módulos do PR 3.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SUPABASE_RESOURCE_PROFILES,
  SUPABASE_SERVICE_IDS,
  SUPABASE_TEMPLATES,
  TARGET_REF_MAX_LENGTH,
  emptyStackProjection,
  pinnedImageRefFor,
  supabaseStackProjectionSchema,
} from '../catalogs/supabase-catalog'
import { PLANNED_ACTION_KINDS, planSchema } from '../domain'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { DEFAULT_POLICY_SNAPSHOT, buildPolicySnapshot } from '../planner'
import { POLICY_VERSION } from '../policy'
import { redactValue } from '../redaction'
import {
  DriverUnavailableError,
  assertPlannedActionShape,
  observedStateSchema,
} from './types'
import {
  SUPABASE_ACTION_KINDS,
  SUPABASE_BROKER_SLOTS,
  SUPABASE_DRIVER_ID,
  SUPABASE_DRIVER_REGISTRY,
  SUPABASE_DRIVER_VERSION,
  SupabasePolicyRejectionError,
  planSupabaseActions,
  selectSupabaseDriver,
  supabaseDriverDescriptor,
  supabaseIsolatedDriver,
  validateSupabaseIntent,
} from './supabase-isolated'
import type {
  SupabaseStackProjection,
  SupabaseTemplate,
} from '../catalogs/supabase-catalog'
import type { PlannedAction, PlannedActionKind, ProjectIntent } from '../domain'
import type {
  SupabaseDriverPlan,
  SupabasePlanRequest,
} from './supabase-isolated'
import type { ObservedState } from './types'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
  driver: SUPABASE_DRIVER_ID,
  environment: 'development',
  host_target: 'vps-primary-local',
  capabilities: {
    auth: true,
    storage: true,
    realtime: true,
    postgrest: true,
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
const FLAGS_OFF = resolveProjectCenterV2Flags({})

const OBSERVED_AT = '2026-09-25T12:00:00.000Z'

function makeObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return observedStateSchema.parse({
    driver: SUPABASE_DRIVER_ID,
    driver_version: SUPABASE_DRIVER_VERSION,
    observer_version: 'pcv2-sb-observer-v1',
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
    ...overrides,
  })
}

/** Projeção de uma stack saudável: tudo existe, com marker e imagem pinada. */
function healthyStack(
  overrides: Partial<SupabaseStackProjection> = {},
): SupabaseStackProjection {
  const resource = (name: string) => ({
    name,
    exists: true,
    ownership_marker: NAMING.ownership_marker,
    ownership_verified: true,
    drift: [],
  })
  const services = SUPABASE_SERVICE_IDS.map((service) => ({
    name: service,
    observed: true,
    status: 'running' as const,
    health: 'healthy' as const,
    image_ref: pinnedImageRefFor(service),
    pinned: true,
    restart_count: 0,
  }))
  return supabaseStackProjectionSchema.parse({
    catalog_version: 'pcv2-supabase-catalog-v1',
    observer_version: 'pcv2-sb-observer-v1',
    template_id: SUPABASE_TEMPLATES[0].template_id,
    template_version: SUPABASE_TEMPLATES[0].version,
    expected_template_id: SUPABASE_TEMPLATES[0].template_id,
    compose_project: resource(NAMING.compose_project),
    network: resource(NAMING.network),
    data_store: resource(NAMING.data_store),
    services,
    endpoints: [
      {
        name: 'api',
        scope: 'loopback',
        port: 54321,
        public_exposure: false,
        tls_terminated: false,
      },
    ],
    broker_bindings: SUPABASE_BROKER_SLOTS.map((slot) => ({
      name: `${NAMING.compose_project}:${slot}`,
      exists: true,
      shared_with_other_project: false,
      rotation_days: 30,
    })),
    capacity: SUPABASE_SERVICE_IDS.map((service) => ({
      name: service,
      cpu_millicores: 100,
      memory_mb: 128,
      disk_mb: 128,
    })),
    missing_services: [],
    drift_findings: [],
    template_complete: true,
    ownership_verified: true,
    backup_artifacts: [],
    ...overrides,
  })
}

/** Stack provisionada: estado canônico coerente com o que o observer leria. */
function provisionedObserved(): ObservedState {
  return makeObserved({
    ownership_verified: true,
    database: {
      name: NAMING.database,
      exists: true,
      owner_role: null,
      ownership_marker: NAMING.ownership_marker,
      size_mb: 1024,
      is_template: false,
    },
    app_role: {
      name: NAMING.app_role,
      exists: true,
      can_login: true,
      is_superuser: false,
      can_create_db: false,
      can_create_role: false,
      can_replicate: false,
      bypass_rls: false,
      memberships: [],
    },
    privileges: [
      {
        schema_name: 'public',
        role_name: NAMING.app_role,
        privilege: 'USAGE',
        grantable: false,
      },
    ],
    endpoint_masked: '127.0.0.1:54321',
  })
}

function planWith(
  input: Partial<SupabasePlanRequest> = {},
): SupabaseDriverPlan {
  return planSupabaseActions({
    intent: INTENT,
    observed: makeObserved(),
    policy: DEFAULT_POLICY_SNAPSHOT,
    flags: FLAGS_ON,
    ...input,
  })
}

const EXPECTED_KINDS: ReadonlyArray<PlannedActionKind> = [
  'reserve_project',
  'render_compose_template',
  'create_network',
  'create_data_store',
  'create_database',
  'create_app_role',
  'apply_least_privilege',
  'create_secret_ref',
  'create_secret_ref',
  'create_secret_ref',
  'create_secret_ref',
  'start_stack',
  'health_check',
  'verify_cross_isolation',
  'configure_backup',
  'configure_r2_prefix',
  'verify_backup_restore',
  'publish_registry',
  'publish_platform_context',
]

describe('descriptor e seleção do driver', () => {
  it('declara o driver/versão e apenas kinds do contrato', () => {
    expect(supabaseDriverDescriptor.id).toBe('supabase_isolated')
    expect(supabaseDriverDescriptor.version).toBe(SUPABASE_DRIVER_VERSION)
    expect(supabaseDriverDescriptor.actions).toEqual(SUPABASE_ACTION_KINDS)
    expect(supabaseDriverDescriptor.provided_capabilities).toEqual([
      'auth',
      'storage',
      'realtime',
      'postgrest',
      'backup',
    ])
    for (const kind of supabaseDriverDescriptor.actions) {
      expect(PLANNED_ACTION_KINDS).toContain(kind)
    }
  })

  it('não expõe observação nem execução', () => {
    expect(Object.keys(supabaseIsolatedDriver).sort()).toEqual([
      'descriptor',
      'plan',
      'sanitize',
      'validate',
    ])
    for (const forbidden of [
      'execute',
      'compensate',
      'observe',
      'run',
      'apply',
      'provision',
      'container',
      'docker',
    ]) {
      expect(forbidden in supabaseIsolatedDriver).toBe(false)
    }
  })

  it('schema_shared falha como driver não selecionável', () => {
    expect(selectSupabaseDriver('supabase_isolated')).toBe(
      supabaseIsolatedDriver,
    )
    for (const name of [
      'schema_shared',
      'postgresql_isolated',
      undefined,
      42,
    ]) {
      expect(() => selectSupabaseDriver(name)).toThrow(DriverUnavailableError)
    }
    expect(Object.keys(SUPABASE_DRIVER_REGISTRY)).toEqual([SUPABASE_DRIVER_ID])
  })
})

describe('validação da intenção', () => {
  it('aceita a intenção de stack completa', () => {
    const result = validateSupabaseIntent(INTENT, DEFAULT_POLICY_SNAPSHOT)
    expect(result.ok).toBe(true)
    expect(result.ok && result.warnings.join(' ')).toContain(
      'sb-stack-full@2026.09',
    )
  })

  it('avisa que produção exige aprovação humana', () => {
    const result = validateSupabaseIntent(
      { ...INTENT, environment: 'production' },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(result.ok && result.warnings.join(' ')).toContain(
      'aprovacao humana segregada',
    )
  })

  it('recusa capability fora da política (capacidade não suportada)', () => {
    const policy = buildPolicySnapshot({ allowed_capabilities: ['backup'] })
    const result = validateSupabaseIntent(INTENT, policy)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('POLICY_DENIED')
    expect(
      result.ok === false &&
        result.issues.some(
          (issue) => issue.reason === 'capability_not_allowed',
        ),
    ).toBe(true)
    // O planejamento fecha fechado com o mesmo motivo.
    try {
      planWith({ policy })
      throw new Error('deveria ter recusado')
    } catch (error) {
      expect(error).toBeInstanceOf(SupabasePolicyRejectionError)
      expect((error as SupabasePolicyRejectionError).code).toBe('POLICY_DENIED')
      expect(
        (error as SupabasePolicyRejectionError).issues.some(
          (issue) => issue.reason === 'capability_not_allowed',
        ),
      ).toBe(true)
    }
  })

  it('recusa capability que o template não entrega', () => {
    const restrito: SupabaseTemplate = {
      template_id: 'sb-stack-full',
      version: '2026.09',
      capabilities: ['backup'],
      services: ['postgres', 'gateway'],
    }
    const result = validateSupabaseIntent(INTENT, DEFAULT_POLICY_SNAPSHOT, [
      restrito,
    ])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('DRIVER_UNAVAILABLE')
    expect(
      result.ok === false &&
        result.issues.some(
          (issue) => issue.reason === 'capability_not_provided',
        ),
    ).toBe(true)
  })

  it('recusa driver, host e ambiente fora da allowlist', () => {
    const wrongDriver = validateSupabaseIntent(
      { ...INTENT, driver: 'postgresql_isolated' },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(wrongDriver.ok === false && wrongDriver.code).toBe(
      'DRIVER_UNAVAILABLE',
    )
    const wrongHost = validateSupabaseIntent(
      INTENT,
      buildPolicySnapshot({ allowed_host_targets: ['outro-host'] }),
    )
    expect(wrongHost.ok === false && wrongHost.code).toBe('POLICY_DENIED')
    const wrongEnvironment = validateSupabaseIntent(
      INTENT,
      buildPolicySnapshot({ allowed_environments: ['production'] }),
    )
    expect(wrongEnvironment.ok === false && wrongEnvironment.code).toBe(
      'POLICY_DENIED',
    )
  })

  it('recusa limites acima do maior perfil e abaixo do mínimo do perfil', () => {
    const above = validateSupabaseIntent(
      { ...INTENT, requested_limits: { memory_mb: 16385 } },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(above.ok === false && above.code).toBe('QUOTA_EXCEEDED')

    const below = validateSupabaseIntent(
      { ...INTENT, requested_limits: { cpu_millicores: 100 } },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(below.ok === false && below.code).toBe('INVALID_REQUEST')
    expect(
      below.ok === false &&
        below.issues.some((issue) => issue.reason === 'limit_below_minimum'),
    ).toBe(true)
  })
})

describe('entrada livre recusada', () => {
  it('recusa hostname, path, rede, porta, volume, imagem e template', () => {
    const injects: ReadonlyArray<Record<string, unknown>> = [
      { hostname: 'outro-host' },
      { host: '10.1.2.3' },
      { path: '/srv/projetos' },
      { workdir: '/srv' },
      { network: 'rede-compartilhada' },
      { network_name: 'rede-compartilhada' },
      { port: 54321 },
      { ports: [54321] },
      { domain: 'site.exemplo.com' },
      { volume: 'vol-compartilhado' },
      { mount: '/var/lib/postgresql' },
      { image: 'postgres:latest' },
      { image_ref: 'postgres:latest' },
      { image_digest: `sha256:${'a'.repeat(64)}` },
      { tag: 'latest' },
      { digest: `sha256:${'a'.repeat(64)}` },
      { repository: 'postgres' },
      { registry: 'docker.io' },
      { compose_file: 'compose.yml' },
      { template: 'sb-stack-livre' },
      { template_id: 'sb-stack-livre' },
      { command: 'compose up' },
      { argv: ['compose', 'up'] },
      { shell: '/bin/sh' },
      { sql: 'DROP DATABASE x' },
      { env: { DB_PASSWORD: 'x' } },
      { secret: 'x' },
      { password: 'x' },
      { dsn: 'postgres://u:p@h:5432/db' },
      { privileged: true },
      { cap_add: ['SYS_ADMIN'] },
    ]
    for (const inject of injects) {
      let caught: unknown
      try {
        planWith(inject as Partial<SupabasePlanRequest>)
      } catch (error) {
        caught = error
      }
      expect(caught, JSON.stringify(inject)).toBeInstanceOf(
        SupabasePolicyRejectionError,
      )
      const rejection = caught as SupabasePolicyRejectionError
      expect(rejection.code, JSON.stringify(inject)).toBe('INVALID_REQUEST')
      expect(
        rejection.issues.some((issue) => issue.reason === 'free_form_input'),
        JSON.stringify(inject),
      ).toBe(true)
    }
  })

  it('recusa entrada livre injetada dentro da intenção', () => {
    const tampered = {
      ...INTENT,
      image: 'postgres:latest',
    } as ProjectIntent
    expect(() => planWith({ intent: tampered })).toThrow(
      SupabasePolicyRejectionError,
    )
  })
})

describe('plano de ações', () => {
  it('produz a stack canônica na ordem, com dependências válidas', () => {
    const plan = planWith()
    expect(plan.actions.map((action) => action.kind)).toEqual(EXPECTED_KINDS)
    expect(plan.actions).toHaveLength(19)
    const ids = new Set(plan.actions.map((action) => action.action_id))
    expect(ids.size).toBe(plan.actions.length)
    const indexById = new Map<string, number>()
    plan.actions.forEach((action, index) => {
      expect(action.action_id).toMatch(/^act_[A-Za-z0-9_-]{8,64}$/)
      expect(action.reversible).toBe(action.risk !== 'destructive')
      indexById.set(action.action_id, index)
    })
    plan.actions.forEach((action, index) => {
      for (const dependency of action.dependencies) {
        const dependencyIndex = indexById.get(dependency)
        expect(dependencyIndex).toBeDefined()
        expect(dependencyIndex ?? index).toBeLessThan(index)
      }
    })
    expect(plan.actions[0].dependencies).toEqual([])
    expect(plan.actions[1].dependencies).toEqual([plan.actions[0].action_id])
  })

  it('carrega o ownership marker esperado em cada recurso planejado', () => {
    const plan = planWith()
    for (const action of plan.actions) {
      expect(action.target_ref.endsWith(`#${NAMING.ownership_marker}`)).toBe(
        true,
      )
      expect(action.target_ref.startsWith('/')).toBe(false)
      expect(action.target_ref.length).toBeLessThanOrEqual(
        TARGET_REF_MAX_LENGTH,
      )
    }
    expect(plan.ownership_expectations).toHaveLength(plan.actions.length)
    plan.ownership_expectations.forEach((expectation, index) => {
      expect(expectation.target_ref).toBe(plan.actions[index].target_ref)
      expect(expectation.ownership_marker).toBe(NAMING.ownership_marker)
    })
  })

  it('mantém stack, rede e data store distintos no plano', () => {
    const plan = planWith()
    const targets = plan.actions.map((action) => action.target_ref)
    const compose = targets.find((ref) => ref.startsWith('compose-project:'))
    const network = targets.find((ref) => ref.startsWith('network:'))
    const dataStore = targets.find((ref) => ref.startsWith('data-store:'))
    expect(compose).toBeDefined()
    expect(network).toBeDefined()
    expect(dataStore).toBeDefined()
    expect(compose).not.toBe(network)
    expect(network).not.toBe(dataStore)
    expect(compose).not.toBe(dataStore)
    expect(NAMING.compose_project).not.toBe(NAMING.network)
    expect(NAMING.network).not.toBe(NAMING.data_store)
    expect(NAMING.compose_project).not.toBe(NAMING.data_store)
    expect(
      targets.filter((ref) => ref.startsWith('broker-binding:')),
    ).toHaveLength(SUPABASE_BROKER_SLOTS.length)
    expect(new Set(targets).size).toBeGreaterThan(10)
  })

  it('pina template, versão, perfil e imagens por digest', () => {
    const plan = planWith()
    expect(plan.stack_pin.template_id).toBe(SUPABASE_TEMPLATES[0].template_id)
    expect(plan.stack_pin.template_version).toBe(SUPABASE_TEMPLATES[0].version)
    expect(plan.stack_pin.profile_id).toBe('sb-small')
    expect(plan.stack_pin.images).toHaveLength(SUPABASE_SERVICE_IDS.length)
    for (const image of plan.stack_pin.images) {
      expect(image.ref).toMatch(/@sha256:[a-f0-9]{64}$/)
    }
    expect(plan.stack_pin.internal_ports.map((entry) => entry.service)).toEqual(
      [...SUPABASE_SERVICE_IDS],
    )
  })

  it('valida o plano contra o schema do contrato e o congela', () => {
    const plan = planWith()
    const parsed = planSchema.parse({
      policy_version: POLICY_VERSION,
      actions: [...plan.actions],
      estimated_resources: { ...plan.estimated_resources },
      warnings: [...plan.warnings],
    })
    expect(parsed.actions).toHaveLength(19)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.actions)).toBe(true)
    for (const action of plan.actions) {
      expect(Object.isFrozen(action)).toBe(true)
    }
    expect(Object.isFrozen(plan.stack_pin)).toBe(true)
  })

  it('não permite ação com conteúdo renderizado ou segredo', () => {
    const plan = planWith()
    const composeAction = plan.actions[1]
    expect(composeAction.kind).toBe('render_compose_template')
    expect(() => assertPlannedActionShape(composeAction)).not.toThrow()
    const injections: ReadonlyArray<Record<string, unknown>> = [
      { payload: { compose: 'services: {}' } },
      { rendered: 'services: {}' },
      { secret_value: 'segredo' },
      { secret: `sref_${'a'.repeat(43)}` },
      { command: 'compose up' },
      { sql: 'CREATE ROLE x' },
      { env: { DB_PASSWORD: 'x' } },
      { image: 'postgres:latest' },
      { port: 5432 },
      { host_path: '/srv/projetos' },
      { mount: '/var/lib/postgresql' },
      { script: './start.sh' },
    ]
    for (const injection of injections) {
      expect(
        () =>
          assertPlannedActionShape({
            ...composeAction,
            ...injection,
          } as PlannedAction),
        JSON.stringify(injection),
      ).toThrow()
    }
  })

  it('é determinístico para a mesma entrada', () => {
    const first = planWith()
    const second = planWith()
    expect(second.actions).toEqual(first.actions)
    expect(second.estimated_resources).toEqual(first.estimated_resources)
    expect(second.warnings).toEqual(first.warnings)
    expect(second.stack_pin).toEqual(first.stack_pin)
  })

  it('estima recursos pelo perfil e pelos limites pedidos', () => {
    const plan = planWith({
      intent: {
        ...INTENT,
        requested_limits: {
          database_size_mb: 4096,
          memory_mb: 8192,
          cpu_millicores: 4001,
          backup_retention_days: 30,
        },
      },
    })
    expect(plan.estimated_resources.database_size_mb).toBe(4096)
    expect(plan.estimated_resources.memory_mb).toBe(8192)
    expect(plan.estimated_resources.cpu_millicores).toBe(4001)
    expect(plan.estimated_resources.local_backup_mb).toBe(4096 / 2 + 30)
    expect(plan.stack_pin.profile_id).toBe('sb-standard')
  })

  it('marca como satisfeito o que a observação já comprova', () => {
    const plan = planWith({
      observed: provisionedObserved(),
      stack: healthyStack(),
    })
    const satisfiedKinds = plan.actions
      .filter((action) => plan.satisfied_action_ids.includes(action.action_id))
      .map((action) => action.kind)
    expect(satisfiedKinds).toEqual([
      'render_compose_template',
      'create_network',
      'create_data_store',
      'create_database',
      'create_app_role',
      'apply_least_privilege',
      ...SUPABASE_BROKER_SLOTS.map(() => 'create_secret_ref' as const),
      'start_stack',
    ])
    expect(plan.drift_findings).toEqual([])
    expect(plan.warnings.join(' ')).toContain('template sb-stack-full')
  })

  it('sem observação, nada é presumido existente (fail-closed)', () => {
    const plan = planWith()
    expect(plan.satisfied_action_ids).toEqual([])
    expect(plan.drift_findings).toEqual([])
    expect(plan.actions).toHaveLength(19)
  })

  it('propaga o drift observado para avisos e plano', () => {
    const plan = planWith({
      observed: provisionedObserved(),
      stack: healthyStack({
        template_version: '2026.01',
        drift_findings: ['template_version_drift', 'capacity_exceeded'],
      }),
    })
    expect([...plan.drift_findings].sort()).toEqual([
      'capacity_exceeded',
      'template_version_drift',
    ])
    expect(plan.warnings.join(' ')).toContain('template_version_drift')
  })

  it('não adota stack de outro projeto nem template divergente', () => {
    expect(() =>
      planWith({
        stack: healthyStack({
          compose_project: {
            name: 'je4ndev-sb-outro-projeto',
            exists: true,
            ownership_marker: NAMING.ownership_marker,
            ownership_verified: true,
            drift: [],
          },
        }),
      }),
    ).toThrow(/observacao fora do escopo/)
    expect(() =>
      planWith({ stack: healthyStack({ expected_template_id: 'sb-outro' }) }),
    ).toThrow(/observacao fora do escopo/)
  })

  it('recusa projeção de stack com campo desconhecido', () => {
    const stack = {
      ...healthyStack(),
      host_path: '/srv/projetos',
    } as unknown as SupabaseStackProjection
    expect(() => planWith({ stack })).toThrow()
  })
})

describe('dry-run sem execução', () => {
  it('não chama executor injetado acidentalmente', () => {
    let touches = 0
    let calls = 0
    const executor = new Proxy(
      {},
      {
        get: () => {
          touches += 1
          throw new Error('executor acessado')
        },
        apply: () => {
          calls += 1
          throw new Error('executor chamado')
        },
      },
    )
    const plan = planWith({ executor })
    expect(touches).toBe(0)
    expect(calls).toBe(0)
    expect(plan.actions).toHaveLength(19)
    expect(plan.warnings.join(' ')).toContain('adapter de execucao ignorado')

    const plainExecutor = {
      run: () => {
        calls += 1
      },
      execute: () => {
        calls += 1
      },
    }
    planWith({ executor: plainExecutor })
    expect(calls).toBe(0)
  })

  it('exige flags ligadas para planejar', () => {
    expect(() => planWith({ flags: FLAGS_OFF })).toThrow(FeatureDisabledError)
    expect(() => planWith({ flags: FLAGS_OFF })).toThrowError(
      /funcionalidade desligada/,
    )
  })

  it('recusa observação de outro driver, projeto ou ambiente', () => {
    expect(() =>
      planWith({ observed: makeObserved({ driver: 'postgresql_isolated' }) }),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith({
        observed: makeObserved({ driver_version: 'pcv2-sb-isolated-v0' }),
      }),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith({ observed: makeObserved({ project_id: 'acme-outro' }) }),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith({ observed: makeObserved({ environment: 'staging' }) }),
    ).toThrowError(/observacao fora do escopo/)
  })

  it('recusa intenção fora da política antes de gerar ações', () => {
    expect(() =>
      planWith({
        policy: buildPolicySnapshot({ allowed_host_targets: ['outro-host'] }),
      }),
    ).toThrowError(/recusada/)
  })

  it('comporta slugs no limite máximo do contrato', () => {
    const longIntent: ProjectIntent = {
      ...INTENT,
      client_id: `c${'a'.repeat(23)}`,
      project_slug: `p${'b'.repeat(23)}`,
      environment: 'production',
    }
    const plan = planSupabaseActions({
      intent: longIntent,
      observed: makeObserved({
        project_id: buildNamingSnapshot({
          client_id: longIntent.client_id,
          project_slug: longIntent.project_slug,
          environment: longIntent.environment,
          driver: longIntent.driver,
        }).project_id,
        environment: 'production',
      }),
      policy: DEFAULT_POLICY_SNAPSHOT,
      flags: FLAGS_ON,
    })
    for (const action of plan.actions) {
      expect(action.target_ref.length).toBeLessThanOrEqual(
        TARGET_REF_MAX_LENGTH,
      )
      expect(action.target_ref).not.toContain(' ')
    }
  })
})

describe('plano sem resíduo sensível', () => {
  it('não carrega comando, credencial, path, bind público nem container', () => {
    const json = JSON.stringify(planWith())
    expect(json).not.toContain('sref_')
    expect(json).not.toContain('password')
    expect(json).not.toContain('postgres://')
    expect(json).not.toContain('0.0.0.0')
    expect(json).not.toContain('docker')
    expect(json).not.toContain('command')
    expect(json).not.toContain('argv')
    expect(json).not.toMatch(/\/home\/|\/root\/|\/etc\/|\/var\/|\/srv\//)
  })

  it('não contém material sensível nem entrega segredo ao broker', () => {
    const plan = planWith({
      observed: provisionedObserved(),
      stack: healthyStack(),
    })
    const plain = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>
    expect(redactValue(plain)).toEqual(plain)
    for (const warning of plan.warnings) {
      expect(warning).not.toContain('sref_')
    }
  })

  it('sanitiza detalhe de erro com o catálogo de redaction', () => {
    const payload = supabaseIsolatedDriver.sanitize({
      detail: 'ok',
      token: 'segredo',
      dsn: 'postgres://usuario:***@host:5432/banco',
    })
    expect(payload.detail).toBe('ok')
    expect(payload.token).toBe('[REDACTED]')
    expect(JSON.stringify(payload)).not.toContain('segredo')
    expect(JSON.stringify(payload)).not.toContain('postgres://')
  })
})

describe('perfis disponíveis no plano', () => {
  it('seleciona perfil pelo pedido e mantém a projeção vazia fail-closed', () => {
    const empty = emptyStackProjection({
      compose_project: NAMING.compose_project,
      network: NAMING.network,
      data_store: NAMING.data_store,
      expected_template_id: SUPABASE_TEMPLATES[0].template_id,
    })
    expect(planWith({ stack: empty }).satisfied_action_ids).toEqual([])
    expect(SUPABASE_RESOURCE_PROFILES).toHaveLength(2)
  })
})

const PR3_SOURCES = [
  'supabase-isolated.ts',
  '../catalogs/supabase-catalog.ts',
  '../observers/supabase-observer.ts',
] as const

const ALLOWED_SPECIFIERS = new Set(['zod', 'node:crypto'])

/** Alvos relativos permitidos: nada fora do escopo revisado do PCv2. */
const ALLOWED_RELATIVE = new Set([
  './types',
  '../domain',
  '../feature-flags',
  '../naming',
  '../redaction',
  '../planner',
  '../policy',
  '../catalogs/supabase-catalog',
  '../drivers/supabase-isolated',
  '../drivers/types',
  './postgresql-observer',
  '../observers/postgresql-observer',
  './supabase-isolated',
])

const FORBIDDEN_TOKENS = [
  '0.0.0.0',
  'CREATE ROLE',
  'CREATE DATABASE',
  'DROP DATABASE',
  'ALTER ROLE',
  'child_process',
  'spawnSync',
  'spawn(',
  'execFile',
  'execSync',
  'dockerode',
  'docker compose',
  'compose up',
  'compose down',
  'require(',
  'eval(',
  'node:fs',
  'node:net',
  'node:http',
]

function moduleSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    'utf8',
  )
}

function importSpecifiers(source: string): Array<string> {
  const found: Array<string> = []
  const pattern = /(?:from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

describe('guarda de arquitetura dos módulos do PR 3', () => {
  it('importa apenas módulos permitidos (sem I/O privilegiado)', () => {
    for (const name of PR3_SOURCES) {
      const specifiers = importSpecifiers(moduleSource(name))
      expect(specifiers.length, name).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        const allowed =
          ALLOWED_SPECIFIERS.has(specifier) || ALLOWED_RELATIVE.has(specifier)
        expect(allowed, `${name}: ${specifier}`).toBe(true)
      }
    }
  })

  it('não referencia cliente de banco, nuvem nem SDK de container', () => {
    for (const name of PR3_SOURCES) {
      const external = importSpecifiers(moduleSource(name)).filter(
        (specifier) => !specifier.startsWith('.'),
      )
      for (const specifier of external) {
        expect(ALLOWED_SPECIFIERS.has(specifier), `${name}: ${specifier}`).toBe(
          true,
        )
        expect(specifier, `${name}: ${specifier}`).not.toMatch(
          /child_process|docker|(^|\/)pg($|\/)|postgres|mysql|mongo|redis|aws-sdk|supabase|node:fs|node:net|node:http/,
        )
      }
    }
  })

  it('não contém DDL, shell, SQL livre, path nem segredo literal', () => {
    for (const name of PR3_SOURCES) {
      const source = moduleSource(name)
      for (const token of FORBIDDEN_TOKENS) {
        expect(source.includes(token), `${name}: ${token}`).toBe(false)
      }
      expect(source.includes('sref_'), `${name}: sref_`).toBe(false)
      expect(
        /\/home\/|\/root\/|\/etc\/|\/var\/|\/srv\//.test(source),
        `${name}: path absoluto`,
      ).toBe(false)
    }
  })

  it('não planeja `schema_shared` em nenhum caminho', () => {
    for (const name of PR3_SOURCES) {
      expect(moduleSource(name).includes('schema_shared')).toBe(false)
    }
    expect(SUPABASE_ACTION_KINDS).not.toContain('schema_shared')
  })
})
