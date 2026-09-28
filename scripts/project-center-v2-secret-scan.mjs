#!/usr/bin/env node
// Secret scan do Project Center v2 (PR 7 do plano de implementação).
//
// Varre, por classe de risco, os dados que podem vazar credencial ou path de
// host em artefato versionado:
//
//   1. **diff** do range base...HEAD (linhas adicionadas), configurável por
//      `--base <ref>` / `--diff <ref>` / `PCV2_SCAN_DIFF`;
//   2. **arquivos de resposta, fixture e documentação** do escopo v2 (specs,
//      docs de contrato/QA/security/runbook, `src/server/project-center-v2`,
//      rotas v2, `src/lib/project-center-v2*` e os scripts do gate);
//   3. **capturas de log** do harness efémero (`qa-artifacts/pcv2-harness/**`
//      por padrão, ou `--capture <path>` / `PCV2_SCAN_CAPTURES`).
//
// Classes duras (FAIL): chave privada, PAT do GitHub, JWT completo, service
// key, DSN/URI com credencial, atribuição de senha, token `sref_` integral,
// `Bearer` com material e path absoluto de host fora das citações históricas
// já declaradas. Cada classe é reportada com valor **mascarado** — o relatório
// nunca reproduz o material encontrado.
//
// Saída: JSON com `verdict` (PASS/FAIL), `counters`, `findings[]` (com
// `severity`), `sources`. Exit code 0 = PASS, 1 = FAIL, 2 = uso inválido.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const REPO_ROOT = process.cwd()
const DEFAULT_BASE = 'project-center-v2/base-20260811'
const DEFAULT_CAPTURE_DIRS = ['qa-artifacts/pcv2-harness']

const SCANNED_DIRS = [
  'docs/adr',
  'docs/design',
  'docs/plans',
  'docs/qa',
  'docs/runbooks',
  'docs/security',
  'specs',
  'src/server/project-center-v2',
  'src/routes/api/project-center',
]
const SCANNED_FILE_PATTERNS = [
  /^src\/lib\/project-center-v2-[\w.-]+$/,
  /^scripts\/project-center-v2-[\w.-]+$/,
  /^package\.json$/,
]

const USAGE = `Uso: node scripts/project-center-v2-secret-scan.mjs [opções]

Opções:
  --base <ref>       Base do diff (default: ${DEFAULT_BASE}).
  --diff <ref>       Igual a --base, mas com o range ref...HEAD explícito.
  --capture <path>   Arquivo ou diretório de captura de log (repetível).
  --no-diff          Não varre o diff.
  --json             Emite apenas o JSON.
  -h, --help         Mostra esta ajuda.

Também aceito via env: PCV2_SCAN_DIFF, PCV2_SCAN_CAPTURES (separados por ':').
Saída: JSON com verdict PASS/FAIL, counters e findings[].`

// ---------------------------------------------------------------------------
// Padrões: monta-os em runtime para que o próprio scanner não contenha um
// literal que pareça segredo (mesmo princípio da redaction do PR 1).
// ---------------------------------------------------------------------------

