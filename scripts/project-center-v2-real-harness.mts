#!/usr/bin/env node
/**
 * Harness efémero **real** do Project Center v2 — gate final (PR 7).
 *
 * Fonte da verdade: `docs/plans/project-center-v2-implementation-plan.md` (§PR 7,
 * passos 4 e 5), `docs/security/project-center-v2-threat-model.md` (§I-11) e a
 * decisão do gate: só é autorizado harness **efémero e isolado**, com nome
 * derivado de UUID, porta/volume exclusivos e guard que recusa host, path e
 * ambiente de produção.
 *
 * O que este script prova com execução real (nenhum cluster sintético):
 *
 *  1. provisionamento real de dois projetos (`psql` de verdade) por `psql`
 *     contra um PostgreSQL efémero;
 *  2. replay do item de outbox não repete DDL nem duplica recurso;
 *  3. backup real (`pg_dump`) com prefixo dedicado, checksum e retenção;
 *  4. prova negativa A→B: a role de A alcança o próprio database e é NEGADA no
 *     database de B (e vice-versa), com controle positivo A→A;
 *  5. verificação do plano (isolamento + restore efémero por `pg_restore`) e
 *     publicação só depois de PASS, com o alvo efémero destruído no fim;
 *  6. falha transitória (conexão recusada real) agendada como retry e
 *     reconciliada sem duplicação;
 *  7. falha parcial (database pré-existente) escala para
 *     `manual_intervention_required`;
 *  8. lease: segundo writer recusado, writer com token stale recusado **antes**
 *     do adapter (nenhum comando novo);
 *  9. rollback com gate próprio (hash + aprovação + ownership): recurso com
 *     proveniência é removido; recurso pré-existente nunca é removido;
 * 10. flags desligadas impedem qualquer execução (default do repositório);
 * 11. **defeito P7-01**: ação de rollback com alvo `role:` executa o template
 *     `pg-drop-owned-resource`, cujo SQL é fixo em `drop_database` — a role
 *     nunca é removida e o **database** é apagado em seu lugar. Provado aqui
 *     com o cluster real (o database desaparece e a role permanece).
 *
 * Fronteira: container `je4ndev_pcv2_<hex>` (nome derivado do UUID do
 * processo), volume `je4ndev_pcv2_<hex>_data`, porta efémera publicada apenas
 * em loopback, todos removidos no fim. Os clientes (`psql`, `pg_dump`,
 * `pg_restore`) correm dentro da **mesma imagem pinada por digest**
 * (`docker run --rm --network host`), o que garante o mesmo toolchain do
 * servidor e honra byte a byte o argv renderizado pelo executor — sem shell. O
 * script nunca toca container, volume, network, imagem ou porta de produção,
 * nem o PostgreSQL do host (5432 é denylistada no guard e no executor).
 * Nenhum segredo real: a credencial administrativa e o pepper do broker são
 * gerados em runtime e o relatório é conferido contra os dois.
 *
 * `supabase_isolated` **não** é executável nesta fronteira: o executor do
 * driver exige uma implementação de `StackAdapter` (`supabase-stack-adapter`) e
 * uma porta de projeção que o repositório não contém (o PR 6 as deixa para o
 * deployment), e o template `sb-stack-full` exige os seis serviços com imagens
 * pinadas por digest ausentes no host. Isso é registrado como nota explícita —
 * nunca substituído por narrativa.
 *
 * Uso:
 *
 *   PROJECT_CENTER_V2_TEST_HARNESS=1 pnpm run project-center:v2:harness
 *
 * Opções: `--report <arquivo>` (default `qa-artifacts/pcv2-harness/<uuid>/report.json`),
 * `--keep` (não remove container/volume no fim; só para depuração manual),
 * `--json` (imprime apenas o JSON, sem as linhas legíveis).
 * Exit code: 0 = todas as provas PASS; 1 = alguma prova falhou; 2 = uso/ambiente.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'

import {
  createInMemoryOperationApprovalStore,
  createInMemoryRollbackPlanStore,
  RollbackUnsafeError,
} from '../src/server/project-center-v2/approval-service'
import { createBackupService } from '../src/server/project-center-v2/backup-service'
import {
  FeatureDisabledError,
  describeFlags,
  resolveProjectCenterV2Flags,
} from '../src/server/project-center-v2/feature-flags'
import {
  EXECUTION_ADMIN_ROLE,
  createActionExecutor,
  renderActionTemplate,
  templateFor,
} from '../src/server/project-center-v2/executors/action-executor'
import { createPostgresqlExecutor } from '../src/server/project-center-v2/executors/postgresql-executor'
import {
  HARNESS_OPT_IN_ENV,
  HarnessGuardError,
  assertEphemeralHarness,
} from '../src/server/project-center-v2/harness-guard'
import { createInMemoryOutboxStore } from '../src/server/project-center-v2/idempotency'
import {
  LeaseHeldError,
  StaleWriterError,
  createInMemoryLeaseStore,
} from '../src/server/project-center-v2/lease-store'
import {
  buildNamingSnapshot,
  localBackupPrefixFor,
} from '../src/server/project-center-v2/naming'
import { createInMemoryOperationStore } from '../src/server/project-center-v2/operation-store'
import { createRestoreVerifier } from '../src/server/project-center-v2/restore-verifier'
import {
  RollbackServiceError,
  buildRollbackPlan,
  createRollbackService,
} from '../src/server/project-center-v2/rollback-service'
import {
  createInMemorySecretMaterialStore,
  createSecretBroker,
} from '../src/server/project-center-v2/secret-broker'
import { createWorker } from '../src/server/project-center-v2/worker'
import type {
  ProcessAdapter,
  ProcessRunInput,
  ProcessRunResult,
} from '../src/server/project-center-v2/executors/action-executor'
import type { BackupDestinationPort } from '../src/server/project-center-v2/backup-service'
import type {
  Driver,
  Operation,
  Plan,
  PlannedAction,
  ProjectIntent,
} from '../src/server/project-center-v2/domain'
import type { OwnedResource } from '../src/server/project-center-v2/rollback-service'
import type { ResourceNamingSnapshot } from '../src/server/project-center-v2/naming'
import type { EphemeralRestoreTarget } from '../src/server/project-center-v2/restore-verifier'
import type {
  WorkerActionContextPort,
  WorkerObservationPort,
  WorkerRunResult,
} from '../src/server/project-center-v2/worker'

// ---------------------------------------------------------------------------
// Identidade do harness (UUID → nome, volume e diretório exclusivos)
// ---------------------------------------------------------------------------

const UUID = randomUUID()
const SHORT = UUID.replaceAll('-', '').slice(0, 12)
const CONTAINER = `je4ndev_pcv2_${SHORT}`
const VOLUME = `je4ndev_pcv2_${SHORT}_data`
const LABEL = `je4ndev.pcv2.harness=${UUID}`
const WORK_DIR = `qa-artifacts/pcv2-harness/${UUID}`
const IMAGE =
  process.env.PCV2_HARNESS_IMAGE ??
  'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
const ADMIN_ROLE = EXECUTION_ADMIN_ROLE
const HOST_TARGET = 'vps-primary-local'
const ENVIRONMENT = 'development'
const DRIVER: Driver = 'postgresql_isolated'
const OBSERVED_REVISION = 'rev-harness-1'
const ADMIN_MATERIAL = randomBytes(24).toString('base64url')
const BROKER_PEPPER = randomBytes(48).toString('base64url')
const NOW = new Date('2026-09-25T12:00:00.000Z')
const EXPIRES_AT = '2026-09-25T23:00:00.000Z'

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
  PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

interface HarnessCheck {
  id: string
  name: string
  status: 'PASS' | 'FAIL'
  detail: string
  extra?: Record<string, unknown>
}
interface HarnessFinding {
  id: string
  severity: 'critica' | 'alta' | 'media' | 'baixa'
  title: string
  detail: string
  evidence: string
}
interface CommandRecord {
  adapter: string
  argv: ReadonlyArray<string>
  exit_code: number
  duration_ms: number
}

const checks: Array<HarnessCheck> = []
const findings: Array<HarnessFinding> = []
const commands: Array<CommandRecord> = []
const notes: Array<{ kind: string; detail: string }> = []

function check(
  id: string,
  name: string,
  ok: boolean,
  detail: string,
  extra?: Record<string, unknown>,
): boolean {
  checks.push({
    id,
    name,
    status: ok ? 'PASS' : 'FAIL',
    detail,
    ...(extra === undefined ? {} : { extra }),
  })
  return ok
}

function finding(
  id: string,
  severity: HarnessFinding['severity'],
  title: string,
  detail: string,
  evidence: string,
): void {
  findings.push({ id, severity, title, detail, evidence })
}

function note(kind: string, detail: string): void {
  notes.push({ kind, detail })
}

function withoutMaterial(
  argv: ReadonlyArray<string>,
  material: string,
): Array<string> {
  return argv.map((element) =>
    material.length > 0 && element.includes(material)
      ? element.split(material).join('[REDACTED]')
      : element,
  )
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function countIn(values: ReadonlyArray<string>, value: string): number {
  return values.filter((entry) => entry === value).length
}

// ---------------------------------------------------------------------------
// Docker (argv fixo, sem shell; nunca toca recurso que não seja deste UUID)
// ---------------------------------------------------------------------------

function docker(args: ReadonlyArray<string>): string {
  return execFileSync('docker', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function dockerNoThrow(args: ReadonlyArray<string>): {
  ok: boolean
  output: string
} {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

function assertNamesAreFree(): void {
  const container = dockerNoThrow(['inspect', CONTAINER])
  const volume = dockerNoThrow(['volume', 'inspect', VOLUME])
  if (container.ok || volume.ok) {
    throw new Error(
      'nome de harness ja existe; abortando sem tocar recurso alheio',
    )
  }
}

function startContainer(port: number): void {
  docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--label',
    LABEL,
    '--publish',
    `127.0.0.1:${port}:5432`,
    '--volume',
    `${VOLUME}:/var/lib/postgresql/data`,
    '--env',
    `POSTGRES_USER=${ADMIN_ROLE}`,
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    IMAGE,
  ])
}

// ---------------------------------------------------------------------------
// Portas efémeras (janela do guard: 10240..65000)
// ---------------------------------------------------------------------------

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => {
      server.close(() => resolvePromise(true))
    })
    server.listen({ host: '127.0.0.1', port })
  })
}

async function allocateEphemeralPort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000)
    if (await isPortFree(port)) return port
  }
  throw new Error('sem porta efemera livre na janela do guard')
}

// ---------------------------------------------------------------------------
// Adapter de processo REAL (spawn de psql/pg_dump/pg_restore, argv fixo)
// ---------------------------------------------------------------------------

let endpointPort = 0

function createRealProcessAdapter(
  binary: 'psql' | 'pg_dump' | 'pg_restore',
): ProcessAdapter {
  return {
    adapter_id: `pcv2-real-${binary}`,
    binary,
    run: async (input: ProcessRunInput): Promise<ProcessRunResult> => {
      for (const element of input.argv) {
        if (element.includes(ADMIN_MATERIAL)) {
          throw new Error('material administrativo em argv recusado')
        }
      }
      // O handle administrativo injetado é consumido como no deployment real
      // (`reveal()`), mas o material sintético não é exportado: o servidor
      // efémero só aceita loopback com trust, dentro do container pinado.
      if (input.credential !== undefined) {
        void input.credential.reveal()
      }
      // O cliente corre dentro da **mesma imagem pinada por digest** do
      // servidor (`--network host`): o toolchain tem a mesma versão maior do
      // servidor (sem incompatibilidade de `pg_dump`) e o argv renderizado pelo
      // executor é honrado byte a byte depois do binário.
      const argv = [
        'docker',
        'run',
        '--rm',
        '--interactive',
        '--network',
        'host',
        '--label',
        LABEL,
        '--env',
        'PGCONNECT_TIMEOUT=5',
        '--env',
        `PGAPPNAME=pcv2-harness-${SHORT}`,
        IMAGE,
        ...input.argv,
      ]
      const startedAt = Date.now()
      const result = spawnSync(argv[0], argv.slice(1), {
        env: { ...process.env },
        ...(input.stdin_base64 === undefined
          ? {}
          : { input: Buffer.from(input.stdin_base64, 'base64') }),
        timeout: input.timeout_ms,
        maxBuffer: 64 * 1024 * 1024,
      })
      commands.push({
        adapter: binary,
        argv: withoutMaterial(argv, ADMIN_MATERIAL),
        exit_code: result.status ?? -1,
        duration_ms: Date.now() - startedAt,
      })
      return {
        exit_code: result.status ?? -1,
        stdout: result.stdout?.toString('utf8') ?? '',
        stderr: result.stderr?.toString('utf8') ?? '',
        stdout_base64: result.stdout?.toString('base64') ?? '',
      }
    },
  }
}

const psqlAdapter = createRealProcessAdapter('psql')
const pgDumpAdapter = createRealProcessAdapter('pg_dump')
const pgRestoreAdapter = createRealProcessAdapter('pg_restore')

// ---------------------------------------------------------------------------
// SQL do harness (argv fixo; identificadores derivados server-side)
// ---------------------------------------------------------------------------

interface SqlOutcome {
  exit_code: number
  stdout: string
  stderr: string
  rows: Array<string>
}

function assertHarnessIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`identificador fora da allowlist do harness: ${value}`)
  }
  return value
}

function toOutcome(result: ProcessRunResult): SqlOutcome {
  return {
    exit_code: result.exit_code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    rows: result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  }
}

async function adminSql(
  sql: string,
  database = 'postgres',
): Promise<SqlOutcome> {
  return toOutcome(
    await psqlAdapter.run({
      argv: [
        'psql',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--host',
        '127.0.0.1',
        '--port',
        String(endpointPort),
        '--username',
        ADMIN_ROLE,
        '--dbname',
        assertHarnessIdentifier(database),
        '--command',
        sql,
      ],
      timeout_ms: 30_000,
    }),
  )
}

async function asAppRole(
  role: string,
  database: string,
  sql = 'SELECT current_database()',
): Promise<SqlOutcome> {
  return toOutcome(
    await psqlAdapter.run({
      argv: [
        'psql',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--host',
        '127.0.0.1',
        '--port',
        String(endpointPort),
        '--username',
        assertHarnessIdentifier(role),
        '--dbname',
        assertHarnessIdentifier(database),
        '--command',
        sql,
      ],
      timeout_ms: 30_000,
    }),
  )
}

async function listDatabases(): Promise<Array<string>> {
  const result = await adminSql(
    "SELECT datname FROM pg_database WHERE datname LIKE 'je4ndev\\_%' ORDER BY datname",
  )
  return result.rows
}

async function listRoles(): Promise<Array<string>> {
  const result = await adminSql(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'je4ndev\\_%' ORDER BY rolname",
  )
  return result.rows
}

/** DDL administrativo executado até agora (evidência de "nenhum efeito novo"). */
function ddlCommandCount(): number {
  return commands.filter(
    (entry) =>
      entry.adapter === 'psql' &&
      entry.argv.includes('--command') &&
      entry.argv.some((element) =>
        /^(CREATE|GRANT|REVOKE|DROP) /.test(element),
      ),
  ).length
}

