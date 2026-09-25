/**
 * Worker de outbox do Project Center v2 (PR 6).
 *
 * Fonte da verdade: plano §PR 6 (passo 2), spec §9/§14 e ADR 0001.
 *
 * O worker consome **somente** outbox aprovada e revalida, antes de qualquer
 * ação: flag do worker, identidade do plano (hash), aprovação vigente,
 * `observed_revision` fresca, estado da operação, lease exclusivo com fencing
 * token e — para rollback — aprovação de rollback e ownership observado.
 *
 * Invariantes:
 * - com o worker desligado **nada** acontece: nenhum adapter é chamado e o
 *   outbox fica intacto;
 * - retry só para erro transitório e com teto de tentativas; erro definitivo
 *   leva a operação direto para `manual_intervention_required`;
 * - dependências são respeitadas por ordenação topológica (ciclo recusa o
 *   plano inteiro, nada é executado fora de ordem);
 * - publicação só acontece depois de health + isolamento + backup/restore
 *   PASS; sem publisher injetado a operação **não** é dada como concluída;
 * - o lease é sempre liberado no fim (sucesso, falha ou exceção);
 * - a identidade do worker (`holder_ref`) é **por processo** (`pid` + id
 *   aleatório por instância); nunca uma constante compartilhável, de modo que
 *   duas réplicas não apresentem o mesmo fencing token (§9);
 * - nenhuma saída carrega segredo: só nomes derivados e detalhes já
 *   sanitizados pelo executor.
 */
import { randomUUID } from 'node:crypto'
import { requireWorkerActive } from './feature-flags'
import { leaseScopeKey } from './lease-store'
import {
  NAMING_VERSION,
  appRoleNameFor,
  buildNamingSnapshot,
  dataStoreNameFor,
  localBackupPrefixFor,
  networkNameFor,
  ownershipMarkerFor,
  r2PrefixFor,
} from './naming'
import { DRIVERS } from './domain'
import {
  assertApprovalUsable,
  assertRollbackApprovalUsable,
  buildRollbackPlan,
} from './approval-service'
import type { ResourceNamingSnapshot } from './naming'
import type {
  Approval,
  Driver,
  Environment,
  Operation,
  PlannedAction,
  RollbackPlan,
} from './domain'
import type { ProjectCenterV2Flags } from './feature-flags'
import type { OperationStore } from './operation-store'
import type { OutboxEntry, OutboxStore } from './idempotency'
import type {
  OperationApprovalStore,
  RollbackPlanStore,
} from './approval-service'
import type { LeaseGrant, LeaseStore } from './lease-store'
import type {
  ActionExecutor,
  ActionOutcome,
  DriverContextFields,
  ExecutionEndpoint,
} from './executors/action-executor'
import type { OwnedResource, RollbackService } from './rollback-service'

export const WORKER_VERSION = 'pcv2-worker-v1'
/** Teto de tentativas por entrada do outbox (retry só de erro transitório). */
export const WORKER_MAX_ATTEMPTS = 3
/** Backoff entre tentativas, em segundos (tentativa 2, 3). */
export const WORKER_BACKOFF_SECONDS: ReadonlyArray<number> = [30, 120]
/** Teto de entradas processadas por tick. */
export const WORKER_BATCH_LIMIT = 10
/** TTL do lease de execução. */
export const WORKER_LEASE_TTL_SECONDS = 900
/** Ações que compõem a verificação antes da publicação. */
export const VERIFICATION_ACTION_KINDS: ReadonlyArray<PlannedAction['kind']> = [
  'health_check',
  'verify_cross_isolation',
  'verify_backup_restore',
]
/** Estados em que uma operação pode executar o plano. */
export const EXECUTABLE_STATES: ReadonlyArray<Operation['state']> = [
  'queued',
  'executing',
  'approved',
]
/** Estados em que uma operação pode ser verificada/publicada. */
export const VERIFIABLE_STATES: ReadonlyArray<Operation['state']> = [
  'verifying',
  'executing',
  'queued',
]

/**
 * Diário de conclusão do worker.
 *
 * O outbox do PR 3/4 é uma fila append-only (`state: 'pending'` imutável e só
 * `discard` como remoção): quem acompanha o ciclo de vida do item é o worker.
 * Sem este diário o mesmo item seria reprocessado a cada tick e o replay
 * repetiria efeito — exatamente o que a spec §9 proíbe.
 */
