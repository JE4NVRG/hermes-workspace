/**
 * Executor `supabase_isolated` (PR 6).
 *
 * Fonte da verdade: spec §8.3, §14 e o catálogo `catalogs/supabase-catalog.ts`.
 *
 * Nada aqui executa comando livre: todas as ações vão para uma **porta de
 * stack injetada** (`StackAdapter`) e todo parâmetro é derivado server-side do
 * catálogo fechado — template allowlisted, imagens pinadas por digest, portas
 * internas por serviço e nomes do snapshot de naming.
 *
 * Invariantes:
 * - template fora da allowlist, perfil desconhecido, nome divergente do naming
 *   ou imagem sem pin → recusa **antes** de tocar a stack;
 * - endpoint público (ou porta fora da allowlist interna) → recusa: a stack
 *   deste catálogo só publica bind interno;
 * - `disable_resource`/`drop_resource_created_by_operation` exigem
 *   `ownership_verified` na projeção observada (nunca apagar stack alheia);
 * - secret refs são emitidos pelo broker com escopo de bind do projeto e
 *   **nunca** devolvem material na saída — só o `sref_` mascarado;
 * - prova A×B compara duas projeções sanitizadas e falha se houver qualquer
 *   acoplamento (endpoint, binding compartilhado, artefato do par);
 * - prova de restore exige alvo efémero distinto, nunca a própria stack.
 */
import {
  SUPABASE_CATALOG_VERSION,
  SUPABASE_PROFILE_IDS,
  SUPABASE_RESOURCE_PROFILES,
  SUPABASE_TEMPLATES,
  SUPABASE_TEMPLATE_ALLOWLIST,
  assertPinnedImageRef,
  internalPortFor,
  isKnownTemplateId,
  pinnedImageRefFor,
  requiredServicesFor,
  resolveTemplateFor,
} from '../catalogs/supabase-catalog'
import { EPHEMERAL_TARGET_PATTERN } from '../restore-verifier'
import { redactText } from '../redaction'
import { errorFingerprint } from '../domain'
import type { PlannedAction } from '../domain'
import type {
  SUPABASE_BIND_SCOPES,
  SupabaseProfileId,
  SupabaseServiceId,
  SupabaseStackProjection,
  SupabaseTemplate,
} from '../catalogs/supabase-catalog'
import type {
  SecretBroker,
  SecretMaterialHandle,
  SecretPurpose,
} from '../secret-broker'
import type { DriverActionInput, DriverExecutor } from './action-executor'

