/**
 * Serviço de backup do Project Center v2 (PR 6).
 *
 * Fonte da verdade: plano §PR 6 (passos 7 e 8) e spec §8.2 (item 6), §14.
 *
 * Invariantes:
 * - backup por **project UUID + ambiente**, com prefixo dedicado
 *   (`projects/<project_id>/<environment>/postgres/` no R2 e o prefixo local
 *   equivalente) — nunca um path vindo de request e nunca a raiz do bucket;
 * - **checksum** sha256 do artefato calculado aqui e conferido no restore;
 * - **retenção** dentro da quota da política (7..90 dias), sem clamp silencioso;
 * - artefato **sanitizado**: o manifesto só carrega nomes derivados server-side
 *   (projeto, ambiente, driver, database, checksum, tamanho, retenção) — nada de
 *   DSN, senha, path absoluto, host ou token;
 * - escrita exige **lease vigente** (fencing token atual): sem lease não há
 *   backup, e writer stale é recusado;
 * - com as flags desligadas o serviço não escreve nada (`requireWorkerActive`).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  BACKUP_DESTINATIONS,
  NAMING_VERSION,
  localBackupPrefixFor,
  r2PrefixFor,
} from './naming'
import { requireWorkerActive } from './feature-flags'
import {
  ARTIFACT_REF_PATTERN,
  DRIVERS,
  ENVIRONMENTS,
  SHA256_PATTERN,
} from './domain'
import type { BackupDestination, ResourceNamingSnapshot } from './naming'
import type { Driver, Environment } from './domain'
import type { ProjectCenterV2Flags } from './feature-flags'
import type { LeaseStore } from './lease-store'
import type { ActionLeaseProof } from './executors/action-executor'

export const BACKUP_SERVICE_VERSION = 'pcv2-backup-v1'
export const BACKUP_MANIFEST_VERSION = 'pcv2-backup-manifest-v1'
/** Nome-base do arquivo de dump (relativo, sem diretório, sem extensão livre). */
export const BACKUP_FILE_BASE = 'postgres.dump'
/** Quota de retenção da spec §10. */
export const BACKUP_MIN_RETENTION_DAYS = 7
export const BACKUP_MAX_RETENTION_DAYS = 90
export const BACKUP_DEFAULT_RETENTION_DAYS = 30
/** Teto de tamanho do artefato aceito pelo serviço (512 MiB). */
export const BACKUP_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export class BackupInputError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly field: string

  constructor(field: string) {
    super(`entrada de backup invalida: ${field}`)
    this.name = 'BackupInputError'
    this.field = field
  }
}

/** Destino/prefixo fora da allowlist ou do escopo do projeto. */
export class BackupDestinationError extends Error {
  readonly code = 'POLICY_DENIED'
  readonly reason: string

  constructor(reason: string) {
    super('destino de backup recusado')
    this.name = 'BackupDestinationError'
    this.reason = reason
  }
}

/** Artefato/manifesto inconsistente (falha fechada). */
export class BackupArtifactError extends Error {
  readonly code = 'VERIFICATION_FAILED'
  readonly reason: string

  constructor(reason: string) {
    super('artefato de backup inconsistente')
    this.name = 'BackupArtifactError'
    this.reason = reason
  }
}

