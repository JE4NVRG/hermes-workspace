/**
 * Driver `postgresql_isolated` em dry-run estrito (PR 2).
 *
 * O driver **planeja**: valida a intenção contra a política, resolve os nomes
 * server-side e devolve ações tipadas. Ele não observa (a observação é uma
 * porta read-only injetada) e não executa — `execute`/`compensate` são do PR 6.
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §7, §8.2 e §10.
 * Proibido por construção: DDL, Docker, R2, banco real, credencial, SQL/shell
 * livre, path absoluto e bind público. Nenhum campo de command/argv/sql/env/
 * secret entra em ação planejada.
 */
import { ENVIRONMENTS } from '../domain'
import {
  requireApiEnabled,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import {
  appRoleNameFor,
  buildNamingSnapshot,
  resolveResourceName,
} from '../naming'
import { toSafePayload } from '../redaction'
import {
  DRIVER_ALLOWLIST_VERSION,
  ObservationScopeError,
  POSTGRESQL_ACTION_KINDS,
  assertObservedState,
  assertPlannedActionShape,
  shortDigest,
} from './types'
import type { DesiredResource, ExistingResource } from '../naming'
import type {
  Driver,
  ErrorCode,
  PlannedAction,
  PlannedActionKind,
  ProjectIntent,
  SafePayload,
} from '../domain'
import type {
  CapabilityKey,
  DriverDescriptor,
  DriverPlan,
  DriverPlanRequest,
  DriverValidationIssue,
  DriverValidationResult,
  DryRunDriver,
  EstimatedResources,
  ObservedState,
  ProjectCenterV2PolicySnapshot,
} from './types'

export const POSTGRESQL_DRIVER_ID: Driver = 'postgresql_isolated'
/** Versão fixada no plano; mudança exige plano novo (dry-run é versionado). */
export const POSTGRESQL_DRIVER_VERSION = 'pcv2-pg-isolated-v1'

/** Capabilities que este driver entrega. Stack completa é do Supabase (PR 3). */
const PROVIDED_CAPABILITIES: ReadonlyArray<CapabilityKey> = Object.freeze([
  'backup',
])

/** Capabilities que exigem outro driver (stack dedicada). */
const STACK_CAPABILITIES: ReadonlyArray<CapabilityKey> = Object.freeze([
  'auth',
  'storage',
  'realtime',
  'postgrest',
])

/**
 * Expectativa de least privilege do app role, verificada contra a observação.
 * É dado compilado (template interno), nunca SQL recebido do request.
 */
export const LEAST_PRIVILEGE_EXPECTATIONS: ReadonlyArray<{
  readonly schema_name: string
  readonly privilege: string
}> = Object.freeze([{ schema_name: 'public', privilege: 'USAGE' }])

/** Perfil de risco/compensação por ação planejada. */
interface ActionProfile {
  readonly risk: PlannedAction['risk']
  readonly reversible: boolean
  readonly compensation_kind?: string
}

const ACTION_PROFILES: Readonly<Record<PlannedActionKind, ActionProfile>> =
  Object.freeze({
    reserve_project: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'release_reservation',
    },
    create_database: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'drop_resource_created_by_operation',
    },
    create_app_role: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'drop_resource_created_by_operation',
    },
    apply_least_privilege: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'revoke_privileges',
    },
    create_secret_ref: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    configure_backup: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    configure_r2_prefix: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    render_compose_template: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    create_network: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'drop_resource_created_by_operation',
    },
    create_data_store: {
      risk: 'destructive',
      reversible: false,
    },
    start_stack: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    health_check: { risk: 'read_only', reversible: true },
    verify_cross_isolation: { risk: 'read_only', reversible: true },
    verify_backup_restore: { risk: 'read_only', reversible: true },
    publish_registry: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    publish_platform_context: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    disable_resource: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    drop_resource_created_by_operation: {
      risk: 'destructive',
      reversible: false,
    },
  })

/** Precedência de código de erro para issues de validação (falha fechada). */
const ISSUE_CODE_PRECEDENCE: ReadonlyArray<ErrorCode> = Object.freeze([
  'POLICY_DENIED',
  'DRIVER_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'INVALID_REQUEST',
])

const ISSUE_CODES: Readonly<Record<string, ErrorCode>> = Object.freeze({
  driver_mismatch: 'DRIVER_UNAVAILABLE',
  host_target_not_allowed: 'POLICY_DENIED',
  environment_not_allowed: 'POLICY_DENIED',
  capability_not_provided: 'DRIVER_UNAVAILABLE',
  limit_above_quota: 'QUOTA_EXCEEDED',
  limit_below_minimum: 'INVALID_REQUEST',
})

