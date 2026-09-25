/**
 * Testes de redaction.
 *
 * Todas as fixtures sensíveis são montadas em runtime (concatenação/`join`),
 * de modo que nenhum valor com formato de secret, DSN ou path do host fique
 * gravado como literal no commit.
 */
import { describe, expect, it } from 'vitest'
import { SECRET_REF_PATTERN, safePayloadSchema } from './domain'
import {
  CIRCULAR_MASK,
  MASK,
  PATH_MASK,
  SECRET_REF_FINGERPRINT_PREFIX,
  SECRET_REF_MASK,
  fingerprintSecretRef,
  isSecretRef,
  isSensitiveKey,
  maskSecretRef,
  redactForLog,
  redactText,
  redactValue,
  toSafePayload,
} from './redaction'

const CREDENTIAL_VALUE = ['credencial', 'sintetica', 'x9'].join('-')
const DSN_VALUE = `postgres://app:${CREDENTIAL_VALUE}@db.interno:5432/app`
const URI_WITH_CREDENTIAL = `https://operador:${CREDENTIAL_VALUE}@painel.interno/x`
const JWT_VALUE = [
  ['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''),
  'eyJzdWIiOiJwY3YyIn0',
  'c2lnbmF0dXJlLXRlc3Rl',
].join('.')
const SERVICE_KEY_VALUE = ['sb', 'secret', 'chave', 'sintetica', 'x9'].join('_')
const SECRET_REF_VALUE = `sref_${'B'.repeat(43)}`
const ABSOLUTE_PATH_VALUE = ['', 'srv', 'pcv2', 'dados', 'pgdata'].join('/')
const WINDOWS_PATH_VALUE = ['C:', 'Users', 'pcv2', 'dados'].join(
  String.fromCharCode(92),
)
const CREDENTIAL_KEY = ['pass', 'word'].join('')
const CREDENTIAL_SECRET = ['senha', 'sintetica', 'x9'].join('-')
const PRIVATE_KEY_BLOCK = [
  ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  'Y29udGV1ZG8tc2ludGV0aWNv',
  ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
].join('\n')

const SENSITIVE_FIXTURES = [
  DSN_VALUE,
  URI_WITH_CREDENTIAL,
  JWT_VALUE,
  SERVICE_KEY_VALUE,
  SECRET_REF_VALUE,
  ABSOLUTE_PATH_VALUE,
  WINDOWS_PATH_VALUE,
  CREDENTIAL_SECRET,
  PRIVATE_KEY_BLOCK,
]

describe('redactText', () => {
  it('mascara DSN com credencial embutida', () => {
    const redacted = redactText(`falha ao conectar em ${DSN_VALUE}`)
    expect(redacted).not.toContain(DSN_VALUE)
    expect(redacted).not.toContain(CREDENTIAL_VALUE)
    expect(redacted).toContain(MASK)
  })

  it('mascara URI com usuario e credencial em qualquer esquema', () => {
    const redacted = redactText(URI_WITH_CREDENTIAL)
    expect(redacted).not.toContain(CREDENTIAL_VALUE)
    expect(redacted).toBe(MASK)
  })

  it('mascara JWT integral', () => {
    const redacted = redactText(`authorization Bearer ${JWT_VALUE}`)
    expect(redacted).not.toContain(JWT_VALUE)
    expect(redacted).toContain(MASK)
  })

  it('mascara service key', () => {
    const redacted = redactText(`chave ${SERVICE_KEY_VALUE} rejeitada`)
    expect(redacted).not.toContain(SERVICE_KEY_VALUE)
    expect(redacted).toContain(MASK)
  })

  it('mascara senha em atribuicao', () => {
    const redacted = redactText(`${CREDENTIAL_KEY}=${CREDENTIAL_SECRET}`)
    expect(redacted).not.toContain(CREDENTIAL_SECRET)
    expect(redacted).toContain(MASK)
    expect(redactText(`token: ${JWT_VALUE}`)).not.toContain(JWT_VALUE)
  })

  it('mascara path absoluto POSIX e Windows', () => {
    expect(redactText(`cwd ${ABSOLUTE_PATH_VALUE}/base`)).toContain(PATH_MASK)
    expect(redactText(`cwd ${ABSOLUTE_PATH_VALUE}/base`)).not.toContain(
      ABSOLUTE_PATH_VALUE,
    )
    const windows = redactText(`cwd ${WINDOWS_PATH_VALUE}`)
    expect(windows).not.toContain(WINDOWS_PATH_VALUE)
    expect(windows).toContain(PATH_MASK)
    expect(redactText(ABSOLUTE_PATH_VALUE)).toBe(PATH_MASK)
  })

  it('mascara bloco de chave privada', () => {
    const redacted = redactText(PRIVATE_KEY_BLOCK)
    expect(redacted).not.toContain('Y29udGV1ZG8tc2ludGV0aWNv')
    expect(redacted).toContain(MASK)
  })

  it('mascara token sref_ integral e nunca o devolve', () => {
    const redacted = redactText(`artefato ${SECRET_REF_VALUE} criado`)
    expect(redacted).not.toContain(SECRET_REF_VALUE)
    expect(redacted).toContain(SECRET_REF_MASK)
    expect(redacted).toContain('REDACTED')
  })

  it('preserva texto que nao e sensivel', () => {
    const text = 'operacao aprobada em desenvolvimento; health check executado'
    expect(redactText(text)).toBe(text)
  })

  it('e idempotente', () => {
    for (const fixture of SENSITIVE_FIXTURES) {
      const once = redactText(fixture)
      expect(redactText(once)).toBe(once)
    }
  })
})

describe('redactValue', () => {
  it('mascara chave sensivel, secret ref e path aninhados', () => {
    const payload = {
      [CREDENTIAL_KEY]: CREDENTIAL_SECRET,
      dsn: DSN_VALUE,
      authorization: `Bearer ${JWT_VALUE}`,
      service_key: SERVICE_KEY_VALUE,
      secret_ref: SECRET_REF_VALUE,
      workdir: ABSOLUTE_PATH_VALUE,
      nested: { paths: [ABSOLUTE_PATH_VALUE], attempts: 2 },
    }

    const redacted = redactValue(payload) as Record<string, unknown>
    expect(redacted[CREDENTIAL_KEY]).toBe(MASK)
    expect(redacted.dsn).toBe(MASK)
    expect(redacted.authorization).toBe(MASK)
    expect(redacted.service_key).toBe(MASK)
    expect(redacted.secret_ref).toBe(SECRET_REF_MASK)
    expect(redacted.workdir).toBe(PATH_MASK)
    expect(redacted.nested).toEqual({ paths: [PATH_MASK], attempts: 2 })
  })

  it('nao devolve nenhum valor sensivel serializado', () => {
    const payload = {
      [CREDENTIAL_KEY]: CREDENTIAL_SECRET,
      dsn: DSN_VALUE,
      jwt: JWT_VALUE,
      service_key: SERVICE_KEY_VALUE,
      secret_ref: SECRET_REF_VALUE,
      nested: { paths: [ABSOLUTE_PATH_VALUE], private_key: PRIVATE_KEY_BLOCK },
    }
    const serialized = redactForLog(payload)
    for (const fixture of SENSITIVE_FIXTURES) {
      expect(serialized).not.toContain(fixture)
    }
    expect(serialized).toContain(SECRET_REF_MASK)
    expect(serialized).toContain(PATH_MASK)
  })

  it('nao muta a entrada', () => {
    const payload = { dsn: DSN_VALUE }
    redactValue(payload)
    expect(payload.dsn).toBe(DSN_VALUE)
  })

  it('trata ciclos, profundidade, datas, erros e valores nao serializaveis', () => {
    const circular: Record<string, unknown> = { name: 'pcv2' }
    circular.self = circular
    const circularResult = redactValue(circular) as Record<string, unknown>
    expect(circularResult.name).toBe('pcv2')
    expect(circularResult.self).toBe(CIRCULAR_MASK)

    const deep = redactValue({ a: { b: { c: 1 } } }, { maxDepth: 1 }) as Record<
      string,
      Record<string, unknown>
    >
    expect(deep.a.b).toBe(MASK)

    const dated = redactValue({ at: new Date('2026-09-25T00:00:00.000Z') })
    expect(dated).toEqual({ at: '2026-09-25T00:00:00.000Z' })

    const failure = Object.assign(
      new Error(`falha em ${ABSOLUTE_PATH_VALUE}`),
      { code: 'EXECUTION_FAILED' },
    )
    expect(redactValue(failure)).toEqual({
      name: 'Error',
      message: `falha em ${PATH_MASK}`,
      code: 'EXECUTION_FAILED',
    })

    const odd = redactValue({
      fn: () => 1,
      symbol: Symbol('x'),
      big: BigInt(10),
      missing: undefined,
      notFinite: Number.POSITIVE_INFINITY,
    }) as Record<string, unknown>
    expect(odd.fn).toBe(MASK)
    expect(odd.symbol).toBe(MASK)
    expect(odd.big).toBe(MASK)
    expect(odd.missing).toBeNull()
    expect(odd.notFinite).toBe(MASK)
  })

  it('nunca lanca em log', () => {
    expect(redactForLog(undefined)).toBe('null')
    expect(typeof redactForLog({ a: 1 })).toBe('string')
  })
})

describe('SecretRef', () => {
  it('reconhece apenas o formato do contrato', () => {
    expect(isSecretRef(SECRET_REF_VALUE)).toBe(true)
    expect(isSecretRef(`sref_${'B'.repeat(42)}`)).toBe(false)
    expect(isSecretRef(`sref_${'B'.repeat(129)}`)).toBe(false)
    expect(isSecretRef('sref_')).toBe(false)
    expect(isSecretRef(SECRET_REF_VALUE.toUpperCase())).toBe(false)
    expect(isSecretRef(1234)).toBe(false)
    expect(isSecretRef(null)).toBe(false)
    expect(isSecretRef(undefined)).toBe(false)
  })

  it('mascara de forma neutra, sem depender do valor', () => {
    const first = maskSecretRef(SECRET_REF_VALUE)
    const second = maskSecretRef(`sref_${'C'.repeat(60)}`)
    expect(first).toBe(SECRET_REF_MASK)
    expect(second).toBe(SECRET_REF_MASK)
    expect(first).not.toContain(SECRET_REF_VALUE.slice(5, 20))
  })

  it('gera fingerprint estavel e nao reversivel', () => {
    const fingerprint = fingerprintSecretRef(SECRET_REF_VALUE)
    expect(fingerprint.startsWith(SECRET_REF_FINGERPRINT_PREFIX)).toBe(true)
    expect(fingerprintSecretRef(SECRET_REF_VALUE)).toBe(fingerprint)
    expect(fingerprintSecretRef(`sref_${'C'.repeat(43)}`)).not.toBe(fingerprint)
    expect(fingerprint).not.toContain(SECRET_REF_VALUE.slice(5, 20))
    expect(SECRET_REF_PATTERN.test(fingerprint)).toBe(false)
  })

  it('identifica chaves sensiveis sem falso negativo nos nomes do catalogo', () => {
    for (const key of [
      CREDENTIAL_KEY,
      'dsn',
      'authorization',
      'service_key',
      'private_key',
      'api_key',
      'token',
      'secret',
      'connection_string',
    ]) {
      expect(isSensitiveKey(key), `chave ${key}`).toBe(true)
    }
    for (const key of ['state', 'plan_hash', 'sequence', 'attempt', 'driver']) {
      expect(isSensitiveKey(key), `chave ${key}`).toBe(false)
    }
  })
})

describe('toSafePayload', () => {
  it('achata em escalares e valida contra o contrato', () => {
    const payload = toSafePayload({
      state: 'planned',
      attempt: 1,
      nested: { aplan: true, note: `em ${ABSOLUTE_PATH_VALUE}` },
      list: ['x', 'y'],
      nothing: null,
      dsn: DSN_VALUE,
      secret_ref: SECRET_REF_VALUE,
    })
    expect(payload.state).toBe('planned')
    expect(payload.attempt).toBe(1)
    expect(payload['nested.aplan']).toBe(true)
    expect(payload['nested.note']).toBe(`em ${PATH_MASK}`)
    expect(payload['list.0']).toBe('x')
    expect(payload.nothing).toBeNull()
    expect(payload.dsn).toBe(MASK)
    expect(payload.secret_ref).toBe(SECRET_REF_MASK)
    expect(safePayloadSchema.safeParse(payload).success).toBe(true)
    for (const value of Object.values(payload)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value)
    }
  })

  it('limita a 30 propriedades sem silencio', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`campo_${index}`, index]),
    )
    const payload = toSafePayload(oversized)
    expect(Object.keys(payload)).toHaveLength(30)
    expect(payload.truncated_properties).toBe(11)
    expect(safePayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('aceita ausencia de payload', () => {
    expect(toSafePayload(undefined)).toEqual({})
  })
})
