/**
 * Testes da máquina canônica de estados.
 *
 * Além das asserções locais, a tabela do módulo é comparada com o contrato
 * OpenAPI em disco: qualquer drift entre implementação e contrato falha aqui.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  ALLOWED_TRANSITIONS,
  INITIAL_STATE,
  InvalidOperationStateError,
  InvalidRevisionError,
  InvalidStateTransitionError,
  OPERATION_STATES,
  OperationRevisionConflictError,
  TERMINAL_STATES,
  TRANSITION_EDGES,
  allowedTransitionsFrom,
  canTransition,
  isOperationState,
  isTerminalState,
  transitionOperation,
} from './state-machine'
import { ERROR_CODES } from './domain'
import type { OperationState } from './state-machine'

const CONTRACT_PATH = fileURLToPath(
  new URL(
    '../../../specs/contracts/project-center-v2.openapi.yaml',
    import.meta.url,
  ),
)
const contract = parseYaml(readFileSync(CONTRACT_PATH, 'utf8')) as {
  components: {
    schemas: {
      OperationState: {
        enum: Array<string>
        'x-terminal-states': Array<string>
        'x-allowed-transitions': Record<string, Array<string>>
      }
    }
  }
}
const contractState = contract.components.schemas.OperationState

function guard(actual: number, expected = actual) {
  return { actual, expected }
}

describe('maquina canonica x contrato', () => {
  it('declara exatamente os 15 estados do OpenAPI', () => {
    expect(OPERATION_STATES).toHaveLength(15)
    expect([...OPERATION_STATES]).toEqual(contractState.enum)
  })

  it('declara exatamente as 23 arestas de x-allowed-transitions', () => {
    const contractEdges = Object.entries(
      contractState['x-allowed-transitions'],
    ).flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`))

    expect(contractEdges).toHaveLength(23)
    expect(TRANSITION_EDGES).toHaveLength(23)
    expect(TRANSITION_EDGES.map((edge) => `${edge.from}->${edge.to}`)).toEqual(
      contractEdges,
    )
  })

  it('espelha a tabela de transicoes estado por estado', () => {
    expect(ALLOWED_TRANSITIONS).toEqual(contractState['x-allowed-transitions'])
  })

  it('marca como terminais exatamente os estados sem saida', () => {
    expect([...TERMINAL_STATES]).toEqual(contractState['x-terminal-states'])
    for (const state of OPERATION_STATES) {
      expect(isTerminalState(state)).toBe(
        allowedTransitionsFrom(state).length === 0,
      )
    }
    for (const terminal of TERMINAL_STATES) {
      expect(allowedTransitionsFrom(terminal)).toHaveLength(0)
    }
  })

  it('comeca em planned', () => {
    expect(INITIAL_STATE).toBe('planned')
    expect(isOperationState(INITIAL_STATE)).toBe(true)
  })

  it('nao inventa estados alem do enum do contrato', () => {
    for (const state of OPERATION_STATES) {
      expect(contractState.enum).toContain(state)
    }
    for (const edge of TRANSITION_EDGES) {
      expect(contractState.enum).toContain(edge.from)
      expect(contractState.enum).toContain(edge.to)
    }
  })
})

describe('transitionOperation', () => {
  it('aceita aresta canonica com revisao coerente', () => {
    expect(transitionOperation('planned', 'awaiting_approval', guard(1))).toBe(
      'awaiting_approval',
    )
    expect(transitionOperation('executing', 'verifying', guard(7, 7))).toBe(
      'verifying',
    )
    expect(transitionOperation('failed', 'queued', guard(3))).toBe('queued')
  })

  it('percorre o ciclo completo de sucesso ate rolled_back', () => {
    const path: Array<OperationState> = [
      'planned',
      'awaiting_approval',
      'approved',
      'queued',
      'executing',
      'verifying',
      'succeeded',
      'rollback_pending',
      'rolling_back',
      'rolled_back',
    ]
    let revision = 1
    for (let index = 1; index < path.length; index += 1) {
      const current = path[index - 1]
      const next = path[index]
      expect(transitionOperation(current, next, guard(revision))).toBe(next)
      revision += 1
    }
    expect(revision).toBe(10)
  })

  it('recusa transicao fora das arestas com erro fechado', () => {
    const invalid: Array<[OperationState, OperationState]> = [
      ['planned', 'executing'],
      ['planned', 'planned'],
      ['succeeded', 'queued'],
      ['rejected', 'approved'],
      ['rolled_back', 'planned'],
      ['manual_intervention_required', 'queued'],
      ['verifying', 'queued'],
    ]
    for (const [current, next] of invalid) {
      expect(canTransition(current, next)).toBe(false)
      expect(() => transitionOperation(current, next, guard(1))).toThrow(
        InvalidStateTransitionError,
      )
    }
  })

  it('expoe estado atual, destino e arestas permitidas no erro', () => {
    try {
      transitionOperation('planned', 'succeeded', guard(1))
      throw new Error('deveria ter falhado')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionError)
      const failure = error as InvalidStateTransitionError
      expect(failure.code).toBe('INVALID_STATE_TRANSITION')
      expect(failure.current).toBe('planned')
      expect(failure.next).toBe('succeeded')
      expect(failure.allowed).toEqual(['awaiting_approval'])
    }
  })

  it('recusa revisao divergente com PLAN_STALE', () => {
    try {
      transitionOperation('approved', 'queued', guard(4, 1))
      throw new Error('deveria ter falhado')
    } catch (error) {
      expect(error).toBeInstanceOf(OperationRevisionConflictError)
      const failure = error as OperationRevisionConflictError
      expect(failure.code).toBe('PLAN_STALE')
      expect(failure.reason).toBe('revision_mismatch')
      expect(failure.expected).toBe(1)
      expect(failure.actual).toBe(4)
    }
  })

  it('valida o formato da revisao antes de qualquer efeito', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        transitionOperation('planned', 'awaiting_approval', guard(bad, bad)),
      ).toThrow(InvalidRevisionError)
    }
    expect(() =>
      transitionOperation('planned', 'awaiting_approval', guard(1, 0)),
    ).toThrow(InvalidRevisionError)
  })

  it('recusa estado desconhecido sem abrir excecao', () => {
    for (const bad of ['Planed', '', 'planned ', 'executing_v2', 7, null]) {
      expect(isOperationState(bad)).toBe(false)
      expect(() =>
        transitionOperation(bad as OperationState, 'queued', guard(1)),
      ).toThrow(InvalidOperationStateError)
    }
  })

  it('nao muta a tabela canonica', () => {
    expect(Object.isFrozen(ALLOWED_TRANSITIONS)).toBe(true)
    expect(Object.isFrozen(TRANSITION_EDGES)).toBe(true)
    expect(Object.isFrozen(ALLOWED_TRANSITIONS.queued)).toBe(true)
  })

  it('emite apenas codigos do catalogo fechado de erros', () => {
    const codes = [
      new InvalidStateTransitionError('planned', 'executing').code,
      new OperationRevisionConflictError(1, 2).code,
      new InvalidRevisionError(0).code,
      new InvalidOperationStateError('x').code,
    ]
    for (const code of codes) {
      expect(ERROR_CODES as ReadonlyArray<string>).toContain(code)
    }
  })
})
