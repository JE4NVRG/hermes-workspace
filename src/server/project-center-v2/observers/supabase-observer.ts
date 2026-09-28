/**
 * Observer read-only da stack Supabase isolada (PR 3).
 *
 * A observação acontece **somente** por uma porta injetada
 * (`SupabaseObservationPort`), cujo único método é `inspect` e cujo destino
 * precisa pertencer à allowlist de host targets. Não existe `exec`, `spawn`,
 * subida/descida de stack, escrita em filesystem, cliente Docker ou SQL livre
 * neste módulo.
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §8.3 e §10.
 *
 * Garantias verificadas por `supabase-observer.test.ts`:
 * - flag v2 desligada impede **até** a leitura de inventário (zero chamadas à
 *   porta);
 * - colunas fora da projeção do read são descartadas: senha, token, DSN,
 *   registry credential e atributo interno não entram no resultado;
 * - nenhum endereço bruto observado é preservado: endpoint vira classificação
 *   fechada (`loopback`/`private_network`/`public`/`wildcard`/`unknown`) e o
 *   `endpoint_masked` canônico só representa bind de loopback;
 * - o carimbo `revision` depende apenas do conteúdo observado (sem relógio),
 *   então duas observações idênticas produzem a mesma revisão.
 */
import {
  SUPABASE_BACKUP_DESTINATIONS,
  SUPABASE_BIND_SCOPES,
  SUPABASE_CATALOG_VERSION,
  SUPABASE_DRIFT_FINDINGS,
  SUPABASE_MAX_ROWS,
  SUPABASE_RESOURCE_PROFILES,
  SUPABASE_SERVICE_HEALTH,
  SUPABASE_SERVICE_IDS,
  SUPABASE_SERVICE_STATUSES,
  SUPABASE_TEMPLATES,
  resolveResourceProfile,
  resolveTemplateFor,
  supabaseStackProjectionSchema,
} from '../catalogs/supabase-catalog'
import {
  SUPABASE_DRIVER_ID,
  SUPABASE_DRIVER_VERSION,
} from '../drivers/supabase-isolated'
import {
  HostNotAllowedError,
  ObservationPortError,
  ObservationScopeError,
  PROJECT_CENTER_ALLOWLISTS,
  hashCanonical,
  observedStateSchema,
} from '../drivers/types'
import {
  requireApiEnabled,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import {
  appRoleNameFor,
  composeProjectNameFor,
  dataStoreNameFor,
  databaseNameFor,
  networkNameFor,
  parseOwnershipMarker,
  projectIdFor,
} from '../naming'
import { MASK, PATH_MASK, redactText, redactValue } from '../redaction'
import { assertNoCredentialMaterial } from './postgresql-observer'
import type { ErrorCode, ProjectIntent } from '../domain'
import type { ProjectCenterV2Flags } from '../feature-flags'
import type { ResourceNamingSnapshot } from '../naming'
import type { ObservedState, ObservedUnsafeFinding } from '../drivers/types'
import type {
  SupabaseBindScope,
  SupabaseDriftFinding,
  SupabaseResourceProfile,
  SupabaseServiceId,
  SupabaseStackProjection,
  SupabaseTemplate,
} from '../catalogs/supabase-catalog'

export const SUPABASE_OBSERVER_VERSION = 'pcv2-sb-observer-v1'

/** Role administrativa do provisionador; constante compilada, nunca do request. */
export const SUPABASE_ADMIN_ROLE = 'je4ndev_pcv2_admin'

// ---------------------------------------------------------------------------
// Catálogo FECHADO de reads e projeção por read
// ---------------------------------------------------------------------------

/** Reads permitidos. Só estes podem ser lidos da porta. */
export const SUPABASE_READS = [
  'stack_inventory',
  'network_inventory',
  'data_store_inventory',
  'role_inventory',
  'grant_inventory',
  'service_inventory',
  'endpoint_inventory',
  'broker_binding_inventory',
  'capacity_inventory',
  'backup_inventory',
] as const
export type SupabaseReadId = (typeof SUPABASE_READS)[number]

/**
 * Projeção por read: SOMENTE estas colunas entram no resultado. Coluna
 * devolvida pela porta que não esteja aqui é descartada — é o mecanismo que
 * impede credencial, DSN ou atributo interno de vazar para a observação.
 *
 * O read de bindings expõe apenas o nome opaco do slot no broker: o token
 * (referência de secret) nunca é lido, nem de forma mascarada.
 */
export const SUPABASE_READ_COLUMNS: Readonly<
  Record<SupabaseReadId, ReadonlyArray<string>>
> = Object.freeze({
  stack_inventory: Object.freeze([
    'project_name',
    'exists',
    'ownership_marker',
    'template_id',
    'template_version',
    'service_count',
    'status',
  ]),
  network_inventory: Object.freeze([
    'network_name',
    'exists',
    'ownership_marker',
    'driver',
    'internal',
    'externally_attached',
  ]),
  data_store_inventory: Object.freeze([
    'store_name',
    'exists',
    'ownership_marker',
    'engine',
    'engine_version',
    'size_mb',
    'shared_with_other_project',
  ]),
  role_inventory: Object.freeze([
    'role_name',
    'exists',
    'can_login',
    'is_superuser',
    'can_create_db',
    'can_create_role',
    'can_replicate',
    'bypass_rls',
    'memberships',
  ]),
  grant_inventory: Object.freeze([
    'schema_name',
    'role_name',
    'privilege',
    'grantable',
  ]),
  service_inventory: Object.freeze([
    'service_name',
    'image_ref',
    'image_digest',
    'status',
    'health',
    'template_id',
    'restart_count',
  ]),
  endpoint_inventory: Object.freeze([
    'endpoint_name',
    'bind_scope',
    'bind_port',
    'public_exposure',
    'tls_terminated',
  ]),
  broker_binding_inventory: Object.freeze([
    'binding_name',
    'scope',
    'exists',
    'shared_with_other_project',
    'rotation_days',
  ]),
  capacity_inventory: Object.freeze([
    'resource_name',
    'cpu_millicores',
    'memory_mb',
    'disk_mb',
  ]),
  backup_inventory: Object.freeze([
    'artifact_ref',
    'created_at',
    'checksum',
    'size_mb',
    'retention_days',
    'destination',
  ]),
})

/** Chaves aceitas em parâmetros de read; nada além disso é repassado. */
export const SUPABASE_READ_PARAM_KEYS = [
  'project_id',
  'compose_project',
  'network_name',
  'data_store',
  'role_name',
  'service_name',
  'binding_name',
  'limit',
] as const

/** Forma aceita de valor de parâmetro; recusa SQL livre, path e espaço. */
export const SUPABASE_READ_PARAM_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export class ReadCatalogError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly read: string

  constructor(read: unknown) {
    super('read fora do catalogo fechado')
    this.name = 'ReadCatalogError'
    this.read = typeof read === 'string' ? read.slice(0, 32) : typeof read
  }
}

