/**
 * Operation store do Project Center v2 (PR 1).
 *
 * Interface + implementação in-memory para testes unitários. Nenhum store de
 * runtime é instanciado neste PR: a persistência real (adapter server-side)
 * chega nos PRs seguintes.
 *
 * Invariantes:
 * - `operation_version` é a revisão otimista: transição exige `expectedRevision`
 *   igual à revisão persistida (equivalente ao `If-Match`);
 * - toda transição passa pela máquina canônica (`transitionOperation`);
 * - `state`, `plan_hash` e `operation_id` não são mutáveis fora de transição;
 * - um ambiente/projeto não aceita duas operações ativas ao mesmo tempo;
 * - nada de I/O: sem banco, sem Docker, sem shell.
 */
import { randomUUID } from 'node:crypto'
import { INITIAL_STATE, transitionOperation } from './state-machine'
import {
  buildProjectId,
  operationSchema,
  planSchema,
  projectIntentSchema,
  sha256Schema,
} from './domain'
import type { OperationState } from './state-machine'
import type { Operation, Plan, ProjectIntent } from './domain'

export const OPERATION_INITIAL_VERSION = 1

/** Operação inexistente (ou invisível ao ator). */
export class OperationNotFoundError extends Error {
  readonly code = 'NOT_FOUND'
  readonly operationId: string

  constructor(operationId: string) {
    super('operacao nao encontrada')
    this.name = 'OperationNotFoundError'
    this.operationId = operationId
  }
}

/** Colisão de identidade/nome da operação. */
export class OperationNamingConflictError extends Error {
  readonly code = 'NAMING_CONFLICT'
  readonly reason: string

  constructor(reason: string) {
    super('conflito de identificacao da operacao')
    this.name = 'OperationNamingConflictError'
    this.reason = reason
  }
}

/** Entrada fora do contrato. */
export class InvalidOperationInputError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly issues: number

  constructor(issues: number) {
    super('entrada de operacao invalida')
    this.name = 'InvalidOperationInputError'
    this.issues = issues
  }
}

export interface CreateOperationInput {
  readonly intent: ProjectIntent
  readonly plan: Plan
  readonly planHash: string
  readonly expiresAt: string
  readonly statusUrl: string
  readonly auditUrl: string
  readonly observedRevision?: string
  readonly driverVersion?: string
  readonly operationId?: string
}

export interface OperationStore {
  create: (input: CreateOperationInput) => Operation
  get: (operationId: string) => Operation | null
  require: (operationId: string) => Operation
  transition: (
    operationId: string,
    next: OperationState,
    expectedRevision: number,
  ) => Operation
  list: () => ReadonlyArray<Operation>
  activeFor: (
    projectId: string,
    environment: string,
  ) => ReadonlyArray<Operation>
}

export interface InMemoryOperationStoreOptions {
  readonly now?: () => string
  readonly generateId?: () => string
}

const TERMINAL_LIKE = new Set<string>([
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
])

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value
  const target = value as unknown as object
  if (seen.has(target)) return value
  seen.add(target)
  for (const nested of Object.values(target as Record<string, unknown>)) {
    deepFreeze(nested, seen)
  }
  return Object.freeze(value)
}

function assertIsoDateTime(value: string, issues: number): void {
  if (Number.isNaN(Date.parse(value)))
    throw new InvalidOperationInputError(issues + 1)
}

/**
 * `status_url`/`audit_url` são caminhos relativos da própria API: nunca URL
 * com esquema, host, barra invertida ou espaço. Mantém a resposta livre de
 * destino do host.
 */
function assertRelativeUrl(value: string, issues: number): void {
  const invalid =
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('://') ||
    value.includes('\\') ||
    /\s/.test(value)
  if (invalid) throw new InvalidOperationInputError(issues + 1)
}

/**
 * Cria o operation store in-memory. Uso exclusivo de teste.
 */
export function createInMemoryOperationStore(
  options: InMemoryOperationStoreOptions = {},
): OperationStore {
  const now = options.now ?? (() => new Date().toISOString())
  const generateId = options.generateId ?? (() => randomUUID())
  const operations = new Map<string, Operation>()

  function require(operationId: string): Operation {
    const operation = operations.get(operationId)
    if (!operation) throw new OperationNotFoundError(operationId)
    return operation
  }

  return {
    create(input: CreateOperationInput): Operation {
      const intent = projectIntentSchema.safeParse(input.intent)
      if (!intent.success) {
        throw new InvalidOperationInputError(intent.error.issues.length)
      }
      const plan = planSchema.safeParse(input.plan)
      if (!plan.success) {
        throw new InvalidOperationInputError(plan.error.issues.length)
      }
      const planHash = sha256Schema.safeParse(input.planHash)
      if (!planHash.success) throw new InvalidOperationInputError(1)
      assertRelativeUrl(input.statusUrl, 0)
      assertRelativeUrl(input.auditUrl, 0)

      const operationId = input.operationId ?? generateId()
      if (operations.has(operationId)) {
        throw new OperationNamingConflictError('operation_id_reused')
      }

      const createdAt = now()
      assertIsoDateTime(createdAt, 0)
      const expiresAt = input.expiresAt
      assertIsoDateTime(expiresAt, 0)
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
        throw new InvalidOperationInputError(1)
      }

      const projectId = buildProjectId(
        intent.data.client_id,
        intent.data.project_slug,
      )
      const environment = intent.data.environment
      const hasActive = [...operations.values()].some(
        (candidate) =>
          candidate.project_id === projectId &&
          candidate.environment === environment &&
          !TERMINAL_LIKE.has(candidate.state),
      )
      if (hasActive) {
        throw new OperationNamingConflictError('operation_already_active')
      }

      const candidate = {
        operation_id: operationId,
        project_id: projectId,
        driver: intent.data.driver,
        ...(input.driverVersion === undefined
          ? {}
          : { driver_version: input.driverVersion }),
        environment,
        state: INITIAL_STATE,
        operation_version: OPERATION_INITIAL_VERSION,
        plan_hash: planHash.data,
        ...(input.observedRevision === undefined
          ? {}
          : { observed_revision: input.observedRevision }),
        plan: plan.data,
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: expiresAt,
        status_url: input.statusUrl,
        audit_url: input.auditUrl,
      }

      const parsed = operationSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new InvalidOperationInputError(parsed.error.issues.length)
      }
      const operation = deepFreeze(parsed.data)
      operations.set(operationId, operation)
      return operation
    },

    get(operationId: string): Operation | null {
      return operations.get(operationId) ?? null
    },

    require,

    transition(
      operationId: string,
      next: OperationState,
      expectedRevision: number,
    ): Operation {
      const current = require(operationId)
      const state = transitionOperation(current.state, next, {
        actual: current.operation_version,
        expected: expectedRevision,
      })
      const candidate = {
        ...current,
        state,
        operation_version: current.operation_version + 1,
        updated_at: now(),
      }
      const parsed = operationSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new InvalidOperationInputError(parsed.error.issues.length)
      }
      const operation = deepFreeze(parsed.data)
      operations.set(operationId, operation)
      return operation
    },

    list(): ReadonlyArray<Operation> {
      return Object.freeze([...operations.values()])
    },

    activeFor(
      projectId: string,
      environment: string,
    ): ReadonlyArray<Operation> {
      return Object.freeze(
        [...operations.values()].filter(
          (candidate) =>
            candidate.project_id === projectId &&
            candidate.environment === environment &&
            !TERMINAL_LIKE.has(candidate.state),
        ),
      )
    },
  }
}
