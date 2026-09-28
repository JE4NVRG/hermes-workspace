/**
 * Naming determinístico do Project Center v2 (PR 2).
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §4. Nenhum
 * identificador SQL vem do cliente: database, role app e prefixos são
 * derivados server-side de `client_id`/`project_slug` já validados pelo
 * contrato, normalizados em ASCII minúsculo e limitados a 63 bytes (o limite
 * de identifier do PostgreSQL).
 *
 * Módulo puro: sem I/O, sem banco, sem DDL, sem secret e sem path absoluto.
 * Nome inválido ou colisão com recurso pertencente a outro projeto falha
 * fechado (`NAMING_CONFLICT`); nunca existe fallback silencioso, adoção
 * implícita nem aceitação de identifier bruto.
 */
import { SLUG_PATTERN, buildProjectId } from './domain'
import type { Driver, Environment } from './domain'

/** Versão do algoritmo de naming, fixada no plano e no hash canônico. */
export const NAMING_VERSION = 'pcv2-naming-v1'
/** Namespace fixo da plataforma; nunca vem do request. */
export const PLATFORM_NAMESPACE = 'je4ndev'
/** Sufixo canônico da role de aplicação. */
export const APP_ROLE_SUFFIX = '_app'
/** Prefixo canônico do Compose project (driver Supabase, PR 3). */
export const COMPOSE_PROJECT_PREFIX = 'je4ndev-sb'
/** Raiz relativa do prefixo R2. */
export const R2_PREFIX_ROOT = 'projects'
/** Segmento final do prefixo de backup (por driver). */
export const BACKUP_DRIVER_SEGMENT = 'postgres'
/** Destinos de backup aceitos (allowlist versionada). */
export const BACKUP_DESTINATIONS = ['local', 'r2'] as const
export type BackupDestination = (typeof BACKUP_DESTINATIONS)[number]

/** Limite de bytes de um identifier do PostgreSQL (`NAMEDATALEN - 1`). */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63
/** Forma final aceita para qualquer identifier que chegue ao banco. */
export const POSTGRES_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/
/**
 * Forma de entrada aceita para slug: ASCII, começa com letra, somente
 * minúsculas/maiúsculas, dígitos e hífen, 2 a 24 caracteres. Caixa é
 * normalizada; qualquer outro caractere (aspas, espaço, ponto-e-vírgula,
 * barra, acento, emoji) é recusado em vez de "limpo".
 */
export const SLUG_INPUT_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,23}$/

/** Forma canônica do ownership marker derivado server-side. */
export const OWNERSHIP_MARKER_PATTERN =
  /^je4ndev:pcv2:(postgresql_isolated|supabase_isolated):(development|staging|production):([a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23})$/

export type NamingErrorCode = 'INVALID_REQUEST' | 'NAMING_CONFLICT'

/** Erro fechado de naming; o código pertence ao catálogo do contrato. */
export class NamingError extends Error {
  readonly code: NamingErrorCode

  constructor(message: string, code: NamingErrorCode) {
    super(message)
    this.name = 'NamingError'
    this.code = code
  }
}

/** Identificador fora da forma canônica (`INVALID_REQUEST`). */
export class InvalidIdentifierError extends NamingError {
  readonly field: string
  readonly value: unknown

  constructor(field: string, value: unknown) {
    super(`identificador invalido em ${field}`, 'INVALID_REQUEST')
    this.name = 'InvalidIdentifierError'
    this.field = field
    this.value = value
  }
}

/** Nome já ocupado por recurso incompatível (`NAMING_CONFLICT`). */
export class NamingConflictError extends NamingError {
  readonly resourceName: string

  constructor(resourceName: string) {
    super('nome de recurso em conflito', 'NAMING_CONFLICT')
    this.name = 'NamingConflictError'
    this.resourceName = resourceName
  }
}

/**
 * Normaliza e valida um slug (`client_id`/`project_slug`).
 *
 * Caixa é normalizada para minúsculo; qualquer caractere fora de
 * `[A-Za-z0-9-]` é recusado (nada de `trim`, remoção ou escape silencioso).
 */
export function normalizeSlug(input: unknown, field = 'slug'): string {
  if (typeof input !== 'string' || !SLUG_INPUT_PATTERN.test(input)) {
    throw new InvalidIdentifierError(field, input)
  }
  const normalized = input.toLowerCase()
  if (!SLUG_PATTERN.test(normalized)) {
    throw new InvalidIdentifierError(field, input)
  }
  return normalized
}

