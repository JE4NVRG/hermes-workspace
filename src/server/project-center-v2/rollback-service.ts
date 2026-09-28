/**
 * Serviço de rollback do Project Center v2 (PR 6).
 *
 * Fonte da verdade: plano §PR 6 (passo 11) e spec §8.4.
 *
 * Este módulo **não** inventa plano de rollback: o plano vem do PR 5
 * (`buildRollbackPlan`), assinado por hash e (quando destrutivo) aprovado. Aqui
 * implementa-se a metade que falta no PR 6:
 *
 * 1. uma porta de observação de rollback **real** (`RollbackPlanningPort`), que
 *    lê o inventário observado e decide, recurso a recurso, se pode ser
 *    revertido — com `ownership_verified` e `drift_findings` calculados;
 * 2. o planeamento de execução: das ações do plano aprovado, quais podem
 *    correr agora, em que ordem, e quais vão para intervenção manual.
 *
 * Invariantes:
 * - **nunca** se apaga o que a operação não criou: só entram recursos com
 *   `created_by_operation_id` igual ao da operação, marker de ownership
 *   compatível e observação fresca;
 * - recurso **preexistente** é sempre preservado (nunca é alvo de drop);
 * - **drift** (recurso recriado por outra operação, marker divergente,
 *   revisão observada diferente da do plano) → `manual_intervention`, sem
 *   execução;
 * - **produção** exige aprovação de rollback válida (decisão `approve`, não
 *   expirada) além do plano; sem isso, o rollback é recusado;
 * - nenhuma ação fora do plano (hash) é executada, e a ordem é sempre
 *   `disable_resource` (stack/network) antes de `drop_resource_created_by_operation`
 *   (database/role/data store);
 * - a primeira falha **interrompe** o rollback: nunca se continua a apagar
 *   às cegas depois de um erro.
 */
import { requireWorkerActive } from './feature-flags'
import { DRIVERS, SHA256_PATTERN } from './domain'
import { executionChannelFor } from './executors/action-executor'
import { buildRollbackPlan } from './approval-service'
import type {
  ActionExecutor,
  ActionLeaseProof,
  ActionOutcome,
} from './executors/action-executor'
import type {
  Driver,
  Environment,
  Operation,
  PlannedAction,
  RollbackPlan,
} from './domain'
import type { ResourceNamingSnapshot } from './naming'
import type { ProjectCenterV2Flags } from './feature-flags'
import type { LeaseStore } from './lease-store'
import type {
  RollbackObservation,
  RollbackPlanningPort,
} from './approval-service'

export const ROLLBACK_SERVICE_VERSION = 'pcv2-rollback-v1'
/** Recursos que são desativados antes de qualquer drop. */
export const DISABLE_FIRST_PREFIXES: ReadonlyArray<string> = [
  'stack:',
  'compose-project:',
  'network:',
  'data-store:',
]
/** Ações aceitas num rollback deste serviço. */
export const ROLLBACK_EXECUTABLE_KINDS: ReadonlyArray<PlannedAction['kind']> = [
  'disable_resource',
  'drop_resource_created_by_operation',
]
/** Recursos proibidos como alvo de rollback (nunca apagar por atacado). */
export const FORBIDDEN_ROLLBACK_TARGETS: ReadonlyArray<RegExp> = [
  /\*/,
  /^database:postgres$/,
  /^role:postgres$/,
  /^database:template[01]$/,
]

export class RollbackServiceError extends Error {
  readonly code:
    | 'POLICY_DENIED'
    | 'INVALID_REQUEST'
    | 'ROLLBACK_NOT_SAFE'
    | 'MANUAL_INTERVENTION_REQUIRED'
  readonly reason: string

  constructor(code: RollbackServiceError['code'], reason: string) {
    super('rollback recusado')
    this.name = 'RollbackServiceError'
    this.code = code
    this.reason = reason
  }
}

/** Recurso observado no inventário, com a proveniência da criação. */
export interface OwnedResource {
  readonly target_ref: string
  readonly resource_name: string
  readonly project_id: string
  readonly environment: Environment
  readonly driver: Driver
  readonly ownership_marker: string | null
  /** Operação que criou o recurso (marker/registry); `null` quando desconhecido. */
  readonly created_by_operation_id: string | null
  readonly exists: boolean
}

