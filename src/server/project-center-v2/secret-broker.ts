/**
 * Secret broker do Project Center v2 (PR 6).
 *
 * Fonte da verdade: `specs/features/project-center-v2.spec.md` §8.2 (item 5),
 * §I-08 e os testes negativos API-16 a API-19 do threat model.
 *
 * Invariantes implementadas aqui:
 * - `SecretRef` opaca no formato canônico `^sref_[A-Za-z0-9_-]{43,128}$`,
 *   gerada com **≥ 32 bytes de CSPRNG** (`crypto.randomBytes`) em base64url —
 *   nenhum alias determinístico, nenhum placeholder derivável;
 * - o **binding privado é atômico e por digest**: o material nunca é gravado
 *   junto do registro público (que só carrega a referência opaca, a máscara e
 *   um fingerprint não reversível); o índice privado é endereçado por HMAC da
 *   referência com um pepper privado;
 * - **replay idempotente**: repetir a emissão com a mesma `Idempotency-Key`
 *   devolve a referência já persistida, sem gerar material novo; duas emissões
 *   independentes produzem tokens aleatórios **distintos** (API-17);
 * - **rotação**: a referência anterior deixa de ser resolvível e passa a
 *   `rotated`, sem apagar histórico do registro público;
 * - **redaction**: nenhuma saída deste módulo contém material; o handle é
 *   serializado na forma mascarada (`toJSON`) e a redaction do PR 1 produz
 *   `[REDACTED]` para o campo funcional `reveal`.
 *
 * O broker é uma interface: o deployment injeta o cofre real (Secret Manager,
 * sops, arquivo fora do repo). O fixture usa valor **sintético gerado em
 * runtime** — nunca material real, nunca DSN, nunca JWT.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { ENVIRONMENTS, SECRET_REF_PATTERN } from './domain'
import { SECRET_REF_MASK, fingerprintSecretRef } from './redaction'
import type { Environment } from './domain'

export const SECRET_BROKER_VERSION = 'pcv2-secret-broker-v1'
/** Prefixo canônico da referência opaca. */
export const SECRET_REF_PREFIX = 'sref_'
/** Entropia mínima: 32 bytes (256 bits) por emissão. */
export const SECRET_REF_ENTROPY_BYTES = 32
/** Corpo base64url de 32 bytes sem padding: 44 caracteres (≥ 43 do contrato). */
export const SECRET_REF_BODY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
export const SECRET_REF_MIN_BODY_LENGTH = 43
/** Bits efetivos por caractere base64url. */
export const SECRET_REF_BITS_PER_CHARACTER = 6
/** Tamanho mínimo do pepper privado que endereça o índice de bindings. */
export const SECRET_PEPPER_MIN_BYTES = 32
/** Prefixo do valor sintético de fixture (nunca é credencial real). */
export const SYNTHETIC_MATERIAL_PREFIX = 'synthetic-material-'

export const SECRET_PURPOSES = [
  'app_role_password',
  'jwt_secret',
  'anon_key',
  'service_role_key',
  'admin_bootstrap',
] as const
export type SecretPurpose = (typeof SECRET_PURPOSES)[number]

/** Estado do binding no registro público. */
export const SECRET_BINDING_STATES = [
  'active',
  'rotated',
  'superseded',
] as const
export type SecretBindingState = (typeof SECRET_BINDING_STATES)[number]

/** Referência fora da forma contratual (`INVALID_REQUEST`). */
export class SecretReferenceError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly field: string

  constructor(field: string) {
    super(`referencia de secret invalida: ${field}`)
    this.name = 'SecretReferenceError'
    this.field = field
  }
}

/**
 * Recusa **uniforme** para referência desconhecida, de outro projeto, já
 * rotacionada ou com propósito divergente: o cliente não consegue distinguir
 * os casos nem descobrir metadado de outro projeto (API-18).
 */
export class SecretUnavailableError extends Error {
  readonly code = 'FORBIDDEN'
  readonly status = 403

  constructor() {
    super('secret indisponivel')
    this.name = 'SecretUnavailableError'
  }
}

