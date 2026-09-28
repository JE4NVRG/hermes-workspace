/**
 * Verificador de restore do Project Center v2 (PR 6).
 *
 * Fonte da verdade: plano §PR 6 (passos 9 e 10) e spec §14.
 *
 * Invariantes:
 * - o restore de prova vai **sempre** para um alvo efémero dedicado
 *   (`je4ndev_pcv2_<hex>`), criado para este passo e destruído no fim; o alvo
 *   nunca pode ser o database de origem nem um database de produção;
 * - a origem é declarada explicitamente e o dump só é restaurado se pertencer a
 *   ela (project UUID, ambiente, driver e database batem);
 * - os bytes são conferidos contra o **checksum** do manifesto antes do restore;
 * - a prova exige que o adapter reporte a origem **intacta**; se a origem for
 *   tocada a verificação falha fechado;
 * - o alvo efémero é destruído mesmo quando a prova falha — alvo não destruído é
 *   falha (nada de database órfão a consumir disco);
 * - com as flags desligadas o verificador não corre nada.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { requireWorkerActive } from './feature-flags'
import { DRIVERS } from './domain'
import type { Driver, Environment } from './domain'
import type { ProjectCenterV2Flags } from './feature-flags'
import type { LeaseStore } from './lease-store'
import type { ActionLeaseProof } from './executors/action-executor'
import type {
  BackupArtifact,
  BackupManifest,
  BackupService,
} from './backup-service'

export const RESTORE_VERIFIER_VERSION = 'pcv2-restore-verifier-v1'
/** Prefixo obrigatório do database efémero de prova. */
export const EPHEMERAL_TARGET_PREFIX = 'je4ndev_pcv2_'
export const EPHEMERAL_TARGET_PATTERN = /^je4ndev_pcv2_[a-z0-9]{8,20}$/
export const RESTORE_TARGET_REF_PATTERN =
  /^restore-test:[a-z0-9_]{16,32}#[a-f0-9]{8,16}$/
/** Teto de bytes restaurados por prova (512 MiB). */
export const RESTORE_MAX_BYTES = 512 * 1024 * 1024
/** Padrões que jamais podem ser alvo de restore. */
export const FORBIDDEN_TARGET_DATABASES: ReadonlyArray<RegExp> = [
  /^postgres$/,
  /^template0$/,
  /^template1$/,
  /^je4ndev_pcv2$/,
]

export class RestoreVerificationError extends Error {
  readonly code: 'VERIFICATION_FAILED' | 'POLICY_DENIED' | 'INVALID_REQUEST'
  readonly reason: string

  constructor(code: RestoreVerificationError['code'], reason: string) {
    super('verificacao de restore recusada')
    this.name = 'RestoreVerificationError'
    this.code = code
    this.reason = reason
  }
}

/** Alvo efémero de prova. `target_ref` é relativo e não revela nada sensível. */
export const ephemeralTargetSchema = z
  .object({
    target_ref: z.string().regex(RESTORE_TARGET_REF_PATTERN),
    target_name: z.string().regex(EPHEMERAL_TARGET_PATTERN),
    marker: z.string().regex(/^[a-f0-9]{8,16}$/),
  })
  .strict()

export type EphemeralRestoreTarget = z.infer<typeof ephemeralTargetSchema>

export interface RestoreRunInput {
  readonly artifact: BackupArtifact
  readonly manifest: BackupManifest
  /** Bytes já conferidos contra o checksum do manifesto. */
  readonly bytes: Uint8Array
  readonly target: EphemeralRestoreTarget
  readonly origin: {
    readonly project_id: string
    readonly environment: Environment
    readonly driver: Driver
    readonly database: string
  }
  readonly timeout_ms: number
}

export interface RestoreRunResult {
  readonly exit_code: number
  /** `true` somente se o adapter comprovar que a origem não foi tocada. */
  readonly origin_untouched: boolean
  /** Contagem observada na tabela canário do alvo (opcional). */
  readonly restored_rows?: number | null
  readonly safe_detail?: string
}

export interface RestoreVerificationInput {
  readonly operationId: string
  readonly artifact: BackupArtifact
  readonly manifest: unknown
  readonly bytes: Uint8Array
  readonly origin: RestoreRunInput['origin']
  readonly lease: ActionLeaseProof
  readonly target?: EphemeralRestoreTarget
  readonly timeout_ms?: number
}

export interface RestoreVerificationResult {
  readonly target: EphemeralRestoreTarget
  readonly verified_bytes: number
  readonly restored_rows: number | null
  readonly verified_at: string
  readonly target_destroyed: boolean
  readonly safe_detail: string
  readonly evidence_ref: string
}

export interface RestoreVerifierDeps {
  readonly flags: ProjectCenterV2Flags
  readonly leases: LeaseStore
  readonly backups: Pick<BackupService, 'verifyArtifact'>
  /** Executa o restore no alvo efémero (adapter `pg_restore` injetado). */
  readonly runRestore: (input: RestoreRunInput) => Promise<RestoreRunResult>
  /** Destrói o alvo efémero. Obrigatório: alvo órfão é falha. */
  readonly dropTarget: (target: EphemeralRestoreTarget) => Promise<void>
  /** Habilita prova com origem de produção (default: recusa). */
  readonly allowProductionOrigin?: boolean
  readonly now?: () => Date
  readonly generateId?: () => string
}

export interface RestoreVerifier {
  readonly version: string
  issueTarget: () => EphemeralRestoreTarget
  verify: (
    input: RestoreVerificationInput,
  ) => Promise<RestoreVerificationResult>
}

