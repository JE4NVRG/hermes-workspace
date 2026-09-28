/**
 * Integração canário P3-03 — harness efémero com guard (passo 13 do plano).
 *
 * Prova no nível de jornada, com os módulos reais do PR 6 (worker, action
 * executor, executor postgresql, secret broker, backup service, restore
 * verifier, rollback service e stores em memória), que:
 *
 * 1. o harness **recusa** qualquer sinal de produção (opt-in explícito,
 *    ambiente, host target, porta, path/prefixo e DSN não-loopback);
 * 2. dois projetos (A alvo, B canário) provisionam databases/roles distintos e a
 *    prova negativa A→B **falha** como esperado (role A não alcança o database
 *    de B), sem grant cruzado;
 * 3. o backup gera artefato com prefixo por projeto/ambiente, checksum e
 *    retenção, e o restore só acontece em alvo efémero, destruído no fim;
 * 4. a publicação só ocorre **depois** de todas as verificações passarem;
 * 5. replay do mesmo item de outbox não repete efeito;
 * 6. rollback de recurso sem ownership vai para intervenção manual e **não**
 *    remove nada;
 * 7. com as flags desligadas nenhum adapter é chamado.
 *
 * O único limite emulado é o processo do sistema (`psql`/`pg_dump`/`pg_restore`):
 * o adapter sintético interpreta o argv real (fixo, renderizado do catálogo
 * fechado) e mantém um cluster em memória — nenhum servidor é tocado. O SQL
 * administrativo continua sendo o versionado interno.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from './feature-flags'
import { buildNamingSnapshot } from './naming'
import { createBackupService } from './backup-service'
import { createInMemoryLeaseStore } from './lease-store'
import { createRestoreVerifier } from './restore-verifier'
import { RollbackServiceError, createRollbackService } from './rollback-service'
import { createInMemoryOutboxStore } from './idempotency'
import { createInMemoryOperationStore } from './operation-store'
import { createInMemoryOperationApprovalStore } from './approval-service'
import {
  createInMemorySecretMaterialStore,
  createSecretBroker,
} from './secret-broker'
import {
  EXECUTION_ADMIN_ROLE,
  createActionExecutor,
} from './executors/action-executor'
import { createPostgresqlExecutor } from './executors/postgresql-executor'
import { createWorker } from './worker'
import {
  HARNESS_OPT_IN_ENV,
  HarnessGuardError,
  assertEphemeralHarness,
} from './harness-guard'
import type { WorkerActionContextPort } from './worker'
import type {
  ProcessAdapter,
  ProcessRunInput,
  ProcessRunResult,
} from './executors/action-executor'
import type { OwnedResource } from './rollback-service'
import type { BackupDestinationPort } from './backup-service'
import type { EphemeralHarnessRequest } from './harness-guard'
import type { Plan, PlannedAction } from './domain'

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})
const NOW = new Date('2026-09-25T12:00:00.000Z')
const HOST_TARGET = 'vps-primary-local' as const
const ENDPOINT = { host: '127.0.0.1', port: 55432 } as const
const HARNESS_ENV = { [HARNESS_OPT_IN_ENV]: '1' } as const

const PROJECT_A = 'acme-site'
const PROJECT_B = 'canary-peer'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function planHashOf(plan: Plan): string {
  return sha256Hex(JSON.stringify(plan))
}

// ---------------------------------------------------------------------------
// Cluster sintético: interpreta o argv REAL do catálogo fechado.
// ---------------------------------------------------------------------------

interface SyntheticDatabase {
  owner: string
  connect_roles: Set<string>
  payload: string
}

interface SyntheticCluster {
  readonly adapters: {
    readonly sql: ProcessAdapter
    readonly dump: ProcessAdapter
    readonly restore: ProcessAdapter
  }
  readonly databases: Map<string, SyntheticDatabase>
  readonly roles: Map<string, { login: boolean }>
  readonly calls: ReadonlyArray<string>
  readonly callCount: () => number
  /** Quantos comandos de criação (`CREATE ...`) já rodaram. */
  readonly creationCalls: () => number
  readonly hasDatabase: (name: string) => boolean
  readonly grants: (database: string, role: string) => boolean
  /** Simula o restore do artefato em alvo efémero (feito pelo adapter real). */
  readonly restoreInto: (target: string, payload: string) => void
  readonly rows: (name: string) => string
}

/**
 * Emula `psql`/`pg_dump`/`pg_restore` sobre um cluster em memória, lendo o
 * mesmo argv `--host/--port/--username/--dbname/--command` do catálogo.
 */
