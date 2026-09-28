/**
 * Driver `supabase_isolated` em dry-run estrito (PR 3).
 *
 * O driver **planeja**: valida a intenção contra política/allowlists, resolve a
 * stack a partir do catálogo compilado (`catalogs/supabase-catalog.ts`) e
 * devolve ações tipadas. Ele não observa (a observação é a porta read-only
 * injetada do observer) e não executa: `execute`/`compensate` são do PR 6.
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §7, §8.3 e §10.
 *
 * Proibido por construção:
 * - imagem sem digest, template/serviço/porta/target fora da allowlist;
 * - hostname, path, rede, porta, volume, mount, imagem ou comando fornecidos
 *   pelo request (recusados como entrada livre antes de qualquer plano);
 * - execução de processo, container, Compose, Docker, filesystem, rede,
 *   banco real, R2 ou credencial real.
 *
 * Cada recurso planejado carrega o **ownership marker esperado** dentro do
 * próprio `target_ref` (`<prefixo>:<nome>#<marker>`) — o contrato não permite
 * campo extra em `PlannedAction`, e assim o marker sobrevive ao plano
 * persistido e à auditoria. O worker do PR 6 só pode adotar recurso cujo
 * marker observado seja exatamente esse.
 */
import {
  SUPABASE_CATALOG_VERSION,
  SUPABASE_DRIFT_FINDINGS,
  SUPABASE_RESOURCE_PROFILES,
  SUPABASE_TEMPLATES,
  assertSupabaseStackProjection,
  emptyStackProjection,
  internalPortFor,
  pinnedImageRefFor,
  profileQuota,
  resolveResourceProfile,
  resolveTemplateFor,
  targetRefFor,
  unsupportedCapabilities,
} from '../catalogs/supabase-catalog'
import { ENVIRONMENTS, PLANNED_ACTION_KINDS } from '../domain'
import {
  requireApiEnabled,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { toSafePayload } from '../redaction'
import {
  CAPABILITY_KEYS,
  DRIVER_ALLOWLIST_VERSION,
  DriverUnavailableError,
  ObservationScopeError,
  assertObservedState,
  assertPlannedActionShape,
  shortDigest,
} from './types'
import type {
  Driver,
  ErrorCode,
  PlannedAction,
  PlannedActionKind,
  ProjectIntent,
  SafePayload,
} from '../domain'
import type { ResourceNamingSnapshot } from '../naming'
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
import type {
  SupabaseDriftFinding,
  SupabaseQuotaField,
  SupabaseResourceProfile,
  SupabaseServiceId,
  SupabaseStackProjection,
  SupabaseTargetKind,
  SupabaseTemplate,
} from '../catalogs/supabase-catalog'

export const SUPABASE_DRIVER_ID: Driver = 'supabase_isolated'
/** Versão fixada no plano; mudança exige plano novo. */
export const SUPABASE_DRIVER_VERSION = 'pcv2-sb-isolated-v1'

/** Capabilities que a stack completa entrega (todas as do contrato). */
export const SUPABASE_PROVIDED_CAPABILITIES: ReadonlyArray<CapabilityKey> =
  Object.freeze([...CAPABILITY_KEYS])

/** Kinds que um plano `supabase_isolated` pode conter. */
const SUPABASE_ACTION_KIND_LIST: ReadonlyArray<PlannedActionKind> = [
  'reserve_project',
  'render_compose_template',
  'create_network',
  'create_data_store',
  'create_database',
  'create_app_role',
  'apply_least_privilege',
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

export const SUPABASE_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  Object.freeze(SUPABASE_ACTION_KIND_LIST)

/**
 * Slots de broker da stack. O nome é **opaco** de propósito: o plano e a
 * auditoria registram apenas o slot, nunca a natureza nem o valor do material.
 *
 * - `stack-signing`: material de assinatura da própria stack;
 * - `client-public`: credencial publicável embutida no cliente;
 * - `client-server`: credencial server-side, nunca no bundle do cliente;
 * - `data-store`: credencial do data store usada pela role app.
 */
export const SUPABASE_BROKER_SLOTS = [
  'stack-signing',
  'client-public',
  'client-server',
  'data-store',
] as const
export type SupabaseBrokerSlot = (typeof SUPABASE_BROKER_SLOTS)[number]

/** Expectativa de least privilege da role app, verificada contra a observação. */
export const SUPABASE_LEAST_PRIVILEGE_EXPECTATIONS: ReadonlyArray<{
  readonly schema_name: string
  readonly privilege: string
}> = Object.freeze([{ schema_name: 'public', privilege: 'USAGE' }])

/** Chaves de entrada livre recusadas em qualquer nível do request. */
export const FORBIDDEN_INPUT_KEYS = [
  'command',
  'argv',
  'args',
  'shell',
  'script',
  'sql',
  'env',
  'environment_variables',
  'secret',
  'secret_value',
  'password',
  'dsn',
  'connection_string',
  'path',
  'paths',
  'host_path',
  'workdir',
  'hostname',
  'host',
  'ip',
  'address',
  'network',
  'network_name',
  'subnet',
  'port',
  'ports',
  'domain',
  'dns',
  'image',
  'images',
  'image_ref',
  'image_digest',
  'tag',
  'digest',
  'repository',
  'registry',
  'compose_file',
  'compose_path',
  'template',
  'template_id',
  'volume',
  'volumes',
  'mount',
  'mounts',
  'entrypoint',
  'user',
  'privileged',
  'cap_add',
  'resources',
  'limits',
] as const

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
    start_stack: {
      risk: 'reversible',
      reversible: true,
      compensation_kind: 'disable_resource',
    },
    health_check: { risk: 'read_only', reversible: true },
    verify_cross_isolation: { risk: 'read_only', reversible: true },
    verify_backup_restore: { risk: 'read_only', reversible: true },
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
  template_not_found: 'POLICY_DENIED',
  host_target_not_allowed: 'POLICY_DENIED',
  environment_not_allowed: 'POLICY_DENIED',
  capability_not_allowed: 'POLICY_DENIED',
  capability_not_provided: 'DRIVER_UNAVAILABLE',
  limit_above_quota: 'QUOTA_EXCEEDED',
  limit_below_minimum: 'INVALID_REQUEST',
  free_form_input: 'INVALID_REQUEST',
})

