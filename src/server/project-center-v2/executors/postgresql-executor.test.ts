/**
 * Testes do executor `postgresql_isolated` (PR 6).
 *
 * Cobre: argv fixo com SQL versionado, credencial nunca em argv nem em
 * `safe_detail`, prova negativa A→B (database/role), classificação de retry,
 * canal de broker com replay idempotente e recusa de alvo/credencial ausente.
 */
import { describe, expect, it } from 'vitest'
import { resolveProjectCenterV2Flags } from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { createInMemoryLeaseStore } from '../lease-store'
import { MASK } from '../redaction'
import {
  createInMemorySecretMaterialStore,
  createSecretBroker,
} from '../secret-broker'
import {
  EXECUTABLE_ACTION_KINDS,
  createActionExecutor,
  templateFor,
  templateParamsFor,
} from './action-executor'
import {
  POSTGRESQL_EXECUTOR_VERSION,
  POSTGRES_BACKOFF_CAP_SECONDS,
  POSTGRES_BACKOFF_SECONDS,
  POSTGRES_EXECUTOR_ACTIONS,
  POSTGRES_MAX_ATTEMPTS,
  PostgresExecutorError,
  createPostgresqlExecutor,
  isTransientExitCode,
  redactProcessOutput,
} from './postgresql-executor'
import type { SecretBroker } from '../secret-broker'
import type {
  ActionExecutionContext,
  ActionExecutor,
  DriverActionInput,
  ProcessAdapter,
  ProcessBinary,
  ProcessRunInput,
  ProcessRunResult,
} from './action-executor'
import type { PlannedAction } from '../domain'

const PROJECT_ID = 'acme-site'
const PEER_PROJECT = 'canary-peer'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const HOLDER = 'pcv2-worker'
const OBSERVED_REVISION = `obsrev_${'c'.repeat(32)}`
const ENDPOINT = { host: '127.0.0.1', port: 55432 }
const NAMING = buildNamingSnapshot({
  client_id: 'acme',
  project_slug: 'site',
  environment: 'development',
  driver: 'postgresql_isolated',
})
const PEER_DATABASE = 'je4ndev_canary_peer_blog'
const RESTORE_DATABASE = 'je4ndev_pcv2_restore_ab12'
const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})

interface FakeAdapter extends ProcessAdapter {
  readonly calls: ReadonlyArray<ProcessRunInput>
  readonly setResult: (result: ProcessRunResult) => void
}

function createFakeAdapter(
  binary: ProcessBinary,
  result: ProcessRunResult,
): FakeAdapter {
  const calls: Array<ProcessRunInput> = []
  let current = result
  return {
    adapter_id: `fake-${binary}`,
    binary,
    calls,
    setResult: (next) => {
      current = next
    },
    run: async (input) => {
      calls.push(input)
      return current
    },
  }
}

interface Harness {
  readonly executor: ActionExecutor
  readonly sql: FakeAdapter
  readonly dump: FakeAdapter
  readonly restore: FakeAdapter
  readonly broker: SecretBroker
  readonly material: string
  readonly context: ActionExecutionContext
  readonly run: (
    action: PlannedAction,
    context?: Partial<ActionExecutionContext>,
  ) => Promise<Awaited<ReturnType<ActionExecutor['execute']>>>
}

function createHarness(
  options: {
    readonly adminCredential?: boolean
    readonly adapterResult?: ProcessRunResult
  } = {},
): Harness {
  const base: ProcessRunResult = { exit_code: 0, stdout: 'ok', stderr: '' }
  const sql = createFakeAdapter('psql', options.adapterResult ?? base)
  const dump = createFakeAdapter('pg_dump', {
    exit_code: 0,
    stdout: '',
    stderr: '',
    stdout_base64: Buffer.from('dump-sintetico').toString('base64'),
  })
  const restore = createFakeAdapter('pg_restore', base)
  const broker = createSecretBroker({
    materials: createInMemorySecretMaterialStore(),
    pepper: 'p'.repeat(48),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  })
  const issued = broker.issue({
    projectId: PROJECT_ID,
    environment: 'development',
    purpose: 'admin_bootstrap',
  })
  const adminHandle = broker.handle({
    secretRef: issued.secret_ref,
    projectId: PROJECT_ID,
    environment: 'development',
    purpose: 'admin_bootstrap',
  })
  const material = adminHandle.reveal()

  const postgres = createPostgresqlExecutor({
    processes: { sql, dump, restore },
    secrets: broker,
    adminCredential: {
      acquire: () => (options.adminCredential === false ? null : adminHandle),
    },
  })

  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '77777777-7777-4777-8777-777777777777',
  })
  const lease = leases.acquire({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    holderRef: HOLDER,
  })

  const executor = createActionExecutor({
    flags: FLAGS_ON,
    leases,
    drivers: { postgresql_isolated: postgres },
  })

  const context: ActionExecutionContext = {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    driver: 'postgresql_isolated',
    host_target: 'vps-primary-local',
    observedRevision: OBSERVED_REVISION,
    naming: NAMING,
    completedActionIds: [],
    lease: {
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      holderRef: HOLDER,
    },
    endpoint: ENDPOINT,
  }

  return {
    executor,
    sql,
    dump,
    restore,
    broker,
    material,
    context,
    run: (action, overrides) =>
      executor.execute({
        action,
        context: { ...context, ...overrides },
        observedRevision: OBSERVED_REVISION,
      }),
  }
}

