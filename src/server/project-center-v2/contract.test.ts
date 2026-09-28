/**
 * Contract tests do Project Center v2 (PR 4).
 *
 * Comparam o manifest das rotas — a fonte que o handler HTTP usa para casar
 * método/path, exigir cabeçalhos e mapear erros — com o OpenAPI canônico, e
 * provam paridade com as tabelas do PR 1 (RBAC, segregação e catálogo de
 * erros). Nada aqui sobe servidor: o contrato é lido do disco e as tabelas
 * vêm dos módulos de produção.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  APPROVAL_CONFIRMATION_PATTERN,
  ERROR_CODES,
  ROLLBACK_CONFIRMATION_PATTERN,
} from './domain'
import {
  ERROR_STATUS_BY_CODE,
  PROJECT_CENTER_V2_MUTATIONS,
  PROJECT_CENTER_V2_OPERATIONS_PATH,
  PROJECT_CENTER_V2_ROUTES,
  hasUnboundSecretRef,
  projectCenterV2RouteFor,
  requiredScopesFor,
} from './http'
import {
  OPERATION_REQUIRED_SCOPES,
  POLICY_VERSION,
  PROJECT_OPERATION_IDS,
  ROLE_DEFINITIONS,
  SEGREGATION_RULES,
} from './policy'
import { InvalidIdempotencyKeyError, hashIdempotencyKey } from './idempotency'
import { assertApprovalConfirmation } from './approval-service'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CONTRACT_PATH = resolve(
  HERE,
  '../../../specs/contracts/project-center-v2.openapi.yaml',
)

interface OpenApiOperation {
  readonly operationId?: string
  readonly 'x-required-scopes'?: ReadonlyArray<string>
  readonly 'x-segregation'?: {
    readonly policy?: string
    readonly actor_type_required?: string
    readonly non_human_actor_response?: { status?: number; code?: string }
  }
  readonly parameters?: ReadonlyArray<{ $ref?: string }>
  readonly requestBody?: {
    readonly required?: boolean
    readonly content?: Record<string, { schema?: { $ref?: string } }>
  }
  readonly responses?: Record<
    string,
    {
      readonly $ref?: string
      readonly headers?: Record<string, unknown>
      readonly content?: Record<string, { schema?: { $ref?: string } }>
    }
  >
}

interface OpenApiDocument {
  readonly openapi: string
  readonly servers: ReadonlyArray<{ url: string }>
  readonly 'x-rbac-policy': {
    readonly version: string
    readonly default: string
    readonly 'actor-claims': {
      readonly subject: string
      readonly actor_type: string
      readonly allowed_values: ReadonlyArray<string>
      readonly required: ReadonlyArray<string>
    }
    readonly roles: Record<
      string,
      {
        readonly scopes: ReadonlyArray<string>
        readonly operations: ReadonlyArray<string>
        readonly environments: ReadonlyArray<string>
        readonly internal_only?: boolean
      }
    >
    readonly segregation: Record<string, Record<string, unknown>>
  }
  readonly paths: Record<string, Record<string, OpenApiOperation>>
  readonly components: {
    readonly parameters: Record<
      string,
      {
        readonly name: string
        readonly in: string
        readonly required?: boolean
        readonly schema?: {
          readonly minLength?: number
          readonly maxLength?: number
          readonly pattern?: string
          readonly format?: string
        }
      }
    >
    readonly headers: Record<string, { readonly schema?: unknown }>
    readonly responses: Record<
      string,
      { readonly headers?: Record<string, unknown> }
    >
    readonly schemas: Record<string, unknown>
  }
}

const contract = parse(readFileSync(CONTRACT_PATH, 'utf8')) as OpenApiDocument

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

function schemaName(reference: string | undefined): string | null {
  if (reference === undefined) return null
  const parts = reference.split('/')
  return parts[parts.length - 1] ?? null
}

function parameterName(reference: string | undefined): string | null {
  return schemaName(reference)
}

/** Acesso seguro a dicionário do contrato (evita `?.` sobre índice). */
function entryOrNull<T>(table: Record<string, T>, key: string): T | null {
  return Object.hasOwn(table, key) ? table[key] : null
}

/** Igual a `entryOrNull`, mas falha alto quando a entrada sumiu do contrato. */
function requiredEntry<T>(table: Record<string, T>, key: string): T {
  const entry = entryOrNull(table, key)
  if (entry === null) throw new Error(`contrato sem a entrada ${key}`)
  return entry
}

/** Resolve um `$ref` de schema do contrato para o objeto declarado. */
function resolveSchema(reference: unknown): Record<string, unknown> | null {
  if (typeof reference !== 'string') return null
  const name = schemaName(reference)
  if (name === null) return null
  const resolved = contract.components.schemas[name]
  return typeof resolved === 'object' && resolved !== null
    ? (resolved as Record<string, unknown>)
    : null
}

