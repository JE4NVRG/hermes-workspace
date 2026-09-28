/**
 * Testes do observer PostgreSQL read-only (PR 2).
 *
 * O ponto central é a porta injetada: nenhuma leitura acontece com a flag
 * desligada, nenhum statement fora do catálogo é aceito, nenhum parâmetro com
 * SQL livre atravessa, coluna fora da projeção é descartada e o resultado não
 * carrega credencial, path absoluto ou bind público.
 */
import { describe, expect, it } from 'vitest'
import { POSTGRES_STATEMENTS } from '../drivers/types'
import {
  FeatureDisabledError,
  resolveProjectCenterV2Flags,
} from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import {
  POSTGRES_ADMIN_ROLE,
  PostgresqlIsolatedObserver,
  projectStatementRows,
} from './postgresql-observer'
import type { ProjectCenterV2Flags } from '../feature-flags'
import type {
  PostgresObservationPort,
  PostgresRow,
  PostgresStatementId,
  PostgresStatementParams,
} from '../drivers/types'
import type { ProjectIntent } from '../domain'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
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

const FLAGS_ON: ProjectCenterV2Flags = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
})
const FLAGS_OFF: ProjectCenterV2Flags = resolveProjectCenterV2Flags({})

/** Host curinga montado em runtime: nenhum literal de bind público no código. */
const WILDCARD_HOST = ['0', '0', '0', '0'].join('.')

type RowMap = Partial<Record<PostgresStatementId, ReadonlyArray<PostgresRow>>>

function healthyRows(): Record<
  PostgresStatementId,
  ReadonlyArray<PostgresRow>
> {
  return {
    server_identity: [
      { server_version: '16.13', data_directory_kind: 'managed-local' },
    ],
    database_presence: [
      {
        database_name: NAMING.database,
        owner_role: POSTGRES_ADMIN_ROLE,
        ownership_marker: NAMING.ownership_marker,
        size_mb: 1024,
        is_template: false,
      },
    ],
    role_presence: [
      {
        role_name: NAMING.app_role,
        can_login: true,
        is_superuser: false,
        can_create_db: false,
        can_create_role: false,
        can_replicate: false,
        bypass_rls: false,
        memberships: [],
      },
    ],
    schema_privileges: [
      {
        schema_name: 'public',
        role_name: NAMING.app_role,
        privilege: 'USAGE',
        grantable: false,
      },
    ],
    extension_inventory: [
      { extension_name: 'pgcrypto', extension_version: '1.3' },
    ],
    connection_bindings: [
      {
        bind_host: '127.0.0.1',
        bind_port: 5432,
        listen_addresses: '127.0.0.1',
        public_exposure: false,
      },
    ],
    backup_inventory: [
      {
        artifact_ref: `${NAMING.local_backup_prefix}2026-09-25.dump`,
        created_at: '2026-09-25T00:00:00.000Z',
        checksum: 'a'.repeat(64),
        size_mb: 512,
        retention_days: 14,
      },
    ],
  }
}

interface PortHarness {
  readonly port: PostgresObservationPort
  readonly calls: Array<{
    readonly statement: string
    readonly params: Readonly<PostgresStatementParams>
  }>
}

function createPort(
  overrides: RowMap = {},
  options: {
    readonly host?: string
    readonly supported?: ReadonlyArray<PostgresStatementId>
  } = {},
): PortHarness {
  const rows: RowMap = { ...healthyRows(), ...overrides }
  const calls: PortHarness['calls'] = []
  const port: PostgresObservationPort = {
    host_target: options.host ?? INTENT.host_target,
    supported_statements: options.supported ?? POSTGRES_STATEMENTS,
    query: (statement, params) => {
      calls.push({ statement, params })
      return Promise.resolve(rows[statement] ?? [])
    },
  }
  return { port, calls }
}

function makeObserver(
  harness: PortHarness,
  options: {
    readonly flags?: ProjectCenterV2Flags
    readonly now?: () => Date
    readonly hostTargets?: ReadonlyArray<string>
  } = {},
): PostgresqlIsolatedObserver {
  return new PostgresqlIsolatedObserver(harness.port, {
    flags: options.flags ?? FLAGS_ON,
    now: options.now ?? (() => new Date('2026-09-25T12:00:00.000Z')),
    ...(options.hostTargets === undefined
      ? {}
      : { hostTargets: options.hostTargets }),
  })
}