/** Manifesto sanitizado do artefato. Schema estrito: campo extra é recusado. */
export const backupManifestSchema = z
  .object({
    version: z.literal(BACKUP_MANIFEST_VERSION),
    naming_version: z.string().min(1).max(64),
    project_id: z.string().regex(/^[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/),
    environment: z.enum(ENVIRONMENTS),
    driver: z.enum(DRIVERS),
    database: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    artifact_ref: z.string().max(256).regex(ARTIFACT_REF_PATTERN),
    checksum: z.string().regex(SHA256_PATTERN),
    size_mb: z.number().int().min(0),
    retention_days: z
      .number()
      .int()
      .min(BACKUP_MIN_RETENTION_DAYS)
      .max(BACKUP_MAX_RETENTION_DAYS),
    created_at: z.string().datetime(),
  })
  .strict()

export type BackupManifest = z.infer<typeof backupManifestSchema>

export interface BackupArtifact {
  readonly artifact_ref: string
  readonly destination: BackupDestination
  readonly prefix: string
  readonly checksum: string
  readonly size_mb: number
  readonly retention_days: number
  readonly created_at: string
  readonly project_id: string
  readonly environment: Environment
  readonly driver: Driver
  readonly manifest_version: string
}

/** Porta de destino injetada (local ou R2). Nada de path no request. */
export interface BackupDestinationPort {
  readonly adapter_id: string
  readonly destination: BackupDestination
  write: (input: {
    readonly prefix: string
    readonly filename: string
    readonly bytes: Uint8Array
  }) => Promise<{ readonly artifact_ref: string }>
  read: (artifact_ref: string) => Promise<Uint8Array>
  list: (prefix: string) => Promise<
    ReadonlyArray<{
      readonly artifact_ref: string
      readonly size_bytes: number
      readonly created_at: string
    }>
  >
}

export interface BackupRequest {
  readonly operationId: string
  readonly projectId: string
  readonly environment: Environment
  readonly driver: Driver
  readonly naming: ResourceNamingSnapshot
  readonly lease: ActionLeaseProof
  readonly retentionDays?: number
  readonly destination?: BackupDestination
  /** Produz os bytes do dump (adapter de processo `pg_dump`). */
  readonly dump: () => Promise<Uint8Array>
}

export interface BackupRunResult {
  readonly artifact: BackupArtifact
  readonly manifest: BackupManifest
  readonly safe_detail: string
  readonly evidence_ref: string
}

export interface BackupService {
  readonly version: string
  run: (request: BackupRequest) => Promise<BackupRunResult>
  /** Confere manifesto + bytes + checksum (usado pelo verifier de restore). */
  verifyArtifact: (input: {
    readonly artifact: BackupArtifact
    readonly manifest: unknown
    readonly bytes: Uint8Array
  }) => BackupManifest
}

export interface BackupServiceDeps {
  readonly flags: ProjectCenterV2Flags
  readonly leases: LeaseStore
  readonly destinations: Readonly<
    Partial<Record<BackupDestination, BackupDestinationPort>>
  >
  readonly now?: () => Date
}

function assertDriver(value: unknown): Driver {
  if (
    typeof value !== 'string' ||
    !(DRIVERS as ReadonlyArray<string>).includes(value)
  ) {
    throw new BackupInputError('driver')
  }
  return value as Driver
}

function assertEnvironment(value: unknown): Environment {
  if (
    typeof value !== 'string' ||
    !(ENVIRONMENTS as ReadonlyArray<string>).includes(value)
  ) {
    throw new BackupInputError('environment')
  }
  return value as Environment
}

function assertDestination(value: unknown): BackupDestination {
  if (
    typeof value !== 'string' ||
    !(BACKUP_DESTINATIONS as ReadonlyArray<string>).includes(value)
  ) {
    throw new BackupDestinationError('destination_not_allowlisted')
  }
  return value as BackupDestination
}

export function assertRetentionDays(value: unknown): number {
  if (value === undefined) return BACKUP_DEFAULT_RETENTION_DAYS
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < BACKUP_MIN_RETENTION_DAYS ||
    value > BACKUP_MAX_RETENTION_DAYS
  ) {
    throw new BackupInputError('retention_days')
  }
  return value
}

/**
 * Prefixo dedicado do projeto/ambiente. É derivado server-side e conferido
 * contra o valor calculado: um prefixo arbitrário (raiz do bucket, `..`,
 * path absoluto) nunca é aceito.
 */
export function buildBackupPrefix(input: {
  readonly projectId: string
  readonly environment: Environment
  readonly destination: BackupDestination
}): string {
  const scope = {
    project_id: input.projectId,
    environment: input.environment,
  }
  return input.destination === 'r2'
    ? r2PrefixFor(scope)
    : localBackupPrefixFor(scope)
}

/** Nome do arquivo: sempre `postgres.dump` sob o prefixo dedicado. */
export function backupFileName(): string {
  return BACKUP_FILE_BASE
}

