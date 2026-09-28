/**
 * Executor `postgresql_isolated` (PR 6).
 *
 * Fonte da verdade: spec §8.2 (plano mínimo), §9 (retries) e §14 (verificação).
 *
 * - comandos são **argv fixo** renderizado de `ACTION_TEMPLATES` (catálogo
 *   fechado do action executor) e validado por `assertFixedArgv`: sem shell,
 *   sem path, sem URI, sem placeholder sobrando;
 * - **SQL administrativo só de `ADMIN_SQL_TEMPLATES`** versionados internos,
 *   com identificadores derivados server-side; nada vem do request;
 * - credencial nunca entra em argv: o adapter recebe o **handle opaco** do
 *   broker e é o único que revela o material. A saída do processo é redigida e
 *   conferida contra o material antes de virar `safe_detail`;
 * - `verify_cross_isolation` é **prova negativa**: o resultado esperado é o
 *   adapter FALHAR (role A não alcança o database canário B);
 * - `create_secret_ref` é canal `broker`: emite a `SecretRef` (CSPRNG) com
 *   replay idempotente por operação, sem qualquer processo.
 *
 * Nenhum adapter concreto de spawn existe aqui: o deployment injeta a
 * implementação (PR 7 e ativação). Neste PR o worker permanece desligado.
 */
import { errorFingerprint } from '../domain'
import { POSTGRES_ADMIN_ROLE } from '../observers/postgresql-observer'
import { MASK, redactText } from '../redaction'
import {
  EXECUTION_ADMIN_ROLE,
  assertExecutionEndpoint,
  assertFixedArgv,
  renderActionTemplate,
} from './action-executor'
import type {
  DriverActionInput,
  DriverActionOutcome,
  DriverExecutor,
  ProcessAdapter,
  ProcessBinary,
} from './action-executor'
import type { ErrorCode, PlannedActionKind, SafeFailure } from '../domain'
import type {
  SecretBroker,
  SecretMaterialHandle,
  SecretPurpose,
} from '../secret-broker'

export const POSTGRESQL_EXECUTOR_VERSION = 'pcv2-pg-executor-v1'
export const POSTGRES_EXECUTOR_ADAPTER_ID = 'pg-process-adapter'
/** Propósito da credencial da role de aplicação. */
export const POSTGRES_APP_SECRET_PURPOSE: SecretPurpose = 'app_role_password'
/** Propósito da credencial administrativa (provisionador dedicado). */
export const POSTGRES_ADMIN_SECRET_PURPOSE: SecretPurpose = 'admin_bootstrap'
/** Retries automáticos da spec §9 (somente erro transitório). */
export const POSTGRES_MAX_ATTEMPTS = 5
export const POSTGRES_BACKOFF_SECONDS = [1, 2, 4, 8, 16] as const
export const POSTGRES_BACKOFF_CAP_SECONDS = 30
/** Exit code do psql para falha de conexão: único caso retentável. */
export const PSQL_EXIT_CONNECTION_ERROR = 2
/** Alvo lógico público do artefato de secret (sem material). */
export const POSTGRES_APP_SECRET_TARGET = 'secret-ref'

/** Kinds resolvidos por este executor (canal de processo + canal de broker). */
export const POSTGRES_EXECUTOR_ACTIONS: ReadonlyArray<PlannedActionKind> =
  Object.freeze([
    'create_database',
    'create_app_role',
    'apply_least_privilege',
    'verify_cross_isolation',
    'verify_backup_restore',
    'disable_resource',
    'drop_resource_created_by_operation',
    'create_secret_ref',
  ])

/** Falha fechada do executor PostgreSQL. */
export class PostgresExecutorError extends Error {
  readonly code: ErrorCode
  readonly reason: string

  constructor(reason: string, code: ErrorCode = 'EXECUTION_FAILED') {
    super('execucao postgresql recusada')
    this.name = 'PostgresExecutorError'
    this.reason = reason
    this.code = code
  }
}

