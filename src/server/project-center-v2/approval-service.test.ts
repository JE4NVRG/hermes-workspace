/**
 * Testes do serviço de aprovação do Project Center v2 (PR 4).
 *
 * Provam as regras que o gate de Security exige no elo 4: aprovação vinculada
 * ao hash e à revisão, expiração, dupla pessoa em produção, segregação de ator
 * e rollback em três fases com hash próprio, novo `approval_id` e recusa por
 * ownership/drift.
 */
import { describe, expect, it } from 'vitest'
import { observedStateSchema } from './drivers/types'
import {
  POSTGRESQL_DRIVER_ID,
  POSTGRESQL_DRIVER_VERSION,
} from './drivers/postgresql-isolated'
import { resolveProjectCenterV2Flags } from './feature-flags'
import { buildNamingSnapshot } from './naming'
import { planProject } from './planner'
import {
  ApprovalConfirmationError,
  ApprovalExpiredError,
  ApprovalHashMismatchError,
  ApprovalRequiredError,
  ApprovalSegregationError,
  RollbackUnsafeError,
  actorRefFor,
  assertApprovalConfirmation,
  assertApprovalUsable,
  assertRollbackApprovalUsable,
  buildRollbackPlan,
  createInMemoryOperationApprovalStore,
  createInMemoryOperationOwnershipStore,
  createInMemoryRollbackPlanStore,
  createOperationProjection,
  evaluateOperationApproval,
  evaluateRollbackApproval,
  expectedApprovalConfirmation,
  expectedRollbackConfirmation,
} from './approval-service'
import { createInMemoryOperationStore } from './operation-store'
import { operationSchema, planSchema, rollbackPlanSchema } from './domain'
import type {
  ApprovalRequest,
  Operation,
  Plan,
  ProjectIntent,
  RollbackApprovalRequest,
  RollbackPlan,
} from './domain'
import type { OperationState } from './state-machine'
import type { RollbackObservation } from './approval-service'
import type { ObservedState } from './drivers/types'

const OBSERVED_AT = '2026-09-25T12:00:00.000Z'
const CLOCK = new Date('2026-09-25T12:05:00.000Z')
const LATER = new Date('2026-09-25T12:45:00.000Z')
const OPERATION_ID = '7c3d3e2a-4f5b-4a6c-9d1e-2b3c4d5e6f70'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
  description: 'site institucional',
  driver: 'postgresql_isolated',
  environment: 'development',
  host_target: 'vps-primary-local',
  capabilities: {
    auth: false,
    storage: false,
    realtime: false,
    postgrest: false,
    backup: true,
  },
}

const NAMING = buildNamingSnapshot({
  client_id: INTENT.client_id,
  project_slug: INTENT.project_slug,
  environment: INTENT.environment,
  driver: INTENT.driver,
})

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
})

const OBSERVED: ObservedState = observedStateSchema.parse({
  driver: POSTGRESQL_DRIVER_ID,
  driver_version: POSTGRESQL_DRIVER_VERSION,
  observer_version: 'pcv2-pg-observer-v1',
  host_target: INTENT.host_target,
  environment: INTENT.environment,
  project_id: NAMING.project_id,
  observed_at: OBSERVED_AT,
  revision: `obsrev_${'a'.repeat(32)}`,
  server_version: '16.13',
  database: {
    name: NAMING.database,
    exists: false,
    owner_role: null,
    ownership_marker: null,
    size_mb: null,
    is_template: false,
  },
  app_role: {
    name: NAMING.app_role,
    exists: false,
    can_login: false,
    is_superuser: false,
    can_create_db: false,
    can_create_role: false,
    can_replicate: false,
    bypass_rls: false,
    memberships: [],
  },
  privileges: [],
  extensions: [],
  disallowed_extensions: [],
  endpoint_masked: null,
  unsafe_findings: [],
  ownership_verified: false,
  backup_artifacts: [],
  warnings: [],
})

const CANONICAL = planProject({
  intent: INTENT,
  observed: OBSERVED,
  flags: FLAGS_ON,
})

const PROJECT_ID = CANONICAL.project_id
const PLAN_HASH = CANONICAL.plan_hash

