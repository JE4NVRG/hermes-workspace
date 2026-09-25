/**
 * Executor de ações allowlisted do Project Center v2 (PR 6).
 *
 * Fonte da verdade: plano §PR 6 (passos 3, 4 e 13) e spec §7/§8/§9.
 *
 * Regras que este módulo garante **antes** de qualquer adapter externo:
 * - catálogo fechado de ação: `kind` fora de `EXECUTABLE_ACTION_KINDS` (ou
 *   `kind` de control plane) é recusado sem tocar adapter algum;
 * - catálogo fechado de template por `driver + kind`: template ausente ou
 *   divergente do declarado no contexto é recusado;
 * - allowlist de `host_target`, de `target_ref` por `kind` e de endpoint
 *   (somente loopback, nunca a porta do PostgreSQL de produção);
 * - comando sempre como **argv fixo** (`assertFixedArgv`): sem shell, sem
 *   interpretação de string, sem path absoluto, sem `..`, sem URI;
 * - **SQL administrativo só de template versionado interno**
 *   (`ADMIN_SQL_TEMPLATES`) com identificadores derivados server-side;
 * - dependencies do grafo de ações já concluídas, revisão observada idêntica e
 *   **lease vigente com fencing token atual** (writer stale recusado).
 *
 * Nenhuma leitura de request entra aqui como comando, SQL, path ou env. O
 * executor só existe com `PROJECT_CENTER_V2_WORKER_ENABLED=true`; com as flags
 * desligadas a primeira linha é `requireWorkerActive` (zero efeito).
 */
import {
  DRIVERS,
  ERROR_FINGERPRINT_PATTERN,
  HOST_TARGETS,
  PLANNED_ACTION_KINDS,
} from '../domain'
import {
  FORBIDDEN_ACTION_KEYS,
  assertPlannedActionShape,
  canonicalJson,
  sha256Hex,
} from '../drivers/types'
import { requireWorkerActive } from '../feature-flags'
import { redactText, safeEvidenceRef } from '../redaction'
import { POSTGRES_IDENTIFIER_PATTERN } from '../naming'
import type {
  Driver,
  Environment,
  ErrorCode,
  PlannedAction,
  PlannedActionKind,
  SafeFailure,
} from '../domain'
import type { ResourceNamingSnapshot } from '../naming'
import type { ProjectCenterV2Flags } from '../feature-flags'
import type { SecretMaterialHandle } from '../secret-broker'
import type { LeaseStore } from '../lease-store'

export const ACTION_EXECUTOR_VERSION = 'pcv2-action-executor-v1'

/** Destino canônico do endpoint de execução (somente loopback). */
export const EXECUTION_LOOPBACK_HOSTS = [
  '127.0.0.1',
  'localhost',
  '[::1]',
] as const
/**
 * Portas que nunca são alvo de execução: `5432` é o PostgreSQL de produção do
 * host (spec §deploy: o worker jamais aponta para recurso existente). O harness
 * efêmero usa porta própria e aleatória.
 */
export const EXECUTION_PORT_DENYLIST = [5432] as const
export const EXECUTION_PORT_MIN = 1024
export const EXECUTION_PORT_MAX = 65535
/** Teto de elementos de argv e de tamanho de cada elemento. */
export const MAX_ARGV_LENGTH = 32
export const MAX_ARGV_ELEMENT_LENGTH = 512
/**
 * Papel administrativo usado em `{{admin_role}}`. É o provisionador dedicado
 * do observer (`je4ndev_pcv2_admin`); o executor PostgreSQL confere o valor
 * contra a constante do observer na carga do módulo (drift quebra em teste).
 */
export const EXECUTION_ADMIN_ROLE = 'je4ndev_pcv2_admin'
/** Metacaracteres de shell nunca aceitos em argv (defesa em profundidade). */
export const SHELL_METACHARACTERS = [
  ';',
  '|',
  '&',
  '$',
  '`',
  '<',
  '>',
  '\n',
  '\r',
]
/** Padrão do ownership marker aceito em `target_ref` (supabase). */
export const LOGICAL_MARKER_PATTERN =
  /^je4ndev:pcv2:(postgresql_isolated|supabase_isolated):(development|staging|production):[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/

export type ExecuteOutcomeStatus =
  | 'succeeded'
  | 'already_satisfied'
  | 'no_op'
  | 'failed'

/** Ação fora do catálogo fechado (nunca chega ao driver). */
export class ActionNotAllowedError extends Error {
  readonly code: ErrorCode = 'POLICY_DENIED'
  readonly status = 403
  readonly reason: string
  readonly kind: string

  constructor(kind: string, reason: string) {
    super('acao fora do catalogo allowlisted')
    this.name = 'ActionNotAllowedError'
    this.kind = kind.slice(0, 40)
    this.reason = reason
  }
}

/** Entrada de execução malformada (plano/contexto inconsistente). */
export class ExecutorInputError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly status = 400
  readonly field: string

  constructor(field: string) {
    super(`entrada de execucao invalida: ${field}`)
    this.name = 'ExecutorInputError'
    this.field = field
  }
}

/** Plano/observação divergente no momento da execução. */
export class ExecutorStaleError extends Error {
  readonly code: ErrorCode = 'PLAN_STALE'
  readonly status = 409
  readonly field: string

  constructor(field: string) {
    super(`execucao com plano stale: ${field}`)
    this.name = 'ExecutorStaleError'
    this.field = field
  }
}

