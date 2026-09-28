/**
 * Testes do executor de ações allowlisted (PR 6).
 *
 * Cada caso hostil tem de falhar **antes** do adapter externo: os testes
 * contam chamadas do adapter e provam zero chamada quando a ação, o template,
 * o host target, o endpoint, o path ou o lease estão fora da allowlist.
 */
import { describe, expect, it } from 'vitest'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { StaleWriterError, createInMemoryLeaseStore } from '../lease-store'
import {
  ACTION_EXECUTOR_VERSION,
  ACTION_TEMPLATES,
  ADMIN_SQL_TEMPLATES,
  ActionNotAllowedError,
  DriverExecutorUnavailableError,
  EXECUTABLE_ACTION_KINDS,
  EXECUTION_PORT_DENYLIST,
  ExecutorInputError,
  ExecutorStaleError,
  PROCESS_BINARY_ALLOWLIST,
  TARGET_REF_PREFIXES_BY_KIND,
  assertExecutionEndpoint,
  assertFixedArgv,
  createActionExecutor,
  renderActionTemplate,
  renderAdminSql,
  templateFor,
  templateParamsFor,
} from './action-executor'
import type { LeaseGrant } from '../lease-store'
import type {
  ActionExecutionContext,
  ActionTemplate,
  DriverActionInput,
  DriverExecutor,
  ProcessBinary,
} from './action-executor'
import type { PlannedAction, PlannedActionKind } from '../domain'

const PROJECT_ID = 'acme-site'
const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const HOLDER = 'pcv2-worker'
const OBSERVED_REVISION = `obsrev_${'a'.repeat(32)}`
const NAMING = buildNamingSnapshot({
  client_id: 'acme',
  project_slug: 'site',
  environment: 'development',
  driver: 'postgresql_isolated',
})
const PEER_DATABASE = 'je4ndev_canary_peer'
const RESTORE_DATABASE = 'je4ndev_pcv2_restore'

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

interface FakeAdapter {
  readonly calls: ReadonlyArray<ProcessRunInputLike>
  run: (input: ProcessRunInputLike) => Promise<{
    exit_code: number
    stdout: string
    stderr: string
  }>
}

interface ProcessRunInputLike {
  readonly argv: ReadonlyArray<string>
  readonly timeout_ms: number
}

interface Harness {
  readonly executor: ReturnType<typeof createActionExecutor>
  readonly adapter: FakeAdapter
  readonly lease: LeaseGrant
  readonly context: ActionExecutionContext
  readonly calls: () => number
}

function plannedAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    action_id: 'act_create_database',
    kind: 'create_database',
    target_ref: `database:${NAMING.database}`,
    risk: 'reversible',
    reversible: true,
    compensation_kind: 'drop_database',
    dependencies: [],
    ...overrides,
  }
}

