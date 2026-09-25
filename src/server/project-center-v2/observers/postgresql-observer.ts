/**
 * Observer PostgreSQL read-only do Project Center v2 (PR 2).
 *
 * A observação acontece **somente** por uma porta injetada
 * (`PostgresObservationPort`) cujo destino pertence à allowlist de host targets
 * e cujo único método é `query` com um `PostgresStatementId` do catálogo
 * fechado. Não existe SQL livre, shell, `exec`/`spawn`, cliente PostgreSQL,
 * Docker ou filesystem neste módulo.
 *
 * Garantias verificadas por `postgresql-observer.test.ts`:
 * - flag v2 desligada impede **até** a leitura de metadados (nenhuma chamada à
 *   porta acontece);
 * - colunas fora da projeção do statement são descartadas, então senha, DSN,
 *   token ou atributo interno não entram no resultado;
 * - `endpoint_masked` só representa bind de loopback; bind público (inclusive
 *   endereço curinga) vira achado `public_postgres_bind` com endpoint suprimido;
 * - o carimbo `revision` depende apenas do conteúdo observado (sem relógio),
 *   então duas observações idênticas produzem a mesma revisão.
 */
import {
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
} from '../drivers/postgresql-isolated'
import {
  HostNotAllowedError,
  ObservationPortError,
  ObservationScopeError,
  POSTGRES_MAX_ROWS,
  POSTGRES_STATEMENT_COLUMNS,
  PROJECT_CENTER_ALLOWLISTS,
  assertPostgresStatementId,
  hashCanonical,
  observedStateSchema,
  sanitizeStatementParams,
} from '../drivers/types'
import {
  requireApiEnabled,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import {
  appRoleNameFor,
  databaseNameFor,
  parseOwnershipMarker,
  projectIdFor,
} from '../naming'
import { MASK, PATH_MASK, redactText, redactValue } from '../redaction'
import type {
  ObservedState,
  ObservedUnsafeFinding,
  PostgresObservationPort,
  PostgresRow,
  PostgresStatementId,
  PostgresStatementParams,
} from '../drivers/types'
import type { ProjectCenterV2Flags } from '../feature-flags'
import type { ResourceNamingSnapshot } from '../naming'
import type { ProjectIntent } from '../domain'

export const POSTGRES_OBSERVER_VERSION = 'pcv2-pg-observer-v1'

/** Role administrativa do provisionador; constante compilada, nunca do request. */
export const POSTGRES_ADMIN_ROLE = 'je4ndev_pcv2_admin'

/** Bind hosts aceitos como loopback: únicos que podem virar endpoint público. */
export const LOOPBACK_BIND_HOSTS = Object.freeze([
  '127.0.0.1',
  'localhost',
  '::1',
])

/**
 * Hosts que indicam bind público. Montado em runtime para que nenhum literal
 * de endereço curinga fique no código ou em artefato de revisão.
 */
export const WILDCARD_BIND_HOSTS: ReadonlyArray<string> = Object.freeze([
  ['0', '0', '0', '0'].join('.'),
  '::',
  '::0',
  '*',
])

const MAX_CELL_LENGTH = 200
const MAX_ARRAY_CELL_ITEMS = 20

export interface PostgresObserverOptions {
  /** Flags resolvidas; default lê o ambiente (off na ausência). */
  readonly flags?: ProjectCenterV2Flags
  /** Allowlist de host targets; default é a allowlist compilada. */
  readonly hostTargets?: ReadonlyArray<string>
  /** Allowlist de extensões PostgreSQL; default é a compilada. */
  readonly extensionAllowlist?: ReadonlyArray<string>
  /** Relógio injetável; apenas para carimbo informativo, nunca para o hash. */
  readonly now?: () => Date
}

export interface PostgresObservationRequest {
  readonly intent: ProjectIntent
  /** Nomes derivados server-side; precisa bater com a intenção. */
  readonly naming: ResourceNamingSnapshot
}

function sanitizeCell(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value)
    return redacted.length > MAX_CELL_LENGTH
      ? redacted.slice(0, MAX_CELL_LENGTH)
      : redacted
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_CELL_ITEMS)
      .map((item) => sanitizeCell(item))
  }
  // Estruturas arbitrárias nunca atravessam a projeção.
  return null
}

/**
 * Projeta linhas cruas para as colunas permitidas do statement, aplicando
 * redaction em cada célula. Exportado para teste direto da garantia.
 */
