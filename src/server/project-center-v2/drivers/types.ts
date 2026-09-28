/**
 * Contratos do driver PostgreSQL em dry-run estrito (PR 2).
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §7, §8 e §10 e o
 * OpenAPI canônico. Este módulo descreve três coisas e nada mais:
 *
 * 1. a **porta de observação** read-only: catálogo de statements fechado,
 *    parâmetros escalares validados por padrão e nenhum método de escrita;
 * 2. o **estado observado** sanitizado (schema estrito: campo desconhecido é
 *    recusado e `endpoint_masked` só aceita bind de loopback);
 * 3. o **contrato de driver de dry-run** (validate/plan/sanitize) e as
 *    allowlists versionadas que a política fixa no hash do plano.
 *
 * Execução não existe aqui: `execute`/`compensate` são do PR 6 e o worker não
 * é sequer referenciado. Nenhum módulo importa execução de processo filho,
 * Docker, cliente de banco, filesystem ou SDK de nuvem.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  DRIVERS,
  ENVIRONMENTS,
  HOST_TARGETS,
  PLANNED_ACTION_KINDS,
  driverSchema,
  environmentSchema,
  plannedActionSchema,
  projectIdSchema,
} from '../domain'
import { BACKUP_DESTINATIONS, NAMING_VERSION } from '../naming'
import type {
  Driver,
  Environment,
  ErrorCode,
  PlannedAction,
  PlannedActionKind,
  ProjectIntent,
  SafePayload,
  estimatedResourcesSchema,
} from '../domain'
import type { ProjectCenterV2Flags } from '../feature-flags'

/** Tipo do bloco `estimated_resources` do contrato (`Plan`). */
export type EstimatedResources = z.infer<typeof estimatedResourcesSchema>

// ---------------------------------------------------------------------------
// Allowlists versionadas (spec §10)
// ---------------------------------------------------------------------------

/** Versão das allowlists compiladas; entra no hash canônico do plano. */
export const DRIVER_ALLOWLIST_VERSION = 'pcv2-allowlists-v1'

/** Chaves de capability do contrato (`Capabilities`). */
export const CAPABILITY_KEYS = [
  'auth',
  'storage',
  'realtime',
  'postgrest',
  'backup',
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** Extensões PostgreSQL permitidas; qualquer outra é drift reportado. */
export const POSTGRES_EXTENSION_ALLOWLIST = ['pgcrypto'] as const

/** Allowlists compiladas, congeladas e reutilizadas por observer e planner. */
export const PROJECT_CENTER_ALLOWLISTS = Object.freeze({
  version: DRIVER_ALLOWLIST_VERSION,
  naming_version: NAMING_VERSION,
  drivers: DRIVERS,
  environments: ENVIRONMENTS,
  host_targets: HOST_TARGETS,
  capabilities: CAPABILITY_KEYS,
  postgres_extensions: POSTGRES_EXTENSION_ALLOWLIST,
  backup_destinations: BACKUP_DESTINATIONS,
})

// ---------------------------------------------------------------------------
// Catálogo de statements e porta de observação read-only
// ---------------------------------------------------------------------------

/** Catálogo FECHADO de statements de observação. Só estes podem ser lidos. */
export const POSTGRES_STATEMENTS = [
  'server_identity',
  'database_presence',
  'role_presence',
  'schema_privileges',
  'extension_inventory',
  'connection_bindings',
  'backup_inventory',
] as const
export type PostgresStatementId = (typeof POSTGRES_STATEMENTS)[number]

/**
 * Projeção por statement: SOMENTE estas colunas entram no resultado. Coluna
 * retornada pela porta que não esteja aqui é descartada — é o mecanismo que
 * impede senha, DSN ou atributo interno de vazar para a observação.
 */
export const POSTGRES_STATEMENT_COLUMNS: Readonly<
  Record<PostgresStatementId, ReadonlyArray<string>>
> = Object.freeze({
  server_identity: Object.freeze(['server_version', 'data_directory_kind']),
  database_presence: Object.freeze([
    'database_name',
    'owner_role',
    'ownership_marker',
    'size_mb',
    'is_template',
  ]),
  role_presence: Object.freeze([
    'role_name',
    'can_login',
    'is_superuser',
    'can_create_db',
    'can_create_role',
    'can_replicate',
    'bypass_rls',
    'memberships',
  ]),
  schema_privileges: Object.freeze([
    'schema_name',
    'role_name',
    'privilege',
    'grantable',
  ]),
  extension_inventory: Object.freeze(['extension_name', 'extension_version']),
  connection_bindings: Object.freeze([
    'bind_host',
    'bind_port',
    'listen_addresses',
    'public_exposure',
  ]),
  backup_inventory: Object.freeze([
    'artifact_ref',
    'created_at',
    'checksum',
    'size_mb',
    'retention_days',
  ]),
})

/** Chaves aceitas em parâmetros de statement; nada além disso é repassado. */
export const POSTGRES_STATEMENT_PARAM_KEYS = [
  'project_id',
  'database_name',
  'role_name',
  'schema_name',
  'extension_name',
  'limit',
] as const

/**
 * Forma aceita para valores de parâmetro. Recusa espaço, aspas, `;`, `--`,
 * `/`, `\` e qualquer coisa que se pareça com SQL livre ou path.
 */
export const POSTGRES_STATEMENT_PARAM_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** Máximo de linhas aceitas de uma porta de observação. */
export const POSTGRES_MAX_ROWS = 50

export class StatementCatalogError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly statement: string

  constructor(statement: string) {
    super('statement fora do catalogo fechado')
    this.name = 'StatementCatalogError'
    this.statement = statement
  }
}

