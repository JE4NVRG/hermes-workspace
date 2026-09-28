/**
 * Testes do operation store in-memory: criação validada, revisão otimista,
 * transições canônicas, imutabilidade e conflitos de nome.
 */
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, operationSchema } from './domain'
import {
  InvalidOperationInputError,
  OPERATION_INITIAL_VERSION,
  OperationNamingConflictError,
  OperationNotFoundError,
  createInMemoryOperationStore,
} from './operation-store'
import {
  InvalidStateTransitionError,
  OperationRevisionConflictError,
} from './state-machine'
import type { Plan, ProjectIntent } from './domain'
import type { CreateOperationInput, OperationStore } from './operation-store'

const OPERATION_UUID = '33333333-3333-4333-8333-333333333333'
const OTHER_UUID = '44444444-4444-4444-8444-444444444444'
const PLAN_HASH = 'a'.repeat(64)
const CREATED_AT = '2026-09-25T00:00:00.000Z'
const UPDATED_AT = '2026-09-25T00:05:00.000Z'
const EXPIRES_AT = '2026-09-26T00:00:00.000Z'
const PROJECT_ID = 'cliente-a-projeto-b'
const SCHEME_URL = ['https', '//interno.invalido/operations/1'].join('://')

const BASE_INTENT: ProjectIntent = {
  client_id: 'cliente-a',
  project_slug: 'projeto-b',
  display_name: 'Projeto B',
  driver: 'postgresql_isolated',
  environment: 'development',
  host_target: 'vps-primary-local',
  capabilities: {
    auth: true,
    storage: true,
    realtime: false,
    postgrest: true,
    backup: true,
  },
}

const BASE_PLAN: Plan = {
  policy_version: 'pcv2-rbac-v1',
  actions: [
    {
      action_id: 'act_abcdefgh',
      kind: 'create_database',
      target_ref: `${PROJECT_ID}-db`,
      risk: 'reversible',
      reversible: true,
      dependencies: [],
    },
  ],
  estimated_resources: { database_size_mb: 256 },
  warnings: [],
}

/** Intenção tipada; overrides passam por cast para exercitar payloads inválidos. */
function intent(overrides: Record<string, unknown> = {}): ProjectIntent {
  return { ...BASE_INTENT, ...overrides } as ProjectIntent
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  return { ...BASE_PLAN, ...overrides } as Plan
}

function input(
  overrides: Partial<CreateOperationInput> = {},
): CreateOperationInput {
  return {
    intent: intent(),
    plan: plan(),
    planHash: PLAN_HASH,
    expiresAt: EXPIRES_AT,
    statusUrl: `/api/v1/project-center/operations/${OPERATION_UUID}`,
    auditUrl: `/api/v1/project-center/operations/${OPERATION_UUID}/audit`,
    operationId: OPERATION_UUID,
    ...overrides,
  }
}

function newStore(): OperationStore {
  return createInMemoryOperationStore({
    now: () => CREATED_AT,
    generateId: () => OPERATION_UUID,
  })
}

/** Store com relógio controlável para asserir `updated_at`. */
function storeWithClock(): {
  store: OperationStore
  advance: () => void
} {
  let current = CREATED_AT
  const store = createInMemoryOperationStore({
    now: () => current,
    generateId: () => OPERATION_UUID,
  })
  return { store, advance: () => (current = UPDATED_AT) }
}

describe('criacao', () => {
  it('cria operacao em planned com revisao 1 e project_id derivado', () => {
    const store = newStore()
    const operation = store.create(input())
    expect(operation.state).toBe('planned')
    expect(operation.operation_version).toBe(OPERATION_INITIAL_VERSION)
    expect(operation.project_id).toBe(PROJECT_ID)
    expect(operation.driver).toBe('postgresql_isolated')
    expect(operation.environment).toBe('development')
    expect(operation.created_at).toBe(CREATED_AT)
    expect(operation.updated_at).toBe(CREATED_AT)
    expect(operation.plan_hash).toBe(PLAN_HASH)
    expect(operationSchema.safeParse(operation).success).toBe(true)
  })

  it('congela a operacao e o plano aninhado', () => {
    const store = newStore()
    const operation = store.create(input())
    expect(Object.isFrozen(operation)).toBe(true)
    expect(Object.isFrozen(operation.plan)).toBe(true)
    expect(Object.isFrozen(operation.plan.actions[0])).toBe(true)
    expect(() => {
      operation.state = 'succeeded'
    }).toThrow()
    expect(() => {
      operation.plan.actions[0].kind = 'publish_registry'
    }).toThrow()
    expect(store.require(OPERATION_UUID).state).toBe('planned')
    expect(store.require(OPERATION_UUID).plan.actions[0].kind).toBe(
      'create_database',
    )
  })

  it('recusa operation_id duplicado', () => {
    const store = newStore()
    store.create(input())
    expect(() => store.create(input())).toThrow(OperationNamingConflictError)
    try {
      store.create(input())
    } catch (error) {
      expect((error as OperationNamingConflictError).reason).toBe(
        'operation_id_reused',
      )
    }
  })

  it('recusa duas operacoes ativas no mesmo ambiente e libera apos estado terminal', () => {
    const store = newStore()
    store.create(input())
    expect(() => store.create(input({ operationId: OTHER_UUID }))).toThrow(
      OperationNamingConflictError,
    )

    expect(store.activeFor(PROJECT_ID, 'development')).toHaveLength(1)

    store.transition(OPERATION_UUID, 'awaiting_approval', 1)
    store.transition(OPERATION_UUID, 'cancelled', 2)
    expect(store.activeFor(PROJECT_ID, 'development')).toHaveLength(0)
    expect(() => store.create(input({ operationId: OTHER_UUID }))).not.toThrow()
  })

  it('aceita o mesmo projeto em outro ambiente', () => {
    const store = newStore()
    store.create(input())
    expect(() =>
      store.create(
        input({
          operationId: OTHER_UUID,
          intent: intent({ environment: 'staging' }),
        }),
      ),
    ).not.toThrow()
  })

  it('recusa entradas fora do contrato sem vazar detalhe', () => {
    const store = newStore()
    const attempts: Array<Partial<CreateOperationInput>> = [
      { intent: intent({ client_id: 'Cliente-a' }) },
      { intent: intent({ environment: 'preview' }) },
      { planHash: 'A'.repeat(64) },
      { planHash: 'a'.repeat(63) },
      { expiresAt: '2026-09-24T00:00:00.000Z' },
      { expiresAt: 'ontem' },
      { plan: plan({ actions: [] }) },
      { plan: plan({ campo_extra: 1 }) },
      { statusUrl: '' },
      { statusUrl: SCHEME_URL },
      { auditUrl: 'api/v1/project-center/operations/1/audit' },
      { auditUrl: `${SCHEME_URL}/audit` },
      { intent: intent({ dsn: 'x' }) },
    ]
    for (const overrides of attempts) {
      try {
        store.create(input(overrides))
        throw new Error('deveria ter falhado')
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOperationInputError)
        expect((error as Error).message).not.toContain('Cliente-a')
      }
    }
    expect(store.list()).toHaveLength(0)
  })
})

