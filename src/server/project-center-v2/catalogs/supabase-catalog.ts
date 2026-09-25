/**
 * Catálogo compilado da stack Supabase isolada em dry-run (PR 3).
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §8.3 e §10. Este
 * módulo é a **única** origem de imagem, digest, template, perfil de recurso,
 * porta interna e target ID aceitos pelo driver `supabase_isolated`. Nada aqui
 * vem de request: request livre de imagem, host, path, rede ou porta é recusado
 * antes de qualquer plano existir.
 *
 * Garantias verificadas por `supabase-catalog.test.ts`:
 * - toda imagem tem digest `sha256` de 64 hex; referência só por tag é recusada;
 * - template, serviço e target ID fora da allowlist falham com `POLICY_DENIED`;
 * - o catálogo inteiro é inerte: nenhum valor sensível (a redaction canônica é
 *   idempotente sobre ele) e nenhum path absoluto, DSN, token ou chave;
 * - quotas de perfil são consistentes com o orçamento declarado por serviço, e
 *   a soma é conferida na carga do módulo (drift de catálogo falha fechado).
 */
import { z } from 'zod'
import { CAPABILITY_KEYS } from '../drivers/types'
import type { ErrorCode } from '../domain'
import type { CapabilityKey, NumericQuota } from '../drivers/types'

/** Versão do catálogo; entra na auditoria do plano (nunca no request). */
export const SUPABASE_CATALOG_VERSION = 'pcv2-supabase-catalog-v1'

// ---------------------------------------------------------------------------
// Serviços da stack
// ---------------------------------------------------------------------------

/** Serviços canônicos da stack isolada, na ordem de composição. */
export const SUPABASE_SERVICE_IDS = [
  'postgres',
  'gotrue',
  'storage-api',
  'realtime',
  'postgrest',
  'gateway',
] as const
export type SupabaseServiceId = (typeof SUPABASE_SERVICE_IDS)[number]

/** Serviços que existem em qualquer template (data store + entrada única). */
export const SUPABASE_CORE_SERVICES: ReadonlyArray<SupabaseServiceId> =
  Object.freeze(['postgres', 'gateway'])

/** Serviço que materializa cada capability do contrato. */
export const SUPABASE_CAPABILITY_SERVICES: Readonly<
  Record<CapabilityKey, SupabaseServiceId>
> = Object.freeze({
  auth: 'gotrue',
  storage: 'storage-api',
  realtime: 'realtime',
  postgrest: 'postgrest',
  backup: 'postgres',
})

/**
 * Porta **interna** de cada serviço (allowlist compilada, spec §10). Nenhuma
 * porta publicada é escolhida pelo request: a exposição externa é etapa futura
 * com approval próprio e, no dry-run, bind público vira achado de drift.
 */
export const SUPABASE_INTERNAL_PORTS: Readonly<
  Record<SupabaseServiceId, number>
> = Object.freeze({
  postgres: 5432,
  gotrue: 9999,
  'storage-api': 5000,
  realtime: 4000,
  postgrest: 3000,
  gateway: 8000,
})

// ---------------------------------------------------------------------------
// Imagens pinadas por digest
// ---------------------------------------------------------------------------

export interface SupabaseImagePin {
  readonly service: SupabaseServiceId
  /** Repositório público aceito (`namespace/nome`, sem registry nem tag). */
  readonly repository: string
  /** Tag legível; documentação apenas — o pin efetivo é o digest. */
  readonly tag: string
  readonly digest: string
  /** Data (UTC) da última verificação do digest no registry público. */
  readonly verified_at: string
}

/** Forma exigida de digest de manifesto. */
export const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
/** Forma exigida de referência pinada: `repo[@...]@sha256:<64 hex>`. */
export const PINNED_IMAGE_REF_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$/

/**
 * Digests verificados em 2026-09-25 no registry público (Docker Hub), via
 * `GET /v2/repositories/<repo>/tags/<tag>` (`digest` = manifesto multi-arquitetura).
 */