export interface WorkerOutboxJournal {
  readonly isCompleted: (outboxId: string) => boolean
  readonly complete: (outboxId: string) => void
}

/** Diário em memória do processo do worker. */
export function createInMemoryOutboxJournal(): WorkerOutboxJournal {
  const completed = new Set<string>()
  return {
    isCompleted: (outboxId) => completed.has(outboxId),
    complete: (outboxId) => {
      completed.add(outboxId)
    },
  }
}

export class WorkerConfigurationError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly reason: string

  constructor(reason: string) {
    super('worker mal configurado')
    this.name = 'WorkerConfigurationError'
    this.reason = reason
  }
}

/** Plano inconsistente (nomes derivados divergentes ou ciclo de dependências). */
export class WorkerPlanError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly reason: string

  constructor(reason: string) {
    super('plano invalido para o worker')
    this.name = 'WorkerPlanError'
    this.reason = reason
  }
}

/** Revalidação falhou: a entrada não pode ser executada nesta passagem. */
export class WorkerRevalidationError extends Error {
  readonly code:
    | 'POLICY_DENIED'
    | 'INVALID_REQUEST'
    | 'PLAN_STALE'
    | 'APPROVAL_REQUIRED'
  readonly reason: string

  constructor(code: WorkerRevalidationError['code'], reason: string) {
    super('entrada de outbox nao revalidada')
    this.name = 'WorkerRevalidationError'
    this.code = code
    this.reason = reason
  }
}

/** Adapter de topologia/endpoint por driver (injetado; nada hardcoded aqui). */
export interface WorkerActionContextPort {
  readonly adapter_id: string
  resolve: (input: {
    readonly operation: Operation
    readonly naming: ResourceNamingSnapshot
  }) => Promise<{
    readonly hostTarget: string
    readonly endpoint: ExecutionEndpoint
    readonly templateId?: string
    readonly profileId?: string
    readonly peerDatabase?: string
    readonly restoreDatabase?: string
    /** Bytes do artefato já conferido contra o checksum (restore efémero). */
    readonly restorePayloadBase64?: string
    readonly driverFields?: DriverContextFields
  }>
}

/** Porta de observação fresca usada nas revalidações. */
export interface WorkerObservationPort {
  readonly adapter_id: string
  /** Revisão observada agora (deve ser igual à do plano no momento do execute). */
  observe: (input: { readonly operation: Operation }) => Promise<{
    readonly revision: string
  }>
  /** Inventário observado com proveniência, usado no rollback. */
  ownedResources: (input: {
    readonly operation: Operation
  }) => Promise<ReadonlyArray<OwnedResource>>
}

/** Publicação idempotente após verificação comprovada. */
export interface WorkerPublisherPort {
  readonly adapter_id: string
  publish: (input: {
    readonly operation: Operation
    readonly checks: ReadonlyArray<{
      readonly name: string
      readonly outcome: string
    }>
  }) => Promise<{ readonly published: boolean; readonly safe_detail: string }>
}

export interface WorkerDeps {
  readonly flags: ProjectCenterV2Flags
  readonly operations: OperationStore
  /** Aprovação da operação (PR 4/5): lida do store, nunca do payload. */
  readonly approvals: OperationApprovalStore
  /** Plano de rollback aprovado (PR 5), por operação. */
  readonly rollbackPlans: RollbackPlanStore
  readonly outbox: OutboxStore
  /** Diário de conclusão (default: em memória, por processo do worker). */
  readonly journal?: WorkerOutboxJournal
  readonly leases: LeaseStore
  readonly actions: ActionExecutor
  readonly observations: WorkerObservationPort
  readonly context: WorkerActionContextPort
  readonly publisher: WorkerPublisherPort
  readonly rollback: RollbackService
  readonly holderRef?: string
  readonly now?: () => Date
}

export interface WorkerEntryResult {
  readonly outbox_id: string
  readonly kind: OutboxEntry['kind']
  readonly operation_id: string
  readonly status: 'processed' | 'failed' | 'skipped'
  readonly state: Operation['state'] | null
  readonly attempts: number
  readonly safe_detail: string
  /** Checks observados no item de verificação (prova pública do tique). */
  readonly checks?: ReadonlyArray<{
    readonly name: string
    readonly outcome: string
  }>
}

export interface WorkerRunResult {
  readonly entries: ReadonlyArray<WorkerEntryResult>
  readonly published: number
  readonly safe_detail: string
}

