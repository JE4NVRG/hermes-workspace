#!/usr/bin/env node
// Gate contratual do Project Center v2 (PR 7 do plano de implementação).
//
// Valida, sem tocar rede/banco/processo:
//   1. OpenAPI 3.1 e resolução de todos os `$ref` locais;
//   2. `operationId` único por operação, path params declarados e coerentes;
//   3. superfície de rotas: cada operação do contrato tem arquivo de rota real
//      (`src/routes/api/project-center/v2/**`) com o mesmo `OPERATION_ID` e o
//      mesmo método HTTP — e nenhuma rota extra fora do contrato;
//   4. máquina de estados: enum × `x-allowed-transitions` × `x-terminal-states`;
//   5. RBAC: `default: deny`, um único dono por `operationId`, escopos cobertos
//      pelas roles e actor claims canônicas;
//   6. mutações idempotentes: todo método mutante exige `Idempotency-Key`;
//   7. schemas discriminados: `discriminator.mapping` × variantes do `oneOf`;
//   8. existência dos artefatos referenciados (docs, spec, scripts, package);
//   9. projeções do contrato canônico nos docs (PRD/ADR/spec/threat/UX/plano) e
//      as referências cruzadas exigidas pelo achado QA P3-03;
//  10. scripts scoped do `package.json` apontando para arquivos existentes;
//  11. nenhum caminho de código liga as flags por padrão.
//
// Saída: JSON com `verdict` (GO/NO-GO), `checks[]`, `failures[]`, `summary`.
// Exit code 0 = GO, 1 = NO-GO, 2 = uso/ambiente inválido.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import YAML from 'yaml'

const REPO_ROOT = process.cwd()
const SPEC_PATH = 'specs/contracts/project-center-v2.openapi.yaml'
const ROUTES_ROOT = 'src/routes/api/project-center/v2'
const ROUTE_PREFIX = '/api/project-center/v2'
const MUTATING_METHODS = ['post', 'put', 'patch', 'delete']
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete']

const FLAG_NAMES = [
  'PROJECT_CENTER_V2_ENABLED',
  'PROJECT_CENTER_V2_WORKER_ENABLED',
]

const CANONICAL_CONTRACT = 'specs/contracts/project-center-v2.openapi.yaml'

/** Artefatos que o gate exige no head revisado. */
const REQUIRED_ARTIFACTS = [
  CANONICAL_CONTRACT,
  'specs/features/project-center-v2.spec.md',
  'docs/PRD-project-center-v2.md',
  'docs/adr/0001-project-center-v2-control-plane.md',
  'docs/design/project-center-v2-ux.md',
  'docs/security/project-center-v2-threat-model.md',
  'docs/security/project-center-v2-independent-review.md',
  'docs/plans/project-center-v2-implementation-plan.md',
  'docs/qa/project-center-v2-discovery-review.md',
  'docs/qa/project-center-v2-final-gate.md',
  'docs/runbooks/project-center-v2-deploy-and-rollback.md',
  'scripts/project-center-v2-discovery-retest.mjs',
  'scripts/project-center-v2-contract-check.mjs',
  'scripts/project-center-v2-secret-scan.mjs',
  'scripts/project-center-v2-real-harness.mts',
  'src/server/project-center-v2/harness-guard.ts',
  'src/server/project-center-v2/feature-flags.ts',
  'src/server/project-center-v2/worker.ts',
  'src/server/project-center-v2/executors/action-executor.ts',
  'src/server/project-center-v2/executors/postgresql-executor.ts',
  'src/server/project-center-v2/executors/supabase-executor.ts',
  'src/server/project-center-v2/backup-service.ts',
  'src/server/project-center-v2/restore-verifier.ts',
  'src/server/project-center-v2/rollback-service.ts',
]