function createSyntheticCluster(): SyntheticCluster {
  const databases = new Map<string, SyntheticDatabase>()
  const roles = new Map<string, { login: boolean }>()
  const calls: Array<string> = []

  function optionValue(
    argv: ReadonlyArray<string>,
    name: string,
  ): string | null {
    const index = argv.indexOf(name)
    if (index === -1 || index + 1 >= argv.length) return null
    return argv[index + 1] ?? null
  }

  function ok(stdout: string, stdout_base64?: string): ProcessRunResult {
    return {
      exit_code: 0,
      stdout,
      stderr: '',
      ...(stdout_base64 === undefined ? {} : { stdout_base64 }),
    }
  }

  function denied(stderr: string): ProcessRunResult {
    return { exit_code: 1, stdout: '', stderr }
  }

  function runSql(argv: ReadonlyArray<string>): ProcessRunResult {
    const user = optionValue(argv, '--username')
    const database = optionValue(argv, '--dbname')
    const sql = optionValue(argv, '--command')
    if (user === null || database === null || sql === null) {
      return denied('argumentos insuficientes')
    }
    calls.push(`psql:${sql.split(' ').slice(0, 2).join(' ')}`)

    const createDatabase = /^CREATE DATABASE (\S+) OWNER (\S+) /.exec(sql)
    if (createDatabase !== null) {
      const [, name, owner] = createDatabase
      if (!roles.has(owner)) return denied(`role "${owner}" does not exist`)
      databases.set(name, {
        owner,
        connect_roles: new Set(),
        payload: '',
      })
      return ok('CREATE DATABASE')
    }

    const createRole = /^CREATE ROLE (\S+) /.exec(sql)
    if (createRole !== null) {
      roles.set(createRole[1], { login: true })
      return ok('CREATE ROLE')
    }

    const grant = /^GRANT CONNECT ON DATABASE (\S+) TO (\S+)$/.exec(sql)
    if (grant !== null) {
      const target = databases.get(grant[1])
      if (target === undefined) return denied('database does not exist')
      target.connect_roles.add(grant[2])
      return ok('GRANT')
    }

    const revoke = /^REVOKE ALL ON DATABASE (\S+) FROM PUBLIC$/.exec(sql)
    if (revoke !== null) {
      const target = databases.get(revoke[1])
      if (target === undefined) return denied('database does not exist')
      target.connect_roles.delete('PUBLIC')
      return ok('REVOKE')
    }

    const dropDatabase = /^DROP DATABASE IF EXISTS (\S+)/.exec(sql)
    if (dropDatabase !== null) {
      databases.delete(dropDatabase[1])
      return ok('DROP DATABASE')
    }

    const dropRole = /^DROP ROLE IF EXISTS (\S+)/.exec(sql)
    if (dropRole !== null) {
      roles.delete(dropRole[1])
      return ok('DROP ROLE')
    }

    if (/^SELECT current_database\(\) IS NOT NULL AS reachable$/.test(sql)) {
      const target = databases.get(database)
      if (target === undefined) {
        return denied(`database "${database}" does not exist`)
      }
      // Superuser administrativo passa; qualquer outra role precisa de grant.
      // Sem grant a prova negativa A->B falha como em produção.
      if (user === EXECUTION_ADMIN_ROLE) return ok('reachable')
      if (!target.connect_roles.has(user)) {
        return denied(`permission denied for database "${database}"`)
      }
      return ok('reachable')
    }

    if (/^SELECT 1 AS restored$/.test(sql)) {
      if (!databases.has(database)) {
        return denied(`database "${database}" does not exist`)
      }
      return ok('1')
    }

    return denied(`comando nao emulado: ${sql.slice(0, 40)}`)
  }

  const sql: ProcessAdapter = {
    adapter_id: 'synthetic-psql',
    binary: 'psql',
    run: async (input: ProcessRunInput) => {
      return runSql(input.argv)
    },
  }

  const dump: ProcessAdapter = {
    adapter_id: 'synthetic-pg-dump',
    binary: 'pg_dump',
    run: async (input: ProcessRunInput) => {
      calls.push('pg_dump')
      const database = optionValue(input.argv, '--dbname')
      const target = database === null ? undefined : databases.get(database)
      if (database === null || target === undefined) {
        return denied(`database "${database ?? '?'}" does not exist`)
      }
      const payload = JSON.stringify({
        database,
        owner: target.owner,
        connect_roles: [...target.connect_roles],
        marker: 'canary-row',
      })
      return ok('', Buffer.from(payload, 'utf8').toString('base64'))
    },
  }

  const restore: ProcessAdapter = {
    adapter_id: 'synthetic-pg-restore',
    binary: 'pg_restore',
    run: async (input: ProcessRunInput) => {
      calls.push('pg_restore')
      const target = optionValue(input.argv, '--dbname')
      if (target === null || input.stdin_base64 === undefined) {
        return denied('destino ou payload ausente')
      }
      const parsed = JSON.parse(
        Buffer.from(input.stdin_base64, 'base64').toString('utf8'),
      ) as { owner?: string; marker?: string }
      databases.set(target, {
        owner: parsed.owner ?? EXECUTION_ADMIN_ROLE,
        connect_roles: new Set(),
        payload: parsed.marker ?? '',
      })
      return ok('pg_restore')
    },
  }

  return {
    adapters: { sql, dump, restore },
    databases,
    roles,
    calls,
    callCount: () => calls.length,
    creationCalls: () =>
      calls.filter((call) => call.startsWith('psql:CREATE')).length,
    hasDatabase: (name) => databases.has(name),
    grants: (database, role) =>
      databases.get(database)?.connect_roles.has(role) === true,
    restoreInto: (target, payload) => {
      databases.set(target, {
        owner: EXECUTION_ADMIN_ROLE,
        connect_roles: new Set(),
        payload,
      })
    },
    rows: (name) => databases.get(name)?.payload ?? '',
  }
}