function action(overrides: Partial<PlannedAction>): PlannedAction {
  return {
    action_id: 'act_pg_default',
    kind: 'create_database',
    target_ref: `database:${NAMING.database}`,
    risk: 'reversible',
    reversible: true,
    dependencies: [],
    ...overrides,
  }
}

describe('postgresql executor — catálogo e argv fixo', () => {
  it('declara versão, adapter e ações suportadas', () => {
    const harness = createHarness()
    expect(POSTGRESQL_EXECUTOR_VERSION).toBe('pcv2-pg-executor-v1')
    expect(POSTGRES_EXECUTOR_ACTIONS).toContain('create_database')
    expect(POSTGRES_EXECUTOR_ACTIONS).toContain('create_secret_ref')
    expect(POSTGRES_MAX_ATTEMPTS).toBe(5)
    expect(POSTGRES_BACKOFF_SECONDS).toEqual([1, 2, 4, 8, 16])
    expect(POSTGRES_BACKOFF_CAP_SECONDS).toBe(30)
    expect(EXECUTABLE_ACTION_KINDS).toContain('verify_cross_isolation')
    expect(harness.sql.calls).toHaveLength(0)
  })

  it('recusa adapter cujo binário não corresponde ao contrato', () => {
    const broker = createHarness().broker
    expect(() =>
      createPostgresqlExecutor({
        processes: {
          sql: createFakeAdapter('pg_dump', {
            exit_code: 0,
            stdout: '',
            stderr: '',
          }),
          dump: createFakeAdapter('pg_dump', {
            exit_code: 0,
            stdout: '',
            stderr: '',
          }),
          restore: createFakeAdapter('pg_restore', {
            exit_code: 0,
            stdout: '',
            stderr: '',
          }),
        },
        secrets: broker,
        adminCredential: { acquire: () => null },
      }),
    ).toThrow(PostgresExecutorError)
  })

  it('executa create_database com argv fixo, SQL versionado e credencial fora do argv', async () => {
    const harness = createHarness()
    const outcome = await harness.run(action({}))

    expect(outcome.status).toBe('succeeded')
    expect(harness.sql.calls).toHaveLength(1)
    const call = harness.sql.calls[0]
    expect(call.argv[0]).toBe('psql')
    expect(call.argv).toContain('ON_ERROR_STOP=1')
    expect(
      call.argv.some((element) =>
        element.includes(`CREATE DATABASE ${NAMING.database}`),
      ),
    ).toBe(true)
    expect(call.argv.join(' ')).not.toContain(harness.material)
    expect(call.credential).toBeDefined()
    expect(JSON.stringify(outcome)).not.toContain(harness.material)
    expect(outcome.safe_detail).toBe('exit_code=0 action=create_database')
  })

  it('qualifica saída de processo que ecoa o material', () => {
    const harness = createHarness()
    const leaked = `LOG: connection ok com ${harness.material}`
    const detail = redactProcessOutput(leaked, harness.material)
    expect(detail).not.toContain(harness.material)
    expect(detail).toContain(MASK)
    expect(redactProcessOutput('sem material', null)).toBe('sem material')
  })

  it('falha fechado quando não há credencial administrativa injetada', async () => {
    const harness = createHarness({ adminCredential: false })
    await expect(harness.run(action({}))).rejects.toBeInstanceOf(
      PostgresExecutorError,
    )
    expect(harness.sql.calls).toHaveLength(0)
  })

  it('recusa template divergente do kind antes de abrir processo', async () => {
    const harness = createHarness()
    const template = templateFor('create_database', 'postgresql_isolated')
    const params = templateParamsFor(action({}), harness.context)
    expect(params.admin_role).toBe('je4ndev_pcv2_admin')
    expect(template.kind).toBe('create_database')
    await expect(
      harness.run(
        action({
          kind: 'start_stack',
          target_ref: `stack:${NAMING.compose_project}`,
        }),
      ),
    ).rejects.toThrow()
    expect(harness.sql.calls).toHaveLength(0)
  })
})

