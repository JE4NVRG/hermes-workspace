/**
 * Serviço de aprovação do Project Center v2 (PR 4).
 *
 * Implementa as decisões de aprovação do contrato sem I/O privilegiado:
 *
 * - aprovação vinculada ao `plan_hash`/`rollback_plan_hash` exato e à revisão
 *   otimista (`If-Match`); plano vencido é `APPROVAL_EXPIRED` (410) e revisão
 *   divergente é `PLAN_STALE` (409);
 * - **hash divergente na decisão** é tratado pela política de segregação do
 *   PR 1 (`approval_hash_mismatch` ⇒ `FORBIDDEN` 403): apresentar outro hash
 *   ao aprovar é ato de segregação, conforme a descrição 403 do contrato. O
 *   `PLAN_STALE` (409) fica para a revalidação em `execute`/`rollback`, quando
 *   o plano registrado muda depois da aprovação (sem segregação em jogo);
 * - frase de confirmação validada contra o **pattern canônico** do contrato e
 *   contra o `project_id`/hash da operação — qualquer outra forma é
 *   `INVALID_REQUEST` (400) e nunca aprova nada;
 * - segregação de funções pela política do PR 1: token com `actor_type`
 *   diferente de `human` responde 403 `FORBIDDEN` **antes** de qualquer
 *   escrita (zero side effect), aprovador difere do solicitante e, no rollback
 *   destrutivo, também do solicitante original;
 * - rollback em três fases (`dry-run` → `approval` → `execute`) com hash
 *   próprio, novo `approval_id`, ownership/drift comprovados e gate destrutivo.
 *
 * As escritas (aprovação, plano de rollback, solicitante) são devolvidas como
 * decisões puras; quem as aplica de forma atômica é a unidade de trabalho do
 * `idempotency.ts`, junto da operação, do outbox e da auditoria.
 */
import { createHash } from 'node:crypto'
import {
  ROLLBACK_CONFIRMATION_PATTERN,
  SHA256_PATTERN,
  approvalSchema,
  buildApprovalConfirmation,
  buildRollbackConfirmation,
  rollbackApprovalSchema,
  rollbackPlanSchema,
} from './domain'
import { APPROVAL_TTL_SECONDS, PLAN_TTL_SECONDS } from './planner'
import { evaluateApprovalSegregation } from './policy'
import { transitionOperation } from './state-machine'
import type {
  Approval,
  ApprovalRequest,
  ArtifactRef,
  ErrorCode,
  Operation,
  Plan,
  PlannedAction,
  RollbackApproval,
  RollbackApprovalRequest,
  RollbackPlan,
  Verification,
} from './domain'
import type { OperationStore } from './operation-store'
import type { PolicyActorClaims, PolicyDecisionCode } from './policy'
import type { OperationState } from './state-machine'

/** Teto de ações de um plano de rollback (contrato). */
export const ROLLBACK_ACTION_LIMIT = 50

/**
 * Referência pública de ator. Nunca é o `sub` cru: o `actor_ref` do contrato
 * (aprovação e auditoria) expõe apenas um digest estável, sem PII.
 */
