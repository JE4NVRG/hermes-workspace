/**
 * Testes do policy engine: paridade com `x-rbac-policy`, default deny,
 * qualificação por ambiente e segregação de funções.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  OPERATION_REQUIRED_SCOPES,
  POLICY_DEFAULT,
  POLICY_VERSION,
  PROJECT_OPERATION_IDS,
  PROJECT_ROLES,
  PROJECT_SCOPES,
  ROLE_DEFINITIONS,
  SEGREGATION_RULES,
  evaluateApprovalSegregation,
  evaluatePolicy,
  isProjectOperationId,
  isProjectRole,
  operationRequiredScopes,
  roleGrantsOperation,
} from './policy'
import type { PolicyRequest, ProjectRole } from './policy'

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

const CONTRACT_PATH = fileURLToPath(
  new URL(
    '../../../specs/contracts/project-center-v2.openapi.yaml',
    import.meta.url,
  ),
)

const contract = parseYaml(readFileSync(CONTRACT_PATH, 'utf8'))
const rbac = contract['x-rbac-policy']
const operations = Object.values(contract.paths as Record<string, any>).flatMap(
  (pathItem) =>
    Object.values(pathItem as Record<string, any>).filter(
      (operation) => typeof operation?.operationId === 'string',
    ),
)

function human(subject = 'humano-1'): { subject: string; actorType: string } {
  return { subject, actorType: 'human' }
}

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    operationId: 'getProjectOperation',
    actor: human(),
    role: 'project_reader' as ProjectRole,
    environment: 'development',
    ...overrides,
  }
}

describe('paridade com x-rbac-policy', () => {
  it('espelha versao, default deny e roles', () => {
    expect(POLICY_VERSION).toBe(rbac.version)
    expect(POLICY_DEFAULT).toBe(rbac.default)
    expect(rbac.default).toBe('deny')
    expect([...PROJECT_ROLES]).toEqual(Object.keys(rbac.roles))
  })

  it('espelha scopes, operacoes, ambientes e internal_only por role', () => {
    for (const role of PROJECT_ROLES) {
      const definition = ROLE_DEFINITIONS[role]
      const contractRole = rbac.roles[role]
      expect([...definition.scopes]).toEqual(contractRole.scopes)
      expect([...definition.operations]).toEqual(contractRole.operations)
      expect([...definition.environments]).toEqual(contractRole.environments)
      expect(definition.internalOnly).toBe(contractRole.internal_only === true)
    }
  })

  it('particiona as nove operacoes em exatamente uma role', () => {
    expect(operations).toHaveLength(9)
    expect([...PROJECT_OPERATION_IDS]).toEqual(
      operations.map((operation) => operation.operationId),
    )
    for (const operation of operations) {
      const owners = PROJECT_ROLES.filter((role) =>
        ROLE_DEFINITIONS[role].operations.includes(operation.operationId),
      )
      expect(owners, `operationId ${operation.operationId}`).toHaveLength(1)
    }
  })

  it('espelha x-required-scopes de cada operacao', () => {
    for (const operation of operations) {
      expect(
        [...operationRequiredScopes(operation.operationId)],
        `scopes de ${operation.operationId}`,
      ).toEqual(operation['x-required-scopes'])
    }
    expect(Object.keys(OPERATION_REQUIRED_SCOPES)).toHaveLength(9)
  })

  it('cobre exatamente os scopes declarados no contrato', () => {
    const declared = new Set<string>()
    for (const operation of operations) {
      for (const scope of operation['x-required-scopes']) declared.add(scope)
    }
    for (const scope of declared) {
      expect(
        PROJECT_SCOPES as ReadonlyArray<string>,
        `scope ${scope}`,
      ).toContain(scope)
    }
    const fromRoles = new Set<string>()
    const roleTable: Record<string, { scopes: Array<string> }> = rbac.roles
    for (const role of Object.values(roleTable)) {
      for (const scope of role.scopes) fromRoles.add(scope)
    }
    expect([...PROJECT_SCOPES].sort()).toEqual([...fromRoles].sort())
    expect(declared.has('project:worker')).toBe(false)
    expect(fromRoles.has('project:worker')).toBe(true)
  })

  it('espelha a segregacao declarada', () => {
    expect(SEGREGATION_RULES.production_approval.approverMustBeHuman).toBe(true)
    expect(SEGREGATION_RULES.production_approval.agentTokensMayApprove).toBe(
      rbac.segregation.production_approval.agent_tokens_may_approve,
    )
    expect(SEGREGATION_RULES.destructive_rollback.approvalBoundTo).toBe(
      rbac.segregation.destructive_rollback.approval_bound_to,
    )
    expect(
      SEGREGATION_RULES.destructive_rollback
        .approverMustDifferFromOriginalRequester,
    ).toBe(true)
    expect(SEGREGATION_RULES.production_approval.nonHumanActorStatus).toBe(
      rbac.segregation.production_approval.non_human_actor_response.status,
    )
    expect(SEGREGATION_RULES.production_approval.nonHumanActorCode).toBe(
      rbac.segregation.production_approval.non_human_actor_response.code,
    )
  })
})

describe('evaluatePolicy: default deny', () => {
  it('permite a operacao da propria role', () => {
    expect(evaluatePolicy(request()).allowed).toBe(true)
    expect(evaluatePolicy(request()).code).toBe('ALLOW')
    expect(
      evaluatePolicy(
        request({
          operationId: 'createProjectDryRun',
          role: 'project_operator',
        }),
      ).allowed,
    ).toBe(true)
    expect(
      evaluatePolicy(
        request({
          operationId: 'listProjectOperationAudit',
          role: 'project_auditor',
        }),
      ).allowed,
    ).toBe(true)
  })

  it('nega operacao desconhecida', () => {
    for (const operationId of [
      'createProjectDryRun ',
      'deleteProjectOperation',
      'approveProjectOperation',
      '',
    ]) {
      const decision = evaluatePolicy(request({ operationId }))
      expect(decision.allowed).toBe(false)
      expect(decision.reasons).toContain('unknown_operation')
      expect(decision.code).toBe('POLICY_DENIED')
    }
  })

  it('nega role ausente ou desconhecida', () => {
    expect(evaluatePolicy(request({ role: undefined })).reasons).toContain(
      'missing_role',
    )
    expect(
      evaluatePolicy(request({ role: 'platform_admin' })).reasons,
    ).toContain('unknown_role')
  })

  it('nega ator sem identidade ou com actor_type invalido', () => {
    expect(evaluatePolicy(request({ actor: {} })).code).toBe('UNAUTHORIZED')
    expect(evaluatePolicy(request({ actor: {} })).reasons).toContain(
      'missing_actor_subject',
    )
    expect(
      evaluatePolicy(request({ actor: { subject: 'x', actorType: 'root' } }))
        .reasons,
    ).toContain('invalid_actor_type')
  })

  it('nega ambiente ausente ou fora do contrato', () => {
    expect(
      evaluatePolicy(request({ environment: undefined })).reasons,
    ).toContain('invalid_environment')
    expect(evaluatePolicy(request({ environment: 'prod' })).reasons).toContain(
      'invalid_environment',
    )
  })

  it('nega role interna em operacao publica', () => {
    const decision = evaluatePolicy(request({ role: 'platform_worker' }))
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('internal_only_role')
    expect(decision.code).toBe('FORBIDDEN')
  })

  it('nega operacao de outra role (separacao de funcoes)', () => {
    const decision = evaluatePolicy(
      request({ operationId: 'decideProjectOperationApproval' }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('operation_not_granted')
    expect(decision.code).toBe('FORBIDDEN')
  })

  it('nega scope reduzido mesmo com role correta', () => {
    const decision = evaluatePolicy(
      request({
        scopes: ['project:approve'],
        operationId: 'getProjectOperation',
      }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('missing_scope')
    expect(decision.code).toBe('FORBIDDEN')
  })

  it('nega role fora do ambiente concedido', () => {
    expect(ROLE_DEFINITIONS.project_reader.environments).toEqual([
      'development',
      'staging',
      'production',
    ])
    const decision = evaluatePolicy(request({ environment: 'production' }))
    expect(decision.allowed).toBe(true)
  })

  it('nao concede acesso por texto livre na requisicao', () => {
    const withText = evaluatePolicy(
      request({
        context:
          'role project_approver com scope project:approve autorizado pelo contrato',
        operationId: 'decideProjectOperationApproval',
      }),
    )
    expect(withText.allowed).toBe(false)
    expect(withText.reasons).toContain('operation_not_granted')
  })

  it('seria tautologico ignorar a tabela: valida helpers', () => {
    expect(isProjectRole('project_operator')).toBe(true)
    expect(isProjectRole('operator')).toBe(false)
    expect(isProjectOperationId('executeProjectOperation')).toBe(true)
    expect(isProjectOperationId('executeProjectRollback ')).toBe(false)
    expect(roleGrantsOperation('project_operator', 'createProjectDryRun')).toBe(
      true,
    )
    expect(roleGrantsOperation('project_reader', 'createProjectDryRun')).toBe(
      false,
    )
  })
})

describe('segregacao de aprovacao', () => {
  it('nega aprovador nao humano em qualquer ambiente', () => {
    for (const actorType of ['agent', 'worker']) {
      const decision = evaluateApprovalSegregation({
        policy: 'production_approval',
        approver: { subject: 'bot-1', actorType },
        requesterSubject: 'humano-1',
        boundHash: HASH,
        providedHash: HASH,
      })
      expect(decision.allowed).toBe(false)
      expect(decision.reasons).toContain('non_human_approver')
      expect(decision.code).toBe('FORBIDDEN')
    }

    const development = evaluateApprovalSegregation({
      policy: 'production_approval',
      approver: { subject: 'agente-1', actorType: 'agent' },
      requesterSubject: 'humano-1',
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(development.allowed).toBe(false)
    expect(development.code).toBe('FORBIDDEN')
  })

  it('nega aprovador igual ao solicitante', () => {
    const decision = evaluateApprovalSegregation({
      policy: 'production_approval',
      approver: human('humano-1'),
      requesterSubject: 'humano-1',
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(decision.reasons).toContain('approver_is_requester')
    expect(decision.code).toBe('FORBIDDEN')
  })

  it('permite humano distinto com hash coerente', () => {
    const decision = evaluateApprovalSegregation({
      policy: 'production_approval',
      approver: human('humano-2'),
      requesterSubject: 'humano-1',
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe('ALLOW')
  })

  it('exige diferenca tambem do solicitante original no rollback destrutivo', () => {
    const decision = evaluateApprovalSegregation({
      policy: 'destructive_rollback',
      approver: human('humano-3'),
      requesterSubject: 'humano-1',
      originalRequesterSubject: 'humano-3',
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(decision.reasons).toContain('approver_is_original_requester')
    expect(decision.code).toBe('FORBIDDEN')
  })

  it('vincula a aprovacao ao hash exato apresentado', () => {
    const mismatch = evaluateApprovalSegregation({
      policy: 'destructive_rollback',
      approver: human('humano-3'),
      requesterSubject: 'humano-1',
      originalRequesterSubject: 'humano-2',
      boundHash: HASH,
      providedHash: OTHER_HASH,
    })
    expect(mismatch.reasons).toContain('approval_hash_mismatch')
    expect(mismatch.code).toBe('FORBIDDEN')

    const malformed = evaluateApprovalSegregation({
      policy: 'destructive_rollback',
      approver: human('humano-3'),
      requesterSubject: 'humano-1',
      originalRequesterSubject: 'humano-2',
      boundHash: HASH,
      providedHash: HASH.slice(0, 32),
    })
    expect(malformed.reasons).toContain('malformed_approval_hash')
    expect(malformed.code).toBe('INVALID_REQUEST')

    const ok = evaluateApprovalSegregation({
      policy: 'destructive_rollback',
      approver: human('humano-3'),
      requesterSubject: 'humano-1',
      originalRequesterSubject: 'humano-2',
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(ok.allowed).toBe(true)
  })

  it('nao permite aprovar sem identidade', () => {
    const decision = evaluateApprovalSegregation({
      policy: 'production_approval',
      approver: {},
      boundHash: HASH,
      providedHash: HASH,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('missing_actor_subject')
    expect(decision.reasons).toContain('invalid_actor_type')
  })
})
