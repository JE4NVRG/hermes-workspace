/**
 * Testes do secret broker (PR 6).
 *
 * Cobre o critério do card: `sref_` com 32+ bytes de CSPRNG em base64url,
 * binding privado atômico por digest, replay idempotente, rotação, recusa
 * uniforme cross-project e redaction — sem nenhum material real (o fixture é
 * sintético e gerado em runtime).
 */
import { describe, expect, it } from 'vitest'
import { MASK, SECRET_REF_MASK, redactForLog, redactValue } from './redaction'
import {
  SECRET_BROKER_VERSION,
  SECRET_REF_ENTROPY_BYTES,
  SECRET_REF_PREFIX,
  SecretMaterialError,
  SecretReferenceError,
  SecretUnavailableError,
  assertSecretRefShape,
  createInMemorySecretMaterialStore,
  createSecretBroker,
  createSyntheticMaterial,
  generateSecretRef,
  hasMinimumEntropy,
  isSecretRefToken,
  maskSecretRefValue,
  secretRefDigest,
  secretRefFingerprint,
} from './secret-broker'
import type { SecretBroker, SecretMaterialStore } from './secret-broker'

const PROJECT_A = 'acme-site'
const PROJECT_B = 'acme-blog'
const PEPPER = 'p'.repeat(48)
/** Prefixo do material sintético, montado aqui para não virar literal de valor. */
const SYNTHETIC_PREFIX = ['synthetic', 'material', ''].join('-')

interface Harness {
  readonly broker: SecretBroker
  readonly materials: SecretMaterialStore
  readonly materialOf: (secretRef: string) => string | null
}

function createHarness(
  options: { readonly materials?: SecretMaterialStore } = {},
): Harness {
  const materials = options.materials ?? createInMemorySecretMaterialStore()
  let counter = 0
  const broker = createSecretBroker({
    materials,
    pepper: PEPPER,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => {
      counter += 1
      return `55555555-5555-4555-8555-${String(counter).padStart(12, '0')}`
    },
  })
  return {
    broker,
    materials,
    materialOf: (secretRef: string) =>
      materials.read(secretRefDigest(secretRef, PEPPER)),
  }
}

