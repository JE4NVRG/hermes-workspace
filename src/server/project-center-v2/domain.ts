/**
 * Domínio tipado do Project Center v2 (PR 1).
 *
 * Tipos Zod espelhando `specs/contracts/project-center-v2.openapi.yaml`, sem
 * I/O e sem efeitos. Nenhum schema aceita `additionalProperties`: payload
 * desconhecido é recusado, nunca ignorado.
 *
 * Catálogo fechado de erros, redaction e stores vivem em módulos irmãos; este
 * arquivo é a única superfície que descreve o formato dos dados.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { OPERATION_STATES } from './state-machine'

// ---------------------------------------------------------------------------
// Vocabulários canônicos do contrato
// ---------------------------------------------------------------------------

export const DRIVERS = ['postgresql_isolated', 'supabase_isolated'] as const
export type Driver = (typeof DRIVERS)[number]

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export const HOST_TARGETS = ['vps-primary-local'] as const

export const ACTOR_TYPES = ['human', 'agent', 'worker'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

export const ARTIFACT_TYPES = [
  'database',
  'app_role',
  'compose_project',
  'network',
  'data_store',
  'secret_ref',
  'backup_policy',
  'r2_prefix',
  'restore_test',
  'registry_record',
  'platform_context',
  'endpoint_masked',
] as const

export const ARTIFACT_STATUSES = [
  'planned',
  'created',
  'adopted',
  'verified',
  'disabled',
  'removed',
] as const

export const PLANNED_ACTION_KINDS = [
  'reserve_project',
  'create_database',
  'create_app_role',
  'apply_least_privilege',
  'create_secret_ref',
  'configure_backup',
  'configure_r2_prefix',
  'render_compose_template',
  'create_network',
  'create_data_store',
  'start_stack',
  'health_check',
  'verify_cross_isolation',
  'verify_backup_restore',
  'publish_registry',
  'publish_platform_context',
  'disable_resource',
  'drop_resource_created_by_operation',
] as const
export type PlannedActionKind = (typeof PLANNED_ACTION_KINDS)[number]

export const ACTION_RISKS = ['read_only', 'reversible', 'destructive'] as const

export const AUDIT_OUTCOMES = [
  'accepted',
  'denied',
  'started',
  'succeeded',
  'failed',
  'replayed',
  'expired',
] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

export const VERIFICATION_OUTCOMES = [
  'pending',
  'passed',
  'failed',
  'inconclusive',
] as const

export const VERIFICATION_CHECK_OUTCOMES = [
  'passed',
  'failed',
  'skipped',
  'inconclusive',
] as const

export const VERIFICATION_CHECKS = [
  'ownership',
  'least_privilege',
  'cross_isolation',
  'health',
  'secret_permissions',
  'backup',
  'restore',
] as const

/** Catálogo fechado de códigos de erro da API (`components.schemas.ErrorCode`). */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'POLICY_DENIED',
  'NAMING_CONFLICT',
  'QUOTA_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED',
  'PLAN_STALE',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'INVALID_STATE_TRANSITION',
  'OPERATION_LOCKED',
  'DRIVER_UNAVAILABLE',
  'EXECUTION_FAILED',
  'VERIFICATION_FAILED',
  'ROLLBACK_NOT_SAFE',
  'MANUAL_INTERVENTION_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Padrões canônicos (copiados literalmente do contrato)
// ---------------------------------------------------------------------------

export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const SECRET_REF_PATTERN = /^sref_[A-Za-z0-9_-]{43,128}$/
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,23}$/
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/
export const ARTIFACT_REF_PATTERN =
  /^(?!\/)(?!.*:\/\/)(?!.*:[^@/]*@)(?!.*\.\.)(?!.*\\)[^\s]+$/
export const ACTION_ID_PATTERN = /^act_[A-Za-z0-9_-]{8,64}$/
export const ERROR_FINGERPRINT_PATTERN = /^err_[a-f0-9]{16,64}$/
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/
export const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/
export const APPROVAL_CONFIRMATION_PATTERN =
  /^APROVAR [a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23} [a-f0-9]{8,64}$/
export const ROLLBACK_CONFIRMATION_PATTERN =
  /^APROVAR ROLLBACK [a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23} [a-f0-9]{8,64}$/

/** Valor exato aceito em `confirmation` para aproveitar um plano. */
export function buildApprovalConfirmation(
  projectId: string,
  planHash: string,
): string {
  return `APROVAR ${projectId} ${planHash.slice(0, 8)}`
}

