/**
 * Testes do serviço de backup (PR 6).
 *
 * Prova: prefixo dedicado por projeto/ambiente, checksum, retenção dentro da
 * quota, artefato sanitizado, escrita somente com lease vigente e destino
 * allowlisted — nenhuma escrita sem flags ligadas.
 */
import { describe, expect, it } from 'vitest'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import {
  buildNamingSnapshot,
  localBackupPrefixFor,
  r2PrefixFor,
} from './naming'
import {
  LeaseLostError,
  StaleWriterError,
  createInMemoryLeaseStore,
} from './lease-store'
import {
  BACKUP_DEFAULT_RETENTION_DAYS,
  BACKUP_MAX_ARTIFACT_BYTES,
  BACKUP_MAX_RETENTION_DAYS,
  BACKUP_MIN_RETENTION_DAYS,
  BACKUP_SERVICE_VERSION,
  BackupArtifactError,
  BackupDestinationError,
  BackupInputError,
  assertBackupArtifactShape,
  buildBackupPrefix,
  checksumOf,
  createBackupService,
} from './backup-service'
import type {
  BackupArtifact,
  BackupDestinationPort,
  BackupRunResult,
} from './backup-service'
import type { BackupDestination } from './naming'

const PROJECT_ID = 'acme-site'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const HOLDER = 'pcv2-worker'
const NAMING = buildNamingSnapshot({
  client_id: 'acme',
  project_slug: 'site',
  environment: 'development',
  driver: 'postgresql_isolated',
})
const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

interface FakePort extends BackupDestinationPort {
  readonly writes: ReadonlyArray<string>
  readonly setArtifactRef: (value: string) => void
}

function createFakePort(
  destination: BackupDestination,
  artifactRefOverride?: string,
): FakePort {
  const writes: Array<string> = []
  let artifactRef: string | null = artifactRefOverride ?? null
  return {
    adapter_id: `fake-${destination}-store`,
    destination,
    writes,
    setArtifactRef: (value: string) => {
      artifactRef = value
    },
    write: async ({ prefix, filename }) => {
      writes.push(`${prefix}${filename}`)
      return {
        artifact_ref: artifactRef ?? `${prefix}${filename}`,
      }
    },
    read: async () => new Uint8Array([1, 2, 3]),
    list: async () => [],
  }
}

interface Harness {
  readonly run: (
    overrides?: Partial<
      Parameters<ReturnType<typeof createBackupService>['run']>[0]
    >,
  ) => Promise<BackupRunResult>
  readonly local: FakePort
  readonly r2: FakePort
  readonly bytes: Uint8Array
  readonly leases: ReturnType<typeof createInMemoryLeaseStore>
  readonly lease: { leaseId: string; fencingToken: number; holderRef: string }
}

function createHarness(
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly artifactRefOverride?: string
    readonly dumpBytes?: Uint8Array
  } = {},
): Harness {
  const bytes =
    options.dumpBytes ?? new Uint8Array([0x50, 0x47, 0x44, 0x4d, 0x50])
  const local = createFakePort('local', options.artifactRefOverride)
  const r2 = createFakePort('r2', options.artifactRefOverride)
  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '88888888-8888-4888-8888-888888888888',
  })
  const grant = leases.acquire({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    holderRef: HOLDER,
  })
  const service = createBackupService({
    flags: options.flags ?? FLAGS_ON,
    leases,
    destinations: { local, r2 },
    now: () => new Date('2026-09-25T12:05:00.000Z'),
  })
  const lease = {
    leaseId: grant.lease_id,
    fencingToken: grant.fencing_token,
    holderRef: HOLDER,
  }
  return {
    local,
    r2,
    bytes,
    leases,
    lease,
    run: (overrides = {}) =>
      service.run({
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        environment: 'development',
        driver: 'postgresql_isolated',
        naming: NAMING,
        lease,
        dump: async () => bytes,
        ...overrides,
      }),
  }
}