export interface PostgresProcessAdapters {
  readonly sql: ProcessAdapter
  readonly dump: ProcessAdapter
  readonly restore: ProcessAdapter
}

/** Porta da credencial administrativa do provisionador (nunca do request). */
export interface AdminCredentialPort {
  acquire: (input: {
    readonly projectId: string
    readonly environment: string
  }) => SecretMaterialHandle | null
}

export interface PostgresqlExecutorDeps {
  readonly processes: PostgresProcessAdapters
  readonly secrets: SecretBroker
  readonly adminCredential: AdminCredentialPort
}

// Guarda de drift: o papel administrativo dos templates tem de ser o
// provisionador dedicado do observer. Divergência quebra na carga.
const adminRoles: ReadonlyArray<string> = Object.freeze([
  POSTGRES_ADMIN_ROLE,
  EXECUTION_ADMIN_ROLE,
])
if (adminRoles[0] !== adminRoles[1]) {
  throw new PostgresExecutorError('admin_role_drift', 'INTERNAL_ERROR')
}

function assertAdapterBinary(
  adapter: ProcessAdapter,
  binary: ProcessBinary,
): void {
  if (adapter.binary !== binary) {
    throw new PostgresExecutorError(
      `adapter_binary_mismatch:${adapter.adapter_id}`,
      'DRIVER_UNAVAILABLE',
    )
  }
}

/**
 * Qualifica a saída bruta do processo: remove qualquer ocorrência do material
 * conhecido e aplica a redaction do PR 1. A saída crua nunca é devolvida.
 */
export function redactProcessOutput(
  output: string,
  material: string | null,
): string {
  if (material !== null && material.length > 0 && output.includes(material)) {
    return redactText(output.split(material).join(MASK)).slice(0, 300)
  }
  return redactText(output).slice(0, 300)
}

function failureFor(
  code: ErrorCode,
  detail: string,
  retryable: boolean,
): SafeFailure {
  return Object.freeze({
    code,
    message: redactText(detail).slice(0, 300),
    retryable,
    fingerprint: errorFingerprint(code, detail),
  })
}

/** Exit code transitório (retentável) conforme a classificação da spec §9. */
export function isTransientExitCode(exitCode: number): boolean {
  return exitCode === PSQL_EXIT_CONNECTION_ERROR
}