function pickIssueCode(
  issues: ReadonlyArray<DriverValidationIssue>,
): ErrorCode {
  for (const code of ISSUE_CODE_PRECEDENCE) {
    if (issues.some((issue) => ISSUE_CODES[issue.reason] === code)) return code
  }
  return 'INVALID_REQUEST'
}

function actionIdFor(input: {
  readonly project_id: string
  readonly kind: PlannedActionKind
  readonly target_ref: string
  readonly index: number
}): string {
  const slug = input.kind.replaceAll('_', '-')
  const digest = shortDigest({
    project_id: input.project_id,
    kind: input.kind,
    target_ref: input.target_ref,
    index: input.index,
  })
  return `act_${slug}-${digest}`
}

interface ActionDraft {
  readonly kind: PlannedActionKind
  readonly target_ref: string
  readonly dependencyKinds: ReadonlyArray<PlannedActionKind>
}

function validateCapabilities(
  intent: ProjectIntent,
  issues: Array<DriverValidationIssue>,
): void {
  for (const capability of STACK_CAPABILITIES) {
    if (intent.capabilities[capability]) {
      issues.push({
        field: `capabilities.${capability}`,
        reason: 'capability_not_provided',
      })
    }
  }
}

function validateLimits(
  intent: ProjectIntent,
  policy: ProjectCenterV2PolicySnapshot,
  issues: Array<DriverValidationIssue>,
): void {
  const limits = intent.requested_limits
  if (limits === undefined) return
  const quotas = policy.postgres_quotas
  const entries: ReadonlyArray<{
    readonly value: number | undefined
    readonly reason: string
    readonly quota: { readonly min: number; readonly max: number }
  }> = [
    {
      value: limits.database_size_mb,
      reason: 'limit_above_quota',
      quota: quotas.database_size_mb,
    },
    {
      value: limits.memory_mb,
      reason: 'limit_above_quota',
      quota: quotas.memory_mb,
    },
    {
      value: limits.cpu_millicores,
      reason: 'limit_above_quota',
      quota: quotas.cpu_millicores,
    },
    {
      value: limits.backup_retention_days,
      reason: 'limit_above_quota',
      quota: quotas.backup_retention_days,
    },
  ]
  const fields: ReadonlyArray<string> = [
    'database_size_mb',
    'memory_mb',
    'cpu_millicores',
    'backup_retention_days',
  ]
  entries.forEach((entry, index) => {
    if (entry.value === undefined) return
    if (entry.value > entry.quota.max) {
      issues.push({
        field: `requested_limits.${fields[index]}`,
        reason: 'limit_above_quota',
      })
      return
    }
    if (entry.value < entry.quota.min) {
      issues.push({
        field: `requested_limits.${fields[index]}`,
        reason: 'limit_below_minimum',
      })
    }
  })
}

function estimateResources(
  intent: ProjectIntent,
  policy: ProjectCenterV2PolicySnapshot,
): EstimatedResources {
  const quotas = policy.postgres_quotas
  const limits = intent.requested_limits
  const databaseSize =
    limits?.database_size_mb ?? quotas.database_size_mb.default
  const retention =
    limits?.backup_retention_days ?? quotas.backup_retention_days.default
  const estimated: EstimatedResources = {
    database_size_mb: databaseSize,
    memory_mb: limits?.memory_mb ?? quotas.memory_mb.default,
    cpu_millicores: limits?.cpu_millicores ?? quotas.cpu_millicores.default,
    // Estimativa do dump local + metadados do catalogo de backup.
    local_backup_mb: Math.ceil(databaseSize * 0.5) + retention,
  }
  return estimated
}

/**
 * A observação precisa pertencer ao mesmo escopo do plano.
 *
 * `host_target` não aparece aqui porque é estruturalmente único: o contrato
 * define um único identificador de allowlist (`HOST_TARGETS`), o
 * `observedStateSchema` só aceita esse valor e `validatePostgresqlIntent` já
 * recusou qualquer host fora da política antes de chegar neste ponto.
 */
function scopeChecks(
  intent: ProjectIntent,
  observed: ObservedState,
  expectedProjectId: string,
): void {
  if (observed.driver !== POSTGRESQL_DRIVER_ID) {
    throw new ObservationScopeError('driver')
  }
  if (observed.driver_version !== POSTGRESQL_DRIVER_VERSION) {
    throw new ObservationScopeError('driver_version')
  }
  if (observed.project_id !== expectedProjectId) {
    throw new ObservationScopeError('project_id')
  }
  if (observed.environment !== intent.environment) {
    throw new ObservationScopeError('environment')
  }
}