export const SUPABASE_IMAGE_PINS: Readonly<
  Record<SupabaseServiceId, SupabaseImagePin>
> = Object.freeze({
  postgres: Object.freeze({
    service: 'postgres',
    repository: 'supabase/postgres',
    tag: '15.14.1.176',
    digest:
      'sha256:96edd90f1f9833b09aba5afe579260c44f06adffbe92035bcd09e0a3125a7bbe',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
  gotrue: Object.freeze({
    service: 'gotrue',
    repository: 'supabase/gotrue',
    tag: 'v2.197.0',
    digest:
      'sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
  'storage-api': Object.freeze({
    service: 'storage-api',
    repository: 'supabase/storage-api',
    tag: 'v1.79.19',
    digest:
      'sha256:6ed034de789983954f36dbf3bda7ce8b69b919533a7a8df3f5c6c357f9ab6835',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
  realtime: Object.freeze({
    service: 'realtime',
    repository: 'supabase/realtime',
    tag: 'v2.138.1',
    digest:
      'sha256:7a6d995635f747b566079e51b1a1388dded8b2d0dfef1eda5afe98f6c9e5567e',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
  postgrest: Object.freeze({
    service: 'postgrest',
    repository: 'postgrest/postgrest',
    tag: 'v16.4',
    digest:
      'sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
  gateway: Object.freeze({
    service: 'gateway',
    repository: 'library/kong',
    tag: '3.9.3',
    digest:
      'sha256:12972ce1ab6396083e56e7d46fce084836c98cc819344bef44a1f583ec3ab191',
    verified_at: '2026-09-25T00:00:00.000Z',
  }),
})

// ---------------------------------------------------------------------------
// Templates permitidos
// ---------------------------------------------------------------------------

export const SUPABASE_TEMPLATE_IDS = ['sb-stack-full'] as const
export type SupabaseTemplateId = (typeof SUPABASE_TEMPLATE_IDS)[number]

export interface SupabaseTemplate {
  readonly template_id: SupabaseTemplateId
  readonly version: string
  /** Capabilities do contrato que o template entrega. */
  readonly capabilities: ReadonlyArray<CapabilityKey>
  readonly services: ReadonlyArray<SupabaseServiceId>
}

/** Allowlist fechada de templates; a escolha é derivada, nunca recebida. */
export const SUPABASE_TEMPLATES: ReadonlyArray<SupabaseTemplate> =
  Object.freeze([
    Object.freeze({
      template_id: 'sb-stack-full',
      version: '2026.09',
      capabilities: Object.freeze([...CAPABILITY_KEYS]),
      services: Object.freeze([...SUPABASE_SERVICE_IDS]),
    }),
  ])

export const SUPABASE_TEMPLATE_ALLOWLIST: ReadonlyArray<string> = Object.freeze(
  [...SUPABASE_TEMPLATE_IDS],
)

// ---------------------------------------------------------------------------
// Perfis de recurso
// ---------------------------------------------------------------------------

export const SUPABASE_PROFILE_IDS = ['sb-small', 'sb-standard'] as const
export type SupabaseProfileId = (typeof SUPABASE_PROFILE_IDS)[number]

export interface SupabaseServiceBudget {
  readonly cpu_millicores: number
  readonly memory_mb: number
}

export interface SupabaseResourceProfile {
  readonly profile_id: SupabaseProfileId
  /** Cota da stack inteira (soma dos serviços), nunca de um serviço isolado. */
  readonly cpu_millicores: NumericQuota
  readonly memory_mb: NumericQuota
  readonly data_store_mb: NumericQuota
  readonly backup_retention_days: NumericQuota
  readonly services: Readonly<Record<SupabaseServiceId, SupabaseServiceBudget>>
}

function budgets(
  input: Readonly<Record<SupabaseServiceId, [number, number]>>,
): Readonly<Record<SupabaseServiceId, SupabaseServiceBudget>> {
  const output: Record<string, SupabaseServiceBudget> = {}
  for (const service of SUPABASE_SERVICE_IDS) {
    const [cpu, memory] = input[service]
    output[service] = Object.freeze({
      cpu_millicores: cpu,
      memory_mb: memory,
    })
  }
  return Object.freeze(output)
}

/** Perfis em ordem crescente; a seleção pega o menor que couber no pedido. */
export const SUPABASE_RESOURCE_PROFILES: ReadonlyArray<SupabaseResourceProfile> =
  Object.freeze([
    Object.freeze({
      profile_id: 'sb-small',
      cpu_millicores: Object.freeze({ min: 1000, max: 4000, default: 1500 }),
      memory_mb: Object.freeze({ min: 2560, max: 10240, default: 3840 }),
      data_store_mb: Object.freeze({ min: 128, max: 10240, default: 1024 }),
      backup_retention_days: Object.freeze({ min: 7, max: 30, default: 7 }),
      services: budgets({
        postgres: [300, 768],
        gotrue: [150, 384],
        'storage-api': [150, 384],
        realtime: [150, 384],
        postgrest: [150, 384],
        gateway: [100, 256],
      }),
    }),
    Object.freeze({
      profile_id: 'sb-standard',
      cpu_millicores: Object.freeze({ min: 3500, max: 8000, default: 5000 }),
      memory_mb: Object.freeze({ min: 8192, max: 16384, default: 10240 }),
      data_store_mb: Object.freeze({ min: 1024, max: 102400, default: 8192 }),
      backup_retention_days: Object.freeze({ min: 7, max: 90, default: 14 }),
      services: budgets({
        postgres: [1000, 3072],
        gotrue: [500, 1024],
        'storage-api': [500, 1024],
        realtime: [500, 1024],
        postgrest: [500, 1024],
        gateway: [500, 1024],
      }),
    }),
  ])

// ---------------------------------------------------------------------------
// Target IDs (identidades fechadas dos recursos planejados)
// ---------------------------------------------------------------------------

export const SUPABASE_TARGET_KINDS = [
  'registry',
  'compose-project',
  'network',
  'data-store',
  'database',
  'app-role',
  'grant',
  'broker-binding',
  'stack',
  'health',
  'endpoint',
  'backup-policy',
  'r2-prefix',
  'restore-test',
  'verification',
  'registry-record',
  'platform-context',
] as const
export type SupabaseTargetKind = (typeof SUPABASE_TARGET_KINDS)[number]

/** Prefixo de `target_ref` por tipo de recurso (allowlist compilada). */
export const SUPABASE_TARGET_IDS: Readonly<Record<SupabaseTargetKind, string>> =
  Object.freeze({
    registry: 'registry',
    'compose-project': 'compose-project',
    network: 'network',
    'data-store': 'data-store',
    database: 'database',
    'app-role': 'app-role',
    grant: 'grant',
    'broker-binding': 'broker-binding',
    stack: 'stack',
    health: 'health',
    endpoint: 'endpoint',
    'backup-policy': 'backup-policy',
    'r2-prefix': 'r2-prefix',
    'restore-test': 'restore-test',
    verification: 'verification',
    'registry-record': 'registry-record',
    'platform-context': 'platform-context',
  })

/** Limite de `target_ref` no contrato (`PlannedAction.target_ref`). */
export const TARGET_REF_MAX_LENGTH = 200

// ---------------------------------------------------------------------------
// Erros de catálogo (falha fechada)
// ---------------------------------------------------------------------------

/** Valor fora do catálogo compilado; nunca há fallback silencioso. */
export class SupabaseCatalogError extends Error {
  readonly code: ErrorCode
  readonly value: string

  constructor(
    message: string,
    value: string,
    code: ErrorCode = 'POLICY_DENIED',
  ) {
    super(message)
    this.name = 'SupabaseCatalogError'
    this.value = value.slice(0, 64)
    this.code = code
  }
}

export class UnknownTemplateError extends SupabaseCatalogError {
  constructor(templateId: unknown) {
    super(
      'template supabase fora da allowlist',
      typeof templateId === 'string' ? templateId : typeof templateId,
    )
    this.name = 'UnknownTemplateError'
  }
}

export class UnknownServiceError extends SupabaseCatalogError {
  constructor(service: unknown) {
    super(
      'servico supabase fora da allowlist',
      typeof service === 'string' ? service : typeof service,
    )
    this.name = 'UnknownServiceError'
  }
}

export class UnpinnedImageError extends SupabaseCatalogError {
  constructor(image: unknown) {
    super(
      'imagem supabase sem digest pinado',
      typeof image === 'string' ? image : typeof image,
    )
    this.name = 'UnpinnedImageError'
  }
}

// ---------------------------------------------------------------------------
// Leitura do catálogo
// ---------------------------------------------------------------------------

export function isSupabaseServiceId(
  value: unknown,
): value is SupabaseServiceId {
  return (
    typeof value === 'string' &&
    (SUPABASE_SERVICE_IDS as ReadonlyArray<string>).includes(value)
  )
}

export function assertSupabaseServiceId(value: unknown): SupabaseServiceId {
  if (!isSupabaseServiceId(value)) throw new UnknownServiceError(value)
  return value
}

export function isKnownTemplateId(value: unknown): value is SupabaseTemplateId {
  return (
    typeof value === 'string' &&
    (SUPABASE_TEMPLATE_IDS as ReadonlyArray<string>).includes(value)
  )
}

export function assertKnownTemplateId(value: unknown): SupabaseTemplateId {
  if (!isKnownTemplateId(value)) throw new UnknownTemplateError(value)
  return value
}

/** Digest pinado do serviço; serviço fora do catálogo falha fechado. */
export function imagePinFor(service: unknown): SupabaseImagePin {
  const id = assertSupabaseServiceId(service)
  return SUPABASE_IMAGE_PINS[id]
}

/** Referência **pinada** (`repo@sha256:<64 hex>`) do serviço. */
export function pinnedImageRefFor(service: unknown): string {
  const pin = imagePinFor(service)
  return assertPinnedImageRef(`${pin.repository}@${pin.digest}`)
}

/**
 * Aceita apenas referência de imagem com digest e repositório do catálogo.
 * Tag, `latest` e repositório desconhecido são recusados: imagem sem digest
 * nunca entra em plano.
 */
export function assertPinnedImageRef(value: unknown): string {
  if (typeof value !== 'string' || !PINNED_IMAGE_REF_PATTERN.test(value)) {
    throw new UnpinnedImageError(value)
  }
  const repository = value.slice(0, value.indexOf('@'))
  const known = SUPABASE_SERVICE_IDS.some(
    (service) => SUPABASE_IMAGE_PINS[service].repository === repository,
  )
  if (!known) throw new UnpinnedImageError(value)
  return value
}

/** Porta interna do serviço; fora do catálogo falha fechado. */
export function internalPortFor(service: unknown): number {
  const id = assertSupabaseServiceId(service)
  return SUPABASE_INTERNAL_PORTS[id]
}

/** Serviços exigidos pelas capabilities pedidas (ordem canônica, sem duplicata). */
export function requiredServicesFor(
  capabilities: Readonly<Partial<Record<CapabilityKey, boolean>>>,
): ReadonlyArray<SupabaseServiceId> {
  const required = new Set<SupabaseServiceId>(SUPABASE_CORE_SERVICES)
  for (const capability of CAPABILITY_KEYS) {
    if (capabilities[capability] === true) {
      required.add(SUPABASE_CAPABILITY_SERVICES[capability])
    }
  }
  return Object.freeze(
    SUPABASE_SERVICE_IDS.filter((service) => required.has(service)),
  )
}

/**
 * Template que atende as capabilities pedidas: o **menor** da allowlist que as
 * cobre. Sem candidato, a capability não é suportada e o dry-run é recusado.
 */
export function resolveTemplateFor(
  capabilities: Readonly<Partial<Record<CapabilityKey, boolean>>>,
  templates: ReadonlyArray<SupabaseTemplate> = SUPABASE_TEMPLATES,
): SupabaseTemplate | undefined {
  const requested = CAPABILITY_KEYS.filter(
    (capability) => capabilities[capability] === true,
  )
  const candidates = templates
    .filter((template) =>
      requested.every((capability) =>
        template.capabilities.includes(capability),
      ),
    )
    .slice()
    .sort(
      (left, right) =>
        left.capabilities.length - right.capabilities.length ||
        left.template_id.localeCompare(right.template_id),
    )
  return candidates[0]
}

/** Capabilities que o template não entrega dentre as pedidas. */
export function unsupportedCapabilities(
  capabilities: Readonly<Partial<Record<CapabilityKey, boolean>>>,
  template: SupabaseTemplate,
): ReadonlyArray<CapabilityKey> {
  return Object.freeze(
    CAPABILITY_KEYS.filter(
      (capability) =>
        capabilities[capability] === true &&
        !template.capabilities.includes(capability),
    ),
  )
}

/**
 * Menor perfil da allowlist que comporta os limites pedidos. Sem candidato,
 * o pedido excede a capacidade do catálogo (`QUOTA_EXCEEDED` no driver).
 */
export function resolveResourceProfile(
  limits:
    | {
        readonly database_size_mb?: number
        readonly memory_mb?: number
        readonly cpu_millicores?: number
        readonly backup_retention_days?: number
      }
    | undefined,
  profiles: ReadonlyArray<SupabaseResourceProfile> = SUPABASE_RESOURCE_PROFILES,
): SupabaseResourceProfile | undefined {
  const requested: ReadonlyArray<{
    readonly value: number | undefined
    readonly field: SupabaseQuotaField
  }> = [
    { value: limits?.cpu_millicores, field: 'cpu_millicores' },
    { value: limits?.memory_mb, field: 'memory_mb' },
    { value: limits?.database_size_mb, field: 'data_store_mb' },
    {
      value: limits?.backup_retention_days,
      field: 'backup_retention_days',
    },
  ]
  return profiles.find((profile) =>
    requested.every((entry) => {
      if (entry.value === undefined) return true
      return entry.value <= profile[entry.field].max
    }),
  )
}

/** Campos de quota de um perfil de recurso. */
export type SupabaseQuotaField =
  | 'cpu_millicores'
  | 'memory_mb'
  | 'data_store_mb'
  | 'backup_retention_days'

/** Menor quota do catálogo para um campo (base do erro `limit_below_minimum`). */
export function profileQuota(
  profile: SupabaseResourceProfile,
  field: SupabaseQuotaField,
): NumericQuota {
  return profile[field]
}

/**
 * `target_ref` de um recurso planejado: `<prefixo>:<nome>#<ownership marker>`.
 * O marker esperado viaja **dentro** do plano (o contrato não permite campo
 * extra em `PlannedAction`), de modo que a execução do PR 6 só adota recurso
 * cujo marker observado seja exatamente este.
 */
export function targetRefFor(input: {
  readonly kind: SupabaseTargetKind
  readonly name: string
  readonly ownership_marker: string
}): string {
  const prefix = SUPABASE_TARGET_IDS[input.kind]
  const name = assertTargetName(input.name)
  const reference = `${prefix}:${name}#${assertOwnershipMarker(input.ownership_marker)}`
  if (reference.length > TARGET_REF_MAX_LENGTH) {
    throw new SupabaseCatalogError(
      'target_ref acima do limite do contrato',
      prefix,
      'INVALID_REQUEST',
    )
  }
  return reference
}

function assertTargetName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 120 ||
    value.startsWith('/') ||
    value.includes('..') ||
    value.includes('\\') ||
    /\s/.test(value) ||
    value.includes('#')
  ) {
    throw new SupabaseCatalogError(
      'nome de recurso invalido no target_ref',
      typeof value === 'string' ? value : typeof value,
      'INVALID_REQUEST',
    )
  }
  return value
}

function assertOwnershipMarker(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 140 ||
    /\s/.test(value) ||
    value.startsWith('/')
  ) {
    throw new SupabaseCatalogError(
      'ownership marker invalido no target_ref',
      typeof value === 'string' ? value : typeof value,
      'INVALID_REQUEST',
    )
  }
  return value
}

/** Prefixos legíveis por tipo de target (auditoria/teste). */
export function targetPrefixFor(kind: unknown): string {
  if (
    typeof kind !== 'string' ||
    !(SUPABASE_TARGET_KINDS as ReadonlyArray<string>).includes(kind)
  ) {
    throw new SupabaseCatalogError(
      'target id fora da allowlist',
      typeof kind === 'string' ? kind : typeof kind,
      'INVALID_REQUEST',
    )
  }
  return SUPABASE_TARGET_IDS[kind as SupabaseTargetKind]
}

// ---------------------------------------------------------------------------
// Snapshot do catálogo (auditoria, sem valor sensível)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contrato de observação da stack (vocabulário fechado + projeção sanitizada)
// ---------------------------------------------------------------------------

/** Máximo de linhas aceitas de uma porta de observação. */
export const SUPABASE_MAX_ROWS = 50

/** Escopos de bind reconhecidos; nenhum endereço bruto observado é preservado. */
export const SUPABASE_BIND_SCOPES = [
  'loopback',
  'private_network',
  'public',
  'wildcard',
  'unknown',
] as const
export type SupabaseBindScope = (typeof SUPABASE_BIND_SCOPES)[number]

/** Estados de serviço reconhecidos. */
export const SUPABASE_SERVICE_STATUSES = [
  'running',
  'stopped',
  'absent',
  'unknown',
] as const
export type SupabaseServiceStatus = (typeof SUPABASE_SERVICE_STATUSES)[number]

/** Estados de health reconhecidos. */
export const SUPABASE_SERVICE_HEALTH = [
  'healthy',
  'unhealthy',
  'starting',
  'none',
  'unknown',
] as const
export type SupabaseServiceHealth = (typeof SUPABASE_SERVICE_HEALTH)[number]

/** Destinos de backup aceitos (allowlist versionada). */
export const SUPABASE_BACKUP_DESTINATIONS = ['local', 'r2'] as const

/** Achados de drift: vocabulário fechado comparado contra o catálogo. */
export const SUPABASE_DRIFT_FINDINGS = [
  'missing_ownership_marker',
  'foreign_ownership_marker',
  'unlisted_template',
  'template_version_drift',
  'resource_name_drift',
  'unlisted_service',
  'unlisted_image',
  'image_digest_drift',
  'stack_not_running',
  'service_unhealthy',
  'public_endpoint_exposure',
  'wildcard_endpoint_binding',
  'shared_network',
  'shared_data_store',
  'shared_broker_binding',
  'capacity_exceeded',
] as const
export type SupabaseDriftFinding = (typeof SUPABASE_DRIFT_FINDINGS)[number]

const driftFindingSchema = z.enum(SUPABASE_DRIFT_FINDINGS)

const resourceObservationSchema = z
  .object({
    name: z.string().min(1).max(120),
    exists: z.boolean(),
    ownership_marker: z.union([z.string().max(200), z.null()]),
    ownership_verified: z.boolean(),
    drift: z.array(driftFindingSchema).max(SUPABASE_DRIFT_FINDINGS.length),
  })
  .strict()

const serviceObservationSchema = z
  .object({
    name: z.string().min(1).max(64),
    observed: z.boolean(),
    status: z.enum(SUPABASE_SERVICE_STATUSES),
    health: z.enum(SUPABASE_SERVICE_HEALTH),
    image_ref: z.union([z.string().max(200), z.null()]),
    pinned: z.boolean(),
    restart_count: z.number().int().min(0).max(100000),
  })
  .strict()

const endpointObservationSchema = z
  .object({
    name: z.string().min(1).max(64),
    scope: z.enum(SUPABASE_BIND_SCOPES),
    port: z.union([z.number().int().min(1).max(65535), z.null()]),
    public_exposure: z.boolean(),
    tls_terminated: z.boolean(),
  })
  .strict()

const brokerBindingObservationSchema = z
  .object({
    name: z.string().min(1).max(64),
    exists: z.boolean(),
    shared_with_other_project: z.boolean(),
    rotation_days: z.number().int().min(0).max(3650),
  })
  .strict()

const capacityObservationSchema = z
  .object({
    name: z.string().min(1).max(64),
    cpu_millicores: z.number().int().min(0).max(1000000),
    memory_mb: z.number().int().min(0).max(1000000),
    disk_mb: z.number().int().min(0).max(100000000),
  })
  .strict()

const backupArtifactSchema = z
  .object({
    artifact_ref: z.string().min(1).max(256),
    created_at: z.string().min(1).max(40),
    checksum: z.string().min(1).max(80),
    size_mb: z.number().int().min(0),
    retention_days: z.number().int().min(0).max(365),
    destination: z.enum(SUPABASE_BACKUP_DESTINATIONS),
  })
  .strict()

/**
 * Projeção sanitizada da stack observada: existência, ownership marker, drift
 * e capacidade por recurso. Schema estrito: campo desconhecido é recusado e
 * não existe campo de endereço bruto, credencial, token ou path por construção.
 */
export const supabaseStackProjectionSchema = z
  .object({
    catalog_version: z.string().min(1).max(64),
    observer_version: z.string().min(1).max(64),
    template_id: z.union([z.string().max(64), z.null()]),
    template_version: z.union([z.string().max(64), z.null()]),
    expected_template_id: z.string().min(1).max(64),
    compose_project: resourceObservationSchema,
    network: resourceObservationSchema,
    data_store: resourceObservationSchema,
    services: z.array(serviceObservationSchema).max(20),
    endpoints: z.array(endpointObservationSchema).max(20),
    broker_bindings: z.array(brokerBindingObservationSchema).max(20),
    capacity: z.array(capacityObservationSchema).max(20),
    missing_services: z.array(z.string().min(1).max(64)).max(20),
    drift_findings: z
      .array(driftFindingSchema)
      .max(SUPABASE_DRIFT_FINDINGS.length),
    template_complete: z.boolean(),
    ownership_verified: z.boolean(),
    backup_artifacts: z.array(backupArtifactSchema).max(SUPABASE_MAX_ROWS),
  })
  .strict()

export type SupabaseStackProjection = z.infer<
  typeof supabaseStackProjectionSchema
>

export function assertSupabaseStackProjection(
  value: unknown,
): SupabaseStackProjection {
  return supabaseStackProjectionSchema.parse(value)
}

/**
 * Projeção **fail-closed** usada quando nenhuma stack foi observada: nada
 * existe, nada é adotado e o plano repete todos os efeitos. Nunca assume
 * recurso existente por ausência de dado.
 */
export function emptyStackProjection(input: {
  readonly compose_project: string
  readonly network: string
  readonly data_store: string
  readonly expected_template_id: string
  readonly observer_version?: string
}): SupabaseStackProjection {
  const absent = (name: string) => ({
    name,
    exists: false,
    ownership_marker: null,
    ownership_verified: false,
    drift: [] as ReadonlyArray<SupabaseDriftFinding>,
  })
  return supabaseStackProjectionSchema.parse({
    catalog_version: SUPABASE_CATALOG_VERSION,
    observer_version: input.observer_version ?? 'observacao-ausente',
    template_id: null,
    template_version: null,
    expected_template_id: input.expected_template_id,
    compose_project: absent(input.compose_project),
    network: absent(input.network),
    data_store: absent(input.data_store),
    services: [],
    endpoints: [],
    broker_bindings: [],
    capacity: [],
    missing_services: [],
    drift_findings: [],
    template_complete: false,
    ownership_verified: false,
    backup_artifacts: [],
  })
}

/** Retrato congelado do catálogo; usado no hash/auditoria e nos testes. */
export const SUPABASE_CATALOG_SNAPSHOT = Object.freeze({
  catalog_version: SUPABASE_CATALOG_VERSION,
  services: SUPABASE_SERVICE_IDS,
  templates: SUPABASE_TEMPLATES.map((template) => ({
    template_id: template.template_id,
    version: template.version,
    capabilities: template.capabilities,
    services: template.services,
  })),
  images: SUPABASE_SERVICE_IDS.map((service) => ({
    service,
    ref: pinnedImageRefFor(service),
    tag: SUPABASE_IMAGE_PINS[service].tag,
    verified_at: SUPABASE_IMAGE_PINS[service].verified_at,
  })),
  internal_ports: SUPABASE_SERVICE_IDS.map((service) => ({
    service,
    port: SUPABASE_INTERNAL_PORTS[service],
  })),
  profiles: SUPABASE_RESOURCE_PROFILES.map((profile) => ({
    profile_id: profile.profile_id,
    cpu_millicores: profile.cpu_millicores,
    memory_mb: profile.memory_mb,
    data_store_mb: profile.data_store_mb,
    backup_retention_days: profile.backup_retention_days,
  })),
  target_ids: SUPABASE_TARGET_KINDS.map((kind) => ({
    kind,
    prefix: SUPABASE_TARGET_IDS[kind],
  })),
})

// ---------------------------------------------------------------------------
// Guarda de drift do catálogo (falha na carga, não em produção)
// ---------------------------------------------------------------------------

function assertCatalogConsistency(): void {
  for (const service of SUPABASE_SERVICE_IDS) {
    const pin = SUPABASE_IMAGE_PINS[service]
    if (pin.service !== service || !IMAGE_DIGEST_PATTERN.test(pin.digest)) {
      throw new UnpinnedImageError(service)
    }
    assertPinnedImageRef(`${pin.repository}@${pin.digest}`)
    const port = SUPABASE_INTERNAL_PORTS[service]
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SupabaseCatalogError('porta interna invalida', service)
    }
  }
  for (const capability of CAPABILITY_KEYS) {
    assertSupabaseServiceId(SUPABASE_CAPABILITY_SERVICES[capability])
  }
  for (const template of SUPABASE_TEMPLATES) {
    assertKnownTemplateId(template.template_id)
    for (const service of template.services) assertSupabaseServiceId(service)
    for (const service of SUPABASE_CORE_SERVICES) {
      if (!template.services.includes(service)) {
        throw new SupabaseCatalogError(
          'template sem servico essencial',
          `${template.template_id}:${service}`,
        )
      }
    }
  }
  for (const profile of SUPABASE_RESOURCE_PROFILES) {
    const cpu = SUPABASE_SERVICE_IDS.reduce(
      (total, service) => total + profile.services[service].cpu_millicores,
      0,
    )
    const memory = SUPABASE_SERVICE_IDS.reduce(
      (total, service) => total + profile.services[service].memory_mb,
      0,
    )
    if (
      profile.cpu_millicores.min !== cpu ||
      profile.memory_mb.min !== memory
    ) {
      throw new SupabaseCatalogError(
        'quota de perfil inconsistente com os servicos',
        profile.profile_id,
      )
    }
    if (
      profile.cpu_millicores.default > profile.cpu_millicores.max ||
      profile.memory_mb.default > profile.memory_mb.max ||
      profile.data_store_mb.default > profile.data_store_mb.max
    ) {
      throw new SupabaseCatalogError(
        'default de perfil acima do maximo',
        profile.profile_id,
      )
    }
  }
}

assertCatalogConsistency()