describe('postgresql executor — prova negativa A para B', () => {
  it('considera isolamento comprovado quando a role A é negada no database B', async () => {
    const harness = createHarness({
      adapterResult: { exit_code: 1, stdout: '', stderr: 'permission denied' },
    })
    const outcome = await harness.run(
      action({
        kind: 'verify_cross_isolation',
        action_id: 'act_verify_isolation',
        target_ref: 'verification:cross-isolation',
        dependencies: ['act_create_database'],
      }),
      {
        peerDatabase: PEER_DATABASE,
        completedActionIds: ['act_create_database'],
      },
    )

    expect(outcome.status).toBe('succeeded')
    expect(outcome.safe_detail).toContain('isolamento comprovado')
    const argv = harness.sql.calls[0]?.argv ?? []
    expect(argv).toContain(NAMING.app_role)
    expect(argv).toContain(PEER_DATABASE)
    expect(argv).not.toContain(PEER_PROJECT)
  })

  it('falha a publicação quando o acesso cruzado é concedido', async () => {
    const harness = createHarness({
      adapterResult: { exit_code: 0, stdout: 'SELECT 1', stderr: '' },
    })
    const outcome = await harness.run(
      action({
        kind: 'verify_cross_isolation',
        action_id: 'act_verify_isolation',
        target_ref: 'verification:cross-isolation',
      }),
      { peerDatabase: PEER_DATABASE },
    )

    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.code).toBe('VERIFICATION_FAILED')
    expect(outcome.failure?.retryable).toBe(false)
    expect(outcome.failure?.fingerprint).toMatch(/^err_[a-f0-9]{16,64}$/)
  })

  it('restore acontece em database distinto da origem via pg_restore', async () => {
    const harness = createHarness()
    const outcome = await harness.run(
      action({
        kind: 'verify_backup_restore',
        action_id: 'act_verify_backup',
        target_ref: 'verification:backup-restore',
      }),
      {
        restoreDatabase: RESTORE_DATABASE,
        restorePayloadBase64: Buffer.from('dump-sintetico').toString('base64'),
      },
    )

    expect(outcome.status).toBe('succeeded')
    expect(harness.restore.calls).toHaveLength(1)
    const argv = harness.restore.calls[0]?.argv ?? []
    expect(argv[0]).toBe('pg_restore')
    expect(argv).toContain(RESTORE_DATABASE)
    expect(argv).not.toContain(NAMING.database)
    // Dump entra por stdin, nunca por path no argv.
    expect(harness.restore.calls[0]?.stdin_base64).toBe(
      Buffer.from('dump-sintetico').toString('base64'),
    )
    expect(harness.dump.calls).toHaveLength(0)
  })

  it('pg_restore sem payload conferido nao roda', async () => {
    const harness = createHarness()
    await expect(
      harness.run(
        action({
          kind: 'verify_backup_restore',
          action_id: 'act_verify_backup',
          target_ref: 'verification:backup-restore',
        }),
        { restoreDatabase: RESTORE_DATABASE },
      ),
    ).rejects.toThrow(PostgresExecutorError)
    expect(harness.restore.calls).toHaveLength(0)
  })

  it('classifica exit code de execução: conexão retentável, resto definitivo', async () => {
    expect(isTransientExitCode(2)).toBe(true)
    expect(isTransientExitCode(1)).toBe(false)
    expect(isTransientExitCode(0)).toBe(false)

    const transient = createHarness({
      adapterResult: { exit_code: 2, stdout: '', stderr: 'connection refused' },
    })
    const transientOutcome = await transient.run(action({}))
    expect(transientOutcome.status).toBe('failed')
    expect(transientOutcome.failure?.retryable).toBe(true)

    const definite = createHarness({
      adapterResult: { exit_code: 3, stdout: '', stderr: 'script error' },
    })
    const definiteOutcome = await definite.run(action({}))
    expect(definiteOutcome.status).toBe('failed')
    expect(definiteOutcome.failure?.retryable).toBe(false)
  })
})

describe('postgresql executor — canal de broker', () => {
  it('emite SecretRef com replay idempotente e sem material na saída', async () => {
    const harness = createHarness()
    const target = { kind: 'create_secret_ref' as const }
    const first = await harness.run(
      action({
        ...target,
        action_id: 'act_secret_issue',
        target_ref: `secret-ref:${PROJECT_ID}:app-role`,
      }),
    )
    const second = await harness.run(
      action({
        ...target,
        action_id: 'act_secret_issue',
        target_ref: `secret-ref:${PROJECT_ID}:app-role`,
      }),
    )

    expect(first.status).toBe('succeeded')
    expect(first.evidence_ref).toBe(`secret-ref:${PROJECT_ID}:app-role`)
    expect(first.safe_detail).toContain('replayed=false')
    expect(second.safe_detail).toContain('replayed=true')
    expect(first.safe_detail).not.toContain(harness.material)
    expect(second.safe_detail).not.toContain(harness.material)
    // Replay não cria material novo: vault contém apenas o admin + a role app.
    expect(harness.broker.bindings()).toHaveLength(2)
    expect(harness.sql.calls).toHaveLength(0)
  })

  it('recusa alvo de secret que não pertence ao projeto', async () => {
    const harness = createHarness()
    await expect(
      harness.run(
        action({
          kind: 'create_secret_ref',
          action_id: 'act_secret_hostil',
          target_ref: `secret-ref:${PEER_PROJECT}:app-role`,
        }),
      ),
    ).rejects.toBeInstanceOf(PostgresExecutorError)
    expect(harness.broker.bindings()).toHaveLength(1)
  })
})