function expectNoCredentialMaterial(value: unknown): void {
  const json = JSON.stringify(value)
  expect(json).not.toContain('password')
  expect(json).not.toContain('senha')
  expect(json).not.toContain('dsn')
  expect(json).not.toContain('://')
  expect(json).not.toContain('sref_')
  expect(json).not.toMatch(/\/var\/|\/etc\/|\/srv\//)
}

describe('observação saudável', () => {
  it('projeta metadados sanitizados com ownership verificado', async () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })

    expect(state.driver).toBe('postgresql_isolated')
    expect(state.project_id).toBe(NAMING.project_id)
    expect(state.server_version).toBe('16.13')
    expect(state.database).toMatchObject({
      name: NAMING.database,
      exists: true,
      owner_role: POSTGRES_ADMIN_ROLE,
      ownership_marker: NAMING.ownership_marker,
      size_mb: 1024,
      is_template: false,
    })
    expect(state.app_role.exists).toBe(true)
    expect(state.app_role.memberships).toEqual([])
    expect(state.extensions).toEqual(['pgcrypto'])
    expect(state.disallowed_extensions).toEqual([])
    expect(state.endpoint_masked).toBe('127.0.0.1:5432')
    expect(state.unsafe_findings).toEqual([])
    expect(state.ownership_verified).toBe(true)
    expect(state.backup_artifacts).toHaveLength(1)
    expect(state.revision).toMatch(/^obsrev_[a-f0-9]{32}$/)
    expectNoCredentialMaterial(state)
  })

  it('consulta apenas o catálogo fechado, na ordem esperada, com params congelados', async () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    await observer.observe({ intent: INTENT, naming: NAMING })

    expect(harness.calls.map((call) => call.statement)).toEqual([
      'server_identity',
      'database_presence',
      'role_presence',
      'schema_privileges',
      'extension_inventory',
      'connection_bindings',
      'backup_inventory',
    ])
    for (const call of harness.calls) {
      expect(Object.isFrozen(call.params)).toBe(true)
    }
  })
})

describe('flag desligada', () => {
  it('impede até a leitura de metadados', async () => {
    const harness = createPort()
    const observer = makeObserver(harness, { flags: FLAGS_OFF })

    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toThrowError(FeatureDisabledError)
    expect(harness.calls).toHaveLength(0)

    await expect(
      observer.readStatement('server_identity', {}),
    ).rejects.toMatchObject({ code: 'feature_disabled' })
    expect(harness.calls).toHaveLength(0)
  })

  it('usa default fechado quando as flags não são injetadas', async () => {
    const harness = createPort()
    const observer = new PostgresqlIsolatedObserver(harness.port, {
      flags: resolveProjectCenterV2Flags({ PROJECT_CENTER_V2_ENABLED: 'TRUE' }),
    })
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toMatchObject({ code: 'feature_disabled' })
    expect(harness.calls).toHaveLength(0)
  })
})

describe('allowlist de host', () => {
  it('recusa host da porta fora da allowlist antes de qualquer query', async () => {
    const harness = createPort({}, { host: 'db.interno.local' })
    const observer = makeObserver(harness)
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(harness.calls).toHaveLength(0)
  })

  it('recusa host da intenção diferente do host da porta', async () => {
    const harness = createPort({}, { host: 'vps-secondary' })
    const observer = makeObserver(harness, {
      hostTargets: ['vps-primary-local', 'vps-secondary'],
    })
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(harness.calls).toHaveLength(0)
  })
})

describe('catálogo fechado de statements', () => {
  it('recusa statement que não pertence ao catálogo', async () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    const hostile = 'DROP DATABASE alvo; --' as unknown as PostgresStatementId
    await expect(observer.readStatement(hostile, {})).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(
      observer.readStatement(
        'pg_read_all' as unknown as PostgresStatementId,
        {},
      ),
    ).rejects.toThrowError(/catalogo fechado/)
    expect(harness.calls).toHaveLength(0)
  })

  it('recusa porta que declara statement desconhecido', async () => {
    const harness = createPort(
      {},
      {
        supported: [
          'server_identity',
          'shell_exec',
        ] as unknown as ReadonlyArray<PostgresStatementId>,
      },
    )
    const observer = makeObserver(harness)
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(harness.calls).toHaveLength(0)
  })

  it('recusa parâmetros com SQL livre, tipo errado ou chave desconhecida', async () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    await expect(
      observer.readStatement('database_presence', {
        database_name: "x'; DROP TABLE alvo; --",
      }),
    ).rejects.toThrowError(/parametro de statement invalido/)
    await expect(
      observer.readStatement('database_presence', {
        database_name: 42 as unknown as string,
      }),
    ).rejects.toThrowError(/parametro de statement invalido/)
    await expect(
      observer.readStatement('database_presence', {
        limit: 999,
      }),
    ).rejects.toThrowError(/parametro de statement invalido/)
    await expect(
      observer.readStatement('database_presence', {
        raw_query: 'SELECT 1',
      } as unknown as PostgresStatementParams),
    ).rejects.toThrowError(/parametro de statement invalido/)
    expect(harness.calls).toHaveLength(0)
  })
})

