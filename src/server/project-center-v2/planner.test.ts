/**
 * Testes do planner em dry-run (PR 2).
 *
 * Provam o que o elo 2 promete: ações tipadas sem execução, hash canônico com
 * driver/versão, revisão observada, política e prazo; idempotência real
 * (mesma intenção + mesma observação ⇒ mesmo plano/hash) e mudança material
 * exigindo nova chave; flag desligada fechando antes de qualquer trabalho; e
 * nenhum resíduo sensível no plano. O último bloco é o guarda de arquitetura
 * dos módulos do PR 2.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planSchema } from './domain'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { buildNamingSnapshot } from './naming'
import { POLICY_VERSION } from './policy'
import {
  APPROVAL_TTL_SECONDS,
  DEFAULT_POLICY_SNAPSHOT,
  DRIVER_REGISTRY,
  PLANNER_VERSION,
  PLAN_TTL_SECONDS,
  PlanDeterminismError,
  PlanRejectedError,
  PlanStaleError,
  assertPlanReusable,
  buildPolicySnapshot,
  comparePlanReuse,
  computeIntentHash,
  computePlanKey,
  describePlan,
  planProject,
  selectDryRunDriver,
  toPlanReference,
} from './planner'
import {
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
} from './drivers/postgresql-isolated'
import { DriverUnavailableError, observedStateSchema } from './drivers/types'
import type { ProjectIntent } from './domain'
import type { ObservedState } from './drivers/types'

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
const FLAGS_OFF = resolveProjectCenterV2Flags({})

const OBSERVED_AT = '2026-09-25T12:00:00.000Z'
const REVISION_A = `obsrev_${'a'.repeat(32)}`

function makeObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return observedStateSchema.parse({
    driver: POSTGRESQL_DRIVER_ID,
    driver_version: POSTGRESQL_DRIVER_VERSION,
    observer_version: 'pcv2-pg-observer-v1',
    host_target: INTENT.host_target,
    environment: INTENT.environment,
    project_id: NAMING.project_id,
    observed_at: OBSERVED_AT,
    revision: REVISION_A,
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

function makePlan(
  observed: ObservedState = makeObserved(),
  intent: ProjectIntent = INTENT,
  policy = DEFAULT_POLICY_SNAPSHOT,
) {
  return planProject({ intent, observed, policy, flags: FLAGS_ON })
}

const NOW = new Date(OBSERVED_AT)

describe('plano canônico', () => {
  it('gera hash, prazo derivado da observação e ações tipadas', () => {
    const plan = makePlan()
    expect(plan.driver).toBe(POSTGRESQL_DRIVER_ID)
    expect(plan.driver_version).toBe(POSTGRESQL_DRIVER_VERSION)
    expect(plan.planner_version).toBe(PLANNER_VERSION)
    expect(plan.policy_version).toBe(POLICY_VERSION)
    expect(plan.project_id).toBe(NAMING.project_id)
    expect(plan.observed_revision).toBe(REVISION_A)
    expect(plan.plan_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.plan_key).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.intent_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.expires_at).toBe(
      new Date(Date.parse(OBSERVED_AT) + PLAN_TTL_SECONDS * 1000).toISOString(),
    )
    expect(plan.plan.actions).toHaveLength(11)
    expect(plan.plan.actions.map((action) => action.kind)).toEqual([
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
    expect(DEFAULT_POLICY_SNAPSHOT.approval_ttl_seconds).toBe(
      APPROVAL_TTL_SECONDS,
    )
  })

  it('valida o plano contra o schema do contrato e o congela', () => {
    const plan = makePlan()
    expect(() => planSchema.parse(plan.plan)).not.toThrow()
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.plan)).toBe(true)
    expect(Object.isFrozen(plan.plan.actions)).toBe(true)
    for (const action of plan.plan.actions) {
      expect(Object.isFrozen(action)).toBe(true)
    }
  })

  it('não duplica nome derivado do cliente e usa o naming server-side', () => {
    const plan = makePlan()
    expect(
      plan.plan.actions.find((action) => action.kind === 'create_database')
        ?.target_ref,
    ).toBe(`database:${NAMING.database}`)
    expect(
      plan.plan.actions.find((action) => action.kind === 'configure_r2_prefix')
        ?.target_ref,
    ).toBe(`r2-prefix:${NAMING.r2_prefix}`)
  })
})

describe('idempotência e determinismo', () => {
  it('mesma intenção + mesma observação produzem o mesmo plano/hash', () => {
    const observed = makeObserved()
    const first = planProject({ intent: INTENT, observed, flags: FLAGS_ON })
    const second = planProject({ intent: INTENT, observed, flags: FLAGS_ON })
    expect(second.plan_key).toBe(first.plan_key)
    expect(second.plan_hash).toBe(first.plan_hash)
    expect(second.plan).toEqual(first.plan)
    expect(
      computePlanKey({
        intent_hash: first.intent_hash,
        observed,
        policy: DEFAULT_POLICY_SNAPSHOT,
        driver: POSTGRESQL_DRIVER_ID,
        driver_version: POSTGRESQL_DRIVER_VERSION,
      }),
    ).toBe(first.plan_key)
  })

  it('reaproveita plano idêntico dentro do prazo', () => {
    const plan = makePlan()
    const verdict = comparePlanReuse(toPlanReference(plan), plan, NOW)
    expect(verdict).toEqual({ status: 'identical', plan_hash: plan.plan_hash })
    expect(() =>
      assertPlanReusable(toPlanReference(plan), plan, NOW),
    ).not.toThrow()
  })

  it('expira o plano depois do prazo', () => {
    const plan = makePlan()
    const after = new Date(Date.parse(plan.expires_at) + 1000)
    expect(comparePlanReuse(toPlanReference(plan), plan, after)).toEqual({
      status: 'expired',
      plan_hash: plan.plan_hash,
    })
    expect(() =>
      assertPlanReusable(toPlanReference(plan), plan, after),
    ).toThrow(PlanStaleError)
    try {
      assertPlanReusable(toPlanReference(plan), plan, after)
    } catch (error) {
      expect((error as PlanStaleError).reason).toBe('expired')
    }
  })

  it('exige nova chave quando a observação muda materialmente', () => {
    const previous = toPlanReference(makePlan())
    const current = makePlan(
      makeObserved({ revision: `obsrev_${'b'.repeat(32)}` }),
    )
    const verdict = comparePlanReuse(previous, current, NOW)
    expect(verdict.status).toBe('material_change')
    expect(verdict.status === 'material_change' && verdict.reason).toBe(
      'observation_changed',
    )
    expect(current.plan_key).not.toBe(previous.plan_key)
    expect(() => assertPlanReusable(previous, current, NOW)).toThrow(
      PlanStaleError,
    )
  })

  it('exige nova chave quando só o carimbo da observação muda', () => {
    const previous = toPlanReference(makePlan())
    const current = makePlan(
      makeObserved({ observed_at: '2026-09-25T13:00:00.000Z' }),
    )
    expect(current.observed_revision).toBe(previous.observed_revision)
    const verdict = comparePlanReuse(previous, current, NOW)
    expect(verdict.status === 'material_change' && verdict.reason).toBe(
      'observation_timestamp_changed',
    )
    expect(current.plan_key).not.toBe(previous.plan_key)
  })

  it('exige nova chave quando a intenção muda', () => {
    const previous = toPlanReference(makePlan())
    const current = makePlan(makeObserved(), {
      ...INTENT,
      display_name: 'Site Acme 2',
    })
    const verdict = comparePlanReuse(previous, current, NOW)
    expect(verdict.status === 'material_change' && verdict.reason).toBe(
      'intent_changed',
    )
    const withoutDescription: ProjectIntent = {
      client_id: INTENT.client_id,
      project_slug: INTENT.project_slug,
      display_name: INTENT.display_name,
      driver: INTENT.driver,
      environment: INTENT.environment,
      host_target: INTENT.host_target,
      capabilities: INTENT.capabilities,
    }
    expect(computeIntentHash(withoutDescription)).not.toBe(
      computeIntentHash(INTENT),
    )
  })

  it('exige nova chave quando a política muda', () => {
    const previous = toPlanReference(makePlan())
    const policy = buildPolicySnapshot({ policy_version: 'pcv2-rbac-v2' })
    const current = makePlan(makeObserved(), INTENT, policy)
    const verdict = comparePlanReuse(previous, current, NOW)
    expect(verdict.status === 'material_change' && verdict.reason).toBe(
      'policy_changed',
    )
    expect(current.plan.policy_version).toBe('pcv2-rbac-v2')
  })

  it('prioriza driver_changed sobre as demais mudanças materiais', () => {
    const plan = makePlan()
    const previous = {
      ...toPlanReference(plan),
      driver_version: 'pcv2-pg-isolated-v0',
    }
    const current = makePlan(
      makeObserved(),
      INTENT,
      buildPolicySnapshot({ policy_version: 'pcv2-rbac-v2' }),
    )
    const verdict = comparePlanReuse(previous, current, NOW)
    expect(verdict.status === 'material_change' && verdict.reason).toBe(
      'driver_changed',
    )
  })

  it('falha fechado quando a mesma chave produz hashes diferentes', () => {
    const plan = makePlan()
    const previous = {
      ...toPlanReference(plan),
      plan_hash: 'b'.repeat(64),
    }
    expect(() => comparePlanReuse(previous, plan, NOW)).toThrow(
      PlanDeterminismError,
    )
  })
})

describe('flags e seleção de driver', () => {
  it('fecha com feature_disabled antes de escolher driver', () => {
    expect(() =>
      planProject({
        intent: { ...INTENT, driver: 'supabase_isolated' },
        observed: makeObserved(),
        flags: FLAGS_OFF,
      }),
    ).toThrow(FeatureDisabledError)
    expect(() =>
      planProject({
        intent: INTENT,
        observed: makeObserved(),
        flags: FLAGS_OFF,
      }),
    ).toThrowError(/funcionalidade desligada/)
  })

  it('recusa driver sem plano implementado neste PR', () => {
    expect(() =>
      planProject({
        intent: { ...INTENT, driver: 'supabase_isolated' },
        observed: makeObserved(),
        flags: FLAGS_ON,
      }),
    ).toThrow(DriverUnavailableError)
    expect(() => selectDryRunDriver('schema_shared')).toThrowError(
      DriverUnavailableError,
    )
    expect(() => selectDryRunDriver(undefined)).toThrowError(
      /driver indisponivel/,
    )
    expect(Object.keys(DRIVER_REGISTRY)).toEqual([POSTGRESQL_DRIVER_ID])
  })

  it('não exige a flag do worker para planejar', () => {
    const plan = planProject({
      intent: INTENT,
      observed: makeObserved(),
      flags: resolveProjectCenterV2Flags({
        PROJECT_CENTER_V2_ENABLED: 'true',
        PROJECT_CENTER_V2_WORKER_ENABLED: 'false',
      }),
    })
    expect(plan.driver).toBe(POSTGRESQL_DRIVER_ID)
  })
})

describe('política no dry-run', () => {
  it('recusa host fora da allowlist com POLICY_DENIED', () => {
    try {
      makePlan(
        makeObserved(),
        INTENT,
        buildPolicySnapshot({ allowed_host_targets: ['outro-host'] }),
      )
      throw new Error('deveria ter recusado')
    } catch (error) {
      expect(error).toBeInstanceOf(PlanRejectedError)
      expect((error as PlanRejectedError).code).toBe('POLICY_DENIED')
    }
  })

  it('recusa capability de stack completa', () => {
    try {
      makePlan(makeObserved(), {
        ...INTENT,
        capabilities: { ...INTENT.capabilities, realtime: true },
      })
      throw new Error('deveria ter recusado')
    } catch (error) {
      expect(error).toBeInstanceOf(PlanRejectedError)
      expect((error as PlanRejectedError).code).toBe('DRIVER_UNAVAILABLE')
    }
  })

  it('congela o snapshot e aplica overrides', () => {
    const snapshot = buildPolicySnapshot({ plan_ttl_seconds: 600 })
    expect(snapshot.plan_ttl_seconds).toBe(600)
    expect(snapshot.policy_version).toBe(POLICY_VERSION)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(DEFAULT_POLICY_SNAPSHOT)).toBe(true)
    expect(buildPolicySnapshot().plan_ttl_seconds).toBe(PLAN_TTL_SECONDS)
  })
})

describe('plano sem resíduo sensível', () => {
  it('descreve o plano de forma sanitizada', () => {
    const plan = makePlan()
    const summary = describePlan(plan)
    expect(summary.action_count).toBe(11)
    expect(summary.plan_hash).toBe(plan.plan_hash)
    expect(summary.driver).toBe(POSTGRESQL_DRIVER_ID)
    expect(JSON.stringify(summary)).not.toContain('postgres://')
    expect(JSON.stringify(summary)).not.toContain('sref_')
  })

  it('não carrega path absoluto, credencial nem bind público', () => {
    const json = JSON.stringify(makePlan())
    expect(json).not.toContain('postgres://')
    expect(json).not.toContain('password')
    expect(json).not.toContain('sref_')
    expect(json).not.toMatch(/\/home\/|\/srv\/|\/var\/|\/etc\//)
    expect(json).not.toContain('0.0.0.0')
    expect(json).not.toContain('command')
    expect(json).not.toContain('argv')
  })
})

const PR2_SOURCES = [
  'naming.ts',
  'planner.ts',
  'drivers/types.ts',
  'drivers/postgresql-isolated.ts',
  'observers/postgresql-observer.ts',
] as const

const ALLOWED_SPECIFIERS = new Set(['zod', 'node:crypto'])

/**
 * Alvos relativos explicitamente permitidos. Um allowlist exato evita falso
 * positivo por substring (por exemplo `./drivers/postgresql-isolated` contém
 * `postgres`) e impede importar qualquer coisa fora do escopo revisado.
 */
