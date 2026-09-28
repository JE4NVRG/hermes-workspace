/**
 * Policy engine puro do Project Center v2 (PR 1).
 *
 * Espelha `x-rbac-policy` do contrato: default deny, cinco roles, scopes por
 * `operationId`, qualificação por ambiente e segregação de funções. Descrições
 * textuais, comentários e qualquer outro texto livre nunca concedem acesso —
 * apenas a tabela canônica abaixo decide.
 *
 * Sem I/O: nenhum banco, nenhum cache de token, nenhum secret.
 */
import { ACTOR_TYPES, ENVIRONMENTS } from './domain'

export const POLICY_VERSION = 'pcv2-rbac-v1'
export const POLICY_DEFAULT = 'deny'

export const PROJECT_OPERATION_IDS = [
  'createProjectDryRun',
  'decideProjectOperationApproval',
  'executeProjectOperation',
  'getProjectOperation',
  'verifyProjectOperation',
  'createProjectRollbackDryRun',
  'decideProjectRollbackApproval',
  'executeProjectRollback',
  'listProjectOperationAudit',
] as const
export type ProjectOperationId = (typeof PROJECT_OPERATION_IDS)[number]

export const PROJECT_SCOPES = [
  'project:read',
  'project:plan',
  'project:execute',
  'project:verify',
  'project:rollback',
  'project:approve',
  'project:audit',
  'project:worker',
] as const
export type ProjectScope = (typeof PROJECT_SCOPES)[number]

export const PROJECT_ROLES = [
  'project_reader',
  'project_operator',
  'project_approver',
  'project_auditor',
  'platform_worker',
] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

/** Scopes exigidos por operação (`x-required-scopes`). */
export const OPERATION_REQUIRED_SCOPES: Readonly<
  Record<ProjectOperationId, ReadonlyArray<ProjectScope>>
> = Object.freeze({
  createProjectDryRun: ['project:plan'],
  decideProjectOperationApproval: ['project:approve'],
  executeProjectOperation: ['project:execute'],
  verifyProjectOperation: ['project:verify'],
  getProjectOperation: ['project:read'],
  createProjectRollbackDryRun: ['project:rollback'],
  decideProjectRollbackApproval: ['project:approve'],
  executeProjectRollback: ['project:rollback'],
  listProjectOperationAudit: ['project:audit'],
})

export interface RoleDefinition {
  readonly scopes: ReadonlyArray<ProjectScope>
  readonly operations: ReadonlyArray<ProjectOperationId>
  readonly environments: ReadonlyArray<string>
  readonly internalOnly: boolean
}

/** Tabela canônica de roles. Operação fora desta lista é negada por padrão. */
export const ROLE_DEFINITIONS: Readonly<Record<ProjectRole, RoleDefinition>> =
  Object.freeze({
    project_reader: {
      scopes: ['project:read'],
      operations: ['getProjectOperation'],
      environments: [...ENVIRONMENTS],
      internalOnly: false,
    },
    project_operator: {
      scopes: [
        'project:plan',
        'project:execute',
        'project:verify',
        'project:rollback',
      ],
      operations: [
        'createProjectDryRun',
        'executeProjectOperation',
        'verifyProjectOperation',
        'createProjectRollbackDryRun',
        'executeProjectRollback',
      ],
      environments: [...ENVIRONMENTS],
      internalOnly: false,
    },
    project_approver: {
      scopes: ['project:approve'],
      operations: [
        'decideProjectOperationApproval',
        'decideProjectRollbackApproval',
      ],
      environments: [...ENVIRONMENTS],
      internalOnly: false,
    },
    project_auditor: {
      scopes: ['project:audit'],
      operations: ['listProjectOperationAudit'],
      environments: [...ENVIRONMENTS],
      internalOnly: false,
    },
    platform_worker: {
      scopes: ['project:worker'],
      operations: [],
      environments: [...ENVIRONMENTS],
      internalOnly: true,
    },
  })

