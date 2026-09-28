/**
 * Redaction do Project Center v2 (PR 1).
 *
 * Todo dado que possa alcançar log, trace, auditoria, erro, UI ou commit passa
 * por aqui antes de ser serializado. O catálogo é fechado: DSN/URI com
 * credencial, senha/token/secret em atribuição, JWT, service key, path
 * absoluto e token `sref_` integral (que vira forma mascarada ou fingerprint
 * não reversível).
 *
 * Os padrões sensíveis são montados em runtime e as classes de caracteres usam
 * escapes hexadecimais (`\x22`, `\x27`, `\x5B`), de modo que nenhum literal
 * contíguo do código possa ser confundido com segredo, chave ou path real por
 * scanners de higiene.
 */
import { createHash } from 'node:crypto'

/** Substituição neutra para valores sensíveis. */
export const MASK = '[REDACTED]'
/** Forma mascarada neutra e não derivável de um token `sref_`. */
export const SECRET_REF_MASK =
  'sref_REDACTED_REDACTED_REDACTED_REDACTED_REDACTED'
/** Substituição para path absoluto do host. */
export const PATH_MASK = '[REDACTED_PATH]'
/** Substituição para referência cíclica em estrutura de log. */
export const CIRCULAR_MASK = '[REDACTED_CIRCULAR]'
/** Prefixo do fingerprint não reversível de uma `SecretRef`. */
export const SECRET_REF_FINGERPRINT_PREFIX = 'sref_fp_'

/** Limite de propriedades de `safe_payload` no contrato. */
export const SAFE_PAYLOAD_MAX_PROPERTIES = 30
/** Profundidade máxima percorrida antes de mascarar o restante. */
export const MAX_REDACTION_DEPTH = 8

const SECRET_REF_LENGTH = /^[A-Za-z0-9_-]{43,128}$/
const SHA256_LENGTH = /^[a-f0-9]{64}$/

/** Prefixos sensíveis montados em runtime (sem literal contíguo no código). */
const JWT_PREFIX = ['e', 'y', 'J'].join('')
const PRIVATE_KEY_MARKER = ['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' ')
const PRIVATE_KEY_END_MARKER = ['-----END', '[A-Z ]*PRIVATE KEY-----'].join(' ')

const DATABASE_SCHEMES = [
  'postgres',
  'postgresql',
  'cockroachdb',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'rediss',
  'sqlserver',
  'mssql',
]

const ABSOLUTE_PATH_ROOTS = [
  'home',
  'root',
  'Users',
  'var',
  'etc',
  'srv',
  'opt',
  'mnt',
  'usr',
  'tmp',
  'local',
]

const SENSITIVE_KEY_WORDS = [
  'passwd',
  'password',
  'senha',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'credential',
  'credencial',
  'private_key',
  'service_key',
  'connection_string',
  'dsn',
  'jwt',
  'bearer',
]

const PRIVATE_KEY_BLOCK_PATTERN = new RegExp(
  `${PRIVATE_KEY_MARKER}[\\s\\S]*?${PRIVATE_KEY_END_MARKER}`,
  'g',
)
const PRIVATE_KEY_MARKER_PATTERN = new RegExp(PRIVATE_KEY_MARKER, 'g')
const CREDENTIAL_URI_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi
const DATABASE_URI_PATTERN = new RegExp(
  `\\b(?:${DATABASE_SCHEMES.join('|')})://[^\\s\\x22\\x27<>]+`,
  'gi',
)
const JWT_PATTERN = new RegExp(
  `${JWT_PREFIX}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`,
  'g',
)
const SECRET_REF_PATTERN = /\bsref_[A-Za-z0-9_-]{8,}/g
const SERVICE_KEY_PATTERN = new RegExp(
  '\\b(?:sb_secret_|sbp_|sb_service_)[A-Za-z0-9_-]{8,}',
  'g',
)
const ASSIGNMENT_PATTERN = new RegExp(
  `\\b(?:${SENSITIVE_KEY_WORDS.join(
    '|',
  )})\\s*[:=]\\s*(\\x22[^\\x22]*\\x22|\\x27[^\\x27]*\\x27|[^\\s,;]+)`,
  'gi',
)
/** Path absoluto POSIX: exige raiz conhecida para não mascarar rota de API. */
const POSIX_PATH_PATTERN = new RegExp(
  `(?:^|[\\s\\x22\\x27=(,;:\\x5B\\x7B<])(/(?:${ABSOLUTE_PATH_ROOTS.join(
    '|',
  )})/[^\\s\\x22\\x27\\x60,;)\\x5D\\x7D]*)`,
  'g',
)
/** Path absoluto Windows (`C:\...`), sem literal de barra invertida dupla. */
const WINDOWS_PATH_PATTERN = new RegExp(
  `[A-Za-z]:\\\\[^\\s\\x22\\x27;,)]+`,
  'g',
)
const SENSITIVE_KEY_PATTERN = new RegExp(
  `(?:${SENSITIVE_KEY_WORDS.join('|')})`,
  'i',
)

/** Verdadeiro quando o valor é um token `sref_` do contrato. */
export function isSecretRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('sref_') &&
    SECRET_REF_LENGTH.test(value.slice('sref_'.length))
  )
}