export class InvalidStatementParamError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly field: string

  constructor(field: string) {
    super(`parametro de statement invalido: ${field}`)
    this.name = 'InvalidStatementParamError'
    this.field = field
  }
}

export function isPostgresStatementId(
  value: unknown,
): value is PostgresStatementId {
  return (
    typeof value === 'string' &&
    (POSTGRES_STATEMENTS as ReadonlyArray<string>).includes(value)
  )
}

/** Falha fechada para qualquer statement que não pertença ao catálogo. */
export function assertPostgresStatementId(value: unknown): PostgresStatementId {
  if (!isPostgresStatementId(value)) {
    throw new StatementCatalogError(
      typeof value === 'string' ? value.slice(0, 32) : typeof value,
    )
  }
  return value
}

export interface PostgresStatementParams {
  readonly project_id?: string
  readonly database_name?: string
  readonly role_name?: string
  readonly schema_name?: string
  readonly extension_name?: string
  readonly limit?: number
}

/**
 * Valida e congela parâmetros de statement. Chave desconhecida, valor
 * não-escalar, string fora do padrão ou limite fora de faixa são recusados.
 */
export function sanitizeStatementParams(
  params: PostgresStatementParams | undefined,
): Readonly<PostgresStatementParams> {
  const output: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (
      !(POSTGRES_STATEMENT_PARAM_KEYS as ReadonlyArray<string>).includes(key)
    ) {
      throw new InvalidStatementParamError(key)
    }
    if (value === undefined) continue
    if (key === 'limit') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > POSTGRES_MAX_ROWS
      ) {
        throw new InvalidStatementParamError(key)
      }
      output[key] = value
      continue
    }
    if (
      typeof value !== 'string' ||
      !POSTGRES_STATEMENT_PARAM_PATTERN.test(value)
    ) {
      throw new InvalidStatementParamError(key)
    }
    output[key] = value
  }
  return Object.freeze(output)
}

/** Linha crua devolvida pela porta, já restrita à projeção do statement. */
export type PostgresRow = Readonly<Record<string, unknown>>

