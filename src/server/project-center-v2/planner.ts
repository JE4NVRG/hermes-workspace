/**
 * Planner determinístico do Project Center v2 (PR 2).
 *
 * O planner compõe o plano de dry-run: seleciona o driver registrado, valida a
 * intenção contra a política/allowlists, pede as ações tipadas ao driver e
 * calcula o **hash canônico** que amarra intenção + observação + política +
 * prazo. Ele não executa nada, não abre conexão, não emite credencial e não
 * conhece worker, outbox ou lease (PR 6).
 *
 * Determinismo: o prazo é derivado do carimbo da observação
 * (`observed_at + plan_ttl_seconds`), nunca do relógio do processo. Assim, a
 * mesma intenção com a mesma observação produz o mesmo `plan_key` e o mesmo
 * `plan_hash`; mudança material (intenção, observação, política ou driver)
 * muda a chave e exige nova `Idempotency-Key`.
 */
import { DRIVERS, planSchema, projectIntentSchema } from './domain'
import { requireApiEnabled, resolveProjectCenterV2Flags } from './feature-flags'
import { NAMING_VERSION, projectIdFor } from './naming'
import { POLICY_VERSION } from './policy'
import { toSafePayload } from './redaction'
import {
  POSTGRESQL_DRIVER_ID,
  postgresqlIsolatedDriver,
} from './drivers/postgresql-isolated'
import {
  DRIVER_ALLOWLIST_VERSION,
  DriverUnavailableError,
  PROJECT_CENTER_ALLOWLISTS,
  assertObservedState,
  assertPlannedActionShape,
  hashCanonical,
} from './drivers/types'
import type { ProjectCenterV2Flags } from './feature-flags'
import type {
  Driver,
  ErrorCode,
  Plan,
  ProjectIntent,
  SafePayload,
} from './domain'
import type {
  DriverPlan,
  DriverValidationIssue,
  DryRunDriver,
  ObservedState,
  PostgresQuotas,
  ProjectCenterV2PolicySnapshot,
} from './drivers/types'

export const PLANNER_VERSION = 'pcv2-planner-v1'
/** Validade do plano (spec §10): 30 minutos. */
export const PLAN_TTL_SECONDS = 1800
/** Validade da aprovação vinculada ao plano (spec §10): 15 minutos. */
export const APPROVAL_TTL_SECONDS = 900
/** Limite de ações por plano (spec §10 / contrato). */
export const MAX_ACTIONS_PER_PLAN = 50
/** Forma canônica de `action_id` no contrato. */
const ACTION_ID_PATTERN = /^act_[A-Za-z0-9_-]{8,64}$/

/** Cotas do driver PostgreSQL isolado (spec §10). */
export const POSTGRES_QUOTAS: PostgresQuotas = Object.freeze({
  database_size_mb: Object.freeze({ min: 128, max: 102400, default: 1024 }),
  memory_mb: Object.freeze({ min: 256, max: 16384, default: 512 }),
  cpu_millicores: Object.freeze({ min: 100, max: 8000, default: 500 }),
  backup_retention_days: Object.freeze({ min: 7, max: 90, default: 14 }),
})

/** Retrato padrão de política + allowlists, congelado. */
export const DEFAULT_POLICY_SNAPSHOT: ProjectCenterV2PolicySnapshot =
  Object.freeze({
    policy_version: POLICY_VERSION,
    allowlist_version: DRIVER_ALLOWLIST_VERSION,
    plan_ttl_seconds: PLAN_TTL_SECONDS,
    approval_ttl_seconds: APPROVAL_TTL_SECONDS,
    max_actions_per_plan: MAX_ACTIONS_PER_PLAN,
    allowed_drivers: PROJECT_CENTER_ALLOWLISTS.drivers,
    allowed_environments: PROJECT_CENTER_ALLOWLISTS.environments,
    allowed_host_targets: PROJECT_CENTER_ALLOWLISTS.host_targets,
    allowed_capabilities: PROJECT_CENTER_ALLOWLISTS.capabilities,
    postgres_extension_allowlist: PROJECT_CENTER_ALLOWLISTS.postgres_extensions,
    backup_destinations: PROJECT_CENTER_ALLOWLISTS.backup_destinations,
    postgres_quotas: POSTGRES_QUOTAS,
  })

export function buildPolicySnapshot(
  overrides: Partial<ProjectCenterV2PolicySnapshot> = {},
): ProjectCenterV2PolicySnapshot {
  return Object.freeze({ ...DEFAULT_POLICY_SNAPSHOT, ...overrides })
}

/**
 * Drivers de dry-run registrados. `supabase_isolated` entra no PR 3; enquanto
 * não estiver registrado, selecioná-lo falha com `DRIVER_UNAVAILABLE`
 * (nunca cai em fallback silencioso).
 */
