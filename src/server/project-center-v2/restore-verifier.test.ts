/**
 * Testes do verificador de restore (PR 6).
 *
 * Prova: alvo efémero dedicado, distinto da origem, destruído em todos os
 * caminhos; origem nunca é tocada; bytes conferidos por checksum antes do
 * restore; produção recusada por default.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { buildNamingSnapshot } from './naming'
import {
  LeaseLostError,
  StaleWriterError,
  createInMemoryLeaseStore,
} from './lease-store'
import { BackupArtifactError, createBackupService } from './backup-service'
import {
  EPHEMERAL_TARGET_PREFIX,
  RESTORE_VERIFIER_VERSION,
  RestoreVerificationError,
  assertEphemeralRestoreTarget,
  createRestoreVerifier,
} from './restore-verifier'
import type { BackupRunResult } from './backup-service'
import type {
  EphemeralRestoreTarget,
  RestoreRunInput,
  RestoreRunResult,
} from './restore-verifier'

const PROJECT_ID = 'acme-site'
const PEER_PROJECT = 'canary-peer'
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

interface Harness {
  readonly verify: (
    overrides?: Record<string, unknown>,
  ) => Promise<
    Awaited<ReturnType<ReturnType<typeof createRestoreVerifier>['verify']>>
  >
  readonly runRestore: ReturnType<typeof vi.fn>
  readonly dropTarget: ReturnType<typeof vi.fn>
  readonly backup: BackupRunResult
  readonly lease: { leaseId: string; fencingToken: number; holderRef: string }
  readonly leases: ReturnType<typeof createInMemoryLeaseStore>
  readonly bytes: Uint8Array
  readonly origin: {
    project_id: string
    environment: 'development'
    driver: 'postgresql_isolated'
    database: string
  }
  readonly setRunResult: (value: RestoreRunResult) => void
  readonly restoreInputs: ReadonlyArray<RestoreRunInput>
}

async function createHarness(
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly allowProductionOrigin?: boolean
    readonly dropFails?: boolean
  } = {},
): Promise<Harness> {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '99999999-9999-4999-8999-999999999999',
  })
  const grant = leases.acquire({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    holderRef: HOLDER,
  })
  const backupService = createBackupService({
    flags: FLAGS_ON,
    leases,
    destinations: {
      local: {
        adapter_id: 'fake-local',
        destination: 'local',
        write: async ({ prefix, filename }) => ({
          artifact_ref: `${prefix}${filename}`,
        }),
        read: async () => bytes,
        list: async () => [],
      },
    },
    now: () => new Date('2026-09-25T12:05:00.000Z'),
  })
  const backup = await backupService.run({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    driver: 'postgresql_isolated',
    naming: NAMING,
    lease: {
      leaseId: grant.lease_id,
      fencingToken: grant.fencing_token,
      holderRef: HOLDER,
    },
    dump: async () => bytes,
  })

  const restoreInputs: Array<RestoreRunInput> = []
  let runResult: RestoreRunResult = {
    exit_code: 0,
    origin_untouched: true,
    restored_rows: 42,
  }
  const runRestore = vi.fn(async (input: RestoreRunInput) => {
    restoreInputs.push(input)
    return runResult
  })
  const dropTarget = vi.fn(async (_target: EphemeralRestoreTarget) => {
    if (options.dropFails === true) {
      throw new Error('drop falhou')
    }
  })

  let counter = 0
  const verifier = createRestoreVerifier({
    flags: options.flags ?? FLAGS_ON,
    leases,
    backups: backupService,
    runRestore,
    dropTarget,
    allowProductionOrigin: options.allowProductionOrigin,
    now: () => new Date('2026-09-25T12:10:00.000Z'),
    generateId: () => {
      counter += 1
      return `${counter}`.padStart(16, 'c') + 'abcdefabcdef'
    },
  })

  const origin = {
    project_id: PROJECT_ID,
    environment: 'development' as const,
    driver: 'postgresql_isolated' as const,
    database: NAMING.database,
  }

  return {
    runRestore,
    dropTarget,
    backup,
    leases,
    bytes,
    origin,
    restoreInputs,
    lease: {
      leaseId: grant.lease_id,
      fencingToken: grant.fencing_token,
      holderRef: HOLDER,
    },
    setRunResult: (value) => {
      runResult = value
    },
    verify: (overrides = {}) =>
      verifier.verify({
        operationId: OPERATION_ID,
        artifact: backup.artifact,
        manifest: backup.manifest,
        bytes,
        origin,
        lease: {
          leaseId: grant.lease_id,
          fencingToken: grant.fencing_token,
          holderRef: HOLDER,
        },
        ...overrides,
      } as Parameters<typeof verifier.verify>[0]),
  }
}

describe('restore verifier — alvo efémero', () => {
  it('restaura num alvo efémero distinto da origem e o destrói', async () => {
    const harness = await createHarness()
    const result = await harness.verify()

    expect(RESTORE_VERIFIER_VERSION).toBe('pcv2-restore-verifier-v1')
    expect(result.target.target_name.startsWith(EPHEMERAL_TARGET_PREFIX)).toBe(
      true,
    )
    expect(result.target.target_name).not.toBe(harness.origin.database)
    expect(result.evidence_ref).toBe(result.target.target_ref)
    expect(result.target_destroyed).toBe(true)
    expect(result.restored_rows).toBe(42)
    expect(harness.restoreInputs).toHaveLength(1)
    expect(harness.restoreInputs[0]?.target.target_name).toBe(
      result.target.target_name,
    )
    expect(harness.restoreInputs[0]?.origin.database).toBe(
      harness.origin.database,
    )
    expect(harness.dropTarget).toHaveBeenCalledTimes(1)
    expect(harness.dropTarget.mock.calls[0]?.[0]).toEqual(result.target)
    expect(JSON.stringify(result)).not.toContain(harness.origin.database)
  })

  it('cada prova usa um alvo novo (A para B por prova)', async () => {
    const harness = await createHarness()
    const first = await harness.verify()
    const second = await harness.verify()
    expect(first.target.target_name).not.toBe(second.target.target_name)
    expect(harness.dropTarget).toHaveBeenCalledTimes(2)
  })

  it('com flags desligadas nada corre', async () => {
    const harness = await createHarness({ flags: FLAGS_OFF })
    await expect(harness.verify()).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(harness.runRestore).not.toHaveBeenCalled()
    expect(harness.dropTarget).not.toHaveBeenCalled()
  })

  it('sem lease vigente a prova é recusada', async () => {
    const harness = await createHarness()
    await expect(
      harness.verify({ lease: { ...harness.lease, fencingToken: 7 } }),
    ).rejects.toBeInstanceOf(StaleWriterError)
    harness.leases.release(harness.lease)
    await expect(harness.verify()).rejects.toBeInstanceOf(LeaseLostError)
    expect(harness.runRestore).not.toHaveBeenCalled()
  })
})

describe('restore verifier — falhas fechadas', () => {
  it('origem tocada durante o restore falha e ainda assim destrói o alvo', async () => {
    const harness = await createHarness()
    harness.setRunResult({ exit_code: 0, origin_untouched: false })
    await expect(harness.verify()).rejects.toMatchObject({
      reason: 'origin_touched',
    })
    expect(harness.dropTarget).toHaveBeenCalledTimes(1)
  })

  it('exit code diferente de zero falha como restore_failed', async () => {
    const harness = await createHarness()
    harness.setRunResult({ exit_code: 3, origin_untouched: true })
    await expect(harness.verify()).rejects.toBeInstanceOf(
      RestoreVerificationError,
    )
    await expect(harness.verify()).rejects.toMatchObject({
      reason: 'restore_failed',
    })
    expect(harness.dropTarget).toHaveBeenCalledTimes(2)
  })

  it('alvo efémero não destruído é falha', async () => {
    const harness = await createHarness({ dropFails: true })
    await expect(harness.verify()).rejects.toMatchObject({
      reason: 'target_not_dropped',
    })
  })

  it('exceção do adapter de restore propaga e destrói o alvo', async () => {
    const harness = await createHarness()
    harness.runRestore.mockRejectedValueOnce(new Error('pg_restore falhou'))
    await expect(harness.verify()).rejects.toThrow('pg_restore falhou')
    expect(harness.dropTarget).toHaveBeenCalledTimes(1)
  })

  it('bytes adulterados não chegam ao restore', async () => {
    const harness = await createHarness()
    await expect(
      harness.verify({ bytes: new Uint8Array([9, 9, 9]) }),
    ).rejects.toBeInstanceOf(BackupArtifactError)
    expect(harness.runRestore).not.toHaveBeenCalled()
    expect(harness.dropTarget).not.toHaveBeenCalled()
  })

  it('manifesto de outro projeto é recusado antes do restore', async () => {
    const harness = await createHarness()
    const foreign = createBackupService({
      flags: FLAGS_ON,
      leases: harness.leases,
      destinations: {
        local: {
          adapter_id: 'fake-local',
          destination: 'local',
          write: async ({ prefix, filename }) => ({
            artifact_ref: `${prefix}${filename}`,
          }),
          read: async () => harness.bytes,
          list: async () => [],
        },
      },
      now: () => new Date('2026-09-25T12:05:00.000Z'),
    })
    const peerNaming = buildNamingSnapshot({
      client_id: 'canary',
      project_slug: 'peer',
      environment: 'development',
      driver: 'postgresql_isolated',
    })
    const peerGrant = harness.leases.acquire({
      operationId: OPERATION_ID,
      projectId: PEER_PROJECT,
      environment: 'development',
      holderRef: HOLDER,
    })
    const evidence = await foreign.run({
      operationId: OPERATION_ID,
      projectId: PEER_PROJECT,
      environment: 'development',
      driver: 'postgresql_isolated',
      naming: peerNaming,
      lease: {
        leaseId: peerGrant.lease_id,
        fencingToken: peerGrant.fencing_token,
        holderRef: HOLDER,
      },
      dump: async () => harness.bytes,
    })
    // Artefato de um projeto com manifesto de outro: recusa na verificação.
    await expect(
      harness.verify({
        artifact: harness.backup.artifact,
        manifest: evidence.manifest,
      }),
    ).rejects.toBeInstanceOf(BackupArtifactError)
    // Artefato e manifesto coerentes entre si, mas de outro projeto: recusa
    // porque a origem declarada não é a do artefato.
    await expect(
      harness.verify({
        artifact: evidence.artifact,
        manifest: evidence.manifest,
      }),
    ).rejects.toMatchObject({ reason: 'manifest_origin_mismatch' })
    expect(harness.runRestore).not.toHaveBeenCalled()
  })

  it('origem de produção é recusada por default', async () => {
    const harness = await createHarness()
    await expect(
      harness.verify({
        origin: { ...harness.origin, environment: 'production' },
      }),
    ).rejects.toMatchObject({ reason: 'production_origin_not_allowed' })
    expect(harness.runRestore).not.toHaveBeenCalled()

    // Com a porta explícita aberta, a recusa passa a ser a do próximo gate
    // (o lease vigente é do escopo `development`, não de produção).
    const allowed = await createHarness({ allowProductionOrigin: true })
    await expect(
      allowed.verify({
        origin: { ...allowed.origin, environment: 'production' },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError)
    expect(allowed.runRestore).not.toHaveBeenCalled()
  })
})

describe('restore verifier — allowlist de alvo', () => {
  it('recusa alvo que não é efémero dedicado', () => {
    const hostile: ReadonlyArray<unknown> = [
      {
        target_ref: 'restore-test:postgres#abcdef01',
        target_name: 'postgres',
        marker: 'abcdef01',
      },
      {
        target_ref: 'restore-test:meu_banco#abcdef01',
        target_name: 'meu_banco',
        marker: 'abcdef01',
      },
      {
        target_ref: 'restore-test:je4ndev_pcv2_aaaaaaaa#abcdef01',
        target_name: 'je4ndev_pcv2_bbbbbbbb',
        marker: 'abcdef01',
      },
      {
        target_ref: `${EPHEMERAL_TARGET_PREFIX}/${'a'.repeat(16)}#abcdef01`,
        target_name: `${EPHEMERAL_TARGET_PREFIX}${'a'.repeat(16)}`,
        marker: 'abcdef01',
      },
      {
        target_name: 'je4ndev_pcv2_aaaaaaaa',
        target_ref: 'restore-test:je4ndev_pcv2_aaaaaaaa#abcdef01',
      },
      {
        target_ref: 'restore-test:je4ndev_pcv2_aaaaaaaa#abcdef01',
        target_name: 'je4ndev_pcv2_aaaaaaaa',
        marker: 'abcdef01',
        extra: 1,
      },
    ]
    for (const value of hostile) {
      expect(() => assertEphemeralRestoreTarget(value)).toThrow(
        RestoreVerificationError,
      )
    }
  })

  it('recusa alvo igual ao database de origem', async () => {
    const harness = await createHarness()
    await expect(
      harness.verify({
        target: {
          target_ref: `restore-test:${harness.origin.database}#abcdef01`,
          target_name: harness.origin.database.replace(/[^a-z0-9_]/g, '_'),
          marker: 'abcdef01',
        },
      }),
    ).rejects.toBeInstanceOf(RestoreVerificationError)
    // O nome da origem não é efémero; a recusa vem da allowlist, não do banco.
    expect(harness.runRestore).not.toHaveBeenCalled()
  })
})