/** Verdadeiro quando o valor pode chegar ao banco como identifier. */
export function isPostgresIdentifier(value: unknown): value is string {
  // O padrão é ASCII puro, então o comprimento em caracteres é o de bytes.
  return (
    typeof value === 'string' &&
    POSTGRES_IDENTIFIER_PATTERN.test(value) &&
    value.length <= POSTGRES_IDENTIFIER_MAX_BYTES
  )
}

/** Recusa identifier fora da forma canônica ou acima de 63 bytes. */
export function assertPostgresIdentifier(
  value: unknown,
  field = 'identifier',
): string {
  if (!isPostgresIdentifier(value)) {
    throw new InvalidIdentifierError(field, value)
  }
  return value
}

export interface NamingInput {
  readonly client_id: string
  readonly project_slug: string
  readonly environment: Environment
  readonly driver: Driver
}

/**
 * Snapshot de nomes derivados de uma intenção. Todos os valores são públicos
 * (nomes de recurso e prefixes relativos); nenhum contém credencial, path
 * absoluto ou token.
 */
export interface ResourceNamingSnapshot {
  readonly naming_version: string
  readonly project_id: string
  readonly database: string
  readonly app_role: string
  /** Compose project do driver Supabase (PR 3); determinístico e sem input livre. */
  readonly compose_project: string
  readonly network: string
  readonly data_store: string
  /** Prefixo de backup local, sempre relativo. */
  readonly local_backup_prefix: string
  /** Prefixo R2, sempre relativo. */
  readonly r2_prefix: string
  readonly ownership_marker: string
}

/** `project_id = <client_id>-<project_slug>` a partir de slug validado. */
export function projectIdFor(clientId: unknown, projectSlug: unknown): string {
  const client = normalizeSlug(clientId, 'client_id')
  const project = normalizeSlug(projectSlug, 'project_slug')
  return buildProjectId(client, project)
}

/** `je4ndev_<client_id>_<project_slug>` com hífen convertido em `_`. */
export function databaseNameFor(input: {
  readonly client_id: string
  readonly project_slug: string
}): string {
  const client = normalizeSlug(input.client_id, 'client_id')
  const project = normalizeSlug(input.project_slug, 'project_slug')
  const name = `${PLATFORM_NAMESPACE}_${client}_${project}`.replaceAll('-', '_')
  return assertPostgresIdentifier(name, 'database')
}

/** `<database>_app`. */
export function appRoleNameFor(databaseName: unknown): string {
  const database = assertPostgresIdentifier(databaseName, 'database')
  return assertPostgresIdentifier(`${database}${APP_ROLE_SUFFIX}`, 'app_role')
}

/** `je4ndev-sb-<client_id>-<project_slug>` (driver Supabase, PR 3). */
export function composeProjectNameFor(input: {
  readonly client_id: string
  readonly project_slug: string
}): string {
  const client = normalizeSlug(input.client_id, 'client_id')
  const project = normalizeSlug(input.project_slug, 'project_slug')
  return `${COMPOSE_PROJECT_PREFIX}-${client}-${project}`
}

/** `<compose_project>-net`. */
export function networkNameFor(composeProject: unknown): string {
  if (typeof composeProject !== 'string' || composeProject.length === 0) {
    throw new InvalidIdentifierError('compose_project', composeProject)
  }
  return `${composeProject}-net`
}

/** `<compose_project>-postgres-data`. */
export function dataStoreNameFor(composeProject: unknown): string {
  if (typeof composeProject !== 'string' || composeProject.length === 0) {
    throw new InvalidIdentifierError('compose_project', composeProject)
  }
  return `${composeProject}-postgres-data`
}

/** Backup local `<project_id>/<environment>/postgres/` (relativo, nunca absoluto). */
export function localBackupPrefixFor(input: {
  readonly project_id: string
  readonly environment: Environment
}): string {
  return `${relativeSegment(input.project_id, 'project_id')}/${relativeSegment(
    input.environment,
    'environment',
  )}/${BACKUP_DRIVER_SEGMENT}/`
}

/** Prefixo R2 `projects/<project_id>/<environment>/postgres/` (relativo). */
export function r2PrefixFor(input: {
  readonly project_id: string
  readonly environment: Environment
}): string {
  return `${R2_PREFIX_ROOT}/${localBackupPrefixFor(input)}`
}

function relativeSegment(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('..') ||
    value.includes('\\')
  ) {
    throw new InvalidIdentifierError(field, value)
  }
  return value
}