function operationAt(
  path: string,
  method: string,
): { operation: OpenApiOperation; key: string } | null {
  const item = entryOrNull(contract.paths, path)
  if (item === null) return null
  const operation = entryOrNull(item, method)
  if (operation === null) return null
  const key = `${method.toUpperCase()} ${path}`
  return { operation, key }
}

function collectOperations(): ReadonlyArray<{
  readonly path: string
  readonly method: string
  readonly operation: OpenApiOperation
}> {
  const collected: Array<{
    path: string
    method: string
    operation: OpenApiOperation
  }> = []
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const method of METHODS) {
      const operation = entryOrNull(item, method)
      if (operation !== null) collected.push({ path, method, operation })
    }
  }
  return collected
}

const declared = collectOperations()

describe('manifest x OpenAPI', () => {
  it('declara as nove operações do contrato, sem sobra nem falta', () => {
    const contractIds = declared
      .map((entry) => entry.operation.operationId)
      .filter((value): value is string => typeof value === 'string')
    expect(contractIds).toHaveLength(9)
    expect(new Set(contractIds).size).toBe(9)
    expect(contractIds).toEqual(
      PROJECT_CENTER_V2_ROUTES.map((route) => route.operationId),
    )
    expect(contractIds).toEqual([...PROJECT_OPERATION_IDS])
  })

  it('casa método, caminho contratual e caminho montado de cada operação', () => {
    // O mount da aplicação segue a regra global 4 do plano
    // (`/api/project-center/v2/...`); o `servers[0].url` do contrato é o
    // contexto documental, e `contractPath` é comparado com `paths`.
    expect(contract.servers[0]?.url).toBe('/api/v1/project-center')
    expect(PROJECT_CENTER_V2_OPERATIONS_PATH).toBe(
      '/api/project-center/v2/operations',
    )

    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      expect(
        found,
        `${route.operationId} em ${route.contractPath}`,
      ).not.toBeNull()
      expect(found?.operation.operationId).toBe(route.operationId)
      expect(route.path.startsWith(PROJECT_CENTER_V2_OPERATIONS_PATH)).toBe(
        true,
      )
      expect(route.path).toBe(
        `${PROJECT_CENTER_V2_OPERATIONS_PATH}${route.contractPath.slice(
          '/operations'.length,
        )}`,
      )
      expect(projectCenterV2RouteFor(route.operationId)).toBe(route)
    }
  })

  it('exige os cabeçalhos contratuais na mesma proporção do manifest', () => {
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      const parameters = (found?.operation.parameters ?? []).map((parameter) =>
        parameterName(parameter.$ref),
      )
      if (route.contractPath.includes('{operation_id}')) {
        expect(parameters, route.operationId).toContain('OperationId')
      } else {
        expect(parameters, route.operationId).not.toContain('OperationId')
      }
      if (route.requiresIdempotencyKey) {
        expect(parameters, route.operationId).toContain('IdempotencyKey')
      } else {
        expect(parameters, route.operationId).not.toContain('IdempotencyKey')
      }
      if (route.requiresIfMatch) {
        expect(parameters, route.operationId).toContain('IfMatchVersion')
      }
    }

    const idempotency = requiredEntry(
      contract.components.parameters,
      'IdempotencyKey',
    )
    expect(idempotency.name).toBe('Idempotency-Key')
    expect(idempotency.in).toBe('header')
    expect(idempotency.required).toBe(true)
    expect(idempotency.schema?.minLength).toBe(16)
    expect(idempotency.schema?.maxLength).toBe(128)
    expect(idempotency.schema?.pattern).toBe('^[A-Za-z0-9._:-]+$')
    expect(
      requiredEntry(contract.components.parameters, 'IfMatchVersion').schema
        ?.pattern,
    ).toBe('^"[1-9][0-9]*"$')

    // Paridade comportamental com o validador real da chave.
    expect(() => hashIdempotencyKey('a'.repeat(15))).toThrow(
      InvalidIdempotencyKeyError,
    )
    expect(() => hashIdempotencyKey('a'.repeat(129))).toThrow(
      InvalidIdempotencyKeyError,
    )
    expect(() => hashIdempotencyKey(`chave${'ç'}`)).toThrow(
      InvalidIdempotencyKeyError,
    )
    expect(hashIdempotencyKey('a'.repeat(16))).toMatch(/^idem_[a-f0-9]{64}$/)
    expect(hashIdempotencyKey('a'.repeat(128))).toMatch(/^idem_[a-f0-9]{64}$/)
  })

  it('declara schemas de request/response iguais aos do manifest', () => {
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      const operation = found?.operation
      expect(operation, route.operationId).toBeDefined()

      const requestSchema = schemaName(
        operation?.requestBody?.content?.['application/json']?.schema?.$ref,
      )
      expect(requestSchema, route.operationId).toBe(route.requestSchema)
      if (route.requestSchema !== null) {
        expect(operation?.requestBody?.required).toBe(route.requestBodyRequired)
      }

      const responses = operation?.responses ?? {}
      const successStatuses = Object.keys(responses)
        .filter((status) => /^2[0-9]{2}$/.test(status))
        .map((status) => Number.parseInt(status, 10))
      for (const status of route.successStatuses) {
        expect(successStatuses, route.operationId).toContain(status)
      }
      const responseSchema = schemaName(
        entryOrNull(responses, String(route.successStatuses[0]))?.content?.[
          'application/json'
        ]?.schema?.$ref,
      )
      expect(responseSchema, route.operationId).toBe(route.responseSchema)
      expect(route.successStatuses).toContain(route.replayStatus)
    }
  })

  it('recusa autenticação e autorização em todas as operações', () => {
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      const responses = found?.operation.responses ?? {}
      expect(Object.keys(responses), route.operationId).toContain('401')
      expect(Object.keys(responses), route.operationId).toContain('403')
      expect(found?.operation['x-required-scopes']).toEqual(
        requiredScopesFor(route.operationId),
      )
      expect(requiredScopesFor(route.operationId)).toEqual(
        OPERATION_REQUIRED_SCOPES[
          route.operationId as keyof typeof OPERATION_REQUIRED_SCOPES
        ],
      )
    }
  })

  it('declara 429 com Retry-After nas sete mutações e 423 no lock', () => {
    expect(PROJECT_CENTER_V2_MUTATIONS).toHaveLength(7)
    for (const route of PROJECT_CENTER_V2_MUTATIONS) {
      expect(route.requiresIdempotencyKey).toBe(true)
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      const responses = found?.operation.responses ?? {}
      expect(Object.keys(responses), route.operationId).toContain('429')
    }
    const rateLimited = entryOrNull(
      contract.components.responses,
      'RateLimited',
    )
    const locked = entryOrNull(contract.components.responses, 'Locked')
    expect(Object.keys(rateLimited?.headers ?? {})).toContain('Retry-After')
    expect(Object.keys(locked?.headers ?? {})).toContain('Retry-After')
    expect(
      Object.keys(contract.components.headers).includes('IdempotencyReplayed'),
    ).toBe(true)
  })

  it('mantém paridade com a política do PR 1 (RBAC e segregação)', () => {
    const policy = contract['x-rbac-policy']
    expect(policy.version).toBe(POLICY_VERSION)
    expect(policy.default).toBe('deny')
    expect(policy['actor-claims']).toEqual({
      subject: 'sub',
      actor_type: 'actor_type',
      allowed_values: ['human', 'agent', 'worker'],
      required: ['subject', 'actor_type'],
    })

    expect(Object.keys(policy.roles).sort()).toEqual(
      Object.keys(ROLE_DEFINITIONS).sort(),
    )
    for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
      const declaredRole = entryOrNull(policy.roles, role)
      expect(declaredRole, role).not.toBeNull()
      expect(declaredRole?.scopes).toEqual(definition.scopes)
      expect(declaredRole?.operations).toEqual(definition.operations)
      expect(declaredRole?.environments).toEqual(definition.environments)
      expect(declaredRole?.internal_only === true).toBe(definition.internalOnly)
    }

    const production = policy.segregation.production_approval
    expect(production).toMatchObject({
      approver_must_be_human: true,
      approver_must_differ_from_requester: true,
      agent_tokens_may_approve: false,
    })
    const destructive = policy.segregation.destructive_rollback
    expect(destructive).toMatchObject({
      approver_must_differ_from_requester: true,
      approver_must_differ_from_original_operation_requester: true,
      approval_bound_to: 'rollback_plan_hash',
    })

    for (const rule of Object.values(SEGREGATION_RULES)) {
      expect(rule.nonHumanActorStatus).toBe(403)
      expect(rule.nonHumanActorCode).toBe('FORBIDDEN')
    }
  })

  it('exige ator humano (403 FORBIDDEN) nas duas decisões', () => {
    for (const operationId of [
      'decideProjectOperationApproval',
      'decideProjectRollbackApproval',
    ]) {
      const route = projectCenterV2RouteFor(operationId)
      expect(route.segregation).not.toBeNull()
      const found = operationAt(route.contractPath, route.method.toLowerCase())
      expect(found?.operation['x-segregation']).toMatchObject({
        policy: route.segregation,
        actor_type_required: 'human',
        non_human_actor_response: { status: 403, code: 'FORBIDDEN' },
      })
    }
    for (const route of PROJECT_CENTER_V2_ROUTES) {
      const isDecision =
        route.operationId === 'decideProjectOperationApproval' ||
        route.operationId === 'decideProjectRollbackApproval'
      expect(route.segregation !== null, route.operationId).toBe(isDecision)
    }
  })

  it('usa o pattern de confirmação do contrato', () => {
    function patternFromRequestSchema(schemaKey: string): string | undefined {
      const request = contract.components.schemas[schemaKey] as {
        readonly oneOf?: ReadonlyArray<{ $ref?: string }>
      }
      for (const variant of request.oneOf ?? []) {
        const resolved = resolveSchema(variant.$ref)
        const properties = resolved?.properties as
          | { readonly confirmation?: { readonly pattern?: string } }
          | undefined
        const pattern = properties?.confirmation?.pattern
        if (typeof pattern === 'string') return pattern
      }
      return undefined
    }

    expect(patternFromRequestSchema('ApprovalRequest')).toBe(
      APPROVAL_CONFIRMATION_PATTERN.source,
    )
    expect(patternFromRequestSchema('RollbackApprovalRequest')).toBe(
      ROLLBACK_CONFIRMATION_PATTERN.source,
    )
  })

  it('restringe ArtifactRef e o token SecretRef do contrato', () => {
    const artifactRef = contract.components.schemas.ArtifactRef as {
      readonly allOf?: ReadonlyArray<{
        readonly if?: {
          readonly properties?: { readonly type?: { const?: string } }
        }
        readonly then?: {
          readonly properties?: { readonly ref?: { $ref?: string } }
        }
      }>
      readonly properties?: {
        readonly type?: { readonly enum?: ReadonlyArray<string> }
        readonly ref?: { readonly pattern?: string }
      }
    }
    expect(artifactRef.properties?.type?.enum).toContain('secret_ref')
    const conditional = artifactRef.allOf?.[0]
    expect(conditional?.if?.properties?.type?.const).toBe('secret_ref')
    expect(schemaName(conditional?.then?.properties?.ref?.$ref)).toBe(
      'SecretRef',
    )

    const secretRef = contract.components.schemas.SecretRef as {
      readonly pattern?: string
      readonly minLength?: number
    }
    expect(secretRef.pattern).toBe('^sref_[A-Za-z0-9_-]{43,128}$')
    expect(secretRef.minLength).toBe(48)

    const token = `sref_${'A'.repeat(43)}`
    expect(new RegExp(secretRef.pattern ?? '').test(token)).toBe(true)
    // Fora do campo tipado o token é recusado; dentro de `artifacts[].ref` é
    // o valor contratual (a resposta é do tipo `secret_ref`).
    expect(
      hasUnboundSecretRef({ plan: { actions: [{ target_ref: token }] } }),
    ).toBe(true)
    expect(
      hasUnboundSecretRef({
        operation: { artifacts: [{ ref: token, type: 'secret_ref' }] },
      }),
    ).toBe(false)
  })

  it('mantém o catálogo de erros com status fechado', () => {
    const errorCode = contract.components.schemas.ErrorCode as {
      readonly enum?: ReadonlyArray<string>
    }
    expect([...(errorCode.enum ?? [])].sort()).toEqual([...ERROR_CODES].sort())
    expect(Object.keys(ERROR_STATUS_BY_CODE).sort()).toEqual(
      [...ERROR_CODES].sort(),
    )
    const statuses = new Set(Object.values(ERROR_STATUS_BY_CODE))
    expect([...statuses].sort()).toEqual(
      [400, 401, 403, 404, 409, 410, 422, 423, 429, 500].sort(),
    )

    // Toda resposta 4xx/5xx declarada no contrato tem código no catálogo.
    for (const entry of declared) {
      for (const status of Object.keys(entry.operation.responses ?? {})) {
        if (!/^[45][0-9]{2}$/.test(status)) continue
        expect(statuses, `${entry.operation.operationId} ${status}`).toContain(
          Number.parseInt(status, 10),
        )
      }
    }
  })

  it('recusa confirmação fora do pattern do contrato', () => {
    const valid = `APROVAR acme-site ${'a'.repeat(8)}`
    expect(APPROVAL_CONFIRMATION_PATTERN.test(valid)).toBe(true)
    expect(() =>
      assertApprovalConfirmation(valid, {
        kind: 'operation',
        projectId: 'acme-site',
        planHash: 'a'.repeat(64),
      }),
    ).not.toThrow()
    expect(() =>
      assertApprovalConfirmation(`aprovar acme-site ${'a'.repeat(8)}`, {
        kind: 'operation',
        projectId: 'acme-site',
        planHash: 'a'.repeat(64),
      }),
    ).toThrow()
    expect(
      APPROVAL_CONFIRMATION_PATTERN.test(`APROVAR acme-site ${'a'.repeat(7)}`),
    ).toBe(false)
  })
})