export function assertEphemeralRestoreTarget(
  value: unknown,
): EphemeralRestoreTarget {
  const parsed = ephemeralTargetSchema.safeParse(value)
  if (!parsed.success) {
    throw new RestoreVerificationError('POLICY_DENIED', 'target_not_ephemeral')
  }
  const target = parsed.data
  if (
    FORBIDDEN_TARGET_DATABASES.some((pattern) =>
      pattern.test(target.target_name),
    )
  ) {
    throw new RestoreVerificationError('POLICY_DENIED', 'target_forbidden')
  }
  if (!target.target_ref.includes(`:${target.target_name}#`)) {
    throw new RestoreVerificationError('POLICY_DENIED', 'target_ref_mismatch')
  }
  return target
}

export function createRestoreVerifier(
  deps: RestoreVerifierDeps,
): RestoreVerifier {
  const now = deps.now ?? (() => new Date())
  const generateId = deps.generateId ?? (() => randomBytes(16).toString('hex'))

  function issueTarget(): EphemeralRestoreTarget {
    const suffix = generateId()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 16)
    const marker = generateId()
      .replace(/[^a-f0-9]/g, '')
      .slice(0, 12)
    const target_name = `${EPHEMERAL_TARGET_PREFIX}${suffix}`
    return assertEphemeralRestoreTarget({
      target_ref: `restore-test:${target_name}#${marker}`,
      target_name,
      marker,
    })
  }

  return {
    version: RESTORE_VERIFIER_VERSION,
    issueTarget,

    async verify(
      input: RestoreVerificationInput,
    ): Promise<RestoreVerificationResult> {
      // 1. flags: sem worker ativo nenhuma prova de restore corre.
      requireWorkerActive(deps.flags)

      // 2. origem declarada e coerente com o artefato.
      const origin = input.origin
      const untrustedOrigin = origin as unknown as {
        readonly database?: unknown
      }
      if (
        typeof untrustedOrigin.database !== 'string' ||
        origin.database.length === 0 ||
        !(DRIVERS as ReadonlyArray<string>).includes(origin.driver)
      ) {
        throw new RestoreVerificationError('INVALID_REQUEST', 'origin_invalid')
      }
      if (
        deps.allowProductionOrigin !== true &&
        origin.environment === 'production'
      ) {
        // Prova de restore não corre sobre origem de produção por default.
        throw new RestoreVerificationError(
          'POLICY_DENIED',
          'production_origin_not_allowed',
        )
      }

      // 3. alvo efémero e distinto da origem.
      const target = assertEphemeralRestoreTarget(input.target ?? issueTarget())
      if (target.target_name === origin.database) {
        throw new RestoreVerificationError('POLICY_DENIED', 'target_is_origin')
      }

      // 4. lease vigente: a prova escreve no host do banco.
      deps.leases.assertWriter({
        scope: {
          projectId: origin.project_id,
          environment: origin.environment,
        },
        leaseId: input.lease.leaseId,
        fencingToken: input.lease.fencingToken,
        holderRef: input.lease.holderRef,
      })

      // 5. bytes conferidos contra o manifesto (escopo + checksum).
      const manifest = deps.backups.verifyArtifact({
        artifact: input.artifact,
        manifest: input.manifest,
        bytes: input.bytes,
      })
      if (
        manifest.project_id !== origin.project_id ||
        manifest.environment !== origin.environment ||
        manifest.driver !== origin.driver ||
        manifest.database !== origin.database
      ) {
        throw new RestoreVerificationError(
          'POLICY_DENIED',
          'manifest_origin_mismatch',
        )
      }
      if (input.bytes.byteLength > RESTORE_MAX_BYTES) {
        throw new RestoreVerificationError('INVALID_REQUEST', 'bytes_over_cap')
      }

      // 6. restore no alvo efémero; o alvo nunca sobrevive à prova.
      let result: RestoreRunResult
      try {
        result = await deps.runRestore({
          artifact: input.artifact,
          manifest,
          bytes: input.bytes,
          target,
          origin,
          timeout_ms: input.timeout_ms ?? 120_000,
        })
      } catch (error) {
        await dropTargetOrThrow(deps.dropTarget, target)
        throw error
      }

      if (result.origin_untouched !== true) {
        await dropTargetOrThrow(deps.dropTarget, target)
        throw new RestoreVerificationError(
          'VERIFICATION_FAILED',
          'origin_touched',
        )
      }
      if (result.exit_code !== 0) {
        await dropTargetOrThrow(deps.dropTarget, target)
        throw new RestoreVerificationError(
          'VERIFICATION_FAILED',
          'restore_failed',
        )
      }
      // Alvo destruído é parte do contrato: se ficar órfão, a prova falha.
      await dropTargetOrThrow(deps.dropTarget, target)

      return Object.freeze({
        target,
        verified_bytes: input.bytes.byteLength,
        restored_rows: result.restored_rows ?? null,
        verified_at: now().toISOString(),
        target_destroyed: true,
        safe_detail: `restore-test ok target=${target.target_name} bytes=${input.bytes.byteLength} checksum=${manifest.checksum.slice(0, 12)}`,
        evidence_ref: target.target_ref,
      })
    },
  }
}

/** Destrói o alvo efémero; alvo não destruído é falha fechada. */
async function dropTargetOrThrow(
  dropTarget: (target: EphemeralRestoreTarget) => Promise<void>,
  target: EphemeralRestoreTarget,
): Promise<void> {
  try {
    await dropTarget(target)
  } catch {
    throw new RestoreVerificationError(
      'VERIFICATION_FAILED',
      'target_not_dropped',
    )
  }
}