/** Projeções do contrato: path → trechos obrigatórios (docs de rastreabilidade). */
const PROJECTION_REQUIREMENTS = {
  'docs/PRD-project-center-v2.md': [CANONICAL_CONTRACT],
  'docs/adr/0001-project-center-v2-control-plane.md': [CANONICAL_CONTRACT],
  'specs/features/project-center-v2.spec.md': [CANONICAL_CONTRACT],
  'docs/security/project-center-v2-threat-model.md': [CANONICAL_CONTRACT],
  'docs/design/project-center-v2-ux.md': [CANONICAL_CONTRACT],
}
/** Referências cruzadas P3-03: doc → artefatos que precisam ser citados. */
const CROSS_REFERENCE_REQUIREMENTS = {
  'docs/adr/0001-project-center-v2-control-plane.md': [
    'docs/plans/project-center-v2-implementation-plan.md',
    'docs/qa/project-center-v2-final-gate.md',
  ],
  'docs/design/project-center-v2-ux.md': [
    'docs/plans/project-center-v2-implementation-plan.md',
    'docs/qa/project-center-v2-final-gate.md',
  ],
  'docs/plans/project-center-v2-implementation-plan.md': [
    'docs/qa/project-center-v2-final-gate.md',
    'docs/runbooks/project-center-v2-deploy-and-rollback.md',
    'scripts/project-center-v2-real-harness.mts',
  ],
}

const SCOPED_SCRIPTS = {
  'project-center:v2:contract':
    'node scripts/project-center-v2-contract-check.mjs',
  'project-center:v2:scan': 'node scripts/project-center-v2-secret-scan.mjs',
}

const USAGE = `Uso: node scripts/project-center-v2-contract-check.mjs [opções]

Opções:
  --json          Emite apenas o JSON (sem resumo legível).
  -h, --help      Mostra esta ajuda.

Saída: JSON com verdict GO/NO-GO, checks[], failures[].
Exit code 0 = GO, 1 = NO-GO, 2 = uso inválido.`

const checks = []
const failures = []

function check(id, name, ok, detail) {
  checks.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failures.push({ id, name, detail })
  return ok
}

function readText(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
}

function listFiles(dir, predicate) {
  const absolute = join(REPO_ROOT, dir)
  if (!existsSync(absolute)) return []
  const out = []
  for (const entry of readdirSync(absolute)) {
    const rel = join(dir, entry)
    const abs = join(REPO_ROOT, rel)
    if (statSync(abs).isDirectory()) out.push(...listFiles(rel, predicate))
    else if (predicate === undefined || predicate(rel)) out.push(rel)
  }
  return out
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

let spec = null
let specError = null
try {
  spec = YAML.parse(readText(SPEC_PATH))
} catch (error) {
  specError = error instanceof Error ? error.message : String(error)
}

if (
  !check(
    'spec-parse',
    'OpenAPI parseia como YAML',
    spec !== null,
    specError ?? `${SPEC_PATH} carregado`,
  )
) {
  report()
}

check(
  'openapi-3.1',
  'Documento é OpenAPI 3.1.x',
  typeof spec.openapi === 'string' && spec.openapi.startsWith('3.1'),
  `openapi=${String(spec.openapi)}`,
)

function resolvePointer(doc, ref) {
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let current = doc
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function collectRefs(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => {
      collectRefs(entry, `${path}[${index}]`, out)
    })
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        out.push({ path, ref: value })
        continue
      }
      collectRefs(value, `${path}.${key}`, out)
    }
  }
  return out
}

const allRefs = collectRefs(spec, '', [])
const localRefs = allRefs.filter((entry) => entry.ref.startsWith('#/'))
const externalRefs = allRefs.filter((entry) => !entry.ref.startsWith('#/'))
const brokenRefs = localRefs.filter(
  (entry) => resolvePointer(spec, entry.ref) === undefined,
)
check(
  'refs-resolvidos',
  'Todos os $ref locais resolvem',
  brokenRefs.length === 0 && externalRefs.length === 0,
  `${localRefs.length} refs locais, ${brokenRefs.length} nao resolvidas, ${externalRefs.length} refs externas${
    brokenRefs.length === 0
      ? ''
      : `: ${brokenRefs
          .slice(0, 5)
          .map((entry) => `${entry.path}->${entry.ref}`)
          .join(', ')}`
  }`,
)

function deref(node) {
  if (
    node === null ||
    typeof node !== 'object' ||
    typeof node.$ref !== 'string'
  )
    return node
  return resolvePointer(spec, node.$ref)
}

const paths = spec.paths ?? {}
const operations = []
for (const [specPath, pathItem] of Object.entries(paths)) {
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method]
    if (operation === undefined) continue
    operations.push({ specPath, method, operation })
  }
}