export class InvalidReadParamError extends Error {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly field: string

  constructor(field: string) {
    super(`parametro de read invalido: ${field}`)
    this.name = 'InvalidReadParamError'
    this.field = field
  }
}

export function isSupabaseReadId(value: unknown): value is SupabaseReadId {
  return (
    typeof value === 'string' &&
    (SUPABASE_READS as ReadonlyArray<string>).includes(value)
  )
}

export function assertSupabaseReadId(value: unknown): SupabaseReadId {
  if (!isSupabaseReadId(value)) throw new ReadCatalogError(value)
  return value
}

export interface SupabaseReadParams {
  readonly project_id?: string
  readonly compose_project?: string
  readonly network_name?: string
  readonly data_store?: string
  readonly role_name?: string
  readonly service_name?: string
  readonly binding_name?: string
  readonly limit?: number
}

/** Valida e congela parâmetros de read (chave/valor escalar fora do padrão falha). */
export function sanitizeReadParams(
  params: SupabaseReadParams | undefined,
): Readonly<SupabaseReadParams> {
  const output: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!(SUPABASE_READ_PARAM_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new InvalidReadParamError(key)
    }
    if (value === undefined) continue
    if (key === 'limit') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > SUPABASE_MAX_ROWS
      ) {
        throw new InvalidReadParamError(key)
      }
      output[key] = value
      continue
    }
    if (typeof value !== 'string' || !SUPABASE_READ_PARAM_PATTERN.test(value)) {
      throw new InvalidReadParamError(key)
    }
    output[key] = value
  }
  return Object.freeze(output)
}

/** Linha crua devolvida pela porta, já restrita à projeção do read. */
export type SupabaseRow = Readonly<Record<string, unknown>>