const PRIVATE_KEY = new RegExp(
  ['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' '),
)
const PAT_GITHUB = new RegExp(`\\bgh${'[pousr]'}_[A-Za-z0-9]{30,}\\b`)
const JWT = new RegExp(
  `\\b${['e', 'y', 'J'].join('')}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`,
)
const SERVICE_KEY = new RegExp(
  `\\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\\b|\\bSUPABASE_SERVICE_ROLE_KEY\\s*[:=]\\s*["']?[A-Za-z0-9._-]{30,}`,
)
const DSN_WITH_CREDENTIAL = new RegExp(
  `\\b(?:postgres(?:ql)?|cockroachdb|mysql|mariadb|mongodb|redis|rediss|sqlserver|mssql):\\/\\/[^\\s:@/]+:[^\\s@/]+@[^\\s/]+`,
)
const PASSWORD_ASSIGNMENT = new RegExp(
  `\\b(?:password|passwd|pwd|senha|secret_key|api_key)\\s*[:=]\\s*["']([^"']{8,})["']`,
  'i',
)
const BEARER_TOKEN = new RegExp(`\\bBearer\\s+[A-Za-z0-9._-]{20,}`)
const SECRET_REF_INTEGRAL = new RegExp(
  `\\b${['s', 'r', 'e', 'f'].join('')}_(?!REDACTED_)[A-Za-z0-9_-]{43,128}\\b`,
)
const ABSOLUTE_PATH = new RegExp(
  `(?<![\\w.-])\\/(?:home|root|Users|var|etc|srv|opt|mnt|usr|tmp)\\/[A-Za-z0-9._@/-]{2,}`,
)
const WINDOWS_PATH = new RegExp(`\\b[A-Za-z]:\\\\[A-Za-z0-9._\\\\-]{3,}`)

const MASK_TOKENS = new RegExp(
  `^(?:\\*{3,}|\\[REDACTED\\]|\\[REDACTED_PATH\\]|<[A-Za-z0-9_-]+>|redacted|placeholder|synthetic|example|dummy|changeme)$`,
  'i',
)
const SECRET_REF_MASK_LITERAL =
  'sref_REDACTED_REDACTED_REDACTED_REDACTED_REDACTED'

/** Classes de achado. `critical` reprova o gate; `warn` fica registrado. */
const CLASSES = [
  { id: 'private_key', pattern: PRIVATE_KEY, severity: 'critical' },
  { id: 'pat_github', pattern: PAT_GITHUB, severity: 'critical' },
  { id: 'jwt_completo', pattern: JWT, severity: 'critical' },
  { id: 'service_key', pattern: SERVICE_KEY, severity: 'critical' },
  {
    id: 'dsn_com_credencial',
    pattern: DSN_WITH_CREDENTIAL,
    severity: 'critical',
    classify: (match) => {
      const userInfo = match.split('://')[1]?.split('@')[0] ?? ''
      const password = userInfo.slice(userInfo.indexOf(':') + 1)
      return MASK_TOKENS.test(password) ? 'fixture_sintetica' : 'critical'
    },
  },
  {
    id: 'atribuicao_de_senha',
    pattern: PASSWORD_ASSIGNMENT,
    severity: 'critical',
    classify: (match, groups) => {
      const value = groups?.[1] ?? ''
      return MASK_TOKENS.test(value) ? 'fixture_sintetica' : 'critical'
    },
  },
  { id: 'bearer_token', pattern: BEARER_TOKEN, severity: 'critical' },
  {
    id: 'sref_integral',
    pattern: SECRET_REF_INTEGRAL,
    severity: 'critical',
    classify: (match) =>
      match.includes(SECRET_REF_MASK_LITERAL) ? 'mascara_neutra' : 'critical',
  },
  { id: 'path_absoluto', pattern: ABSOLUTE_PATH, severity: 'critical' },
  { id: 'path_windows', pattern: WINDOWS_PATH, severity: 'critical' },
]

/**
 * Citações históricas de evidência já declaradas no parecer de discovery:
 * o path absoluto aparece como registro de auditoria de achado corrigido, não
 * como credencial, instrução operacional ou implementação (§9.1/P3-02 do doc
 * de QA de discovery).
 */
const HISTORICAL_EVIDENCE_DOCS = [
  'docs/qa/project-center-v2-discovery-review.md',
  'docs/qa/project-center-v2-final-gate.md',
  'docs/security/project-center-v2-independent-review.md',
]

/**
 * Valores sintéticos documentados em **arquivos de teste**: fixtures que
 * existem exatamente para provar a recusa/redaction de DSN, path, token e JWT.
 * A regra só vale para `*.test.ts(x)` e só para valores com marcador sintético
 * conhecido (host de documentação/RFC 5737/RFC 2606, raiz de path canônica de
 * fixture, token com prefixo `tok-`/`test-`/`synthetic`). Qualquer outro valor
 * em arquivo de teste continua sendo achado crítico.
 */
const TEST_FILE_PATTERN = /\.test\.tsx?$/
const FIXTURE_HOSTS = new Set([
  'host',
  'h',
  'db.interno',
  'interno',
  'localhost',
  '127.0.0.1',
  '10.0.0.1',
  '10.0.0.7',
  '192.0.2.10',
  '198.51.100.7',
  '203.0.113.9',
  'example.com',
])
const FIXTURE_PATHS = [
  '/etc/passwd',
  '/var/lib/postgresql',
  '/var/lib/backups',
  '/var/lib/dump',
  '/var/backups',
  '/srv/projetos',
  '/usr/bin/psql',
]
const FIXTURE_BEARER =
  /^Bearer\s+(?:tok|test|synthetic|fixture|scope)[A-Za-z0-9._-]*$/
const FIXTURE_PASSWORD =
  /^(?:\$\{[A-Z_]+\}|p|senha|credencial|password|passwd|secret|token|value|synthetic[-_]?password|sup3rsecret|canario|canary)$/i
/**
 * O próprio scanner declara o catálogo de padrões e as listas de paths
 * sintéticos/proibidos: as ocorrências nessas linhas são a definição do
 * detector, não um vazamento (arquivo revisado neste gate).
 */
const SCANNER_SELF_PATH = 'scripts/project-center-v2-secret-scan.mjs'

/**
 * O harness efémero declara dois paths internos deliberados, nenhum deles de
 * host de produção: o alvo de montagem dentro do container pinado
 * (`/var/lib/postgresql/data`, exigido pela imagem `postgres`) e a sonda
 * negativa que o guard **tem** de recusar (`/var/lib/postgresql/harness`).
 * Qualquer outro path absoluto no mesmo arquivo continua sendo achado crítico.
 */
const HARNESS_INTERNAL_PATHS = new Map([
  [
    'scripts/project-center-v2-real-harness.mts',
    ['/var/lib/postgresql/data', '/var/lib/postgresql/harness'],
  ],
])

/**
 * Baseline de linhas revisadas manualmente (path + linha + classe), cada uma
 * com justificativa. Serve para valores que **não** são fixture de teste mas
 * são deliberados: constante de denylist, catálogo de redaction e citação
 * histórica de parecer. Linha nova sem justificativa continua reprovando.
 */
const LINE_ALLOWLIST = [
  {
    path: 'src/server/project-center-v2/harness-guard.ts',
    line: 41,
    class: 'path_absoluto',
    kind: 'constante_de_denylist',
    note: '/var/lib/postgresql é segmento proibido declarado em HARNESS_FORBIDDEN_PATH_SEGMENTS',
  },
  {
    path: 'src/server/project-center-v2/redaction.ts',
    line: 132,
    class: 'path_windows',
    kind: 'catalogo_de_redaction',
    note: 'comentário que descreve o padrão de path absoluto Windows do catálogo',
  },
  {
    path: 'src/server/project-center-v2/redaction-canary.test.ts',
    line: 61,
    class: 'jwt_completo',
    kind: 'fixture_sintetica',
    note: 'JWT canário P3-03 (header/payload sintéticos) usado para provar a redaction',
  },
]

function allowlisted(relPath, line, classe) {
  const entry = LINE_ALLOWLIST.find(
    (candidate) =>
      candidate.path === relPath &&
      candidate.line === line &&
      candidate.class === classe.id,
  )
  return entry ?? null
}

/** Marcadores sintéticos aceitos em arquivo de teste, por classe. */
function syntheticFixture(classe, match, relPath) {
  if (!TEST_FILE_PATTERN.test(relPath)) return false
  if (classe.id === 'dsn_com_credencial') {
    const host = match.split('@')[1]?.split('/')[0]?.split(':')[0] ?? ''
    const userInfo = match.split('://')[1]?.split('@')[0] ?? ''
    const password = userInfo.slice(userInfo.indexOf(':') + 1)
    return FIXTURE_HOSTS.has(host) && FIXTURE_PASSWORD.test(password)
  }
  if (classe.id === 'path_absoluto' || classe.id === 'path_windows') {
    return FIXTURE_PATHS.some((prefix) => match.startsWith(prefix))
  }
  if (classe.id === 'bearer_token') return FIXTURE_BEARER.test(match)
  return false
}

function classifyHit(classe, match, groups, relPath, line) {
  if (classe.classify !== undefined) {
    const verdict = classe.classify(match, groups)
    if (verdict !== 'critical') {
      return { severity: 'warn', kind: verdict }
    }
  }
  if (relPath === SCANNER_SELF_PATH && classe.id.startsWith('path_')) {
    return { severity: 'warn', kind: 'catalogo_do_scanner' }
  }
  const harnessPaths = HARNESS_INTERNAL_PATHS.get(relPath)
  if (
    harnessPaths !== undefined &&
    classe.id.startsWith('path_') &&
    harnessPaths.some((allowedPath) => match.startsWith(allowedPath))
  ) {
    return { severity: 'warn', kind: 'alvo_interno_do_harness' }
  }
  if (syntheticFixture(classe, match, relPath)) {
    return { severity: 'warn', kind: 'fixture_sintetica_de_teste' }
  }
  const allowed = allowlisted(relPath, line, classe)
  if (allowed !== null) {
    return { severity: 'warn', kind: allowed.kind }
  }
  if (
    classe.id.startsWith('path_') &&
    HISTORICAL_EVIDENCE_DOCS.includes(relPath)
  ) {
    return { severity: 'warn', kind: 'citacao_historica_de_evidencia' }
  }
  return { severity: 'critical', kind: 'segredo_ou_path_vivo' }
}

// ---------------------------------------------------------------------------
// Alvos
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    base: process.env.PCV2_SCAN_DIFF ?? DEFAULT_BASE,
    scansDiff: true,
    captures: [],
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base' || arg === '--diff') options.base = argv[++index]
    else if (arg === '--capture') options.captures.push(argv[++index])
    else if (arg === '--no-diff') options.scansDiff = false
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else {
      process.stderr.write(`opcao desconhecida: ${arg}\n${USAGE}\n`)
      process.exit(2)
    }
  }
  const envCaptures = (process.env.PCV2_SCAN_CAPTURES ?? '')
    .split(':')
    .filter((entry) => entry.length > 0)
  options.captures.push(...envCaptures)
  if (options.captures.length === 0) {
    options.captures.push(
      ...DEFAULT_CAPTURE_DIRS.filter((dir) => existsSync(join(REPO_ROOT, dir))),
    )
  }
  return options
}