/**
 * Porta de observação injetada. É read-only por construção: o único método é
 * `query`, ele aceita apenas um `PostgresStatementId` do catálogo e o destino
 * declarado precisa pertencer à allowlist de host targets.
 *
 * Não existe injeção de SQL, de argv, de shell ou de cliente PostgreSQL neste
 * contrato — o adapter concreto (PR 6) é quem conhece o banco, nunca o planner.
 */
export interface PostgresObservationPort {
  readonly host_target: string
  readonly supported_statements: ReadonlyArray<PostgresStatementId>
  query: (
    statement: PostgresStatementId,
    params: Readonly<PostgresStatementParams>,
  ) => Promise<ReadonlyArray<PostgresRow>>
}

export class HostNotAllowedError extends Error {
  readonly code: ErrorCode = 'POLICY_DENIED'
  readonly host_target: string

  constructor(hostTarget: string) {
    super('host target fora da allowlist')
    this.name = 'HostNotAllowedError'
    this.host_target = hostTarget
  }
}

export class ObservationPortError extends Error {
  readonly code: ErrorCode = 'DRIVER_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'ObservationPortError'
  }
}

// ---------------------------------------------------------------------------
// Estado observado (sanitizado, sem credenciais)
// ---------------------------------------------------------------------------

export const UNSAFE_FINDINGS = [
  'public_postgres_bind',
  'wildcard_listen_addresses',
  'app_role_privileged',
  'missing_ownership_marker',
  'foreign_database_owner',
  'disallowed_extension',
] as const
export type ObservedUnsafeFinding = (typeof UNSAFE_FINDINGS)[number]

export const OBSERVED_REVISION_PATTERN = /^obsrev_[a-f0-9]{32}$/
/**
 * Única forma aceita para `endpoint_masked`: bind de loopback em `host:porta`.
 * Estruturalmente, nenhum bind público (nem endereço curinga) é representável,
 * e o literal do curinga não aparece no código — é montado em runtime pelo
 * observer.
 */
export const MASKED_ENDPOINT_PATTERN =
  /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/

const observedDatabaseSchema = z
  .object({
    name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    exists: z.boolean(),
    owner_role: z.union([z.string().max(63), z.null()]),
    ownership_marker: z.union([z.string().max(200), z.null()]),
    size_mb: z.union([z.number().int().min(0), z.null()]),
    is_template: z.boolean(),
  })
  .strict()

const observedRoleSchema = z
  .object({
    name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    exists: z.boolean(),
    can_login: z.boolean(),
    is_superuser: z.boolean(),
    can_create_db: z.boolean(),
    can_create_role: z.boolean(),
    can_replicate: z.boolean(),
    bypass_rls: z.boolean(),
    memberships: z.array(z.string().max(63)).max(20),
  })
  .strict()

const observedPrivilegeSchema = z
  .object({
    schema_name: z.string().max(63),
    role_name: z.string().max(63),
    privilege: z.string().max(32),
    grantable: z.boolean(),
  })
  .strict()

const observedBackupArtifactSchema = z
  .object({
    artifact_ref: z.string().max(256),
    created_at: z.string().max(40),
    checksum: z.string().max(80),
    size_mb: z.number().int().min(0),
    retention_days: z.number().int().min(0).max(365),
  })
  .strict()

/**
 * Estado observado canônico. Schema estrito: campo desconhecido é recusado e
 * não existe campo de senha, DSN, token ou path absoluto por construção.
 */