function pickIssueCode(
  issues: ReadonlyArray<DriverValidationIssue>,
): ErrorCode {
  for (const code of ISSUE_CODE_PRECEDENCE) {
    if (issues.some((issue) => ISSUE_CODES[issue.reason] === code)) return code
  }
  return 'INVALID_REQUEST'
}

/** Guarda de drift do contrato: kind planejável precisa existir no OpenAPI. */
for (const kind of SUPABASE_ACTION_KINDS) {
  if (!(PLANNED_ACTION_KINDS as ReadonlyArray<string>).includes(kind)) {
    throw new DriverUnavailableError(`action_kind:${kind}`)
  }
}

// ---------------------------------------------------------------------------
// Request/plan do driver
// ---------------------------------------------------------------------------

/**
 * Request do planner. Além do contrato comum de dry-run aceita:
 *
 * - `stack`: projeção sanitizada devolvida pelo observer. Ausente = nada
 *   observado (fail-closed: nenhum recurso é assumido existente);
 * - `executor`: **nunca** é usado. Existe apenas para que a injeção acidental
 *   de um adapter de execução seja ignorada (e registrada como aviso) em vez
 *   de abrir um caminho de execução dentro do dry-run.
 */
export interface SupabasePlanRequest extends DriverPlanRequest {
  readonly stack?: SupabaseStackProjection
  readonly executor?: unknown
  readonly template_id?: string
}

/** Pin da stack usado pelo plano (template, versão, perfil e imagens). */
export interface SupabaseStackPin {
  readonly template_id: string
  readonly template_version: string
  readonly catalog_version: string
  readonly profile_id: string
  readonly images: ReadonlyArray<{
    readonly service: string
    readonly ref: string
  }>
  readonly internal_ports: ReadonlyArray<{
    readonly service: string
    readonly port: number
  }>
}

/** Plano do driver: ações tipadas + pin da stack + drift da observação. */
export interface SupabaseDriverPlan extends DriverPlan {
  readonly stack_pin: SupabaseStackPin
  readonly drift_findings: ReadonlyArray<SupabaseDriftFinding>
  /**
   * Recursos planejados com o ownership marker esperado. Redundante com o
   * fragmento `#<marker>` de `target_ref` de propósito: é a forma legível de
   * auditar a expectativa de ownership sem parsear identificadores.
   */
  readonly ownership_expectations: ReadonlyArray<{
    readonly target_ref: string
    readonly ownership_marker: string
  }>
}