/** Driver sem executor allowlisted no deployment. */
export class DriverExecutorUnavailableError extends Error {
  readonly code: ErrorCode = 'DRIVER_UNAVAILABLE'
  readonly status = 422
  readonly driver: string

  constructor(driver: string) {
    super('executor de driver indisponivel')
    this.name = 'DriverExecutorUnavailableError'
    this.driver = driver
  }
}

// ---------------------------------------------------------------------------
// Endpoint de execução (guard de ambiente)
// ---------------------------------------------------------------------------

export interface ExecutionEndpoint {
  readonly host: string
  readonly port: number
}

/**
 * Guard de endpoint: só loopback, nunca a porta do banco de produção. Falha
 * fechado **antes** de qualquer adapter — é o mesmo guard reutilizado pelo
 * harness efêmero de integração.
 */
export function assertExecutionEndpoint(
  endpoint: ExecutionEndpoint,
  options: { readonly allowedPorts?: ReadonlyArray<number> } = {},
): ExecutionEndpoint {
  const host = endpoint.host
  if (
    typeof host !== 'string' ||
    !(EXECUTION_LOOPBACK_HOSTS as ReadonlyArray<string>).includes(host)
  ) {
    throw new ActionNotAllowedError('endpoint', 'host_not_loopback')
  }
  const port = endpoint.port
  if (
    !Number.isInteger(port) ||
    port < EXECUTION_PORT_MIN ||
    port > EXECUTION_PORT_MAX
  ) {
    throw new ActionNotAllowedError('endpoint', 'port_out_of_range')
  }
  if ((EXECUTION_PORT_DENYLIST as ReadonlyArray<number>).includes(port)) {
    throw new ActionNotAllowedError('endpoint', 'port_denylisted')
  }
  if (
    options.allowedPorts !== undefined &&
    !options.allowedPorts.includes(port)
  ) {
    throw new ActionNotAllowedError('endpoint', 'port_not_allowlisted')
  }
  return Object.freeze({ host, port })
}

// ---------------------------------------------------------------------------
// Catálogo fechado de ações e templates
// ---------------------------------------------------------------------------

/**
 * Canal de execução por kind. O catálogo é total (cobre os 18 kinds do
 * contrato) e cada kind pertence a **exatamente** um canal:
 *
 * - `process`: adapter de processo com argv fixo e template fechado;
 * - `stack`: adapter de stack (Compose/network/data store) sem argv;
 * - `broker`: porta do secret broker (nenhum processo, nenhum SQL);
 * - `backup`: portas de destino de backup (prefixo relativo, sem path);
 * - `control_plane`: porta de registry/plataforma com outbox idempotente.
 */
export const ACTION_EXECUTION_CHANNELS = [
  'process',
  'stack',
  'broker',
  'backup',
  'control_plane',
] as const
export type ActionExecutionChannel = (typeof ACTION_EXECUTION_CHANNELS)[number]

export const ACTION_EXECUTION_CHANNEL: Readonly<
  Record<PlannedActionKind, ActionExecutionChannel | undefined>
> = Object.freeze({
  reserve_project: 'control_plane',
  create_database: 'process',
  create_app_role: 'process',
  apply_least_privilege: 'process',
  create_secret_ref: 'broker',
  configure_backup: 'backup',
  configure_r2_prefix: 'backup',
  render_compose_template: 'stack',
  create_network: 'stack',
  create_data_store: 'stack',
  start_stack: 'stack',
  health_check: 'stack',
  verify_cross_isolation: 'process',
  verify_backup_restore: 'process',
  publish_registry: 'control_plane',
  publish_platform_context: 'control_plane',
  disable_resource: 'process',
  drop_resource_created_by_operation: 'process',
})

/**
 * Overrides por driver. O driver Supabase executa os recursos de banco dentro
 * da própria stack (canal `stack`), não por processo no host.
 */
export const DRIVER_CHANNEL_OVERRIDES: Readonly<
  Partial<
    Record<
      Driver,
      Readonly<Partial<Record<PlannedActionKind, ActionExecutionChannel>>>
    >
  >
> = Object.freeze({
  postgresql_isolated: Object.freeze({}),
  supabase_isolated: Object.freeze({
    create_database: 'stack',
    create_app_role: 'stack',
    apply_least_privilege: 'stack',
    verify_cross_isolation: 'stack',
    verify_backup_restore: 'stack',
    disable_resource: 'stack',
    drop_resource_created_by_operation: 'stack',
  }),
})

/** Canal efetivo do par (kind, driver). Total: nunca devolve `undefined`. */
export function executionChannelFor(
  kind: PlannedActionKind,
  driver: Driver = 'postgresql_isolated',
): ActionExecutionChannel {
  const channel =
    DRIVER_CHANNEL_OVERRIDES[driver]?.[kind] ?? ACTION_EXECUTION_CHANNEL[kind]
  if (channel === undefined) {
    throw new ActionNotAllowedError(String(kind), 'kind_without_channel')
  }
  return channel
}

function kindsByChannel(
  channel: ActionExecutionChannel,
): ReadonlyArray<PlannedActionKind> {
  return Object.freeze(
    PLANNED_ACTION_KINDS.filter(
      (kind) => ACTION_EXECUTION_CHANNEL[kind] === channel,
    ),
  )
}