export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === 'string' &&
    (PROJECT_ROLES as ReadonlyArray<string>).includes(value)
  )
}

export function isProjectOperationId(
  value: unknown,
): value is ProjectOperationId {
  return (
    typeof value === 'string' &&
    (PROJECT_OPERATION_IDS as ReadonlyArray<string>).includes(value)
  )
}

export function operationRequiredScopes(
  operationId: ProjectOperationId,
): ReadonlyArray<ProjectScope> {
  return OPERATION_REQUIRED_SCOPES[operationId]
}

export function roleGrantsOperation(
  role: ProjectRole,
  operationId: ProjectOperationId,
): boolean {
  return ROLE_DEFINITIONS[role].operations.includes(operationId)
}

export interface PolicyActorClaims {
  /** Claim `sub`: identidade do ator. */
  readonly subject?: string
  /** Claim `actor_type`: `human` | `agent` | `worker`. */
  readonly actorType?: string
}

export interface PolicyRequest {
  readonly operationId: string
  /** Claims do ator; ausente = requisição sem identidade (nega). */
  readonly actor?: PolicyActorClaims
  readonly role?: string | null
  /** Scopes concedidos ao token; ausente = derivado da role. */
  readonly scopes?: ReadonlyArray<string>
  readonly environment?: string
  /** Texto livre (descrição/comentário). Nunca concede acesso. */
  readonly context?: string
}

export type PolicyReason =
  | 'missing_actor_subject'
  | 'invalid_actor_type'
  | 'unknown_operation'
  | 'missing_role'
  | 'unknown_role'
  | 'invalid_environment'
  | 'internal_only_role'
  | 'operation_not_granted'
  | 'environment_not_granted'
  | 'missing_scope'

export type PolicyDecisionCode =
  | 'ALLOW'
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'POLICY_DENIED'
  | 'FORBIDDEN'

export interface PolicyDecision {
  readonly allowed: boolean
  readonly code: PolicyDecisionCode
  readonly reasons: ReadonlyArray<PolicyReason>
}

/** Precedência de decisão: autenticação, formato, policy, autorização. */
const DECISION_PRECEDENCE: ReadonlyArray<PolicyDecisionCode> = [
  'UNAUTHORIZED',
  'INVALID_REQUEST',
  'POLICY_DENIED',
  'FORBIDDEN',
]

function decide(reasons: ReadonlyArray<PolicyReason>): PolicyDecision {
  if (reasons.length === 0) {
    return { allowed: true, code: 'ALLOW', reasons: [] }
  }
  const code =
    DECISION_PRECEDENCE.find((candidate) =>
      reasons.some((reason) => REASON_CODES[reason] === candidate),
    ) ?? 'FORBIDDEN'
  return { allowed: false, code, reasons: [...reasons] }
}

/** Mapeamento fechado razão -> código de decisão. */
const REASON_CODES: Readonly<Record<PolicyReason, PolicyDecisionCode>> =
  Object.freeze({
    missing_actor_subject: 'UNAUTHORIZED',
    invalid_actor_type: 'UNAUTHORIZED',
    unknown_operation: 'POLICY_DENIED',
    missing_role: 'POLICY_DENIED',
    unknown_role: 'POLICY_DENIED',
    invalid_environment: 'POLICY_DENIED',
    internal_only_role: 'FORBIDDEN',
    operation_not_granted: 'FORBIDDEN',
    environment_not_granted: 'FORBIDDEN',
    missing_scope: 'FORBIDDEN',
  })

/**
 * Avalia uma requisição de operação pública contra a tabela canônica.
 *
 * Retorna todas as razões de negação (não fail-fast) para que a camada HTTP do
 * PR 4 possa reportar o motivo sem vazar detalhe sensível.
 *
 * `roleDefinitions` é a costura para **estreitar** a tabela (teste ou
 * deployment que restrinja uma role a menos ambientes). O default é a tabela
 * canônica do contrato — que lista os três ambientes em todas as roles, de
 * forma que `environment_not_granted` só é alcançável com uma tabela
 * injetada; o ramo fica coberto por teste em `policy.test.ts` em vez de virar
 * código morto silencioso.
 */