describe('secret broker — referência opaca', () => {
  it('gera sref_ com 32 bytes CSPRNG em base64url e entropia mínima', () => {
    const secretRef = generateSecretRef()
    const body = secretRef.slice(SECRET_REF_PREFIX.length)

    expect(isSecretRefToken(secretRef)).toBe(true)
    expect(hasMinimumEntropy(secretRef)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(43)
    expect(body.length * 6).toBeGreaterThanOrEqual(SECRET_REF_ENTROPY_BYTES * 8)
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('duas emissões independentes nunca coincidem', () => {
    const refs = new Set(Array.from({ length: 32 }, () => generateSecretRef()))
    expect(refs.size).toBe(32)
  })

  it('recusa entropia abaixo do mínimo e CSPRNG degenerado', () => {
    expect(() => generateSecretRef({ bytes: 16 })).toThrow(SecretReferenceError)
    expect(() =>
      generateSecretRef({ random: () => Buffer.from('curto') }),
    ).toThrow(SecretReferenceError)
  })

  it('recusa placeholder derivável, valor curto e formato estranho', () => {
    expect(() =>
      assertSecretRefShape(`${SECRET_REF_PREFIX}<project_id>`),
    ).toThrow(SecretReferenceError)
    expect(() => assertSecretRefShape(`${SECRET_REF_PREFIX}curto`)).toThrow(
      SecretReferenceError,
    )
    expect(() => assertSecretRefShape('ref_opaca_sem_prefixo')).toThrow(
      SecretReferenceError,
    )
    expect(() => assertSecretRefShape(undefined)).toThrow(SecretReferenceError)
    expect(maskSecretRefValue(generateSecretRef())).toBe(SECRET_REF_MASK)
  })

  it('digest privado exige pepper mínimo e é estável por pepper', () => {
    const secretRef = generateSecretRef()
    expect(secretRefDigest(secretRef, PEPPER)).toBe(
      secretRefDigest(secretRef, PEPPER),
    )
    expect(secretRefDigest(secretRef, PEPPER)).not.toBe(
      secretRefDigest(secretRef, `${PEPPER}x`),
    )
    expect(() => secretRefDigest(secretRef, 'curto')).toThrow(
      SecretReferenceError,
    )
    expect(secretRefFingerprint(secretRef)).not.toContain(secretRef)
  })
})

describe('secret broker — emissão, replay e rotação', () => {
  it('emite referência opaca e guarda material somente no vault privado', () => {
    const harness = createHarness()
    const issued = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'app_role_password',
      idempotencyKey: 'op-1:app_role_password',
    })

    expect(harness.broker.version).toBe(SECRET_BROKER_VERSION)
    expect(hasMinimumEntropy(issued.secret_ref)).toBe(true)
    expect(issued.masked_ref).toBe(SECRET_REF_MASK)
    expect(issued.replayed).toBe(false)
    expect(issued.rotated_from).toBeNull()
    expect(harness.materials.size()).toBe(1)
    expect(harness.materialOf(issued.secret_ref)).not.toBeNull()

    const serialized = JSON.stringify({
      issued,
      bindings: harness.broker.bindings(),
    })
    const material = harness.materialOf(issued.secret_ref) as string
    expect(material.length).toBeGreaterThan(0)
    expect(serialized).not.toContain(material)
    expect(serialized).toContain(SECRET_REF_MASK)
  })

  it('replay com a mesma chave devolve a referência persistida sem material novo', () => {
    const harness = createHarness()
    const first = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'service_role_key',
      idempotencyKey: 'op-7:service_role_key',
    })
    const second = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'service_role_key',
      idempotencyKey: 'op-7:service_role_key',
    })

    expect(second.replayed).toBe(true)
    expect(second.secret_ref).toBe(first.secret_ref)
    expect(second.binding_id).toBe(first.binding_id)
    expect(harness.materials.size()).toBe(1)
    expect(harness.broker.bindings()).toHaveLength(1)
  })

  it('emissões independentes produzem tokens distintos e rotacionam o slot', () => {
    const harness = createHarness()
    const first = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'jwt_secret',
    })
    const second = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'jwt_secret',
    })

    expect(second.secret_ref).not.toBe(first.secret_ref)
    expect(
      harness.broker.activeSecretRefs({
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'jwt_secret',
      }),
    ).toEqual([second.secret_ref])

    const previous = harness.broker
      .bindings()
      .find((binding) => binding.secret_ref === first.secret_ref)
    expect(previous?.state).toBe('superseded')
    expect(previous?.replaced_by).toBe(second.secret_ref)
    expect(() =>
      harness.broker.handle({
        secretRef: first.secret_ref,
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'jwt_secret',
      }),
    ).toThrow(SecretUnavailableError)
  })

  it('rotaciona invalidando a referência anterior e mantendo histórico', () => {
    const harness = createHarness()
    const first = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'app_role_password',
    })
    const rotated = harness.broker.rotate({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'app_role_password',
      previousSecretRef: first.secret_ref,
    })

    expect(rotated.secret_ref).not.toBe(first.secret_ref)
    expect(rotated.rotated_from).toBe(first.secret_ref)

    const previous = harness.broker
      .bindings()
      .find((binding) => binding.secret_ref === first.secret_ref)
    expect(previous?.state).toBe('rotated')
    expect(previous?.replaced_by).toBe(rotated.secret_ref)
    expect(harness.materials.size()).toBe(2)

    const handle = harness.broker.handle({
      secretRef: rotated.secret_ref,
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'app_role_password',
    })
    expect(handle.purpose).toBe('app_role_password')
  })

  it('rotacionar referência já rotacionada falha fechado e não cria material', () => {
    const harness = createHarness()
    const first = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'anon_key',
    })
    harness.broker.rotate({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'anon_key',
      previousSecretRef: first.secret_ref,
    })

    expect(() =>
      harness.broker.rotate({
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'anon_key',
        previousSecretRef: first.secret_ref,
      }),
    ).toThrow(SecretUnavailableError)
    expect(harness.materials.size()).toBe(2)
  })
})