function listFiles(dir) {
  const absolute = join(REPO_ROOT, dir)
  if (!existsSync(absolute)) return []
  const out = []
  for (const entry of readdirSync(absolute)) {
    const rel = join(dir, entry)
    const abs = join(REPO_ROOT, rel)
    if (statSync(abs).isDirectory()) out.push(...listFiles(rel))
    else out.push(rel)
  }
  return out
}

function scopedFiles() {
  const out = new Set()
  for (const dir of SCANNED_DIRS) for (const rel of listFiles(dir)) out.add(rel)
  for (const dir of ['src/lib', 'scripts', '.']) {
    const absolute = join(REPO_ROOT, dir)
    if (!existsSync(absolute)) continue
    for (const entry of readdirSync(absolute)) {
      const abs = join(absolute, entry)
      if (!statSync(abs).isFile()) continue
      const rel = relative(REPO_ROOT, abs)
      if (SCANNED_FILE_PATTERNS.some((pattern) => pattern.test(rel)))
        out.add(rel)
    }
  }
  return [...out].sort()
}

function revExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/** Resolve a base do diff aceitando ref local ou remota (`je4n/`). */
function resolveBase(base) {
  for (const candidate of [base, `je4n/${base}`, `origin/${base}`]) {
    if (revExists(candidate)) return candidate
  }
  return base
}