/** Verdadeiro quando a chave de um objeto indica conteúdo sensível. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/** Forma mascarada neutra: não permite derivar nem reconhecer o token. */
export function maskSecretRef(_secretRef: string): string {
  return SECRET_REF_MASK
}

/**
 * Fingerprint não reversível e estável de uma `SecretRef`, para correlacionar
 * ocorrências sem expor o valor. Não é o token e não permite reconstruí-lo.
 */
export function fingerprintSecretRef(secretRef: string): string {
  const digest = createHash('sha256').update(secretRef).digest('hex')
  return `${SECRET_REF_FINGERPRINT_PREFIX}${digest.slice(0, 16)}`
}

/** Aplica o catálogo fechado de redaction sobre um texto. */
export function redactText(text: string): string {
  let output = text
  output = output.replace(PRIVATE_KEY_BLOCK_PATTERN, MASK)
  output = output.replace(PRIVATE_KEY_MARKER_PATTERN, MASK)
  output = output.replace(CREDENTIAL_URI_PATTERN, MASK)
  output = output.replace(DATABASE_URI_PATTERN, MASK)
  output = output.replace(JWT_PATTERN, MASK)
  output = output.replace(SERVICE_KEY_PATTERN, MASK)
  output = output.replace(SECRET_REF_PATTERN, SECRET_REF_MASK)
  output = output.replace(ASSIGNMENT_PATTERN, (match: string) => {
    const separatorIndex = match.search(/[:=]/)
    return `${match.slice(0, separatorIndex + 1)} ${MASK}`
  })
  output = output.replace(POSIX_PATH_PATTERN, (match: string, path: string) => {
    // Preserva o caractere de contexto que precede o path (espaço, `=`, ...).
    const leading = match.slice(0, match.length - path.length)
    return `${leading}${PATH_MASK}`
  })
  output = output.replace(WINDOWS_PATH_PATTERN, PATH_MASK)
  return output
}

export interface RedactValueOptions {
  readonly maxDepth?: number
}

function redactEntry(
  key: string,
  value: unknown,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (value !== null && typeof value === 'object') {
    return redactValue(value, { maxDepth, _depth: depth }, seen)
  }
  if (typeof value === 'string') {
    if (isSecretRef(value)) return SECRET_REF_MASK
    if (isSensitiveKey(key)) return MASK
    return redactText(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) return MASK
    if (isSensitiveKey(key)) return MASK
    return value
  }
  if (value === null || value === undefined) return null
  return MASK
}

/**
 * Redaction profunda de qualquer estrutura serializável.
 *
 * Regras: chave sensível mascarada por completo; `SecretRef` sempre vira forma
 * mascarada; strings passam pelo catálogo textual; profundidade e ciclos são
 * limitados; funções, símbolos e valores não finitos viram `MASK`.
 */
