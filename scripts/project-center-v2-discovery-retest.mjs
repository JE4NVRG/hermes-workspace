import { execFileSync } from 'node:child_process'
import process from 'node:process'
import YAML from 'yaml'

const refs = {
  base: 'je4n/project-center-v2/base-20260811',
  prd: 'je4n/project-center-v2/prd',
  spec: 'je4n/project-center-v2/spec',
  security: 'je4n/project-center-v2/security',
  ux: 'je4n/project-center-v2/ux',
}

const artifacts = {
  prd: [refs.prd, 'docs/PRD-project-center-v2.md'],
  adr: [refs.spec, 'docs/adr/0001-project-center-v2-control-plane.md'],
  openapi: [refs.spec, 'specs/contracts/project-center-v2.openapi.yaml'],
  spec: [refs.spec, 'specs/features/project-center-v2.spec.md'],
  security: [refs.security, 'docs/security/project-center-v2-threat-model.md'],
  ux: [refs.ux, 'docs/design/project-center-v2-ux.md'],
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const texts = Object.fromEntries(
  Object.entries(artifacts).map(([name, [ref, path]]) => [
    name,
    git('show', `${ref}:${path}`),
  ]),
)
const document = YAML.parse(texts.openapi)
const checks = []
const failures = []

function check(name, condition, detail) {
  checks.push({ name, status: condition ? 'PASS' : 'FAIL', detail })
  if (!condition) failures.push(name)
}

function resolvePointer(pointer) {
  if (!pointer.startsWith('#/')) return undefined
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], document)
}

function walk(value, visitor) {
  if (!value || typeof value !== 'object') return
  visitor(value)
  for (const nested of Object.values(value)) walk(nested, visitor)
}

const refsFound = []
walk(document, (value) => {
  if (typeof value.$ref === 'string') refsFound.push(value.$ref)
})
const unresolvedRefs = refsFound.filter(
  (ref) => ref.startsWith('#/') && resolvePointer(ref) === undefined,
)
check(
  'openapi-parse-and-refs',
  document.openapi === '3.1.0' && unresolvedRefs.length === 0,
  `${refsFound.length} refs locais; ${unresolvedRefs.length} não resolvidas`,
)

const methods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
])
const operations = []
const missingPathParameters = []
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue
    operations.push({ path, method, ...operation })
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1],
    )
    const parameters = [
      ...(pathItem.parameters ?? []),
      ...(operation.parameters ?? []),
    ].map((parameter) =>
      parameter.$ref ? resolvePointer(parameter.$ref) : parameter,
    )
    for (const placeholder of placeholders) {
      if (
        !parameters.some(
          (parameter) =>
            parameter?.in === 'path' &&
            parameter?.name === placeholder &&
            parameter.required === true,
        )
      ) {
        missingPathParameters.push(
          `${method.toUpperCase()} ${path}:{${placeholder}}`,
        )
      }
    }
  }
}
const operationIds = operations.map((operation) => operation.operationId)
const duplicateOperationIds = operationIds.filter(
  (id, index) => operationIds.indexOf(id) !== index,
)
check(
  'operation-ids-and-path-parameters',
  operationIds.every(Boolean) &&
    duplicateOperationIds.length === 0 &&
    missingPathParameters.length === 0,
  `${operationIds.length} operationIds; ${duplicateOperationIds.length} duplicados; ${missingPathParameters.length} parâmetros ausentes`,
)

const policyRoles = document['x-rbac-policy']?.roles ?? {}
const operationToRoles = new Map()
const rbacErrors = []
for (const [roleName, role] of Object.entries(policyRoles)) {
  for (const operationId of role.operations ?? []) {
    const operation = operations.find(
      (candidate) => candidate.operationId === operationId,
    )
    if (!operation) {
      rbacErrors.push(
        `${roleName} referencia operationId inexistente ${operationId}`,
      )
      continue
    }
    operationToRoles.set(operationId, [
      ...(operationToRoles.get(operationId) ?? []),
      roleName,
    ])
    for (const scope of operation['x-required-scopes'] ?? []) {
      if (!(role.scopes ?? []).includes(scope))
        rbacErrors.push(
          `${roleName} não contém ${scope} exigido por ${operationId}`,
        )
    }
  }
}
for (const operation of operations) {
  if (
    !Array.isArray(operation['x-required-scopes']) ||
    operation['x-required-scopes'].length === 0
  ) {
    rbacErrors.push(`${operation.operationId} sem x-required-scopes`)
  }
  const owners = operationToRoles.get(operation.operationId) ?? []
  if (owners.length !== 1)
    rbacErrors.push(
      `${operation.operationId} mapeado para ${owners.length} roles`,
    )
}
check(
  'rbac-contract',
  document['x-rbac-policy']?.default === 'deny' && rbacErrors.length === 0,
  `default deny; ${Object.keys(policyRoles).length} roles; ${rbacErrors.length} inconsistências`,
)