/**
 * Porta de observação injetada. É read-only por construção: o único método é
 * `inspect`, ele aceita apenas um `SupabaseReadId` do catálogo e o destino
 * declarado precisa pertencer à allowlist de host targets. Não existe
 * execução de processo, compose, escrita ou leitura de credencial aqui.
 */
export interface SupabaseObservationPort {
  readonly host_target: string
  readonly supported_reads: ReadonlyArray<SupabaseReadId>
  inspect: (
    read: SupabaseReadId,
    params: Readonly<SupabaseReadParams>,
  ) => Promise<ReadonlyArray<SupabaseRow>>
}

// ---------------------------------------------------------------------------
// Achados de drift e projeção da stack
// ---------------------------------------------------------------------------
// O vocabulário fechado de drift e o schema da projeção vivem no catálogo
// (`catalogs/supabase-catalog.ts`), contrato compartilhado entre este observer
// e o driver. Isso mantém o fluxo de import sempre na direção
// observer -> driver -> catálogo, sem ciclo de módulos.

/** Resultado da observação: estado canônico + projeção sanitizada da stack. */
export interface SupabaseObservation {
  readonly state: ObservedState
  readonly stack: SupabaseStackProjection
}

export interface SupabaseObserverOptions {
  /** Flags resolvidas; default lê o ambiente (off na ausência). */
  readonly flags?: ProjectCenterV2Flags
  /** Allowlist de host targets; default é a allowlist compilada. */
  readonly hostTargets?: ReadonlyArray<string>
  /** Templates permitidos; default é a allowlist compilada. */
  readonly templates?: ReadonlyArray<SupabaseTemplate>
  /** Perfis de recurso; default é a allowlist compilada. */
  readonly profiles?: ReadonlyArray<SupabaseResourceProfile>
  /** Relógio injetável; apenas carimbo informativo, nunca para o hash. */
  readonly now?: () => Date
}

export interface SupabaseObservationRequest {
  readonly intent: ProjectIntent
  /** Nomes derivados server-side; precisa bater com a intenção. */
  readonly naming: ResourceNamingSnapshot
}

// ---------------------------------------------------------------------------
// Normalização de célula/linha
// ---------------------------------------------------------------------------

const MAX_CELL_LENGTH = 200
const MAX_ARRAY_CELL_ITEMS = 20

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
  return null
}

