/**
 * Testes do domínio tipado.
 *
 * Boa parte das asserções compara os schemas Zod com o contrato OpenAPI em
 * disco (enums, `required`, padrões): drift de contrato falha aqui, e não só na
 * API do PR 4.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  ACTION_ID_PATTERN,
  ACTION_RISKS,
  APPROVAL_CONFIRMATION_PATTERN,
  ARTIFACT_REF_PATTERN,
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  AUDIT_OUTCOMES,
  DRIVERS,
  ENVIRONMENTS,
  ERROR_CODES,
  ERROR_FINGERPRINT_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  IF_MATCH_PATTERN,
  PLANNED_ACTION_KINDS,
  PROJECT_ID_PATTERN,
  ROLLBACK_CONFIRMATION_PATTERN,
  SECRET_REF_PATTERN,
  SHA256_PATTERN,
  SLUG_PATTERN,
  VERIFICATION_CHECKS,
  VERIFICATION_CHECK_OUTCOMES,
  VERIFICATION_OUTCOMES,
  approvalRequestSchema,
  approvalSchema,
  artifactRefSchema,
  auditEventSchema,
  auditPageSchema,
  buildApprovalConfirmation,
  buildProjectId,
  buildRollbackConfirmation,
  capabilitiesSchema,
  errorFingerprint,
  errorResponseSchema,
  executeRequestSchema,
  formatOperationRevision,
  operationSchema,
  parseOperationRevision,
  planSchema,
  plannedActionSchema,
  projectIdSchema,
  projectIntentSchema,
  rollbackApprovalRequestSchema,
  rollbackApprovalSchema,
  rollbackExecuteRequestSchema,
  safeFailureSchema,
  safePayloadSchema,
  sha256Schema,
  verificationSchema,
} from './domain'
import type { ErrorCode } from './domain'
import type { z } from 'zod'

// Fixtures sintéticas montadas em runtime: nenhum valor real, nenhum path do
// host e nenhum token com formato de produção aparece como literal no commit.
const PLAN_HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const OPERATION_UUID = '11111111-1111-4111-8111-111111111111'
const APPROVAL_UUID = '22222222-2222-4222-8222-222222222222'
const OCCURRED_AT = '2026-09-25T00:00:00.000Z'
const EXPIRES_AT = '2026-09-26T00:00:00.000Z'
const PROJECT_ID = 'cliente-a-projeto-b'
const SECRET_REF_VALUE = `sref_${'A'.repeat(43)}`
const ABSOLUTE_PATH_REF = ['', 'srv', 'pcv2', 'dados', 'app'].join('/')
const URI_SCHEME_REF = ['https', '//exemplo.interno/artefato'].join('://')
const CREDENTIAL_HOST_REF = `${['usuario', 'credencial'].join(':')}@host`
const PARENT_TRAVERSAL_REF = ['a', '..', 'b'].join('/')
const BACKSLASH_REF = ['a', 'b'].join(String.fromCharCode(92))

const CONTRACT_PATH = fileURLToPath(
  new URL(
    '../../../specs/contracts/project-center-v2.openapi.yaml',
    import.meta.url,
  ),
)

const contract = parseYaml(readFileSync(CONTRACT_PATH, 'utf8'))
const schemas = contract.components.schemas as Record<string, any>
const parameters = contract.components.parameters as Record<string, any>

function contractEnum(path: ReadonlyArray<string>): Array<string> {
  let cursor: unknown = schemas
  for (const step of path) {
    cursor = (cursor as Record<string, unknown> | undefined)?.[step]
  }
  return cursor as Array<string>
}

function shapeOf(schema: unknown): Record<string, unknown> {
  return (schema as { shape: Record<string, unknown> }).shape
}

function samePattern(pattern: RegExp, contractPattern: string): boolean {
  return pattern.source.replaceAll('\\/', '/') === contractPattern
}

const capabilities = {
  auth: true,
  storage: true,
  realtime: false,
  postgrest: true,
  backup: true,
}

const plannedAction = {
  action_id: 'act_abcdefgh',
  kind: 'create_database',
  target_ref: `${PROJECT_ID}-db`,
  risk: 'reversible',
  reversible: true,
  dependencies: [],
}

const plan = {
  policy_version: 'pcv2-rbac-v1',
  actions: [plannedAction],
  estimated_resources: { database_size_mb: 256 },
  warnings: [],
}

const operation = {
  operation_id: OPERATION_UUID,
  project_id: PROJECT_ID,
  driver: 'postgresql_isolated',
  environment: 'development',
  state: 'planned',
  operation_version: 1,
  plan_hash: PLAN_HASH,
  plan,
  created_at: OCCURRED_AT,
  updated_at: OCCURRED_AT,
  expires_at: EXPIRES_AT,
  status_url: `/api/v1/project-center/operations/${OPERATION_UUID}`,
  audit_url: `/api/v1/project-center/operations/${OPERATION_UUID}/audit`,
}

/** Pares (nome no contrato, schema Zod, amostra mínima válida). */
const paritySamples: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
  [
    'ProjectIntent',
    projectIntentSchema,
    {
      client_id: 'cliente-a',
      project_slug: 'projeto-b',
      display_name: 'Projeto B',
      driver: 'postgresql_isolated',
      environment: 'development',
      host_target: 'vps-primary-local',
      capabilities,
    },
  ],
  ['Capabilities', capabilitiesSchema, { ...capabilities }],
  ['PlannedAction', plannedActionSchema, { ...plannedAction }],
  ['Plan', planSchema, { ...plan }],
  ['Operation', operationSchema, { ...operation }],
  [
    'Approval',
    approvalSchema,
    {
      approval_id: APPROVAL_UUID,
      decision: 'approve',
      actor_ref: 'usr_1',
      plan_hash: PLAN_HASH,
      decided_at: OCCURRED_AT,
      expires_at: EXPIRES_AT,
    },
  ],
  [
    'RollbackApproval',
    rollbackApprovalSchema,
    {
      approval_id: APPROVAL_UUID,
      decision: 'approve',
      actor_ref: 'usr_2',
      rollback_plan_hash: PLAN_HASH,
      decided_at: OCCURRED_AT,
      expires_at: EXPIRES_AT,
    },
  ],
  [
    'Verification',
    verificationSchema,
    {
      outcome: 'passed',
      checks: [{ name: 'health', outcome: 'passed' }],
      observed_at: OCCURRED_AT,
    },
  ],
  [
    'SafeFailure',
    safeFailureSchema,
    {
      code: 'EXECUTION_FAILED',
      message: 'falha sintetica',
      retryable: true,
      fingerprint: errorFingerprint('EXECUTION_FAILED'),
    },
  ],
  [
    'AuditEvent',
    auditEventSchema,
    {
      event_id: OPERATION_UUID,
      sequence: 1,
      occurred_at: OCCURRED_AT,
      type: 'operation.transitioned',
      actor_ref: 'usr_1',
      outcome: 'accepted',
      safe_payload: { state: 'planned' },
    },
  ],
  [
    'AuditPage',
    auditPageSchema,
    {
      request_id: 'req-123456',
      operation_id: OPERATION_UUID,
      events: [],
      next_cursor: null,
    },
  ],
  [
    'ErrorResponse',
    errorResponseSchema,
    {
      error: {
        code: 'FORBIDDEN',
        message: 'negado',
        request_id: 'req-123456',
        retryable: false,
      },
    },
  ],
  ['ExecuteRequest', executeRequestSchema, { plan_hash: PLAN_HASH }],
  [
    'RollbackExecuteRequest',
    rollbackExecuteRequestSchema,
    { rollback_plan_hash: PLAN_HASH, approval_id: APPROVAL_UUID },
  ],
]