export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertBackupArtifactShape(value: unknown): BackupArtifact {
  if (value === null || typeof value !== 'object') {
    throw new BackupArtifactError('artifact_not_object')
  }
  const artifact = value as BackupArtifact
  if (
    typeof artifact.artifact_ref !== 'string' ||
    !ARTIFACT_REF_PATTERN.test(artifact.artifact_ref) ||
    artifact.artifact_ref.startsWith('/') ||
    artifact.artifact_ref.includes('..') ||
    artifact.artifact_ref.includes('\\') ||
    artifact.artifact_ref.includes('://')
  ) {
    throw new BackupArtifactError('artifact_ref_not_relative')
  }
  if (!SHA256_PATTERN.test(artifact.checksum)) {
    throw new BackupArtifactError('checksum_invalid')
  }
  assertDestination(artifact.destination)
  if (
    typeof artifact.retention_days !== 'number' ||
    !Number.isInteger(artifact.retention_days) ||
    artifact.retention_days < BACKUP_MIN_RETENTION_DAYS ||
    artifact.retention_days > BACKUP_MAX_RETENTION_DAYS
  ) {
    throw new BackupArtifactError('retention_days_out_of_quota')
  }
  if (artifact.manifest_version !== BACKUP_MANIFEST_VERSION) {
    throw new BackupArtifactError('manifest_version_unknown')
  }
  return artifact
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const now = deps.now ?? (() => new Date())

  function verifyArtifact(input: {
    readonly artifact: BackupArtifact
    readonly manifest: unknown
    readonly bytes: Uint8Array
  }): BackupManifest {
    const artifact = assertBackupArtifactShape(input.artifact)
    const parsed = backupManifestSchema.safeParse(input.manifest)
    if (!parsed.success) {
      throw new BackupArtifactError('manifest_invalid')
    }
    const manifest = parsed.data
    if (
      manifest.project_id !== artifact.project_id ||
      manifest.environment !== artifact.environment ||
      manifest.driver !== artifact.driver
    ) {
      // Manifesto de outro projeto/ambiente/driver: recusa sem revelar dados.
      throw new BackupArtifactError('manifest_scope_mismatch')
    }
    if (manifest.artifact_ref !== artifact.artifact_ref) {
      throw new BackupArtifactError('manifest_artifact_mismatch')
    }
    if (manifest.checksum !== artifact.checksum) {
      throw new BackupArtifactError('manifest_checksum_mismatch')
    }
    const actual = checksumOf(input.bytes)
    if (actual !== manifest.checksum) {
      throw new BackupArtifactError('checksum_mismatch')
    }
    if (input.bytes.byteLength > BACKUP_MAX_ARTIFACT_BYTES) {
      throw new BackupArtifactError('artifact_too_large')
    }
    return manifest
  }

  return {
    version: BACKUP_SERVICE_VERSION,

    async run(request: BackupRequest): Promise<BackupRunResult> {
      // 1. flags: com worker desligado nenhum backup/R2 é tocado.
      requireWorkerActive(deps.flags)

      // 2. escopo coerente (naming server-side idêntico ao do plano).
      const driver = assertDriver(request.driver)
      const environment = assertEnvironment(request.environment)
      if (
        typeof request.projectId !== 'string' ||
        request.naming.project_id !== request.projectId
      ) {
        throw new BackupInputError('project_id')
      }
      const destination = assertDestination(request.destination ?? 'local')
      const retentionDays = assertRetentionDays(request.retentionDays)

      // 3. destino allowlisted e prefixo dedicado conferido.
      const port = deps.destinations[destination]
      if (port === undefined || port.destination !== destination) {
        throw new BackupDestinationError('destination_port_unavailable')
      }
      const prefix = buildBackupPrefix({
        projectId: request.projectId,
        environment,
        destination,
      })

      // 4. lease vigente: sem writer válido nada é escrito.
      deps.leases.assertWriter({
        scope: { projectId: request.projectId, environment },
        leaseId: request.lease.leaseId,
        fencingToken: request.lease.fencingToken,
        holderRef: request.lease.holderRef,
      })

      // 5. bytes, tamanho e checksum.
      const bytes = await request.dump()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new BackupArtifactError('dump_vazio')
      }
      if (bytes.byteLength > BACKUP_MAX_ARTIFACT_BYTES) {
        throw new BackupArtifactError('artifact_too_large')
      }
      const checksum = checksumOf(bytes)
      const createdAt = now().toISOString()
      const sizeMb = Math.max(1, Math.ceil(bytes.byteLength / (1024 * 1024)))

      // 6. escrita no destino dedicado (o adapter resolve o path físico).
      const written = await port.write({
        prefix,
        filename: backupFileName(),
        bytes,
      })
      if (
        typeof written.artifact_ref !== 'string' ||
        !written.artifact_ref.startsWith(prefix) ||
        !ARTIFACT_REF_PATTERN.test(written.artifact_ref)
      ) {
        throw new BackupArtifactError('artifact_ref_outside_prefix')
      }

      const artifact: BackupArtifact = Object.freeze({
        artifact_ref: written.artifact_ref,
        destination,
        prefix,
        checksum,
        size_mb: sizeMb,
        retention_days: retentionDays,
        created_at: createdAt,
        project_id: request.projectId,
        environment,
        driver,
        manifest_version: BACKUP_MANIFEST_VERSION,
      })
      const manifest: BackupManifest = backupManifestSchema.parse({
        version: BACKUP_MANIFEST_VERSION,
        naming_version: NAMING_VERSION,
        project_id: request.projectId,
        environment,
        driver,
        database: request.naming.database,
        artifact_ref: artifact.artifact_ref,
        checksum,
        size_mb: sizeMb,
        retention_days: retentionDays,
        created_at: createdAt,
      })

      return Object.freeze({
        artifact,
        manifest,
        safe_detail: `backup ${destination} checksum=${checksum.slice(0, 12)} size_mb=${sizeMb} retention_days=${retentionDays}`,
        evidence_ref: artifact.artifact_ref,
      })
    },

    verifyArtifact,
  }
}