export const DRIVER_REGISTRY: Readonly<Partial<Record<Driver, DryRunDriver>>> =
  Object.freeze({
    [POSTGRESQL_DRIVER_ID]: postgresqlIsolatedDriver,
  })

/**
 * Seleciona o driver de dry-run pelo nome canônico.
 *
 * O registro default é o `DRIVER_REGISTRY` global (PR 2). Um registro
 * alternativo pode ser injetado (ex.: composição da API v2 no PR 4, que
 * precisa dos dois drivers) sem alterar a asserção congelada do PR 2.
 */
export function selectDryRunDriver(
  driver: unknown,
  registry: Readonly<Partial<Record<Driver, DryRunDriver>>> = DRIVER_REGISTRY,
): DryRunDriver {
  const name = typeof driver === 'string' ? driver : String(driver)
  if (!(DRIVERS as ReadonlyArray<string>).includes(name)) {
    throw new DriverUnavailableError(name)
  }
  const registered = registry[name as Driver]
  if (registered === undefined) {
    throw new DriverUnavailableError(name)
  }
  return registered
}

/** Rejeição de política/validação no dry-run (sem side effect). */
export class PlanRejectedError extends Error {
  readonly code: ErrorCode
  readonly issues: ReadonlyArray<DriverValidationIssue>

  constructor(code: ErrorCode, issues: ReadonlyArray<DriverValidationIssue>) {
    super('intencao recusada no dry-run')
    this.name = 'PlanRejectedError'
    this.code = code
    this.issues = issues
  }
}

/** Plano obsoleto: observação, intenção, política ou prazo mudaram. */
export class PlanStaleError extends Error {
  readonly code = 'PLAN_STALE'
  readonly reason: PlanMaterialChangeReason | 'expired'

  constructor(reason: PlanMaterialChangeReason | 'expired') {
    super(`plano obsoleto: ${reason}`)
    this.name = 'PlanStaleError'
    this.reason = reason
  }
}

/** Não determinismo: mesma chave produzindo hashes diferentes (bug interno). */
export class PlanDeterminismError extends Error {
  readonly code = 'INTERNAL_ERROR'

  constructor() {
    super('plano nao deterministico para a mesma chave')
    this.name = 'PlanDeterminismError'
  }
}

export interface PlanRequest {
  readonly intent: ProjectIntent
  readonly observed: ObservedState
  readonly policy?: ProjectCenterV2PolicySnapshot
  readonly flags?: ProjectCenterV2Flags
  /**
   * Registro de drivers de dry-run; default é o global do PR 2. A API v2
   * injeta aqui os dois drivers allowlisted sem mexer na asserção do elo 2.
   */
  readonly drivers?: Readonly<Partial<Record<Driver, DryRunDriver>>>
}

/** Referência persistida de um plano anterior (para reuso idempotente). */
export interface PlanReference {
  readonly plan_key: string
  readonly plan_hash: string
  readonly intent_hash: string
  readonly observed_revision: string
  readonly observed_at: string
  readonly driver: Driver
  readonly driver_version: string
  readonly policy_version: string
  readonly allowlist_version: string
  readonly expires_at: string
}

/** Plano canônico: ações tipadas + identidade completa para o hash. */
export interface CanonicalPlan {
  readonly driver: Driver
  readonly driver_version: string
  readonly naming_version: string
  readonly planner_version: string
  readonly policy_version: string
  readonly allowlist_version: string
  readonly project_id: string
  readonly environment: ProjectIntent['environment']
  readonly host_target: ProjectIntent['host_target']
  readonly observed_revision: string
  readonly observed_at: string
  readonly intent_hash: string
  readonly plan_key: string
  readonly plan_hash: string
  readonly expires_at: string
  readonly plan: Plan
  readonly satisfied_action_ids: ReadonlyArray<string>
}

export type PlanMaterialChangeReason =
  | 'driver_changed'
  | 'policy_changed'
  | 'intent_changed'
  | 'observation_changed'
  | 'observation_timestamp_changed'

export type PlanReuseVerdict =
  | { readonly status: 'identical'; readonly plan_hash: string }
  | { readonly status: 'expired'; readonly plan_hash: string }
  | {
      readonly status: 'material_change'
      readonly reason: PlanMaterialChangeReason
      readonly plan_hash: string
    }

/** Prazo do plano derivado da observação (determinístico, sem relógio). */
export function planExpiry(
  observedAt: string,
  ttlSeconds = PLAN_TTL_SECONDS,
): string {
  const base = Date.parse(observedAt)
  if (!Number.isFinite(base)) {
    throw new PlanRejectedError('INVALID_REQUEST', [
      { field: 'observed_at', reason: 'invalid_timestamp' },
    ])
  }
  return new Date(base + ttlSeconds * 1000).toISOString()
}