const operationIds = operations.map((entry) => entry.operation.operationId)
const duplicateIds = operationIds.filter(
  (id, index) => operationIds.indexOf(id) !== index,
)
check(
  'operation-ids',
  'operationId unico e presente em toda operacao',
  operationIds.length === 9 &&
    operationIds.every((id) => typeof id === 'string' && id.length > 0) &&
    duplicateIds.length === 0,
  `${operations.length} operacoes, ${new Set(operationIds).size} operationIds unicos, duplicados=[${duplicateIds.join(', ')}]`,
)

function parametersOf(specPath, pathItem, operation) {
  const list = [
    ...(pathItem.parameters ?? []),
    ...(operation.parameters ?? []),
  ].map((entry) => deref(entry))
  return list.filter((entry) => entry !== undefined)
}

const pathParamIssues = []
for (const [specPath, pathItem] of Object.entries(paths)) {
  const templateParams = [...specPath.matchAll(/\{([^}]+)\}/g)].map(
    (match) => match[1],
  )
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method]
    if (operation === undefined) continue
    const declared = parametersOf(specPath, pathItem, operation).filter(
      (param) => param.in === 'path',
    )
    const declaredNames = declared.map((param) => param.name)
    for (const name of templateParams) {
      const param = declared.find((entry) => entry.name === name)
      if (param === undefined) {
        pathParamIssues.push(
          `${method.toUpperCase()} ${specPath}: {${name}} sem parametro`,
        )
        continue
      }
      if (param.required !== true) {
        pathParamIssues.push(
          `${method.toUpperCase()} ${specPath}: {${name}} nao marcado required`,
        )
      }
      if (param.schema?.type === undefined) {
        pathParamIssues.push(
          `${method.toUpperCase()} ${specPath}: {${name}} sem schema tipado`,
        )
      }
    }
    for (const name of declaredNames) {
      if (!templateParams.includes(name)) {
        pathParamIssues.push(
          `${method.toUpperCase()} ${specPath}: parametro path ${name} fora do template`,
        )
      }
    }
  }
}
check(
  'path-params',
  'Path params declarados e coerentes com o template',
  pathParamIssues.length === 0,
  pathParamIssues.length === 0
    ? `${operations.length} operacoes com path params coerentes`
    : pathParamIssues.slice(0, 6).join(' | '),
)

// ---------------------------------------------------------------------------
// Superficie de rotas
// ---------------------------------------------------------------------------

function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase())
}

function expectedRoutePath(specPath) {
  const converted = specPath.replace(
    /\{([^}]+)\}/g,
    (_match, name) => `$${camel(name)}`,
  )
  return `${ROUTE_PREFIX}${converted}`
}

function routeSurface() {
  const files = listFiles(ROUTES_ROOT, (rel) => rel.endsWith('.ts'))
  return files
    .filter((rel) => !rel.endsWith('.test.ts'))
    .map((rel) => {
      const source = readText(rel)
      const operationId =
        /export const OPERATION_ID = '([^']+)'/.exec(source)?.[1] ?? null
      const routePath =
        /createFileRoute\(\s*'([^']+)'/.exec(source)?.[1] ?? null
      const methods = [
        ...source.matchAll(/^\s{4,}(GET|POST|PUT|PATCH|DELETE):/gm),
      ].map((match) => match[1].toLowerCase())
      return { file: rel, operationId, routePath, methods: new Set(methods) }
    })
}

const surface = routeSurface()
// Arquivos do diretório que não exportam `Route` são módulos de composição
// (barrels), não superfície HTTP: o gerador do router os ignora.
const routeFiles = surface.filter((route) => route.routePath !== null)
const routeIssues = []
const usedRouteFiles = new Set()

for (const entry of operations) {
  const wanted = expectedRoutePath(entry.specPath)
  const candidates = routeFiles.filter((route) => route.routePath === wanted)
  if (candidates.length !== 1) {
    routeIssues.push(
      `${entry.operation.operationId}: ${candidates.length} arquivos de rota para ${wanted}`,
    )
    continue
  }
  const route = candidates[0]
  usedRouteFiles.add(route.file)
  if (route.operationId !== entry.operation.operationId) {
    routeIssues.push(
      `${route.file}: OPERATION_ID=${route.operationId} != ${entry.operation.operationId}`,
    )
  }
  if (!route.methods.has(entry.method)) {
    routeIssues.push(
      `${route.file}: metodo ${entry.method.toUpperCase()} ausente nos handlers`,
    )
  }
}
for (const route of routeFiles) {
  if (usedRouteFiles.has(route.file)) continue
  routeIssues.push(`${route.file}: rota ${route.routePath} fora do contrato`)
}
check(
  'route-surface',
  'Cada operacao do contrato tem rota real com o mesmo OPERATION_ID',
  routeIssues.length === 0 && routeFiles.length === operations.length,
  routeIssues.length === 0
    ? `${operations.length} operacoes mapeadas em ${usedRouteFiles.size} arquivos de rota (${surface.length - routeFiles.length} modulos de composicao)`
    : routeIssues.slice(0, 6).join(' | '),
)