function existingResources(
  observed: ObservedState,
  namingOwnershipMarker: string,
): Array<ExistingResource> {
  const existing: Array<ExistingResource> = []
  if (observed.database.exists) {
    existing.push({
      name: observed.database.name,
      project_id: observed.project_id,
      driver: observed.driver,
      environment: observed.environment,
      ownership_marker: observed.database.ownership_marker,
    })
  }
  if (observed.app_role.exists) {
    existing.push({
      name: observed.app_role.name,
      project_id: observed.project_id,
      driver: observed.driver,
      environment: observed.environment,
      // A role só é adotada quando a observação prove ownership compatível.
      ownership_marker: observed.ownership_verified
        ? namingOwnershipMarker
        : null,
    })
  }
  return existing
}

function leastPrivilegeSatisfied(observed: ObservedState): boolean {
  return LEAST_PRIVILEGE_EXPECTATIONS.every((expectation) =>
    observed.privileges.some(
      (privilege) =>
        privilege.role_name === observed.app_role.name &&
        privilege.schema_name === expectation.schema_name &&
        privilege.privilege === expectation.privilege &&
        !privilege.grantable,
    ),
  )
}

export const postgresqlDriverDescriptor: DriverDescriptor = Object.freeze({
  id: POSTGRESQL_DRIVER_ID,
  version: POSTGRESQL_DRIVER_VERSION,
  environments: ENVIRONMENTS,
  provided_capabilities: PROVIDED_CAPABILITIES,
  actions: POSTGRESQL_ACTION_KINDS,
})

/** Valida a intenção contra política/allowlists sem tocar em runtime. */
export function validatePostgresqlIntent(
  intent: ProjectIntent,
  policy: ProjectCenterV2PolicySnapshot,
): DriverValidationResult {
  const issues: Array<DriverValidationIssue> = []
  const warnings: Array<string> = []

  if (intent.driver !== POSTGRESQL_DRIVER_ID) {
    issues.push({ field: 'driver', reason: 'driver_mismatch' })
  }
  if (!policy.allowed_host_targets.includes(intent.host_target)) {
    issues.push({ field: 'host_target', reason: 'host_target_not_allowed' })
  }
  if (!policy.allowed_environments.includes(intent.environment)) {
    issues.push({ field: 'environment', reason: 'environment_not_allowed' })
  }
  validateCapabilities(intent, issues)
  validateLimits(intent, policy, issues)

  if (issues.length > 0) {
    return { ok: false, code: pickIssueCode(issues), issues }
  }
  if (intent.environment === 'production') {
    warnings.push('ambiente de producao exige aprovacao humana segregada')
  }
  return { ok: true, warnings }
}

