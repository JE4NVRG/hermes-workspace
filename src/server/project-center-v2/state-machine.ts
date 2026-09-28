/**
 * Máquina de estados canônica do Project Center v2.
 *
 * Fonte da verdade: `specs/contracts/project-center-v2.openapi.yaml`
 * (`components.schemas.OperationState`), aprovada no pacote de discovery.
 *
 * Módulo puro: sem I/O, sem conexão administrativa, sem DDL, sem Docker e sem
 * acesso a secret. Divergência entre esta tabela e o contrato quebra
 * `state-machine.test.ts`, que compara o módulo com o OpenAPI em disco.
 */

/** Os 15 estados canônicos, na ordem do contrato. */
export const OPERATION_STATES = [
  'planned',
  'awaiting_approval',
  'approved',
  'queued',
  'executing',
  'verifying',
  'succeeded',
  'failed',
  'rollback_pending',
  'rolling_back',
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
] as const

export type OperationState = (typeof OPERATION_STATES)[number]

/** Estados terminais: por contrato não possuem aresta de saída. */
export const TERMINAL_STATES = [
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
] as const satisfies ReadonlyArray<OperationState>

/** Estado inicial de toda operação criada por dry-run. */
export const INITIAL_STATE: OperationState = 'planned'

/**
 * As 23 arestas canônicas de `x-allowed-transitions`.
 *
 * A ausência de uma aresta é uma negação fechada: qualquer par fora desta
 * tabela é recusado por `transitionOperation`.
 */
function freezeTransitionTable(
  table: Record<OperationState, ReadonlyArray<OperationState>>,
): Readonly<Record<OperationState, ReadonlyArray<OperationState>>> {
  const frozen: Record<string, ReadonlyArray<OperationState>> = {}
  for (const [from, targets] of Object.entries(table)) {
    frozen[from] = Object.freeze([...targets])
  }
  return Object.freeze(frozen) as Readonly<
    Record<OperationState, ReadonlyArray<OperationState>>
  >
}

export const ALLOWED_TRANSITIONS: Readonly<
  Record<OperationState, ReadonlyArray<OperationState>>
> = freezeTransitionTable({
  planned: ['awaiting_approval'],
  awaiting_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['queued', 'expired', 'cancelled'],
  queued: ['executing', 'approved'],
  executing: [
    'verifying',
    'failed',
    'rollback_pending',
    'manual_intervention_required',
  ],
  verifying: ['succeeded', 'rollback_pending', 'manual_intervention_required'],
  succeeded: ['rollback_pending'],
  failed: ['queued', 'rollback_pending'],
  rollback_pending: ['rolling_back'],
  rolling_back: ['rolled_back', 'manual_intervention_required'],
  rolled_back: [],
  manual_intervention_required: [],
  rejected: [],
  expired: [],
  cancelled: [],
})

export interface TransitionEdge {
  readonly from: OperationState
  readonly to: OperationState
}

/** As arestas achatadas, na ordem do contrato. */
export const TRANSITION_EDGES: ReadonlyArray<TransitionEdge> = Object.freeze(
  OPERATION_STATES.flatMap((from) =>
    ALLOWED_TRANSITIONS[from].map((to) => Object.freeze({ from, to })),
  ),
)

/** Conjunto fechado de códigos de erro emitidos por este módulo. */
export type StateMachineErrorCode =
  | 'INVALID_STATE_TRANSITION'
  | 'PLAN_STALE'
  | 'INVALID_REQUEST'

/** Transição fora das arestas canônicas (erro fechado). */
export class InvalidStateTransitionError extends Error {
  readonly code: StateMachineErrorCode = 'INVALID_STATE_TRANSITION'
  readonly current: OperationState
  readonly next: OperationState
  readonly allowed: ReadonlyArray<OperationState>

  constructor(current: OperationState, next: OperationState) {
    super(`transicao de estado invalida: ${current} -> ${next}`)
    this.name = 'InvalidStateTransitionError'
    this.current = current
    this.next = next
    this.allowed = allowedTransitionsFrom(current)
  }
}