export const observedStateSchema = z
  .object({
    driver: driverSchema,
    driver_version: z.string().min(1).max(64),
    observer_version: z.string().min(1).max(64),
    host_target: z.enum(HOST_TARGETS),
    environment: environmentSchema,
    project_id: projectIdSchema,
    observed_at: z.string().datetime(),
    revision: z.string().regex(OBSERVED_REVISION_PATTERN),
    server_version: z.string().min(1).max(64),
    database: observedDatabaseSchema,
    app_role: observedRoleSchema,
    privileges: z.array(observedPrivilegeSchema).max(50),
    extensions: z.array(z.string().max(63)).max(50),
    disallowed_extensions: z.array(z.string().max(63)).max(50),
    endpoint_masked: z.union([
      z.string().regex(MASKED_ENDPOINT_PATTERN),
      z.null(),
    ]),
    unsafe_findings: z
      .array(z.enum(UNSAFE_FINDINGS))
      .max(UNSAFE_FINDINGS.length),
    ownership_verified: z.boolean(),
    backup_artifacts: z.array(observedBackupArtifactSchema).max(50),
    warnings: z.array(z.string().max(300)).max(50),
  })
  .strict()

export type ObservedState = z.infer<typeof observedStateSchema>

export function assertObservedState(value: unknown): ObservedState {
  return observedStateSchema.parse(value)
}

// ---------------------------------------------------------------------------
// Política e contrato de driver de dry-run
// ---------------------------------------------------------------------------

export interface NumericQuota {
  readonly min: number
  readonly max: number
  readonly default: number
}

export interface PostgresQuotas {
  readonly database_size_mb: NumericQuota
  readonly memory_mb: NumericQuota
  readonly cpu_millicores: NumericQuota
  readonly backup_retention_days: NumericQuota
}

/**
 * Retrato imutável da política + allowlists no momento do plano. O hash
 * canônico cobre este retrato: mudança de política exige plano novo.
 */
export interface ProjectCenterV2PolicySnapshot {
  readonly policy_version: string
  readonly allowlist_version: string
  readonly plan_ttl_seconds: number
  readonly approval_ttl_seconds: number
  readonly max_actions_per_plan: number
  readonly allowed_drivers: ReadonlyArray<Driver>
  readonly allowed_environments: ReadonlyArray<Environment>
  readonly allowed_host_targets: ReadonlyArray<string>
  readonly allowed_capabilities: ReadonlyArray<CapabilityKey>
  readonly postgres_extension_allowlist: ReadonlyArray<string>
  readonly backup_destinations: ReadonlyArray<string>
  readonly postgres_quotas: PostgresQuotas
}

export interface DriverDescriptor {
  readonly id: Driver
  readonly version: string
  readonly environments: ReadonlyArray<Environment>
  readonly provided_capabilities: ReadonlyArray<CapabilityKey>
  /** Kinds que este driver pode planejar (subconjunto da allowlist do contrato). */
  readonly actions: ReadonlyArray<PlannedActionKind>
}

export interface DriverValidationIssue {
  readonly field: string
  readonly reason: string
}

export type DriverValidationResult =
  | { readonly ok: true; readonly warnings: ReadonlyArray<string> }
  | {
      readonly ok: false
      readonly code: ErrorCode
      readonly issues: ReadonlyArray<DriverValidationIssue>
    }

export interface DriverPlanRequest {
  readonly intent: ProjectIntent
  readonly observed: ObservedState
  readonly policy: ProjectCenterV2PolicySnapshot
  /** Flags resolvidas; ausente cai no default fechado (desligado). */
  readonly flags?: ProjectCenterV2Flags
}

export interface DriverPlan {
  readonly actions: ReadonlyArray<PlannedAction>
  readonly estimated_resources: EstimatedResources
  readonly warnings: ReadonlyArray<string>
  /** Ações já satisfeitas pelo estado observado; o worker não repete o efeito. */
  readonly satisfied_action_ids: ReadonlyArray<string>
}

/** Erro de driver indisponível/não implementado neste PR. */
export class DriverUnavailableError extends Error {
  readonly code: ErrorCode = 'DRIVER_UNAVAILABLE'
  readonly driver: string

  constructor(driver: string) {
    super('driver indisponivel para dry-run')
    this.name = 'DriverUnavailableError'
    this.driver = driver
  }
}

/** Observação pertencente a outro escopo (projeto/driver/ambiente/host). */
export class ObservationScopeError extends Error {
  readonly code: ErrorCode = 'PLAN_STALE'
  readonly field: string