function makeOperation(
  state: OperationState = 'awaiting_approval',
  overrides: Partial<Operation> = {},
): Operation {
  return operationSchema.parse({
    operation_id: OPERATION_ID,
    project_id: PROJECT_ID,
    driver: INTENT.driver,
    driver_version: CANONICAL.driver_version,
    environment: INTENT.environment,
    state,
    operation_version: state === 'planned' ? 1 : 2,
    plan_hash: PLAN_HASH,
    observed_revision: CANONICAL.observed_revision,
    plan: CANONICAL.plan,
    created_at: '2026-09-25T12:00:00.000Z',
    updated_at: '2026-09-25T12:01:00.000Z',
    expires_at: CANONICAL.expires_at,
    status_url: `/api/project-center/v2/operations/${OPERATION_ID}`,
    audit_url: `/api/project-center/v2/operations/${OPERATION_ID}/audit`,
    ...overrides,
  })
}

const HUMAN = 'user:ana@example.com'
const OTHER_HUMAN = 'user:bruno@example.com'
const AGENT = 'agent:automation@example.com'

const APPROVE: ApprovalRequest = {
  decision: 'approve',
  plan_hash: PLAN_HASH,
  confirmation: expectedApprovalConfirmation(PROJECT_ID, PLAN_HASH),
}

function rollbackObservation(
  overrides: Partial<RollbackObservation> = {},
): RollbackObservation {
  return {
    actions: CANONICAL.plan.actions,
    observed_revision: CANONICAL.observed_revision,
    ownership_verified: true,
    drift_findings: [],
    ...overrides,
  }
}

function withPlan(operation: Operation): Plan {
  return planSchema.parse(operation.plan)
}

describe('referência pública de ator', () => {
  it('usa digest estável e nunca o subject cru', () => {
    const ref = actorRefFor(HUMAN)
    expect(ref).toBe(actorRefFor(HUMAN))
    expect(ref).not.toBe(actorRefFor(OTHER_HUMAN))
    expect(ref).not.toContain('ana')
    expect(ref).toMatch(/^actor_[0-9a-f]{16,}$/)
  })
})

describe('frase de confirmação canônica', () => {
  it('aceita a frase do alvo exato', () => {
    expect(() =>
      assertApprovalConfirmation(
        expectedApprovalConfirmation(PROJECT_ID, PLAN_HASH),
        { kind: 'operation', projectId: PROJECT_ID, planHash: PLAN_HASH },
      ),
    ).not.toThrow()
  })

  it('recusa outro projeto, outro hash, outro tipo e forma malformada', () => {
    const cases: ReadonlyArray<[string, unknown]> = [
      ['outro projeto', `APROVAR outro-projeto ${PLAN_HASH.slice(0, 8)}`],
      ['outro hash', `APROVAR ${PROJECT_ID} ${'b'.repeat(8)}`],
      ['outro tipo', expectedRollbackConfirmation(PROJECT_ID, PLAN_HASH)],
      ['sem prefixo', `CONFIRMAR ${PROJECT_ID} ${PLAN_HASH.slice(0, 8)}`],
      ['ausente', undefined],
      ['frase livre', 'sim, pode aprovar'],
    ]
    for (const [label, confirmation] of cases) {
      expect(
        () =>
          assertApprovalConfirmation(confirmation, {
            kind: 'operation',
            projectId: PROJECT_ID,
            planHash: PLAN_HASH,
          }),
        label,
      ).toThrow(ApprovalConfirmationError)
    }
  })
})