/** Revisão otimista divergente: o cliente apresentou um `If-Match` obsoleto. */
export class OperationRevisionConflictError extends Error {
  readonly code: StateMachineErrorCode = 'PLAN_STALE'
  readonly reason = 'revision_mismatch'
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(
      `revisao divergente da operacao: esperada ${expected}, atual ${actual}`,
    )
    this.name = 'OperationRevisionConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** Revisão malformada (não inteira ou menor que 1). */
export class InvalidRevisionError extends Error {
  readonly code: StateMachineErrorCode = 'INVALID_REQUEST'
  readonly value: unknown

  constructor(value: unknown) {
    super('revisao de operacao invalida')
    this.name = 'InvalidRevisionError'
    this.value = value
  }
}

/** Estado desconhecido recebido de fora da máquina canônica. */
export class InvalidOperationStateError extends Error {
  readonly code: StateMachineErrorCode = 'INVALID_REQUEST'
  readonly value: unknown

  constructor(value: unknown) {
    super('estado de operacao desconhecido')
    this.name = 'InvalidOperationStateError'
    this.value = value
  }
}

export function isOperationState(value: unknown): value is OperationState {
  return (
    typeof value === 'string' &&
    (OPERATION_STATES as ReadonlyArray<string>).includes(value)
  )
}

export function assertOperationState(value: unknown): OperationState {
  if (!isOperationState(value)) throw new InvalidOperationStateError(value)
  return value
}

export function isTerminalState(state: OperationState): boolean {
  return (TERMINAL_STATES as ReadonlyArray<OperationState>).includes(state)
}

/** Arestas de saída declaradas para um estado (vazio se terminal). */
export function allowedTransitionsFrom(
  state: OperationState,
): ReadonlyArray<OperationState> {
  return ALLOWED_TRANSITIONS[state]
}

export function canTransition(
  current: OperationState,
  next: OperationState,
): boolean {
  return allowedTransitionsFrom(current).includes(next)
}

/** Lança `InvalidStateTransitionError` quando a aresta não é canônica. */
export function assertTransition(
  current: OperationState,
  next: OperationState,
): void {
  if (!canTransition(current, next)) {
    throw new InvalidStateTransitionError(current, next)
  }
}

export interface RevisionGuard {
  /** Revisão persistida na operação (fonte da verdade). */
  readonly actual: number
  /** Revisão apresentada pelo cliente (equivalente ao `If-Match`). */
  readonly expected: number
}

function assertRevisionValue(value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new InvalidRevisionError(value)
}

/**
 * Guarda de revisão otimista: exige que a revisão apresentada seja exatamente a
 * revisão persistida. Qualquer divergência é conflito fechado (`PLAN_STALE`).
 */
export function assertRevision(guard: RevisionGuard): void {
  assertRevisionValue(guard.actual)
  assertRevisionValue(guard.expected)
  if (guard.expected !== guard.actual) {
    throw new OperationRevisionConflictError(guard.expected, guard.actual)
  }
}

/**
 * `transitionOperation(current, next, expectedRevision)`
 *
 * Efeito puro: valida a aresta canônica e a revisão otimista e devolve o novo
 * estado. Não persiste nada, não incrementa revisão e não toca em I/O — a
 * persistência com incremento de `operation_version` é do operation store.
 *
 * Ordem de validação (negação fechada):
 * 1. estados e revisões bem-formadas (`INVALID_REQUEST`);
 * 2. aresta canônica (`INVALID_STATE_TRANSITION`);
 * 3. revisão otimista (`PLAN_STALE`).
 */
export function transitionOperation(
  current: OperationState,
  next: OperationState,
  expectedRevision: RevisionGuard,
): OperationState {
  assertOperationState(current)
  assertOperationState(next)
  assertTransition(current, next)
  assertRevision(expectedRevision)
  return next
}