/** Kinds que exigem adapter de processo (argv fixo e template fechado). */
export const EXECUTABLE_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  kindsByChannel('process')
/** Kinds resolvidos por adapter de stack (Compose/network/data store). */
export const STACK_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  kindsByChannel('stack')
/** Kinds resolvidos pela porta do secret broker. */
export const BROKER_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  kindsByChannel('broker')
/** Kinds resolvidos pelas portas de destino de backup. */
export const BACKUP_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  kindsByChannel('backup')
/**
 * Kinds resolvidos pelo control plane (registry/plataforma), com porta própria
 * e idempotência de outbox — nunca por comando de processo.
 */
export const CONTROL_PLANE_ACTION_KINDS: ReadonlyArray<PlannedActionKind> =
  kindsByChannel('control_plane')

// Guarda de drift: todo kind do OpenAPI tem exatamente um canal e o
// particionamento é fechado (nenhum kind em dois canais).
for (const kind of PLANNED_ACTION_KINDS) {
  const channel = ACTION_EXECUTION_CHANNEL[kind]
  if (
    channel === undefined ||
    !(ACTION_EXECUTION_CHANNELS as ReadonlyArray<string>).includes(channel)
  ) {
    throw new ExecutorInputError(`execution_channel:${kind}`)
  }
}
if (
  EXECUTABLE_ACTION_KINDS.length +
    STACK_ACTION_KINDS.length +
    BROKER_ACTION_KINDS.length +
    BACKUP_ACTION_KINDS.length +
    CONTROL_PLANE_ACTION_KINDS.length !==
  PLANNED_ACTION_KINDS.length
) {
  throw new ExecutorInputError('execution_channel_partition')
}

/** Binários aceitos em argv. Qualquer outro é recusado antes do adapter. */
export const PROCESS_BINARY_ALLOWLIST = [
  'psql',
  'pg_dump',
  'pg_restore',
  'pg_isready',
] as const
export type ProcessBinary = (typeof PROCESS_BINARY_ALLOWLIST)[number]

export function isProcessBinary(value: unknown): value is ProcessBinary {
  return (
    typeof value === 'string' &&
    (PROCESS_BINARY_ALLOWLIST as ReadonlyArray<string>).includes(value)
  )
}

/** Prefixos de `target_ref` aceitos por kind (allowlist compilada). */
export const TARGET_REF_PREFIXES_BY_KIND: Readonly<
  Record<PlannedActionKind, ReadonlyArray<string>>
> = Object.freeze({
  reserve_project: Object.freeze(['registry:']),
  create_database: Object.freeze(['database:']),
  create_app_role: Object.freeze(['role:', 'app-role:']),
  apply_least_privilege: Object.freeze(['grant:']),
  create_secret_ref: Object.freeze(['secret-ref:', 'broker-binding:']),
  configure_backup: Object.freeze(['backup-policy:']),
  configure_r2_prefix: Object.freeze(['r2-prefix:']),
  render_compose_template: Object.freeze(['compose-project:']),
  create_network: Object.freeze(['network:']),
  create_data_store: Object.freeze(['data-store:']),
  start_stack: Object.freeze(['stack:']),
  health_check: Object.freeze(['health:']),
  verify_cross_isolation: Object.freeze(['verification:cross-isolation']),
  verify_backup_restore: Object.freeze([
    'verification:backup-restore',
    'restore-test:',
  ]),
  publish_registry: Object.freeze(['registry-record:']),
  publish_platform_context: Object.freeze(['platform-context:']),
  disable_resource: Object.freeze([
    'database:',
    'role:',
    'app-role:',
    'stack:',
    'compose-project:',
    'data-store:',
    'network:',
  ]),
  drop_resource_created_by_operation: Object.freeze([
    'database:',
    'role:',
    'app-role:',
    'stack:',
    'compose-project:',
    'data-store:',
    'network:',
  ]),
})

// Guarda de drift do contrato: nenhum kind do OpenAPI pode ficar sem entrada
// de allowlist (e nenhuma entrada pode sobrar). Divergência quebra na carga.
for (const kind of PLANNED_ACTION_KINDS) {
  if (TARGET_REF_PREFIXES_BY_KIND[kind].length === 0) {
    throw new ExecutorInputError(`target_ref_allowlist:${kind}`)
  }
}
for (const kind of Object.keys(TARGET_REF_PREFIXES_BY_KIND)) {
  if (!(PLANNED_ACTION_KINDS as ReadonlyArray<string>).includes(kind)) {
    throw new ExecutorInputError(`target_ref_allowlist_orphan:${kind}`)
  }
}

/**
 * SQL administrativo **versionado e interno**. Placeholders só aceitam
 * identificadores derivados server-side; não existe caminho para SQL vindo do
 * request (plano §PR 6, passo 4).
 */
export const ADMIN_SQL_TEMPLATES: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    create_database:
      'CREATE DATABASE {{database}} OWNER {{app_role}} TEMPLATE template0 ENCODING UTF8',
    create_app_role:
      'CREATE ROLE {{app_role}} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    apply_least_privilege:
      'GRANT CONNECT ON DATABASE {{database}} TO {{app_role}}',
    revoke_public: 'REVOKE ALL ON DATABASE {{database}} FROM PUBLIC',
    verify_isolation: 'SELECT current_database() IS NOT NULL AS reachable',
    verify_restore: 'SELECT 1 AS restored',
    drop_database: 'DROP DATABASE IF EXISTS {{database}} WITH (FORCE)',
    drop_role: 'DROP ROLE IF EXISTS {{app_role}}',
  })