/** Valor exato aceito em `confirmation` para aproveitar um plano de rollback. */
export function buildRollbackConfirmation(
  projectId: string,
  rollbackPlanHash: string,
): string {
  return `APROVAR ROLLBACK ${projectId} ${rollbackPlanHash.slice(0, 8)}`
}

/** `project_id` canônico derivado de cliente + slug do projeto. */
export const projectIdSchema = z.string().regex(PROJECT_ID_PATTERN)

export function buildProjectId(clientId: string, projectSlug: string): string {
  return projectIdSchema.parse(`${clientId}-${projectSlug}`)
}

export const sha256Schema = z.string().regex(SHA256_PATTERN)
export const secretRefSchema = z.string().regex(SECRET_REF_PATTERN)
export const uuidSchema = z.string().uuid()
export const requestIdSchema = z.string().min(8).max(128)

export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(IDEMPOTENCY_KEY_PATTERN)

/** Converte `If-Match` (`"7"`) na revisão numérica da operação. */
export function parseOperationRevision(ifMatch: string): number {
  if (!IF_MATCH_PATTERN.test(ifMatch)) {
    throw new InvalidRevisionHeaderError(ifMatch)
  }
  return Number.parseInt(ifMatch.slice(1, -1), 10)
}

export function formatOperationRevision(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new InvalidRevisionHeaderError(revision)
  }
  return `"${revision}"`
}

/** Cabeçalho `If-Match` fora do padrão contratual. */
export class InvalidRevisionHeaderError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly value: unknown

  constructor(value: unknown) {
    super('cabecalho If-Match invalido')
    this.name = 'InvalidRevisionHeaderError'
    this.value = value
  }
}

/**
 * Fingerprint não reversível de falha (`SafeFailure.fingerprint`), no formato
 * `err_<hex>` exigido pelo contrato. Serve para correlacionar logs sem expor o
 * detalhe que o originou.
 */
export function errorFingerprint(code: ErrorCode, detail = ''): string {
  const digest = createHash('sha256').update(`${code}:${detail}`).digest('hex')
  return `err_${digest.slice(0, 32)}`
}

// ---------------------------------------------------------------------------
// Schemas do contrato
// ---------------------------------------------------------------------------

export const driverSchema = z.enum(DRIVERS)
export const environmentSchema = z.enum(ENVIRONMENTS)
export const operationStateSchema = z.enum(OPERATION_STATES)
export const errorCodeSchema = z.enum(ERROR_CODES)

export const capabilitiesSchema = z
  .object({
    auth: z.boolean(),
    storage: z.boolean(),
    realtime: z.boolean(),
    postgrest: z.boolean(),
    backup: z.literal(true),
  })
  .strict()

export const requestedLimitsSchema = z
  .object({
    database_size_mb: z.number().int().min(128).max(102400).optional(),
    memory_mb: z.number().int().min(256).max(16384).optional(),
    cpu_millicores: z.number().int().min(100).max(8000).optional(),
    backup_retention_days: z.number().int().min(7).max(90).optional(),
  })
  .strict()

export const projectIntentSchema = z
  .object({
    client_id: z.string().regex(SLUG_PATTERN),
    project_slug: z.string().regex(SLUG_PATTERN),
    display_name: z.string().min(3).max(80),
    description: z.string().max(500).optional(),
    driver: driverSchema,
    environment: environmentSchema,
    host_target: z.enum(HOST_TARGETS),
    repository: z
      .object({ registry_id: z.string().min(3).max(128) })
      .strict()
      .optional(),
    capabilities: capabilitiesSchema,
    requested_limits: requestedLimitsSchema.optional(),
  })
  .strict()

export const artifactRefSchema = z
  .object({
    type: z.enum(ARTIFACT_TYPES),
    ref: z.string().max(256).regex(ARTIFACT_REF_PATTERN),
    status: z.enum(ARTIFACT_STATUSES),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const isSecretRef = secretRefSchema.safeParse(artifact.ref).success
    if (artifact.type === 'secret_ref' && !isSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'artefato secret_ref exige token sref_ opaco',
      })
    }
    if (artifact.type !== 'secret_ref' && isSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: 'token sref_ so e aceito em artefato secret_ref',
      })
    }
  })