export function actorRefFor(subject: string): string {
  const digest = createHash('sha256').update(subject).digest('hex')
  return `actor_${digest.slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Erros tipados (códigos fechados do contrato)
// ---------------------------------------------------------------------------

abstract class ApprovalError extends Error {
  abstract readonly code: ErrorCode
  abstract readonly status: number
  readonly details: ReadonlyArray<{
    readonly field?: string
    readonly reason: string
  }>

  constructor(
    message: string,
    details: ReadonlyArray<{
      readonly field?: string
      readonly reason: string
    }> = [],
  ) {
    super(message)
    this.details = details
  }
}

/** Plano/hash apresentado não é o do registro (plano mudou). */
export class ApprovalHashMismatchError extends ApprovalError {
  readonly code: ErrorCode = 'PLAN_STALE'
  readonly status = 409
}

/** Plano ou aprovação fora do prazo. */
export class ApprovalExpiredError extends ApprovalError {
  readonly code: ErrorCode = 'APPROVAL_EXPIRED'
  readonly status = 410
}

/** Frase de confirmação ausente, malformada ou de outro alvo. */
export class ApprovalConfirmationError extends ApprovalError {
  readonly code: ErrorCode = 'INVALID_REQUEST'
  readonly status = 400
}

/** Segregação de funções/papéis negada (não humano, mesmo solicitante). */
export class ApprovalSegregationError extends ApprovalError {
  readonly code: ErrorCode = 'FORBIDDEN'
  readonly status = 403
}

/** Estado/revisão incompatível com a decisão solicitada. */
export class ApprovalStateError extends ApprovalError {
  readonly code: ErrorCode = 'INVALID_STATE_TRANSITION'
  readonly status = 409
}

/** Operação enfileirada sem aprovação válida. */
export class ApprovalRequiredError extends ApprovalError {
  readonly code: ErrorCode = 'APPROVAL_REQUIRED'
  readonly status = 409
}

/** Rollback recusado por ownership/drift/preservação de dados. */
export class RollbackUnsafeError extends ApprovalError {
  readonly code: ErrorCode = 'ROLLBACK_NOT_SAFE'
  readonly status = 422
}

/** Outra operação detém o lease exclusivo. */
export class OperationLockedError extends ApprovalError {
  readonly code: ErrorCode = 'OPERATION_LOCKED'
  readonly status = 423
}

function assertDecisionAllowed(
  decision: { readonly allowed: boolean; readonly code: PolicyDecisionCode },
  reasons: ReadonlyArray<string>,
): void {
  if (decision.allowed) return
  const details = reasons.map((reason) => ({ reason }))
  if (decision.code === 'FORBIDDEN') {
    throw new ApprovalSegregationError('segregacao de funcoes negada', details)
  }
  if (decision.code === 'INVALID_REQUEST') {
    throw new ApprovalConfirmationError('hash de aprovacao malformado', details)
  }
  if (decision.code === 'POLICY_DENIED') {
    throw new RollbackUnsafeError('aprovacao fora da policy', details)
  }
  throw new ApprovalSegregationError('aprovacao negada', details)
}

// ---------------------------------------------------------------------------
// Confirmação canônica
// ---------------------------------------------------------------------------

const CONFIRMATION_PATTERN =
  /^APROVAR (ROLLBACK )?([a-z][a-z0-9-]{1,23}-[a-z][a-z0-9-]{1,23}) ([a-f0-9]{8,64})$/

export type ConfirmationKind = 'operation' | 'rollback'

/**
 * Valida a frase de confirmação contra o pattern do contrato **e** contra o
 * alvo exato: `project_id` canônico e prefixo hexadecimal (8 a 64) do hash
 * correspondente. Qualquer divergência é `INVALID_REQUEST` e não aprova nada.
 */
export function assertApprovalConfirmation(
  confirmation: unknown,
  target: {
    readonly kind: ConfirmationKind
    readonly projectId: string
    readonly planHash: string
  },
): void {
  if (typeof confirmation !== 'string') {
    throw new ApprovalConfirmationError('confirmacao ausente', [
      { field: 'confirmation', reason: 'missing' },
    ])
  }
  const match = CONFIRMATION_PATTERN.exec(confirmation)
  if (match === null) {
    throw new ApprovalConfirmationError('confirmacao fora do pattern', [
      { field: 'confirmation', reason: 'invalid_pattern' },
    ])
  }
  const [, , projectId, prefix] = match
  const expectsRollback = target.kind === 'rollback'
  // O marcador `ROLLBACK` é o que distingue as duas frases do contrato.
  if (ROLLBACK_CONFIRMATION_PATTERN.test(confirmation) !== expectsRollback) {
    throw new ApprovalConfirmationError('confirmacao de outro tipo de plano', [
      { field: 'confirmation', reason: 'kind_mismatch' },
    ])
  }
  if (projectId !== target.projectId) {
    throw new ApprovalConfirmationError('confirmacao de outro projeto', [
      { field: 'confirmation', reason: 'project_mismatch' },
    ])
  }
  if (
    !SHA256_PATTERN.test(target.planHash) ||
    !target.planHash.startsWith(prefix)
  ) {
    throw new ApprovalConfirmationError('confirmacao de outro plano', [
      { field: 'confirmation', reason: 'hash_mismatch' },
    ])
  }
}

/** Frases canônicas esperadas (usadas nos testes e no serviço de UI). */
export function expectedApprovalConfirmation(
  projectId: string,
  planHash: string,
): string {
  return buildApprovalConfirmation(projectId, planHash)
}

export function expectedRollbackConfirmation(
  projectId: string,
  rollbackPlanHash: string,
): string {
  return buildRollbackConfirmation(projectId, rollbackPlanHash)
}

// ---------------------------------------------------------------------------
// Stores do PR 4 (in-memory; o adapter durável entra no PR 6)
// ---------------------------------------------------------------------------

export interface OperationApprovalStore {
  put: (operationId: string, approval: Approval) => Approval
  get: (operationId: string) => Approval | null
  discard: (operationId: string) => void
}

export interface RollbackPlanStore {
  put: (operationId: string, plan: RollbackPlan) => RollbackPlan
  get: (operationId: string) => RollbackPlan | null
  discard: (operationId: string) => void
}

export interface OperationOwnership {
  readonly operation_id: string
  readonly requester_subject: string
  readonly rollback_requester_subject: string | null
}

export interface OperationOwnershipStore {
  record: (operationId: string, requesterSubject: string) => OperationOwnership
  setRollbackRequester: (
    operationId: string,
    requesterSubject: string,
  ) => OperationOwnership
  get: (operationId: string) => OperationOwnership | null
  discard: (operationId: string) => void
}

export function createInMemoryOperationApprovalStore(): OperationApprovalStore {
  const approvals = new Map<string, Approval>()
  return {
    put(operationId, approval) {
      const parsed = approvalSchema.parse(approval)
      const frozen = Object.freeze(parsed)
      approvals.set(operationId, frozen)
      return frozen
    },
    get(operationId) {
      return approvals.get(operationId) ?? null
    },
    discard(operationId) {
      approvals.delete(operationId)
    },
  }
}

export function createInMemoryRollbackPlanStore(): RollbackPlanStore {
  const plans = new Map<string, RollbackPlan>()
  return {
    put(operationId, plan) {
      const parsed = rollbackPlanSchema.parse(plan)
      const frozen = Object.freeze(parsed)
      plans.set(operationId, frozen)
      return frozen
    },
    get(operationId) {
      return plans.get(operationId) ?? null
    },
    discard(operationId) {
      plans.delete(operationId)
    },
  }
}

export function createInMemoryOperationOwnershipStore(): OperationOwnershipStore {
  const ownership = new Map<string, OperationOwnership>()
  return {
    record(operationId, requesterSubject) {
      const entry: OperationOwnership = Object.freeze({
        operation_id: operationId,
        requester_subject: requesterSubject,
        rollback_requester_subject: null,
      })
      ownership.set(operationId, entry)
      return entry
    },
    setRollbackRequester(operationId, requesterSubject) {
      const current = ownership.get(operationId)
      if (current === undefined) {
        throw new ApprovalStateError('solicitante original desconhecido', [
          { reason: 'ownership_unknown' },
        ])
      }
      const entry: OperationOwnership = Object.freeze({
        ...current,
        rollback_requester_subject: requesterSubject,
      })
      ownership.set(operationId, entry)
      return entry
    },
    get(operationId) {
      return ownership.get(operationId) ?? null
    },
    discard(operationId) {
      ownership.delete(operationId)
    },
  }
}

// ---------------------------------------------------------------------------
// Aprovação de provisionamento
// ---------------------------------------------------------------------------

export interface OperationApprovalInput {
  readonly operation: Operation
  readonly actor: PolicyActorClaims
  readonly expectedRevision: number
  readonly request: ApprovalRequest
  readonly requesterSubject: string | null
  readonly now: Date
  readonly generateId: () => string
}

export interface OperationApprovalDecision {
  /** Próximo estado canônico (`approved`, `rejected` ou `expired`). */
  readonly next: OperationState
  /** Registro de aprovação; `null` quando o plano venceu sem decisão. */
  readonly approval: Approval | null
}

function approvalValidity(now: Date): { decidedAt: string; expiresAt: string } {
  return {
    decidedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + APPROVAL_TTL_SECONDS * 1000,
    ).toISOString(),
  }
}

/**
 * Avalia a decisão de aprovação do provisionamento.
 *
 * Ordem fechada: prazo do plano → segregação (não humano/duplo solicitante) →
 * hash exato → transição de estado → frase de confirmação. Nenhuma escrita
 * acontece aqui; a decisão é aplicada pela unidade de trabalho.
 */
export function evaluateOperationApproval(
  input: OperationApprovalInput,
): OperationApprovalDecision {
  const { operation, request, now } = input

  if (Date.parse(operation.expires_at) <= now.getTime()) {
    // Expiração preguiçosa: o estado canônico passa a `expired` e o cliente
    // recebe 410 sem que uma aprovação seja registrada.
    transitionOperation(operation.state, 'expired', {
      actual: operation.operation_version,
      expected: input.expectedRevision,
    })
    return { next: 'expired', approval: null }
  }

  const providedHash =
    request.decision === 'approve' ? request.plan_hash : operation.plan_hash
  const segregation = evaluateApprovalSegregation({
    policy: 'production_approval',
    approver: input.actor,
    requesterSubject: input.requesterSubject ?? undefined,
    boundHash: operation.plan_hash,
    providedHash,
  })
  assertDecisionAllowed(segregation, segregation.reasons)

  if (input.requesterSubject === null) {
    // Fail closed: sem saber quem solicitou não há como provar segregação.
    throw new ApprovalSegregationError('solicitante desconhecido', [
      { reason: 'requester_unknown' },
    ])
  }

  // O vínculo ao hash exato é verificado acima por `evaluateApprovalSegregation`
  // (`approval_hash_mismatch`/`malformed_approval_hash`): outra verificação aqui
  // seria um segundo dono da mesma regra e poderia divergir da política do PR 1.
  const next: OperationState =
    request.decision === 'approve' ? 'approved' : 'rejected'
  transitionOperation(operation.state, next, {
    actual: operation.operation_version,
    expected: input.expectedRevision,
  })

  if (request.decision === 'approve') {
    assertApprovalConfirmation(request.confirmation, {
      kind: 'operation',
      projectId: operation.project_id,
      planHash: operation.plan_hash,
    })
  }

  const { decidedAt, expiresAt } = approvalValidity(now)
  const approval = approvalSchema.parse({
    approval_id: input.generateId(),
    decision: request.decision,
    actor_ref: actorRefFor(input.actor.subject ?? 'unknown'),
    plan_hash: operation.plan_hash,
    decided_at: decidedAt,
    expires_at: expiresAt,
  })

  return { next, approval: Object.freeze(approval) }
}

/**
 * Revalida a aprovação do provisionamento no momento do `execute`:
 * ainda dentro do prazo, decisão `approve` e hash idêntico ao plano.
 */
export function assertApprovalUsable(
  operation: Operation,
  approval: Approval | null,
  now: Date,
): Approval {
  if (approval === null) {
    throw new ApprovalRequiredError('operacao sem aprovacao registrada', [
      { reason: 'approval_missing' },
    ])
  }
  if (approval.decision !== 'approve') {
    throw new ApprovalRequiredError('aprovacao rejeitada', [
      { reason: 'approval_rejected' },
    ])
  }
  if (approval.plan_hash !== operation.plan_hash) {
    throw new ApprovalHashMismatchError('aprovacao de outro plano', [
      { field: 'plan_hash', reason: 'approval_plan_hash_mismatch' },
    ])
  }
  if (Date.parse(approval.expires_at) <= now.getTime()) {
    throw new ApprovalExpiredError('aprovacao vencida', [
      { reason: 'approval_expired' },
    ])
  }
  if (Date.parse(operation.expires_at) <= now.getTime()) {
    throw new ApprovalExpiredError('plano vencido', [
      { reason: 'plan_expired' },
    ])
  }
  return approval
}

// ---------------------------------------------------------------------------
// Rollback em três fases
// ---------------------------------------------------------------------------

/** Resultado da observação de ownership/drift na fase de rollback. */
export interface RollbackObservation {
  readonly actions: ReadonlyArray<PlannedAction>
  readonly observed_revision: string
  readonly ownership_verified: boolean
  readonly drift_findings: ReadonlyArray<string>
}

export interface RollbackPlanningPort {
  observe: (
    operation: Operation,
    options: { readonly preserveData: boolean },
  ) => Promise<RollbackObservation>
}

/** Porta fechada: nenhuma observação de rollback acontece sem adapter injetado. */
export class RollbackObservationUnavailableError extends Error {
  readonly code: ErrorCode = 'ROLLBACK_NOT_SAFE'
  readonly status = 422

  constructor() {
    super('observacao de rollback indisponivel')
    this.name = 'RollbackObservationUnavailableError'
  }
}

/** Porta fechada de observação de rollback (fail closed, sem I/O). */
export function createClosedRollbackPlanningPort(): RollbackPlanningPort {
  return {
    observe: () => Promise.reject(new RollbackObservationUnavailableError()),
  }
}

export interface RollbackPlanInput {
  readonly operation: Operation
  readonly observation: RollbackObservation
  readonly preserveData: boolean
  readonly now: Date
}

/**
 * Monta o plano de rollback (fase 1) com hash próprio.
 *
 * Ownership/drift não comprovados, ação vazia ou ação fora do vocabulário
 * canônico recusam o plano (`ROLLBACK_NOT_SAFE`) em vez de produzi-lo.
 */
export function buildRollbackPlan(input: RollbackPlanInput): RollbackPlan {
  const { operation, observation, preserveData, now } = input

  if (!observation.ownership_verified) {
    throw new RollbackUnsafeError('ownership nao comprovado', [
      { reason: 'ownership_not_verified' },
    ])
  }
  if (observation.drift_findings.length > 0) {
    throw new RollbackUnsafeError('drift detectado', [
      { reason: 'drift_detected' },
      { reason: `drift_count_${observation.drift_findings.length}` },
    ])
  }
  if (
    typeof observation.observed_revision !== 'string' ||
    observation.observed_revision.length === 0 ||
    observation.observed_revision.length > 128
  ) {
    throw new RollbackUnsafeError('revisao observada ausente', [
      { reason: 'observed_revision_missing' },
    ])
  }
  if (
    observation.actions.length === 0 ||
    observation.actions.length > ROLLBACK_ACTION_LIMIT
  ) {
    throw new RollbackUnsafeError('plano de rollback vazio ou acima do teto', [
      { reason: 'action_count_out_of_range' },
    ])
  }

  const actions = observation.actions.map((action) =>
    Object.freeze({ ...action }),
  )
  const destructive =
    !preserveData || actions.some((action) => action.risk === 'destructive')
  const expiresAt = new Date(
    now.getTime() + PLAN_TTL_SECONDS * 1000,
  ).toISOString()
  const hash = rollbackPlanHash({
    operation,
    actions,
    preserveData,
    destructive,
    observedRevision: observation.observed_revision,
    expiresAt,
  })

  return Object.freeze(
    rollbackPlanSchema.parse({
      rollback_plan_hash: hash,
      actions,
      preserve_data: preserveData,
      destructive,
      ownership_verified: true,
      observed_revision: observation.observed_revision,
      approval: null,
      expires_at: expiresAt,
    }),
  ) as RollbackPlan
}

/** Hash canônico do plano de rollback (cobre alvo, ações e prazo). */
function rollbackPlanHash(input: {
  readonly operation: Operation
  readonly actions: ReadonlyArray<PlannedAction>
  readonly preserveData: boolean
  readonly destructive: boolean
  readonly observedRevision: string
  readonly expiresAt: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        algorithm: 'pcv2-rollback-plan-v1',
        operation_id: input.operation.operation_id,
        project_id: input.operation.project_id,
        environment: input.operation.environment,
        driver: input.operation.driver,
        plan_hash: input.operation.plan_hash,
        actions: input.actions,
        preserve_data: input.preserveData,
        destructive: input.destructive,
        observed_revision: input.observedRevision,
        expires_at: input.expiresAt,
      }),
    )
    .digest('hex')
}

export interface RollbackApprovalInput {
  readonly operation: Operation
  readonly rollbackPlan: RollbackPlan | null
  readonly actor: PolicyActorClaims
  readonly expectedRevision: number
  readonly request: RollbackApprovalRequest
  readonly ownership: OperationOwnership | null
  readonly now: Date
  readonly generateId: () => string
}

export interface RollbackApprovalDecision {
  readonly approval: RollbackApproval
  /** Plano reelevado com o novo `approval_id` gravado. */
  readonly rollbackPlan: RollbackPlan
}

/**
 * Avalia a aprovação do rollback (fase 2).
 *
 * Independente da aprovação de provisionamento: novo `approval_id`, vinculado
 * ao `rollback_plan_hash`, aprovador humano, diferente do solicitante do
 * rollback e do solicitante original da operação.
 */
export function evaluateRollbackApproval(
  input: RollbackApprovalInput,
): RollbackApprovalDecision {
  const { operation, rollbackPlan, request, now } = input

  if (rollbackPlan === null) {
    throw new RollbackUnsafeError('plano de rollback ausente', [
      { reason: 'rollback_plan_missing' },
    ])
  }
  if (Date.parse(rollbackPlan.expires_at) <= now.getTime()) {
    throw new ApprovalExpiredError('plano de rollback vencido', [
      { reason: 'rollback_plan_expired' },
    ])
  }

  const providedHash =
    request.decision === 'approve'
      ? request.rollback_plan_hash
      : rollbackPlan.rollback_plan_hash
  const segregation = evaluateApprovalSegregation({
    policy: 'destructive_rollback',
    approver: input.actor,
    requesterSubject: input.ownership?.rollback_requester_subject ?? undefined,
    originalRequesterSubject: input.ownership?.requester_subject,
    boundHash: rollbackPlan.rollback_plan_hash,
    providedHash,
  })
  assertDecisionAllowed(segregation, segregation.reasons)

  const rollbackRequester = input.ownership?.rollback_requester_subject
  if (
    input.ownership === null ||
    rollbackRequester === undefined ||
    rollbackRequester === null
  ) {
    throw new ApprovalSegregationError('solicitante do rollback desconhecido', [
      { reason: 'rollback_requester_unknown' },
    ])
  }

  // Vínculo ao `rollback_plan_hash` exato: mesma regra, mesmo dono
  // (`evaluateApprovalSegregation` acima) — nunca duplicada aqui.
  // A revisão precisa continuar sendo a mesma observada na ficha do cliente.
  transitionOperation(operation.state, 'rollback_pending', {
    actual: operation.operation_version,
    expected: input.expectedRevision,
  })

  if (request.decision === 'approve') {
    assertApprovalConfirmation(request.confirmation, {
      kind: 'rollback',
      projectId: operation.project_id,
      planHash: rollbackPlan.rollback_plan_hash,
    })
  }

  const { decidedAt, expiresAt } = approvalValidity(now)
  const approval = rollbackApprovalSchema.parse({
    approval_id: input.generateId(),
    decision: request.decision,
    actor_ref: actorRefFor(input.actor.subject ?? 'unknown'),
    rollback_plan_hash: rollbackPlan.rollback_plan_hash,
    decided_at: decidedAt,
    expires_at: expiresAt,
  })

  return Object.freeze({
    approval: Object.freeze(approval),
    rollbackPlan: Object.freeze({ ...rollbackPlan, approval }),
  })
}

/** Revalida a aprovação do rollback na fase 3 (`execute`). */
export function assertRollbackApprovalUsable(
  rollbackPlan: RollbackPlan | null,
  request: {
    readonly rollback_plan_hash: string
    readonly approval_id: string
  },
  now: Date,
): RollbackApproval {
  if (rollbackPlan === null) {
    throw new RollbackUnsafeError('plano de rollback ausente', [
      { reason: 'rollback_plan_missing' },
    ])
  }
  const approval = rollbackPlan.approval ?? null
  if (approval === null) {
    throw new ApprovalRequiredError('rollback sem aprovacao registrada', [
      { reason: 'rollback_approval_missing' },
    ])
  }
  if (approval.decision !== 'approve') {
    throw new ApprovalRequiredError('rollback rejeitado', [
      { reason: 'rollback_approval_rejected' },
    ])
  }
  if (request.rollback_plan_hash !== rollbackPlan.rollback_plan_hash) {
    throw new ApprovalHashMismatchError('rollback_plan_hash divergente', [
      { field: 'rollback_plan_hash', reason: 'rollback_plan_hash_mismatch' },
    ])
  }
  if (request.approval_id !== approval.approval_id) {
    throw new ApprovalRequiredError('approval_id divergente', [
      { field: 'approval_id', reason: 'approval_id_mismatch' },
    ])
  }
  if (Date.parse(approval.expires_at) <= now.getTime()) {
    throw new ApprovalExpiredError('aprovacao de rollback vencida', [
      { reason: 'rollback_approval_expired' },
    ])
  }
  if (Date.parse(rollbackPlan.expires_at) <= now.getTime()) {
    throw new ApprovalExpiredError('plano de rollback vencido', [
      { reason: 'rollback_plan_expired' },
    ])
  }
  return approval
}

// ---------------------------------------------------------------------------
// Projeção de leitura
// ---------------------------------------------------------------------------

export interface OperationProjectionSources {
  readonly operations: OperationStore
  readonly approvals: OperationApprovalStore
  readonly rollbackPlans: RollbackPlanStore
}

/**
 * Projeta a operação do contrato juntando os artefatos que vivem em stores
 * próprios (aprovação e plano de rollback). Nunca inclui campo extra: o
 * schema do contrato é estrito.
 */
export function createOperationProjection(
  sources: OperationProjectionSources,
): (operationId: string) => Operation | null {
  return (operationId: string): Operation | null => {
    const operation = sources.operations.get(operationId)
    if (operation === null) return null
    const approval = sources.approvals.get(operationId)
    const rollbackPlan = sources.rollbackPlans.get(operationId)
    return Object.freeze({
      ...operation,
      approval,
      rollback: rollbackPlan,
    })
  }
}

/** Plano efetivo da operação (para auditoria e respostas sanitizadas). */
export function operationPlan(operation: Operation): Plan {
  return operation.plan
}

/** Artefatos sanitizados da operação (sempre lista, nunca `undefined`). */
export function operationArtifacts(
  operation: Operation,
): ReadonlyArray<ArtifactRef> {
  return operation.artifacts ?? Object.freeze([])
}

/** Verificação registrada da operação (ou `null`). */
export function operationVerification(
  operation: Operation,
): Verification | null {
  return operation.verification ?? null
}