export type AdminSqlTemplateId = keyof typeof ADMIN_SQL_TEMPLATES

export interface ActionTemplate {
  readonly template_id: string
  readonly kind: PlannedActionKind
  readonly driver: Driver
  readonly binary: ProcessBinary
  readonly risk: 'reversible' | 'destructive'
  readonly argv: ReadonlyArray<string>
  readonly timeout_ms: number
  readonly compensable: boolean
  /** `true` quando a ação é uma prova negativa (sucesso = adapter falha). */
  readonly expects_denial: boolean
}

function freezeTemplate(template: ActionTemplate): ActionTemplate {
  return Object.freeze({
    ...template,
    argv: Object.freeze([...template.argv]),
  })
}

/**
 * Catálogo fechado de templates por `driver:kind`. Ausência é recusa: um kind
 * sem template não é executável por aquele driver.
 */
export const ACTION_TEMPLATES: Readonly<
  Record<string, ActionTemplate | undefined>
> = Object.freeze({
  'postgresql_isolated:create_database': freezeTemplate({
    template_id: 'pg-create-database',
    kind: 'create_database',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'reversible',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      'postgres',
      '--command',
      '{{sql:create_database}}',
    ],
    timeout_ms: 30_000,
    compensable: true,
    expects_denial: false,
  }),
  'postgresql_isolated:create_app_role': freezeTemplate({
    template_id: 'pg-create-app-role',
    kind: 'create_app_role',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'reversible',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      'postgres',
      '--command',
      '{{sql:create_app_role}}',
    ],
    timeout_ms: 30_000,
    compensable: true,
    expects_denial: false,
  }),
  'postgresql_isolated:apply_least_privilege': freezeTemplate({
    template_id: 'pg-apply-least-privilege',
    kind: 'apply_least_privilege',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'reversible',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      '{{database}}',
      '--command',
      '{{sql:revoke_public}}',
    ],
    timeout_ms: 30_000,
    compensable: true,
    expects_denial: false,
  }),
  'postgresql_isolated:verify_cross_isolation': freezeTemplate({
    template_id: 'pg-verify-cross-isolation',
    kind: 'verify_cross_isolation',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'reversible',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{app_role}}',
      '--dbname',
      '{{peer_database}}',
      '--command',
      '{{sql:verify_isolation}}',
    ],
    timeout_ms: 30_000,
    compensable: false,
    expects_denial: true,
  }),
  'postgresql_isolated:verify_backup_restore': freezeTemplate({
    template_id: 'pg-verify-backup-restore',
    kind: 'verify_backup_restore',
    driver: 'postgresql_isolated',
    binary: 'pg_restore',
    risk: 'reversible',
    argv: [
      'pg_restore',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      '{{restore_database}}',
    ],
    timeout_ms: 120_000,
    compensable: false,
    expects_denial: false,
  }),
  'postgresql_isolated:disable_resource': freezeTemplate({
    template_id: 'pg-disable-resource',
    kind: 'disable_resource',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'reversible',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      'postgres',
      '--command',
      '{{sql:revoke_public}}',
    ],
    timeout_ms: 30_000,
    compensable: false,
    expects_denial: false,
  }),
  'postgresql_isolated:drop_resource_created_by_operation': freezeTemplate({
    template_id: 'pg-drop-owned-resource',
    kind: 'drop_resource_created_by_operation',
    driver: 'postgresql_isolated',
    binary: 'psql',
    risk: 'destructive',
    argv: [
      'psql',
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      '{{host}}',
      '--port',
      '{{port}}',
      '--username',
      '{{admin_role}}',
      '--dbname',
      'postgres',
      '--command',
      '{{sql:drop_database}}',
    ],
    timeout_ms: 120_000,
    compensable: false,
    expects_denial: false,
  }),
})

export function templateFor(
  kind: PlannedActionKind,
  driver: Driver,
): ActionTemplate {
  const template = ACTION_TEMPLATES[`${driver}:${kind}`]
  if (template === undefined) {
    throw new ActionNotAllowedError(kind, 'template_not_in_catalog')
  }
  if (template.kind !== kind || template.driver !== driver) {
    throw new ActionNotAllowedError(kind, 'template_catalog_mismatch')
  }
  return template
}

/** Valores aceitos em placeholder de template (derivados server-side). */
export type TemplateParamValue = string | number

function assertTemplateValue(placeholder: string, value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > EXECUTION_PORT_MAX) {
      throw new ExecutorInputError(`template_param:${placeholder}`)
    }
    return String(value)
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExecutorInputError(`template_param:${placeholder}`)
  }
  if (placeholder === 'host') {
    if (!(EXECUTION_LOOPBACK_HOSTS as ReadonlyArray<string>).includes(value)) {
      throw new ActionNotAllowedError('template', 'host_not_loopback')
    }
    return value
  }
  if (placeholder === 'project_id') {
    if (!/^[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/.test(value)) {
      throw new ExecutorInputError('template_param:project_id')
    }
    return value
  }
  if (placeholder === 'ownership_marker') {
    if (!LOGICAL_MARKER_PATTERN.test(value)) {
      throw new ExecutorInputError('template_param:ownership_marker')
    }
    return value
  }
  // Qualquer outro placeholder é identificador PostgreSQL derivado server-side.
  if (!POSTGRES_IDENTIFIER_PATTERN.test(value) || value.length > 63) {
    throw new ExecutorInputError(`template_param:${placeholder}`)
  }
  return value
}