/** Observação crua do adapter (read-only). */
export interface RollbackObservationPort {
  readonly adapter_id: string
  observe: (input: {
    readonly operation: Operation
    readonly desiredTargetRefs: ReadonlyArray<string>
  }) => Promise<{
    readonly resources: ReadonlyArray<OwnedResource>
    readonly observed_revision: string
    readonly drift_findings: ReadonlyArray<string>
  }>
}

export interface RollbackServiceDeps {
  readonly flags: ProjectCenterV2Flags
  readonly leases: LeaseStore
  readonly observations: RollbackObservationPort
  readonly actions: ActionExecutor
  readonly now?: () => Date
}

/** Decisão por recurso do plano. */
export type RollbackResourceDecision =
  | 'execute'
  | 'skip_already_gone'
  | 'manual'

export interface RollbackExecutionStep {
  readonly action: PlannedAction
  readonly decision: RollbackResourceDecision
  readonly reason: string
}

export interface RollbackExecutionPlan {
  readonly executable: ReadonlyArray<PlannedAction>
  readonly skipped: ReadonlyArray<{ target_ref: string; reason: string }>
  readonly manual: ReadonlyArray<{ target_ref: string; reason: string }>
  readonly requires_manual_intervention: boolean
  readonly safe_detail: string
}

export interface RollbackExecutionResult {
  readonly completed: ReadonlyArray<ActionOutcome>
  readonly failed_action_id: string | null
  readonly aborted: boolean
  readonly safe_detail: string
}

export interface RollbackService {
  readonly version: string
  /** Porta de observação pronta para o PR 5 (`RollbackPlanningPort`). */
  readonly planning: RollbackPlanningPort
  planExecution: (input: {
    readonly operation: Operation
    readonly rollbackPlan: RollbackPlan
    readonly observation: RollbackObservation
    readonly resources: ReadonlyArray<OwnedResource>
    readonly now?: Date
  }) => RollbackExecutionPlan
  execute: (input: {
    readonly operation: Operation
    readonly rollbackPlan: RollbackPlan
    readonly plan: RollbackExecutionPlan
    readonly environment: Environment
    readonly driver: Driver
    readonly host_target: string
    readonly observedRevision: string
    readonly naming: ResourceNamingSnapshot
    readonly lease: ActionLeaseProof
    readonly endpoint: { readonly host: string; readonly port: number }
  }) => Promise<RollbackExecutionResult>
}

function assertOperationId(value: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 64) {
    throw new RollbackServiceError('INVALID_REQUEST', 'operation_id')
  }
  return value
}

function prefixOf(targetRef: string): string {
  const index = targetRef.indexOf(':')
  return index === -1 ? '' : targetRef.slice(0, index + 1)
}

/** `true` quando o recurso tem de ser desativado antes de qualquer drop. */
export function isDisableFirstTarget(targetRef: string): boolean {
  return DISABLE_FIRST_PREFIXES.includes(prefixOf(targetRef))
}