/** Destino de backup em memória (porta injetada do serviço). */
function createInMemoryDestination(): BackupDestinationPort & {
  readonly stored: ReadonlyArray<string>
} {
  const objects = new Map<string, Uint8Array>()
  const destination = 'local' as const
  return {
    adapter_id: 'synthetic-destination',
    destination,
    stored: [],
    write: async (input) => {
      const artifact_ref = `${input.prefix}${input.filename}`
      objects.set(artifact_ref, input.bytes)
      return { artifact_ref }
    },
    read: async (artifact_ref) => objects.get(artifact_ref) ?? new Uint8Array(),
    list: async (prefix) =>
      [...objects.entries()]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([artifact_ref, bytes]) => ({
          artifact_ref,
          size_bytes: bytes.byteLength,
          created_at: NOW.toISOString(),
        })),
  } as BackupDestinationPort & { readonly stored: ReadonlyArray<string> }
}

// ---------------------------------------------------------------------------
// Planos do canário
// ---------------------------------------------------------------------------

interface CanaryProject {
  readonly projectId: string
  readonly clientId: string
  readonly slug: string
  readonly peerProjectId: string
  readonly peerClientId: string
  readonly peerSlug: string
  readonly naming: ReturnType<typeof buildNamingSnapshot>
  readonly peerNaming: ReturnType<typeof buildNamingSnapshot>
}

function canaryProject(): CanaryProject {
  return {
    projectId: PROJECT_A,
    clientId: 'acme',
    slug: 'site',
    peerProjectId: PROJECT_B,
    peerClientId: 'canary',
    peerSlug: 'peer',
    naming: buildNamingSnapshot({
      client_id: 'acme',
      project_slug: 'site',
      environment: 'development',
      driver: 'postgresql_isolated',
    }),
    peerNaming: buildNamingSnapshot({
      client_id: 'canary',
      project_slug: 'peer',
      environment: 'development',
      driver: 'postgresql_isolated',
    }),
  }
}