export function computeIntentHash(intent: ProjectIntent): string {
  return hashCanonical(projectIntentSchema.parse(intent))
}

/**
 * Chave de idempotência do plano: intenção + observação (conteúdo e carimbo) +
 * política + versões. Mudança material muda a chave e exige nova
 * `Idempotency-Key`; nada é reaproveitado silenciosamente.
 */
export function computePlanKey(input: {
  readonly intent_hash: string
  readonly observed: ObservedState
  readonly policy: ProjectCenterV2PolicySnapshot
  readonly driver: Driver
  readonly driver_version: string
}): string {
  return hashCanonical({
    intent_hash: input.intent_hash,
    observed_revision: input.observed.revision,
    observed_at: input.observed.observed_at,
    project_id: input.observed.project_id,
    environment: input.observed.environment,
    driver: input.driver,
    driver_version: input.driver_version,
    naming_version: NAMING_VERSION,
    planner_version: PLANNER_VERSION,
    policy_version: input.policy.policy_version,
    allowlist_version: input.policy.allowlist_version,
  })
}

function assertPlanGraph(
  actions: DriverPlan['actions'],
  policy: ProjectCenterV2PolicySnapshot,
): void {
  if (
    actions.length === 0 ||
    actions.length > Math.min(policy.max_actions_per_plan, MAX_ACTIONS_PER_PLAN)
  ) {
    throw new PlanRejectedError('INVALID_REQUEST', [
      { field: 'actions', reason: 'action_count_out_of_range' },
    ])
  }
  const indexById = new Map<string, number>()
  actions.forEach((action, index) => {
    if (
      !ACTION_ID_PATTERN.test(action.action_id) ||
      indexById.has(action.action_id)
    ) {
      throw new PlanRejectedError('INVALID_REQUEST', [
        { field: 'actions.action_id', reason: 'invalid_or_duplicate_id' },
      ])
    }
    indexById.set(action.action_id, index)
  })
  actions.forEach((action, index) => {
    if (action.reversible === (action.risk === 'destructive')) {
      throw new PlanRejectedError('INVALID_REQUEST', [
        { field: `actions.${action.kind}`, reason: 'risk_flags_inconsistent' },
      ])
    }
    for (const dependency of action.dependencies) {
      const dependencyIndex = indexById.get(dependency)
      if (dependencyIndex === undefined || dependencyIndex >= index) {
        throw new PlanRejectedError('INVALID_REQUEST', [
          {
            field: `actions.${action.kind}`,
            reason: 'dependency_not_satisfied_before',
          },
        ])
      }
    }
  })
}

/**
 * Compõe o plano canônico de dry-run. Nenhum efeito: apenas validação, naming,
 * hash e política. Flag desligada fecha antes de qualquer trabalho.
 */
export function planProject(request: PlanRequest): CanonicalPlan {
  const flags = request.flags ?? resolveProjectCenterV2Flags()
  requireApiEnabled(flags)

  const intent = projectIntentSchema.parse(request.intent)
  const observed = assertObservedState(request.observed)
  const policy = request.policy ?? DEFAULT_POLICY_SNAPSHOT
  const driver = selectDryRunDriver(
    intent.driver,
    request.drivers ?? DRIVER_REGISTRY,
  )

  const validation = driver.validate(intent, policy)
  if (!validation.ok) {
    throw new PlanRejectedError(validation.code, validation.issues)
  }

  const driverPlan = driver.plan({ intent, observed, policy, flags })
  assertPlanGraph(driverPlan.actions, policy)

  const projectId = projectIdFor(intent.client_id, intent.project_slug)
  const intentHash = computeIntentHash(intent)
  const planKey = computePlanKey({
    intent_hash: intentHash,
    observed,
    policy,
    driver: driver.descriptor.id,
    driver_version: driver.descriptor.version,
  })
  const expiresAt = planExpiry(observed.observed_at, policy.plan_ttl_seconds)
  const actions = driverPlan.actions.map((action) =>
    Object.freeze(assertPlannedActionShape(action)),
  )
  const estimatedResources = Object.freeze({
    ...driverPlan.estimated_resources,
  })
  const warnings = Object.freeze([...driverPlan.warnings])
  const plan: Plan = planSchema.parse({
    policy_version: policy.policy_version,
    actions: [...actions],
    estimated_resources: { ...estimatedResources },
    warnings: [...warnings],
  })
  // Congela em profundidade: um plano em dry-run é imutável por contrato.
  plan.actions.forEach((action) => Object.freeze(action))
  Object.freeze(plan.actions)
  Object.freeze(plan.estimated_resources)
  Object.freeze(plan.warnings)
  Object.freeze(plan)
  const planHash = hashCanonical({
    plan_key: planKey,
    intent_hash: intentHash,
    observed_revision: observed.revision,
    observed_at: observed.observed_at,
    expires_at: expiresAt,
    driver: driver.descriptor.id,
    driver_version: driver.descriptor.version,
    naming_version: NAMING_VERSION,
    planner_version: PLANNER_VERSION,
    policy_version: policy.policy_version,
    allowlist_version: policy.allowlist_version,
    actions,
    estimated_resources: estimatedResources,
    warnings,
  })

  return Object.freeze({
    driver: driver.descriptor.id,
    driver_version: driver.descriptor.version,
    naming_version: NAMING_VERSION,
    planner_version: PLANNER_VERSION,
    policy_version: policy.policy_version,
    allowlist_version: policy.allowlist_version,
    project_id: projectId,
    environment: intent.environment,
    host_target: intent.host_target,
    observed_revision: observed.revision,
    observed_at: observed.observed_at,
    intent_hash: intentHash,
    plan_key: planKey,
    plan_hash: planHash,
    expires_at: expiresAt,
    plan,
    satisfied_action_ids: Object.freeze([...driverPlan.satisfied_action_ids]),
  })
}

