/**
 * Canário P3-03 — condição obrigatória do gate de Security.
 *
 * Prova, com payload **sanitizado vivo** (DSN com credencial, `sref_`, JWT e
 * path absoluto injetados nas quatro saídas públicas), que nenhum desses
 * valores sobrevive à redaction:
 *
 * - `safe_detail` — produzido pelo executor PostgreSQL (`redactProcessOutput`);
 * - `safe_payload` — produzido por `toSafePayload` (evento de auditoria);
 * - `evidence_ref` / detalhe do canal de broker — sem material, sem alias
 *   derivável do `sref_`;
 * - `message` — mensagem da falha segura (`SafeFailure`).
 *
 * Cada aserção procura o valor cru nas quatro saídas: se qualquer um aparecer,
 * o canário falha — é ele que autoriza o registro do PR 6.
 */
import { describe, expect, it } from 'vitest'

import {
  MASK,
  PATH_MASK,
  SECRET_REF_MASK,
  fingerprintSecretRef,
  maskSecretRef,
  redactText,
  toSafePayload,
} from './redaction'
import { buildNamingSnapshot } from './naming'
import {
  createInMemorySecretMaterialStore,
  createSecretBroker,
} from './secret-broker'
import { createPostgresqlExecutor } from './executors/postgresql-executor'
import type {
  DriverActionInput,
  ProcessAdapter,
  ProcessBinary,
  ProcessRunResult,
} from './executors/action-executor'
import type { PlannedAction, SafePayload } from './domain'

const NOW = new Date('2026-09-25T12:00:00.000Z')
const PROJECT_ID = 'acme-site'
const ENVIRONMENT = 'development' as const

// ---------------------------------------------------------------------------
// Payload sanitizado vivo: valores sensíveis que NUNCA podem sair.
// ---------------------------------------------------------------------------

/** DSN com credencial embutida (host não-loopback, base de laboratório). */
const LIVE_DSN = 'postgres://jean:sup3rsecret@10.0.0.7:5432/je4ndev_lab'
/** SecretRef emitido pelo broker: material vivo, 43+ caracteres. */
const LIVE_SECRET_REF = `sref_${'Zk7Qm2Wr9Tb4Xn6Ld8Vc3Hs5Pj1Fg0Ay6Ut2Ro4Ei7Qa'}`
/** JWT completo (três segmentos). */
const LIVE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqZWFuIiwicm9sZSI6ImFkbWluIn0.c2lnbmF0dXJlLWZha2UtcGFyYS1jYW5hcmlv'
/** Path absoluto de produção. */
const LIVE_PATH = '/var/lib/postgresql/16/main/pg_hba.conf'
/** Material da credencial administrativa (fixture sintética em runtime). */
const LIVE_MATERIAL = 'synthetic-material-9f2c41ab'

const LIVE_VALUES: ReadonlyArray<string> = Object.freeze([
  LIVE_DSN,
  LIVE_SECRET_REF,
  LIVE_JWT,
  LIVE_PATH,
  'sup3rsecret',
  LIVE_MATERIAL,
])

function expectNoLiveValue(text: string): void {
  for (const value of LIVE_VALUES) {
    expect(text).not.toContain(value)
  }
}

// ---------------------------------------------------------------------------
// Harness mínimo do executor (produtor real de safe_detail/message)
// ---------------------------------------------------------------------------

interface ExecutorHarness {
  readonly outcome: {
    readonly status: string
    readonly safe_detail: string
    readonly failure?: { readonly message: string } | undefined
  }
  readonly adapterCalls: number
  /** Material real da credencial administrativa (fixture sintética). */
  readonly material: string
}

function adapterFor(
  binary: ProcessBinary,
  result: ProcessRunResult,
): ProcessAdapter & {
  calls: number
} {
  const adapter = {
    adapter_id: `canary-${binary}`,
    binary,
    calls: 0,
    run: async () => {
      adapter.calls += 1
      return result
    },
  }
  return adapter
}

async function runWithUntrustedOutput(
  stderrFor: (material: string) => string,
  exitCode: number,
): Promise<ExecutorHarness> {
  const broker = createSecretBroker({
    materials: createInMemorySecretMaterialStore(),
    pepper: 'p'.repeat(48),
    now: () => NOW,
  })
  const issued = broker.issue({
    projectId: PROJECT_ID,
    environment: ENVIRONMENT,
    purpose: 'admin_bootstrap',
  })
  const adminHandle = broker.handle({
    secretRef: issued.secret_ref,
    projectId: PROJECT_ID,
    environment: ENVIRONMENT,
    purpose: 'admin_bootstrap',
  })
  const material = adminHandle.reveal()
  // O stderr é montado com o material real da credencial: é ele que o executor
  // tem de remover por valor, além dos padrões do catálogo de redaction.
  const sql = adapterFor('psql', {
    exit_code: exitCode,
    stdout: '',
    stderr: stderrFor(material),
  })
  const dump = adapterFor('pg_dump', { exit_code: 0, stdout: '', stderr: '' })
  const restore = adapterFor('pg_restore', {
    exit_code: 0,
    stdout: '',
    stderr: '',
  })
  const naming = buildNamingSnapshot({
    client_id: 'acme',
    project_slug: 'site',
    environment: ENVIRONMENT,
    driver: 'postgresql_isolated',
  })
  const executor = createPostgresqlExecutor({
    processes: { sql, dump, restore },
    secrets: broker,
    adminCredential: { acquire: () => adminHandle },
  })

  const action: PlannedAction = {
    action_id: 'act_create_database_canary',
    kind: 'create_database',
    target_ref: `database:${naming.database}`,
    risk: 'reversible',
    reversible: true,
    dependencies: [],
  }
  const input: DriverActionInput = {
    action,
    context: {
      operationId: '11111111-1111-4111-8111-111111111111',
      projectId: PROJECT_ID,
      environment: ENVIRONMENT,
      driver: 'postgresql_isolated',
      host_target: 'vps-primary-local',
      observedRevision: 'rev-1',
      naming,
      completedActionIds: [],
      lease: {
        leaseId: '22222222-2222-4222-8222-222222222222',
        fencingToken: 1,
        holderRef: 'canary',
      },
      endpoint: { host: '127.0.0.1', port: 55432 },
    },
    template: {
      template_id: 'pg-create-database',
      kind: 'create_database',
      driver: 'postgresql_isolated',
      binary: 'psql',
      risk: 'reversible',
      argv: [
        'psql',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--host',
        '{{host}}',
        '--port',
        '{{port}}',
        '--username',
        '{{admin_role}}',
        '--dbname',
        'postgres',
        '--command',
        '{{sql:create_database}}',
      ],
      timeout_ms: 30_000,
      compensable: true,
      expects_denial: false,
    },
    params: {
      host: '127.0.0.1',
      port: 55432,
      admin_role: 'je4ndev_pcv2_admin',
      database: naming.database,
      app_role: naming.app_role,
      sql: `CREATE DATABASE ${naming.database} OWNER ${naming.app_role} TEMPLATE template0 ENCODING UTF8`,
    },
  }

  const outcome = await executor.execute(input)
  return { outcome, adapterCalls: sql.calls, material }
}