// ---------------------------------------------------------------------------
// Especificação de projeto (plano determinístico, naming derivado)
// ---------------------------------------------------------------------------

interface ProjectSpec {
  readonly clientId: string
  readonly slug: string
  readonly projectId: string
  readonly naming: ResourceNamingSnapshot
  readonly intent: ProjectIntent
  readonly plan: Plan
}

function projectSpec(clientId: string, slug: string): ProjectSpec {
  const naming = buildNamingSnapshot({
    client_id: clientId,
    project_slug: slug,
    environment: ENVIRONMENT,
    driver: DRIVER,
  })
  const projectId = naming.project_id
  const intent: ProjectIntent = {
    client_id: clientId,
    project_slug: slug,
    display_name: `${clientId} ${slug}`,
    environment: ENVIRONMENT,
    driver: DRIVER,
    host_target: HOST_TARGET,
    capabilities: {
      auth: false,
      storage: false,
      realtime: false,
      postgrest: false,
      backup: true,
    },
    requested_limits: {
      database_size_mb: 1024,
      memory_mb: 1024,
      cpu_millicores: 500,
    },
  }
  const plan: Plan = {
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
  return { clientId, slug, projectId, naming, intent, plan }
}

// ---------------------------------------------------------------------------
// Jornada: operation store + aprovacao + outbox + worker reais
// ---------------------------------------------------------------------------

interface JourneyOptions {
  readonly spec: ProjectSpec
  readonly holderRef: string
  readonly leases: ReturnType<typeof createInMemoryLeaseStore>
  readonly actions: ReturnType<typeof createActionExecutor>
  readonly rollbackService: ReturnType<typeof createRollbackService>
  readonly observationState: {
    revision: string
    resources: Array<OwnedResource>
  }
}

interface Journey {
  readonly spec: ProjectSpec
  readonly operationId: string
  readonly planHash: string
  readonly runOnce: () => Promise<WorkerRunResult>
  readonly state: () => string
  readonly operation: () => Operation
  readonly published: ReadonlyArray<string>
  readonly setEndpoint: (endpoint: { host: string; port: number }) => void
  /** Reentrega deliberada do mesmo trabalho com um `outbox_id` novo. */
  readonly redeliver: () => void
  readonly setVerify: (input: {
    peerDatabase: string
    restoreDatabase: string
    restorePayloadBase64: string
  }) => void
}

function buildJourney(options: JourneyOptions): Journey {
  const { spec } = options
  const operations = createInMemoryOperationStore({
    now: () => NOW.toISOString(),
    generateId: () => randomUUID(),
  })
  const approvals = createInMemoryOperationApprovalStore()
  const rollbackPlans = createInMemoryRollbackPlanStore()
  const outbox = createInMemoryOutboxStore()

  const created = operations.create({
    intent: spec.intent,
    plan: spec.plan,
    planHash: sha256Hex(JSON.stringify(spec.plan)),
    expiresAt: EXPIRES_AT,
    statusUrl: `/api/project-center/v2/operations/${spec.projectId}`,
    auditUrl: `/api/project-center/v2/operations/${spec.projectId}/audit`,
    observedRevision: OBSERVED_REVISION,
  })
  // Percurso canónico até `approved` (a tabela não permite atalhos): sem isto o
  // worker recusa a entrada com `estado_nao_executavel`.
  const awaiting = operations.transition(
    created.operation_id,
    'awaiting_approval',
    created.operation_version,
  )
  operations.transition(
    created.operation_id,
    'approved',
    awaiting.operation_version,
  )
  approvals.put(created.operation_id, {
    approval_id: randomUUID(),
    decision: 'approve',
    actor_ref: 'usr_harness',
    plan_hash: created.plan_hash,
    decided_at: '2026-09-25T11:00:00.000Z',
    expires_at: EXPIRES_AT,
  })
  outbox.append({
    operationId: created.operation_id,
    kind: 'execute',
    planHash: created.plan_hash,
    projectId: created.project_id,
    environment: ENVIRONMENT,
    outboxId: `execute:${created.operation_id}`,
  })

  const current: {
    endpoint: { host: string; port: number }
    peerDatabase?: string
    restoreDatabase?: string
    restorePayloadBase64?: string
  } = { endpoint: { host: '127.0.0.1', port: endpointPort } }

  const context: WorkerActionContextPort = {
    adapter_id: 'harness-real-context',
    resolve: async () => ({
      hostTarget: HOST_TARGET,
      endpoint: current.endpoint,
      ...(current.peerDatabase === undefined
        ? {}
        : { peerDatabase: current.peerDatabase }),
      ...(current.restoreDatabase === undefined
        ? {}
        : { restoreDatabase: current.restoreDatabase }),
      ...(current.restorePayloadBase64 === undefined
        ? {}
        : { restorePayloadBase64: current.restorePayloadBase64 }),
    }),
  }
  const observations: WorkerObservationPort = {
    adapter_id: 'harness-real-observation',
    observe: async () => ({ revision: options.observationState.revision }),
    ownedResources: async () => options.observationState.resources,
  }
  const published: Array<string> = []
  const worker = createWorker({
    flags: FLAGS_ON,
    operations,
    approvals,
    rollbackPlans,
    outbox,
    leases: options.leases,
    actions: options.actions,
    observations,
    context,
    publisher: {
      adapter_id: 'harness-real-publisher',
      publish: async (input) => {
        published.push(
          `${input.operation.operation_id}:${input.checks
            .map((entry) => `${entry.name}=${entry.outcome}`)
            .join(',')}`,
        )
        return { published: true, safe_detail: 'publicado apos verificacao' }
      },
    },
    rollback: options.rollbackService,
    holderRef: options.holderRef,
    now: () => NOW,
  })

  return {
    spec,
    operationId: created.operation_id,
    planHash: created.plan_hash,
    runOnce: () => worker.runOnce(),
    state: () => operations.require(created.operation_id).state,
    operation: () => operations.require(created.operation_id),
    published,
    setEndpoint: (endpoint) => {
      current.endpoint = endpoint
    },
    redeliver: () => {
      outbox.append({
        operationId: created.operation_id,
        kind: 'execute',
        planHash: created.plan_hash,
        projectId: created.project_id,
        environment: ENVIRONMENT,
        outboxId: `execute-redelivery:${created.operation_id}`,
      })
    },
    setVerify: (input) => {
      current.peerDatabase = input.peerDatabase
      current.restoreDatabase = input.restoreDatabase
      current.restorePayloadBase64 = input.restorePayloadBase64
    },
  }
}

/** Destino de backup local real (arquivos sob o diretório do harness). */
function createLocalDestination(): BackupDestinationPort {
  const objects = new Map<string, Uint8Array>()
  return {
    adapter_id: 'harness-local-destination',
    destination: 'local',
    write: async (input) => {
      const artifactRef = `${input.prefix}${input.filename}`
      objects.set(artifactRef, input.bytes)
      mkdirSync(join(WORK_DIR, 'objects', input.prefix), { recursive: true })
      writeFileSync(join(WORK_DIR, 'objects', artifactRef), input.bytes)
      return { artifact_ref: artifactRef }
    },
    read: async (artifactRef) => objects.get(artifactRef) ?? new Uint8Array(),
    list: async (prefix) =>
      [...objects.entries()]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([artifactRef, bytes]) => ({
          artifact_ref: artifactRef,
          size_bytes: bytes.byteLength,
          created_at: NOW.toISOString(),
        })),
  }
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env[HARNESS_OPT_IN_ENV] !== '1') {
    process.stderr.write(
      `harness efemero exige opt-in explicito: ${HARNESS_OPT_IN_ENV}=1\n`,
    )
    process.exit(2)
  }
  const jsonOnly = process.argv.includes('--json')
  const keep = process.argv.includes('--keep')
  const reportArgIndex = process.argv.indexOf('--report')
  const reportPath =
    reportArgIndex === -1
      ? join(WORK_DIR, 'report.json')
      : process.argv[reportArgIndex + 1]

  mkdirSync(WORK_DIR, { recursive: true })

  let containerStarted = false
  const port = await allocateEphemeralPort()
  endpointPort = port

  const alpha = projectSpec('harness', 'alpha')
  const bravo = projectSpec('harness', 'bravo')
  const retry = projectSpec('harness', 'retry')
  const partial = projectSpec('harness', 'partial')

  let fatal: unknown = null

  try {
    // ---------------------------------------------------------------
    // PROVA 0 — guard do harness (aceita o efémero, recusa produção)
    // ---------------------------------------------------------------
    const harnessRequest = {
      environment: ENVIRONMENT,
      host_target: HOST_TARGET,
      endpoint: { host: '127.0.0.1', port },
      work_dir: WORK_DIR,
      backup_prefix: localBackupPrefixFor({
        project_id: alpha.projectId,
        environment: ENVIRONMENT,
      }),
    }
    let guardAccepted = true
    try {
      assertEphemeralHarness(harnessRequest, process.env)
    } catch (error) {
      guardAccepted = false
      check(
        'harness-guard-opt-in',
        'Guard aceita o harness efemero com opt-in explicito',
        false,
        `recusou: ${error instanceof Error ? error.name : 'erro'}`,
      )
    }
    if (guardAccepted) {
      check(
        'harness-guard-opt-in',
        'Guard aceita o harness efemero com opt-in explicito',
        true,
        `endpoint=127.0.0.1:${port} work_dir=${WORK_DIR}`,
      )
    }
    for (const invalid of [
      {
        id: 'ambiente-production',
        name: 'ambiente production',
        request: { ...harnessRequest, environment: 'production' as const },
      },
      {
        id: 'host-target-producao',
        name: 'host target de producao',
        request: { ...harnessRequest, host_target: 'vps-primary' },
      },
      {
        id: 'porta-5432',
        name: 'porta 5432 do host',
        request: {
          ...harnessRequest,
          endpoint: { host: '127.0.0.1', port: 5432 },
        },
      },
      {
        id: 'work-dir-producao',
        name: 'work_dir com path de producao',
        request: { ...harnessRequest, work_dir: '/var/lib/postgresql/harness' },
      },
      {
        id: 'porta-fora-da-janela',
        name: 'porta fora da janela efemera',
        request: {
          ...harnessRequest,
          endpoint: { host: '127.0.0.1', port: 5432 },
        },
      },
    ]) {
      let refused = false
      try {
        assertEphemeralHarness(invalid.request, process.env)
      } catch (error) {
        refused = error instanceof HarnessGuardError
      }
      check(
        `harness-guard-recusa-${invalid.id}`,
        `Guard recusa ${invalid.name}`,
        refused,
        refused ? 'HarnessGuardError (fail closed)' : 'NAO recusou',
      )
    }

    // ---------------------------------------------------------------
    // PROVA 1 — container efémero e servidor real
    // ---------------------------------------------------------------
    assertNamesAreFree()
    startContainer(port)
    containerStarted = true
    const status = JSON.parse(
      docker(['inspect', '--format', '{{json .State.Status}}', CONTAINER]),
    ) as string
    const imageId = docker([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      IMAGE,
    ]).trim()
    check(
      'container-efemero',
      'Container efemero criado com nome derivado de UUID',
      status === 'running',
      `container=${CONTAINER} volume=${VOLUME} porta=127.0.0.1:${port} status=${status} imagem=${imageId.slice(0, 19)}…`,
      { container: CONTAINER, volume: VOLUME, port, image_id: imageId },
    )

    let ready = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await adminSql('SELECT 1')).exit_code === 0) {
        ready = true
        break
      }
      await sleep(1000)
    }
    if (!ready) throw new Error('servidor efemero nao ficou pronto')
    const version = await adminSql("SELECT current_setting('server_version')")
    check(
      'servidor-real',
      'PostgreSQL efemero responde a conexao real',
      version.exit_code === 0 && version.rows.length === 1,
      `server_version=${version.rows[0] ?? '?'} usuario_admin=${ADMIN_ROLE}`,
      { postgres: version.rows[0] ?? null },
    )

    // Porta fechada alocada e nunca ligada: falha transitória real (ECONNREFUSED).
    let closedPort = await allocateEphemeralPort()
    while (closedPort === port) closedPort = await allocateEphemeralPort()

    // ---------------------------------------------------------------
    // Infra injetada (portas reais + stores do PR 4/5/6)
    // ---------------------------------------------------------------
    endpointPort = port
    const secrets = createSecretBroker({
      materials: createInMemorySecretMaterialStore(),
      pepper: BROKER_PEPPER,
      now: () => NOW,
    })
    const leases = createInMemoryLeaseStore({ now: () => NOW })
    const postgresExecutor = createPostgresqlExecutor({
      processes: {
        sql: psqlAdapter,
        dump: pgDumpAdapter,
        restore: pgRestoreAdapter,
      },
      secrets,
      adminCredential: {
        acquire: () => ({
          secret_ref: `sref_${'h'.repeat(43)}`,
          masked_ref: 'sref_[REDACTED]',
          fingerprint: `f_${'h'.repeat(58)}`,
          purpose: 'admin_bootstrap' as const,
          project_id: 'harness-runtime',
          environment: ENVIRONMENT,
          reveal: () => ADMIN_MATERIAL,
          toJSON: () => ({
            masked_ref: 'sref_[REDACTED]',
            fingerprint: `f_${'h'.repeat(58)}`,
            purpose: 'admin_bootstrap' as const,
          }),
        }),
      },
    })
    const actions = createActionExecutor({
      flags: FLAGS_ON,
      leases,
      drivers: { [DRIVER]: postgresExecutor },
      controlPlane: {
        adapter_id: 'harness-real-control-plane',
        publish: async () => ({
          status: 'succeeded' as const,
          safe_detail: 'control-plane idempotente',
        }),
      },
      backups: {
        adapter_id: 'harness-real-backup-channel',
        configure: async (input) => ({
          status: 'succeeded' as const,
          safe_detail: `canal de backup ${input.kind}`,
          evidence_ref: input.targetRef,
        }),
      },
      now: () => NOW,
    })
    const observationState = {
      revision: OBSERVED_REVISION,
      resources: [] as Array<OwnedResource>,
    }
    const rollbackService = createRollbackService({
      flags: FLAGS_ON,
      leases,
      observations: {
        adapter_id: 'harness-real-rollback-observer',
        observe: async (input) => ({
          resources: observationState.resources.filter(
            (resource) => resource.project_id === input.operation.project_id,
          ),
          observed_revision: observationState.revision,
          drift_findings: [],
        }),
      },
      actions,
      now: () => NOW,
    })
    const destination = createLocalDestination()
    const backups = createBackupService({
      flags: FLAGS_ON,
      leases,
      destinations: { local: destination },
      now: () => NOW,
    })

    const journeyAlpha = buildJourney({
      spec: alpha,
      holderRef: 'harness-worker-alpha',
      leases,
      actions,
      rollbackService,
      observationState,
    })
    const journeyBravo = buildJourney({
      spec: bravo,
      holderRef: 'harness-worker-bravo',
      leases,
      actions,
      rollbackService,
      observationState,
    })
    journeyAlpha.setEndpoint({ host: '127.0.0.1', port })
    journeyBravo.setEndpoint({ host: '127.0.0.1', port })

    // ---------------------------------------------------------------
    // PROVA 2 — provisionamento real de dois projetos
    // ---------------------------------------------------------------
    const alphaExecute = await journeyAlpha.runOnce()
    const bravoExecute = await journeyBravo.runOnce()
    const databasesAfterExecute = await listDatabases()
    const rolesAfterExecute = await listRoles()
    const provisioned =
      alphaExecute.entries[0]?.status === 'processed' &&
      bravoExecute.entries[0]?.status === 'processed' &&
      databasesAfterExecute.includes(alpha.naming.database) &&
      databasesAfterExecute.includes(bravo.naming.database) &&
      rolesAfterExecute.includes(alpha.naming.app_role) &&
      rolesAfterExecute.includes(bravo.naming.app_role) &&
      journeyAlpha.state() === 'verifying' &&
      journeyBravo.state() === 'verifying' &&
      journeyAlpha.published.length === 0
    check(
      'provisiona-dois-projetos',
      'Dois projetos provisionados por psql real, sem publicacao antes da verificacao',
      provisioned,
      `A=${alpha.naming.database} B=${bravo.naming.database} estados=${journeyAlpha.state()}/${journeyBravo.state()} publicados=${journeyAlpha.published.length}`,
      {
        databases: databasesAfterExecute,
        roles: rolesAfterExecute,
        entries: [
          alphaExecute.entries[0] ?? null,
          bravoExecute.entries[0] ?? null,
        ],
      },
    )

    // ---------------------------------------------------------------
    // PROVA 4 — backup real por projeto (pg_dump) com checksum
    // ---------------------------------------------------------------
    const backupLease = leases.acquire({
      operationId: journeyAlpha.operationId,
      projectId: alpha.projectId,
      environment: ENVIRONMENT,
      holderRef: 'harness-backup-alpha',
      ttlSeconds: 300,
    })
    const canary = await adminSql(
      'CREATE TABLE IF NOT EXISTS canary_pcv2(id integer); INSERT INTO canary_pcv2 VALUES (1);',
      alpha.naming.database,
    )
    const backupRun = await backups.run({
      operationId: journeyAlpha.operationId,
      projectId: alpha.projectId,
      environment: ENVIRONMENT,
      driver: DRIVER,
      naming: alpha.naming,
      lease: {
        leaseId: backupLease.lease_id,
        fencingToken: backupLease.fencing_token,
        holderRef: backupLease.holder_ref,
      },
      retentionDays: 30,
      destination: 'local',
      dump: async () => {
        const dump = await pgDumpAdapter.run({
          argv: [
            'pg_dump',
            '--no-owner',
            '--no-privileges',
            '--format=custom',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--username',
            ADMIN_ROLE,
            '--dbname',
            assertHarnessIdentifier(alpha.naming.database),
          ],
          timeout_ms: 120_000,
        })
        if (dump.exit_code !== 0 || dump.stdout_base64 === undefined) {
          throw new Error(`pg_dump falhou (exit=${dump.exit_code})`)
        }
        return new Uint8Array(Buffer.from(dump.stdout_base64, 'base64'))
      },
    })
    const storedBytes = await destination.read(backupRun.artifact.artifact_ref)
    const expectedPrefix = localBackupPrefixFor({
      project_id: alpha.projectId,
      environment: ENVIRONMENT,
    })
    check(
      'backup-por-projeto',
      'Backup real do projeto A com prefixo dedicado, checksum e retencao',
      canary.exit_code === 0 &&
        backupRun.artifact.project_id === alpha.projectId &&
        backupRun.artifact.prefix === expectedPrefix &&
        backupRun.artifact.checksum ===
          createHash('sha256').update(storedBytes).digest('hex') &&
        storedBytes.byteLength > 0,
      `artifact_ref=${backupRun.artifact.artifact_ref} bytes=${storedBytes.byteLength} checksum=${backupRun.artifact.checksum.slice(0, 12)} retencao=${backupRun.artifact.retention_days}d`,
      { artifact: backupRun.artifact, manifest: backupRun.manifest },
    )
    leases.release({
      leaseId: backupLease.lease_id,
      fencingToken: backupLease.fencing_token,
      holderRef: backupLease.holder_ref,
    })

    // ---------------------------------------------------------------
    // PROVA 5 — prova negativa A↔B (com controle positivo)
    // ---------------------------------------------------------------
    const isolationAlpha = await asAppRole(
      alpha.naming.app_role,
      alpha.naming.database,
    )
    const alphaToBravo = await asAppRole(
      alpha.naming.app_role,
      bravo.naming.database,
    )
    const bravoToAlpha = await asAppRole(
      bravo.naming.app_role,
      alpha.naming.database,
    )
    check(
      'prova-negativa-a-b',
      'Role de A alcanca o proprio database e e negada no database de B (e vice-versa)',
      isolationAlpha.exit_code === 0 &&
        alphaToBravo.exit_code !== 0 &&
        bravoToAlpha.exit_code !== 0 &&
        /permission denied/i.test(
          `${alphaToBravo.stderr} ${bravoToAlpha.stderr}`,
        ),
      `A->A exit=${isolationAlpha.exit_code}; A->B exit=${alphaToBravo.exit_code}; B->A exit=${bravoToAlpha.exit_code}`,
      {
        a_to_a: isolationAlpha.rows[0] ?? null,
        a_to_b_stderr: alphaToBravo.stderr.slice(0, 200),
        b_to_a_stderr: bravoToAlpha.stderr.slice(0, 200),
      },
    )

    // ---------------------------------------------------------------
    // PROVA 6 — verificacao real do plano + restore efemero destruido
    // ---------------------------------------------------------------
    const restoreVerifier = createRestoreVerifier({
      flags: FLAGS_ON,
      leases,
      backups,
      runRestore: async (input) => {
        const created = await adminSql(
          `CREATE DATABASE ${input.target.target_name} TEMPLATE template0 ENCODING UTF8`,
        )
        if (created.exit_code !== 0) {
          return {
            exit_code: created.exit_code,
            origin_untouched: true,
            restored_rows: null,
            safe_detail: 'falha ao criar alvo efemero',
          }
        }
        const argv = renderActionTemplate(
          templateFor('verify_backup_restore', DRIVER),
          {
            host: '127.0.0.1',
            port,
            admin_role: ADMIN_ROLE,
            restore_database: input.target.target_name,
          },
        )
        const restored = await pgRestoreAdapter.run({
          argv,
          timeout_ms: input.timeout_ms,
          stdin_base64: Buffer.from(input.bytes).toString('base64'),
        })
        const restoredRows =
          restored.exit_code === 0
            ? await adminSql(
                'SELECT count(*) FROM canary_pcv2',
                input.target.target_name,
              )
            : null
        const originRows = await adminSql(
          'SELECT count(*) FROM canary_pcv2',
          input.origin.database,
        )
        return {
          exit_code: restored.exit_code,
          origin_untouched: originRows.rows[0] === '1',
          restored_rows:
            restoredRows === null ? null : Number(restoredRows.rows[0] ?? '0'),
          safe_detail: `restore real exit=${restored.exit_code}`,
        }
      },
      dropTarget: async (target: EphemeralRestoreTarget) => {
        const dropped = await adminSql(
          `DROP DATABASE IF EXISTS ${target.target_name} WITH (FORCE)`,
        )
        if (dropped.exit_code !== 0)
          throw new Error('alvo efemero nao destruido')
      },
      now: () => NOW,
    })
    // 6a — cadeia do verificador de restore: checksum do manifesto, alvo
    // efémero real, `pg_restore` real, contagem na tabela canário e destruição
    // do alvo pelo próprio verificador.
    const restoreLease = leases.acquire({
      operationId: journeyAlpha.operationId,
      projectId: alpha.projectId,
      environment: ENVIRONMENT,
      holderRef: 'harness-restore',
      ttlSeconds: 300,
    })
    const restoreVerification = await restoreVerifier.verify({
      operationId: journeyAlpha.operationId,
      artifact: backupRun.artifact,
      manifest: backupRun.manifest,
      bytes: storedBytes,
      origin: {
        project_id: alpha.projectId,
        environment: ENVIRONMENT,
        driver: DRIVER,
        database: alpha.naming.database,
      },
      lease: {
        leaseId: restoreLease.lease_id,
        fencingToken: restoreLease.fencing_token,
        holderRef: restoreLease.holder_ref,
      },
    })
    leases.release({
      leaseId: restoreLease.lease_id,
      fencingToken: restoreLease.fencing_token,
      holderRef: restoreLease.holder_ref,
    })
    const verifiedTargetGone = !(await listDatabases()).includes(
      restoreVerification.target.target_name,
    )
    check(
      'restore-efemero-verificado',
      'Restore real do backup em alvo efemero: bytes conferidos, canario contado e alvo destruido',
      restoreVerification.verified_bytes === storedBytes.byteLength &&
        restoreVerification.restored_rows === 1 &&
        restoreVerification.target_destroyed &&
        verifiedTargetGone,
      `bytes=${restoreVerification.verified_bytes} linhas_canario=${restoreVerification.restored_rows} alvo=${restoreVerification.target.target_name} destruido=${restoreVerification.target_destroyed} ausente_no_cluster=${verifiedTargetGone}`,
      { verification: restoreVerification },
    )

    // 6b — o worker repete a verificação do plano (isolamento + restore). O
    // alvo do tick é criado aqui: provisionar alvo é responsabilidade do
    // adapter de restore do deployment (a destruição está provada em 6a).
    const restoreTarget = restoreVerifier.issueTarget()
    const harnessTargetCreated = await adminSql(
      `CREATE DATABASE ${restoreTarget.target_name} TEMPLATE template0 ENCODING UTF8`,
    )
    const payloadBase64 = Buffer.from(storedBytes).toString('base64')
    journeyAlpha.setVerify({
      peerDatabase: bravo.naming.database,
      restoreDatabase: restoreTarget.target_name,
      restorePayloadBase64: payloadBase64,
    })
    journeyBravo.setVerify({
      peerDatabase: alpha.naming.database,
      restoreDatabase: restoreTarget.target_name,
      restorePayloadBase64: payloadBase64,
    })
    const verifiedAlpha = await journeyAlpha.runOnce()
    const verifiedBravo = await journeyBravo.runOnce()
    const alphaChecks = verifiedAlpha.entries[0]?.checks ?? []
    const harnessTargetDropped = await adminSql(
      `DROP DATABASE IF EXISTS ${restoreTarget.target_name} WITH (FORCE)`,
    )
    const targetGone =
      harnessTargetCreated.exit_code === 0 &&
      harnessTargetDropped.exit_code === 0 &&
      !(await listDatabases()).includes(restoreTarget.target_name)
    check(
      'verificacao-e-restore-efemero',
      'Verificacao real passa (isolamento + restore), publica so depois de PASS e destroi o alvo efemero',
      verifiedAlpha.entries[0]?.kind === 'verify' &&
        alphaChecks.length === 2 &&
        alphaChecks.every((entry) => entry.outcome === 'succeeded') &&
        journeyAlpha.state() === 'succeeded' &&
        journeyAlpha.published.length === 1 &&
        (verifiedBravo.entries[0]?.checks ?? []).every(
          (entry) => entry.outcome === 'succeeded',
        ) &&
        targetGone,
      `checks A=${JSON.stringify(alphaChecks)} alvo_destruido=${targetGone} publicados=${journeyAlpha.published.length}`,
      {
        alpha: verifiedAlpha.entries[0] ?? null,
        bravo: verifiedBravo.entries[0] ?? null,
        restore_target: restoreTarget,
      },
    )

    // ---------------------------------------------------------------
    // PROVA 6c — replay do tick concluido nao repete efeito
    // ---------------------------------------------------------------
    const ddlBeforeReplay = ddlCommandCount()
    const replayAlpha = await journeyAlpha.runOnce()
    const ddlAfterReplay = ddlCommandCount()
    check(
      'replay-sem-duplicacao',
      'Tick apos a conclusao nao reexecuta DDL nem duplica recurso',
      replayAlpha.entries.length === 0 &&
        ddlAfterReplay === ddlBeforeReplay &&
        countIn(await listDatabases(), alpha.naming.database) === 1 &&
        countIn(await listRoles(), alpha.naming.app_role) === 1,
      `entradas=${replayAlpha.entries.length} DDL antes=${ddlBeforeReplay} depois=${ddlAfterReplay}`,
      { entries: replayAlpha.entries },
    )

    // ---------------------------------------------------------------
    // PROVA 6d — reentrega com outbox_id novo: conflito real, sem duplicacao
    // ---------------------------------------------------------------
    const replaySpec = projectSpec('harness', 'replay')
    const journeyReplay = buildJourney({
      spec: replaySpec,
      holderRef: 'harness-worker-replay',
      leases,
      actions,
      rollbackService,
      observationState,
    })
    journeyReplay.setEndpoint({ host: '127.0.0.1', port })
    const replayTarget = restoreVerifier.issueTarget()
    const replayTargetCreated = await adminSql(
      `CREATE DATABASE ${replayTarget.target_name} TEMPLATE template0 ENCODING UTF8`,
    )
    journeyReplay.setVerify({
      peerDatabase: alpha.naming.database,
      restoreDatabase: replayTarget.target_name,
      restorePayloadBase64: payloadBase64,
    })
    const replayFirstTick = await journeyReplay.runOnce()
    const replayVerifyTick = await journeyReplay.runOnce()
    journeyReplay.redeliver()
    const commandsBeforeRedelivery = commands.length
    const replaySecondTick = await journeyReplay.runOnce()
    const redeliveryEntry = replaySecondTick.entries.find(
      (entry) =>
        entry.outbox_id === `execute-redelivery:${journeyReplay.operationId}`,
    )
    const commandsAfterRedelivery = commands.length
    const replayTargetDropped = await adminSql(
      `DROP DATABASE IF EXISTS ${replayTarget.target_name} WITH (FORCE)`,
    )
    check(
      'reentrega-conflita-sem-duplicar',
      'Reentrega com outbox_id novo e recusada na revalidacao, sem efeito e sem duplicar recurso',
      replayTargetCreated.exit_code === 0 &&
        replayFirstTick.entries[0]?.status === 'processed' &&
        replayVerifyTick.entries[0]?.status === 'processed' &&
        journeyReplay.state() === 'succeeded' &&
        redeliveryEntry?.status === 'skipped' &&
        /estado_nao_executavel/.test(redeliveryEntry.safe_detail) &&
        redeliveryEntry.attempts === 1 &&
        commandsAfterRedelivery === commandsBeforeRedelivery &&
        countIn(await listDatabases(), replaySpec.naming.database) === 1 &&
        countIn(await listRoles(), replaySpec.naming.app_role) === 1 &&
        replayTargetDropped.exit_code === 0,
      `execute=${replayFirstTick.entries[0]?.status} verify=${replayVerifyTick.entries[0]?.status} reentrega=${redeliveryEntry?.status} detalhe=${redeliveryEntry?.safe_detail ?? '-'} comandos_novos=${commandsAfterRedelivery - commandsBeforeRedelivery} estado=${journeyReplay.state()}`,
      {
        first: replayFirstTick.entries[0] ?? null,
        verify: replayVerifyTick.entries[0] ?? null,
        redelivery: redeliveryEntry ?? null,
      },
    )
    note(
      'observacao',
      `reentrega do mesmo plano com outbox_id novo: recusada na revalidacao por estado nao executavel (nenhum comando novo, nenhum recurso duplicado); a operacao permanece em ${journeyReplay.state()} e o rollback e o caminho de limpeza — que hoje esbarra em P7-01 para o recurso de role.`,
    )

    // ---------------------------------------------------------------
    // PROVA 7 — falha transitoria reconciliada (conexao recusada real)
    // ---------------------------------------------------------------
    const journeyRetry = buildJourney({
      spec: retry,
      holderRef: 'harness-worker-retry',
      leases,
      actions,
      rollbackService,
      observationState,
    })
    journeyRetry.setEndpoint({ host: '127.0.0.1', port: closedPort })
    const transientTick = await journeyRetry.runOnce()
    const transientEntry = transientTick.entries[0]
    check(
      'falha-transitoria-reconciliavel',
      'Conexao recusada real agenda retry e nao deixa estado parcial',
      transientEntry?.status === 'skipped' &&
        transientEntry.state === 'queued' &&
        transientEntry.attempts === 1 &&
        /retry agendado \(tentativa 2\/3\)/.test(transientEntry.safe_detail) &&
        !(await listDatabases()).includes(retry.naming.database),
      `status=${transientEntry?.status} estado=${transientEntry?.state} attempts=${transientEntry?.attempts} detalhe=${transientEntry?.safe_detail ?? '-'}`,
      { entry: transientEntry ?? null },
    )
    journeyRetry.setEndpoint({ host: '127.0.0.1', port })
    const retryRecovered = await journeyRetry.runOnce()
    check(
      'retry-conclui-sem-duplicar',
      'Retry com conectividade restaurada conclui e cria exatamente um database/role',
      retryRecovered.entries[0]?.status === 'processed' &&
        countIn(await listDatabases(), retry.naming.database) === 1 &&
        countIn(await listRoles(), retry.naming.app_role) === 1,
      `entrada=${retryRecovered.entries[0]?.status} estado=${journeyRetry.state()}`,
    )

    // ---------------------------------------------------------------
    // PROVA 8 — falha parcial escala para intervencao manual
    // ---------------------------------------------------------------
    const preExisting = await adminSql(
      `CREATE DATABASE ${partial.naming.database} OWNER ${ADMIN_ROLE} TEMPLATE template0 ENCODING UTF8`,
    )
    const journeyPartial = buildJourney({
      spec: partial,
      holderRef: 'harness-worker-partial',
      leases,
      actions,
      rollbackService,
      observationState,
    })
    journeyPartial.setEndpoint({ host: '127.0.0.1', port })
    const partialTick = await journeyPartial.runOnce()
    const partialEntry = partialTick.entries[0]
    check(
      'falha-parcial-escala-manual',
      'Database pre-existente faz a acao falhar e a operacao escalar para manual_intervention_required',
      preExisting.exit_code === 0 &&
        partialEntry?.status === 'failed' &&
        journeyPartial.state() === 'manual_intervention_required' &&
        (await listRoles()).includes(partial.naming.app_role) &&
        (await listDatabases()).includes(partial.naming.database),
      `status=${partialEntry?.status} estado=${journeyPartial.state()} detalhe=${partialEntry?.safe_detail ?? '-'}`,
      { entry: partialEntry ?? null },
    )

    // ---------------------------------------------------------------
    // PROVA 9 — lease: segundo writer e writer stale recusados
    // ---------------------------------------------------------------
    const firstLease = leases.acquire({
      operationId: journeyRetry.operationId,
      projectId: retry.projectId,
      environment: ENVIRONMENT,
      holderRef: 'harness-writer-1',
      ttlSeconds: 300,
    })
    let heldError: unknown = null
    try {
      leases.acquire({
        operationId: journeyRetry.operationId,
        projectId: retry.projectId,
        environment: ENVIRONMENT,
        holderRef: 'harness-writer-2',
        ttlSeconds: 300,
      })
    } catch (error) {
      heldError = error
    }
    leases.release({
      leaseId: firstLease.lease_id,
      fencingToken: firstLease.fencing_token,
      holderRef: firstLease.holder_ref,
    })
    const secondLease = leases.acquire({
      operationId: journeyRetry.operationId,
      projectId: retry.projectId,
      environment: ENVIRONMENT,
      holderRef: 'harness-writer-2',
      ttlSeconds: 300,
    })
    let staleError: unknown = null
    try {
      leases.assertWriter({
        scope: { projectId: retry.projectId, environment: ENVIRONMENT },
        leaseId: firstLease.lease_id,
        fencingToken: firstLease.fencing_token,
        holderRef: firstLease.holder_ref,
      })
    } catch (error) {
      staleError = error
    }
    const commandsBeforeStale = commands.length
    let executorRefusedStale = false
    try {
      await actions.execute({
        action: retry.plan.actions[0] as PlannedAction,
        context: {
          operationId: journeyRetry.operationId,
          projectId: retry.projectId,
          environment: ENVIRONMENT,
          driver: DRIVER,
          host_target: HOST_TARGET,
          observedRevision: OBSERVED_REVISION,
          naming: retry.naming,
          completedActionIds: [],
          lease: {
            leaseId: firstLease.lease_id,
            fencingToken: firstLease.fencing_token,
            holderRef: firstLease.holder_ref,
          },
          endpoint: { host: '127.0.0.1', port },
        },
        observedRevision: OBSERVED_REVISION,
      })
    } catch (error) {
      executorRefusedStale = error instanceof StaleWriterError
    }
    check(
      'lease-stale-recusado',
      'Lease recusa segundo writer e writer com token stale antes do adapter',
      heldError instanceof LeaseHeldError &&
        staleError instanceof StaleWriterError &&
        executorRefusedStale &&
        commands.length === commandsBeforeStale,
      `lock=${heldError instanceof Error ? heldError.name : 'nao recusou'} stale=${staleError instanceof Error ? staleError.name : 'nao recusou'} executor=${executorRefusedStale ? 'StaleWriterError' : 'nao recusou'} comandos_novos=${commands.length - commandsBeforeStale} fencing=${firstLease.fencing_token}->${secondLease.fencing_token}`,
    )
    leases.release({
      leaseId: secondLease.lease_id,
      fencingToken: secondLease.fencing_token,
      holderRef: secondLease.holder_ref,
    })

    // ---------------------------------------------------------------
    // PROVA 10 — rollback com gate proprio remove o recurso com proveniencia
    // ---------------------------------------------------------------
    observationState.resources = [
      {
        target_ref: `database:${retry.naming.database}`,
        resource_name: retry.naming.database,
        project_id: retry.projectId,
        environment: ENVIRONMENT,
        driver: DRIVER,
        ownership_marker: retry.naming.ownership_marker,
        created_by_operation_id: journeyRetry.operationId,
        exists: (await listDatabases()).includes(retry.naming.database),
      },
      {
        target_ref: `role:${retry.naming.app_role}`,
        resource_name: retry.naming.app_role,
        project_id: retry.projectId,
        environment: ENVIRONMENT,
        driver: DRIVER,
        ownership_marker: retry.naming.ownership_marker,
        created_by_operation_id: journeyRetry.operationId,
        exists: (await listRoles()).includes(retry.naming.app_role),
      },
      {
        target_ref: `database:${partial.naming.database}`,
        resource_name: partial.naming.database,
        project_id: partial.projectId,
        environment: ENVIRONMENT,
        driver: DRIVER,
        ownership_marker: null,
        created_by_operation_id: null,
        exists: true,
      },
    ]
    const retryOperation = journeyRetry.operation()
    const retryObservation = await rollbackService.planning.observe(
      retryOperation,
      { preserveData: false },
    )
    // A observação do harness é filtrada por projeto: o database pré-existente
    // de `partial` não entra no plano de `retry` (nem gera drift aqui).
    const retryRollbackPlan = {
      ...buildRollbackPlan({
        operation: retryOperation,
        observation: retryObservation,
        preserveData: false,
        now: NOW,
      }),
    }
    const approvalId = randomUUID()
    const rollbackPlanWithApproval = {
      ...retryRollbackPlan,
      approval: {
        approval_id: approvalId,
        decision: 'approve' as const,
        actor_ref: 'usr_harness_rollback',
        rollback_plan_hash: retryRollbackPlan.rollback_plan_hash,
        decided_at: '2026-09-25T11:30:00.000Z',
        expires_at: EXPIRES_AT,
      },
    }
    const retryResources = observationState.resources.filter(
      (resource) => resource.project_id === retry.projectId,
    )
    const executionPlan = rollbackService.planExecution({
      operation: retryOperation,
      rollbackPlan: rollbackPlanWithApproval,
      observation: retryObservation,
      resources: retryResources,
      now: NOW,
    })
    const rollbackLease = leases.acquire({
      operationId: journeyRetry.operationId,
      projectId: retry.projectId,
      environment: ENVIRONMENT,
      holderRef: 'harness-rollback',
      ttlSeconds: 300,
    })
    const rollbackResult = await rollbackService.execute({
      operation: retryOperation,
      rollbackPlan: rollbackPlanWithApproval,
      plan: executionPlan,
      environment: ENVIRONMENT,
      driver: DRIVER,
      host_target: HOST_TARGET,
      observedRevision: OBSERVED_REVISION,
      naming: retry.naming,
      lease: {
        leaseId: rollbackLease.lease_id,
        fencingToken: rollbackLease.fencing_token,
        holderRef: rollbackLease.holder_ref,
      },
      endpoint: { host: '127.0.0.1', port },
    })
    leases.release({
      leaseId: rollbackLease.lease_id,
      fencingToken: rollbackLease.fencing_token,
      holderRef: rollbackLease.holder_ref,
    })
    const databasesAfterRollback = await listDatabases()
    const rolesAfterRollback = await listRoles()
    check(
      'rollback-com-gate-proprio',
      'Rollback com hash + aprovacao proprios remove o database do projeto e nao toca nos pares',
      retryRollbackPlan.rollback_plan_hash.length === 64 &&
        executionPlan.executable.length === 2 &&
        executionPlan.requires_manual_intervention === false &&
        rollbackResult.aborted === false &&
        !databasesAfterRollback.includes(retry.naming.database) &&
        databasesAfterRollback.includes(alpha.naming.database) &&
        databasesAfterRollback.includes(bravo.naming.database),
      `plano=${retryRollbackPlan.rollback_plan_hash.slice(0, 12)} executaveis=${executionPlan.executable.length} removidos=${rollbackResult.completed.length} B_intacto=${databasesAfterRollback.includes(bravo.naming.database)}`,
      {
        plan: retryRollbackPlan,
        execution_plan: executionPlan,
        result: rollbackResult,
      },
    )

    // Defeito P7-01: o alvo `role:` roda o template de drop de database.
    const roleSurvived = rolesAfterRollback.includes(retry.naming.app_role)
    const ddlOfRollback = commands
      .filter(
        (entry) =>
          entry.argv.includes('--command') &&
          entry.argv.some((element) => /^DROP /.test(element)),
      )
      .slice(-3)
    if (roleSurvived) {
      finding(
        'P7-01',
        'critica',
        'Rollback com alvo `role:` executa o SQL de drop de DATABASE e deixa a role orfa',
        'O kind `drop_resource_created_by_operation` aceita os prefixos `role:`/`app-role:` (TARGET_REF_PREFIXES_BY_KIND), mas o template `postgresql_isolated:drop_resource_created_by_operation` tem SQL fixo em `{{sql:drop_database}}`. Uma acao de rollback com alvo `role:<app_role>` apaga o database do projeto em vez da role; a role permanece e um reprovisionamento posterior falharia em `role already exists`.',
        `apos o rollback: database ${retry.naming.database} ausente=${!databasesAfterRollback.includes(retry.naming.database)}, role ${retry.naming.app_role} presente=${roleSurvived}; SQLs de drop observados=${JSON.stringify(ddlOfRollback.map((entry) => entry.argv.filter((element) => /^(DROP|pg-|psql)/.test(element))))}`,
      )
    }
    check(
      'rollback-alvo-role-nao-remove-role',
      'Rollback de alvo `role:` remove a role do projeto (esperado pelo contrato)',
      !roleSurvived,
      roleSurvived
        ? `DEFEITO P7-01: a role ${retry.naming.app_role} permaneceu; a acao de alvo role executou drop_database`
        : `role ${retry.naming.app_role} removida`,
      { drop_commands: ddlOfRollback },
    )

    // ---------------------------------------------------------------
    // PROVA 11 — recurso pre-existente nunca e removido
    // ---------------------------------------------------------------
    let foreignPlanRefused = false
    let foreignPlanErrorName = 'nenhum'
    let foreignObservation: { ownership_verified: boolean; drift: number } = {
      ownership_verified: false,
      drift: -1,
    }
    try {
      const partialObservation = await rollbackService.planning.observe(
        journeyPartial.operation(),
        { preserveData: false },
      )
      foreignObservation = {
        ownership_verified: partialObservation.ownership_verified,
        drift: partialObservation.drift_findings.length,
      }
      buildRollbackPlan({
        operation: journeyPartial.operation(),
        observation: partialObservation,
        preserveData: false,
        now: NOW,
      })
    } catch (error) {
      foreignPlanRefused = error instanceof RollbackUnsafeError
      foreignPlanErrorName = error instanceof Error ? error.name : String(error)
    }
    const foreignAction: PlannedAction = {
      action_id: 'act_rb_drop_partial',
      kind: 'drop_resource_created_by_operation',
      target_ref: `database:${partial.naming.database}`,
      risk: 'destructive',
      reversible: false,
      dependencies: [],
    }
    const foreignPlan = {
      ...buildRollbackPlan({
        operation: journeyPartial.operation(),
        observation: {
          actions: [foreignAction],
          observed_revision: OBSERVED_REVISION,
          ownership_verified: true,
          drift_findings: [],
        },
        preserveData: false,
        now: NOW,
      }),
    }
    const foreignResource: OwnedResource = {
      target_ref: `database:${partial.naming.database}`,
      resource_name: partial.naming.database,
      project_id: partial.projectId,
      environment: ENVIRONMENT,
      driver: DRIVER,
      ownership_marker: null,
      created_by_operation_id: null,
      exists: true,
    }
    const foreignExecutionPlan = rollbackService.planExecution({
      operation: journeyPartial.operation(),
      rollbackPlan: foreignPlan,
      observation: {
        actions: [foreignAction],
        observed_revision: OBSERVED_REVISION,
        ownership_verified: true,
        drift_findings: [],
      },
      resources: [foreignResource],
      now: NOW,
    })
    let manualRefusal: unknown = null
    const commandsBeforeForeign = commands.length
    try {
      await rollbackService.execute({
        operation: journeyPartial.operation(),
        rollbackPlan: foreignPlan,
        plan: foreignExecutionPlan,
        environment: ENVIRONMENT,
        driver: DRIVER,
        host_target: HOST_TARGET,
        observedRevision: OBSERVED_REVISION,
        naming: partial.naming,
        lease: {
          leaseId: rollbackLease.lease_id,
          fencingToken: rollbackLease.fencing_token,
          holderRef: rollbackLease.holder_ref,
        },
        endpoint: { host: '127.0.0.1', port },
      })
    } catch (error) {
      manualRefusal = error
    }
    const foreignCommandsAfter = commands.length
    const partialSurvived = (await listDatabases()).includes(
      partial.naming.database,
    )
    check(
      'rollback-preserva-preexistente',
      'Recurso sem proveniencia recusa o plano e vai para intervencao manual sem remover nada',
      foreignPlanRefused &&
        foreignObservation.ownership_verified === false &&
        foreignExecutionPlan.requires_manual_intervention &&
        foreignExecutionPlan.executable.length === 0 &&
        manualRefusal instanceof RollbackServiceError &&
        manualRefusal.code === 'MANUAL_INTERVENTION_REQUIRED' &&
        foreignCommandsAfter === commandsBeforeForeign &&
        partialSurvived,
      `plano_recusado=${foreignPlanRefused} (${foreignPlanErrorName}) ownership=${foreignObservation.ownership_verified} drift=${foreignObservation.drift} manual=${foreignExecutionPlan.manual.length} recusa=${manualRefusal instanceof Error ? manualRefusal.name : 'nenhuma'} comandos_novos=${foreignCommandsAfter - commandsBeforeForeign} database_preservado=${partialSurvived}`,
    )

    // ---------------------------------------------------------------
    // PROVA 12 — flags desligadas bloqueiam qualquer adapter
    // ---------------------------------------------------------------
    const commandsBeforeFlagsOff = ddlCommandCount()
    let flagsOffError: unknown = null
    try {
      await createWorker({
        flags: FLAGS_OFF,
        operations: createInMemoryOperationStore({
          now: () => NOW.toISOString(),
        }),
        approvals: createInMemoryOperationApprovalStore(),
        rollbackPlans: createInMemoryRollbackPlanStore(),
        outbox: createInMemoryOutboxStore(),
        leases,
        actions,
        observations: {
          adapter_id: 'harness-real-observation',
          observe: async () => ({ revision: OBSERVED_REVISION }),
          ownedResources: async () => [],
        },
        context: {
          adapter_id: 'harness-real-nexus-context',
          resolve: async () => ({
            hostTarget: HOST_TARGET,
            endpoint: { host: '127.0.0.1', port },
          }),
        },
        publisher: {
          adapter_id: 'harness-real-publisher',
          publish: async () => ({ published: true, safe_detail: 'noop' }),
        },
        rollback: rollbackService,
        now: () => NOW,
      }).runOnce()
    } catch (error) {
      flagsOffError = error
    }
    check(
      'flags-desligadas',
      'Flags desligadas (default do repositorio) impedem qualquer execucao de adapter',
      flagsOffError instanceof FeatureDisabledError &&
        ddlCommandCount() === commandsBeforeFlagsOff &&
        FLAGS_OFF.apiEnabled === false &&
        FLAGS_OFF.workerEnabled === false,
      `erro=${flagsOffError instanceof Error ? flagsOffError.name : 'nenhum'} DDL_novo=${ddlCommandCount() - commandsBeforeFlagsOff} default=${JSON.stringify(describeFlags(FLAGS_OFF))}`,
    )

    // ---------------------------------------------------------------
    // Notas de fronteira (nao executavel nesta autorizacao)
    // ---------------------------------------------------------------
    note(
      'nao-executavel',
      'supabase_isolated: o executor exige StackAdapter (adapter_id supabase-stack-adapter) e SupabaseProjectionPort, ausentes no repositorio (PR 6 deixa a implementacao para o deployment); o template sb-stack-full exige os 6 servicos com imagens pinadas por digest ausentes no host.',
    )
    note(
      'nao-executavel',
      'lease store duravel do deployment: o harness usa o store em memoria declarado no PR 6 como fixture de referencia.',
    )
    note(
      'nao-executavel',
      'destino R2 real: o harness usa a porta de destino local com prefixo dedicado (R2 e proibido nesta fronteira).',
    )
    note(
      'observacao',
      'os templates SQL do catalogo nao usam IF NOT EXISTS: reentrega do item de execute com outbox_id novo falha com conflito real (already exists) e escala para manual_intervention_required, sem duplicar recurso.',
    )
  } catch (error) {
    fatal = error
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    note('fatal', `execucao interrompida: ${detail}`)
    check(
      'sem-falha-fatal',
      'Harness executou todas as provas sem falha fatal',
      false,
      `interrompido em ${detail}`,
    )
  } finally {
    if (keep) {
      note(
        'teardown',
        `--keep: container ${CONTAINER} e volume ${VOLUME} preservados`,
      )
    } else if (containerStarted) {
      dockerNoThrow(['rm', '--force', '--volumes', CONTAINER])
      dockerNoThrow(['volume', 'rm', VOLUME])
    }
    if (containerStarted) {
      const containerGone = !dockerNoThrow(['inspect', CONTAINER]).ok
      const volumeGone = !dockerNoThrow(['volume', 'inspect', VOLUME]).ok
      // Clientes efémeros (`docker run`) que tenham ficado presos por timeout
      // são removidos pelo label deste UUID — nada fora dele é tocado.
      const leftovers = dockerNoThrow([
        'ps',
        '-aq',
        '--filter',
        `label=${LABEL}`,
      ])
        .output.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (leftovers.length > 0) dockerNoThrow(['rm', '-f', ...leftovers])
      const leftoversAfter = dockerNoThrow([
        'ps',
        '-aq',
        '--filter',
        `label=${LABEL}`,
      ])
        .output.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      check(
        'teardown-sem-residuo',
        'Container, volume e clientes efemeros removidos (nenhum residuo deste UUID)',
        containerGone && volumeGone && leftoversAfter.length === 0,
        `container_removido=${containerGone} volume_removido=${volumeGone} clientes_removidos=${leftovers.length} residuo_apos=${leftoversAfter.length}`,
      )
    }
    // Os objetos de backup do harness sao temporarios do proprio run.
    rmSync(join(WORK_DIR, 'objects'), { recursive: true, force: true })

    const evidenceBlob = JSON.stringify({ checks, findings, commands, notes })
    check(
      'sem-vazamento-de-material',
      'Nenhum material sintetico (credencial/pepper) aparece na evidencia do harness',
      !evidenceBlob.includes(ADMIN_MATERIAL) &&
        !evidenceBlob.includes(BROKER_PEPPER),
      `material_presente=${evidenceBlob.includes(ADMIN_MATERIAL)} pepper_presente=${evidenceBlob.includes(BROKER_PEPPER)} bytes_de_evidencia=${evidenceBlob.length}`,
    )

    const passed = checks.filter((entry) => entry.status === 'PASS').length
    const report = {
      harness: 'project-center-v2-real-harness',
      version: '1.0.0',
      uuid: UUID,
      generated_at: new Date().toISOString(),
      git_sha: (() => {
        try {
          return execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim()
        } catch {
          return null
        }
      })(),
      environment: {
        node: process.version,
        docker: (() => {
          try {
            return execFileSync(
              'docker',
              ['version', '--format', '{{.Server.Version}}'],
              {
                encoding: 'utf8',
              },
            ).trim()
          } catch {
            return null
          }
        })(),
        image: IMAGE,
        container: CONTAINER,
        volume: VOLUME,
        endpoint: `127.0.0.1:${port}`,
        work_dir: WORK_DIR,
      },
      verdict:
        findings.length > 0 || fatal !== null || passed !== checks.length
          ? 'FAIL'
          : 'PASS',
      summary: `${passed}/${checks.length} provas PASS; ${findings.length} defeito(s) encontrado(s); ${commands.length} comandos reais executados${fatal === null ? '' : '; execucao interrompida por falha fatal'}`,
      checks,
      findings,
      commands,
      notes,
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    if (!keep && reportPath !== join(WORK_DIR, 'report.json')) {
      // Relatorio canonico entregue fora do diretorio efemero: o work dir de
      // objetos locais nao deixa residuo para a proxima execucao.
      rmSync(WORK_DIR, { recursive: true, force: true })
    }
    if (!jsonOnly) {
      for (const entry of checks) {
        process.stdout.write(
          `${entry.status === 'PASS' ? 'ok  ' : 'FAIL'} ${entry.id} — ${entry.name}: ${entry.detail}\n`,
        )
      }
      for (const entry of findings) {
        process.stdout.write(
          `DEFEITO ${entry.id} (${entry.severity}): ${entry.title}\n`,
        )
      }
      for (const entry of notes) {
        process.stdout.write(`note ${entry.kind}: ${entry.detail}\n`)
      }
      process.stdout.write(
        `\nverdict=${report.verdict} ${report.summary}\nrelatorio=${reportPath}\n`,
      )
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exit(report.verdict === 'PASS' ? 0 : 1)
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `falha fatal no harness: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