export interface Worker {
  readonly version: string
  readonly holder_ref: string
  runOnce: () => Promise<WorkerRunResult>
  /** Estado interno de tentativas (upload durável é responsabilidade do adapter). */
  attempts: (outboxId: string) => number
}

// ---------------------------------------------------------------------------
// Derivação de naming a partir do plano
// ---------------------------------------------------------------------------

function nameFrom(
  actions: ReadonlyArray<PlannedAction>,
  prefix: string,
): string | null {
  const match = actions.find((action) => action.target_ref.startsWith(prefix))
  if (match === undefined) return null
  return match.target_ref.slice(prefix.length).split('#')[0] ?? null
}

/**
 * Reconstrói o snapshot de naming a partir dos alvos do próprio plano e
 * **valida** a coerência interna (app role derivada do database; network e
 * data store derivados do compose project). Plano divergente é recusado.
 */
export function deriveNamingFromPlan(input: {
  readonly plan: { readonly actions: ReadonlyArray<PlannedAction> }
  readonly projectId: string
  readonly environment: Environment
  readonly driver: Driver
}): ResourceNamingSnapshot {
  const actions = input.plan.actions
  const database = nameFrom(actions, 'database:')
  if (database === null) {
    throw new WorkerPlanError('database_ausente_no_plano')
  }
  const role = nameFrom(actions, 'role:') ?? nameFrom(actions, 'app-role:')
  const stack =
    nameFrom(actions, 'stack:') ?? nameFrom(actions, 'compose-project:')
  const network = nameFrom(actions, 'network:')
  const store = nameFrom(actions, 'data-store:')

  // `project_id` é `client_id-slug`: o split é ambíguo em teoria, então cada
  // candidato é reconstruído pelo naming canônico e só é aceite se bater com
  // os alvos do próprio plano. Zero candidatos ou mais de um: recusa fechada.
  const candidates: Array<ResourceNamingSnapshot> = []
  for (let index = 1; index < input.projectId.length - 1; index += 1) {
    if (input.projectId[index] !== '-') continue
    let snapshot: ResourceNamingSnapshot
    try {
      snapshot = buildNamingSnapshot({
        client_id: input.projectId.slice(0, index),
        project_slug: input.projectId.slice(index + 1),
        environment: input.environment,
        driver: input.driver,
      })
    } catch {
      continue
    }
    if (snapshot.database !== database) continue
    if (role !== null && role !== snapshot.app_role) continue
    if (role !== null && snapshot.app_role !== appRoleNameFor(database))
      continue
    if (stack !== null && snapshot.compose_project !== stack) continue
    if (
      network !== null &&
      snapshot.network !== networkNameFor(snapshot.compose_project)
    )
      continue
    if (
      store !== null &&
      snapshot.data_store !== dataStoreNameFor(snapshot.compose_project)
    )
      continue
    candidates.push(snapshot)
  }

  if (candidates.length === 0) {
    throw new WorkerPlanError('naming_nao_reconstruivel_do_plano')
  }
  if (candidates.length > 1) {
    throw new WorkerPlanError('naming_ambiguo_no_plano')
  }

  const resolved = candidates[0]
  return Object.freeze({
    ...resolved,
    naming_version: NAMING_VERSION,
    local_backup_prefix: localBackupPrefixFor({
      project_id: input.projectId,
      environment: input.environment,
    }),
    r2_prefix: r2PrefixFor({
      project_id: input.projectId,
      environment: input.environment,
    }),
    ownership_marker: ownershipMarkerFor({
      project_id: input.projectId,
      driver: input.driver,
      environment: input.environment,
    }),
  })
}