/** Projeta linhas cruas para as colunas permitidas, com redaction por célula. */
export function projectReadRows(
  read: SupabaseReadId,
  rows: ReadonlyArray<SupabaseRow>,
): ReadonlyArray<SupabaseRow> {
  const columns = SUPABASE_READ_COLUMNS[read]
  return rows.slice(0, SUPABASE_MAX_ROWS).map((row) => {
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

function readScope(value: unknown): SupabaseBindScope {
  return typeof value === 'string' &&
    (SUPABASE_BIND_SCOPES as ReadonlyArray<string>).includes(value)
    ? (value as SupabaseBindScope)
    : 'unknown'
}

function readEnum<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T {
  return typeof value === 'string' &&
    (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback
}

function readInteger(value: unknown): number | null {
  const number = readNumber(value)
  return number === null ? null : Math.trunc(number)
}

function readMemberList(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null)
    .slice(0, MAX_ARRAY_CELL_ITEMS)
}

function isRelativeArtifactRef(value: string): boolean {
  if (value.includes(MASK) || value.includes(PATH_MASK)) return false
  if (value.startsWith('/')) return false
  if (value.includes('://')) return false
  if (value.includes('..')) return false
  if (value.includes('\\')) return false
  return true
}

/**
 * Falha fechado quando a projeção montada ainda contém material que o catálogo
 * de redaction reconhece (DSN com credencial, senha/token em atribuição, JWT,
 * service key, path absoluto ou referência de secret integral). Defesa em
 * profundidade:
 * qualquer diferença significa que algo sensível atravessou a projeção.
 */
export function assertNoCredentialMaterialInProjection(value: unknown): void {
  const plain = JSON.parse(JSON.stringify(value)) as unknown
  const redacted = redactValue(plain)
  if (JSON.stringify(redacted) !== JSON.stringify(plain)) {
    throw new ObservationPortError('observacao de stack com material sensivel')
  }
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

export class SupabaseIsolatedObserver {
  private readonly port: SupabaseObservationPort
  private readonly flags: ProjectCenterV2Flags
  private readonly hostTargets: ReadonlyArray<string>
  private readonly templates: ReadonlyArray<SupabaseTemplate>
  private readonly profiles: ReadonlyArray<SupabaseResourceProfile>
  private readonly now: () => Date

  constructor(
    port: SupabaseObservationPort,
    options: SupabaseObserverOptions = {},
  ) {
    this.port = port
    this.flags = options.flags ?? resolveProjectCenterV2Flags()
    this.hostTargets =
      options.hostTargets ?? PROJECT_CENTER_ALLOWLISTS.host_targets
    this.templates = options.templates ?? SUPABASE_TEMPLATES
    this.profiles = options.profiles ?? SUPABASE_RESOURCE_PROFILES
    this.now = options.now ?? (() => new Date())
  }

  /** Único ponto de I/O: read do catálogo fechado + parâmetros validados. */
  async readInventory(
    read: SupabaseReadId,
    params: SupabaseReadParams = {},
  ): Promise<ReadonlyArray<SupabaseRow>> {
    this.assertObservationAllowed(this.port.host_target, read)
    const safeParams = sanitizeReadParams(params)
    const rows = await this.port.inspect(read, safeParams)
    if (!Array.isArray(rows)) {
      throw new ObservationPortError('retorno da porta nao e lista')
    }
    return projectReadRows(read, rows)
  }

  private assertObservationAllowed(hostTarget: string, read: unknown): void {
    // Flag desligada fecha antes de qualquer leitura de inventário.
    requireApiEnabled(this.flags)
    assertSupabaseReadId(read)
    if (!this.hostTargets.includes(hostTarget)) {
      throw new HostNotAllowedError(hostTarget)
    }
    for (const supported of this.port.supported_reads) {
      assertSupabaseReadId(supported)
    }
  }

  async observe(
    request: SupabaseObservationRequest,
  ): Promise<SupabaseObservation> {
    const { intent, naming } = request
    this.assertObservationAllowed(this.port.host_target, 'stack_inventory')
    const hostTarget = intent.host_target
    if (
      !this.hostTargets.includes(hostTarget) ||
      hostTarget !== this.port.host_target
    ) {
      throw new HostNotAllowedError(hostTarget)
    }
    if (
      naming.project_id !== projectIdFor(intent.client_id, intent.project_slug)
    ) {
      throw new ObservationScopeError('project_id')
    }
    if (naming.compose_project !== composeProjectNameFor(intent)) {
      throw new ObservationScopeError('compose_project')
    }
    if (naming.network !== networkNameFor(naming.compose_project)) {
      throw new ObservationScopeError('network')
    }
    if (naming.data_store !== dataStoreNameFor(naming.compose_project)) {
      throw new ObservationScopeError('data_store')
    }
    if (naming.database !== databaseNameFor(intent)) {
      throw new ObservationScopeError('database')
    }
    if (naming.app_role !== appRoleNameFor(naming.database)) {
      throw new ObservationScopeError('app_role')
    }

    const [
      stackRows,
      networkRows,
      dataStoreRows,
      roleRows,
      grantRows,
      serviceRows,
      endpointRows,
      bindingRows,
      capacityRows,
      backupRows,
    ] = await Promise.all([
      this.readInventory('stack_inventory', {
        compose_project: naming.compose_project,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('network_inventory', {
        network_name: naming.network,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('data_store_inventory', {
        data_store: naming.data_store,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('role_inventory', {
        role_name: naming.app_role,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('grant_inventory', {
        role_name: naming.app_role,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('service_inventory', {
        compose_project: naming.compose_project,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('endpoint_inventory', {
        compose_project: naming.compose_project,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('broker_binding_inventory', {
        project_id: naming.project_id,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('capacity_inventory', {
        compose_project: naming.compose_project,
        limit: SUPABASE_MAX_ROWS,
      }),
      this.readInventory('backup_inventory', {
        project_id: naming.project_id,
        limit: SUPABASE_MAX_ROWS,
      }),
    ])

    return this.assemble({
      intent,
      naming,
      observedAt: this.now().toISOString(),
      stackRows,
      networkRows,
      dataStoreRows,
      roleRows,
      grantRows,
      serviceRows,
      endpointRows,
      bindingRows,
      capacityRows,
      backupRows,
    })
  }

  private assemble(input: {
    readonly intent: ProjectIntent
    readonly naming: ResourceNamingSnapshot
    readonly observedAt: string
    readonly stackRows: ReadonlyArray<SupabaseRow>
    readonly networkRows: ReadonlyArray<SupabaseRow>
    readonly dataStoreRows: ReadonlyArray<SupabaseRow>
    readonly roleRows: ReadonlyArray<SupabaseRow>
    readonly grantRows: ReadonlyArray<SupabaseRow>
    readonly serviceRows: ReadonlyArray<SupabaseRow>
    readonly endpointRows: ReadonlyArray<SupabaseRow>
    readonly bindingRows: ReadonlyArray<SupabaseRow>
    readonly capacityRows: ReadonlyArray<SupabaseRow>
    readonly backupRows: ReadonlyArray<SupabaseRow>
  }): SupabaseObservation {
    const { intent, naming } = input
    const warnings: Array<string> = []
    const drift: Array<SupabaseDriftFinding> = []

    const template = resolveTemplateFor(intent.capabilities, this.templates)
    const expectedTemplateId = template?.template_id ?? 'unknown'
    if (template === undefined) {
      warnings.push(
        'nenhum template do catalogo atende as capabilities pedidas',
      )
    }
    // Perfil de referência da capacidade: o menor que atende o pedido; sem
    // candidato, o maior do catálogo (o excesso já é recusado na validação).
    const profile =
      resolveResourceProfile(intent.requested_limits, this.profiles) ??
      this.profiles[this.profiles.length - 1]

    const verifyMarker = (marker: string | null): boolean => {
      const parsed = parseOwnershipMarker(marker)
      return (
        parsed !== null &&
        marker === naming.ownership_marker &&
        parsed.project_id === naming.project_id &&
        parsed.driver === intent.driver &&
        parsed.environment === intent.environment
      )
    }

    const resource = (
      name: string,
      row: SupabaseRow | undefined,
      expectedName: string,
    ) => {
      const marker = row ? readString(row.ownership_marker) : null
      const exists = row !== undefined
      const verified = exists && verifyMarker(marker)
      const resourceDrift: Array<SupabaseDriftFinding> = []
      if (exists && marker === null) {
        resourceDrift.push('missing_ownership_marker')
      } else if (exists && !verified) {
        resourceDrift.push('foreign_ownership_marker')
      }
      if (exists && name !== expectedName) {
        resourceDrift.push('resource_name_drift')
      }
      drift.push(...resourceDrift)
      return {
        name,
        exists,
        ownership_marker: marker,
        ownership_verified: verified,
        drift: resourceDrift,
      }
    }

    const stackRow = input.stackRows.find(
      (row) => readString(row.project_name) === naming.compose_project,
    )
    const networkRow = input.networkRows.find(
      (row) => readString(row.network_name) === naming.network,
    )
    const dataStoreRow = input.dataStoreRows.find(
      (row) => readString(row.store_name) === naming.data_store,
    )

    const composeProject = resource(
      naming.compose_project,
      stackRow,
      naming.compose_project,
    )
    const network = resource(naming.network, networkRow, naming.network)
    const dataStore = resource(
      naming.data_store,
      dataStoreRow,
      naming.data_store,
    )

    if (stackRow !== undefined) {
      const status = readString(stackRow.status) ?? 'unknown'
      if (status !== 'running') {
        drift.push('stack_not_running')
        warnings.push('stack supabase observada fora de running')
      }
      const templateId = readString(stackRow.template_id)
      if (templateId !== null) {
        const known = this.templates.some(
          (candidate) => candidate.template_id === templateId,
        )
        if (!known) drift.push('unlisted_template')
        else if (templateId !== expectedTemplateId) {
          drift.push('unlisted_template')
        }
      }
      const observedVersion = readString(stackRow.template_version)
      if (
        template !== undefined &&
        observedVersion !== null &&
        observedVersion !== template.version
      ) {
        drift.push('template_version_drift')
      }
    }

    if (networkRow !== undefined) {
      if (
        readBoolean(networkRow.externally_attached) ||
        !readBoolean(networkRow.internal)
      ) {
        drift.push('shared_network')
        warnings.push('rede observada compartilhada ou externa')
      }
    }
    if (dataStoreRow !== undefined) {
      if (readBoolean(dataStoreRow.shared_with_other_project)) {
        drift.push('shared_data_store')
        warnings.push('data store observado compartilhado com outro projeto')
      }
    }

    const requiredServices: ReadonlyArray<SupabaseServiceId> =
      template?.services ?? []
    const observedServices = new Map<string, SupabaseRow>()
    for (const row of input.serviceRows) {
      const name = readString(row.service_name)
      if (name !== null) observedServices.set(name, row)
    }
    const services = requiredServices.map((service) => {
      const row = observedServices.get(service)
      const imageRef = row ? readString(row.image_ref) : null
      const imageDigest = row ? readString(row.image_digest) : null
      const pinned =
        imageRef !== null &&
        imageDigest !== null &&
        imageRef.includes(`@${imageDigest}`)
      if (row !== undefined && imageRef === null) {
        drift.push('unlisted_image')
      } else if (row !== undefined && imageDigest === null) {
        drift.push('unlisted_image')
      } else if (row !== undefined && !pinned) {
        drift.push('image_digest_drift')
      }
      if (row !== undefined) {
        const observedTemplate = readString(row.template_id)
        if (
          observedTemplate !== null &&
          observedTemplate !== expectedTemplateId
        ) {
          drift.push('unlisted_template')
        }
        const status = readEnum(
          row.status,
          SUPABASE_SERVICE_STATUSES,
          'unknown',
        )
        const health = readEnum(row.health, SUPABASE_SERVICE_HEALTH, 'unknown')
        if (status !== 'running' || health === 'unhealthy') {
          drift.push('service_unhealthy')
          warnings.push(`servico observado sem health: ${service}`)
        }
      }
      return {
        name: service,
        observed: row !== undefined,
        status:
          row === undefined
            ? ('absent' as const)
            : readEnum(row.status, SUPABASE_SERVICE_STATUSES, 'unknown'),
        health:
          row === undefined
            ? ('none' as const)
            : readEnum(row.health, SUPABASE_SERVICE_HEALTH, 'unknown'),
        image_ref: imageRef,
        pinned,
        restart_count: row ? (readInteger(row.restart_count) ?? 0) : 0,
      }
    })
    const extraServices = [...observedServices.keys()].filter(
      (name) => !requiredServices.includes(name as SupabaseServiceId),
    )
    if (extraServices.length > 0) {
      drift.push('unlisted_service')
      warnings.push('servico observado fora do template')
    }
    const missingServices = services
      .filter((service) => !service.observed)
      .map((service) => service.name)
    if (missingServices.length > 0) {
      warnings.push('servicos do template ainda ausentes')
    }

    const endpoints = input.endpointRows.map((row) => ({
      name: readString(row.endpoint_name) ?? 'unknown',
      scope: readScope(row.bind_scope),
      port: readInteger(row.bind_port),
      public_exposure: readBoolean(row.public_exposure),
      tls_terminated: readBoolean(row.tls_terminated),
    }))
    for (const endpoint of endpoints) {
      if (endpoint.public_exposure || endpoint.scope === 'public') {
        drift.push('public_endpoint_exposure')
        warnings.push('endpoint observado com exposicao publica; suprimido')
      }
      if (endpoint.scope === 'wildcard') {
        drift.push('wildcard_endpoint_binding')
        warnings.push('bind curinga observado')
      }
    }

    const brokerBindings = input.bindingRows.map((row) => ({
      name: readString(row.binding_name) ?? 'unknown',
      exists: readBoolean(row.exists),
      shared_with_other_project: readBoolean(row.shared_with_other_project),
      rotation_days: readInteger(row.rotation_days) ?? 0,
    }))
    if (brokerBindings.some((binding) => binding.shared_with_other_project)) {
      drift.push('shared_broker_binding')
      warnings.push('binding de broker observado compartilhado')
    }
    if (!brokerBindings.some((binding) => binding.exists)) {
      warnings.push('nenhum binding de broker observado')
    }

    // Nome de recurso fora do catálogo de serviços não entra na projeção: vira
    // drift (`unlisted_service`) em vez de atravessar como string livre.
    const capacity = input.capacityRows
      .map((row) => ({
        name: readString(row.resource_name) ?? 'unknown',
        cpu_millicores: readInteger(row.cpu_millicores) ?? 0,
        memory_mb: readInteger(row.memory_mb) ?? 0,
        disk_mb: readInteger(row.disk_mb) ?? 0,
      }))
      .filter((entry) =>
        (SUPABASE_SERVICE_IDS as ReadonlyArray<string>).includes(entry.name),
      )
    if (capacity.length !== input.capacityRows.length) {
      drift.push('unlisted_service')
      warnings.push('recurso observado fora do catalogo de servicos')
    }
    for (const entry of capacity) {
      const budget = profile.services[entry.name as SupabaseServiceId]
      if (
        entry.cpu_millicores > budget.cpu_millicores * CAPACITY_TOLERANCE ||
        entry.memory_mb > budget.memory_mb * CAPACITY_TOLERANCE ||
        entry.disk_mb > profile.data_store_mb.max
      ) {
        drift.push('capacity_exceeded')
        warnings.push(`capacidade observada acima do perfil: ${entry.name}`)
      }
    }

    const backupArtifacts = input.backupRows
      .map((row) => ({
        artifact_ref: readString(row.artifact_ref),
        created_at: readString(row.created_at),
        checksum: readString(row.checksum),
        size_mb: readInteger(row.size_mb),
        retention_days: readInteger(row.retention_days),
        destination: readString(row.destination),
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
          destination: 'local' | 'r2'
        } =>
          artifact.artifact_ref !== null &&
          isRelativeArtifactRef(artifact.artifact_ref) &&
          artifact.created_at !== null &&
          artifact.checksum !== null &&
          artifact.size_mb !== null &&
          artifact.retention_days !== null &&
          artifact.destination !== null &&
          (SUPABASE_BACKUP_DESTINATIONS as ReadonlyArray<string>).includes(
            artifact.destination,
          ),
      )
      .map((artifact) => ({
        artifact_ref: artifact.artifact_ref,
        created_at: artifact.created_at.slice(0, 40),
        checksum: artifact.checksum.slice(0, 80),
        size_mb: Math.trunc(artifact.size_mb),
        retention_days: Math.trunc(artifact.retention_days),
        destination: artifact.destination,
      }))
    if (input.backupRows.length !== backupArtifacts.length) {
      warnings.push('artefato de backup descartado por forma invalida')
    }

    const uniqueDrift = [...new Set(drift)].sort()
    const ownershipVerified =
      composeProject.ownership_verified &&
      network.ownership_verified &&
      dataStore.ownership_verified
    const templateComplete =
      template !== undefined &&
      missingServices.length === 0 &&
      services.every((service) => service.status === 'running') &&
      !uniqueDrift.includes('image_digest_drift') &&
      !uniqueDrift.includes('unlisted_image') &&
      !uniqueDrift.includes('unlisted_template') &&
      !uniqueDrift.includes('template_version_drift')

    const serverVersion =
      (dataStoreRow ? readString(dataStoreRow.engine_version) : null) ??
      'unknown'
    const database = {
      name: naming.database,
      exists: dataStore.exists,
      owner_role: null,
      ownership_marker: dataStore.ownership_marker,
      size_mb: dataStoreRow ? readInteger(dataStoreRow.size_mb) : null,
      is_template: false,
    }
    const unsafeFindings: Array<ObservedUnsafeFinding> = []
    if (
      uniqueDrift.includes('missing_ownership_marker') ||
      uniqueDrift.includes('foreign_ownership_marker')
    ) {
      unsafeFindings.push('missing_ownership_marker')
    }
    if (uniqueDrift.includes('wildcard_endpoint_binding')) {
      unsafeFindings.push('wildcard_listen_addresses')
    }
    if (uniqueDrift.includes('public_endpoint_exposure')) {
      unsafeFindings.push('public_postgres_bind')
    }

    const roleRow = input.roleRows.find(
      (row) => readString(row.role_name) === naming.app_role,
    )
    const appRole = {
      name: naming.app_role,
      exists: roleRow !== undefined,
      can_login: roleRow ? readBoolean(roleRow.can_login) : false,
      is_superuser: roleRow ? readBoolean(roleRow.is_superuser) : false,
      can_create_db: roleRow ? readBoolean(roleRow.can_create_db) : false,
      can_create_role: roleRow ? readBoolean(roleRow.can_create_role) : false,
      can_replicate: roleRow ? readBoolean(roleRow.can_replicate) : false,
      bypass_rls: roleRow ? readBoolean(roleRow.bypass_rls) : false,
      memberships: roleRow ? readMemberList(roleRow.memberships) : [],
    }
    if (
      appRole.exists &&
      (appRole.is_superuser ||
        appRole.can_create_db ||
        appRole.can_create_role ||
        appRole.can_replicate ||
        appRole.bypass_rls ||
        appRole.memberships.some(
          (membership) =>
            membership === SUPABASE_ADMIN_ROLE || membership === 'postgres',
        ))
    ) {
      unsafeFindings.push('app_role_privileged')
      warnings.push('app role observada com atributos elevados')
    }
    if (!appRole.exists) warnings.push('app role ainda nao existe')

    const privileges = input.grantRows.map((row) => ({
      schema_name: readString(row.schema_name) ?? 'unknown',
      role_name: readString(row.role_name) ?? 'unknown',
      privilege: readString(row.privilege) ?? 'unknown',
      grantable: readBoolean(row.grantable),
    }))

    const apiEndpoint = endpoints.find(
      (endpoint) => endpoint.name === API_ENDPOINT_NAME,
    )
    const endpointMasked =
      apiEndpoint !== undefined &&
      apiEndpoint.port !== null &&
      apiEndpoint.scope === 'loopback'
        ? formatLoopbackEndpoint(apiEndpoint.port)
        : null

    const stack = supabaseStackProjectionSchema.parse({
      catalog_version: SUPABASE_CATALOG_VERSION,
      observer_version: SUPABASE_OBSERVER_VERSION,
      template_id: stackRow ? readString(stackRow.template_id) : null,
      template_version: stackRow ? readString(stackRow.template_version) : null,
      expected_template_id: expectedTemplateId,
      compose_project: composeProject,
      network,
      data_store: dataStore,
      services,
      endpoints,
      broker_bindings: brokerBindings,
      capacity,
      missing_services: missingServices,
      drift_findings: uniqueDrift,
      template_complete: templateComplete,
      ownership_verified: ownershipVerified,
      backup_artifacts: backupArtifacts,
    })
    assertNoCredentialMaterialInProjection(stack)

    const revision = `obsrev_${hashCanonical({
      observer_version: SUPABASE_OBSERVER_VERSION,
      driver_version: SUPABASE_DRIVER_VERSION,
      catalog_version: SUPABASE_CATALOG_VERSION,
      host_target: intent.host_target,
      environment: intent.environment,
      project_id: naming.project_id,
      server_version: serverVersion,
      database,
      app_role: appRole,
      endpoint_masked: endpointMasked,
      unsafe_findings: unsafeFindings,
      ownership_verified: ownershipVerified,
      template_id: stack.template_id,
      template_version: stack.template_version,
      expected_template_id: stack.expected_template_id,
      template_complete: stack.template_complete,
      compose_project: stack.compose_project,
      network: stack.network,
      data_store: stack.data_store,
      services: stack.services,
      endpoints: stack.endpoints,
      broker_bindings: stack.broker_bindings,
      capacity: stack.capacity,
      drift_findings: stack.drift_findings,
      backup_artifacts: stack.backup_artifacts,
    }).slice(0, 32)}`

    const state = observedStateSchema.parse({
      driver: SUPABASE_DRIVER_ID,
      driver_version: SUPABASE_DRIVER_VERSION,
      observer_version: SUPABASE_OBSERVER_VERSION,
      host_target: intent.host_target,
      environment: intent.environment,
      project_id: naming.project_id,
      observed_at: input.observedAt,
      revision,
      server_version: serverVersion,
      database,
      app_role: appRole,
      privileges,
      extensions: [],
      disallowed_extensions: [],
      endpoint_masked: endpointMasked,
      unsafe_findings: [...new Set(unsafeFindings)].sort(),
      ownership_verified: ownershipVerified,
      backup_artifacts: backupArtifacts.map((artifact) => ({
        artifact_ref: artifact.artifact_ref,
        created_at: artifact.created_at,
        checksum: artifact.checksum,
        size_mb: artifact.size_mb,
        retention_days: artifact.retention_days,
      })),
      warnings: warnings.slice(0, 50),
    })
    assertNoCredentialMaterial(state)

    return Object.freeze({ state, stack })
  }
}

/** Nome do endpoint canônico da stack (entrada única do gateway). */
export const API_ENDPOINT_NAME = 'api'

/**
 * Margem aceita entre o orçamento do perfil e a capacidade observada antes de
 * registrar drift (o runtime tem overhead sobre o limite declarado).
 */
export const CAPACITY_TOLERANCE = 1.5

/** `endpoint_masked` canônico: sempre loopback, nunca o endereço observado. */
export function formatLoopbackEndpoint(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return `127.0.0.1:${port}`
}