function diffLines(requestedBase) {
  const base = resolveBase(requestedBase)
  let raw = ''
  try {
    raw = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', `${base}...HEAD`],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (error) {
    process.stderr.write(
      `falha ao ler o diff de ${base}...HEAD: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(2)
  }
  const added = []
  let currentFile = null
  let newLine = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) currentFile = line.slice(6)
    else if (line.startsWith('@@')) {
      const match = /\+(\d+)/.exec(line)
      newLine = match === null ? 0 : Number(match[1])
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({
        file: currentFile ?? '(diff)',
        text: line.slice(1),
        line: newLine,
      })
      newLine += 1
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      newLine += 1
    }
  }
  return { added, raw_bytes: raw.length, resolved_ref: base }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2))
const findings = []

function mask(match) {
  const visible = match.slice(0, 4)
  return `${visible}${'*'.repeat(Math.max(3, Math.min(12, match.length - visible.length)))}`
}

function scanText(relPath, text, lineOffsetLabel) {
  const lines = text.split('\n')
  const allowlistPath = relPath.replace(/^diff:/, '')
  lines.forEach((line, index) => {
    // Shebang de script é `/usr/bin/env`, não path de host.
    if (line.startsWith('#!')) return
    const lineNumber = lineOffsetLabel ?? index + 1
    for (const classe of CLASSES) {
      // Flag global: sem ela `exec` devolveria sempre o primeiro match.
      const flags = classe.pattern.flags.includes('g')
        ? classe.pattern.flags
        : `${classe.pattern.flags}g`
      const regex = new RegExp(classe.pattern.source, flags)
      for (const match of line.matchAll(regex)) {
        const verdict = classifyHit(
          classe,
          match[0],
          match,
          allowlistPath,
          lineNumber,
        )
        findings.push({
          class: classe.id,
          severity: verdict.severity,
          kind: verdict.kind,
          path: relPath,
          line: lineNumber,
          excerpt: mask(match[0]),
        })
      }
    }
  })
}

const diff = options.scansDiff ? diffLines(options.base) : null
if (diff !== null) {
  for (const entry of diff.added) {
    scanText(`diff:${entry.file}`, entry.text, entry.line)
  }
}

const files = scopedFiles()
for (const rel of files) {
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
  scanText(rel, text)
}

const captureFiles = []
for (const capture of options.captures) {
  const absolute = join(REPO_ROOT, capture)
  if (!existsSync(absolute)) continue
  if (statSync(absolute).isDirectory()) {
    for (const rel of listFiles(capture)) captureFiles.push(rel)
  } else {
    captureFiles.push(capture)
  }
}
for (const rel of captureFiles) {
  if (rel.endsWith('.png') || rel.endsWith('.jpg') || rel.endsWith('.gz'))
    continue
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
  scanText(rel, text)
}

const critical = findings.filter((entry) => entry.severity === 'critical')
const warn = findings.filter((entry) => entry.severity === 'warn')
const allowlistUsed = LINE_ALLOWLIST.filter((entry) =>
  findings.some(
    (finding) =>
      finding.path.replace(/^diff:/, '') === entry.path &&
      finding.line === entry.line &&
      finding.class === entry.class,
  ),
)
const allowlistStale = LINE_ALLOWLIST.filter(
  (entry) => !allowlistUsed.includes(entry),
).map((entry) => `${entry.path}:${entry.line}:${entry.class}`)
const payload = {
  gate: 'project-center-v2-secret-scan',
  version: '1.0.0',
  generated_at: new Date().toISOString(),
  verdict: critical.length === 0 ? 'PASS' : 'FAIL',
  diff:
    diff === null
      ? null
      : { ref: options.base, added_lines: diff.added.length },
  scoped_files: files.length,
  capture_files: captureFiles.length,
  allowlist: {
    entries: LINE_ALLOWLIST.length,
    used: allowlistUsed.length,
    stale: allowlistStale,
  },
  counters: {
    critical: critical.length,
    warn: warn.length,
    classes: Object.fromEntries(
      CLASSES.map((classe) => [
        classe.id,
        findings.filter((entry) => entry.class === classe.id).length,
      ]),
    ),
  },
  findings: [...critical, ...warn].slice(0, 200),
}
if (!options.json) {
  process.stdout.write(
    `diff=${diff === null ? 'off' : `${options.base}...HEAD (${diff.added.length} linhas adicionadas)`} arquivos=${files.length} capturas=${captureFiles.length}\n`,
  )
  if (allowlistStale.length > 0) {
    process.stdout.write(
      `warn allowlist obsoleta: ${allowlistStale.join(', ')}\n`,
    )
  }
  for (const entry of payload.findings) {
    process.stdout.write(
      `${entry.severity === 'critical' ? 'FAIL' : 'warn'} ${entry.class} [${entry.kind}] ${entry.path}:${entry.line} ${entry.excerpt}\n`,
    )
  }
  process.stdout.write(
    `verdict=${payload.verdict} critical=${critical.length} warn=${warn.length}\n`,
  )
}
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
process.exit(critical.length === 0 ? 0 : 1)