// ---------------------------------------------------------------------------
// Maquina de estados
// ---------------------------------------------------------------------------

const stateSchema = spec.components?.schemas?.OperationState ?? {}
const states = stateSchema.enum ?? []
const transitions = stateSchema['x-allowed-transitions'] ?? {}
const terminal = stateSchema['x-terminal-states'] ?? []
const transitionIssues = []

const transitionKeys = Object.keys(transitions)
for (const state of states) {
  if (!transitionKeys.includes(state)) {
    transitionIssues.push(`${state} sem entrada em x-allowed-transitions`)
  }
}
for (const key of transitionKeys) {
  const targets = transitions[key] ?? []
  if (!states.includes(key)) {
    transitionIssues.push(`${key} transiciona mas nao esta no enum`)
  }
  if (!Array.isArray(targets)) {
    transitionIssues.push(`${key} com transicoes nao-lista`)
    continue
  }
  if (new Set(targets).size !== targets.length) {
    transitionIssues.push(`${key} com transicao duplicada`)
  }
  for (const target of targets) {
    if (!states.includes(target)) {
      transitionIssues.push(`${key} -> ${target} fora do enum`)
    }
  }
}
for (const state of terminal) {
  if ((transitions[state] ?? []).length > 0) {
    transitionIssues.push(`${state} terminal com saida declarada`)
  }
}
const nonTerminalWithoutExit = states.filter(
  (state) =>
    !terminal.includes(state) && (transitions[state] ?? []).length === 0,
)
for (const state of nonTerminalWithoutExit) {
  transitionIssues.push(`${state} nao-terminal sem aresta de saida`)
}
check(
  'transicoes',
  'Enum, arestas e terminais da maquina de estados coerentes',
  states.length === 15 &&
    terminal.length === 5 &&
    transitionIssues.length === 0,
  transitionIssues.length === 0
    ? `${states.length} estados, ${transitionKeys.reduce((total, key) => total + (transitions[key] ?? []).length, 0)} arestas, ${terminal.length} terminais`
    : transitionIssues.slice(0, 6).join(' | '),
)

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

const rbac = spec['x-rbac-policy'] ?? {}
const roles = rbac.roles ?? {}
const rbacIssues = []
const rolesByOperation = new Map()
for (const [roleName, role] of Object.entries(roles)) {
  for (const operationId of role.operations ?? []) {
    if (!operationIds.includes(operationId)) {
      rbacIssues.push(`${roleName}: operationId inexistente ${operationId}`)
      continue
    }
    rolesByOperation.set(operationId, [
      ...(rolesByOperation.get(operationId) ?? []),
      roleName,
    ])
  }
}
for (const entry of operations) {
  const operationId = entry.operation.operationId
  const scopes = entry.operation['x-required-scopes']
  if (!Array.isArray(scopes) || scopes.length === 0) {
    rbacIssues.push(`${operationId}: sem x-required-scopes`)
    continue
  }
  const owners = rolesByOperation.get(operationId) ?? []
  if (owners.length !== 1) {
    rbacIssues.push(`${operationId}: ${owners.length} roles donas`)
    continue
  }
  const role = roles[owners[0]]
  for (const scope of scopes) {
    if (!(role.scopes ?? []).includes(scope)) {
      rbacIssues.push(
        `${owners[0]} nao tem ${scope} exigido por ${operationId}`,
      )
    }
  }
}
check(
  'rbac-default-deny',
  'RBAC com default deny, um dono por operacao e escopos cobertos',
  rbac.default === 'deny' &&
    rbacIssues.length === 0 &&
    ['human', 'agent', 'worker'].every((actorType) =>
      (rbac['actor-claims']?.allowed_values ?? []).includes(actorType),
    ) &&
    ['subject', 'actor_type'].every((claim) =>
      (rbac['actor-claims']?.required ?? []).includes(claim),
    ),
  rbacIssues.length === 0
    ? `default=${String(rbac.default)}, ${Object.keys(roles).length} roles, ${rolesByOperation.size}/${operations.length} operacoes com dono unico`
    : rbacIssues.slice(0, 6).join(' | '),
)