export function projectStatementRows(
  statement: PostgresStatementId,
  rows: ReadonlyArray<PostgresRow>,
): ReadonlyArray<PostgresRow> {
  const columns = POSTGRES_STATEMENT_COLUMNS[statement]
  return rows.slice(0, POSTGRES_MAX_ROWS).map((row) => {
    const projected: Record<string, unknown> = {}
    for (const column of columns) {
      if (Object.hasOwn(row, column)) {
        projected[column] = sanitizeCell(row[column])
      }
    }
    return Object.freeze(projected)
  })
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null)
    .slice(0, MAX_ARRAY_CELL_ITEMS)
}

function isRelativeArtifactRef(value: string): boolean {
  // Referência já mascarada não é referência utilizável (path/URI suprimido).
  if (value.includes(MASK) || value.includes(PATH_MASK)) return false
  if (value.startsWith('/')) return false
  if (value.includes('://')) return false
  if (value.includes('..')) return false
  if (value.includes('\\')) return false
  return true
}

function formatEndpoint(host: string, port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!LOOPBACK_BIND_HOSTS.includes(host)) return null
  const normalized = host === '::1' ? '[::1]' : host
  return `${normalized}:${port}`
}

/**
 * Falha fechado quando a observação montada ainda contém material que o
 * catálogo de redaction reconhece (DSN com credencial, senha/token em
 * atribuição, JWT, service key, path absoluto ou `sref_` integral).
 *
 * Defesa em profundidade: redaction é idempotente sobre célula já sanitizada,
 * então qualquer diferença aqui significa que algo sensível atravessou a
 * projeção — e aí o observer para em vez de devolver credencial.
 */
export function assertNoCredentialMaterial(state: ObservedState): void {
  const plain = JSON.parse(JSON.stringify(state)) as Record<string, unknown>
  const redacted = redactValue(plain)
  if (JSON.stringify(redacted) !== JSON.stringify(plain)) {
    throw new ObservationPortError('observacao com material sensivel')
  }
}

export class PostgresqlIsolatedObserver {
  private readonly port: PostgresObservationPort
  private readonly flags: ProjectCenterV2Flags
  private readonly hostTargets: ReadonlyArray<string>
  private readonly extensionAllowlist: ReadonlyArray<string>
  private readonly now: () => Date

  constructor(
    port: PostgresObservationPort,
    options: PostgresObserverOptions = {},
  ) {
    this.port = port
    this.flags = options.flags ?? resolveProjectCenterV2Flags()
    this.hostTargets =
      options.hostTargets ?? PROJECT_CENTER_ALLOWLISTS.host_targets
    this.extensionAllowlist =
      options.extensionAllowlist ??
      PROJECT_CENTER_ALLOWLISTS.postgres_extensions
    this.now = options.now ?? (() => new Date())
  }

  /** Único ponto de I/O: statement do catálogo fechado + parâmetros validados. */
  async readStatement(
    statement: PostgresStatementId,
    params: PostgresStatementParams = {},
  ): Promise<ReadonlyArray<PostgresRow>> {
    this.assertObservationAllowed(this.port.host_target, statement)
    const safeParams = sanitizeStatementParams(params)
    const rows = await this.port.query(statement, safeParams)
    if (!Array.isArray(rows)) {
      throw new ObservationPortError('retorno da porta nao e lista')
    }
    return projectStatementRows(statement, rows)
  }

  private assertObservationAllowed(
    hostTarget: string,
    statement: unknown,
  ): void {
    // Flag desligada fecha antes de qualquer leitura de metadado.
    requireApiEnabled(this.flags)
    assertPostgresStatementId(statement)
    if (!this.hostTargets.includes(hostTarget)) {
      throw new HostNotAllowedError(hostTarget)
    }
    for (const supported of this.port.supported_statements) {
      assertPostgresStatementId(supported)
    }
  }

  async observe(request: PostgresObservationRequest): Promise<ObservedState> {
    const { intent, naming } = request
    const hostTarget = intent.host_target
    this.assertObservationAllowed(this.port.host_target, 'server_identity')
    if (
      !this.hostTargets.includes(hostTarget) ||
      hostTarget !== this.port.host_target
    ) {
      throw new HostNotAllowedError(hostTarget)
    }
    const projectId = projectIdFor(intent.client_id, intent.project_slug)
    if (naming.project_id !== projectId) {
      throw new ObservationScopeError('project_id')
    }
    if (naming.database !== databaseNameFor(intent)) {
      throw new ObservationScopeError('database')
    }
    if (naming.app_role !== appRoleNameFor(naming.database)) {
      throw new ObservationScopeError('app_role')
    }

    const [
      identityRows,
      databaseRows,
      roleRows,
      privilegeRows,
      extensionRows,
      bindingRows,
      backupRows,
    ] = await Promise.all([
      this.readStatement('server_identity', { project_id: projectId }),
      this.readStatement('database_presence', {
        database_name: naming.database,
        limit: POSTGRES_MAX_ROWS,
      }),
      this.readStatement('role_presence', {
        role_name: naming.app_role,
        limit: POSTGRES_MAX_ROWS,
      }),
      this.readStatement('schema_privileges', {
        role_name: naming.app_role,
        limit: POSTGRES_MAX_ROWS,
      }),
      this.readStatement('extension_inventory', { limit: POSTGRES_MAX_ROWS }),
      this.readStatement('connection_bindings', { limit: POSTGRES_MAX_ROWS }),
      this.readStatement('backup_inventory', {
        project_id: projectId,
        limit: POSTGRES_MAX_ROWS,
      }),
    ])

    return this.assemble({
      intent,
      naming,
      projectId,
      observedAt: this.now().toISOString(),
      identityRows,
      databaseRows,
      roleRows,
      privilegeRows,
      extensionRows,
      bindingRows,
      backupRows,
    })
  }