/** Rejeição de política/validação no planner (sem side effect). */
export class SupabasePolicyRejectionError extends Error {
  readonly code: ErrorCode
  readonly issues: ReadonlyArray<DriverValidationIssue>

  constructor(code: ErrorCode, issues: ReadonlyArray<DriverValidationIssue>) {
    super('intencao recusada pelo driver supabase_isolated')
    this.name = 'SupabasePolicyRejectionError'
    this.code = code
    this.issues = issues
  }
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

function requestedCapabilities(
  intent: ProjectIntent,
): ReadonlyArray<CapabilityKey> {
  return CAPABILITY_KEYS.filter((capability) => intent.capabilities[capability])
}

function validateCapabilities(
  intent: ProjectIntent,
  policy: ProjectCenterV2PolicySnapshot,
  template: SupabaseTemplate | undefined,
  issues: Array<DriverValidationIssue>,
): void {
  for (const capability of requestedCapabilities(intent)) {
    if (!policy.allowed_capabilities.includes(capability)) {
      issues.push({
        field: `capabilities.${capability}`,
        reason: 'capability_not_allowed',
      })
    }
  }
  if (template === undefined) {
    issues.push({
      field: 'capabilities',
      reason: 'capability_not_provided',
    })
    return
  }
  for (const capability of unsupportedCapabilities(
    intent.capabilities,
    template,
  )) {
    issues.push({
      field: `capabilities.${capability}`,
      reason: 'capability_not_provided',
    })
  }
}

const LIMIT_FIELDS: ReadonlyArray<{
  readonly field: SupabaseQuotaField
  readonly path: string
}> = Object.freeze([
  { field: 'cpu_millicores', path: 'requested_limits.cpu_millicores' },
  { field: 'memory_mb', path: 'requested_limits.memory_mb' },
  { field: 'data_store_mb', path: 'requested_limits.database_size_mb' },
  {
    field: 'backup_retention_days',
    path: 'requested_limits.backup_retention_days',
  },
])

function validateLimits(
  intent: ProjectIntent,
  profile: SupabaseResourceProfile | undefined,
  issues: Array<DriverValidationIssue>,
): void {
  const limits = intent.requested_limits
  if (limits === undefined) return
  if (profile === undefined) {
    issues.push({ field: 'requested_limits', reason: 'limit_above_quota' })
    return
  }
  const values: Readonly<Record<SupabaseQuotaField, number | undefined>> = {
    cpu_millicores: limits.cpu_millicores,
    memory_mb: limits.memory_mb,
    data_store_mb: limits.database_size_mb,
    backup_retention_days: limits.backup_retention_days,
  }
  for (const entry of LIMIT_FIELDS) {
    const value = values[entry.field]
    if (value === undefined) continue
    const quota = profileQuota(profile, entry.field)
    if (value > quota.max) {
      issues.push({ field: entry.path, reason: 'limit_above_quota' })
      continue
    }
    if (value < quota.min) {
      issues.push({ field: entry.path, reason: 'limit_below_minimum' })
    }
  }
}

/**
 * Valida a intenção contra política/allowlists sem tocar em runtime.
 *
 * `templates`/`profiles` são injetáveis apenas para teste: o default é sempre
 * o catálogo compilado (`SUPABASE_TEMPLATES`/`SUPABASE_RESOURCE_PROFILES`).
 */
export function validateSupabaseIntent(
  intent: ProjectIntent,
  policy: ProjectCenterV2PolicySnapshot,
  templates: ReadonlyArray<SupabaseTemplate> = SUPABASE_TEMPLATES,
  profiles: ReadonlyArray<SupabaseResourceProfile> = SUPABASE_RESOURCE_PROFILES,
): DriverValidationResult {
  const issues: Array<DriverValidationIssue> = []
  const warnings: Array<string> = []

  if (intent.driver !== SUPABASE_DRIVER_ID) {
    issues.push({ field: 'driver', reason: 'driver_mismatch' })
  }
  if (!policy.allowed_host_targets.includes(intent.host_target)) {
    issues.push({ field: 'host_target', reason: 'host_target_not_allowed' })
  }
  if (!policy.allowed_environments.includes(intent.environment)) {
    issues.push({ field: 'environment', reason: 'environment_not_allowed' })
  }

  const template = resolveTemplateFor(intent.capabilities, templates)
  validateCapabilities(intent, policy, template, issues)
  validateLimits(
    intent,
    resolveResourceProfile(intent.requested_limits, profiles),
    issues,
  )

  if (issues.length > 0) {
    return { ok: false, code: pickIssueCode(issues), issues }
  }
  if (template !== undefined) {
    warnings.push(
      `template ${template.template_id}@${template.version} selecionado pelo catalogo`,
    )
  }
  if (intent.environment === 'production') {
    warnings.push('ambiente de producao exige aprovacao humana segregada')
  }
  return { ok: true, warnings }
}

/**
 * Recusa entrada livre. Hostname, path, rede, porta, volume, imagem, comando
 * ou template vindos do request nunca viram plano: a stack só é descrita pelo
 * catálogo e pelo naming server-side.
 */
function assertNoFreeFormInput(request: SupabasePlanRequest): void {
  const issues: Array<DriverValidationIssue> = []
  const forbidden = (key: string): boolean =>
    (FORBIDDEN_INPUT_KEYS as ReadonlyArray<string>).includes(key)
  for (const key of Object.keys(request)) {
    if (key === 'executor' || key === 'stack') continue
    if (forbidden(key)) {
      issues.push({ field: key, reason: 'free_form_input' })
    }
  }
  const rawIntent = request.intent as unknown as Record<string, unknown>
  for (const key of Object.keys(rawIntent)) {
    if (forbidden(key)) {
      issues.push({ field: `intent.${key}`, reason: 'free_form_input' })
    }
  }
  if (issues.length > 0) {
    throw new SupabasePolicyRejectionError('INVALID_REQUEST', issues)
  }
}

/**
 * A observação precisa pertencer ao mesmo escopo do plano (driver, versão,
 * projeto e ambiente). Observação de outro escopo é plano obsoleto.
 */
function scopeChecks(
  intent: ProjectIntent,
  observed: ObservedState,
  expectedProjectId: string,
): void {
  if (observed.driver !== SUPABASE_DRIVER_ID) {
    throw new ObservationScopeError('driver')
  }
  if (observed.driver_version !== SUPABASE_DRIVER_VERSION) {
    throw new ObservationScopeError('driver_version')
  }
  if (observed.project_id !== expectedProjectId) {
    throw new ObservationScopeError('project_id')
  }
  if (observed.environment !== intent.environment) {
    throw new ObservationScopeError('environment')
  }
}

// ---------------------------------------------------------------------------
// Planejamento
// ---------------------------------------------------------------------------

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

function leastPrivilegeSatisfied(observed: ObservedState): boolean {
  return SUPABASE_LEAST_PRIVILEGE_EXPECTATIONS.every((expectation) =>
    observed.privileges.some(
      (privilege) =>
        privilege.role_name === observed.app_role.name &&
        privilege.schema_name === expectation.schema_name &&
        privilege.privilege === expectation.privilege &&
        !privilege.grantable,
    ),
  )
}

function appRoleIsPrivileged(observed: ObservedState): boolean {
  return (
    observed.app_role.is_superuser ||
    observed.app_role.can_create_db ||
    observed.app_role.can_create_role ||
    observed.app_role.can_replicate ||
    observed.app_role.bypass_rls
  )
}

function estimateResources(
  intent: ProjectIntent,
  profile: SupabaseResourceProfile,
): EstimatedResources {
  const limits = intent.requested_limits
  const dataStoreSize =
    limits?.database_size_mb ?? profile.data_store_mb.default
  const retention =
    limits?.backup_retention_days ?? profile.backup_retention_days.default
  return {
    database_size_mb: dataStoreSize,
    memory_mb: limits?.memory_mb ?? profile.memory_mb.default,
    cpu_millicores: limits?.cpu_millicores ?? profile.cpu_millicores.default,
    // Estimativa do dump local + metadados do catalogo de backup.
    local_backup_mb: Math.ceil(dataStoreSize * 0.5) + retention,
  }
}

function stackPinFor(input: {
  readonly template: SupabaseTemplate
  readonly profile: SupabaseResourceProfile
}): SupabaseStackPin {
  return Object.freeze({
    template_id: input.template.template_id,
    template_version: input.template.version,
    catalog_version: SUPABASE_CATALOG_VERSION,
    profile_id: input.profile.profile_id,
    images: Object.freeze(
      input.template.services.map((service: SupabaseServiceId) =>
        Object.freeze({
          service,
          ref: pinnedImageRefFor(service),
        }),
      ),
    ),
    internal_ports: Object.freeze(
      input.template.services.map((service: SupabaseServiceId) =>
        Object.freeze({ service, port: internalPortFor(service) }),
      ),
    ),
  })
}

interface ActionDraft {
  readonly key: string
  readonly kind: PlannedActionKind
  readonly targetKind: SupabaseTargetKind
  readonly targetName: string
  readonly dependencies: ReadonlyArray<string>
  readonly satisfied: boolean
}

function buildDrafts(input: {
  readonly observed: ObservedState
  readonly stack: SupabaseStackProjection
  readonly naming: ResourceNamingSnapshot
  readonly template: SupabaseTemplate
}): ReadonlyArray<ActionDraft> {
  const { observed, stack, naming, template } = input
  const composeSatisfied =
    stack.compose_project.exists &&
    stack.compose_project.ownership_verified &&
    stack.template_id === template.template_id &&
    stack.template_version === template.version
  const networkSatisfied =
    stack.network.exists &&
    stack.network.ownership_verified &&
    !stack.drift_findings.includes('shared_network')
  const dataStoreSatisfied =
    stack.data_store.exists &&
    stack.data_store.ownership_verified &&
    !stack.drift_findings.includes('shared_data_store') &&
    !stack.drift_findings.includes('capacity_exceeded')
  const appRoleSatisfied =
    observed.app_role.exists && !appRoleIsPrivileged(observed)
  const bindingSatisfied = (slot: SupabaseBrokerSlot): boolean =>
    stack.broker_bindings.some(
      (binding) =>
        binding.name === `${naming.compose_project}:${slot}` &&
        binding.exists &&
        !binding.shared_with_other_project,
    )
  const stackSatisfied =
    stack.template_complete &&
    !stack.drift_findings.includes('service_unhealthy')

  return Object.freeze([
    {
      key: 'reserve',
      kind: 'reserve_project',
      targetKind: 'registry',
      targetName: naming.project_id,
      dependencies: [],
      // O registry é estado de control plane: não é observado por esta porta.
      satisfied: false,
    },
    {
      key: 'compose',
      kind: 'render_compose_template',
      targetKind: 'compose-project',
      targetName: naming.compose_project,
      dependencies: ['reserve'],
      satisfied: composeSatisfied,
    },
    {
      key: 'network',
      kind: 'create_network',
      targetKind: 'network',
      targetName: naming.network,
      dependencies: ['compose'],
      satisfied: networkSatisfied,
    },
    {
      key: 'store',
      kind: 'create_data_store',
      targetKind: 'data-store',
      targetName: naming.data_store,
      dependencies: ['network'],
      satisfied: dataStoreSatisfied,
    },
    {
      key: 'database',
      kind: 'create_database',
      targetKind: 'database',
      targetName: naming.database,
      dependencies: ['store'],
      satisfied: dataStoreSatisfied,
    },
    {
      key: 'role',
      kind: 'create_app_role',
      targetKind: 'app-role',
      targetName: naming.app_role,
      dependencies: ['database'],
      satisfied: appRoleSatisfied,
    },
    {
      key: 'grant',
      kind: 'apply_least_privilege',
      targetKind: 'grant',
      targetName: naming.app_role,
      dependencies: ['role'],
      satisfied: appRoleSatisfied && leastPrivilegeSatisfied(observed),
    },
    ...SUPABASE_BROKER_SLOTS.map<ActionDraft>((slot) => ({
      key: `slot-${slot}`,
      kind: 'create_secret_ref',
      targetKind: 'broker-binding',
      targetName: `${naming.compose_project}:${slot}`,
      dependencies: ['role'],
      satisfied: bindingSatisfied(slot),
    })),
    {
      key: 'start',
      kind: 'start_stack',
      targetKind: 'stack',
      targetName: naming.compose_project,
      dependencies: ['store', 'role', 'grant'],
      satisfied: stackSatisfied,
    },
    {
      key: 'health',
      kind: 'health_check',
      targetKind: 'health',
      targetName: naming.compose_project,
      dependencies: ['start'],
      // Verificação sempre roda: nunca é presumida saudável.
      satisfied: false,
    },
    {
      key: 'isolation',
      kind: 'verify_cross_isolation',
      targetKind: 'verification',
      targetName: 'cross-isolation',
      dependencies: ['health'],
      satisfied: false,
    },
    {
      key: 'backup',
      kind: 'configure_backup',
      targetKind: 'backup-policy',
      targetName: naming.local_backup_prefix,
      dependencies: ['store', 'role'],
      satisfied: observed.backup_artifacts.length > 0,
    },
    {
      key: 'r2',
      kind: 'configure_r2_prefix',
      targetKind: 'r2-prefix',
      targetName: naming.r2_prefix,
      dependencies: ['backup'],
      satisfied: false,
    },
    {
      key: 'restore',
      kind: 'verify_backup_restore',
      targetKind: 'restore-test',
      targetName: naming.local_backup_prefix,
      dependencies: ['backup', 'r2'],
      satisfied: false,
    },
    {
      key: 'registry',
      kind: 'publish_registry',
      targetKind: 'registry-record',
      targetName: naming.project_id,
      dependencies: ['isolation', 'restore'],
      satisfied: false,
    },
    {
      key: 'context',
      kind: 'publish_platform_context',
      targetKind: 'platform-context',
      targetName: naming.project_id,
      dependencies: ['registry'],
      satisfied: false,
    },
  ])
}

/**
 * Planeja as ações tipadas da stack isolada. Não executa nada, não abre
 * conexão, não emite credencial e **ignora** qualquer adapter de execução que
 * tenha sido injetado por engano no request.
 */
export function planSupabaseActions(
  request: SupabasePlanRequest,
): SupabaseDriverPlan {
  const flags = request.flags ?? resolveProjectCenterV2Flags()
  requireApiEnabled(flags)
  assertNoFreeFormInput(request)

  const { intent, policy } = request
  const observed = assertObservedState(request.observed)
  const naming = buildNamingSnapshot(intent)

  // 1. A intenção precisa ser aceita pela política vigente.
  const validation = validateSupabaseIntent(intent, policy)
  if (!validation.ok) {
    throw new SupabasePolicyRejectionError(validation.code, validation.issues)
  }
  // 2. A observação precisa pertencer ao mesmo escopo.
  scopeChecks(intent, observed, naming.project_id)

  const template = resolveTemplateFor(intent.capabilities)
  if (template === undefined) {
    throw new SupabasePolicyRejectionError('DRIVER_UNAVAILABLE', [
      { field: 'capabilities', reason: 'capability_not_provided' },
    ])
  }
  const profile = resolveResourceProfile(intent.requested_limits)
  if (profile === undefined) {
    throw new SupabasePolicyRejectionError('QUOTA_EXCEEDED', [
      { field: 'requested_limits', reason: 'limit_above_quota' },
    ])
  }

  const stack =
    request.stack === undefined
      ? emptyStackProjection({
          compose_project: naming.compose_project,
          network: naming.network,
          data_store: naming.data_store,
          expected_template_id: template.template_id,
        })
      : assertSupabaseStackProjection(request.stack)
  if (
    stack.compose_project.name !== naming.compose_project ||
    stack.network.name !== naming.network ||
    stack.data_store.name !== naming.data_store
  ) {
    throw new ObservationScopeError('compose_project')
  }
  if (stack.expected_template_id !== template.template_id) {
    throw new ObservationScopeError('template')
  }

  const warnings: Array<string> = [...validation.warnings, ...observed.warnings]
  if (request.executor !== undefined) {
    // Nenhum caminho de execução existe neste PR: o adapter é descartado.
    warnings.push('adapter de execucao ignorado no dry-run')
  }
  if (stack.drift_findings.length > 0) {
    warnings.push(`drift observado: ${stack.drift_findings.join(',')}`)
  }
  if (!stack.ownership_verified && stack.compose_project.exists) {
    warnings.push('stack observada sem ownership marker compativel')
  }
  if (observed.backup_artifacts.length > 0) {
    warnings.push('configure_backup ja possui artefato observado')
  }

  const drafts = buildDrafts({ observed, stack, naming, template })
  const idByKey = new Map<string, string>()
  drafts.forEach((draft, index) => {
    const targetRef = targetRefFor({
      kind: draft.targetKind,
      name: draft.targetName,
      ownership_marker: naming.ownership_marker,
    })
    idByKey.set(
      draft.key,
      actionIdFor({
        project_id: naming.project_id,
        kind: draft.kind,
        target_ref: targetRef,
        index,
      }),
    )
  })

  const actions: Array<PlannedAction> = []
  const satisfied: Array<string> = []
  const ownershipExpectations: Array<{
    target_ref: string
    ownership_marker: string
  }> = []
  drafts.forEach((draft) => {
    const actionProfile = ACTION_PROFILES[draft.kind]
    const targetRef = targetRefFor({
      kind: draft.targetKind,
      name: draft.targetName,
      ownership_marker: naming.ownership_marker,
    })
    const action: PlannedAction = {
      action_id: idByKey.get(draft.key) ?? '',
      kind: draft.kind,
      target_ref: targetRef,
      risk: actionProfile.risk,
      reversible: actionProfile.reversible,
      ...(actionProfile.compensation_kind === undefined
        ? {}
        : { compensation_kind: actionProfile.compensation_kind }),
      dependencies: draft.dependencies.map(
        (dependency) => idByKey.get(dependency) ?? '',
      ),
    }
    const validated = assertPlannedActionShape(action)
    actions.push(Object.freeze(validated))
    ownershipExpectations.push({
      target_ref: targetRef,
      ownership_marker: naming.ownership_marker,
    })
    if (draft.satisfied) satisfied.push(action.action_id)
  })

  const stackPin = stackPinFor({ template, profile })

  return Object.freeze({
    actions: Object.freeze(actions),
    estimated_resources: Object.freeze(estimateResources(intent, profile)),
    warnings: Object.freeze(warnings.slice(0, 50)),
    satisfied_action_ids: Object.freeze(satisfied),
    stack_pin: stackPin,
    drift_findings: Object.freeze([...stack.drift_findings]),
    ownership_expectations: Object.freeze(
      ownershipExpectations.map((expectation) => Object.freeze(expectation)),
    ),
  })
}

export const supabaseDriverDescriptor: DriverDescriptor = Object.freeze({
  id: SUPABASE_DRIVER_ID,
  version: SUPABASE_DRIVER_VERSION,
  environments: ENVIRONMENTS,
  provided_capabilities: SUPABASE_PROVIDED_CAPABILITIES,
  actions: SUPABASE_ACTION_KINDS,
})

/**
 * Driver de dry-run. Sem `execute`, sem `compensate`, sem `observe`: a
 * observação vem por porta injetada e a execução é do PR 6.
 */
export const supabaseIsolatedDriver: DryRunDriver = Object.freeze({
  descriptor: supabaseDriverDescriptor,
  validate: validateSupabaseIntent,
  plan: (request: DriverPlanRequest): DriverPlan =>
    planSupabaseActions(request),
  sanitize: (detail: unknown): SafePayload =>
    toSafePayload(detail as Record<string, unknown> | undefined, {
      maxProperties: 30,
    }),
})

/**
 * Registro **local** do driver. O registro global do planner
 * (`DRIVER_REGISTRY`) é do PR 2 e continua com apenas `postgresql_isolated`;
 * a inclusão do Supabase neste PR invalidaria asserções já congeladas do elo
 * anterior (ver handoff). Qualquer outro nome — inclusive o modo de schema
 * compartilhado, recusado no elo 1 — falha como driver não selecionável, sem
 * fallback silencioso.
 */
export const SUPABASE_DRIVER_REGISTRY: Readonly<
  Partial<Record<string, DryRunDriver>>
> = Object.freeze({
  [SUPABASE_DRIVER_ID]: supabaseIsolatedDriver,
})

export function selectSupabaseDriver(driver: unknown): DryRunDriver {
  const name = typeof driver === 'string' ? driver : String(driver)
  const registered = SUPABASE_DRIVER_REGISTRY[name]
  if (registered === undefined) throw new DriverUnavailableError(name)
  return registered
}

/** Allowlist versionada usada por este driver (auditoria do plano). */
export const SUPABASE_ALLOWLIST_VERSION = DRIVER_ALLOWLIST_VERSION

/** Achados de drift aceitos pelo plano (reexport do catálogo para auditoria). */
export const SUPABASE_PLAN_DRIFT_FINDINGS = SUPABASE_DRIFT_FINDINGS