/** Ownership marker determinístico: vincula recurso a projeto/driver/ambiente. */
export function ownershipMarkerFor(input: {
  readonly project_id: string
  readonly driver: Driver
  readonly environment: Environment
}): string {
  const marker = `${PLATFORM_NAMESPACE}:pcv2:${input.driver}:${input.environment}:${input.project_id}`
  if (!OWNERSHIP_MARKER_PATTERN.test(marker)) {
    throw new InvalidIdentifierError('ownership_marker', input.project_id)
  }
  return marker
}

export interface ParsedOwnershipMarker {
  readonly driver: Driver
  readonly environment: Environment
  readonly project_id: string
}

/** Lê um ownership marker observado; `null` quando ausente ou malformado. */
export function parseOwnershipMarker(
  marker: unknown,
): ParsedOwnershipMarker | null {
  if (typeof marker !== 'string') return null
  const match = OWNERSHIP_MARKER_PATTERN.exec(marker)
  if (match === null) return null
  return {
    driver: match[1] as Driver,
    environment: match[2] as Environment,
    project_id: match[3],
  }
}

/** Snapshot completo de nomes para uma intenção validada. */
export function buildNamingSnapshot(
  input: NamingInput,
): ResourceNamingSnapshot {
  const projectId = projectIdFor(input.client_id, input.project_slug)
  const database = databaseNameFor(input)
  const composeProject = composeProjectNameFor(input)
  return Object.freeze({
    naming_version: NAMING_VERSION,
    project_id: projectId,
    database,
    app_role: appRoleNameFor(database),
    compose_project: composeProject,
    network: networkNameFor(composeProject),
    data_store: dataStoreNameFor(composeProject),
    local_backup_prefix: localBackupPrefixFor({
      project_id: projectId,
      environment: input.environment,
    }),
    r2_prefix: r2PrefixFor({
      project_id: projectId,
      environment: input.environment,
    }),
    ownership_marker: ownershipMarkerFor({
      project_id: projectId,
      driver: input.driver,
      environment: input.environment,
    }),
  })
}

/** Nome desejado, sempre derivado server-side. */
export interface DesiredResource {
  readonly name: string
  readonly project_id: string
  readonly driver: Driver
  readonly environment: Environment
  readonly ownership_marker: string
}

/** Recurso já presente no host, projetado pela observação read-only. */
export interface ExistingResource {
  readonly name: string
  readonly project_id: string
  readonly driver: Driver
  readonly environment: Environment
  readonly ownership_marker: string | null
}

export type ResourceResolutionStatus = 'available' | 'already_satisfied'

export interface ResourceResolution {
  readonly status: ResourceResolutionStatus
  readonly name: string
}

/**
 * Verdadeiro somente quando o recurso preexistente é do mesmo projeto, driver,
 * ambiente e traz o ownership marker esperado. Qualquer outra combinação é
 * conflito: recursos estrangeiros nunca são adotados implicitamente.
 */
export function ownershipMatches(
  existing: ExistingResource,
  desired: DesiredResource,
): boolean {
  if (existing.name !== desired.name) return false
  if (existing.project_id !== desired.project_id) return false
  if (existing.driver !== desired.driver) return false
  if (existing.environment !== desired.environment) return false
  if (existing.ownership_marker === null) return false
  return existing.ownership_marker === desired.ownership_marker
}

/**
 * Resolve o nome de um recurso contra o inventário observado.
 *
 * - sem nome igual no inventário: `available` (criação planejada);
 * - nome igual com ownership compatível: `already_satisfied` (não repete side
 *   effect);
 * - nome igual com owner diferente, marker ausente ou ambiente divergente:
 *   `NAMING_CONFLICT` (falha fechada, nunca fallback para outro nome).
 */
export function resolveResourceName(
  desired: DesiredResource,
  existing: ReadonlyArray<ExistingResource>,
): ResourceResolution {
  assertPostgresIdentifier(desired.name, 'resource_name')
  if (desired.ownership_marker !== ownershipMarkerFor(desired)) {
    throw new InvalidIdentifierError(
      'ownership_marker',
      desired.ownership_marker,
    )
  }
  const sameName = existing.filter(
    (candidate) => candidate.name === desired.name,
  )
  if (sameName.length === 0) {
    return { status: 'available', name: desired.name }
  }
  if (sameName.some((candidate) => ownershipMatches(candidate, desired))) {
    return { status: 'already_satisfied', name: desired.name }
  }
  throw new NamingConflictError(desired.name)
}

/** Recusa dois recursos distintos resolvendo para o mesmo nome. */
export function assertDistinctNames(names: ReadonlyArray<string>): void {
  const seen = new Set<string>()
  for (const name of names) {
    assertPostgresIdentifier(name, 'resource_name')
    if (seen.has(name)) throw new NamingConflictError(name)
    seen.add(name)
  }
}