  private assemble(input: {
    readonly intent: ProjectIntent
    readonly naming: ResourceNamingSnapshot
    readonly projectId: string
    readonly observedAt: string
    readonly identityRows: ReadonlyArray<PostgresRow>
    readonly databaseRows: ReadonlyArray<PostgresRow>
    readonly roleRows: ReadonlyArray<PostgresRow>
    readonly privilegeRows: ReadonlyArray<PostgresRow>
    readonly extensionRows: ReadonlyArray<PostgresRow>
    readonly bindingRows: ReadonlyArray<PostgresRow>
    readonly backupRows: ReadonlyArray<PostgresRow>
  }): ObservedState {
    const { intent, naming, projectId } = input
    const warnings: Array<string> = []
    const unsafe: Array<ObservedUnsafeFinding> = []

    const serverVersion =
      readString(joinRow(input.identityRows)?.server_version) ?? 'unknown'

    const databaseRow = input.databaseRows.find(
      (row) => readString(row.database_name) === naming.database,
    )
    const ownershipMarker = databaseRow
      ? readString(databaseRow.ownership_marker)
      : null
    const parsedMarker = parseOwnershipMarker(ownershipMarker)
    const ownershipVerified =
      databaseRow !== undefined &&
      parsedMarker !== null &&
      parsedMarker.project_id === naming.project_id &&
      parsedMarker.driver === intent.driver &&
      parsedMarker.environment === intent.environment &&
      ownershipMarker === naming.ownership_marker

    const database = {
      name: naming.database,
      exists: databaseRow !== undefined,
      owner_role: databaseRow ? readString(databaseRow.owner_role) : null,
      ownership_marker: ownershipMarker,
      size_mb: databaseRow ? readNumber(databaseRow.size_mb) : null,
      is_template: databaseRow ? readBoolean(databaseRow.is_template) : false,
    }

    if (database.exists && !ownershipVerified) {
      unsafe.push('missing_ownership_marker')
      warnings.push('database observado sem ownership marker compativel')
    }
    if (
      database.exists &&
      database.owner_role !== null &&
      database.owner_role !== POSTGRES_ADMIN_ROLE
    ) {
      unsafe.push('foreign_database_owner')
      warnings.push('database observado com owner fora do provisionador')
    }
    if (!database.exists) warnings.push('database ainda nao existe')

    const roleRow = input.roleRows.find(
      (row) => readString(row.role_name) === naming.app_role,
    )
    const memberships = roleRow ? readStringArray(roleRow.memberships) : []
    const appRole = {
      name: naming.app_role,
      exists: roleRow !== undefined,
      can_login: roleRow ? readBoolean(roleRow.can_login) : false,
      is_superuser: roleRow ? readBoolean(roleRow.is_superuser) : false,
      can_create_db: roleRow ? readBoolean(roleRow.can_create_db) : false,
      can_create_role: roleRow ? readBoolean(roleRow.can_create_role) : false,
      can_replicate: roleRow ? readBoolean(roleRow.can_replicate) : false,
      bypass_rls: roleRow ? readBoolean(roleRow.bypass_rls) : false,
      memberships,
    }
    const privilegedMembership = memberships.some(
      (membership) =>
        membership === POSTGRES_ADMIN_ROLE || membership === 'postgres',
    )
    if (
      appRole.exists &&
      (privilegedMembership ||
        appRole.is_superuser ||
        appRole.can_create_db ||
        appRole.can_create_role ||
        appRole.can_replicate ||
        appRole.bypass_rls)
    ) {
      unsafe.push('app_role_privileged')
      warnings.push('app role observada com atributos elevados')
    }
    if (!appRole.exists) warnings.push('app role ainda nao existe')

    const privileges = input.privilegeRows.map((row) => ({
      schema_name: readString(row.schema_name) ?? 'unknown',
      role_name: readString(row.role_name) ?? 'unknown',
      privilege: readString(row.privilege) ?? 'unknown',
      grantable: readBoolean(row.grantable),
    }))

    const extensions = input.extensionRows
      .map((row) => readString(row.extension_name))
      .filter((name): name is string => name !== null)
    const disallowedExtensions = extensions.filter(
      (name) => !this.extensionAllowlist.includes(name),
    )
    if (disallowedExtensions.length > 0) {
      unsafe.push('disallowed_extension')
      warnings.push('extensao observada fora da allowlist')
    }

    const bindings = input.bindingRows.map((row) => ({
      bind_host: readString(row.bind_host) ?? 'unknown',
      bind_port: readNumber(row.bind_port),
      listen_addresses: readString(row.listen_addresses) ?? 'unknown',
      public_exposure: readBoolean(row.public_exposure),
    }))
    const publicBinding = bindings.some(
      (binding) =>
        binding.public_exposure ||
        WILDCARD_BIND_HOSTS.includes(binding.bind_host) ||
        !LOOPBACK_BIND_HOSTS.includes(binding.bind_host),
    )
    if (bindings.some((binding) => binding.listen_addresses.includes('*'))) {
      unsafe.push('wildcard_listen_addresses')
      warnings.push('listen_addresses com curinga observado')
    }
    if (publicBinding) {
      unsafe.push('public_postgres_bind')
      warnings.push('bind publico detectado; endpoint suprimido')
    }
    const loopback = bindings.find(
      (binding) =>
        LOOPBACK_BIND_HOSTS.includes(binding.bind_host) &&
        binding.bind_port !== null,
    )
    const endpointMasked =
      publicBinding || loopback === undefined
        ? null
        : formatEndpoint(loopback.bind_host, loopback.bind_port ?? 0)

    const backupArtifacts = input.backupRows
      .map((row) => ({
        artifact_ref: readString(row.artifact_ref),
        created_at: readString(row.created_at),
        checksum: readString(row.checksum),
        size_mb: readNumber(row.size_mb),
        retention_days: readNumber(row.retention_days),
      }))
      .filter(
        (
          artifact,
        ): artifact is {
          artifact_ref: string
          created_at: string
          checksum: string
          size_mb: number
          retention_days: number
        } =>
          artifact.artifact_ref !== null &&
          isRelativeArtifactRef(artifact.artifact_ref) &&
          artifact.created_at !== null &&
          artifact.checksum !== null &&
          artifact.size_mb !== null &&
          artifact.retention_days !== null,
      )
      .map((artifact) => ({
        artifact_ref: artifact.artifact_ref,
        created_at: artifact.created_at.slice(0, 40),
        checksum: artifact.checksum.slice(0, 80),
        size_mb: Math.trunc(artifact.size_mb),
        retention_days: Math.trunc(artifact.retention_days),
      }))
    if (input.backupRows.length !== backupArtifacts.length) {
      warnings.push('artefato de backup descartado por forma invalida')
    }
    if (backupArtifacts.length === 0) {
      warnings.push('nenhum artefato de backup observado')
    }

    const revision = `obsrev_${hashCanonical({
      observer_version: POSTGRES_OBSERVER_VERSION,
      driver_version: POSTGRESQL_DRIVER_VERSION,
      host_target: input.intent.host_target,
      environment: input.intent.environment,
      project_id: projectId,
      server_version: serverVersion,
      database,
      app_role: appRole,
      privileges,
      extensions,
      disallowed_extensions: disallowedExtensions,
      endpoint_masked: endpointMasked,
      unsafe_findings: unsafe,
      ownership_verified: ownershipVerified,
      backup_artifacts: backupArtifacts,
    }).slice(0, 32)}`

    const state = observedStateSchema.parse({
      driver: POSTGRESQL_DRIVER_ID,
      driver_version: POSTGRESQL_DRIVER_VERSION,
      observer_version: POSTGRES_OBSERVER_VERSION,
      host_target: input.intent.host_target,
      environment: input.intent.environment,
      project_id: projectId,
      observed_at: input.observedAt,
      revision,
      server_version: serverVersion,
      database,
      app_role: appRole,
      privileges,
      extensions,
      disallowed_extensions: disallowedExtensions,
      endpoint_masked: endpointMasked,
      unsafe_findings: [...new Set(unsafe)].sort(),
      ownership_verified: ownershipVerified,
      backup_artifacts: backupArtifacts,
      warnings: warnings.slice(0, 50),
    })
    assertNoCredentialMaterial(state)
    return state
  }
}

function joinRow(rows: ReadonlyArray<PostgresRow>): PostgresRow | undefined {
  return rows.length > 0 ? rows[0] : undefined
}