/** Ordena as ações: disable primeiro, mantendo a ordem relativa do plano. */
export function orderRollbackActions(
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<PlannedAction> {
  const disable = actions.filter(
    (action) =>
      action.kind === 'disable_resource' ||
      isDisableFirstTarget(action.target_ref),
  )
  const drop = actions.filter(
    (action) =>
      !(
        action.kind === 'disable_resource' ||
        isDisableFirstTarget(action.target_ref)
      ),
  )
  return [...disable, ...drop]
}

export function assertRollbackActionShape(
  action: PlannedAction,
): PlannedAction {
  const untrusted = action as unknown as { readonly target_ref?: unknown }
  if (
    typeof untrusted.target_ref !== 'string' ||
    action.target_ref.length === 0
  ) {
    throw new RollbackServiceError('INVALID_REQUEST', 'target_ref_ausente')
  }
  if (
    FORBIDDEN_ROLLBACK_TARGETS.some((pattern) =>
      pattern.test(action.target_ref),
    )
  ) {
    // Alvo curinga/global: rollback nunca apaga por atacado.
    throw new RollbackServiceError('POLICY_DENIED', 'target_forbidden')
  }
  if (
    !(ROLLBACK_EXECUTABLE_KINDS as ReadonlyArray<string>).includes(action.kind)
  ) {
    throw new RollbackServiceError('POLICY_DENIED', 'kind_not_rollbackable')
  }
  // Canal fechado: kind sem canal conhecido nunca chega ao executor.
  executionChannelFor(action.kind)
  return action
}

export function createRollbackService(
  deps: RollbackServiceDeps,
): RollbackService {
  const now = deps.now ?? (() => new Date())

  const planning: RollbackPlanningPort = {
    async observe(operation, options) {
      requireWorkerActive(deps.flags)
      const observed = await deps.observations.observe({
        operation,
        desiredTargetRefs: [],
      })

      const resources = observed.resources
      const drift: Array<string> = [...observed.drift_findings]
      const actions: Array<PlannedAction> = []

      for (const resource of resources) {
        if (!resource.exists) continue
        const owned =
          resource.project_id === operation.project_id &&
          resource.environment === operation.environment &&
          resource.driver === operation.driver &&
          resource.ownership_marker !== null &&
          resource.created_by_operation_id === operation.operation_id
        if (!owned) {
          drift.push(
            `ownership_nao_comprovado:${prefixOf(resource.target_ref)}`,
          )
          continue
        }
        const disableTarget = isDisableFirstTarget(resource.target_ref)
        actions.push(
          Object.freeze({
            action_id: `act_rb_disable_${actions.length}`.slice(0, 64),
            kind: disableTarget
              ? ('disable_resource' as const)
              : ('drop_resource_created_by_operation' as const),
            target_ref: resource.target_ref,
            risk: 'destructive' as const,
            reversible: false,
            dependencies: [],
          }),
        )
      }

      return Object.freeze({
        actions: Object.freeze(actions),
        observed_revision: observed.observed_revision,
        ownership_verified: drift.length === 0,
        drift_findings: Object.freeze(drift),
      })
    },
  }

  function planExecution(input: {
    readonly operation: Operation
    readonly rollbackPlan: RollbackPlan
    readonly observation: RollbackObservation
    readonly resources: ReadonlyArray<OwnedResource>
    readonly now?: Date
  }): RollbackExecutionPlan {
    const operation = input.operation
    const plan = input.rollbackPlan
    assertOperationId(operation.operation_id)

    // 1. o plano tem de ser íntegro e amarrar observação + ownership.
    const untrustedPlan = plan as unknown as {
      readonly rollback_plan_hash?: unknown
      readonly ownership_verified?: unknown
    }
    if (
      typeof untrustedPlan.rollback_plan_hash !== 'string' ||
      !SHA256_PATTERN.test(plan.rollback_plan_hash)
    ) {
      throw new RollbackServiceError(
        'INVALID_REQUEST',
        'rollback_plan_hash_invalido',
      )
    }
    if (untrustedPlan.ownership_verified !== true) {
      throw new RollbackServiceError(
        'ROLLBACK_NOT_SAFE',
        'ownership_nao_comprovado',
      )
    }
    if (input.observation.observed_revision !== plan.observed_revision) {
      // Plano construído sobre outra revisão: exige nova observação/aprovação.
      throw new RollbackServiceError(
        'MANUAL_INTERVENTION_REQUIRED',
        'drift_de_revisao',
      )
    }
    if (input.observation.drift_findings.length > 0) {
      throw new RollbackServiceError(
        'MANUAL_INTERVENTION_REQUIRED',
        'drift_detectado',
      )
    }

    // 2. produção exige aprovação válida e não expirada.
    const reference = input.now ?? now()
    if (operation.environment === 'production') {
      const approval = plan.approval
      if (
        approval === undefined ||
        approval === null ||
        approval.decision !== 'approve'
      ) {
        throw new RollbackServiceError(
          'POLICY_DENIED',
          'producao_exige_aprovacao_de_rollback',
        )
      }
      if (new Date(approval.expires_at).getTime() <= reference.getTime()) {
        throw new RollbackServiceError(
          'POLICY_DENIED',
          'aprovacao_de_rollback_expirada',
        )
      }
    }

    // 3. nunca executar ação que não esteja no plano aprovado.
    const planned = new Map(
      plan.actions.map((action) => [action.action_id, action] as const),
    )
    const observed = new Map(
      input.resources.map(
        (resource) => [resource.target_ref, resource] as const,
      ),
    )

    const executable: Array<PlannedAction> = []
    const skipped: Array<{ target_ref: string; reason: string }> = []
    const manual: Array<{ target_ref: string; reason: string }> = []

    for (const action of orderRollbackActions(plan.actions)) {
      const fromPlan = planned.get(action.action_id)
      if (fromPlan === undefined) {
        throw new RollbackServiceError('INVALID_REQUEST', 'acao_fora_do_plano')
      }
      assertRollbackActionShape(action)

      const resource = observed.get(action.target_ref)
      if (resource === undefined || !resource.exists) {
        // Já não existe: nada a apagar (idempotente, não é falha).
        skipped.push({ target_ref: action.target_ref, reason: 'already_gone' })
        continue
      }
      if (
        resource.created_by_operation_id !== null &&
        resource.created_by_operation_id !== operation.operation_id
      ) {
        manual.push({
          target_ref: action.target_ref,
          reason: 'ownership_de_outra_operacao',
        })
        continue
      }
      if (resource.created_by_operation_id === null) {
        // Sem proveniência de criação: nunca é apagado (pode ser preexistente).
        manual.push({
          target_ref: action.target_ref,
          reason: 'preexistente_ou_sem_marker',
        })
        continue
      }
      if (
        resource.project_id !== operation.project_id ||
        resource.environment !== operation.environment ||
        resource.driver !== operation.driver ||
        resource.ownership_marker === null
      ) {
        manual.push({
          target_ref: action.target_ref,
          reason: 'ownership_divergente',
        })
        continue
      }
      executable.push(action)
    }

    const requiresManual = manual.length > 0
    return Object.freeze({
      executable: Object.freeze(executable),
      skipped: Object.freeze(skipped),
      manual: Object.freeze(manual),
      requires_manual_intervention: requiresManual,
      safe_detail: `rollback planejado: executar=${executable.length} pulado=${skipped.length} manual=${manual.length}`,
    })
  }

  return {
    version: ROLLBACK_SERVICE_VERSION,
    planning,
    planExecution,

    async execute(input): Promise<RollbackExecutionResult> {
      requireWorkerActive(deps.flags)
      if (input.plan.requires_manual_intervention) {
        // Há recursos sem ownership comprovado: não se executa nada e escala.
        throw new RollbackServiceError(
          'MANUAL_INTERVENTION_REQUIRED',
          'recursos_sem_ownership_comprovado',
        )
      }
      if (input.plan.executable.length === 0) {
        return Object.freeze({
          completed: Object.freeze([]),
          failed_action_id: null,
          aborted: false,
          safe_detail: 'rollback sem acoes executaveis',
        })
      }

      const completed: Array<ActionOutcome> = []
      for (const action of input.plan.executable) {
        // Nada de continuação cega: a primeira falha interrompe o rollback.
        try {
          const outcome = await deps.actions.execute({
            action,
            context: {
              operationId: input.operation.operation_id,
              projectId: input.operation.project_id,
              environment: input.environment,
              driver: input.driver,
              host_target: input.host_target,
              observedRevision: input.observedRevision,
              naming: input.naming,
              completedActionIds: completed.map((entry) => entry.action_id),
              lease: input.lease,
              endpoint: input.endpoint,
            },
            observedRevision: input.observedRevision,
          })
          completed.push(outcome)
          if (outcome.status === 'failed') {
            return Object.freeze({
              completed: Object.freeze(completed),
              failed_action_id: outcome.action_id,
              aborted: true,
              safe_detail: `rollback interrompido em ${outcome.action_id}`,
            })
          }
        } catch (error) {
          return Object.freeze({
            completed: Object.freeze(completed),
            failed_action_id: action.action_id,
            aborted: true,
            safe_detail: `rollback interrompido em ${action.action_id}: ${
              error instanceof RollbackServiceError
                ? error.reason
                : 'erro_de_execucao'
            }`,
          })
        }
      }

      return Object.freeze({
        completed: Object.freeze(completed),
        failed_action_id: null,
        aborted: false,
        safe_detail: `rollback concluido: ${completed.length} acoes`,
      })
    },
  }
}

/** Reexporta a construção do plano (PR 5) para o worker ter um único import. */
export { buildRollbackPlan }
export type {
  RollbackObservation,
  RollbackPlanningPort,
} from './approval-service'

void DRIVERS