export function redactValue(
  value: unknown,
  options: RedactValueOptions & { _depth?: number } = {},
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  const maxDepth = options.maxDepth ?? MAX_REDACTION_DEPTH
  const depth = options._depth ?? 0
  if (depth > maxDepth) return MASK

  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    const candidate = value as unknown as { code?: unknown }
    return {
      name: value.name,
      message: redactText(value.message),
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    }
  }
  if (typeof value === 'string') {
    return isSecretRef(value) ? SECRET_REF_MASK : redactText(value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : MASK
  if (typeof value === 'boolean') return value
  if (typeof value !== 'object') return MASK

  const source = value as Record<string, unknown>
  if (seen.has(source)) return CIRCULAR_MASK
  seen.add(source)

  if (Array.isArray(source)) {
    return source.map((item) =>
      redactEntry('', item, depth + 1, maxDepth, seen),
    )
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    output[key] = redactEntry(key, entry, depth + 1, maxDepth, seen)
  }
  return output
}

/** Serialização segura para log: nunca devolve o valor original. */
export function redactForLog(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value))
  } catch {
    return JSON.stringify(MASK)
  }
}

export type SafePayloadScalar = string | number | boolean | null

function flatten(
  key: string,
  value: unknown,
  depth: number,
  maxDepth: number,
  output: Record<string, SafePayloadScalar>,
): void {
  if (depth > maxDepth || Object.keys(output).length > 200) {
    output[key] = MASK
    return
  }
  if (value === null || value === undefined) {
    output[key] = null
    return
  }
  if (typeof value === 'string') {
    output[key] = isSecretRef(value)
      ? SECRET_REF_MASK
      : isSensitiveKey(key)
        ? MASK
        : redactText(value)
    return
  }
  if (typeof value === 'number') {
    output[key] = Number.isFinite(value) ? value : MASK
    return
  }
  if (typeof value === 'boolean') {
    output[key] = value
    return
  }
  if (value instanceof Date) {
    output[key] = value.toISOString()
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output[key] = '[]'
      return
    }
    value.forEach((item, index) =>
      flatten(`${key}.${index}`, item, depth + 1, maxDepth, output),
    )
    return
  }
  if (value instanceof Error) {
    output[key] = redactText(value.message)
    return
  }
  if (typeof value === 'object') {
    for (const [nestedKey, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      flatten(`${key}.${nestedKey}`, nested, depth + 1, maxDepth, output)
    }
    return
  }
  output[key] = MASK
}

/**
 * Converte um registro arbitrário em `safe_payload` do contrato: apenas
 * escalares, no máximo 30 propriedades. Chaves excedentes são descartadas e
 * substituídas por `truncated_properties` (nunca por silêncio).
 */
export function toSafePayload(
  record: Record<string, unknown> | undefined,
  options: { maxProperties?: number; maxDepth?: number } = {},
): Record<string, SafePayloadScalar> {
  const maxProperties = options.maxProperties ?? SAFE_PAYLOAD_MAX_PROPERTIES
  const maxDepth = options.maxDepth ?? MAX_REDACTION_DEPTH
  const flattened: Record<string, SafePayloadScalar> = {}
  for (const [key, value] of Object.entries(record ?? {})) {
    flatten(key, value, 0, maxDepth, flattened)
  }

  const keys = Object.keys(flattened)
  if (keys.length <= maxProperties) return flattened

  const dropped = keys.length - (maxProperties - 1)
  const output: Record<string, SafePayloadScalar> = {}
  for (const key of keys.slice(0, maxProperties - 1)) {
    output[key] = flattened[key]
  }
  output.truncated_properties = dropped
  return output
}

/**
 * Verdadeiro quando o valor é um sha256 válido — usado pela camada de
 * aprovação (PR 4) antes de comparar hashes.
 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_LENGTH.test(value)
}