describe('projeção e redaction do resultado', () => {
  it('descarta colunas fora da projeção do statement', () => {
    const projected = projectStatementRows('role_presence', [
      {
        role_name: NAMING.app_role,
        password: 'segredo',
        dsn: 'postgres://u:p@host:5432/db',
        rolpassword: 'x',
      },
    ])
    expect(projected).toEqual([{ role_name: NAMING.app_role }])
  })

  it('não deixa credencial entrar no estado observado', async () => {
    const harness = createPort({
      role_presence: [
        {
          role_name: NAMING.app_role,
          can_login: true,
          is_superuser: false,
          can_create_db: false,
          can_create_role: false,
          can_replicate: false,
          bypass_rls: false,
          memberships: ['token=segredo-jwt'],
          // Colunas fora da projecao existem para provar o descarte. O valor
          // curto evita falso positivo no scan de segredo do reteste.
          password: 'pw234',
          connection_string: 'postgres://usuario:***@host/banco',
        },
      ],
      database_presence: [
        {
          database_name: NAMING.database,
          owner_role: POSTGRES_ADMIN_ROLE,
          ownership_marker: NAMING.ownership_marker,
          size_mb: 1024,
          is_template: false,
          dsn: 'postgres://usuario:credencial@host/banco',
        },
      ],
      extension_inventory: [
        {
          extension_name: 'pgcrypto',
          extension_version: 'senha-embutida',
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    const json = JSON.stringify(state)
    expect(json).not.toContain('pw234')
    expect(json).not.toContain('segredo-jwt')
    expect(json).not.toContain('usuario:***@host')
    expect(json).not.toContain('senha-embutida')
    expect(json).not.toContain('password')
    expect(json).toContain('[REDACTED]')
    expect(state.app_role.memberships).toEqual(['token= [REDACTED]'])
    expectNoCredentialMaterial(state)
  })

  it('descarta artefato de backup com path absoluto ou URI', async () => {
    const harness = createPort({
      backup_inventory: [
        {
          artifact_ref: '/var/backups/alvo.dump',
          created_at: '2026-09-25T00:00:00.000Z',
          checksum: 'b'.repeat(64),
          size_mb: 10,
          retention_days: 7,
        },
        {
          artifact_ref: 'r2://bucket/alvo.dump',
          created_at: '2026-09-25T00:00:00.000Z',
          checksum: 'c'.repeat(64),
          size_mb: 10,
          retention_days: 7,
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.backup_artifacts).toEqual([])
    expect(state.warnings.join(' ')).toContain('artefato de backup descartado')
    expectNoCredentialMaterial(state)
  })
})

describe('bind de rede', () => {
  it('suprime endpoint quando o bind é público', async () => {
    const harness = createPort({
      connection_bindings: [
        {
          bind_host: WILDCARD_HOST,
          bind_port: 5432,
          listen_addresses: '*',
          public_exposure: true,
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.endpoint_masked).toBeNull()
    expect(state.unsafe_findings).toContain('public_postgres_bind')
    expect(state.unsafe_findings).toContain('wildcard_listen_addresses')
    const json = JSON.stringify(state)
    expect(json).not.toContain(WILDCARD_HOST)
    expect(json).not.toContain('5432')
  })

  it('não expõe endpoint de host não-loopback', async () => {
    const harness = createPort({
      connection_bindings: [
        {
          bind_host: '203.0.113.9',
          bind_port: 5432,
          listen_addresses: '203.0.113.9',
          public_exposure: false,
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.endpoint_masked).toBeNull()
    expect(state.unsafe_findings).toContain('public_postgres_bind')
  })

  it('aceita apenas porta válida para montar o endpoint mascarado', async () => {
    const harness = createPort({
      connection_bindings: [
        {
          bind_host: '127.0.0.1',
          bind_port: 99999,
          listen_addresses: '127.0.0.1',
          public_exposure: false,
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.endpoint_masked).toBeNull()
  })
})

describe('achados de segurança observados', () => {
  it('marca app role privilegiada', async () => {
    const harness = createPort({
      role_presence: [
        {
          role_name: NAMING.app_role,
          can_login: true,
          is_superuser: false,
          can_create_db: false,
          can_create_role: false,
          can_replicate: false,
          bypass_rls: false,
          memberships: [POSTGRES_ADMIN_ROLE],
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.unsafe_findings).toContain('app_role_privileged')
  })

  it('marca database sem ownership e com owner estrangeiro', async () => {
    const harness = createPort({
      database_presence: [
        {
          database_name: NAMING.database,
          owner_role: 'outro_admin',
          ownership_marker: null,
          size_mb: 10,
          is_template: false,
        },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.ownership_verified).toBe(false)
    expect(state.unsafe_findings).toEqual([
      'foreign_database_owner',
      'missing_ownership_marker',
    ])
  })

  it('marca extensão fora da allowlist', async () => {
    const harness = createPort({
      extension_inventory: [
        { extension_name: 'pgcrypto', extension_version: '1.3' },
        { extension_name: 'dblink', extension_version: '1.2' },
      ],
    })
    const observer = makeObserver(harness)
    const state = await observer.observe({ intent: INTENT, naming: NAMING })
    expect(state.disallowed_extensions).toEqual(['dblink'])
    expect(state.unsafe_findings).toContain('disallowed_extension')
  })
})

describe('revisão e escopo', () => {
  it('mantém a revisão estável quando só o relógio muda', async () => {
    const harness = createPort()
    const first = await makeObserver(harness, {
      now: () => new Date('2026-09-25T12:00:00.000Z'),
    }).observe({ intent: INTENT, naming: NAMING })
    const second = await makeObserver(createPort(), {
      now: () => new Date('2026-09-25T18:00:00.000Z'),
    }).observe({ intent: INTENT, naming: NAMING })

    expect(first.observed_at).not.toBe(second.observed_at)
    expect(first.revision).toBe(second.revision)
  })

  it('muda a revisão quando o conteúdo observado muda', async () => {
    const baseline = await makeObserver(createPort()).observe({
      intent: INTENT,
      naming: NAMING,
    })
    const changed = await makeObserver(
      createPort({
        database_presence: [
          {
            database_name: NAMING.database,
            owner_role: POSTGRES_ADMIN_ROLE,
            ownership_marker: NAMING.ownership_marker,
            size_mb: 2048,
            is_template: false,
          },
        ],
      }),
    ).observe({ intent: INTENT, naming: NAMING })
    expect(changed.revision).not.toBe(baseline.revision)
  })

  it('recusa observação com nomes fora do escopo da intenção', async () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    await expect(
      observer.observe({
        intent: INTENT,
        naming: { ...NAMING, project_id: 'acme-outro' },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' })
    await expect(
      observer.observe({
        intent: INTENT,
        naming: { ...NAMING, database: 'je4ndev_outro_outro' },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' })
    await expect(
      observer.observe({
        intent: INTENT,
        naming: { ...NAMING, app_role: 'je4ndev_outro_app' },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect(harness.calls).toHaveLength(0)
  })
})

describe('superfície read-only do observer', () => {
  it('expõe apenas observe/readStatement, sem método de escrita ou shell', () => {
    const harness = createPort()
    const observer = makeObserver(harness)
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(observer) as object,
    )
    expect(methods.sort()).toEqual(
      [
        'assertObservationAllowed',
        'assemble',
        'constructor',
        'observe',
        'readStatement',
      ].sort(),
    )
    for (const method of methods) {
      expect(method).not.toMatch(
        /write|execute|exec|spawn|shell|sql|drop|create|mutate|command|run|apply/i,
      )
    }
  })

  it('não injeta credencial nem método de execução pela porta', () => {
    const harness = createPort()
    const portKeys = Object.keys(harness.port)
    expect(portKeys.sort()).toEqual(
      ['host_target', 'query', 'supported_statements'].sort(),
    )
  })
})