function createHarness(
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly context?: Partial<ActionExecutionContext>
    readonly adapterResult?: {
      exit_code: number
      stdout: string
      stderr: string
    }
    readonly controlPlane?: boolean
  } = {},
): Harness {
  const calls: Array<ProcessRunInputLike> = []
  const adapter: FakeAdapter = {
    calls,
    run: async (input) => {
      calls.push(input)
      return (
        options.adapterResult ?? {
          exit_code: 0,
          stdout: 'CREATE DATABASE',
          stderr: '',
        }
      )
    },
  }
  const leases = createInMemoryLeaseStore({
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    generateId: () => '66666666-6666-4666-8666-666666666666',
  })
  const lease = leases.acquire({
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    environment: 'development',
    holderRef: HOLDER,
  })

  const driverExecutor: DriverExecutor = {
    driver: 'postgresql_isolated',
    executor_version: 'pcv2-pg-executor-v1',
    adapter_id: 'pg-process-adapter',
    supported_actions: [
      'create_database',
      'create_app_role',
      'apply_least_privilege',
      'verify_cross_isolation',
      'verify_backup_restore',
    ],
    execute: async (input: DriverActionInput) => {
      const template = input.template
      if (template === null) {
        throw new Error('canal sem processo nao suportado neste fake')
      }
      const argv = renderActionTemplate(template, input.params)
      assertFixedArgv({ binary: template.binary, argv })
      const result = await adapter.run({
        argv,
        timeout_ms: template.timeout_ms,
      })
      return {
        status: result.exit_code === 0 ? 'succeeded' : 'failed',
        safe_detail: `exit_code=${result.exit_code}`,
      }
    },
  }

  const executor = createActionExecutor({
    flags: options.flags ?? FLAGS_ON,
    leases,
    drivers: { postgresql_isolated: driverExecutor },
    ...(options.controlPlane === true
      ? {
          controlPlane: {
            adapter_id: 'registry-adapter',
            publish: async () => ({
              status: 'succeeded' as const,
              safe_detail: 'registry upsert',
              evidence_ref: `registry-record:${PROJECT_ID}`,
            }),
          },
        }
      : {}),
    now: () => new Date('2026-09-25T12:01:00.000Z'),
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
    endpoint: { host: '127.0.0.1', port: 55432 },
    ...options.context,
  }

  return {
    executor,
    adapter,
    lease,
    context,
    calls: () => calls.length,
  }
}

describe('action executor — flags e catálogo fechado', () => {
  it('com flags desligadas nada é executado e o adapter não é tocado', async () => {
    const harness = createHarness({ flags: FLAGS_OFF })
    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: harness.context,
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(harness.calls()).toBe(0)
  })

  it('recusa ação fora do catálogo executável e kind fora do contrato', async () => {
    const harness = createHarness()
    await expect(
      harness.executor.execute({
        action: plannedAction({
          kind: 'start_stack',
          target_ref: `stack:${NAMING.compose_project}`,
        }),
        context: harness.context,
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ActionNotAllowedError)

    await expect(
      harness.executor.execute({
        action: plannedAction({ kind: 'sql_livre' as PlannedActionKind }),
        context: harness.context,
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ActionNotAllowedError)

    expect(harness.calls()).toBe(0)
  })

  it('recusa host target fora da allowlist e endpoint de produção', async () => {
    const harness = createHarness()
    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: { ...harness.context, host_target: 'host-livre' },
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ActionNotAllowedError)

    for (const endpoint of [
      { host: '127.0.0.1', port: EXECUTION_PORT_DENYLIST[0] },
      { host: '0.0.0.0', port: 55432 },
      { host: '127.0.0.1', port: 80 },
      { host: 'postgres.interno', port: 55432 },
    ]) {
      await expect(
        harness.executor.execute({
          action: plannedAction(),
          context: { ...harness.context, endpoint },
          observedRevision: OBSERVED_REVISION,
        }),
      ).rejects.toBeInstanceOf(ActionNotAllowedError)
    }
    expect(harness.calls()).toBe(0)
  })

  it('recusa target_ref com prefixo errado, path ou marker inválido', async () => {
    const harness = createHarness()
    const hostile = [
      `stack:${NAMING.compose_project}`,
      'database:/etc/passwd',
      'database:../outro',
      'database:je4ndev_acme_site#je4ndev:pcv2:postgresql_isolated:development:B',
      'database:postgres://user@host/db',
    ]
    for (const targetRef of hostile) {
      await expect(
        harness.executor.execute({
          action: plannedAction({ target_ref: targetRef }),
          context: harness.context,
          observedRevision: OBSERVED_REVISION,
        }),
      ).rejects.toBeInstanceOf(ActionNotAllowedError)
    }
    expect(harness.calls()).toBe(0)
  })

  it('exige dependências concluídas, revisão observada e lease vigente', async () => {
    const harness = createHarness()
    await expect(
      harness.executor.execute({
        action: plannedAction({ dependencies: ['act_create_database_prev'] }),
        context: harness.context,
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ExecutorInputError)

    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: harness.context,
        observedRevision: `obsrev_${'b'.repeat(32)}`,
      }),
    ).rejects.toBeInstanceOf(ExecutorStaleError)

    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: {
          ...harness.context,
          lease: { ...harness.context.lease, fencingToken: 99 },
        },
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(StaleWriterError)

    expect(harness.calls()).toBe(0)
  })

  it('executa com lease vigente e devolve resultado sanitizado', async () => {
    const harness = createHarness()
    const outcome = await harness.executor.execute({
      action: plannedAction({ dependencies: [] }),
      context: {
        ...harness.context,
        completedActionIds: ['act_create_database_prev'],
      },
      observedRevision: OBSERVED_REVISION,
    })

    expect(harness.calls()).toBe(1)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.adapter_id).toBe('pg-process-adapter')
    expect(outcome.executor_version).toBe(ACTION_EXECUTOR_VERSION)
    expect(outcome.argv_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(outcome.safe_detail).toBe('exit_code=0')
    expect(outcome.failure).toBeNull()
    // argv fixo: binário allowlisted, SQL do template versionado, sem shell.
    const argv = harness.adapter.calls[0]?.argv ?? []
    expect(argv[0]).toBe('psql')
    expect(PROCESS_BINARY_ALLOWLIST).toContain(argv[0] as ProcessBinary)
    expect(
      argv.some((element) =>
        element.includes(`CREATE DATABASE ${NAMING.database}`),
      ),
    ).toBe(true)
    expect(argv.join(' ')).not.toContain(';')
  })

  it('recusa template divergente do declarado no contexto', async () => {
    const harness = createHarness()
    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: { ...harness.context, templateId: 'pg-drop-owned-resource' },
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ActionNotAllowedError)
    expect(harness.calls()).toBe(0)
  })

  it('recusa template declarado por sufixo: a comparacao e igualdade exata', async () => {
    const harness = createHarness()

    // `'database'` casaria por sufixo com `'pg-create-database'` (O1 do
    // cross-review): com a igualdade exata, é tratado como divergente.
    await expect(
      harness.executor.execute({
        action: plannedAction(),
        context: { ...harness.context, templateId: 'database' },
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(ActionNotAllowedError)
    expect(harness.calls()).toBe(0)

    // O `template_id` exato do catálogo continua aceito.
    const accepted = await harness.executor.execute({
      action: plannedAction(),
      context: { ...harness.context, templateId: 'pg-create-database' },
      observedRevision: OBSERVED_REVISION,
    })
    expect(accepted.status).toBe('succeeded')
    expect(harness.calls()).toBe(1)
  })

  it('delega ações de control plane à porta dedicada', async () => {
    const withPort = createHarness({ controlPlane: true })
    const outcome = await withPort.executor.execute({
      action: plannedAction({
        kind: 'publish_registry',
        target_ref: `registry-record:${PROJECT_ID}`,
      }),
      context: withPort.context,
      observedRevision: OBSERVED_REVISION,
    })
    expect(outcome.status).toBe('succeeded')
    expect(outcome.adapter_id).toBe('registry-adapter')
    expect(withPort.calls()).toBe(0)

    const withoutPort = createHarness()
    await expect(
      withoutPort.executor.execute({
        action: plannedAction({
          kind: 'publish_registry',
          target_ref: `registry-record:${PROJECT_ID}`,
        }),
        context: withoutPort.context,
        observedRevision: OBSERVED_REVISION,
      }),
    ).rejects.toBeInstanceOf(DriverExecutorUnavailableError)
  })
})

describe('action executor — catálogos e argv', () => {
  it('mantém allowlist de target_ref para todo kind do contrato', () => {
    for (const kind of EXECUTABLE_ACTION_KINDS) {
      expect(TARGET_REF_PREFIXES_BY_KIND[kind].length).toBeGreaterThan(0)
    }
    expect(Object.keys(ADMIN_SQL_TEMPLATES).length).toBeGreaterThan(0)
    expect(Object.keys(ACTION_TEMPLATES).length).toBeGreaterThan(0)
    for (const template of Object.values(ACTION_TEMPLATES)) {
      // O catálogo é fechado: entrada ausente nunca aparece aqui.
      expect(template).toBeDefined()
      if (template === undefined) continue
      expect(PROCESS_BINARY_ALLOWLIST).toContain(template.binary)
      expect(template.argv[0]).toBe(template.binary)
    }
  })

  it('templateFor só devolve template do driver:kind pedido', () => {
    expect(
      templateFor('create_database', 'postgresql_isolated').template_id,
    ).toBe('pg-create-database')
    expect(() => templateFor('start_stack', 'postgresql_isolated')).toThrow(
      ActionNotAllowedError,
    )
  })

  it('assertFixedArgv recusa shell, path, URI, argv0 divergente e binário fora', () => {
    const base = {
      binary: 'psql' as ProcessBinary,
      argv: ['psql', '--version'],
    }
    expect(assertFixedArgv(base)).toEqual(['psql', '--version'])

    const hostileArgv = [
      { binary: 'psql' as ProcessBinary, argv: ['bash', '-c', 'true'] },
      { binary: 'psql' as ProcessBinary, argv: ['/usr/bin/psql', '--version'] },
      { binary: 'psql' as ProcessBinary, argv: ['psql', '/etc/passwd'] },
      { binary: 'psql' as ProcessBinary, argv: ['psql', '../outro'] },
      { binary: 'psql' as ProcessBinary, argv: ['psql', 'a; rm -rf x'] },
      { binary: 'psql' as ProcessBinary, argv: ['psql', 'postgres://u@h/db'] },
      { binary: 'psql' as ProcessBinary, argv: ['psql', '{{database}}'] },
      { binary: 'psql' as ProcessBinary, argv: [] },
    ]
    for (const input of hostileArgv) {
      expect(() => assertFixedArgv(input)).toThrow()
    }
    expect(() =>
      assertFixedArgv({ binary: 'bash' as ProcessBinary, argv: ['bash'] }),
    ).toThrow(ActionNotAllowedError)
  })

  it('renderActionTemplate só aceita SQL versionado e placeholders validados', () => {
    const template = templateFor('create_database', 'postgresql_isolated')
    const params = templateParamsFor(plannedAction(), createHarness().context)
    const argv = renderActionTemplate(template, params)
    expect(argv.join(' ')).toContain(
      // SQL versionado interno: presente por construção no catálogo.
      (ADMIN_SQL_TEMPLATES.create_database ?? 'CREATE').split(' ')[0],
    )
    expect(argv.join(' ')).toContain(NAMING.database)
    expect(argv.join(' ')).toContain(NAMING.app_role)

    expect(() => renderAdminSql('sql_livre_do_request', params)).toThrow(
      ActionNotAllowedError,
    )
    expect(() =>
      renderAdminSql('create_database', {
        ...params,
        database: `${NAMING.database}; DROP DATABASE x`,
      }),
    ).toThrow(ExecutorInputError)
    expect(() => renderAdminSql('create_database', {})).toThrow(
      ExecutorInputError,
    )
    const hostileTemplate: ActionTemplate = {
      ...template,
      template_id: 'pg-hostile',
      argv: ['psql', '--command', '{{sql:inexistente}}'],
    }
    expect(() => renderActionTemplate(hostileTemplate, params)).toThrow(
      ActionNotAllowedError,
    )
  })

  it('parâmetros de template nunca usam o próprio database como canário ou destino', () => {
    const context = createHarness().context
    expect(() =>
      templateParamsFor(plannedAction({ kind: 'verify_cross_isolation' }), {
        ...context,
        peerDatabase: NAMING.database,
      }),
    ).toThrow(ExecutorInputError)
    expect(() =>
      templateParamsFor(plannedAction({ kind: 'verify_cross_isolation' }), {
        ...context,
        peerDatabase: PEER_DATABASE,
      }),
    ).not.toThrow()
    expect(() =>
      templateParamsFor(plannedAction({ kind: 'verify_backup_restore' }), {
        ...context,
        restoreDatabase: NAMING.database,
      }),
    ).toThrow(ExecutorInputError)
    expect(
      templateParamsFor(plannedAction({ kind: 'verify_backup_restore' }), {
        ...context,
        restoreDatabase: RESTORE_DATABASE,
      }).restore_database,
    ).toBe(RESTORE_DATABASE)
  })

  it('assertExecutionEndpoint aceita faixa de allowlist explícita', () => {
    expect(assertExecutionEndpoint({ host: 'localhost', port: 55432 })).toEqual(
      {
        host: 'localhost',
        port: 55432,
      },
    )
    expect(() =>
      assertExecutionEndpoint(
        { host: 'localhost', port: 55433 },
        { allowedPorts: [55432] },
      ),
    ).toThrow(ActionNotAllowedError)
  })
})