/** SQL interno renderizado: só templates versionados, só placeholders válidos. */
export function renderAdminSql(
  templateId: string,
  params: Readonly<Record<string, TemplateParamValue>>,
): string {
  const template = ADMIN_SQL_TEMPLATES[templateId]
  if (template === undefined) {
    throw new ActionNotAllowedError('sql', 'sql_template_not_versioned')
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, placeholder: string) => {
    if (!(placeholder in params)) {
      throw new ExecutorInputError(`sql_param_missing:${placeholder}`)
    }
    return assertTemplateValue(placeholder, params[placeholder])
  })
}

/**
 * Renderiza o argv do template. Placeholders: `{{sql:<id>}}` resolve SQL de
 * template versionado; os demais só aceitam valor derivado server-side já
 * validado. Placeholder desconhecido falha fechado.
 */
export function renderActionTemplate(
  template: ActionTemplate,
  params: Readonly<Record<string, TemplateParamValue>>,
): ReadonlyArray<string> {
  const argv = template.argv.map((element) =>
    element.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
      if (raw.startsWith('sql:')) {
        return renderAdminSql(raw.slice(4), params)
      }
      if (!(raw in params)) {
        throw new ExecutorInputError(`template_param_missing:${raw}`)
      }
      return assertTemplateValue(raw, params[raw])
    }),
  )
  return assertFixedArgv({ binary: template.binary, argv })
}

// ---------------------------------------------------------------------------
// argv fixo (sem shell, sem path)
// ---------------------------------------------------------------------------

/**
 * Valida argv fixo: primeiro elemento igual ao binário allowlisted, sem
 * metacaractere de shell, sem path absoluto/relativo com `..`, sem URI, sem
 * placeholder sobrando. Recusa é anterior a qualquer spawn.
 */
export function assertFixedArgv(input: {
  readonly binary: ProcessBinary
  readonly argv: ReadonlyArray<string>
}): ReadonlyArray<string> {
  if (!isProcessBinary(input.binary)) {
    throw new ActionNotAllowedError('argv', 'binary_not_allowlisted')
  }
  if (
    !Array.isArray(input.argv) ||
    input.argv.length === 0 ||
    input.argv.length > MAX_ARGV_LENGTH
  ) {
    throw new ExecutorInputError('argv_length')
  }
  if (input.argv[0] !== input.binary) {
    throw new ActionNotAllowedError('argv', 'argv0_is_not_allowlisted_binary')
  }
  for (const element of input.argv) {
    if (
      typeof element !== 'string' ||
      element.length > MAX_ARGV_ELEMENT_LENGTH
    ) {
      throw new ExecutorInputError('argv_element')
    }
    if (SHELL_METACHARACTERS.some((character) => element.includes(character))) {
      throw new ActionNotAllowedError('argv', 'shell_metacharacter')
    }
    if (element.includes('{{') || element.includes('}}')) {
      throw new ExecutorInputError('argv_placeholder_unrendered')
    }
    if (
      element.startsWith('/') ||
      element.startsWith('~') ||
      /^[A-Za-z]:\\/.test(element) ||
      element.includes('..') ||
      element.includes('\\') ||
      element.includes('://')
    ) {
      throw new ActionNotAllowedError('argv', 'path_or_uri_not_allowlisted')
    }
  }
  return Object.freeze([...input.argv])
}

// ---------------------------------------------------------------------------
// Adapters (injetados; nada aqui abre processo por conta própria)
// ---------------------------------------------------------------------------

export interface ProcessRunInput {
  readonly argv: ReadonlyArray<string>
  /** Payload binário de entrada em base64 (restore), nunca path. */
  readonly stdin_base64?: string
  readonly timeout_ms: number
  /** Handle opaco do broker: o adapter é o único que revela o material. */
  readonly credential?: SecretMaterialHandle
}

export interface ProcessRunResult {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
  /** Saída binária (pg_dump) em base64; ausente quando não há payload. */
  readonly stdout_base64?: string
}

export interface ProcessAdapter {
  readonly adapter_id: string
  readonly binary: ProcessBinary
  run: (input: ProcessRunInput) => Promise<ProcessRunResult>
}

export interface ControlPlanePort {
  readonly adapter_id: string
  /** Upsert idempotente por `project_id` + generation. */
  publish: (input: {
    readonly kind:
      | 'reserve_project'
      | 'publish_registry'
      | 'publish_platform_context'
    readonly projectId: string
    readonly environment: Environment
    readonly safePayload: Readonly<
      Record<string, string | number | boolean | null>
    >
  }) => Promise<{
    readonly status: ExecuteOutcomeStatus
    readonly safe_detail: string
    readonly evidence_ref?: string
  }>
}

/**
 * Porta do canal de backup: configura destino/prefixo/retenção sem tocar em
 * processo nem em path arbitrário (o serviço de backup resolve o destino).
 */
export interface BackupChannelPort {
  readonly adapter_id: string
  configure: (input: {
    readonly kind: 'configure_backup' | 'configure_r2_prefix'
    readonly projectId: string
    readonly environment: Environment
    readonly targetRef: string
  }) => Promise<{
    readonly status: ExecuteOutcomeStatus
    readonly safe_detail: string
    readonly evidence_ref?: string
  }>
}

// ---------------------------------------------------------------------------
// Contexto e resultado
// ---------------------------------------------------------------------------

export interface ActionLeaseProof {
  readonly leaseId: string
  readonly fencingToken: number
  readonly holderRef: string
}