describe('canario P3-03 — payload sanitizado vivo', () => {
  it('safe_detail e message limpam DSN, sref_, JWT, path e material', async () => {
    const harness = await runWithUntrustedOutput(
      (material) =>
        [
          `psql: error: could not connect to ${LIVE_DSN}`,
          `token ${LIVE_SECRET_REF}`,
          `authorization: Bearer ${LIVE_JWT}`,
          `reading ${LIVE_PATH}`,
          `material ${material}`,
        ].join('\n'),
      3,
    )

    expect(harness.adapterCalls).toBe(1)
    expect(harness.outcome.status).toBe('failed')
    expectNoLiveValue(harness.outcome.safe_detail)
    expectNoLiveValue(harness.outcome.failure?.message ?? '')
    // O material real da credencial também é removido por valor.
    expect(harness.material.length).toBeGreaterThan(0)
    expect(harness.outcome.safe_detail).not.toContain(harness.material)
    expect(harness.outcome.failure?.message ?? '').not.toContain(
      harness.material,
    )
    // A redaction é visível na mensagem da falha (o detalhe do processo é
    // redigido antes de virar `message`; `safe_detail` sai como descritor
    // compacto, sem saída de processo).
    expect(harness.outcome.safe_detail).toBe(
      'exit_code=3 action=create_database',
    )
    expect(harness.outcome.failure?.message ?? '').toContain(MASK)
  })

  it('safe_detail de execucao bem-sucedida tambem nao devolve valor vivo', async () => {
    const harness = await runWithUntrustedOutput(
      (material) =>
        `notice: connected via ${LIVE_DSN} token=${LIVE_JWT} path=${LIVE_PATH} material=${material}`,
      0,
    )

    expect(harness.outcome.status).toBe('succeeded')
    expectNoLiveValue(harness.outcome.safe_detail)
    expect(harness.outcome.safe_detail).not.toContain(harness.material)
  })

  it('safe_payload de auditoria achata e redige qualquer valor vivo', () => {
    const payload = toSafePayload({
      dsn: LIVE_DSN,
      secret_ref: LIVE_SECRET_REF,
      authorization: `Bearer ${LIVE_JWT}`,
      path: LIVE_PATH,
    }) as SafePayload

    const serialized = JSON.stringify(payload)
    expectNoLiveValue(serialized)
    expect(serialized).toContain(MASK)
    for (const value of Object.values(payload)) {
      expect(
        ['string', 'number', 'boolean'].includes(typeof value) ||
          value === null,
      ).toBe(true)
    }
  })

  it('evidence_ref de secret nao carrega material nem alias derivavel', async () => {
    const broker = createSecretBroker({
      materials: createInMemorySecretMaterialStore(),
      pepper: 'p'.repeat(48),
      now: () => NOW,
    })
    const issued = broker.issue({
      projectId: PROJECT_ID,
      environment: ENVIRONMENT,
      purpose: 'app_role_password',
      idempotencyKey: `op:canary:app_role_password`,
    })

    expect(issued.secret_ref.startsWith('sref_')).toBe(true)
    expectNoLiveValue(issued.masked_ref)
    expectNoLiveValue(issued.fingerprint)
    expect(issued.masked_ref).toContain(SECRET_REF_MASK)
    // Mascara e fingerprint são neutros: não derivam nem revelam o token.
    expect(issued.masked_ref).not.toContain(issued.secret_ref.slice(5, 20))
    expect(issued.fingerprint).not.toContain(issued.secret_ref.slice(5, 20))
    expect(maskSecretRef(issued.secret_ref)).toBe(issued.masked_ref)
    expect(fingerprintSecretRef(issued.secret_ref)).not.toBe(issued.secret_ref)
  })

  it('redactText mascara path absoluto e preserva texto neutro', () => {
    const text = redactText(
      `arquivo em ${LIVE_PATH} e token ${LIVE_SECRET_REF}`,
    )
    expectNoLiveValue(text)
    expect(text).toContain(PATH_MASK)
    expect(redactText('operacao concluida')).toBe('operacao concluida')
  })
})