export const SUPABASE_EXECUTOR_VERSION = 'pcv2-sb-executor-v1'
export const SUPABASE_EXECUTOR_ADAPTER_ID = 'supabase-stack-adapter'
/** Escopo de bind usado nos secret refs da stack (loopback). */
export const SUPABASE_BIND_SCOPE = 'loopback' as const
/** Timeout por passo de stack. */
export const SUPABASE_STEP_TIMEOUT_MS = 120_000
/** Tipos de passo aceitos pela porta de stack (catálogo fechado). */
export const SUPABASE_STACK_STEPS = [
  'render_compose_template',
  'create_network',
  'create_data_store',
  'create_database',
  'create_app_role',
  'apply_least_privilege',
  'start_stack',
  'health_check',
  'verify_cross_isolation',
  'verify_backup_restore',
  'disable_resource',
  'drop_resource_created_by_operation',
] as const
export type SupabaseStackStep = (typeof SUPABASE_STACK_STEPS)[number]
/** Ações servidas pela porta do broker, sem tocar na stack. */
export const SUPABASE_BROKER_ACTIONS: ReadonlyArray<PlannedAction['kind']> = [
  'create_secret_ref',
]
export const SUPABASE_APP_SECRET_PURPOSE: SecretPurpose = 'app_role_password'
export const SUPABASE_SECRET_TARGET_PATTERN =
  /^broker-binding:[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$/

export class SupabaseExecutorError extends Error {
  readonly code:
    | 'POLICY_DENIED'
    | 'INVALID_REQUEST'
    | 'VERIFICATION_FAILED'
    | 'DRIVER_UNAVAILABLE'
  readonly reason: string
  readonly fingerprint: string

  constructor(code: SupabaseExecutorError['code'], reason: string) {
    super('execucao supabase recusada')
    this.name = 'SupabaseExecutorError'
    this.code = code
    this.reason = reason
    this.fingerprint = errorFingerprint(code, reason)
  }
}

/** Escopos de bind aceitos: nunca público, curinga ou desconhecido. */
export const SUPABASE_ALLOWED_BIND_SCOPES: ReadonlyArray<string> = [
  'loopback',
  'private_network',
]

/** Endpoint interno declarado pela operação (nunca público). */
export interface StackEndpoint {
  readonly service: SupabaseServiceId
  readonly scope: (typeof SUPABASE_BIND_SCOPES)[number]
  readonly port: number
  readonly public_exposure: boolean
}

/** Operação de stack derivada do catálogo + naming (nada vem do request). */
export interface StackOperation {
  readonly adapter_id: string
  readonly catalog_version: string
  readonly template_id: string
  readonly template_version: string
  readonly profile_id: SupabaseProfileId
  readonly compose_project: string
  readonly network: string
  readonly data_store: string
  readonly database: string
  readonly app_role: string
  readonly services: ReadonlyArray<SupabaseServiceId>
  readonly images: Readonly<Record<SupabaseServiceId, string>>
  readonly endpoints: ReadonlyArray<StackEndpoint>
  readonly timeout_ms: number
  readonly restore_target?: string
  readonly peer_compose_project?: string
}

export interface StackStepRequest {
  readonly step: SupabaseStackStep
  readonly operation: StackOperation
  readonly credential?: SecretMaterialHandle
}

export interface StackStepResult {
  readonly exit_code: number
  readonly safe_detail?: string
}

/** Porta de stack injetada (Compose). Sem argv: só passos allowlisted. */
export interface StackAdapter {
  readonly adapter_id: string
  readonly apply: (request: StackStepRequest) => Promise<StackStepResult>
}

/** Porta de projeção observada (read-only) da stack. */
export interface StackProjectionPort {
  readonly adapter_id: string
  observe: (composeProject: string) => Promise<SupabaseStackProjection>
}

export interface SupabaseExecutorDeps {
  readonly stack: StackAdapter
  readonly projections: StackProjectionPort
  readonly secrets: SecretBroker
  /** Credencial de bootstrap do banco da stack (nunca em argv). */
  readonly adminCredential?: {
    readonly acquire: () => SecretMaterialHandle | null
  }
  readonly now?: () => Date
}

/** Campos do contexto que só o driver Supabase usa. */
export interface SupabaseContextFields {
  readonly templateId?: string
  readonly profileId?: string
  readonly endpoints?: ReadonlyArray<StackEndpoint>
  readonly restoreDatabase?: string
  readonly peerComposeProject?: string
}

interface OperationLike {
  readonly projectId: string
  readonly environment: string
  readonly naming: {
    readonly compose_project: string
    readonly network: string
    readonly data_store: string
    readonly database: string
    readonly app_role: string
    readonly project_id: string
  }
}

function templateForId(templateId: string | undefined): SupabaseTemplate {
  if (templateId === undefined || !isKnownTemplateId(templateId)) {
    throw new SupabaseExecutorError('POLICY_DENIED', 'template_not_allowlisted')
  }
  // Comparação por valor amplo: o guard de tipo estreita para o literal único
  // do catálogo, mas o casamento continua sendo por igualdade de string.
  const wanted: string = templateId
  const template = SUPABASE_TEMPLATES.find(
    (candidate) => candidate.template_id === wanted,
  )
  if (
    template === undefined ||
    !SUPABASE_TEMPLATE_ALLOWLIST.includes(template.template_id)
  ) {
    throw new SupabaseExecutorError('POLICY_DENIED', 'template_not_allowlisted')
  }
  return template
}

function profileForId(profileId: string | undefined): SupabaseProfileId {
  if (
    profileId === undefined ||
    !(SUPABASE_PROFILE_IDS as ReadonlyArray<string>).includes(profileId)
  ) {
    throw new SupabaseExecutorError('POLICY_DENIED', 'profile_not_allowlisted')
  }
  return profileId as SupabaseProfileId
}

/** Valida o endpoint: só bind interno, na porta canônica do serviço. */
export function assertInternalEndpoint(endpoint: StackEndpoint): StackEndpoint {
  if (!SUPABASE_ALLOWED_BIND_SCOPES.includes(endpoint.scope)) {
    throw new SupabaseExecutorError(
      'POLICY_DENIED',
      'bind_scope_not_allowlisted',
    )
  }
  const exposure = endpoint.public_exposure as unknown
  if (exposure !== true && exposure !== false) {
    throw new SupabaseExecutorError('INVALID_REQUEST', 'endpoint_malformado')
  }
  if (endpoint.public_exposure) {
    // Exposição pública não é representável neste catálogo.
    throw new SupabaseExecutorError(
      'POLICY_DENIED',
      'public_exposure_forbidden',
    )
  }
  const expected = internalPortFor(endpoint.service)
  if (endpoint.port !== expected) {
    throw new SupabaseExecutorError('POLICY_DENIED', 'port_outside_allowlist')
  }
  return endpoint
}

/** Monta a operação de stack a partir do catálogo + naming (server-side). */
export function buildStackOperation(input: {
  readonly operation: OperationLike
  readonly fields: SupabaseContextFields
  readonly adapterId: string
}): StackOperation {
  const template = templateForId(input.fields.templateId)
  const profileId = profileForId(input.fields.profileId)
  const profile = SUPABASE_RESOURCE_PROFILES.find(
    (candidate) => candidate.profile_id === profileId,
  )
  if (profile === undefined) {
    throw new SupabaseExecutorError('POLICY_DENIED', 'profile_not_allowlisted')
  }

  // Visão não confiável do naming: o valor chega do plano persistido.
  const naming = input.operation.naming
  const untrustedNaming = naming as unknown as {
    readonly compose_project?: unknown
  }
  if (
    typeof untrustedNaming.compose_project !== 'string' ||
    untrustedNaming.compose_project.length === 0
  ) {
    throw new SupabaseExecutorError('INVALID_REQUEST', 'naming_ausente')
  }

  const services = requiredServicesFor(
    Object.fromEntries(
      template.capabilities.map((capability) => [capability, true]),
    ),
  )
  const images = Object.fromEntries(
    services.map((service) => [
      service,
      // `pinnedImageRefFor` falha fechado se o serviço não tiver digest.
      pinnedImageRefFor(service),
    ]),
  ) as Record<SupabaseServiceId, string>
  for (const image of Object.values(images)) {
    assertPinnedImageRef(image)
  }

  const endpoints = (input.fields.endpoints ?? []).map((endpoint) =>
    assertInternalEndpoint(endpoint),
  )
  for (const endpoint of endpoints) {
    if (!services.includes(endpoint.service)) {
      throw new SupabaseExecutorError(
        'POLICY_DENIED',
        'service_outside_template',
      )
    }
  }

  if (input.fields.restoreDatabase !== undefined) {
    if (!EPHEMERAL_TARGET_PATTERN.test(input.fields.restoreDatabase)) {
      throw new SupabaseExecutorError(
        'POLICY_DENIED',
        'restore_target_not_ephemeral',
      )
    }
    if (input.fields.restoreDatabase === naming.compose_project) {
      throw new SupabaseExecutorError(
        'POLICY_DENIED',
        'restore_target_is_origin',
      )
    }
  }
  if (input.fields.peerComposeProject !== undefined) {
    if (
      typeof input.fields.peerComposeProject !== 'string' ||
      input.fields.peerComposeProject.length === 0 ||
      input.fields.peerComposeProject === naming.compose_project
    ) {
      throw new SupabaseExecutorError('POLICY_DENIED', 'peer_invalido')
    }
  }

  return Object.freeze({
    adapter_id: input.adapterId,
    catalog_version: SUPABASE_CATALOG_VERSION,
    template_id: template.template_id,
    template_version: template.version,
    profile_id: profileId,
    compose_project: naming.compose_project,
    network: naming.network,
    data_store: naming.data_store,
    database: naming.database,
    app_role: naming.app_role,
    services,
    images: Object.freeze(images),
    endpoints: Object.freeze(endpoints),
    timeout_ms: SUPABASE_STEP_TIMEOUT_MS,
    restore_target: input.fields.restoreDatabase,
    peer_compose_project: input.fields.peerComposeProject,
  })
}

/**
 * Prova A×B entre duas projeções sanitizadas. Devolve os achados; lista vazia
 * significa isolamento comprovado.
 */
export function isolationFindings(
  origin: SupabaseStackProjection,
  peer: SupabaseStackProjection,
): ReadonlyArray<string> {
  const findings: Array<string> = []

  const peerEndpoints = new Map(
    peer.endpoints.map((endpoint) => [endpoint.name, endpoint] as const),
  )
  for (const endpoint of origin.endpoints) {
    const collision = peerEndpoints.get(endpoint.name)
    if (collision !== undefined && collision.port !== null) {
      findings.push(`endpoint_partilhado:${endpoint.name}`)
    }
    if (endpoint.public_exposure) {
      findings.push(`endpoint_publico:${endpoint.name}`)
    }
    if (!SUPABASE_ALLOWED_BIND_SCOPES.includes(endpoint.scope)) {
      findings.push(`bind_fora_do_loopback:${endpoint.name}`)
    }
  }

  const peerArtifacts = new Set(
    peer.backup_artifacts.map((artifact) => artifact.artifact_ref),
  )
  for (const artifact of origin.backup_artifacts) {
    if (peerArtifacts.has(artifact.artifact_ref)) {
      findings.push(`artefato_do_par:${artifact.artifact_ref}`)
    }
    if (artifact.retention_days > 90) {
      findings.push(`retencao_acima_da_quota:${artifact.artifact_ref}`)
    }
  }

  for (const binding of origin.broker_bindings) {
    if (!binding.exists) continue
    if (binding.shared_with_other_project) {
      findings.push(`binding_partilhado:${binding.name}`)
    }
  }

  if (origin.compose_project.name === peer.compose_project.name) {
    findings.push('stack_igual_ao_par')
  }
  if (
    !origin.ownership_verified ||
    !origin.compose_project.ownership_verified
  ) {
    findings.push('ownership_da_origem_nao_comprovado')
  }
  if (origin.drift_findings.length > 0) {
    findings.push(`drift_na_origem:${origin.drift_findings.length}`)
  }
  return Object.freeze(findings)
}

/** Serviços exigidos que não estão observados/sadios na projeção. */
export function healthFindings(
  projection: SupabaseStackProjection,
  required: ReadonlyArray<SupabaseServiceId>,
): ReadonlyArray<string> {
  const findings: Array<string> = []
  for (const service of required) {
    const observed = projection.services.find((entry) => entry.name === service)
    if (observed === undefined || !observed.observed) {
      findings.push(`servico_ausente:${service}`)
      continue
    }
    if (observed.status !== 'running') {
      findings.push(`servico_parado:${service}`)
    }
    if (observed.health !== 'healthy' && observed.health !== 'none') {
      findings.push(`servico_unhealthy:${service}`)
    }
    if (!observed.pinned) {
      findings.push(`imagem_sem_pin:${service}`)
    }
  }
  const running = projection.services.filter((entry) => entry.observed)
  for (const entry of running) {
    if (!required.includes(entry.name as SupabaseServiceId)) {
      findings.push(`servico_fora_do_template:${entry.name}`)
    }
  }
  return Object.freeze(findings)
}

export function createSupabaseExecutor(
  deps: SupabaseExecutorDeps,
): DriverExecutor {
  if (deps.stack.adapter_id !== SUPABASE_EXECUTOR_ADAPTER_ID) {
    throw new SupabaseExecutorError(
      'DRIVER_UNAVAILABLE',
      'stack_adapter_desconhecido',
    )
  }
  if (deps.projections.adapter_id.length === 0) {
    throw new SupabaseExecutorError(
      'DRIVER_UNAVAILABLE',
      'projection_adapter_ausente',
    )
  }

  function failure(
    code: 'VERIFICATION_FAILED' | 'POLICY_DENIED' | 'EXECUTION_FAILED',
    reason: string,
    retryable = false,
  ) {
    return {
      code,
      message: 'passo de stack recusado',
      retryable,
      fingerprint: errorFingerprint(code, reason),
    }
  }

  async function runStep(
    step: SupabaseStackStep,
    operation: StackOperation,
    credential?: SecretMaterialHandle | null,
  ): Promise<{ ok: boolean; safe_detail: string }> {
    const result = await deps.stack.apply({
      step,
      operation,
      ...(credential === null || credential === undefined
        ? {}
        : { credential }),
    })
    const detail = redactText(result.safe_detail ?? '').slice(0, 300)
    return {
      ok: result.exit_code === 0,
      safe_detail:
        detail.length > 0
          ? detail
          : `step=${step} exit_code=${result.exit_code}`,
    }
  }

  return {
    driver: 'supabase_isolated',
    adapter_id: deps.stack.adapter_id,
    executor_version: SUPABASE_EXECUTOR_VERSION,
    supported_actions: Object.freeze([
      ...SUPABASE_STACK_STEPS,
      ...SUPABASE_BROKER_ACTIONS,
    ]),

    async execute(input) {
      const { action, context } = input
      const driverFields = context.driverFields ?? {}
      const fields: SupabaseContextFields = {
        templateId: context.templateId,
        profileId: context.profileId,
        endpoints: (driverFields.endpoints ??
          []) as ReadonlyArray<StackEndpoint>,
        restoreDatabase: context.restoreDatabase,
        peerComposeProject: driverFields.peerComposeProject,
      }
      const operation = buildStackOperation({
        operation: context,
        fields,
        adapterId: deps.stack.adapter_id,
      })

      // --- canal de broker: nenhum passo de stack, nenhum material na saída.
      if (
        (SUPABASE_BROKER_ACTIONS as ReadonlyArray<string>).includes(action.kind)
      ) {
        if (!SUPABASE_SECRET_TARGET_PATTERN.test(action.target_ref)) {
          return {
            status: 'failed',
            safe_detail: 'alvo de binding fora da allowlist',
            failure: failure('POLICY_DENIED', 'secret_target_not_allowlisted'),
          }
        }
        const slot = action.target_ref.split(':')[2] ?? ''
        const issued = deps.secrets.issue({
          projectId: context.projectId,
          environment: context.environment,
          purpose: SUPABASE_APP_SECRET_PURPOSE,
          idempotencyKey: `op:${context.operationId}:${SUPABASE_APP_SECRET_PURPOSE}:${slot}`,
        })
        return {
          status: 'succeeded',
          safe_detail: `binding ${issued.masked_ref} slot=${slot} replayed=${String(issued.replayed)}`,
          evidence_ref: action.target_ref,
        }
      }

      const step = action.kind as SupabaseStackStep
      if (!(SUPABASE_STACK_STEPS as ReadonlyArray<string>).includes(step)) {
        return {
          status: 'failed',
          safe_detail: 'passo fora do catalogo de stack',
          failure: failure('POLICY_DENIED', 'step_not_in_catalog'),
        }
      }

      // --- passos que exigem ownership comprovado na projeção observada.
      if (
        step === 'disable_resource' ||
        step === 'drop_resource_created_by_operation'
      ) {
        const projection = await deps.projections.observe(
          operation.compose_project,
        )
        if (
          !projection.ownership_verified ||
          !projection.compose_project.exists ||
          !projection.compose_project.ownership_verified ||
          projection.drift_findings.length > 0 ||
          projection.compose_project.drift.length > 0
        ) {
          return {
            status: 'failed',
            safe_detail: 'ownership da stack nao comprovado; nada foi removido',
            failure: failure('POLICY_DENIED', 'ownership_not_verified'),
          }
        }
      }

      // --- prova A×B entre a stack do projeto e a do par (canário).
      if (step === 'verify_cross_isolation') {
        if (operation.peer_compose_project === undefined) {
          return {
            status: 'failed',
            safe_detail: 'prova de isolamento exige stack par',
            failure: failure('POLICY_DENIED', 'peer_ausente'),
          }
        }
        const origin = await deps.projections.observe(operation.compose_project)
        const peer = await deps.projections.observe(
          operation.peer_compose_project,
        )
        const findings = isolationFindings(origin, peer)
        if (findings.length > 0) {
          return {
            status: 'failed',
            safe_detail: `isolamento nao comprovado (${findings.length} achados)`,
            failure: failure('VERIFICATION_FAILED', 'acoplamento_entre_stacks'),
          }
        }
        return {
          status: 'succeeded',
          safe_detail: `isolamento comprovado entre ${operation.compose_project} e ${operation.peer_compose_project}`,
          evidence_ref: action.target_ref,
        }
      }

      // --- prova de restore: alvo efémero distinto da stack.
      if (step === 'verify_backup_restore') {
        if (operation.restore_target === undefined) {
          return {
            status: 'failed',
            safe_detail: 'prova de restore exige alvo efemero',
            failure: failure('POLICY_DENIED', 'restore_target_ausente'),
          }
        }
        const stepResult = await runStep(
          step,
          operation,
          deps.adminCredential?.acquire() ?? null,
        )
        return stepResult.ok
          ? {
              status: 'succeeded',
              safe_detail: stepResult.safe_detail,
              evidence_ref: action.target_ref,
            }
          : {
              status: 'failed',
              safe_detail: stepResult.safe_detail,
              failure: failure('VERIFICATION_FAILED', 'restore_prova_falhou'),
            }
      }

      // --- health da stack contra os serviços exigidos pelo template.
      if (step === 'health_check') {
        const projection = await deps.projections.observe(
          operation.compose_project,
        )
        const findings = healthFindings(projection, operation.services)
        if (findings.length > 0) {
          return {
            status: 'failed',
            safe_detail: `stack nao saudavel (${findings.length} achados)`,
            failure: failure('VERIFICATION_FAILED', 'stack_unhealthy'),
          }
        }
        return {
          status: 'succeeded',
          safe_detail: `stack saudavel: ${operation.services.length} servicos`,
          evidence_ref: action.target_ref,
        }
      }

      // --- passos de criação: exigem credencial de bootstrap da stack.
      const credential = deps.adminCredential?.acquire() ?? null
      if (credential === null && step !== 'render_compose_template') {
        return {
          status: 'failed',
          safe_detail: 'credencial de bootstrap da stack indisponivel',
          failure: failure('POLICY_DENIED', 'credential_unavailable'),
        }
      }
      // Render não abre conexão ao banco: não recebe credencial nenhuma.
      const stepCredential =
        step === 'render_compose_template' ? null : credential
      const stepResult = await runStep(step, operation, stepCredential)
      return stepResult.ok
        ? {
            status: 'succeeded',
            safe_detail: stepResult.safe_detail,
            evidence_ref: action.target_ref,
          }
        : {
            status: 'failed',
            safe_detail: stepResult.safe_detail,
            failure: failure('EXECUTION_FAILED', 'stack_step_falhou', true),
          }
    },
  }
}

void resolveTemplateFor