/** Planeja as ações tipadas; não executa nada e não abre conexão. */
export function planPostgresqlActions(request: DriverPlanRequest): DriverPlan {
  const flags = request.flags ?? resolveProjectCenterV2Flags()
  requireApiEnabled(flags)

  const { intent, policy } = request
  const observed = assertObservedState(request.observed)
  const naming = buildNamingSnapshot(intent)

  // 1. A intenção precisa ser aceita pela política vigente.
  const validation = validatePostgresqlIntent(intent, policy)
  if (!validation.ok) {
    throw new PostgresPolicyRejectionError(validation.code, validation.issues)
  }
  // 2. A observação precisa pertencer ao mesmo escopo (driver/versão/projeto/
  //    ambiente). Observação de escopo errado é plano obsoleto.
  scopeChecks(intent, observed, naming.project_id)

  const desiredDatabase: DesiredResource = {
    name: naming.database,
    project_id: naming.project_id,
    driver: POSTGRESQL_DRIVER_ID,
    environment: intent.environment,
    ownership_marker: naming.ownership_marker,
  }
  const desiredAppRole: DesiredResource = {
    ...desiredDatabase,
    name: naming.app_role,
  }
  const existing = existingResources(observed, naming.ownership_marker)
  const databaseResolution = resolveResourceName(desiredDatabase, existing)
  const appRoleResolution = resolveResourceName(desiredAppRole, existing)

  const warnings: Array<string> = [...validation.warnings, ...observed.warnings]
  const satisfied: Array<string> = []
  if (databaseResolution.status === 'already_satisfied') {
    warnings.push('create_database ja satisfeito pelo estado observado')
  }
  if (appRoleResolution.status === 'already_satisfied') {
    warnings.push('create_app_role ja satisfeito pelo estado observado')
  }
  if (leastPrivilegeSatisfied(observed)) {
    warnings.push('apply_least_privilege ja satisfeito pelo estado observado')
  }
  if (observed.unsafe_findings.length > 0) {
    warnings.push(
      `achados de seguranca observados: ${observed.unsafe_findings.join(',')}`,
    )
  }
  if (observed.backup_artifacts.length > 0) {
    warnings.push('configure_backup ja possui artefato observado')
  }

  const drafts: ReadonlyArray<ActionDraft> = [
    {
      kind: 'reserve_project',
      target_ref: `registry:${naming.project_id}`,
      dependencyKinds: [],
    },
    {
      kind: 'create_database',
      target_ref: `database:${naming.database}`,
      dependencyKinds: ['reserve_project'],
    },
    {
      kind: 'create_app_role',
      target_ref: `role:${naming.app_role}`,
      dependencyKinds: ['create_database'],
    },
    {
      kind: 'apply_least_privilege',
      target_ref: `grant:${naming.database}:${naming.app_role}`,
      dependencyKinds: ['create_app_role'],
    },
    {
      kind: 'create_secret_ref',
      target_ref: `secret-ref:${naming.project_id}:app-role`,
      dependencyKinds: ['create_app_role'],
    },
    {
      kind: 'configure_backup',
      target_ref: `backup-policy:${naming.local_backup_prefix}`,
      dependencyKinds: ['create_database', 'create_app_role'],
    },
    {
      kind: 'configure_r2_prefix',
      target_ref: `r2-prefix:${naming.r2_prefix}`,
      dependencyKinds: ['configure_backup'],
    },
    {
      kind: 'verify_cross_isolation',
      target_ref: 'verification:cross-isolation',
      dependencyKinds: ['apply_least_privilege'],
    },
    {
      kind: 'verify_backup_restore',
      target_ref: 'verification:backup-restore',
      dependencyKinds: ['configure_backup', 'configure_r2_prefix'],
    },
    {
      kind: 'publish_registry',
      target_ref: `registry-record:${naming.project_id}`,
      dependencyKinds: ['verify_cross_isolation', 'verify_backup_restore'],
    },
    {
      kind: 'publish_platform_context',
      target_ref: `platform-context:${naming.project_id}`,
      dependencyKinds: ['publish_registry'],
    },
  ]

  const actions: Array<PlannedAction> = []
  const idByKind = new Map<PlannedActionKind, string>()
  drafts.forEach((draft, index) => {
    const actionId = actionIdFor({
      project_id: naming.project_id,
      kind: draft.kind,
      target_ref: draft.target_ref,
      index,
    })
    idByKind.set(draft.kind, actionId)
  })
  drafts.forEach((draft) => {
    const profile = ACTION_PROFILES[draft.kind]
    const action: PlannedAction = {
      action_id: idByKind.get(draft.kind) ?? '',
      kind: draft.kind,
      target_ref: draft.target_ref,
      risk: profile.risk,
      reversible: profile.reversible,
      ...(profile.compensation_kind === undefined
        ? {}
        : { compensation_kind: profile.compensation_kind }),
      dependencies: draft.dependencyKinds.map(
        (dependency) => idByKind.get(dependency) ?? '',
      ),
    }
    const validated = assertPlannedActionShape(action)
    actions.push(Object.freeze(validated))
    if (
      (draft.kind === 'create_database' &&
        databaseResolution.status === 'already_satisfied') ||
      (draft.kind === 'create_app_role' &&
        appRoleResolution.status === 'already_satisfied') ||
      (draft.kind === 'apply_least_privilege' &&
        leastPrivilegeSatisfied(observed))
    ) {
      satisfied.push(action.action_id)
    }
  })

  return Object.freeze({
    actions: Object.freeze(actions),
    estimated_resources: Object.freeze(estimateResources(intent, policy)),
    warnings: Object.freeze(warnings.slice(0, 50)),
    satisfied_action_ids: Object.freeze(satisfied),
  })
}

/** Rejeição de política/validação no planner (sem side effect). */
export class PostgresPolicyRejectionError extends Error {
  readonly code: ErrorCode
  readonly issues: ReadonlyArray<DriverValidationIssue>

  constructor(code: ErrorCode, issues: ReadonlyArray<DriverValidationIssue>) {
    super('intencao recusada pelo driver postgresql_isolated')
    this.name = 'PostgresPolicyRejectionError'
    this.code = code
    this.issues = issues
  }
}

/**
 * Driver de dry-run. Sem `execute`, sem `compensate`, sem `observe`: a
 * observação vem por porta injetada e a execução é do PR 6.
 */
export const postgresqlIsolatedDriver: DryRunDriver = Object.freeze({
  descriptor: postgresqlDriverDescriptor,
  validate: validatePostgresqlIntent,
  plan: planPostgresqlActions,
  sanitize: (detail: unknown): SafePayload =>
    toSafePayload(detail as Record<string, unknown> | undefined, {
      maxProperties: 30,
    }),
})

/** Allowlist versionada usada por este driver (auditoria do plano). */
export const POSTGRESQL_ALLOWLIST_VERSION = DRIVER_ALLOWLIST_VERSION