export const plannedActionSchema = z
  .object({
    action_id: z.string().regex(ACTION_ID_PATTERN),
    kind: z.enum(PLANNED_ACTION_KINDS),
    target_ref: z.string().max(200),
    risk: z.enum(ACTION_RISKS),
    reversible: z.boolean(),
    compensation_kind: z.string().max(80).optional(),
    dependencies: z
      .array(z.string())
      .max(20)
      .refine((items) => new Set(items).size === items.length, {
        message: 'dependencias duplicadas',
      }),
  })
  .strict()

export const estimatedResourcesSchema = z
  .object({
    database_size_mb: z.number().int().min(0).optional(),
    memory_mb: z.number().int().min(0).optional(),
    cpu_millicores: z.number().int().min(0).optional(),
    local_backup_mb: z.number().int().min(0).optional(),
  })
  .strict()

export const planSchema = z
  .object({
    policy_version: z.string().max(64),
    actions: z.array(plannedActionSchema).min(1).max(50),
    estimated_resources: estimatedResourcesSchema,
    warnings: z.array(z.string().max(300)).max(50),
  })
  .strict()

export const approvalSchema = z
  .object({
    approval_id: uuidSchema,
    decision: z.enum(['approve', 'reject']),
    actor_ref: z.string().max(128),
    plan_hash: sha256Schema,
    decided_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict()

export const rollbackApprovalSchema = z
  .object({
    approval_id: uuidSchema,
    decision: z.enum(['approve', 'reject']),
    actor_ref: z.string().max(128),
    rollback_plan_hash: sha256Schema,
    decided_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict()

export const rollbackPlanSchema = z
  .object({
    rollback_plan_hash: sha256Schema,
    actions: z.array(plannedActionSchema).min(1).max(50),
    preserve_data: z.boolean(),
    destructive: z.boolean(),
    ownership_verified: z.literal(true),
    observed_revision: z.string().min(1).max(128),
    approval: z.union([rollbackApprovalSchema, z.null()]).optional(),
    expires_at: z.string().datetime(),
  })
  .strict()

export const verificationCheckSchema = z
  .object({
    name: z.string().max(80),
    outcome: z.enum(VERIFICATION_CHECK_OUTCOMES),
    evidence_ref: z.string().max(256).optional(),
    safe_detail: z.string().max(500).optional(),
  })
  .strict()

export const verificationSchema = z
  .object({
    outcome: z.enum(VERIFICATION_OUTCOMES),
    checks: z.array(verificationCheckSchema).max(50),
    observed_at: z.string().datetime(),
  })
  .strict()

export const safeFailureSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().max(500),
    retryable: z.boolean(),
    fingerprint: z.string().regex(ERROR_FINGERPRINT_PATTERN),
  })
  .strict()

export const safePayloadSchema = z
  .record(
    z.union([z.string(), z.number().int(), z.number(), z.boolean(), z.null()]),
  )
  .refine((payload) => Object.keys(payload).length <= 30, {
    message: 'safe_payload aceita no maximo 30 propriedades',
  })

export const operationSchema = z
  .object({
    operation_id: uuidSchema,
    project_id: projectIdSchema,
    driver: driverSchema,
    driver_version: z.string().max(64).optional(),
    environment: environmentSchema,
    state: operationStateSchema,
    operation_version: z.number().int().min(1),
    plan_hash: sha256Schema,
    observed_revision: z.string().max(128).optional(),
    plan: planSchema,
    approval: z.union([approvalSchema, z.null()]).optional(),
    verification: z.union([verificationSchema, z.null()]).optional(),
    artifacts: z.array(artifactRefSchema).max(100).optional(),
    failure: z.union([safeFailureSchema, z.null()]).optional(),
    rollback_plan_hash: z.union([sha256Schema, z.null()]).optional(),
    rollback: z.union([rollbackPlanSchema, z.null()]).optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    status_url: z.string(),
    audit_url: z.string(),
  })
  .strict()

export const operationResponseSchema = z
  .object({ request_id: z.string(), operation: operationSchema })
  .strict()

export const auditEventSchema = z
  .object({
    event_id: uuidSchema,
    sequence: z.number().int().min(1),
    occurred_at: z.string().datetime(),
    type: z.string().max(100),
    actor_ref: z.string().max(128),
    from_state: z.union([operationStateSchema, z.null()]).optional(),
    to_state: z.union([operationStateSchema, z.null()]).optional(),
    action_kind: z.string().max(80).optional(),
    attempt: z.number().int().min(1).optional(),
    outcome: z.enum(AUDIT_OUTCOMES),
    safe_payload: safePayloadSchema,
  })
  .strict()

export const auditPageSchema = z
  .object({
    request_id: z.string(),
    operation_id: uuidSchema,
    events: z.array(auditEventSchema).max(500),
    next_cursor: z.union([z.string().max(256), z.null()]).optional(),
  })
  .strict()

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().max(500),
        request_id: z.string(),
        retryable: z.boolean(),
        retry_after_seconds: z.number().int().min(1).optional(),
        details: z
          .array(
            z
              .object({
                field: z.string().max(120).optional(),
                reason: z.string().max(120),
              })
              .strict(),
          )
          .max(20)
          .optional(),
      })
      .strict(),
  })
  .strict()