/** Referência persistível de um plano (sem ações, sem segredo). */
export function toPlanReference(plan: CanonicalPlan): PlanReference {
  return Object.freeze({
    plan_key: plan.plan_key,
    plan_hash: plan.plan_hash,
    intent_hash: plan.intent_hash,
    observed_revision: plan.observed_revision,
    observed_at: plan.observed_at,
    driver: plan.driver,
    driver_version: plan.driver_version,
    policy_version: plan.policy_version,
    allowlist_version: plan.allowlist_version,
    expires_at: plan.expires_at,
  })
}

function materialChangeReason(
  previous: PlanReference,
  current: CanonicalPlan,
): PlanMaterialChangeReason {
  if (
    previous.driver !== current.driver ||
    previous.driver_version !== current.driver_version
  ) {
    return 'driver_changed'
  }
  if (
    previous.policy_version !== current.policy_version ||
    previous.allowlist_version !== current.allowlist_version
  ) {
    return 'policy_changed'
  }
  if (previous.intent_hash !== current.intent_hash) return 'intent_changed'
  if (previous.observed_revision !== current.observed_revision) {
    return 'observation_changed'
  }
  return 'observation_timestamp_changed'
}

/**
 * Compara um plano anterior com o plano recém-calculado.
 *
 * - `identical`: mesma chave, mesmo hash e ainda dentro do prazo → pode ser
 *   reaproveitado (replay idempotente);
 * - `expired`: mesma chave/hash, prazo vencido → nova aprovação/plano;
 * - `material_change`: a chave mudou → nova `Idempotency-Key` e plano novo.
 *
 * Chave igual com hash diferente é bug de determinismo e falha fechado.
 */
export function comparePlanReuse(
  previous: PlanReference,
  current: CanonicalPlan,
  now: Date,
): PlanReuseVerdict {
  if (previous.plan_key !== current.plan_key) {
    return {
      status: 'material_change',
      reason: materialChangeReason(previous, current),
      plan_hash: current.plan_hash,
    }
  }
  if (previous.plan_hash !== current.plan_hash) {
    throw new PlanDeterminismError()
  }
  if (Date.parse(previous.expires_at) <= now.getTime()) {
    return { status: 'expired', plan_hash: current.plan_hash }
  }
  return { status: 'identical', plan_hash: current.plan_hash }
}

/** Exige plano idêntico e dentro do prazo; qualquer outra coisa é `PLAN_STALE`. */
export function assertPlanReusable(
  previous: PlanReference,
  current: CanonicalPlan,
  now: Date,
): void {
  const verdict = comparePlanReuse(previous, current, now)
  if (verdict.status === 'identical') return
  if (verdict.status === 'expired') throw new PlanStaleError('expired')
  throw new PlanStaleError(verdict.reason)
}

/** Resumo sanitizado do plano para log/auditoria (nunca contém segredo). */
export function describePlan(plan: CanonicalPlan): SafePayload {
  return toSafePayload({
    driver: plan.driver,
    driver_version: plan.driver_version,
    planner_version: plan.planner_version,
    policy_version: plan.policy_version,
    allowlist_version: plan.allowlist_version,
    project_id: plan.project_id,
    environment: plan.environment,
    host_target: plan.host_target,
    observed_revision: plan.observed_revision,
    plan_hash: plan.plan_hash,
    action_count: plan.plan.actions.length,
    actions: plan.plan.actions.map((action) => action.kind).join(','),
    satisfied_action_count: plan.satisfied_action_ids.length,
    expires_at: plan.expires_at,
  })
}