// ---------------------------------------------------------------------------
// Mutações idempotentes + schemas discriminados
// ---------------------------------------------------------------------------

const mutating = operations.filter((entry) =>
  MUTATING_METHODS.includes(entry.method),
)
const nonIdempotent = []
for (const entry of mutating) {
  const params = parametersOf(
    entry.specPath,
    paths[entry.specPath],
    entry.operation,
  )
  const idempotency = params.find(
    (param) => param.name === 'Idempotency-Key' && param.in === 'header',
  )
  if (idempotency === undefined || idempotency.required !== true) {
    nonIdempotent.push(
      `${entry.method.toUpperCase()} ${entry.specPath} (${entry.operation.operationId})`,
    )
  }
}
check(
  'mutacoes-idempotentes',
  'Toda mutacao exige Idempotency-Key',
  nonIdempotent.length === 0 && mutating.length === 7,
  nonIdempotent.length === 0
    ? `${mutating.length}/${mutating.length} mutacoes exigem Idempotency-Key`
    : `sem header: ${nonIdempotent.join(', ')}`,
)

const schemas = spec.components?.schemas ?? {}
const discriminated = Object.entries(schemas).filter(
  (entry) => Array.isArray(entry[1]?.oneOf) && entry[1]?.discriminator,
)
const discriminatorIssues = []
let discriminatedVariants = 0
for (const [schemaName, schema] of discriminated) {
  const property = schema.discriminator.propertyName
  const mapping = schema.discriminator.mapping ?? {}
  const variants = schema.oneOf.map((entry) => deref(entry))
  const mappedRefs = Object.values(mapping)
  const variantRefs = schema.oneOf
    .map((entry) => entry.$ref)
    .filter((ref) => typeof ref === 'string')
  discriminatedVariants += variants.length
  if (typeof property !== 'string' || property.length === 0) {
    discriminatorIssues.push(`${schemaName}: discriminator sem propertyName`)
    continue
  }
  if (mappedRefs.length !== variantRefs.length) {
    discriminatorIssues.push(
      `${schemaName}: ${mappedRefs.length} mappings para ${variantRefs.length} variantes`,
    )
  }
  for (const ref of variantRefs) {
    if (!mappedRefs.includes(ref)) {
      discriminatorIssues.push(`${schemaName}: variante ${ref} sem mapping`)
    }
  }
  for (const [key, ref] of Object.entries(mapping)) {
    const variant = deref({ $ref: ref })
    if (variant === undefined) {
      discriminatorIssues.push(
        `${schemaName}: mapping ${key} -> ref inexistente`,
      )
      continue
    }
    const propertySchema = variant.properties?.[property]
    const values =
      propertySchema?.enum ??
      (propertySchema?.const === undefined ? [] : [propertySchema.const])
    if (!values.includes(key)) {
      discriminatorIssues.push(
        `${schemaName}: mapping ${key} sem const/enum ${key} em ${ref}`,
      )
    }
    if (
      Array.isArray(variant.required) &&
      !variant.required.includes(property)
    ) {
      discriminatorIssues.push(`${schemaName}: ${ref} nao exige ${property}`)
    }
  }
}
check(
  'schemas-discriminados',
  'Schemas oneOf/discriminator com mapping completo e coerente',
  discriminated.length >= 2 && discriminatorIssues.length === 0,
  discriminatorIssues.length === 0
    ? `${discriminated.length} schemas discriminados, ${discriminatedVariants} variantes mapeadas`
    : discriminatorIssues.slice(0, 6).join(' | '),
)

// ---------------------------------------------------------------------------
// Artefatos, projeções, package.json e flags
// ---------------------------------------------------------------------------

const missingArtifacts = REQUIRED_ARTIFACTS.filter(
  (rel) => !existsSync(join(REPO_ROOT, rel)),
)
check(
  'artefatos-referenciados',
  'Todos os artefatos referenciados existem no head',
  missingArtifacts.length === 0,
  missingArtifacts.length === 0
    ? `${REQUIRED_ARTIFACTS.length} artefatos presentes`
    : `ausentes: ${missingArtifacts.join(', ')}`,
)