describe('backup service — escrita allowlisted', () => {
  it('com flags desligadas nenhum destino é escrito', async () => {
    const harness = createHarness({ flags: FLAGS_OFF })
    await expect(harness.run()).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(harness.local.writes).toHaveLength(0)
    expect(harness.r2.writes).toHaveLength(0)
  })

  it('grava no prefixo dedicado com checksum, retenção e manifesto sanitizado', async () => {
    const harness = createHarness()
    const result = await harness.run()

    const expectedPrefix = localBackupPrefixFor({
      project_id: PROJECT_ID,
      environment: 'development',
    })
    expect(result.artifact.prefix).toBe(expectedPrefix)
    expect(result.artifact.artifact_ref).toBe(`${expectedPrefix}postgres.dump`)
    expect(result.artifact.checksum).toBe(checksumOf(harness.bytes))
    expect(result.artifact.retention_days).toBe(BACKUP_DEFAULT_RETENTION_DAYS)
    expect(result.evidence_ref).toBe(result.artifact.artifact_ref)
    expect(result.manifest.project_id).toBe(PROJECT_ID)
    expect(result.manifest.database).toBe(NAMING.database)
    expect(result.manifest.version).toBe('pcv2-backup-manifest-v1')
    expect(harness.local.writes).toEqual([`${expectedPrefix}postgres.dump`])
    expect(harness.r2.writes).toHaveLength(0)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/\/home\/|\/etc\/|:\/\/|password|senha/i)
    expect(BACKUP_SERVICE_VERSION).toBe('pcv2-backup-v1')
  })

  it('destino r2 usa o prefixo dedicado do R2', async () => {
    const harness = createHarness()
    const result = await harness.run({ destination: 'r2' })

    const expectedPrefix = r2PrefixFor({
      project_id: PROJECT_ID,
      environment: 'development',
    })
    expect(expectedPrefix.startsWith('projects/')).toBe(true)
    expect(result.artifact.prefix).toBe(expectedPrefix)
    expect(harness.r2.writes).toHaveLength(1)
    expect(harness.local.writes).toHaveLength(0)
  })

  it('recusa destino fora da allowlist e porta ausente', async () => {
    const harness = createHarness()
    await expect(
      harness.run({ destination: 'bucket-livre' as BackupDestination }),
    ).rejects.toBeInstanceOf(BackupDestinationError)

    const service = createBackupService({
      flags: FLAGS_ON,
      leases: harness.leases,
      destinations: { local: harness.local },
      now: () => new Date('2026-09-25T12:05:00.000Z'),
    })
    await expect(
      service.run({
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        environment: 'development',
        driver: 'postgresql_isolated',
        naming: NAMING,
        lease: harness.lease,
        destination: 'r2',
        dump: async () => harness.bytes,
      }),
    ).rejects.toBeInstanceOf(BackupDestinationError)
    expect(harness.r2.writes).toHaveLength(0)
  })

  it('recusa artefato escrito fora do prefixo dedicado', async () => {
    const harness = createHarness({ artifactRefOverride: 'outro/projeto/dump' })
    await expect(harness.run()).rejects.toBeInstanceOf(BackupArtifactError)

    const absolute = createHarness({
      artifactRefOverride: '/var/lib/backups/postgres.dump',
    })
    await expect(absolute.run()).rejects.toBeInstanceOf(BackupArtifactError)
  })

  it('exige lease vigente: stale e liberado recusam a escrita', async () => {
    const harness = createHarness()
    await expect(
      harness.run({ lease: { ...harness.lease, fencingToken: 42 } }),
    ).rejects.toBeInstanceOf(StaleWriterError)

    harness.leases.release(harness.lease)
    await expect(harness.run()).rejects.toBeInstanceOf(LeaseLostError)
    expect(harness.local.writes).toHaveLength(0)
  })

  it('valida retenção dentro da quota sem clamp silencioso', async () => {
    const harness = createHarness()
    await expect(
      harness.run({ retentionDays: BACKUP_MIN_RETENTION_DAYS - 1 }),
    ).rejects.toBeInstanceOf(BackupInputError)
    await expect(
      harness.run({ retentionDays: BACKUP_MAX_RETENTION_DAYS + 1 }),
    ).rejects.toBeInstanceOf(BackupInputError)

    const min = await harness.run({ retentionDays: BACKUP_MIN_RETENTION_DAYS })
    expect(min.artifact.retention_days).toBe(BACKUP_MIN_RETENTION_DAYS)
    const max = await harness.run({ retentionDays: BACKUP_MAX_RETENTION_DAYS })
    expect(max.artifact.retention_days).toBe(BACKUP_MAX_RETENTION_DAYS)
    expect(harness.local.writes).toHaveLength(2)
  })

  it('recusa escopo divergente e dump vazio ou acima do teto', async () => {
    const harness = createHarness()
    await expect(
      harness.run({ projectId: 'outro-projeto' }),
    ).rejects.toBeInstanceOf(BackupInputError)
    await expect(
      harness.run({ dump: async () => new Uint8Array(0) }),
    ).rejects.toBeInstanceOf(BackupArtifactError)

    const oversized = new Uint8Array(8)
    Object.defineProperty(oversized, 'byteLength', {
      value: BACKUP_MAX_ARTIFACT_BYTES + 1,
    })
    await expect(
      harness.run({ dump: async () => oversized }),
    ).rejects.toBeInstanceOf(BackupArtifactError)
    expect(harness.local.writes).toHaveLength(0)
  })

  it('prefixo é sempre derivado server-side', () => {
    expect(
      buildBackupPrefix({
        projectId: PROJECT_ID,
        environment: 'production',
        destination: 'r2',
      }),
    ).toBe(r2PrefixFor({ project_id: PROJECT_ID, environment: 'production' }))
    expect(() =>
      buildBackupPrefix({
        projectId: '/etc/passwd',
        environment: 'development',
        destination: 'local',
      }),
    ).toThrow()
  })
})