export function createPostgresqlExecutor(
  deps: PostgresqlExecutorDeps,
): DriverExecutor {
  assertAdapterBinary(deps.processes.sql, 'psql')
  assertAdapterBinary(deps.processes.dump, 'pg_dump')
  assertAdapterBinary(deps.processes.restore, 'pg_restore')

  function adapterForTemplate(binary: ProcessBinary): ProcessAdapter {
    if (binary === 'psql') return deps.processes.sql
    if (binary === 'pg_dump') return deps.processes.dump
    if (binary === 'pg_restore') return deps.processes.restore
    throw new PostgresExecutorError(
      `binary_not_allowlisted:${binary}`,
      'POLICY_DENIED',
    )
  }

  function runBrokerChannel(input: DriverActionInput): DriverActionOutcome {
    const context = input.context
    const expectedTarget = `${POSTGRES_APP_SECRET_TARGET}:${context.projectId}:app-role`
    if (input.action.target_ref !== expectedTarget) {
      // Alvo fora do allowlist de naming do projeto: nunca emite secret.
      throw new PostgresExecutorError(
        'secret_target_not_owned',
        'POLICY_DENIED',
      )
    }
    const issued = deps.secrets.issue({
      projectId: context.projectId,
      environment: context.environment,
      purpose: POSTGRES_APP_SECRET_PURPOSE,
      // Replay idempotente por operação: retry do worker não cria material
      // novo nem produz alias derivável.
      idempotencyKey: `op:${context.operationId}:${POSTGRES_APP_SECRET_PURPOSE}`,
    })
    return {
      status: 'succeeded',
      safe_detail: `secret_ref=${issued.masked_ref} fingerprint=${issued.fingerprint} replayed=${issued.replayed}`,
      evidence_ref: expectedTarget,
    }
  }

  async function runProcessChannel(
    input: DriverActionInput,
  ): Promise<DriverActionOutcome> {
    const template = input.template
    if (template === null) {
      throw new PostgresExecutorError('template_ausente', 'INVALID_REQUEST')
    }
    const context = input.context
    assertExecutionEndpoint(context.endpoint)
    const argv = renderActionTemplate(template, input.params)
    assertFixedArgv({ binary: template.binary, argv })

    const credential =
      template.binary === 'psql'
        ? deps.adminCredential.acquire({
            projectId: context.projectId,
            environment: context.environment,
          })
        : null
    if (template.binary === 'psql' && credential === null) {
      // Sem credencial administrativa injetada, nenhuma conexão é aberta.
      throw new PostgresExecutorError(
        'admin_credential_unavailable',
        'DRIVER_UNAVAILABLE',
      )
    }
    const material = credential === null ? null : credential.reveal()

    // `pg_restore` recebe o dump por stdin (nunca por path): sem o payload
    // conferido contra o checksum, o restore efémero não roda.
    const restorePayload =
      template.binary === 'pg_restore'
        ? (context.restorePayloadBase64 ?? null)
        : null
    if (template.binary === 'pg_restore' && restorePayload === null) {
      throw new PostgresExecutorError(
        'restore_payload_ausente',
        'INVALID_REQUEST',
      )
    }

    const adapter = adapterForTemplate(template.binary)
    const result = await adapter.run({
      argv,
      timeout_ms: template.timeout_ms,
      ...(credential === null ? {} : { credential }),
      ...(restorePayload === null ? {} : { stdin_base64: restorePayload }),
    })

    const raw = result.stderr.length > 0 ? result.stderr : result.stdout
    const detail = redactProcessOutput(raw, material)
    if (material !== null && detail.includes(material)) {
      // Defesa em profundidade: saída ainda contendo material nunca é
      // publicada como detalhe seguro.
      throw new PostgresExecutorError(
        'credential_leak_in_output',
        'INTERNAL_ERROR',
      )
    }

    if (template.expects_denial) {
      // Prova negativa: o esperado é a operação ser NEGADA pelo servidor.
      if (result.exit_code === 0) {
        return {
          status: 'failed',
          safe_detail: 'prova negativa de isolamento falhou',
          failure: failureFor(
            'VERIFICATION_FAILED',
            'acesso cruzado permitido',
            false,
          ),
        }
      }
      return {
        status: 'succeeded',
        safe_detail: `isolamento comprovado (exit_code=${result.exit_code})`,
      }
    }

    if (result.exit_code === 0) {
      return {
        status: 'succeeded',
        safe_detail: `exit_code=0 action=${input.action.kind}`,
      }
    }

    const retryable = isTransientExitCode(result.exit_code)
    return {
      status: 'failed',
      safe_detail: `exit_code=${result.exit_code} action=${input.action.kind}`,
      failure: failureFor(
        'EXECUTION_FAILED',
        detail.length > 0 ? detail : `exit_code=${result.exit_code}`,
        retryable,
      ),
    }
  }

  return {
    driver: 'postgresql_isolated',
    executor_version: POSTGRESQL_EXECUTOR_VERSION,
    adapter_id: POSTGRES_EXECUTOR_ADAPTER_ID,
    supported_actions: POSTGRES_EXECUTOR_ACTIONS,

    async execute(input: DriverActionInput): Promise<DriverActionOutcome> {
      return input.template === null
        ? runBrokerChannel(input)
        : runProcessChannel(input)
    },
  }
}

/** Papel administrativo usado nos templates (constante do observer). */
export const POSTGRES_EXECUTOR_ADMIN_ROLE = POSTGRES_ADMIN_ROLE