export const dryRunRequestSchema = z
  .object({
    intent: projectIntentSchema,
    reason: z.string().min(3).max(500).optional(),
  })
  .strict()

export const executeRequestSchema = z
  .object({ plan_hash: sha256Schema })
  .strict()

export const verifyRequestSchema = z
  .object({
    checks: z
      .array(z.enum(VERIFICATION_CHECKS))
      .max(20)
      .refine((items) => new Set(items).size === items.length, {
        message: 'checks duplicados',
      })
      .optional(),
  })
  .strict()

export const rollbackDryRunRequestSchema = z
  .object({
    reason: z.string().min(10).max(500),
    preserve_data: z.boolean().default(true),
  })
  .strict()

export const rollbackExecuteRequestSchema = z
  .object({ rollback_plan_hash: sha256Schema, approval_id: uuidSchema })
  .strict()

export const approveRequestSchema = z
  .object({
    decision: z.literal('approve'),
    plan_hash: sha256Schema,
    confirmation: z
      .string()
      .min(3)
      .max(160)
      .regex(APPROVAL_CONFIRMATION_PATTERN),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict()

export const rejectRequestSchema = z
  .object({
    decision: z.literal('reject'),
    reason: z.string().min(3).max(500),
  })
  .strict()

export const approvalRequestSchema = z.discriminatedUnion('decision', [
  approveRequestSchema,
  rejectRequestSchema,
])

export const rollbackApproveRequestSchema = z
  .object({
    decision: z.literal('approve'),
    rollback_plan_hash: sha256Schema,
    confirmation: z
      .string()
      .min(3)
      .max(160)
      .regex(ROLLBACK_CONFIRMATION_PATTERN),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict()

export const rollbackRejectRequestSchema = z
  .object({
    decision: z.literal('reject'),
    reason: z.string().min(3).max(500),
  })
  .strict()

export const rollbackApprovalRequestSchema = z.discriminatedUnion('decision', [
  rollbackApproveRequestSchema,
  rollbackRejectRequestSchema,
])

export type Capabilities = z.infer<typeof capabilitiesSchema>
export type RequestedLimits = z.infer<typeof requestedLimitsSchema>
export type ProjectIntent = z.infer<typeof projectIntentSchema>
export type ArtifactRef = z.infer<typeof artifactRefSchema>
export type PlannedAction = z.infer<typeof plannedActionSchema>
export type Plan = z.infer<typeof planSchema>
export type Approval = z.infer<typeof approvalSchema>
export type RollbackApproval = z.infer<typeof rollbackApprovalSchema>
export type RollbackPlan = z.infer<typeof rollbackPlanSchema>
export type Verification = z.infer<typeof verificationSchema>
export type VerificationCheck = z.infer<typeof verificationCheckSchema>
export type SafeFailure = z.infer<typeof safeFailureSchema>
export type SafePayload = z.infer<typeof safePayloadSchema>
export type Operation = z.infer<typeof operationSchema>
export type OperationResponse = z.infer<typeof operationResponseSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type AuditPage = z.infer<typeof auditPageSchema>
export type ErrorResponse = z.infer<typeof errorResponseSchema>
export type DryRunRequest = z.infer<typeof dryRunRequestSchema>
export type ExecuteRequest = z.infer<typeof executeRequestSchema>
export type VerifyRequest = z.infer<typeof verifyRequestSchema>
export type RollbackDryRunRequest = z.infer<typeof rollbackDryRunRequestSchema>
export type RollbackExecuteRequest = z.infer<
  typeof rollbackExecuteRequestSchema
>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type RollbackApprovalRequest = z.infer<
  typeof rollbackApprovalRequestSchema
>