export interface ActionExecutionContext {
  readonly operationId: string
  readonly projectId: string
  readonly environment: Environment
  readonly driver: Driver
  readonly host_target: string
  /** Revisão observada fixada no plano; divergência é `PLAN_STALE`. */
  readonly observedRevision: string
  readonly naming: ResourceNamingSnapshot
  /** Ids de ações do plano já concluídas (grafo de dependências). */
  readonly completedActionIds: ReadonlyArray<string>
  readonly lease: ActionLeaseProof
  readonly endpoint: ExecutionEndpoint
  /** Rebanho de prova negativa: database de outro projeto (nunca o próprio). */
  readonly peerDatabase?: string
  /** Destino efêmero do teste de restore (distinto da origem). */
  readonly restoreDatabase?: string
  /** Bytes do artefato conferido (base64): só o canal `pg_restore` consome. */
  readonly restorePayloadBase64?: string
  readonly templateId?: string
  readonly profileId?: string
  /** Campos adicionais por driver (ex.: endpoints/stack par do Supabase). */
  readonly driverFields?: DriverContextFields
}

/** Campos adicionais de contexto por driver (validados pelo próprio executor). */
export interface DriverContextFields {
  readonly endpoints?: ReadonlyArray<{
    readonly service: string
    readonly scope: string
    readonly port: number
    readonly public_exposure: boolean
  }>
  readonly peerComposeProject?: string
}

export interface ActionOutcome {
  readonly action_id: string
  readonly kind: PlannedActionKind
  readonly status: ExecuteOutcomeStatus
  readonly adapter_id: string
  readonly executor_version: string
  readonly safe_detail: string
  readonly evidence_ref: string | null
  readonly failure: SafeFailure | null
  /** Digest do par (argv, ação): rastreabilidade sem expor o argv. */
  readonly argv_digest: string
  readonly duration_ms: number
}

export interface DriverActionInput {
  readonly action: PlannedAction
  readonly context: ActionExecutionContext
  /** `null` para canais sem processo (broker/backup). */
  readonly template: ActionTemplate | null
  readonly params: Readonly<Record<string, TemplateParamValue>>
}

export interface DriverActionOutcome {
  readonly status: ExecuteOutcomeStatus
  readonly safe_detail: string
  readonly evidence_ref?: string
  readonly failure?: SafeFailure
}

/**
 * Executor por driver: valida as allowlists específicas (imagens, templates,
 * perfis, slots) e só então fala com o adapter externo.
 */
export interface DriverExecutor {
  readonly driver: Driver
  readonly executor_version: string
  readonly adapter_id: string
  readonly supported_actions: ReadonlyArray<PlannedActionKind>
  execute: (input: DriverActionInput) => Promise<DriverActionOutcome>
}

export interface ActionExecutorDeps {
  readonly flags: ProjectCenterV2Flags
  readonly leases: LeaseStore
  readonly drivers: Readonly<Partial<Record<Driver, DriverExecutor>>>
  readonly controlPlane?: ControlPlanePort
  readonly backups?: BackupChannelPort
  readonly now?: () => Date
}

export interface ExecuteActionInput {
  readonly action: PlannedAction
  readonly context: ActionExecutionContext
  /**
   * Revisão observada no instante da execução (revalidada pelo worker). Some
   * com a revisão do plano => `PLAN_STALE` antes de qualquer efeito.
   */
  readonly observedRevision: string
}