describe('consulta', () => {
  it('devolve null quando ausente e erro fechado em require', () => {
    const store = newStore()
    expect(store.get(OPERATION_UUID)).toBeNull()
    expect(() => store.require(OPERATION_UUID)).toThrow(OperationNotFoundError)
    try {
      store.require(OPERATION_UUID)
    } catch (error) {
      expect((error as OperationNotFoundError).code).toBe('NOT_FOUND')
      expect((error as OperationNotFoundError).operationId).toBe(OPERATION_UUID)
    }
  })

  it('lista operacoes criadas', () => {
    const store = newStore()
    store.create(input())
    store.create(
      input({
        operationId: OTHER_UUID,
        intent: intent({ environment: 'staging' }),
      }),
    )
    const listed = store.list()
    expect(listed).toHaveLength(2)
    expect(Object.isFrozen(listed)).toBe(true)
  })
})

describe('transicoes com revisao otimista', () => {
  it('percorre o ciclo de cancelamento incrementando revisao', () => {
    const { store, advance } = storeWithClock()
    store.create(input())

    advance()
    const awaiting = store.transition(OPERATION_UUID, 'awaiting_approval', 1)
    expect(awaiting.state).toBe('awaiting_approval')
    expect(awaiting.operation_version).toBe(2)
    expect(awaiting.updated_at).toBe(UPDATED_AT)
    expect(awaiting.created_at).toBe(CREATED_AT)

    const cancelled = store.transition(OPERATION_UUID, 'cancelled', 2)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.operation_version).toBe(3)
  })

  it('recusa transicao fora das arestas canonicas', () => {
    const store = newStore()
    store.create(input())
    expect(() => store.transition(OPERATION_UUID, 'succeeded', 1)).toThrow(
      InvalidStateTransitionError,
    )
    expect(() => store.transition(OPERATION_UUID, 'planned', 1)).toThrow(
      InvalidStateTransitionError,
    )
    expect(store.require(OPERATION_UUID).operation_version).toBe(1)
  })

  it('recusa revisao divergente com PLAN_STALE', () => {
    const store = newStore()
    store.create(input())
    store.transition(OPERATION_UUID, 'awaiting_approval', 1)
    expect(() => store.transition(OPERATION_UUID, 'approved', 1)).toThrow(
      OperationRevisionConflictError,
    )
    expect(store.require(OPERATION_UUID).operation_version).toBe(2)
  })

  it('recusa operacao inexistente', () => {
    const store = newStore()
    expect(() => store.transition(OTHER_UUID, 'awaiting_approval', 1)).toThrow(
      OperationNotFoundError,
    )
  })

  it('preserva plan_hash, plano e identidade ao longo do ciclo', () => {
    const store = newStore()
    const created = store.create(input())
    const path = [
      'awaiting_approval',
      'approved',
      'queued',
      'executing',
      'verifying',
      'succeeded',
      'rollback_pending',
      'rolling_back',
      'rolled_back',
    ] as const
    let revision = 1
    for (const next of path) {
      const updated = store.transition(OPERATION_UUID, next, revision)
      expect(updated.plan_hash).toBe(PLAN_HASH)
      expect(updated.project_id).toBe(PROJECT_ID)
      expect(updated.operation_id).toBe(OPERATION_UUID)
      expect(updated.plan).toEqual(created.plan)
      revision += 1
    }
    const final = store.require(OPERATION_UUID)
    expect(final.state).toBe('rolled_back')
    expect(final.operation_version).toBe(10)
    expect(operationSchema.safeParse(final).success).toBe(true)
  })

  it('esgotado o estado terminal, nenhuma transicao e aceita', () => {
    const store = newStore()
    store.create(input())
    store.transition(OPERATION_UUID, 'awaiting_approval', 1)
    store.transition(OPERATION_UUID, 'rejected', 2)
    expect(() => store.transition(OPERATION_UUID, 'approved', 3)).toThrow(
      InvalidStateTransitionError,
    )
  })

  it('emite apenas codigos do catalogo fechado', () => {
    for (const code of [
      new OperationNotFoundError(OPERATION_UUID).code,
      new OperationNamingConflictError('x').code,
      new InvalidOperationInputError(1).code,
    ]) {
      expect(ERROR_CODES as ReadonlyArray<string>).toContain(code)
    }
  })
})