export function evaluatePolicy(
  request: PolicyRequest,
  roleDefinitions: Readonly<
    Record<ProjectRole, RoleDefinition>
  > = ROLE_DEFINITIONS,
): PolicyDecision {
  const reasons: Array<PolicyReason> = []

  const subject = request.actor?.subject
  if (typeof subject !== 'string' || subject.length === 0) {
    reasons.push('missing_actor_subject')
  }
  const actorType = request.actor?.actorType
  if (
    typeof actorType !== 'string' ||
    !(ACTOR_TYPES as ReadonlyArray<string>).includes(actorType)
  ) {
    reasons.push('invalid_actor_type')
  }

  if (!isProjectOperationId(request.operationId)) {
    reasons.push('unknown_operation')
  }
  if (request.role === undefined || request.role === null) {
    reasons.push('missing_role')
  } else if (!isProjectRole(request.role)) {
    reasons.push('unknown_role')
  }
  if (
    typeof request.environment !== 'string' ||
    !(ENVIRONMENTS as ReadonlyArray<string>).includes(request.environment)
  ) {
    reasons.push('invalid_environment')
  }

  if (reasons.length > 0 || !isProjectRole(request.role)) return decide(reasons)

  const role = request.role
  const definition = roleDefinitions[role]
  const operationId = request.operationId as ProjectOperationId
  const environment = request.environment as string
  const grantedScopes: ReadonlyArray<string> =
    request.scopes ?? definition.scopes

  if (definition.internalOnly) reasons.push('internal_only_role')
  if (!definition.operations.includes(operationId)) {
    reasons.push('operation_not_granted')
  }
  if (!definition.environments.includes(environment)) {
    reasons.push('environment_not_granted')
  }
  for (const scope of OPERATION_REQUIRED_SCOPES[operationId]) {
    if (!grantedScopes.includes(scope)) reasons.push('missing_scope')
  }

  return decide(reasons)
}

export const SEGREGATION_POLICIES = [
  'production_approval',
  'destructive_rollback',
] as const
export type SegregationPolicyName = (typeof SEGREGATION_POLICIES)[number]

export const SEGREGATION_RULES: Readonly<
  Record<
    SegregationPolicyName,
    {
      readonly approverMustBeHuman: boolean
      readonly agentTokensMayApprove: boolean
      readonly approvalBoundTo: string
      readonly approverMustDifferFromRequester: boolean
      readonly approverMustDifferFromOriginalRequester: boolean
      readonly nonHumanActorStatus: number
      readonly nonHumanActorCode: string
    }
  >
> = Object.freeze({
  production_approval: {
    approverMustBeHuman: true,
    agentTokensMayApprove: false,
    approvalBoundTo: 'plan_hash',
    approverMustDifferFromRequester: true,
    approverMustDifferFromOriginalRequester: false,
    nonHumanActorStatus: 403,
    nonHumanActorCode: 'FORBIDDEN',
  },
  destructive_rollback: {
    approverMustBeHuman: true,
    agentTokensMayApprove: false,
    approvalBoundTo: 'rollback_plan_hash',
    approverMustDifferFromRequester: true,
    approverMustDifferFromOriginalRequester: true,
    nonHumanActorStatus: 403,
    nonHumanActorCode: 'FORBIDDEN',
  },
})

export interface SegregationRequest {
  readonly policy: SegregationPolicyName
  /** Claims do aprovador; ausente = requisição sem identidade (nega). */
  readonly approver?: PolicyActorClaims
  /** Claim `sub` de quem solicitou a operação original. */
  readonly requesterSubject?: string
  /** Claim `sub` de quem solicitou o rollback (policy destrutiva). */
  readonly originalRequesterSubject?: string
  /** Hash ao qual a aprovação está vinculada (`plan_hash`/`rollback_plan_hash`). */
  readonly boundHash?: string
  /** Hash apresentado na requisição de aprovação. */
  readonly providedHash?: string
}