describe('paridade com o contrato OpenAPI', () => {
  it('espelha os enums canonicos', () => {
    const pairs: Array<[Array<string>, ReadonlyArray<string>]> = [
      [contractEnum(['Driver', 'enum']), DRIVERS],
      [contractEnum(['Environment', 'enum']), ENVIRONMENTS],
      [contractEnum(['ErrorCode', 'enum']), ERROR_CODES],
      [
        contractEnum(['ArtifactRef', 'properties', 'type', 'enum']),
        ARTIFACT_TYPES,
      ],
      [
        contractEnum(['ArtifactRef', 'properties', 'status', 'enum']),
        ARTIFACT_STATUSES,
      ],
      [
        contractEnum(['PlannedAction', 'properties', 'kind', 'enum']),
        PLANNED_ACTION_KINDS,
      ],
      [
        contractEnum(['PlannedAction', 'properties', 'risk', 'enum']),
        ACTION_RISKS,
      ],
      [
        contractEnum(['AuditEvent', 'properties', 'outcome', 'enum']),
        AUDIT_OUTCOMES,
      ],
      [
        contractEnum(['Verification', 'properties', 'outcome', 'enum']),
        VERIFICATION_OUTCOMES,
      ],
      [
        contractEnum(['VerificationCheck', 'properties', 'outcome', 'enum']),
        VERIFICATION_CHECK_OUTCOMES,
      ],
      [
        contractEnum([
          'VerifyRequest',
          'properties',
          'checks',
          'items',
          'enum',
        ]),
        VERIFICATION_CHECKS,
      ],
    ]
    for (const [expected, actual] of pairs) {
      expect([...actual]).toEqual(expected)
    }
  })

  it('espelha os padroes canonicos', () => {
    expect(samePattern(SHA256_PATTERN, schemas.Sha256.pattern)).toBe(true)
    expect(samePattern(SECRET_REF_PATTERN, schemas.SecretRef.pattern)).toBe(
      true,
    )
    expect(schemas.SecretRef.minLength).toBe(48)
    expect(schemas.SecretRef.maxLength).toBe(133)
    expect(
      samePattern(
        SLUG_PATTERN,
        schemas.ProjectIntent.properties.client_id.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        SLUG_PATTERN,
        schemas.ProjectIntent.properties.project_slug.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        PROJECT_ID_PATTERN,
        schemas.Operation.properties.project_id.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        ARTIFACT_REF_PATTERN,
        schemas.ArtifactRef.properties.ref.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        ACTION_ID_PATTERN,
        schemas.PlannedAction.properties.action_id.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        ERROR_FINGERPRINT_PATTERN,
        schemas.SafeFailure.properties.fingerprint.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        APPROVAL_CONFIRMATION_PATTERN,
        schemas.ApproveRequest.properties.confirmation.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        ROLLBACK_CONFIRMATION_PATTERN,
        schemas.RollbackApproveRequest.properties.confirmation.pattern,
      ),
    ).toBe(true)
    expect(
      samePattern(
        IDEMPOTENCY_KEY_PATTERN,
        parameters.IdempotencyKey.schema.pattern,
      ),
    ).toBe(true)
    expect(parameters.IdempotencyKey.schema.minLength).toBe(16)
    expect(parameters.IdempotencyKey.schema.maxLength).toBe(128)
    expect(
      samePattern(IF_MATCH_PATTERN, parameters.IfMatchVersion.schema.pattern),
    ).toBe(true)
  })

  it('espelha required, propriedades e adicionalidade fechada', () => {
    for (const [name, schema, sample] of paritySamples) {
      const required = (schemas[name].required ?? []) as Array<string>
      const properties = Object.keys(schemas[name].properties ?? {})
      const minimum = Object.fromEntries(
        Object.entries(sample).filter(([key]) => required.includes(key)),
      )

      expect(schema.safeParse(minimum).success, `${name}: minimo valido`).toBe(
        true,
      )

      for (const field of required) {
        const rest = { ...minimum }
        delete rest[field]
        expect(
          schema.safeParse(rest).success,
          `${name}.${field} deveria ser obrigatorio`,
        ).toBe(false)
      }

      for (const field of properties) {
        if (required.includes(field)) continue
        const rest = { ...minimum }
        delete rest[field]
        expect(
          schema.safeParse(rest).success,
          `${name}.${field} deveria ser opcional`,
        ).toBe(true)
      }

      expect(
        schema.safeParse({ ...minimum, campo_inesperado: 'x' }).success,
        `${name}: additionalProperties deve ser fechado`,
      ).toBe(false)

      for (const key of Object.keys(shapeOf(schema))) {
        expect(properties, `${name}.${key} deve existir no contrato`).toContain(
          key,
        )
      }
    }
  })

  it('espelha required de ArtifactRef', () => {
    expect((schemas.ArtifactRef.required as Array<string>).sort()).toEqual([
      'ref',
      'status',
      'type',
    ])
    expect(
      artifactRefSchema.safeParse({ type: 'database', ref: 'x-db' }).success,
    ).toBe(false)
    expect(
      artifactRefSchema.safeParse({
        type: 'database',
        ref: 'x-db',
        status: 'created',
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

describe('ProjectIntent', () => {
  function intent(overrides: Record<string, unknown> = {}) {
    return {
      client_id: 'cliente-a',
      project_slug: 'projeto-b',
      display_name: 'Projeto B',
      driver: 'postgresql_isolated',
      environment: 'development',
      host_target: 'vps-primary-local',
      capabilities,
      ...overrides,
    }
  }

  it('aceita intencao minima valida', () => {
    expect(projectIntentSchema.safeParse(intent()).success).toBe(true)
  })

  it('recusa identificadores fora do padrao de slug', () => {
    for (const clientId of [
      'Cliente-a',
      'a',
      '1cliente',
      'cliente_a',
      '',
      'x'.repeat(25),
    ]) {
      expect(
        projectIntentSchema.safeParse(intent({ client_id: clientId })).success,
        `client_id recusado: ${clientId}`,
      ).toBe(false)
    }
  })

  it('recusa driver, ambiente e host_target fora da allowlist', () => {
    expect(
      projectIntentSchema.safeParse(intent({ driver: 'schema_shared' }))
        .success,
    ).toBe(false)
    expect(
      projectIntentSchema.safeParse(intent({ environment: 'preview' })).success,
    ).toBe(false)
    for (const host of [
      'localhost',
      ['', 'srv', 'db'].join('/'),
      '10.0.0.5',
      'vps-primary-local ',
    ]) {
      expect(
        projectIntentSchema.safeParse(intent({ host_target: host })).success,
        `host_target recusado: ${host}`,
      ).toBe(false)
    }
  })

  it('exige backup habilitado e recusa campo desconhecido', () => {
    expect(
      projectIntentSchema.safeParse(
        intent({ capabilities: { ...capabilities, backup: false } }),
      ).success,
    ).toBe(false)
    expect(projectIntentSchema.safeParse(intent({ dsn: 'x' })).success).toBe(
      false,
    )
  })

  it('recusa limites fora da faixa do contrato', () => {
    expect(
      projectIntentSchema.safeParse(
        intent({ requested_limits: { memory_mb: 128 } }),
      ).success,
    ).toBe(false)
    expect(
      projectIntentSchema.safeParse(
        intent({ requested_limits: { cpu_millicores: 9000 } }),
      ).success,
    ).toBe(false)
    expect(
      projectIntentSchema.safeParse(
        intent({ requested_limits: { backup_retention_days: 90 } }),
      ).success,
    ).toBe(true)
  })
})

describe('ArtifactRef', () => {
  it('aceita identificador publico deterministico', () => {
    expect(
      artifactRefSchema.safeParse({
        type: 'database',
        ref: `${PROJECT_ID}-db`,
        status: 'created',
      }).success,
    ).toBe(true)
  })

  it('recusa path absoluto, URI, credencial embutida, traversal e barra invertida', () => {
    for (const ref of [
      ABSOLUTE_PATH_REF,
      URI_SCHEME_REF,
      CREDENTIAL_HOST_REF,
      PARENT_TRAVERSAL_REF,
      BACKSLASH_REF,
      'com espaco',
    ]) {
      expect(
        artifactRefSchema.safeParse({
          type: 'database',
          ref,
          status: 'created',
        }).success,
        `ref deveria ser recusada: ${ref}`,
      ).toBe(false)
    }
  })

  it('trata secret_ref como valor atomico e nao aceita token em outro tipo', () => {
    expect(
      artifactRefSchema.safeParse({
        type: 'secret_ref',
        ref: SECRET_REF_VALUE,
        status: 'created',
      }).success,
    ).toBe(true)
    expect(
      artifactRefSchema.safeParse({
        type: 'secret_ref',
        ref: `${PROJECT_ID}-secret`,
        status: 'created',
      }).success,
    ).toBe(false)
    expect(
      artifactRefSchema.safeParse({
        type: 'endpoint_masked',
        ref: SECRET_REF_VALUE,
        status: 'created',
      }).success,
    ).toBe(false)
    expect(
      artifactRefSchema.safeParse({
        type: 'endpoint_masked',
        ref: '127.0.0.1:5432',
        status: 'created',
      }).success,
    ).toBe(true)
  })
})

describe('aprovacao e rollback discriminados', () => {
  it('exige confirmacao exata no approve e apenas motivo no reject', () => {
    const approve = {
      decision: 'approve',
      plan_hash: PLAN_HASH,
      confirmation: buildApprovalConfirmation(PROJECT_ID, PLAN_HASH),
    }
    expect(approvalRequestSchema.safeParse(approve).success).toBe(true)
    expect(
      approvalRequestSchema.safeParse({
        ...approve,
        confirmation: 'APROVAR tudo',
      }).success,
    ).toBe(false)
    expect(
      approvalRequestSchema.safeParse({
        decision: 'approve',
        plan_hash: PLAN_HASH,
      }).success,
    ).toBe(false)
    expect(
      approvalRequestSchema.safeParse({
        decision: 'reject',
        reason: 'nao aprovado',
      }).success,
    ).toBe(true)
    expect(
      approvalRequestSchema.safeParse({
        decision: 'reject',
        reason: 'nao aprovado',
        plan_hash: PLAN_HASH,
      }).success,
    ).toBe(false)
  })

  it('monta as frases canonicas e nao as confunde', () => {
    const approvalConfirmation = buildApprovalConfirmation(
      PROJECT_ID,
      PLAN_HASH,
    )
    expect(approvalConfirmation).toBe(
      `APROVAR ${PROJECT_ID} ${PLAN_HASH.slice(0, 8)}`,
    )
    expect(APPROVAL_CONFIRMATION_PATTERN.test(approvalConfirmation)).toBe(true)

    const rollbackConfirmation = buildRollbackConfirmation(
      PROJECT_ID,
      OTHER_HASH,
    )
    expect(ROLLBACK_CONFIRMATION_PATTERN.test(rollbackConfirmation)).toBe(true)
    expect(APPROVAL_CONFIRMATION_PATTERN.test(rollbackConfirmation)).toBe(false)
    expect(
      rollbackApprovalRequestSchema.safeParse({
        decision: 'approve',
        rollback_plan_hash: OTHER_HASH,
        confirmation: rollbackConfirmation,
      }).success,
    ).toBe(true)
  })

  it('recusa hash e confirmacao malformados', () => {
    expect(
      approvalRequestSchema.safeParse({
        decision: 'approve',
        plan_hash: 'A'.repeat(64),
        confirmation: buildApprovalConfirmation(PROJECT_ID, PLAN_HASH),
      }).success,
    ).toBe(false)
    expect(sha256Schema.safeParse(PLAN_HASH.slice(0, 63)).success).toBe(false)
  })
})

describe('helpers de dominio', () => {
  it('deriva e valida project_id canonico', () => {
    expect(buildProjectId('cliente-a', 'projeto-b')).toBe(PROJECT_ID)
    expect(projectIdSchema.safeParse(PROJECT_ID).success).toBe(true)
    expect(projectIdSchema.safeParse('cliente-a').success).toBe(false)
    expect(projectIdSchema.safeParse('Cliente-a-Projeto-b').success).toBe(false)
    expect(() => buildProjectId('Cliente-a', 'projeto-b')).toThrow()
  })

  it('converte If-Match em revisao e devolve o formato canonico', () => {
    expect(parseOperationRevision('"7"')).toBe(7)
    expect(formatOperationRevision(7)).toBe('"7"')
    for (const header of ['7', '"0"', '"-1"', '"01"', '"7', '7"', '']) {
      expect(() => parseOperationRevision(header)).toThrow()
    }
    expect(() => formatOperationRevision(0)).toThrow()
  })

  it('gera fingerprint nao reversivel no formato do contrato', () => {
    const first = errorFingerprint('EXECUTION_FAILED')
    expect(first).toMatch(ERROR_FINGERPRINT_PATTERN)
    expect(errorFingerprint('EXECUTION_FAILED')).toBe(first)
    expect(errorFingerprint('VERIFICATION_FAILED')).not.toBe(first)
    expect(errorFingerprint('EXECUTION_FAILED', 'detalhe sintetico')).not.toBe(
      first,
    )
    expect(first).not.toContain('EXECUTION_FAILED')
  })

  it('mantem o catalogo de erros fechado e sem duplicata', () => {
    expect(ERROR_CODES).toHaveLength(20)
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
    const code: ErrorCode = 'INVALID_STATE_TRANSITION'
    expect(ERROR_CODES).toContain(code)
    expect(new Set(AUDIT_OUTCOMES).size).toBe(AUDIT_OUTCOMES.length)
  })

  it('limita safe_payload a 30 propriedades escalares', () => {
    expect(
      safePayloadSchema.safeParse({ state: 'planned', attempt: 1 }).success,
    ).toBe(true)
    expect(
      safePayloadSchema.safeParse({ nested: { state: 'planned' } }).success,
    ).toBe(false)
    const oversized = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [`k${index}`, index]),
    )
    expect(safePayloadSchema.safeParse(oversized).success).toBe(false)
  })
})