/** Uso incorreto do vault privado (bug interno, falha fechada). */
export class SecretMaterialError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly reason: string

  constructor(reason: string, options: { readonly cause?: unknown } = {}) {
    super('material de secret inconsistente', { cause: options.cause })
    this.name = 'SecretMaterialError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Referência opaca e digest
// ---------------------------------------------------------------------------

export function isSecretRefToken(value: unknown): value is string {
  return typeof value === 'string' && SECRET_REF_PATTERN.test(value)
}

/** Verdadeiro quando a referência também tem a entropia mínima esperada. */
export function hasMinimumEntropy(secretRef: string): boolean {
  if (!isSecretRefToken(secretRef)) return false
  const body = secretRef.slice(SECRET_REF_PREFIX.length)
  return (
    SECRET_REF_BODY_PATTERN.test(body) &&
    body.length * SECRET_REF_BITS_PER_CHARACTER >= SECRET_REF_ENTROPY_BYTES * 8
  )
}

/** Valida a forma/entropia contratual; falha fechado se divergir. */
export function assertSecretRefShape(secretRef: unknown): string {
  if (!hasMinimumEntropy(secretRef as string)) {
    throw new SecretReferenceError(
      typeof secretRef === 'string' ? 'shape_or_entropy' : 'missing',
    )
  }
  return secretRef as string
}

/** Monta a referência a partir de um corpo base64url já validado. */
export function generateSecretRef(
  options: {
    readonly bytes?: number
    readonly random?: (size: number) => Buffer
  } = {},
): string {
  const bytes = options.bytes ?? SECRET_REF_ENTROPY_BYTES
  if (!Number.isInteger(bytes) || bytes < SECRET_REF_ENTROPY_BYTES) {
    throw new SecretReferenceError('bytes')
  }
  const random = options.random ?? ((size: number) => randomBytes(size))
  const body = random(bytes).toString('base64url')
  if (
    !SECRET_REF_BODY_PATTERN.test(body) ||
    !hasMinimumEntropy(`${SECRET_REF_PREFIX}${body}`)
  ) {
    // CSPRNG que devolveu algo fora da forma esperada: falha fechado em vez de
    // aceitar uma referência degenerada (ex.: stub de teste mal configurado).
    throw new SecretReferenceError('generated_body')
  }
  return `${SECRET_REF_PREFIX}${body}`
}

/**
 * Digest privado da referência: HMAC-SHA256 com pepper privado. É a única
 * chave do índice de bindings — sem o pepper, o registro público não pode ser
 * correlacionado ao material (§I-08).
 */
export function secretRefDigest(secretRef: string, pepper: string): string {
  assertSecretRefShape(secretRef)
  if (
    typeof pepper !== 'string' ||
    Buffer.byteLength(pepper, 'utf8') < SECRET_PEPPER_MIN_BYTES
  ) {
    throw new SecretReferenceError('pepper')
  }
  return createHmac('sha256', pepper).update(secretRef).digest('hex')
}

/** Mascara neutra da referência (mesma forma do PR 1). */
export function maskSecretRefValue(secretRef: string): string {
  assertSecretRefShape(secretRef)
  return SECRET_REF_MASK
}

/** Fingerprint não reversível e estável para correlacionar sem expor. */
export function secretRefFingerprint(secretRef: string): string {
  return fingerprintSecretRef(assertSecretRefShape(secretRef))
}

/** Material sintético de fixture, gerado em runtime (nunca credencial real). */
export function createSyntheticMaterial(
  random: (size: number) => Buffer = (size: number) => randomBytes(size),
): string {
  return `${SYNTHETIC_MATERIAL_PREFIX}${random(24).toString('base64url')}`
}

/** Digest público do material (só para o teste provar que não há eco). */
export function materialDigest(material: string): string {
  return createHash('sha256').update(material).digest('hex')
}

// ---------------------------------------------------------------------------
// Vault privado do material (interface + fixture in-memory)
// ---------------------------------------------------------------------------

export interface SecretMaterialStore {
  /** Escrita atômica de uma chave: primeira gravação vence. */
  put: (digest: string, material: string) => void
  has: (digest: string) => boolean
  read: (digest: string) => string | null
  remove: (digest: string) => void
  size: () => number
}

export function createInMemorySecretMaterialStore(): SecretMaterialStore {
  const entries = new Map<string, string>()
  return {
    put(digest: string, material: string): void {
      if (typeof digest !== 'string' || digest.length !== 64) {
        throw new SecretMaterialError('digest')
      }
      if (typeof material !== 'string' || material.length === 0) {
        throw new SecretMaterialError('material')
      }
      const existing = entries.get(digest)
      if (existing !== undefined && existing !== material) {
        // Colisão de digest com material divergente: nunca sobrescrever.
        throw new SecretMaterialError('digest_collision')
      }
      entries.set(digest, material)
    },
    has: (digest: string) => entries.has(digest),
    read: (digest: string) => entries.get(digest) ?? null,
    remove: (digest: string) => {
      entries.delete(digest)
    },
    size: () => entries.size,
  }
}

/**
 * Handle de material: o transporte do segredo para o adapter externo. É seguro
 * para log — `toJSON` devolve apenas a máscara, o fingerprint e o propósito, e
 * a redaction trata o campo funcional `reveal` como não serializável.
 */
export interface SecretMaterialHandle {
  readonly secret_ref: string
  readonly masked_ref: string
  readonly fingerprint: string
  readonly purpose: SecretPurpose
  readonly project_id: string
  readonly environment: Environment
  reveal: () => string
  toJSON: () => {
    readonly masked_ref: string
    readonly fingerprint: string
    readonly purpose: SecretPurpose
  }
}

export interface SecretBindingRecord {
  readonly binding_id: string
  readonly secret_ref: string
  readonly masked_ref: string
  readonly fingerprint: string
  readonly purpose: SecretPurpose
  readonly project_id: string
  readonly environment: Environment
  readonly state: SecretBindingState
  readonly created_at: string
  readonly idempotency_key_hash: string | null
  readonly rotated_from: string | null
  readonly replaced_by: string | null
}

export interface IssuedSecret {
  readonly secret_ref: string
  readonly masked_ref: string
  readonly fingerprint: string
  readonly purpose: SecretPurpose
  readonly binding_id: string
  readonly created_at: string
  /** `true` quando a emissão foi replay da referência já persistida. */
  readonly replayed: boolean
  readonly rotated_from: string | null
}

export interface IssueSecretInput {
  readonly projectId: string
  readonly environment: Environment
  readonly purpose: SecretPurpose
  /** Chave client/worker-owned; habilita replay idempotente da emissão. */
  readonly idempotencyKey?: string
}

export interface RotateSecretInput {
  readonly projectId: string
  readonly environment: Environment
  readonly purpose: SecretPurpose
  readonly previousSecretRef: string
}

export interface ResolveSecretInput {
  readonly secretRef: string
  readonly projectId: string
  readonly environment: Environment
  readonly purpose: SecretPurpose
}

export interface SecretBroker {
  readonly version: string
  issue: (input: IssueSecretInput) => IssuedSecret
  rotate: (input: RotateSecretInput) => IssuedSecret
  handle: (input: ResolveSecretInput) => SecretMaterialHandle
  /** Metadados públicos (sem material, sem digest privado). */
  bindings: () => ReadonlyArray<SecretBindingRecord>
  activeSecretRefs: (input: {
    readonly projectId: string
    readonly environment: Environment
    readonly purpose: SecretPurpose
  }) => ReadonlyArray<string>
}

export interface SecretBrokerOptions {
  readonly materials: SecretMaterialStore
  /** Pepper privado (≥ 32 bytes) que endereça o índice de bindings. */
  readonly pepper?: string
  readonly now?: () => Date
  readonly generateId?: () => string
  readonly generateMaterial?: () => string
  readonly generateBytes?: (size: number) => Buffer
}

function assertPurpose(value: unknown): SecretPurpose {
  if (
    typeof value !== 'string' ||
    !(SECRET_PURPOSES as ReadonlyArray<string>).includes(value)
  ) {
    throw new SecretReferenceError('purpose')
  }
  return value as SecretPurpose
}

function assertEnvironment(value: unknown): Environment {
  if (
    typeof value !== 'string' ||
    !(ENVIRONMENTS as ReadonlyArray<string>).includes(value)
  ) {
    throw new SecretReferenceError('environment')
  }
  return value as Environment
}

function assertProjectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}$/.test(value)
  ) {
    throw new SecretReferenceError('project_id')
  }
  return value
}