  constructor(field: string) {
    super(`observacao fora do escopo do plano: ${field}`)
    this.name = 'ObservationScopeError'
    this.field = field
  }
}

/**
 * Driver de **dry-run**: valida, planeja e sanitiza. Não existe `observe`
 * (a observação é uma porta read-only injetada) nem `execute`/`compensate`
 * (PR 6). O objeto do driver não pode expor nenhum método de execução.
 */
export interface DryRunDriver {
  readonly descriptor: DriverDescriptor
  validate: (
    intent: ProjectIntent,
    policy: ProjectCenterV2PolicySnapshot,
  ) => DriverValidationResult
  plan: (request: DriverPlanRequest) => DriverPlan
  sanitize: (detail: unknown) => SafePayload
}

/** Kinds que um plano PostgreSQL isolado pode conter. */
const POSTGRESQL_ACTION_KIND_LIST: ReadonlyArray<PlannedActionKind> = [
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
]

export const POSTGRESQL_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  Object.freeze(POSTGRESQL_ACTION_KIND_LIST)

/** Chaves proibidas em qualquer ação planejada (defesa em profundidade). */
export const FORBIDDEN_ACTION_KEYS = [
  'command',
  'argv',
  'shell',
  'sql',
  'script',
  'env',
  'secret',
  'secret_value',
  'password',
  'dsn',
  'path',
  'host_path',
  'image',
  'mount',
  'port',
] as const

// ---------------------------------------------------------------------------
// Hash canônico (determinismo do plano)
// ---------------------------------------------------------------------------

export class CanonicalValueError extends Error {
  readonly code: ErrorCode = 'INTERNAL_ERROR'
  readonly field: string

  constructor(field: string) {
    super('valor nao canonico para hash')
    this.name = 'CanonicalValueError'
    this.field = field
  }
}

// Guarda de drift do contrato: todo kind planejável precisa existir no enum do
// OpenAPI (`PlannedAction.kind`). Divergência falha na carga do módulo.
for (const kind of POSTGRESQL_ACTION_KINDS) {
  if (!(PLANNED_ACTION_KINDS as ReadonlyArray<string>).includes(kind)) {
    throw new CanonicalValueError(`action_kind:${kind}`)
  }
}

function assertJsonSafe(value: unknown, path: string, depth: number): void {
  if (depth > 16) throw new CanonicalValueError(path)
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalValueError(path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonSafe(item, `${path}[${index}]`, depth + 1),
    )
    return
  }
  if (typeof value !== 'object') throw new CanonicalValueError(path)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalValueError(path)
  }
  for (const [key, entry] of Object.entries(value)) {
    // `undefined` em propriedade é equivalência JSON de chave ausente; dentro
    // de array é ambíguo e falha fechado.
    if (entry === undefined) continue
    assertJsonSafe(entry, `${path}.${key}`, depth + 1)
  }
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortValue)
  const source = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    if (entry === undefined) continue
    output[key] = sortValue(entry)
  }
  return output
}

/**
 * JSON canônico: chaves ordenadas, arrays preservados, valores não-JSON
 * recusados. Sem isso, dois planos materialmente idênticos poderiam gerar
 * hashes diferentes — e a idempotência dependem exatamente do contrário.
 */
export function canonicalJson(value: unknown): string {
  assertJsonSafe(value, '$', 0)
  return JSON.stringify(sortValue(value))
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/** Digest curto e determinístico para compor `action_id`. */
export function shortDigest(value: unknown, length = 12): string {
  return hashCanonical(value).slice(0, length)
}

/** Ação planejada validada pela forma estrita do contrato. */
export function assertPlannedActionShape(action: PlannedAction): PlannedAction {
  const parsed = plannedActionSchema.parse(action)
  for (const key of Object.keys(parsed)) {
    if ((FORBIDDEN_ACTION_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new CanonicalValueError(key)
    }
  }
  return parsed
}