export type SegregationReason =
  | PolicyReason
  | 'non_human_approver'
  | 'approver_is_requester'
  | 'approver_is_original_requester'
  | 'malformed_approval_hash'
  | 'approval_hash_mismatch'

export interface SegregationDecision {
  readonly allowed: boolean
  readonly code: PolicyDecisionCode
  readonly reasons: ReadonlyArray<SegregationReason>
}

const SEGREGATION_REASON_CODES: Readonly<
  Record<SegregationReason, PolicyDecisionCode>
> = Object.freeze({
  missing_actor_subject: 'UNAUTHORIZED',
  invalid_actor_type: 'UNAUTHORIZED',
  unknown_operation: 'POLICY_DENIED',
  missing_role: 'POLICY_DENIED',
  unknown_role: 'POLICY_DENIED',
  invalid_environment: 'POLICY_DENIED',
  internal_only_role: 'FORBIDDEN',
  operation_not_granted: 'FORBIDDEN',
  environment_not_granted: 'FORBIDDEN',
  missing_scope: 'FORBIDDEN',
  non_human_approver: 'FORBIDDEN',
  approver_is_requester: 'FORBIDDEN',
  approver_is_original_requester: 'FORBIDDEN',
  malformed_approval_hash: 'INVALID_REQUEST',
  approval_hash_mismatch: 'FORBIDDEN',
})

function decideSegregation(
  reasons: ReadonlyArray<SegregationReason>,
): SegregationDecision {
  if (reasons.length === 0) return { allowed: true, code: 'ALLOW', reasons: [] }
  const code =
    DECISION_PRECEDENCE.find((candidate) =>
      reasons.some((reason) => SEGREGATION_REASON_CODES[reason] === candidate),
    ) ?? 'FORBIDDEN'
  return { allowed: false, code, reasons: [...reasons] }
}

/**
 * Segregação de funções para aprovações.
 *
 * Regras fechadas (as do contrato, sem exceção por ambiente):
 * - aprovador humano obrigatório; token de agente/worker responde 403
 *   `FORBIDDEN` sem side effect (`agent_tokens_may_approve: false`);
 * - aprovador difere do solicitante;
 * - no rollback destrutivo, difere também do solicitante original;
 * - a aprovação fica vinculada ao hash exato apresentado.
 */
export function evaluateApprovalSegregation(
  request: SegregationRequest,
): SegregationDecision {
  const reasons: Array<SegregationReason> = []
  const rules = SEGREGATION_RULES[request.policy]

  const subject = request.approver?.subject
  if (typeof subject !== 'string' || subject.length === 0) {
    reasons.push('missing_actor_subject')
  }
  const actorType = request.approver?.actorType
  if (
    typeof actorType !== 'string' ||
    !(ACTOR_TYPES as ReadonlyArray<string>).includes(actorType)
  ) {
    reasons.push('invalid_actor_type')
  } else if (actorType !== 'human') {
    reasons.push('non_human_approver')
  }

  if (typeof subject === 'string' && subject.length > 0) {
    if (rules.approverMustDifferFromRequester) {
      if (subject === request.requesterSubject)
        reasons.push('approver_is_requester')
    }
    if (rules.approverMustDifferFromOriginalRequester) {
      if (subject === request.originalRequesterSubject) {
        reasons.push('approver_is_original_requester')
      }
    }
  }

  const malformedHash =
    request.boundHash === undefined ||
    request.providedHash === undefined ||
    !/^[a-f0-9]{64}$/.test(request.boundHash) ||
    !/^[a-f0-9]{64}$/.test(request.providedHash)
  if (malformedHash) reasons.push('malformed_approval_hash')
  else if (request.boundHash !== request.providedHash) {
    reasons.push('approval_hash_mismatch')
  }

  return decideSegregation(reasons)
}