describe('backup service — verificação de artefato', () => {
  it('confere checksum, escopo e forma do artefato', async () => {
    const harness = createHarness()
    const service = createBackupService({
      flags: FLAGS_ON,
      leases: harness.leases,
      destinations: { local: harness.local },
    })
    const result = await harness.run()

    expect(
      service.verifyArtifact({
        artifact: result.artifact,
        manifest: result.manifest,
        bytes: harness.bytes,
      }).checksum,
    ).toBe(result.artifact.checksum)

    expect(() =>
      service.verifyArtifact({
        artifact: result.artifact,
        manifest: result.manifest,
        bytes: new Uint8Array([9, 9, 9]),
      }),
    ).toThrow(BackupArtifactError)

    expect(() =>
      service.verifyArtifact({
        artifact: result.artifact,
        manifest: { ...result.manifest, project_id: 'canary-peer-blog' },
        bytes: harness.bytes,
      }),
    ).toThrow(BackupArtifactError)

    expect(() =>
      service.verifyArtifact({
        artifact: result.artifact,
        manifest: { ...result.manifest, campo_extra: 'x' },
        bytes: harness.bytes,
      }),
    ).toThrow(BackupArtifactError)

    expect(() =>
      service.verifyArtifact({
        artifact: result.artifact,
        manifest: { ...result.manifest, artifact_ref: 'outro/arquivo.dump' },
        bytes: harness.bytes,
      }),
    ).toThrow(BackupArtifactError)
  })

  it('recusa artefato com path absoluto, URI ou retenção fora da quota', async () => {
    const harness = createHarness()
    const result = await harness.run()
    const hostile: ReadonlyArray<Partial<BackupArtifact>> = [
      { artifact_ref: '/var/lib/dump' },
      { artifact_ref: 'https://bucket/dump' },
      { artifact_ref: '../dump' },
      { checksum: 'nao-hex' },
      { retention_days: 365 },
      { manifest_version: 'pcv2-backup-manifest-v0' },
    ]
    for (const override of hostile) {
      expect(() =>
        assertBackupArtifactShape({ ...result.artifact, ...override }),
      ).toThrow(BackupArtifactError)
    }
  })
})