/** Ordem topológica das ações; ciclo recusa o plano (nada roda fora de ordem). */
export function orderActionsByDependency(
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<PlannedAction> {
  const byId = new Map(
    actions.map((action) => [action.action_id, action] as const),
  )
  const pending = new Map(byId)
  const done = new Set<string>()
  const ordered: Array<PlannedAction> = []

  while (pending.size > 0) {
    const cycle = { stuck: true }
    for (const action of actions) {
      if (!pending.has(action.action_id)) continue
      const ready = action.dependencies.every(
        (dependency) => done.has(dependency) || !byId.has(dependency),
      )
      if (!ready) continue
      ordered.push(action)
      pending.delete(action.action_id)
      done.add(action.action_id)
      cycle.stuck = false
    }
    if (cycle.stuck) {
      throw new WorkerPlanError('dependencia_ciclica_no_plano')
    }
  }
  return Object.freeze(ordered)
}

// ---------------------------------------------------------------------------
// Revalidação
// ---------------------------------------------------------------------------

export interface RevalidationInput {
  readonly entry: OutboxEntry
  readonly operation: Operation
  readonly approval: Approval | null
  readonly rollbackPlan: RollbackPlan | null
  readonly flags: ProjectCenterV2Flags
  readonly observedRevision: string
  readonly now: Date
}

/**
 * Revalida tudo que o worker exige antes de tocar no mundo. Devolve o motivo
 * em caso de recusa, nunca executa por aproximação.
 *
 * Decisão registrada (O2 do cross-review de Security do PR 6): o passo 2 do
 * plano pede revalidação de "policy" antes de cada ação, mas o caminho de
 * execução **não** chama o policy engine nem relê `policy_version`. O
 * enforcement é estrutural e está ancorado aqui: (a) catálogo fechado de ações
 * e de templates no executor — `kind`/`target_ref` fora do contrato morrem
 * antes de qualquer adapter; (b) a aprovação é vinculada ao `plan_hash`, que
 * cobre `policy_version` do plano aprovado (divergência de hash recusa a
 * entrada acima); (c) `observed_revision` do momento da execução tem de ser a
 * do plano; (d) estado da operação e lease exclusivo com fencing token atual.
 * Acrescentar um check de `policy_version` em runtime exigiria injetar o
 * policy engine no worker — fora do escopo do PR 6 e sem ganho enquanto a
 * aprovação continuar amarrada ao hash do plano.
 */
export function revalidateEntry(input: RevalidationInput): void {
  requireWorkerActive(input.flags)
  const { entry, operation } = input
  if (entry.operation_id !== operation.operation_id) {
    throw new WorkerRevalidationError('INVALID_REQUEST', 'operacao_divergente')
  }
  if (entry.plan_hash !== operation.plan_hash) {
    throw new WorkerRevalidationError('INVALID_REQUEST', 'plan_hash_divergente')
  }
  if (
    entry.project_id !== operation.project_id ||
    entry.environment !== operation.environment
  ) {
    throw new WorkerRevalidationError('INVALID_REQUEST', 'escopo_divergente')
  }
  if (
    operation.observed_revision !== undefined &&
    operation.observed_revision !== input.observedRevision
  ) {
    // Recurso mudou desde o plano: exige nova observação/aprovação.
    throw new WorkerRevalidationError(
      'PLAN_STALE',
      'observed_revision_divergente',
    )
  }
  if (entry.kind === 'execute') {
    if (!EXECUTABLE_STATES.includes(operation.state)) {
      throw new WorkerRevalidationError(
        'INVALID_REQUEST',
        'estado_nao_executavel',
      )
    }
    assertApprovalUsable(operation, input.approval, input.now)
  }
  if (entry.kind === 'verify' && !VERIFIABLE_STATES.includes(operation.state)) {
    throw new WorkerRevalidationError(
      'INVALID_REQUEST',
      'estado_nao_verificavel',
    )
  }
  if (entry.kind === 'rollback_execute') {
    const plan = input.rollbackPlan
    if (plan === null) {
      throw new WorkerRevalidationError(
        'INVALID_REQUEST',
        'plano_de_rollback_ausente',
      )
    }
    if (plan.approval === null || plan.approval === undefined) {
      throw new WorkerRevalidationError(
        'APPROVAL_REQUIRED',
        'rollback_sem_aprovacao',
      )
    }
    assertRollbackApprovalUsable(
      plan,
      {
        rollback_plan_hash: plan.rollback_plan_hash,
        approval_id: plan.approval.approval_id,
      },
      input.now,
    )
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function createWorker(deps: WorkerDeps): Worker {
  const now = deps.now ?? (() => new Date())
  /**
   * Identidade **do processo** do worker (§9).
   *
   * O default é único por instância (`pid` + id aleatório): uma constante
   * reaproveitável permitiria a duas réplicas (ou a dois ticks sobrepostos)
   * apresentarem o mesmo `holder_ref`/`fencing_token` e entregarem o mesmo
   * DDL/destrutivo duas vezes sem que o fencing detectasse — é o F1 do
   * cross-review de Security. Com identidade por instância, a segunda passagem
   * recebe `409 OPERATION_LOCKED` do store.
   */
  const holderRef = deps.holderRef ?? `${process.pid}-${randomUUID()}`
  const attemptCounts = new Map<string, number>()
  const inFlight = new Set<string>()
  const journal = deps.journal ?? createInMemoryOutboxJournal()
  /**
   * Leases adquiridos por **esta** instância, por escopo. Serve só como prova
   * de posse para o retry do próprio processo (o `lease_id` nunca sai daqui
   * para outro processo) — nunca como identidade compartilhável.
   */
  const ownedLeases = new Map<string, LeaseGrant>()

  /**
   * Aquisição com prova de posse: se esta instância já detém o lease do
   * escopo, o retry apresenta o `lease_id` que recebeu (reaquisição idempotente
   * sem token novo); sem essa prova o store recusa com 409, que é o que
   * acontece com qualquer outro processo.
   */
  function acquireLease(operation: Operation): LeaseGrant {
    const scopeKey = leaseScopeKey({
      projectId: operation.project_id,
      environment: operation.environment,
    })
    const owned = ownedLeases.get(scopeKey)
    const proof =
      owned !== undefined && owned.operation_id === operation.operation_id
        ? owned.lease_id
        : undefined
    const lease = deps.leases.acquire({
      operationId: operation.operation_id,
      projectId: operation.project_id,
      environment: operation.environment,
      holderRef,
      ...(proof === undefined ? {} : { leaseId: proof }),
    })
    ownedLeases.set(scopeKey, lease)
    return lease
  }

  /** Libera o lease da passagem; a posse local é esquecida em qualquer caso. */
  function releaseLease(lease: LeaseGrant): void {
    try {
      deps.leases.release({
        leaseId: lease.lease_id,
        fencingToken: lease.fencing_token,
        holderRef,
      })
    } catch {
      // Lease já expirado/liberado: nada a compensar aqui.
    } finally {
      ownedLeases.delete(lease.scope_key)
    }
  }

  function attemptsFor(entry: OutboxEntry): number {
    return attemptCounts.get(entry.outbox_id) ?? entry.attempt
  }

  /** Agenda a próxima tentativa (usada só quando o erro é transitório). */
  function scheduleRetry(entry: OutboxEntry): void {
    attemptCounts.set(entry.outbox_id, attemptsFor(entry) + 1)
  }

  /**
   * Encadeia o item de verificação da operação: idempotente pelo `outbox_id`
   * determinístico e pela ausência de verificação aberta para a operação.
   */
  function enqueueVerifyEntry(entry: OutboxEntry): void {
    const alreadyOpen = deps.outbox
      .listFor(entry.operation_id)
      .some(
        (item) =>
          item.kind === 'verify' && !journal.isCompleted(item.outbox_id),
      )
    if (alreadyOpen) return
    deps.outbox.append({
      operationId: entry.operation_id,
      kind: 'verify',
      planHash: entry.plan_hash,
      projectId: entry.project_id,
      environment: entry.environment,
      outboxId: `verify:${entry.operation_id}`,
    })
  }

  /**
   * Escalada para intervenção manual percorrendo as arestas canónicas: de
   * `failed` ou `queued`/`approved` a máquina só chega a
   * `manual_intervention_required` passando por `executing`.
   */
  function escalateToManualIntervention(operation: Operation): Operation {
    let current = operation
    if (current.state === 'failed') {
      current = deps.operations.transition(
        current.operation_id,
        'queued',
        current.operation_version,
      )
    }
    if (current.state === 'queued' || current.state === 'approved') {
      current = deps.operations.transition(
        current.operation_id,
        'executing',
        current.operation_version,
      )
    }
    if (current.state === 'executing' || current.state === 'verifying') {
      current = deps.operations.transition(
        current.operation_id,
        'manual_intervention_required',
        current.operation_version,
      )
    }
    return current
  }

  async function runActions(input: {
    readonly operation: Operation
    readonly naming: ResourceNamingSnapshot
    readonly actions: ReadonlyArray<PlannedAction>
    readonly keep: (action: PlannedAction) => boolean
  }): Promise<{
    readonly outcomes: ReadonlyArray<ActionOutcome>
    readonly failed: ActionOutcome | null
  }> {
    const observedRevision = input.operation.observed_revision
    if (observedRevision === undefined) {
      throw new WorkerRevalidationError(
        'INVALID_REQUEST',
        'observed_revision_ausente',
      )
    }
    const contextPort = await deps.context.resolve({
      operation: input.operation,
      naming: input.naming,
    })
    const lease = acquireLease(input.operation)
    const outcomes: Array<ActionOutcome> = []
    try {
      for (const action of input.actions) {
        if (!input.keep(action)) continue
        const outcome = await deps.actions.execute({
          action,
          context: {
            operationId: input.operation.operation_id,
            projectId: input.operation.project_id,
            environment: input.operation.environment,
            driver: input.operation.driver,
            host_target: contextPort.hostTarget,
            observedRevision,
            naming: input.naming,
            completedActionIds: outcomes
              .filter((entry) => entry.status !== 'failed')
              .map((entry) => entry.action_id),
            lease: {
              leaseId: lease.lease_id,
              fencingToken: lease.fencing_token,
              holderRef,
            },
            endpoint: contextPort.endpoint,
            ...(contextPort.templateId === undefined
              ? {}
              : { templateId: contextPort.templateId }),
            ...(contextPort.profileId === undefined
              ? {}
              : { profileId: contextPort.profileId }),
            ...(contextPort.peerDatabase === undefined
              ? {}
              : { peerDatabase: contextPort.peerDatabase }),
            ...(contextPort.restoreDatabase === undefined
              ? {}
              : { restoreDatabase: contextPort.restoreDatabase }),
            ...(contextPort.restorePayloadBase64 === undefined
              ? {}
              : { restorePayloadBase64: contextPort.restorePayloadBase64 }),
            ...(contextPort.driverFields === undefined
              ? {}
              : { driverFields: contextPort.driverFields }),
          },
          observedRevision,
        })
        outcomes.push(outcome)
        if (outcome.status === 'failed') {
          return { outcomes: Object.freeze(outcomes), failed: outcome }
        }
      }
      return { outcomes: Object.freeze(outcomes), failed: null }
    } finally {
      // O lease nunca sobrevive à passagem, com ou sem falha.
      releaseLease(lease)
    }
  }

  /**
   * Leva a operação até `executing` pelas arestas canónicas
   * (`approved -> queued -> executing`), sem atalhos.
   */
  function enterExecuting(operation: Operation): Operation {
    let current = operation
    if (current.state === 'approved') {
      current = deps.operations.transition(
        current.operation_id,
        'queued',
        current.operation_version,
      )
    }
    if (current.state === 'queued') {
      current = deps.operations.transition(
        current.operation_id,
        'executing',
        current.operation_version,
      )
    }
    return current
  }

  async function processExecute(
    entry: OutboxEntry,
    operation: Operation,
  ): Promise<WorkerEntryResult> {
    const naming = deriveNamingFromPlan({
      plan: operation.plan,
      projectId: operation.project_id,
      environment: operation.environment,
      driver: operation.driver,
    })
    const ordered = orderActionsByDependency(operation.plan.actions)

    // 1. approved -> queued -> executing antes de qualquer side effect
    //    (a tabela canónica não permite approved -> executing direto).
    const current = enterExecuting(operation)

    const { outcomes, failed } = await runActions({
      operation: current,
      naming,
      actions: ordered,
      keep: (action) => !VERIFICATION_ACTION_KINDS.includes(action.kind),
    })

    if (failed !== null) {
      const retryable = failed.failure?.retryable === true
      const attempts = attemptsFor(entry)
      if (retryable && attempts < WORKER_MAX_ATTEMPTS) {
        scheduleRetry(entry)
        // Volta para `failed` e re-enfileira (`failed -> queued`): retry só de
        // erro transitório, com teto em WORKER_MAX_ATTEMPTS.
        const failedState =
          current.state === 'executing'
            ? deps.operations.transition(
                operation.operation_id,
                'failed',
                current.operation_version,
              )
            : current
        const requeued =
          failedState.state === 'failed'
            ? deps.operations.transition(
                operation.operation_id,
                'queued',
                failedState.operation_version,
              )
            : failedState
        return {
          outbox_id: entry.outbox_id,
          kind: entry.kind,
          operation_id: operation.operation_id,
          status: 'skipped',
          state: requeued.state,
          attempts,
          safe_detail: `retry agendado (tentativa ${attempts + 1}/${WORKER_MAX_ATTEMPTS})`,
        }
      }
      const next = escalateToManualIntervention(current)
      return {
        outbox_id: entry.outbox_id,
        kind: entry.kind,
        operation_id: operation.operation_id,
        status: 'failed',
        state: next.state,
        attempts,
        safe_detail: `falha definitiva em ${failed.action_id}`,
      }
    }

    // 2. executing -> verifying (a publicação só acontece após PASS).
    const verifying =
      current.state === 'executing'
        ? deps.operations.transition(
            operation.operation_id,
            'verifying',
            current.operation_version,
          )
        : current
    return {
      outbox_id: entry.outbox_id,
      kind: entry.kind,
      operation_id: operation.operation_id,
      status: 'processed',
      state: verifying.state,
      attempts: attemptsFor(entry),
      safe_detail: `executadas ${outcomes.length} acoes`,
    }
  }

  async function processVerify(
    entry: OutboxEntry,
    operation: Operation,
  ): Promise<WorkerEntryResult> {
    const naming = deriveNamingFromPlan({
      plan: operation.plan,
      projectId: operation.project_id,
      environment: operation.environment,
      driver: operation.driver,
    })
    const verificationActions = orderActionsByDependency(
      operation.plan.actions,
    ).filter((action) => VERIFICATION_ACTION_KINDS.includes(action.kind))
    if (verificationActions.length === 0) {
      // Sem prova de health/isolamento/restore não há publicação.
      const next = escalateToManualIntervention(operation)
      return {
        outbox_id: entry.outbox_id,
        kind: entry.kind,
        operation_id: operation.operation_id,
        status: 'failed',
        state: next.state,
        attempts: attemptsFor(entry),
        safe_detail: 'verificacao ausente no plano',
      }
    }

    const { outcomes, failed } = await runActions({
      operation,
      naming,
      actions: verificationActions,
      keep: () => true,
    })
    const checks = outcomes.map((outcome) => ({
      name: outcome.kind,
      outcome: outcome.status,
    }))

    if (failed !== null) {
      const attempts = attemptsFor(entry)
      if (
        failed.failure?.retryable === true &&
        attempts < WORKER_MAX_ATTEMPTS
      ) {
        scheduleRetry(entry)
        return {
          outbox_id: entry.outbox_id,
          kind: entry.kind,
          operation_id: operation.operation_id,
          status: 'skipped',
          state: operation.state,
          attempts,
          safe_detail: `retry de verificacao (tentativa ${attempts + 1}/${WORKER_MAX_ATTEMPTS})`,
        }
      }
      const next = escalateToManualIntervention(operation)
      return {
        outbox_id: entry.outbox_id,
        kind: entry.kind,
        operation_id: operation.operation_id,
        status: 'failed',
        state: next.state,
        attempts,
        safe_detail: `verificacao falhou em ${failed.action_id}`,
      }
    }

    // 3. publicação idempotente só depois de PASS; sem publisher não conclui.
    const published = await deps.publisher.publish({ operation, checks })
    if (published.published !== true) {
      return {
        outbox_id: entry.outbox_id,
        kind: entry.kind,
        operation_id: operation.operation_id,
        status: 'skipped',
        state: operation.state,
        attempts: attemptsFor(entry),
        safe_detail: 'publicacao pendente',
      }
    }
    const next =
      operation.state === 'verifying'
        ? deps.operations.transition(
            operation.operation_id,
            'succeeded',
            operation.operation_version,
          )
        : operation
    return {
      outbox_id: entry.outbox_id,
      kind: entry.kind,
      operation_id: operation.operation_id,
      status: 'processed',
      state: next.state,
      attempts: attemptsFor(entry),
      safe_detail: `publicado apos ${checks.length} verificacoes`,
      checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    }
  }

  async function processRollback(
    entry: OutboxEntry,
    operation: Operation,
    rollbackPlan: RollbackPlan,
  ): Promise<WorkerEntryResult> {
    const observation = await deps.rollback.planning.observe(operation, {
      preserveData: rollbackPlan.preserve_data,
    })
    const resources = await deps.observations.ownedResources({ operation })
    const executionPlan = deps.rollback.planExecution({
      operation,
      rollbackPlan,
      observation,
      resources,
      now: now(),
    })

    // Estado vai para rolling_back antes de qualquer remoção.
    let current = operation
    if (current.state !== 'rolling_back') {
      if (current.state !== 'rollback_pending') {
        current = deps.operations.transition(
          operation.operation_id,
          'rollback_pending',
          current.operation_version,
        )
      }
      current = deps.operations.transition(
        operation.operation_id,
        'rolling_back',
        current.operation_version,
      )
    }

    const naming = deriveNamingFromPlan({
      plan: current.plan,
      projectId: current.project_id,
      environment: current.environment,
      driver: current.driver,
    })
    const contextPort = await deps.context.resolve({
      operation: current,
      naming,
    })
    const lease = acquireLease(current)
    let result: Awaited<ReturnType<RollbackService['execute']>>
    try {
      result = await deps.rollback.execute({
        operation: current,
        rollbackPlan,
        plan: executionPlan,
        environment: current.environment,
        driver: current.driver,
        host_target: contextPort.hostTarget,
        observedRevision: observation.observed_revision,
        naming,
        lease: {
          leaseId: lease.lease_id,
          fencingToken: lease.fencing_token,
          holderRef,
        },
        endpoint: contextPort.endpoint,
      })
    } finally {
      releaseLease(lease)
    }

    const next = deps.operations.transition(
      operation.operation_id,
      result.aborted ? 'manual_intervention_required' : 'rolled_back',
      current.operation_version,
    )
    return {
      outbox_id: entry.outbox_id,
      kind: entry.kind,
      operation_id: operation.operation_id,
      status: result.aborted ? 'failed' : 'processed',
      state: next.state,
      attempts: attemptsFor(entry),
      safe_detail: result.safe_detail,
    }
  }

  async function runOnce(): Promise<WorkerRunResult> {
    requireWorkerActive(deps.flags)
    const pending = deps.outbox
      .list()
      .filter(
        (entry) =>
          !inFlight.has(entry.outbox_id) &&
          !journal.isCompleted(entry.outbox_id),
      )
      .slice(0, WORKER_BATCH_LIMIT)

    const results: Array<WorkerEntryResult> = []
    let published = 0
    for (const entry of pending) {
      inFlight.add(entry.outbox_id)
      try {
        const operation = deps.operations.get(entry.operation_id)
        if (operation === null) {
          results.push({
            outbox_id: entry.outbox_id,
            kind: entry.kind,
            operation_id: entry.operation_id,
            status: 'skipped',
            state: null,
            attempts: attemptsFor(entry),
            safe_detail: 'operacao inexistente',
          })
          continue
        }
        const observed = await deps.observations.observe({ operation })
        const approval = deps.approvals.get(operation.operation_id)
        const rollbackPlan = deps.rollbackPlans.get(operation.operation_id)
        revalidateEntry({
          entry,
          operation,
          approval,
          rollbackPlan,
          flags: deps.flags,
          observedRevision: observed.revision,
          now: now(),
        })
        const result =
          entry.kind === 'execute'
            ? await processExecute(entry, operation)
            : entry.kind === 'verify'
              ? await processVerify(entry, operation)
              : await processRollback(
                  entry,
                  operation,
                  rollbackPlan as RollbackPlan,
                )
        if (result.state === 'succeeded') published += 1
        // Terminal: item concluído (sucesso ou escalada manual) sai da fila.
        if (result.status === 'processed' || result.status === 'failed') {
          journal.complete(entry.outbox_id)
        }
        // Execução bem-sucedida encadeia a verificação (PR 6 §14).
        if (entry.kind === 'execute' && result.state === 'verifying') {
          enqueueVerifyEntry(entry)
        }
        results.push(result)
      } catch (error) {
        const reason =
          error instanceof WorkerRevalidationError
            ? error.reason
            : error instanceof WorkerPlanError
              ? error.reason
              : error instanceof WorkerConfigurationError
                ? error.reason
                : error instanceof Error &&
                    typeof (error as { reason?: unknown }).reason === 'string'
                  ? `${error.name}:${String((error as { reason?: unknown }).reason)}`
                  : error instanceof Error && error.name.length > 0
                    ? error.name
                    : 'erro_na_execucao'
        const attempts = attemptsFor(entry)
        const exhausted = attempts >= WORKER_MAX_ATTEMPTS
        if (exhausted) {
          const operation = deps.operations.get(entry.operation_id)
          if (operation !== null) {
            escalateToManualIntervention(operation)
          }
        } else {
          scheduleRetry(entry)
        }
        results.push({
          outbox_id: entry.outbox_id,
          kind: entry.kind,
          operation_id: entry.operation_id,
          status: 'skipped',
          state: null,
          attempts,
          safe_detail: `nao executado: ${reason}`,
        })
      } finally {
        inFlight.delete(entry.outbox_id)
      }
    }

    return Object.freeze({
      entries: Object.freeze(results),
      published,
      safe_detail: `worker ${WORKER_VERSION}: ${results.length} entradas avaliadas`,
    })
  }

  return {
    version: WORKER_VERSION,
    holder_ref: holderRef,
    runOnce,
    attempts: (outboxId: string) => attemptCounts.get(outboxId) ?? 0,
  }
}

void DRIVERS
void buildRollbackPlan