describe('aprovação de provisionamento', () => {
  it('aprova vinculando hash, revisão e novo approval_id', () => {
    const decision = evaluateOperationApproval({
      operation: makeOperation(),
      actor: { subject: OTHER_HUMAN, actorType: 'human' },
      expectedRevision: 2,
      request: APPROVE,
      requesterSubject: HUMAN,
      now: CLOCK,
      generateId: () => '1f0b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    })
    expect(decision.next).toBe('approved')
    expect(decision.approval?.decision).toBe('approve')
    expect(decision.approval?.plan_hash).toBe(PLAN_HASH)
    expect(decision.approval?.approval_id).toBe(
      '1f0b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    )
    expect(decision.approval?.actor_ref).toBe(actorRefFor(OTHER_HUMAN))
    expect(decision.approval?.expires_at).toBe(
      new Date(CLOCK.getTime() + 900_000).toISOString(),
    )
  })

  it('rejeita com motivo e sem frase de aprovação', () => {
    const decision = evaluateOperationApproval({
      operation: makeOperation(),
      actor: { subject: OTHER_HUMAN, actorType: 'human' },
      expectedRevision: 2,
      request: { decision: 'reject', reason: 'custo acima do previsto' },
      requesterSubject: HUMAN,
      now: CLOCK,
      generateId: () => '2f0b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    })
    expect(decision.next).toBe('rejected')
    expect(decision.approval?.decision).toBe('reject')
  })

  it('recusa aprovador não humano (segregação de ator)', () => {
    expect(() =>
      evaluateOperationApproval({
        operation: makeOperation(),
        actor: { subject: AGENT, actorType: 'agent' },
        expectedRevision: 2,
        request: APPROVE,
        requesterSubject: HUMAN,
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalSegregationError)
  })

  it('recusa dupla pessoa no mesmo solicitante', () => {
    expect(() =>
      evaluateOperationApproval({
        operation: makeOperation(),
        actor: { subject: HUMAN, actorType: 'human' },
        expectedRevision: 2,
        request: APPROVE,
        requesterSubject: HUMAN,
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalSegregationError)
  })

  it('falha fechado quando o solicitante é desconhecido', () => {
    expect(() =>
      evaluateOperationApproval({
        operation: makeOperation(),
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: 2,
        request: APPROVE,
        requesterSubject: null,
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalSegregationError)
  })

  it('recusa hash divergente (segregação), revisão divergente e estado inválido', () => {
    // Hash divergente na decisão: a política do PR 1 trata como ato de
    // segregação — 403 FORBIDDEN, nunca aprovação.
    try {
      evaluateOperationApproval({
        operation: makeOperation(),
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: 2,
        request: {
          ...APPROVE,
          plan_hash: 'b'.repeat(64),
          confirmation: `APROVAR ${PROJECT_ID} ${'b'.repeat(8)}`,
        },
        requesterSubject: HUMAN,
        now: CLOCK,
        generateId: () => 'id',
      })
      throw new Error('hash divergente nao foi recusado')
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalSegregationError)
      expect((error as ApprovalSegregationError).code).toBe('FORBIDDEN')
      expect((error as ApprovalSegregationError).status).toBe(403)
      expect(
        (error as ApprovalSegregationError).details.map((d) => d.reason),
      ).toContain('approval_hash_mismatch')
    }

    // Revisão divergente (`If-Match` diferente da versão real) é PLAN_STALE.
    try {
      evaluateOperationApproval({
        operation: makeOperation(),
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: 1,
        request: APPROVE,
        requesterSubject: HUMAN,
        now: CLOCK,
        generateId: () => 'id',
      })
      throw new Error('revisao divergente nao foi recusada')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PLAN_STALE')
    }

    // Estado que não aceita decisão (`planned`) é transição inválida.
    try {
      evaluateOperationApproval({
        operation: makeOperation('planned'),
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: 1,
        request: APPROVE,
        requesterSubject: HUMAN,
        now: CLOCK,
        generateId: () => 'id',
      })
      throw new Error('estado invalido nao foi recusado')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_STATE_TRANSITION')
    }
  })

  it('vencido o plano, expira sem registrar aprovação', () => {
    const decision = evaluateOperationApproval({
      operation: makeOperation(),
      actor: { subject: OTHER_HUMAN, actorType: 'human' },
      expectedRevision: 2,
      request: APPROVE,
      requesterSubject: HUMAN,
      now: LATER,
      generateId: () => 'id',
    })
    expect(decision.next).toBe('expired')
    expect(decision.approval).toBeNull()
  })
})

describe('revalidação da aprovação no execute', () => {
  it('exige aprovação registrada, do mesmo hash e dentro do prazo', () => {
    const operation = makeOperation('approved')
    expect(() => assertApprovalUsable(operation, null, CLOCK)).toThrow(
      ApprovalRequiredError,
    )
    expect(() =>
      assertApprovalUsable(
        operation,
        {
          approval_id: 'a',
          decision: 'reject',
          actor_ref: actorRefFor(OTHER_HUMAN),
          plan_hash: PLAN_HASH,
          decided_at: CLOCK.toISOString(),
          expires_at: new Date(CLOCK.getTime() + 900_000).toISOString(),
        },
        CLOCK,
      ),
    ).toThrow(ApprovalRequiredError)
    expect(() =>
      assertApprovalUsable(
        operation,
        {
          approval_id: 'a',
          decision: 'approve',
          actor_ref: actorRefFor(OTHER_HUMAN),
          plan_hash: PLAN_HASH,
          decided_at: CLOCK.toISOString(),
          expires_at: new Date(CLOCK.getTime() - 1000).toISOString(),
        },
        CLOCK,
      ),
    ).toThrow(ApprovalExpiredError)

    const usable = {
      approval_id: 'a',
      decision: 'approve' as const,
      actor_ref: actorRefFor(OTHER_HUMAN),
      plan_hash: PLAN_HASH,
      decided_at: CLOCK.toISOString(),
      expires_at: new Date(CLOCK.getTime() + 900_000).toISOString(),
    }
    expect(assertApprovalUsable(operation, usable, CLOCK)).toEqual(usable)
  })
})

describe('plano de rollback (fase 1)', () => {
  it('emite hash próprio, prazo e flag destrutiva', () => {
    const plan = buildRollbackPlan({
      operation: makeOperation('succeeded'),
      observation: rollbackObservation(),
      preserveData: true,
      now: CLOCK,
    })
    expect(rollbackPlanSchema.safeParse(plan).success).toBe(true)
    expect(plan.rollback_plan_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.rollback_plan_hash).not.toBe(PLAN_HASH)
    expect(plan.ownership_verified).toBe(true)
    expect(plan.destructive).toBe(false)
    expect(plan.approval).toBeNull()
    expect(plan.expires_at).toBe(
      new Date(CLOCK.getTime() + 1_800_000).toISOString(),
    )

    const destructive = buildRollbackPlan({
      operation: makeOperation('succeeded'),
      observation: rollbackObservation(),
      preserveData: false,
      now: CLOCK,
    })
    expect(destructive.destructive).toBe(true)
    expect(destructive.rollback_plan_hash).not.toBe(plan.rollback_plan_hash)
  })

  it('recusa ownership não comprovado, drift, revisão ausente e plano vazio', () => {
    const cases: ReadonlyArray<Partial<RollbackObservation>> = [
      { ownership_verified: false },
      { drift_findings: ['recurso sem ownership'] },
      { observed_revision: '' },
      { actions: [] },
    ]
    for (const override of cases) {
      expect(() =>
        buildRollbackPlan({
          operation: makeOperation('succeeded'),
          observation: rollbackObservation(override),
          preserveData: true,
          now: CLOCK,
        }),
      ).toThrow(RollbackUnsafeError)
    }
  })
})

describe('aprovação do rollback (fase 2)', () => {
  const operation = makeOperation('succeeded')
  const plan = buildRollbackPlan({
    operation,
    observation: rollbackObservation(),
    preserveData: true,
    now: CLOCK,
  })

  function approveRequest(target: RollbackPlan): RollbackApprovalRequest {
    return {
      decision: 'approve',
      rollback_plan_hash: target.rollback_plan_hash,
      confirmation: expectedRollbackConfirmation(
        PROJECT_ID,
        target.rollback_plan_hash,
      ),
    }
  }

  it('exige plano de rollback existente e dentro do prazo', () => {
    expect(() =>
      evaluateRollbackApproval({
        operation,
        rollbackPlan: null,
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: approveRequest(plan),
        ownership: null,
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(RollbackUnsafeError)

    expect(() =>
      evaluateRollbackApproval({
        operation,
        rollbackPlan: plan,
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: approveRequest(plan),
        ownership: {
          operation_id: OPERATION_ID,
          requester_subject: HUMAN,
          rollback_requester_subject: HUMAN,
        },
        now: LATER,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalExpiredError)
  })

  it('emite novo approval_id vinculado ao rollback_plan_hash', () => {
    const decision = evaluateRollbackApproval({
      operation,
      rollbackPlan: plan,
      actor: { subject: OTHER_HUMAN, actorType: 'human' },
      expectedRevision: operation.operation_version,
      request: approveRequest(plan),
      ownership: {
        operation_id: OPERATION_ID,
        requester_subject: 'user:dono-original@example.com',
        rollback_requester_subject: HUMAN,
      },
      now: CLOCK,
      generateId: () => '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    })
    expect(decision.approval.approval_id).toBe(
      '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    )
    expect(decision.approval.rollback_plan_hash).toBe(plan.rollback_plan_hash)
    expect(decision.approval.decision).toBe('approve')
    expect(decision.rollbackPlan.approval?.approval_id).toBe(
      decision.approval.approval_id,
    )
  })

  it('recusa aprovação do próprio solicitante do rollback e do original', () => {
    expect(() =>
      evaluateRollbackApproval({
        operation,
        rollbackPlan: plan,
        actor: { subject: HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: approveRequest(plan),
        ownership: {
          operation_id: OPERATION_ID,
          requester_subject: OTHER_HUMAN,
          rollback_requester_subject: HUMAN,
        },
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalSegregationError)

    expect(() =>
      evaluateRollbackApproval({
        operation,
        rollbackPlan: plan,
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: approveRequest(plan),
        ownership: {
          operation_id: OPERATION_ID,
          requester_subject: OTHER_HUMAN,
          rollback_requester_subject: 'user:quem-solicitou@example.com',
        },
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalSegregationError)
  })

  it('recusa hash divergente (segregação) e marcador de rollback ausente', () => {
    // Mesma regra do PR 1: hash divergente é ato de segregação (403).
    try {
      evaluateRollbackApproval({
        operation,
        rollbackPlan: plan,
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: {
          decision: 'approve',
          rollback_plan_hash: 'c'.repeat(64),
          confirmation: `APROVAR ROLLBACK ${PROJECT_ID} ${'c'.repeat(8)}`,
        },
        ownership: {
          operation_id: OPERATION_ID,
          requester_subject: 'user:dono-original@example.com',
          rollback_requester_subject: HUMAN,
        },
        now: CLOCK,
        generateId: () => 'id',
      })
      throw new Error('hash divergente nao foi recusado')
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalSegregationError)
      expect((error as ApprovalSegregationError).status).toBe(403)
      expect(
        (error as ApprovalSegregationError).details.map((d) => d.reason),
      ).toContain('approval_hash_mismatch')
    }

    expect(() =>
      evaluateRollbackApproval({
        operation,
        rollbackPlan: plan,
        actor: { subject: OTHER_HUMAN, actorType: 'human' },
        expectedRevision: operation.operation_version,
        request: {
          decision: 'approve',
          rollback_plan_hash: plan.rollback_plan_hash,
          confirmation: expectedApprovalConfirmation(
            PROJECT_ID,
            plan.rollback_plan_hash,
          ),
        },
        ownership: {
          operation_id: OPERATION_ID,
          requester_subject: 'user:dono-original@example.com',
          rollback_requester_subject: HUMAN,
        },
        now: CLOCK,
        generateId: () => 'id',
      }),
    ).toThrow(ApprovalConfirmationError)
  })
})

describe('revalidação do rollback (fase 3)', () => {
  const operation = makeOperation('succeeded')
  const approved: RollbackPlan = {
    ...buildRollbackPlan({
      operation,
      observation: rollbackObservation(),
      preserveData: true,
      now: CLOCK,
    }),
    approval: {
      approval_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      decision: 'approve',
      actor_ref: actorRefFor(OTHER_HUMAN),
      rollback_plan_hash: 'replaced',
      decided_at: CLOCK.toISOString(),
      expires_at: new Date(CLOCK.getTime() + 900_000).toISOString(),
    },
  }
  approved.approval!.rollback_plan_hash = approved.rollback_plan_hash

  it('exige plano, aprovação aprovada, hash e approval_id coincidentes', () => {
    expect(() =>
      assertRollbackApprovalUsable(
        null,
        {
          rollback_plan_hash: approved.rollback_plan_hash,
          approval_id: approved.approval!.approval_id,
        },
        CLOCK,
      ),
    ).toThrow(RollbackUnsafeError)

    expect(() =>
      assertRollbackApprovalUsable(
        { ...approved, approval: null },
        {
          rollback_plan_hash: approved.rollback_plan_hash,
          approval_id: 'x',
        },
        CLOCK,
      ),
    ).toThrow(ApprovalRequiredError)

    expect(() =>
      assertRollbackApprovalUsable(
        approved,
        { rollback_plan_hash: approved.rollback_plan_hash, approval_id: 'x' },
        CLOCK,
      ),
    ).toThrow(ApprovalRequiredError)

    expect(() =>
      assertRollbackApprovalUsable(
        approved,
        {
          rollback_plan_hash: 'd'.repeat(64),
          approval_id: approved.approval!.approval_id,
        },
        CLOCK,
      ),
    ).toThrow(ApprovalHashMismatchError)

    expect(
      assertRollbackApprovalUsable(
        approved,
        {
          rollback_plan_hash: approved.rollback_plan_hash,
          approval_id: approved.approval!.approval_id,
        },
        CLOCK,
      ).approval_id,
    ).toBe(approved.approval!.approval_id)
  })

  it('recusa aprovação e plano vencidos', () => {
    expect(() =>
      assertRollbackApprovalUsable(
        approved,
        {
          rollback_plan_hash: approved.rollback_plan_hash,
          approval_id: approved.approval!.approval_id,
        },
        LATER,
      ),
    ).toThrow(ApprovalExpiredError)
  })
})

describe('projeção de leitura', () => {
  it('junta aprovação e rollback sem quebrar o schema estrito', () => {
    const operations = createInMemoryOperationStore({
      now: () => CLOCK.toISOString(),
      generateId: () => OPERATION_ID,
    })
    operations.create({
      intent: INTENT,
      plan: CANONICAL.plan,
      planHash: PLAN_HASH,
      expiresAt: CANONICAL.expires_at,
      statusUrl: `/api/project-center/v2/operations/${OPERATION_ID}`,
      auditUrl: `/api/project-center/v2/operations/${OPERATION_ID}/audit`,
      observedRevision: CANONICAL.observed_revision,
      driverVersion: CANONICAL.driver_version,
      operationId: OPERATION_ID,
    })

    const approvals = createInMemoryOperationApprovalStore()
    const rollbackPlans = createInMemoryRollbackPlanStore()
    const ownership = createInMemoryOperationOwnershipStore()
    ownership.record(OPERATION_ID, HUMAN)

    const project = createOperationProjection({
      operations,
      approvals,
      rollbackPlans,
    })
    expect(project('inexistente')).toBeNull()

    const base = project(OPERATION_ID)
    expect(base).not.toBeNull()
    expect(operationSchema.safeParse(base).success).toBe(true)
    expect(base?.approval).toBeNull()
    expect(base?.rollback).toBeNull()

    const approval = approvals.put(OPERATION_ID, {
      approval_id: '5c4b3a29-1e0f-4d3c-8b7a-6d5e4f3a2b1c',
      decision: 'approve',
      actor_ref: actorRefFor(OTHER_HUMAN),
      plan_hash: PLAN_HASH,
      decided_at: CLOCK.toISOString(),
      expires_at: new Date(CLOCK.getTime() + 900_000).toISOString(),
    })
    rollbackPlans.put(
      OPERATION_ID,
      buildRollbackPlan({
        operation: makeOperation('succeeded'),
        observation: rollbackObservation(),
        preserveData: true,
        now: CLOCK,
      }),
    )

    const projected = project(OPERATION_ID)
    expect(projected?.approval?.approval_id).toBe(approval.approval_id)
    expect(projected?.rollback?.rollback_plan_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(operationSchema.safeParse(projected).success).toBe(true)
    expect(withPlan(makeOperation()).actions).toHaveLength(
      CANONICAL.plan.actions.length,
    )
  })
})