function canaryPlan(naming: CanaryProject['naming'], projectId: string): Plan {
  return {
    policy_version: 'pcv2-policy-v1',
    actions: [
      {
        action_id: 'act_create_app_role_01',
        kind: 'create_app_role',
        target_ref: `role:${naming.app_role}`,
        risk: 'reversible',
        reversible: true,
        dependencies: [],
      },
      {
        // `CREATE DATABASE ... OWNER <app_role>` exige a role já criada: no
        // harness a ordem é role -> database (achado registrado no handoff
        // sobre a ordem dos drafts do driver do PR 5).
        action_id: 'act_create_database_01',
        kind: 'create_database',
        target_ref: `database:${naming.database}`,
        risk: 'reversible',
        reversible: true,
        dependencies: ['act_create_app_role_01'],
      },
      {
        action_id: 'act_apply_privilege_01',
        kind: 'apply_least_privilege',
        target_ref: `grant:${naming.database}:${naming.app_role}`,
        risk: 'reversible',
        reversible: true,
        dependencies: ['act_create_app_role_01'],
      },
      {
        action_id: 'act_create_secret_01',
        kind: 'create_secret_ref',
        target_ref: `secret-ref:${projectId}:app-role`,
        risk: 'reversible',
        reversible: true,
        dependencies: ['act_create_app_role_01'],
      },
      {
        action_id: 'act_verify_isolation_01',
        kind: 'verify_cross_isolation',
        target_ref: `verification:cross-isolation:${naming.database}`,
        risk: 'read_only',
        reversible: true,
        dependencies: [],
      },
      {
        action_id: 'act_verify_backup_01',
        kind: 'verify_backup_restore',
        target_ref: `verification:backup-restore:${naming.database}`,
        risk: 'read_only',
        reversible: true,
        dependencies: [],
      },
    ],
    estimated_resources: { cpu_millicores: 500, memory_mb: 512 },
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Jornada
// ---------------------------------------------------------------------------

interface Journey {
  readonly cluster: SyntheticCluster
  readonly destination: ReturnType<typeof createInMemoryDestination>
  readonly verifier: ReturnType<typeof createRestoreVerifier>
  readonly buildWorkerFor: (
    flags: ReturnType<typeof resolveProjectCenterV2Flags>,
  ) => ReturnType<typeof createWorker>
  readonly workerA: ReturnType<typeof createWorker>
  readonly workerB: ReturnType<typeof createWorker>
  readonly operationsA: ReturnType<typeof createInMemoryOperationStore>
  readonly outboxA: ReturnType<typeof createInMemoryOutboxStore>
  readonly operationIdA: string
  readonly operationIdB: string
  readonly publishA: ReadonlyArray<string>
  readonly publishB: ReadonlyArray<string>
  readonly restoreDatabaseA: string
}

function buildJourney(): Journey {
  const cluster = createSyntheticCluster()
  const destination = createInMemoryDestination()
  const leases = createInMemoryLeaseStore({ now: () => NOW })
  const secrets = createSecretBroker({
    materials: createInMemorySecretMaterialStore(),
    pepper: 'p'.repeat(48),
    now: () => NOW,
  })
  const backups = createBackupService({
    flags: FLAGS_ON,
    leases,
    destinations: { local: destination },
    now: () => NOW,
  })
  const canary = canaryProject()

  const adminHandle = {
    secret_ref: `sref_${'a'.repeat(43)}`,
    masked_ref: 'sref_***',
    fingerprint: `f_${'a'.repeat(58)}`,
    purpose: 'admin_bootstrap' as const,
    project_id: canary.projectId,
    environment: 'development' as const,
    reveal: () => 'admin-material',
    toJSON: () => ({
      masked_ref: 'sref_***',
      fingerprint: `f_${'a'.repeat(58)}`,
      purpose: 'admin_bootstrap' as const,
    }),
  }
  const postgres = createPostgresqlExecutor({
    processes: cluster.adapters,
    secrets,
    adminCredential: { acquire: () => adminHandle },
  })

  const publishedA: Array<string> = []
  const publishedB: Array<string> = []
  const actions = createActionExecutor({
    flags: FLAGS_ON,
    leases,
    drivers: { postgresql_isolated: postgres },
    controlPlane: {
      adapter_id: 'synthetic-control-plane',
      publish: async (input) => {
        if (input.projectId === canary.projectId) publishedA.push(input.kind)
        if (input.projectId === canary.peerProjectId)
          publishedB.push(input.kind)
        return {
          status: 'succeeded',
          safe_detail: `control-plane ${input.kind}`,
        }
      },
    },
    backups: {
      adapter_id: 'synthetic-backup-channel',
      configure: async (input) => ({
        status: 'succeeded',
        safe_detail: `backup channel ${input.kind}`,
        evidence_ref: input.targetRef,
      }),
    },
    now: () => NOW,
  })

  const operationsA = createInMemoryOperationStore({
    now: () => NOW.toISOString(),
    generateId: () => '11111111-1111-4111-8111-111111111111',
  })
  const operationsB = createInMemoryOperationStore({
    now: () => NOW.toISOString(),
    generateId: () => '22222222-2222-4222-8222-222222222222',
  })
  const planA = canaryPlan(canary.naming, canary.projectId)
  const planB = canaryPlan(canary.peerNaming, canary.peerProjectId)
  const intentA = {
    client_id: canary.clientId,
    project_slug: canary.slug,
    display_name: 'Acme Site',
    environment: 'development' as const,
    driver: 'postgresql_isolated' as const,
    host_target: HOST_TARGET,
    capabilities: {
      auth: false,
      storage: false,
      realtime: false,
      postgrest: false,
      backup: true as const,
    },
    requested_limits: {
      database_size_mb: 1024,
      memory_mb: 1024,
      cpu_millicores: 500,
    },
  }
  const intentB = {
    client_id: canary.peerClientId,
    project_slug: canary.peerSlug,
    display_name: 'Canary Peer',
    environment: 'development' as const,
    driver: 'postgresql_isolated' as const,
    host_target: HOST_TARGET,
    capabilities: {
      auth: false,
      storage: false,
      realtime: false,
      postgrest: false,
      backup: true as const,
    },
    requested_limits: {
      database_size_mb: 1024,
      memory_mb: 1024,
      cpu_millicores: 500,
    },
  }

  const createdA = operationsA.create({
    intent: intentA,
    plan: planA,
    planHash: planHashOf(planA),
    expiresAt: '2026-09-25T23:00:00.000Z',
    statusUrl: '/api/project-center/v2/operations/x',
    auditUrl: '/api/project-center/v2/operations/x/audit',
    observedRevision: 'rev-1',
  })
  const createdB = operationsB.create({
    intent: intentB,
    plan: planB,
    planHash: planHashOf(planB),
    expiresAt: '2026-09-25T23:00:00.000Z',
    statusUrl: '/api/project-center/v2/operations/y',
    auditUrl: '/api/project-center/v2/operations/y/audit',
    observedRevision: 'rev-1',
  })

  // Caminho canónico até `queued` + aprovação válida no store (PR 4/5).
  let operationA = createdA
  for (const next of ['awaiting_approval', 'approved', 'queued'] as const) {
    operationA = operationsA.transition(
      operationA.operation_id,
      next,
      operationA.operation_version,
    )
  }
  let operationB = createdB
  for (const next of ['awaiting_approval', 'approved', 'queued'] as const) {
    operationB = operationsB.transition(
      operationB.operation_id,
      next,
      operationB.operation_version,
    )
  }

  const approvalsA = createInMemoryOperationApprovalStore()
  approvalsA.put(operationA.operation_id, {
    approval_id: '33333333-3333-4333-8333-333333333333',
    decision: 'approve',
    actor_ref: 'usr_jean',
    plan_hash: operationA.plan_hash,
    decided_at: '2026-09-25T11:00:00.000Z',
    expires_at: '2026-09-25T23:00:00.000Z',
  })
  const approvalsB = createInMemoryOperationApprovalStore()
  approvalsB.put(operationB.operation_id, {
    approval_id: '44444444-4444-4444-8444-444444444444',
    decision: 'approve',
    actor_ref: 'usr_jean',
    plan_hash: operationB.plan_hash,
    decided_at: '2026-09-25T11:00:00.000Z',
    expires_at: '2026-09-25T23:00:00.000Z',
  })

  const outboxA = createInMemoryOutboxStore()
  outboxA.append({
    operationId: operationA.operation_id,
    kind: 'execute',
    planHash: operationA.plan_hash,
    projectId: operationA.project_id,
    environment: 'development',
    outboxId: 'outbox-a-1',
  })

  const contextFor = (
    peerDatabase: string,
    restoreDatabase: string,
    restorePayloadBase64: string,
  ): WorkerActionContextPort => ({
    adapter_id: 'synthetic-context',
    resolve: async () => ({
      hostTarget: HOST_TARGET,
      endpoint: ENDPOINT,
      peerDatabase,
      restoreDatabase,
      restorePayloadBase64,
    }),
  })

  // Alvo efémero do teste de restore do projeto A (emitido pelo verifier).
  const restoreTarget = createRestoreVerifier({
    flags: FLAGS_ON,
    leases,
    backups,
    runRestore: async () => ({
      exit_code: 0,
      origin_untouched: true,
      restored_rows: 1,
    }),
    dropTarget: async () => {},
    now: () => NOW,
    generateId: () => 'abcdef1234567890abcdef1234567890',
  }).issueTarget()

  const base = {
    flags: FLAGS_ON,
    leases,
    actions,
    publisher: {
      adapter_id: 'synthetic-publisher',
      publish: async () => ({
        published: true,
        safe_detail: 'publicado',
      }),
    },
    rollback: createRollbackService({
      flags: FLAGS_ON,
      leases,
      actions,
      observations: {
        adapter_id: 'synthetic-rollback-observer',
        observe: async () => ({
          resources: [],
          observed_revision: 'rev-1',
          drift_findings: [],
        }),
      },
      now: () => NOW,
    }),
    holderRef: 'worker-canary',
    now: () => NOW,
  }

  const rollbackPlans = {
    put: () => ({}) as never,
    get: () => null,
    discard: () => {},
  }
  const observations = {
    adapter_id: 'synthetic-observer',
    observe: async () => ({ revision: 'rev-1' }),
    ownedResources: async () => [],
  }
  const restorePayloadBase64 = Buffer.from(
    JSON.stringify({
      database: canary.naming.database,
      owner: EXECUTION_ADMIN_ROLE,
      marker: 'canary-row',
    }),
    'utf8',
  ).toString('base64')
  const contextA = contextFor(
    canary.peerNaming.database,
    restoreTarget.target_name,
    restorePayloadBase64,
  )

  /** Worker do projeto A com as flags escolhidas (usado no teste de flags off). */
  function buildWorkerFor(
    flags: ReturnType<typeof resolveProjectCenterV2Flags>,
  ): ReturnType<typeof createWorker> {
    return createWorker({
      ...base,
      flags,
      operations: operationsA,
      approvals: approvalsA,
      rollbackPlans,
      outbox: outboxA,
      observations,
      context: contextA,
    })
  }

  return {
    cluster,
    destination,
    buildWorkerFor,
    verifier: createRestoreVerifier({
      flags: FLAGS_ON,
      leases,
      backups,
      runRestore: async () => ({
        exit_code: 0,
        origin_untouched: true,
        restored_rows: 1,
      }),
      dropTarget: async () => {},
      now: () => NOW,
    }),
    workerA: buildWorkerFor(FLAGS_ON),
    workerB: createWorker({
      ...base,
      operations: operationsB,
      approvals: approvalsB,
      rollbackPlans,
      outbox: createInMemoryOutboxStore(),
      observations,
      context: contextFor(
        canary.naming.database,
        restoreTarget.target_name,
        restorePayloadBase64,
      ),
    }),
    operationsA,
    outboxA,
    operationIdA: operationA.operation_id,
    operationIdB: operationB.operation_id,
    publishA: publishedA,
    publishB: publishedB,
    restoreDatabaseA: restoreTarget.target_name,
  }
}

describe('harness efemero P3-03 — guard', () => {
  const valid: EphemeralHarnessRequest = {
    environment: 'development',
    host_target: HOST_TARGET,
    endpoint: ENDPOINT,
    work_dir: 'harness/canary',
    backup_prefix: 'projects/acme-site/development/postgres/',
  }

  it('sem opt-in explicito recusa', () => {
    expect(() => assertEphemeralHarness(valid, {})).toThrow(HarnessGuardError)
  })

  it('recusa ambiente de producao', () => {
    expect(() =>
      assertEphemeralHarness(
        { ...valid, environment: 'production' },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
  })

  it('recusa host target, porta e path de producao', () => {
    expect(() =>
      assertEphemeralHarness(
        { ...valid, host_target: 'vps-primary' },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
    expect(() =>
      assertEphemeralHarness(
        { ...valid, endpoint: { host: '10.0.0.5', port: 55432 } },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
    expect(() =>
      assertEphemeralHarness(
        { ...valid, endpoint: { host: '127.0.0.1', port: 5432 } },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
    expect(() =>
      assertEphemeralHarness(
        { ...valid, work_dir: '/var/lib/postgresql' },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
    expect(() =>
      assertEphemeralHarness(
        { ...valid, backup_prefix: 'production/postgres/' },
        HARNESS_ENV,
      ),
    ).toThrow(HarnessGuardError)
  })

  it('recusa DSN nao-loopback no ambiente', () => {
    expect(() =>
      assertEphemeralHarness(valid, {
        ...HARNESS_ENV,
        POSTGRES_DSN:
          'postgres://user:synthetic-password@198.51.100.7:5432/lab',
      }),
    ).toThrow(HarnessGuardError)
  })

  it('aceita harness efemero com opt-in', () => {
    expect(() => assertEphemeralHarness(valid, HARNESS_ENV)).not.toThrow()
  })
})

describe('jornada canonica P3-03 — dois projetos em harness efemero', () => {
  it('provisiona A e B, prova isolamento cruzado e so entao publica', async () => {
    assertEphemeralHarness(
      {
        environment: 'development',
        host_target: HOST_TARGET,
        endpoint: ENDPOINT,
        work_dir: 'harness/canary',
        backup_prefix: 'projects/acme-site/development/postgres/',
      },
      HARNESS_ENV,
    )
    const journey = buildJourney()
    const canary = canaryProject()

    // Projeto B (canário) já existe no cluster, sem grant para a role de A.
    journey.cluster.restoreInto(canary.peerNaming.database, 'peer-row')

    const executed = await journey.workerA.runOnce()
    expect(executed.entries[0]?.status).toBe('processed')
    expect(executed.entries[0]?.state).toBe('verifying')
    expect(journey.cluster.hasDatabase(canary.naming.database)).toBe(true)
    expect(journey.cluster.roles.has(canary.naming.app_role)).toBe(true)
    // A role de A não tem acesso ao database do projeto B.
    expect(
      journey.cluster.grants(
        canary.peerNaming.database,
        canary.naming.app_role,
      ),
    ).toBe(false)

    // Estado da operação A depois da execução: `verifying` (nada publicado).
    expect(journey.operationsA.require(journey.operationIdA).state).toBe(
      'verifying',
    )
    expect(journey.publishA).toHaveLength(0)

    // Tique de verificação: prova negativa A->B e restore reachable.
    // O item de verificação é encadeado pelo próprio worker (outbox_id
    // determinístico `verify:<operation_id>`), não pela mão do teste.
    const verified = await journey.workerA.runOnce()
    expect(verified.entries.map((entry) => entry.kind)).toEqual(['verify'])
    expect(verified.entries[0]?.state).toBe('succeeded')
    expect(verified.published).toBe(1)
    const operationA = journey.operationsA.require(journey.operationIdA)
    expect(operationA.state).toBe('succeeded')
    // Duas provas de verificação, ambas com desfecho de sucesso.
    expect(
      verified.entries[0]?.checks?.map((check) => check.name).sort(),
    ).toEqual(['verify_backup_restore', 'verify_cross_isolation'])
    expect(
      verified.entries[0]?.checks?.every(
        (check) => check.outcome === 'succeeded',
      ),
    ).toBe(true)
    // Restore foi para o alvo efémero (nunca para a origem de outro projeto).
    expect(journey.cluster.rows(journey.restoreDatabaseA)).toBe('canary-row')
    expect(journey.cluster.rows(canary.peerNaming.database)).toBe('peer-row')
  })

  it('replay do mesmo item de outbox nao repete efeito', async () => {
    const journey = buildJourney()
    const first = await journey.workerA.runOnce()
    expect(first.entries[0]?.status).toBe('processed')
    expect(first.entries[0]?.kind).toBe('execute')
    const createsAfterFirst = journey.cluster.creationCalls()
    expect(createsAfterFirst).toBe(2)

    // Segundo tick processa apenas a verificação encadeada: o item de execução
    // já está concluído no diário do worker e não repete efeito.
    const replay = await journey.workerA.runOnce()
    expect(replay.entries.map((entry) => entry.kind)).toEqual(['verify'])
    expect(journey.cluster.creationCalls()).toBe(createsAfterFirst)
  })

  it('backup gera artefato com checksum/retencao e restore so em alvo efemero', async () => {
    const journey = buildJourney()
    const canary = canaryProject()
    const leases = createInMemoryLeaseStore({ now: () => NOW })
    const lease = leases.acquire({
      operationId: journey.operationIdA,
      projectId: canary.projectId,
      environment: 'development',
      holderRef: 'backup-canary',
      ttlSeconds: 300,
    })
    const backups = createBackupService({
      flags: FLAGS_ON,
      leases,
      destinations: { local: journey.destination },
      now: () => NOW,
    })
    const artifactBytes = new TextEncoder().encode(
      JSON.stringify({
        database: canary.naming.database,
        marker: 'canary-row',
      }),
    )
    const run = await backups.run({
      operationId: journey.operationIdA,
      projectId: canary.projectId,
      environment: 'development',
      driver: 'postgresql_isolated',
      naming: canary.naming,
      lease: {
        leaseId: lease.lease_id,
        fencingToken: lease.fencing_token,
        holderRef: lease.holder_ref,
      },
      retentionDays: 30,
      destination: 'local',
      dump: async () => artifactBytes,
    })

    expect(run.artifact.project_id).toBe(canary.projectId)
    expect(run.artifact.environment).toBe('development')
    expect(run.artifact.prefix).toContain(canary.projectId)
    expect(run.artifact.checksum).toBe(
      createHash('sha256').update(artifactBytes).digest('hex'),
    )
    expect(run.artifact.retention_days).toBe(30)
    expect(run.manifest.checksum).toBe(run.artifact.checksum)

    const dropped: Array<string> = []
    const verifier = createRestoreVerifier({
      flags: FLAGS_ON,
      leases,
      backups,
      runRestore: async (input) => {
        // Alvo efémero é o único destino; a origem nunca é tocada.
        expect(input.target.target_name.startsWith('je4ndev_pcv2_')).toBe(true)
        journey.cluster.restoreInto(input.target.target_name, 'canary-row')
        return { exit_code: 0, origin_untouched: true, restored_rows: 1 }
      },
      dropTarget: async (target) => {
        dropped.push(target.target_name)
        journey.cluster.databases.delete(target.target_name)
      },
      now: () => NOW,
    })

    const verification = await verifier.verify({
      operationId: journey.operationIdA,
      artifact: run.artifact,
      manifest: run.manifest,
      bytes: artifactBytes,
      origin: {
        project_id: canary.projectId,
        environment: 'development',
        driver: 'postgresql_isolated',
        database: canary.naming.database,
      },
      lease: {
        leaseId: lease.lease_id,
        fencingToken: lease.fencing_token,
        holderRef: lease.holder_ref,
      },
    })

    expect(verification.verified_bytes).toBe(artifactBytes.byteLength)
    expect(verification.restored_rows).toBe(1)
    expect(verification.target_destroyed).toBe(true)
    expect(dropped).toEqual([verification.target.target_name])
    expect(journey.cluster.hasDatabase(verification.target.target_name)).toBe(
      false,
    )
  })

  it('rollback sem ownership nao remove recurso', async () => {
    const journey = buildJourney()
    const canary = canaryProject()
    await journey.workerA.runOnce()
    expect(journey.cluster.hasDatabase(canary.naming.database)).toBe(true)

    const leases = createInMemoryLeaseStore({ now: () => NOW })
    const offOwnerResource: OwnedResource = {
      target_ref: `database:${canary.naming.database}`,
      resource_name: canary.naming.database,
      project_id: canary.projectId,
      environment: 'development',
      driver: 'postgresql_isolated',
      ownership_marker: null,
      created_by_operation_id: null,
      exists: true,
    }
    const rollback = createRollbackService({
      flags: FLAGS_ON,
      leases,
      actions: createActionExecutor({
        flags: FLAGS_ON,
        leases,
        drivers: {},
      }),
      observations: {
        adapter_id: 'synthetic-rollback-observer',
        observe: async () => ({
          resources: [offOwnerResource],
          observed_revision: 'rev-2',
          drift_findings: ['ownership_marker_ausente'],
        }),
      },
      now: () => NOW,
    })

    const rollbackPlan = {
      rollback_plan_hash: sha256Hex('rollback'),
      actions: [
        {
          action_id: 'act_drop_database_01',
          kind: 'drop_resource_created_by_operation' as const,
          target_ref: `database:${canary.naming.database}`,
          risk: 'destructive' as const,
          reversible: false,
          dependencies: [],
        },
      ],
      preserve_data: false,
      destructive: true,
      ownership_verified: true as const,
      observed_revision: 'rev-2',
      expires_at: '2026-09-25T23:00:00.000Z',
    }
    const operation = journey.operationsA.require(journey.operationIdA)
    const observation = {
      actions: rollbackPlan.actions,
      observed_revision: 'rev-2',
      ownership_verified: true,
      drift_findings: ['ownership_marker_ausente'],
    }
    // Drift observado: o serviço recusa fechado em vez de destruir o recurso.
    let refusal: unknown = null
    try {
      rollback.planExecution({
        operation,
        rollbackPlan,
        observation,
        resources: [offOwnerResource],
        now: NOW,
      })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(RollbackServiceError)
    expect((refusal as RollbackServiceError).code).toBe(
      'MANUAL_INTERVENTION_REQUIRED',
    )

    // Sem drift, mas com recurso sem ownership: plano vai para intervenção
    // manual e nada é executável.
    const planExecution = rollback.planExecution({
      operation,
      rollbackPlan,
      observation: { ...observation, drift_findings: [] },
      resources: [offOwnerResource],
      now: NOW,
    })

    expect(planExecution.requires_manual_intervention).toBe(true)
    expect(planExecution.manual).toHaveLength(1)
    expect(planExecution.executable).toHaveLength(0)
    // Recurso sem ownership continua no cluster.
    expect(journey.cluster.hasDatabase(canary.naming.database)).toBe(true)
  })

  it('com flags desligadas nenhum adapter e chamado', async () => {
    const journey = buildJourney()
    const callsBefore = journey.cluster.callCount()
    await expect(
      journey.buildWorkerFor(FLAGS_OFF).runOnce(),
    ).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(journey.cluster.callCount()).toBe(callsBefore)
    expect(journey.cluster.hasDatabase(canaryProject().naming.database)).toBe(
      false,
    )
  })
})

/** Ações do plano do canário usadas nas asserções de conformidade. */
export function canaryPlanKinds(
  plan: Plan,
): ReadonlyArray<PlannedAction['kind']> {
  return plan.actions.map((action) => action.kind)
}