const ALLOWED_RELATIVE = new Set([
  './domain',
  './feature-flags',
  './naming',
  './policy',
  './redaction',
  './planner',
  './postgresql-observer',
  './postgresql-isolated',
  './drivers/types',
  './drivers/postgresql-isolated',
  './types',
  '../domain',
  '../feature-flags',
  '../naming',
  '../policy',
  '../redaction',
  '../drivers/types',
  '../drivers/postgresql-isolated',
])

const FORBIDDEN_TOKENS = [
  '0.0.0.0',
  'DROP DATABASE',
  'CREATE DATABASE',
  'CREATE ROLE',
  'ALTER ROLE',
  'child_process',
  'spawnSync',
  'execFile',
  'execSync',
  'require(',
  'docker compose',
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

describe('guarda de arquitetura dos módulos do PR 2', () => {
  it('importa apenas módulos permitidos (sem I/O privilegiado)', () => {
    for (const name of PR2_SOURCES) {
      const specifiers = importSpecifiers(moduleSource(name))
      expect(specifiers.length, name).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        const allowed =
          ALLOWED_SPECIFIERS.has(specifier) || ALLOWED_RELATIVE.has(specifier)
        expect(allowed, `${name}: ${specifier}`).toBe(true)
      }
    }
  })

  it('não referencia nó nativo, clientes de banco nem Docker', () => {
    for (const name of PR2_SOURCES) {
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

  it('não contém DDL, shell, SQL livre nem bind público literal', () => {
    for (const name of PR2_SOURCES) {
      const source = moduleSource(name)
      for (const token of FORBIDDEN_TOKENS) {
        expect(source.includes(token), `${name}: ${token}`).toBe(false)
      }
    }
  })
})