const projectionIssues = []
for (const [rel, required] of Object.entries(PROJECTION_REQUIREMENTS)) {
  const source = readText(rel)
  for (const needle of required) {
    if (!source.includes(needle)) {
      projectionIssues.push(`${rel} nao cita ${needle}`)
    }
  }
}
check(
  'projecoes-contrato',
  'PRD/ADR/spec/threat/UX projetam o contrato canonico',
  projectionIssues.length === 0,
  projectionIssues.length === 0
    ? `${Object.keys(PROJECTION_REQUIREMENTS).length} docs citam ${CANONICAL_CONTRACT}`
    : projectionIssues.join(' | '),
)

const crossIssues = []
for (const [rel, required] of Object.entries(CROSS_REFERENCE_REQUIREMENTS)) {
  const source = readText(rel)
  for (const needle of required) {
    if (!source.includes(needle)) {
      crossIssues.push(`${rel} nao cita ${needle}`)
    }
  }
}
check(
  'referencias-cruzadas-p3-03',
  'Referencias cruzadas do achado QA P3-03 presentes',
  crossIssues.length === 0,
  crossIssues.length === 0
    ? `${Object.keys(CROSS_REFERENCE_REQUIREMENTS).length} docs com referencias completas`
    : crossIssues.join(' | '),
)

const pkg = JSON.parse(readText('package.json'))
const scriptIssues = []
for (const [name, command] of Object.entries(SCOPED_SCRIPTS)) {
  const declared = pkg.scripts?.[name]
  if (declared !== command) {
    scriptIssues.push(`${name} = ${String(declared)}`)
    continue
  }
  const target = command.replace(/^node\s+/, '')
  if (!existsSync(join(REPO_ROOT, target))) {
    scriptIssues.push(`${name} aponta para ${target} ausente`)
  }
}
if (
  !String(pkg.scripts?.['project-center:v2:gate'] ?? '').includes(
    'project-center:v2:contract',
  )
) {
  scriptIssues.push('project-center:v2:gate nao encadeia o contract check')
}
if (
  !String(pkg.scripts?.['project-center:v2:gate'] ?? '').includes(
    'project-center:v2:scan',
  )
) {
  scriptIssues.push('project-center:v2:gate nao encadeia o secret scan')
}
check(
  'package-scripts',
  'Scripts scoped project-center:v2:* declarados e resolviveis',
  scriptIssues.length === 0,
  scriptIssues.length === 0
    ? `scripts: ${Object.keys(SCOPED_SCRIPTS).join(', ')}, project-center:v2:gate`
    : scriptIssues.join(' | '),
)

const liveSources = [
  ...listFiles('src/server/project-center-v2', (rel) => rel.endsWith('.ts')),
  ...listFiles('src/routes/api/project-center', (rel) => rel.endsWith('.ts')),
].filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx'))
const flagViolations = []
/** Remove comentários de bloco e de linha antes de procurar atribuição viva. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
for (const rel of liveSources) {
  const source = stripComments(readText(rel))
  for (const flag of FLAG_NAMES) {
    const enabled = new RegExp(`['"]?${flag}['"]?\\s*[:=]\\s*['"]?true`, 'i')
    if (enabled.test(source)) flagViolations.push(`${rel}: ${flag}=true`)
  }
}
check(
  'flags-desligadas',
  'Nenhum caminho de runtime liga as flags por padrao',
  flagViolations.length === 0,
  flagViolations.length === 0
    ? `${liveSources.length} arquivos de runtime sem atribuicao viva de ${FLAG_NAMES.join('/')}=true`
    : flagViolations.slice(0, 5).join(' | '),
)

report()

function report() {
  const passed = checks.filter((entry) => entry.status === 'PASS').length
  const payload = {
    gate: 'project-center-v2-contract-check',
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    ref: process.env.PCV2_CONTRACT_REF ?? 'HEAD',
    verdict: failures.length === 0 ? 'GO' : 'NO-GO',
    summary: `${passed}/${checks.length} checks PASS`,
    checks,
    failures,
  }
  if (!process.argv.includes('--json')) {
    for (const entry of checks) {
      process.stdout.write(
        `${entry.status === 'PASS' ? 'ok  ' : 'FAIL'} ${entry.id} — ${entry.name}: ${entry.detail}\n`,
      )
    }
    process.stdout.write(`\nverdict=${payload.verdict} ${payload.summary}\n`)
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}