const operationState = document.components?.schemas?.OperationState
const stateSet = new Set(operationState?.enum ?? [])
const transitions = operationState?.['x-allowed-transitions'] ?? {}
const transitionErrors = []
for (const state of stateSet) {
  if (!Object.hasOwn(transitions, state))
    transitionErrors.push(`estado sem transições declaradas: ${state}`)
}
for (const [from, targets] of Object.entries(transitions)) {
  if (!stateSet.has(from)) transitionErrors.push(`origem fora do enum: ${from}`)
  for (const target of targets)
    if (!stateSet.has(target))
      transitionErrors.push(`destino fora do enum: ${target}`)
}
for (const terminal of operationState?.['x-terminal-states'] ?? []) {
  if ((transitions[terminal] ?? []).length !== 0)
    transitionErrors.push(`terminal com saída: ${terminal}`)
}
check(
  'canonical-states',
  stateSet.size === 15 && transitionErrors.length === 0,
  `${stateSet.size} estados; ${Object.values(transitions).reduce((sum, targets) => sum + targets.length, 0)} transições; ${transitionErrors.length} inconsistências`,
)

const projectedDocs = ['prd', 'spec', 'security', 'ux']
const stateProjectionErrors = []
for (const name of projectedDocs) {
  for (const state of stateSet) {
    if (
      !texts[name].includes(`\`${state}\``) &&
      !texts[name].includes(`${state} `)
    ) {
      stateProjectionErrors.push(`${name} não projeta ${state}`)
    }
  }
  if (
    !texts[name].includes('OperationState') ||
    (!texts[name].includes('x-allowed-transitions') &&
      !texts[name].includes('tabela de transições'))
  ) {
    stateProjectionErrors.push(`${name} não referencia a fonte canônica`)
  }
}
check(
  'state-projections',
  stateProjectionErrors.length === 0,
  `PRD/spec/security/UX; ${stateProjectionErrors.length} lacunas${stateProjectionErrors.length ? `: ${stateProjectionErrors.join('; ')}` : ''}`,
)

const requiredRollbackPaths = [
  '/operations/{operation_id}/rollback/dry-run',
  '/operations/{operation_id}/rollback/approve',
  '/operations/{operation_id}/rollback/execute',
]
const rollbackSchemas = document.components?.schemas ?? {}
const rollbackOk =
  requiredRollbackPaths.every((path) => document.paths?.[path]?.post) &&
  rollbackSchemas.RollbackPlan?.required?.includes('rollback_plan_hash') &&
  rollbackSchemas.RollbackExecuteRequest?.required?.includes('approval_id') &&
  rollbackSchemas.RollbackExecuteRequest?.required?.includes(
    'rollback_plan_hash',
  ) &&
  document['x-rbac-policy']?.segregation?.destructive_rollback
    ?.approval_bound_to === 'rollback_plan_hash'
check(
  'rollback-contract',
  rollbackOk,
  'dry-run/approve/execute, hash, approval_id e segregação destrutiva',
)

function validDecisionSchema(schemaName, approveName, rejectName, hashName) {
  const schema = rollbackSchemas[schemaName]
  const approve = rollbackSchemas[approveName]
  const reject = rollbackSchemas[rejectName]
  return (
    schema?.oneOf?.length === 2 &&
    schema?.discriminator?.propertyName === 'decision' &&
    approve?.required?.includes(hashName) &&
    approve?.required?.includes('confirmation') &&
    !reject?.required?.includes(hashName) &&
    !reject?.required?.includes('confirmation') &&
    reject?.required?.includes('reason')
  )
}
check(
  'approve-reject-discrimination',
  validDecisionSchema(
    'ApprovalRequest',
    'ApproveRequest',
    'RejectRequest',
    'plan_hash',
  ) &&
    validDecisionSchema(
      'RollbackApprovalRequest',
      'RollbackApproveRequest',
      'RollbackRejectRequest',
      'rollback_plan_hash',
    ),
  'approve exige hash/confirmação; reject exige somente decisão/motivo',
)

const idempotencyParameter = document.components?.parameters?.IdempotencyKey
const idempotencyErrors = operations
  .filter((operation) => operation.method === 'post')
  .filter(
    (operation) =>
      !(operation.parameters ?? []).some(
        (parameter) =>
          parameter.$ref === '#/components/parameters/IdempotencyKey',
      ),
  )
  .map((operation) => operation.operationId)
check(
  'idempotency-contract',
  idempotencyParameter?.required === true &&
    idempotencyParameter?.description?.includes('cliente/SDK') &&
    idempotencyParameter?.description?.includes('primeiro POST') &&
    idempotencyErrors.length === 0,
  `${operations.filter((operation) => operation.method === 'post').length} mutações cobertas; ${idempotencyErrors.length} sem header`,
)

const absolutePathHits = []
for (const [name, text] of Object.entries(texts)) {
  for (const [index, line] of text.split('\n').entries()) {
    if (/\/home\/|[A-Za-z]:\\\\Users\\\\/.test(line))
      absolutePathHits.push(`${name}:${index + 1}`)
  }
}