function freezeRecord(record: SecretBindingRecord): SecretBindingRecord {
  return Object.freeze(record)
}

export function createSecretBroker(options: SecretBrokerOptions): SecretBroker {
  const now = options.now ?? (() => new Date())
  const generateId = options.generateId ?? (() => randomUUID())
  const generateMaterial =
    options.generateMaterial ?? (() => createSyntheticMaterial())
  const pepper =
    options.pepper ?? randomBytes(SECRET_PEPPER_MIN_BYTES).toString('hex')
  if (Buffer.byteLength(pepper, 'utf8') < SECRET_PEPPER_MIN_BYTES) {
    throw new SecretReferenceError('pepper')
  }

  /** Registro público por referência (sem material). */
  const records = new Map<string, SecretBindingRecord>()
  /** Índice de slot → referência ativa, para replay idempotente por escopo. */
  const slots = new Map<string, { ref: string; keyHash: string | null }>()

  function slotKey(input: {
    projectId: string
    environment: Environment
    purpose: SecretPurpose
  }): string {
    return `${input.projectId}:${input.environment}:${input.purpose}`
  }

  function hashIdempotencyKey(key: string): string {
    return `idem_${createHash('sha256').update(key).digest('hex')}`
  }

  function handleFor(record: SecretBindingRecord): SecretMaterialHandle {
    const digest = secretRefDigest(record.secret_ref, pepper)
    const material = options.materials.read(digest)
    if (material === null) {
      // Registro público sem material privado: inconsistência fechada.
      throw new SecretMaterialError('binding_without_material')
    }
    return Object.freeze({
      secret_ref: record.secret_ref,
      masked_ref: record.masked_ref,
      fingerprint: record.fingerprint,
      purpose: record.purpose,
      project_id: record.project_id,
      environment: record.environment,
      reveal: () => material,
      toJSON: () => ({
        masked_ref: record.masked_ref,
        fingerprint: record.fingerprint,
        purpose: record.purpose,
      }),
    })
  }

  /** Emissão atômica: material primeiro, registro depois, com compensação. */
  function emit(input: {
    projectId: string
    environment: Environment
    purpose: SecretPurpose
    idempotencyKeyHash: string | null
    rotatedFrom: string | null
    supersedes: string | null
  }): IssuedSecret {
    const secretRef = generateSecretRef({ random: options.generateBytes })
    const digest = secretRefDigest(secretRef, pepper)
    const material = generateMaterial()

    // 1. binding privado (atômico por digest). Se falhar, nada é publicado.
    options.materials.put(digest, material)

    const createdAt = now().toISOString()
    const record = freezeRecord({
      binding_id: generateId(),
      secret_ref: secretRef,
      masked_ref: SECRET_REF_MASK,
      fingerprint: secretRefFingerprint(secretRef),
      purpose: input.purpose,
      project_id: input.projectId,
      environment: input.environment,
      state: 'active',
      created_at: createdAt,
      idempotency_key_hash: input.idempotencyKeyHash,
      rotated_from: input.rotatedFrom,
      replaced_by: null,
    })

    try {
      // 2. registro público por referência.
      records.set(secretRef, record)
      // 3. troca do slot ativo: a referência anterior sai de circulação.
      if (input.supersedes !== null) {
        const previous = records.get(input.supersedes)
        if (previous !== undefined) {
          records.set(
            input.supersedes,
            freezeRecord({
              ...previous,
              state: input.rotatedFrom === null ? 'superseded' : 'rotated',
              replaced_by: secretRef,
            }),
          )
        }
      }
      slots.set(slotKey(input), {
        ref: secretRef,
        keyHash: input.idempotencyKeyHash,
      })
    } catch (error) {
      // Compensação: sem registro público, o material não pode ficar órfão.
      records.delete(secretRef)
      options.materials.remove(digest)
      throw new SecretMaterialError('binding_write_failed', { cause: error })
    }

    return Object.freeze({
      secret_ref: secretRef,
      masked_ref: record.masked_ref,
      fingerprint: record.fingerprint,
      purpose: record.purpose,
      binding_id: record.binding_id,
      created_at: record.created_at,
      replayed: false,
      rotated_from: input.rotatedFrom,
    })
  }

  return {
    version: SECRET_BROKER_VERSION,

    issue(input: IssueSecretInput): IssuedSecret {
      const projectId = assertProjectId(input.projectId)
      const environment = assertEnvironment(input.environment)
      const purpose = assertPurpose(input.purpose)
      const scope = { projectId, environment, purpose }
      const key = slotKey(scope)
      const existing = slots.get(key)
      const keyHash =
        typeof input.idempotencyKey === 'string' &&
        input.idempotencyKey.length > 0
          ? hashIdempotencyKey(input.idempotencyKey)
          : null

      if (existing !== undefined) {
        const current = records.get(existing.ref)
        // Replay idempotente: mesma chave e mesmo escopo devolvem a
        // referência já persistida, sem material novo e sem alias derivável.
        if (
          current !== undefined &&
          keyHash !== null &&
          existing.keyHash === keyHash
        ) {
          return Object.freeze({
            secret_ref: current.secret_ref,
            masked_ref: current.masked_ref,
            fingerprint: current.fingerprint,
            purpose: current.purpose,
            binding_id: current.binding_id,
            created_at: current.created_at,
            replayed: true,
            rotated_from: current.rotated_from,
          })
        }
        return emit({
          ...scope,
          idempotencyKeyHash: keyHash,
          rotatedFrom: null,
          supersedes: existing.ref,
        })
      }

      return emit({
        ...scope,
        idempotencyKeyHash: keyHash,
        rotatedFrom: null,
        supersedes: null,
      })
    },

    rotate(input: RotateSecretInput): IssuedSecret {
      const projectId = assertProjectId(input.projectId)
      const environment = assertEnvironment(input.environment)
      const purpose = assertPurpose(input.purpose)
      const previousRef = assertSecretRefShape(input.previousSecretRef)
      const previous = records.get(previousRef)
      const scopeKeyValue = slotKey({ projectId, environment, purpose })

      if (
        previous === undefined ||
        previous.state !== 'active' ||
        previous.project_id !== projectId ||
        previous.environment !== environment ||
        previous.purpose !== purpose ||
        slots.get(scopeKeyValue)?.ref !== previousRef
      ) {
        throw new SecretUnavailableError()
      }

      return emit({
        projectId,
        environment,
        purpose,
        idempotencyKeyHash: null,
        rotatedFrom: previousRef,
        supersedes: previousRef,
      })
    },

    handle(input: ResolveSecretInput): SecretMaterialHandle {
      const projectId = assertProjectId(input.projectId)
      const environment = assertEnvironment(input.environment)
      const purpose = assertPurpose(input.purpose)
      const secretRef = input.secretRef
      if (!hasMinimumEntropy(secretRef)) throw new SecretUnavailableError()

      const record = records.get(secretRef)
      if (
        record === undefined ||
        record.state !== 'active' ||
        record.project_id !== projectId ||
        record.environment !== environment ||
        record.purpose !== purpose
      ) {
        // Mesma resposta para desconhecido, rotacionado e cross-project.
        throw new SecretUnavailableError()
      }
      return handleFor(record)
    },

    bindings(): ReadonlyArray<SecretBindingRecord> {
      return Object.freeze([...records.values()])
    },

    activeSecretRefs(input: {
      readonly projectId: string
      readonly environment: Environment
      readonly purpose: SecretPurpose
    }): ReadonlyArray<string> {
      const current = slots.get(slotKey(input))
      return Object.freeze(current === undefined ? [] : [current.ref])
    },
  }
}