export interface ActionExecutor {
  readonly version: string
  execute: (input: ExecuteActionInput) => Promise<ActionOutcome>
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function assertTargetRef(action: PlannedAction): void {
  const targetRef = action.target_ref
  if (
    typeof targetRef !== 'string' ||
    targetRef.length === 0 ||
    targetRef.length > 200 ||
    /\s/.test(targetRef) ||
    targetRef.startsWith('/') ||
    targetRef.includes('..') ||
    targetRef.includes('\\') ||
    targetRef.includes('://') ||
    targetRef.includes('@') ||
    targetRef.includes('//')
  ) {
    throw new ActionNotAllowedError(action.kind, 'target_ref_not_allowlisted')
  }
  const prefixes =
    (
      TARGET_REF_PREFIXES_BY_KIND as Readonly<
        Record<string, ReadonlyArray<string> | undefined>
      >
    )[action.kind] ?? []
  if (!prefixes.some((prefix) => targetRef.startsWith(prefix))) {
    throw new ActionNotAllowedError(
      action.kind,
      'target_ref_prefix_not_allowed',
    )
  }
  // Nome do alvo: identificador, prefixo relativo de backup ou marker. Nunca
  // path absoluto, URI, credencial ou espaço.
  const name = targetRef.slice(targetRef.indexOf(':') + 1).split('#')[0]
  if (
    !/^[A-Za-z0-9_./:-]+$/.test(name) ||
    name.startsWith('/') ||
    name.includes('..') ||
    name.includes('\\') ||
    name.includes('://')
  ) {
    throw new ActionNotAllowedError(action.kind, 'target_ref_name_not_allowed')
  }
  if (targetRef.includes('#')) {
    const marker = targetRef.slice(targetRef.indexOf('#') + 1)
    if (!LOGICAL_MARKER_PATTERN.test(marker)) {
      throw new ActionNotAllowedError(action.kind, 'ownership_marker_invalid')
    }
  }
}

function assertDependencies(
  action: PlannedAction,
  completed: ReadonlyArray<string>,
): void {
  const missing = action.dependencies.filter(
    (dependency) => !completed.includes(dependency),
  )
  if (missing.length > 0) {
    throw new ExecutorInputError('dependency_not_completed')
  }
}

/**
 * Revalidação de estado observado: a revisão apresentada tem de ser a revisão
 * do plano. Divergência significa que o mundo mudou depois da aprovação.
 */
export function assertObservedRevision(
  expected: string,
  observed: string,
): void {
  if (
    typeof expected !== 'string' ||
    expected.length === 0 ||
    typeof observed !== 'string' ||
    observed.length === 0
  ) {
    throw new ExecutorStaleError('observed_revision_missing')
  }
  if (expected !== observed) {
    throw new ExecutorStaleError('observed_revision_mismatch')
  }
}

function failureOf(
  code: ErrorCode,
  detail: string,
  retryable: boolean,
): SafeFailure {
  const message = redactText(detail).slice(0, 300)
  const digest = sha256Hex(canonicalJson({ code, message }))
  const fingerprint = `err_${digest.slice(0, 32)}`
  /* istanbul ignore next — o formato é garantido por construção. */
  if (!ERROR_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new ExecutorInputError('error_fingerprint')
  }
  return Object.freeze({ code, message, retryable, fingerprint })
}

/** Constrói o executor de ações. Nada é executado na construção. */
export function createActionExecutor(deps: ActionExecutorDeps): ActionExecutor {
  const now = deps.now ?? (() => new Date())

  async function runControlPlane(
    action: PlannedAction,
    context: ActionExecutionContext,
  ): Promise<DriverActionOutcome> {
    const port = deps.controlPlane
    if (port === undefined) {
      throw new DriverExecutorUnavailableError('control_plane')
    }
    const result = await port.publish({
      kind: action.kind as
        | 'reserve_project'
        | 'publish_registry'
        | 'publish_platform_context',
      projectId: context.projectId,
      environment: context.environment,
      safePayload: {
        project_id: context.projectId,
        environment: context.environment,
        driver: context.driver,
        plan_target_ref: action.target_ref,
      },
    })
    // `evidence_ref` é dado não confiável do adapter: passa por redaction e
    // pela forma do contrato (teto de 256, sem URI/path/`..`), como o resto.
    const evidenceRef = safeEvidenceRef(result.evidence_ref)
    return {
      status: result.status,
      safe_detail: result.safe_detail,
      ...(evidenceRef === null ? {} : { evidence_ref: evidenceRef }),
    }
  }

  return {
    version: ACTION_EXECUTOR_VERSION,

    async execute(input: ExecuteActionInput): Promise<ActionOutcome> {
      // 1. flag: com worker desligado nada além desta linha acontece.
      requireWorkerActive(deps.flags)

      const action = input.action
      const context = input.context
      const startedAt = now().getTime()

      // 2. catálogo do contrato: kind fora de `PlannedActionKind` morre aqui,
      // como erro tipado, sem chegar ao parse de forma.
      const untrustedAction = action as unknown as { readonly kind?: unknown }
      if (
        typeof untrustedAction.kind !== 'string' ||
        !(PLANNED_ACTION_KINDS as ReadonlyArray<string>).includes(
          untrustedAction.kind,
        )
      ) {
        throw new ActionNotAllowedError(
          typeof untrustedAction.kind === 'string'
            ? untrustedAction.kind
            : typeof untrustedAction.kind,
          'kind_not_in_contract',
        )
      }
      // 3. forma estrita do contrato e chaves proibidas (command/sql/argv/path).
      const parsed = assertPlannedActionShape(action)
      for (const key of Object.keys(parsed)) {
        if ((FORBIDDEN_ACTION_KEYS as ReadonlyArray<string>).includes(key)) {
          throw new ActionNotAllowedError(parsed.kind, 'forbidden_action_key')
        }
      }

      // 4. canal fechado do kind (process/broker/backup/control_plane).
      const channel = executionChannelFor(parsed.kind, context.driver)
      const isControlPlane = channel === 'control_plane'
      const isProcess = channel === 'process'

      // 5. driver allowlisted.
      if (!(DRIVERS as ReadonlyArray<string>).includes(context.driver)) {
        throw new DriverExecutorUnavailableError(String(context.driver))
      }
      // 6. host target allowlisted.
      if (
        !(HOST_TARGETS as ReadonlyArray<string>).includes(context.host_target)
      ) {
        throw new ActionNotAllowedError(
          parsed.kind,
          'host_target_not_allowlisted',
        )
      }
      // 7. endpoint de execução (loopback, nunca a porta de produção).
      assertExecutionEndpoint(context.endpoint)
      // 8. target_ref coerente com o kind (e ownership marker quando houver).
      assertTargetRef(parsed)
      // 9. dependências do grafo já concluídas.
      assertDependencies(parsed, context.completedActionIds)
      // 10. revisão observada idêntica à do plano.
      assertObservedRevision(context.observedRevision, input.observedRevision)
      // 11. lease vigente com fencing token atual (writer stale recusado).
      deps.leases.assertWriter({
        scope: {
          projectId: context.projectId,
          environment: context.environment,
        },
        leaseId: context.lease.leaseId,
        fencingToken: context.lease.fencingToken,
        holderRef: context.lease.holderRef,
      })

      let outcome: DriverActionOutcome
      let adapterId: string
      let template: ActionTemplate | null = null

      if (isControlPlane) {
        adapterId = deps.controlPlane?.adapter_id ?? 'control-plane-unavailable'
        outcome = await runControlPlane(parsed, context)
      } else {
        if (channel === 'backup') {
          // Canal de backup: porta própria (destino/prefixo/retenção), sem
          // processo e sem path vindo do plano.
          if (deps.backups === undefined) {
            throw new ActionNotAllowedError(
              parsed.kind,
              'backup_channel_unavailable',
            )
          }
          const configured = await deps.backups.configure({
            kind: parsed.kind as 'configure_backup' | 'configure_r2_prefix',
            projectId: context.projectId,
            environment: context.environment,
            targetRef: parsed.target_ref,
          })
          const duration = Math.max(0, now().getTime() - startedAt)
          return Object.freeze({
            action_id: parsed.action_id,
            kind: parsed.kind,
            status: configured.status,
            adapter_id: deps.backups.adapter_id,
            executor_version: ACTION_EXECUTOR_VERSION,
            safe_detail: redactText(configured.safe_detail).slice(0, 300),
            evidence_ref: safeEvidenceRef(configured.evidence_ref),
            failure: null,
            argv_digest: sha256Hex(
              canonicalJson({ channel: 'backup', action_id: parsed.action_id }),
            ),
            duration_ms: duration,
          })
        }
        if (isProcess) {
          // 11. template fechado por driver:kind e coerente com o declarado —
          // igualdade **exata**: sufixo (`'database'` casando com
          // `'pg-create-database'`) não é aceito (O1 do cross-review).
          template = templateFor(parsed.kind, context.driver)
          if (
            context.templateId !== undefined &&
            context.templateId !== template.template_id
          ) {
            throw new ActionNotAllowedError(parsed.kind, 'template_id_mismatch')
          }
        } else if (channel !== 'stack' && context.templateId !== undefined) {
          // Canais sem template (broker/backup) não aceitam template: template
          // informado é sinal de plano adulterado. O canal `stack` aceita
          // template id (validado pela allowlist do próprio executor).
          throw new ActionNotAllowedError(
            parsed.kind,
            'template_not_applicable',
          )
        }
        const executor = deps.drivers[context.driver]
        if (executor === undefined) {
          throw new DriverExecutorUnavailableError(context.driver)
        }
        if (!executor.supported_actions.includes(parsed.kind)) {
          throw new ActionNotAllowedError(
            parsed.kind,
            'driver_action_not_supported',
          )
        }
        adapterId = executor.adapter_id
        outcome = await executor.execute({
          action: parsed,
          context,
          template,
          params: template === null ? {} : templateParamsFor(parsed, context),
        })
      }

      const durationMs = Math.max(0, now().getTime() - startedAt)
      return Object.freeze({
        action_id: parsed.action_id,
        kind: parsed.kind,
        status: outcome.status,
        adapter_id: adapterId,
        executor_version: ACTION_EXECUTOR_VERSION,
        safe_detail: redactText(outcome.safe_detail).slice(0, 300),
        evidence_ref: safeEvidenceRef(outcome.evidence_ref),
        failure: outcome.failure ?? null,
        argv_digest: sha256Hex(
          canonicalJson({
            argv: template === null ? ['control-plane'] : template.argv,
            action_id: parsed.action_id,
            template_id: template?.template_id ?? null,
          }),
        ),
        duration_ms: durationMs,
      })
    },
  }
}

/**
 * Parâmetros de template derivados **exclusivamente** do contexto validado:
 * naming server-side, endpoint allowlisted e o database canário de prova
 * negativa (nunca o próprio database do projeto).
 */
export function templateParamsFor(
  action: PlannedAction,
  context: ActionExecutionContext,
): Readonly<Record<string, TemplateParamValue>> {
  const naming = context.naming
  assertExecutionEndpoint(context.endpoint)
  if (naming.project_id !== context.projectId) {
    throw new ExecutorInputError('naming_project_mismatch')
  }
  const params: Record<string, TemplateParamValue> = {
    host: context.endpoint.host,
    port: context.endpoint.port,
    database: naming.database,
    app_role: naming.app_role,
    project_id: naming.project_id,
    compose_project: naming.compose_project,
    network: naming.network,
    data_store: naming.data_store,
    ownership_marker: naming.ownership_marker,
    admin_role: EXECUTION_ADMIN_ROLE,
  }
  if (action.kind === 'verify_cross_isolation') {
    if (
      typeof context.peerDatabase !== 'string' ||
      context.peerDatabase.length === 0
    ) {
      throw new ExecutorInputError('peer_database_missing')
    }
    if (context.peerDatabase === naming.database) {
      // Prova negativa contra o próprio database não prova isolamento.
      throw new ExecutorInputError('peer_database_must_differ')
    }
    params.peer_database = assertTemplateValue(
      'peer_database',
      context.peerDatabase,
    )
  }
  if (action.kind === 'verify_backup_restore') {
    if (
      typeof context.restoreDatabase !== 'string' ||
      context.restoreDatabase.length === 0
    ) {
      throw new ExecutorInputError('restore_database_missing')
    }
    if (context.restoreDatabase === naming.database) {
      // Restore sobre a origem é proibido: o destino tem de ser distinto.
      throw new ExecutorInputError('restore_database_must_differ')
    }
    params.restore_database = assertTemplateValue(
      'restore_database',
      context.restoreDatabase,
    )
  }
  return Object.freeze(params)
}