const secretRefSchema = rollbackSchemas.SecretRef
const artifactRefSchema = rollbackSchemas.ArtifactRef
const secretRefConditional = artifactRefSchema?.allOf?.find(
  (entry) => entry?.if?.properties?.type?.const === 'secret_ref',
)
const secretRefDescription = secretRefSchema?.description ?? ''
check(
  'secret-ref-schema-and-artifact-contract',
  secretRefSchema?.type === 'string' &&
    secretRefSchema?.minLength === 48 &&
    secretRefSchema?.maxLength === 133 &&
    secretRefSchema?.pattern === '^sref_[A-Za-z0-9_-]{43,128}$' &&
    secretRefConditional?.then?.properties?.ref?.$ref ===
      '#/components/schemas/SecretRef' &&
    secretRefDescription.includes('server-issued') &&
    secretRefDescription.includes('256 bits') &&
    secretRefDescription.includes('CSPRNG') &&
    secretRefDescription.includes('persiste atomicamente') &&
    secretRefDescription.includes('binding interno protegido'),
  'SecretRef sref_ base64url, >=256 bits CSPRNG, server-issued; ArtifactRef condicional e binding atômico',
)

const projectionRequirements = {
  prd: [
    /secret_ref` opaca como único identificador retornável/i,
    /secret_ref` é um identificador opaco emitido pelo broker/i,
    /Clientes não a constroem a partir de UUID, `project_id`, slug ou path/i,
  ],
  adr: [
    /SecretRef` é um token opaco, aleatório e emitido exclusivamente pelo secret broker/i,
    /não contém, codifica ou concatena `project_id`, UUID do projeto, slug, purpose, provider, locator ou path/i,
    /persistência atômica do digest\/binding interno da `SecretRef` antes de publicar/i,
  ],
  spec: [
    /SecretRef` emitida exclusivamente pelo secret broker/i,
    /não contém, codifica nem permite derivar `project_id`, UUID do projeto, slug, purpose, provider, locator ou path/i,
    /broker persiste de forma durável e atômica um registro interno que vincula o digest do token/i,
  ],
  security: [
    /SecretRef` opaca emitida pelo broker/i,
    /não contém, codifica nem permite derivar `project_id`, `project_uuid`, slug, purpose, provider, locator ou path/i,
    /broker persiste de forma durável e atômica o digest do token e seu binding interno protegido/i,
  ],
  ux: [
    /UI não constrói, analisa, normaliza nem deriva referência a partir de `project_id`, UUID, slug, purpose, provider, locator ou path/i,
    /broker emite o token opaco no servidor/i,
    /persiste atomicamente seu digest e binding privado antes de publicar o artefato/i,
  ],
}
const projectionErrors = []
for (const [name, requirements] of Object.entries(projectionRequirements)) {
  requirements.forEach((requirement, index) => {
    if (!requirement.test(texts[name]))
      projectionErrors.push(`${name}:regra-${index + 1}`)
  })
}
check(
  'opaque-secret-ref-projections',
  projectionErrors.length === 0,
  `PRD/ADR/spec/threat/UX; ${projectionErrors.length} regras ausentes${projectionErrors.length ? `: ${projectionErrors.join(', ')}` : ''}`,
)

const derivedPlaceholderHits = []
const exposedSecretRefHits = []
for (const [name, text] of Object.entries(texts)) {
  for (const [index, line] of text.split('\n').entries()) {
    if (
      /secret:\/\//i.test(line) ||
      /(?:SecretRef|secret_ref|sref_).*(?:<project[_-]?(?:id|uuid)>|<uuid>|<slug>|<purpose>|<provider>|<locator>|<path>)/i.test(
        line,
      )
    ) {
      derivedPlaceholderHits.push(`${name}:${index + 1}`)
    }
    for (const match of line.matchAll(/sref_[A-Za-z0-9_-]{43,128}/g)) {
      if (!match[0].includes('REDACTED'))
        exposedSecretRefHits.push(`${name}:${index + 1}`)
    }
  }
}
check(
  'secret-ref-leak-and-placeholder-scan',
  absolutePathHits.length === 0 &&
    derivedPlaceholderHits.length === 0 &&
    exposedSecretRefHits.length === 0,
  `${absolutePathHits.length} paths absolutos; ${derivedPlaceholderHits.length} placeholders deriváveis; ${exposedSecretRefHits.length} tokens integrais expostos`,
)

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
]
const diffSecretHits = []
for (const ref of new Set(
  Object.values(refs).filter((ref) => ref !== refs.base),
)) {
  const additions = git('diff', '--unified=0', `${refs.base}...${ref}`, '--')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  additions.forEach((line, index) => {
    if (secretPatterns.some((pattern) => pattern.test(line)))
      diffSecretHits.push(`${ref}:addition-${index + 1}`)
  })
}
check(
  'secret-scan',
  diffSecretHits.length === 0,
  `${diffSecretHits.length} hits nos diffs das quatro branches`,
)

const heads = Object.fromEntries(
  Object.entries(refs)
    .filter(([name]) => name !== 'base')
    .map(([name, ref]) => [name, git('rev-parse', ref).trim()]),
)

const result = {
  verdict: failures.length === 0 ? 'GO' : 'NO-GO',
  heads,
  checks,
  failures,
}
console.log(JSON.stringify(result, null, 2))
process.exitCode = failures.length === 0 ? 0 : 1
