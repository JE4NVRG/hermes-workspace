/**
 * Testes do driver `postgresql_isolated` em dry-run (PR 2).
 *
 * O plano é dado tipado: as ações são validadas pela forma estrita do contrato,
 * a ordem e as dependências são determinísticas, nada carrega command/argv/sql/
 * env/secret e nenhum caminho executa. Colisão de nome e observação fora de
 * escopo falham fechado antes de qualquer ação existir.
 */
import { describe, expect, it } from 'vitest'
import { PLANNED_ACTION_KINDS } from '../domain'
import { resolveProjectCenterV2Flags } from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { DEFAULT_POLICY_SNAPSHOT, buildPolicySnapshot } from '../planner'
import {
  LEAST_PRIVILEGE_EXPECTATIONS,
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
  planPostgresqlActions,
  postgresqlDriverDescriptor,
  postgresqlIsolatedDriver,
  validatePostgresqlIntent,
} from './postgresql-isolated'
import {
  FORBIDDEN_ACTION_KEYS,
  POSTGRESQL_ACTION_KINDS,
  observedStateSchema,
} from './types'
import type { ObservedState } from './types'
import type { ProjectIntent } from '../domain'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
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
const FLAGS_OFF = resolveProjectCenterV2Flags({})

function makeObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return observedStateSchema.parse({
    driver: POSTGRESQL_DRIVER_ID,
    driver_version: POSTGRESQL_DRIVER_VERSION,
    observer_version: 'pcv2-pg-observer-v1',
    host_target: INTENT.host_target,
    environment: INTENT.environment,
    project_id: NAMING.project_id,
    observed_at: '2026-09-25T12:00:00.000Z',
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

function planWith(
  observed: ObservedState = makeObserved(),
  intent: ProjectIntent = INTENT,
  policy = DEFAULT_POLICY_SNAPSHOT,
) {
  return planPostgresqlActions({ intent, observed, policy, flags: FLAGS_ON })
}

describe('descriptor do driver', () => {
  it('declara o driver/versão e apenas kinds do contrato', () => {
    expect(postgresqlDriverDescriptor.id).toBe('postgresql_isolated')
    expect(postgresqlDriverDescriptor.version).toBe(POSTGRESQL_DRIVER_VERSION)
    expect(postgresqlDriverDescriptor.actions).toEqual(POSTGRESQL_ACTION_KINDS)
    for (const kind of postgresqlDriverDescriptor.actions) {
      expect(PLANNED_ACTION_KINDS).toContain(kind)
    }
    expect(postgresqlDriverDescriptor.provided_capabilities).toEqual(['backup'])
  })

  it('não expõe observação nem execução', () => {
    expect(Object.keys(postgresqlIsolatedDriver).sort()).toEqual([
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
    ]) {
      expect(forbidden in postgresqlIsolatedDriver).toBe(false)
    }
  })
})

describe('validação da intenção', () => {
  it('aceita intenção compatível com o driver PostgreSQL', () => {
    expect(validatePostgresqlIntent(INTENT, DEFAULT_POLICY_SNAPSHOT)).toEqual({
      ok: true,
      warnings: [],
    })
  })

  it('avisa que produção exige aprovação humana', () => {
    const result = validatePostgresqlIntent(
      { ...INTENT, environment: 'production' },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.warnings.join(' ')).toContain(
      'aprovacao humana segregada',
    )
  })

  it('recusa capability de stack completa', () => {
    for (const capability of [
      'auth',
      'storage',
      'realtime',
      'postgrest',
    ] as const) {
      const result = validatePostgresqlIntent(
        {
          ...INTENT,
          capabilities: { ...INTENT.capabilities, [capability]: true },
        },
        DEFAULT_POLICY_SNAPSHOT,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.code).toBe('DRIVER_UNAVAILABLE')
      expect(
        result.ok === false &&
          result.issues.some(
            (issue) => issue.field === `capabilities.${capability}`,
          ),
      ).toBe(true)
    }
  })

  it('recusa driver, host e ambiente fora da allowlist', () => {
    const wrongDriver = validatePostgresqlIntent(
      { ...INTENT, driver: 'supabase_isolated' },
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(wrongDriver.ok === false && wrongDriver.code).toBe(
      'DRIVER_UNAVAILABLE',
    )

    const wrongHost = validatePostgresqlIntent(
      INTENT,
      buildPolicySnapshot({ allowed_host_targets: ['outro-host'] }),
    )
    expect(wrongHost.ok === false && wrongHost.code).toBe('POLICY_DENIED')

    const wrongEnvironment = validatePostgresqlIntent(
      INTENT,
      buildPolicySnapshot({ allowed_environments: ['production'] }),
    )
    expect(wrongEnvironment.ok === false && wrongEnvironment.code).toBe(
      'POLICY_DENIED',
    )
  })

  it('recusa limites acima da cota e abaixo do mínimo', () => {
    const above = validatePostgresqlIntent(
      {
        ...INTENT,
        requested_limits: { database_size_mb: 102401 },
      } as ProjectIntent,
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(above.ok === false && above.code).toBe('QUOTA_EXCEEDED')

    const below = validatePostgresqlIntent(
      {
        ...INTENT,
        requested_limits: { database_size_mb: 10 },
      } as ProjectIntent,
      DEFAULT_POLICY_SNAPSHOT,
    )
    expect(below.ok === false && below.code).toBe('INVALID_REQUEST')
  })
})

describe('plano de ações', () => {
  it('produz as ações canônicas, na ordem, com dependências válidas', () => {
    const plan = planWith()
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'reserve_project',
      'create_database',
      'create_app_role',
      'apply_least_privilege',
      'create_secret_ref',
      'configure_backup',
      'configure_r2_prefix',
      'verify_cross_isolation',
      'verify_backup_restore',
      'publish_registry',
      'publish_platform_context',
    ])
    const ids = new Set(plan.actions.map((action) => action.action_id))
    expect(ids.size).toBe(plan.actions.length)
    plan.actions.forEach((action) => {
      expect(action.action_id).toMatch(/^act_[A-Za-z0-9_-]{8,64}$/)
      expect(action.reversible).toBe(action.risk !== 'destructive')
      for (const dependency of action.dependencies) {
        expect(ids.has(dependency)).toBe(true)
      }
    })
    expect(plan.actions[0].dependencies).toEqual([])
    expect(plan.satisfied_action_ids).toEqual([])
  })

  it('não carrega command, argv, sql, env, path ou secret', () => {
    const plan = planWith()
    const json = JSON.stringify(plan)
    expect(json).not.toContain('postgres://')
    expect(json).not.toContain('password')
    expect(json).not.toContain('sref_')
    for (const action of plan.actions) {
      for (const key of Object.keys(action)) {
        expect(FORBIDDEN_ACTION_KEYS).not.toContain(key)
      }
      expect(action.target_ref.startsWith('/')).toBe(false)
    }
  })

  it('é determinístico para a mesma entrada', () => {
    const first = planWith()
    const second = planWith()
    expect(second.actions).toEqual(first.actions)
    expect(second.estimated_resources).toEqual(first.estimated_resources)
    expect(second.warnings).toEqual(first.warnings)
  })

  it('estima recursos a partir dos limites pedidos', () => {
    const plan = planWith(makeObserved(), {
      ...INTENT,
      requested_limits: {
        database_size_mb: 2048,
        memory_mb: 1024,
        cpu_millicores: 1500,
        backup_retention_days: 30,
      },
    })
    expect(plan.estimated_resources.database_size_mb).toBe(2048)
    expect(plan.estimated_resources.memory_mb).toBe(1024)
    expect(plan.estimated_resources.cpu_millicores).toBe(1500)
    expect(plan.estimated_resources.local_backup_mb).toBe(2048 / 2 + 30)
  })

  it('marca ações já satisfeitas pelo estado observado', () => {
    const satisfiedPrivilege = LEAST_PRIVILEGE_EXPECTATIONS.map(
      (expectation) => ({
        schema_name: expectation.schema_name,
        role_name: NAMING.app_role,
        privilege: expectation.privilege,
        grantable: false,
      }),
    )
    const plan = planWith(
      makeObserved({
        ownership_verified: true,
        database: {
          name: NAMING.database,
          exists: true,
          owner_role: 'je4ndev_pcv2_admin',
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
        privileges: satisfiedPrivilege,
      }),
    )
    const satisfiedKinds = plan.actions
      .filter((action) => plan.satisfied_action_ids.includes(action.action_id))
      .map((action) => action.kind)
    expect(satisfiedKinds).toEqual([
      'create_database',
      'create_app_role',
      'apply_least_privilege',
    ])
    expect(plan.warnings.join(' ')).toContain('ja satisfeito')
  })

  it('falha com NAMING_CONFLICT quando o database existe sem ownership', () => {
    expect(() =>
      planWith(
        makeObserved({
          database: {
            name: NAMING.database,
            exists: true,
            owner_role: 'outro_admin',
            ownership_marker: null,
            size_mb: 10,
            is_template: false,
          },
        }),
      ),
    ).toThrowError(/conflito/)
  })

  it('falha quando a app role preexistente não é do projeto', () => {
    expect(() =>
      planWith(
        makeObserved({
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
        }),
      ),
    ).toThrowError(/conflito/)
  })

  it('recusa observação de outro driver, projeto ou ambiente', () => {
    expect(() =>
      planWith(makeObserved({ driver: 'supabase_isolated' })),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith(makeObserved({ driver_version: 'pcv2-pg-isolated-v0' })),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith(makeObserved({ project_id: 'acme-outro' })),
    ).toThrowError(/observacao fora do escopo/)
    expect(() =>
      planWith(makeObserved({ environment: 'staging' })),
    ).toThrowError(/observacao fora do escopo/)
  })

  it('exige flags ligadas para planejar', () => {
    expect(() =>
      planPostgresqlActions({
        intent: INTENT,
        observed: makeObserved(),
        policy: DEFAULT_POLICY_SNAPSHOT,
        flags: FLAGS_OFF,
      }),
    ).toThrowError(/funcionalidade desligada/)
  })

  it('recusa intenção fora da política antes de gerar ações', () => {
    expect(() =>
      planWith(
        makeObserved(),
        INTENT,
        buildPolicySnapshot({ allowed_host_targets: ['outro-host'] }),
      ),
    ).toThrowError(/recusada/)
  })

  it('preserva avisos de insegurança observados', () => {
    const plan = planWith(
      makeObserved({
        unsafe_findings: ['public_postgres_bind'],
        warnings: ['bind publico detectado; endpoint suprimido'],
      }),
    )
    expect(plan.warnings.join(' ')).toContain('public_postgres_bind')
    expect(plan.warnings.join(' ')).toContain('bind publico detectado')
  })
})

describe('sanitização de detalhe', () => {
  it('mascara chave sensível e mantém detalhe neutro', () => {
    const payload = postgresqlIsolatedDriver.sanitize({
      detail: 'ok',
      password: 'segredo',
      dsn: 'postgres://usuario:credencial@host:5432/banco',
    })
    expect(payload.detail).toBe('ok')
    expect(payload.password).toBe('[REDACTED]')
    expect(payload.dsn).toBe('[REDACTED]')
    expect(JSON.stringify(payload)).not.toContain('segredo')
  })
})