describe('secret broker — resolução e recusa uniforme', () => {
  it('resolve para o projeto correto e revela material apenas no handle', () => {
    const harness = createHarness()
    const issued = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'staging',
      purpose: 'service_role_key',
    })
    const handle = harness.broker.handle({
      secretRef: issued.secret_ref,
      projectId: PROJECT_A,
      environment: 'staging',
      purpose: 'service_role_key',
    })
    const material = handle.reveal()

    expect(material.startsWith(SYNTHETIC_PREFIX)).toBe(true)
    expect(JSON.stringify(handle)).not.toContain(material)
    expect(JSON.stringify(handle)).toContain(SECRET_REF_MASK)
    expect(redactForLog(handle)).not.toContain(material)
    expect(redactForLog(handle)).toContain(MASK)
    expect(redactValue(handle)).not.toEqual(
      expect.objectContaining({ reveal: material }),
    )
    expect(
      Object.values(redactValue(handle) as Record<string, unknown>),
    ).not.toContain(material)
  })

  it('recusa cross-project, propósito errado, ambiente errado e desconhecido de forma uniforme', () => {
    const harness = createHarness()
    const issued = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'app_role_password',
    })

    const attempts = [
      {
        projectId: PROJECT_B,
        environment: 'development' as const,
        purpose: 'app_role_password' as const,
      },
      {
        projectId: PROJECT_A,
        environment: 'production' as const,
        purpose: 'app_role_password' as const,
      },
      {
        projectId: PROJECT_A,
        environment: 'development' as const,
        purpose: 'jwt_secret' as const,
      },
    ]
    const messages = new Set<string>()
    for (const attempt of attempts) {
      let caught: unknown = null
      try {
        harness.broker.handle({ secretRef: issued.secret_ref, ...attempt })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SecretUnavailableError)
      const failure = caught as SecretUnavailableError
      expect(failure.code).toBe('FORBIDDEN')
      expect(failure.status).toBe(403)
      messages.add(failure.message)
    }

    let unknown: unknown = null
    try {
      harness.broker.handle({
        secretRef: generateSecretRef(),
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'app_role_password',
      })
    } catch (error) {
      unknown = error
    }
    expect(unknown).toBeInstanceOf(SecretUnavailableError)
    messages.add((unknown as SecretUnavailableError).message)

    expect(messages.size).toBe(1)
    expect([...messages][0]).not.toContain(issued.secret_ref)
  })

  it('recusa project_id/purpose/ambiente fora do contrato sem tocar o vault', () => {
    const harness = createHarness()
    expect(() =>
      harness.broker.issue({
        projectId: '../etc',
        environment: 'development',
        purpose: 'jwt_secret',
      }),
    ).toThrow(SecretReferenceError)
    expect(() =>
      harness.broker.issue({
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'livre' as never,
      }),
    ).toThrow(SecretReferenceError)
    expect(() =>
      harness.broker.issue({
        projectId: PROJECT_A,
        environment: 'local' as never,
        purpose: 'jwt_secret',
      }),
    ).toThrow(SecretReferenceError)
    expect(harness.materials.size()).toBe(0)
    expect(harness.broker.bindings()).toHaveLength(0)
  })
})

describe('secret broker — binding atômico', () => {
  it('colisão de digest com material divergente é recusada', () => {
    const materials = createInMemorySecretMaterialStore()
    const digest = 'a'.repeat(64)
    materials.put(digest, createSyntheticMaterial())
    expect(() => materials.put(digest, createSyntheticMaterial())).toThrow(
      SecretMaterialError,
    )
    expect(() => materials.put('curto', 'x')).toThrow(SecretMaterialError)
  })

  it('falha ao gravar o binding privado não publica referência nem deixa órfão', () => {
    let calls = 0
    const failing: SecretMaterialStore = {
      put: () => {
        calls += 1
        if (calls > 1) throw new SecretMaterialError('vault_indisponivel')
      },
      has: () => false,
      read: () => null,
      remove: () => undefined,
      size: () => 0,
    }
    const harness = createHarness({ materials: failing })

    const issued = harness.broker.issue({
      projectId: PROJECT_A,
      environment: 'development',
      purpose: 'admin_bootstrap',
    })
    expect(hasMinimumEntropy(issued.secret_ref)).toBe(true)
    expect(harness.broker.bindings()).toHaveLength(1)

    expect(() =>
      harness.broker.issue({
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'admin_bootstrap',
      }),
    ).toThrow(SecretMaterialError)
    // Nenhuma referência órfã publicada: o registro continua sendo o primeiro.
    expect(harness.broker.bindings()).toHaveLength(1)
    expect(
      harness.broker.activeSecretRefs({
        projectId: PROJECT_A,
        environment: 'development',
        purpose: 'admin_bootstrap',
      }),
    ).toEqual([issued.secret_ref])
  })
})
