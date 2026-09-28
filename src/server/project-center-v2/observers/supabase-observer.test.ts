/**
 * Testes do observer Supabase read-only (PR 3).
 *
 * Provam o que o observer promete: a única porta de I/O é a injetada (com
 * catálogo fechado de reads e parâmetros validados), flag desligada fecha antes
 * de qualquer leitura, colunas fora da projeção são descartadas, nenhum
 * endereço bruto observado sobrevive à projeção e o carimbo de revisão é
 * determinístico (sem relógio).
 */
import { describe, expect, it } from 'vitest'
import {
  SUPABASE_IMAGE_PINS,
  SUPABASE_MAX_ROWS,
  SUPABASE_SERVICE_IDS,
  SUPABASE_TEMPLATES,
  pinnedImageRefFor,
} from '../catalogs/supabase-catalog'
import { SUPABASE_BROKER_SLOTS } from '../drivers/supabase-isolated'
import {
  HostNotAllowedError,
  ObservationPortError,
  ObservationScopeError,
  observedStateSchema,
} from '../drivers/types'
import { resolveProjectCenterV2Flags } from '../feature-flags'
import { buildNamingSnapshot } from '../naming'
import { SECRET_REF_MASK, redactText } from '../redaction'
import {
  InvalidReadParamError,
  ReadCatalogError,
  SUPABASE_READS,
  SupabaseIsolatedObserver,
  assertNoCredentialMaterialInProjection,
  formatLoopbackEndpoint,
  projectReadRows,
  sanitizeReadParams,
} from './supabase-observer'
import type {
  SupabaseObservationPort,
  SupabaseReadId,
  SupabaseReadParams,
} from './supabase-observer'
import type { ProjectIntent } from '../domain'

const INTENT: ProjectIntent = {
  client_id: 'acme',
  project_slug: 'site',
  display_name: 'Site Acme',
  driver: 'supabase_isolated',
  environment: 'development',
  host_target: 'vps-primary-local',
  capabilities: {
    auth: true,
    storage: true,
    realtime: true,
    postgrest: true,
    backup: true,
  },
}

const NAMING = buildNamingSnapshot({
  client_id: INTENT.client_id,
  project_slug: INTENT.project_slug,
  environment: INTENT.environment,
  driver: INTENT.driver,
})
const TEMPLATE = SUPABASE_TEMPLATES[0]

const FLAGS_ON = resolveProjectCenterV2Flags({
  PROJECT_CENTER_V2_ENABLED: 'true',
})
const FLAGS_OFF = resolveProjectCenterV2Flags({})

type Row = Record<string, unknown>
type Rows = Partial<Record<SupabaseReadId, ReadonlyArray<Row>>>

function healthyRows(): Rows {
  return {
    stack_inventory: [
      {
        project_name: NAMING.compose_project,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        template_id: TEMPLATE.template_id,
        template_version: TEMPLATE.version,
        service_count: SUPABASE_SERVICE_IDS.length,
        status: 'running',
      },
    ],
    network_inventory: [
      {
        network_name: NAMING.network,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        driver: 'bridge',
        internal: true,
        externally_attached: false,
      },
    ],
    data_store_inventory: [
      {
        store_name: NAMING.data_store,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        engine: 'postgres',
        engine_version: '16.13',
        size_mb: 1024,
        shared_with_other_project: false,
      },
    ],
    role_inventory: [
      {
        role_name: NAMING.app_role,
        exists: true,
        can_login: true,
        is_superuser: false,
        can_create_db: false,
        can_create_role: false,
        can_replicate: false,
        bypass_rls: false,
        memberships: [],
      },
    ],
    grant_inventory: [
      {
        schema_name: 'public',
        role_name: NAMING.app_role,
        privilege: 'USAGE',
        grantable: false,
      },
    ],
    service_inventory: SUPABASE_SERVICE_IDS.map((service) => ({
      service_name: service,
      image_ref: pinnedImageRefFor(service),
      image_digest: SUPABASE_IMAGE_PINS[service].digest,
      status: 'running',
      health: 'healthy',
      template_id: TEMPLATE.template_id,
      restart_count: 0,
    })),
    endpoint_inventory: [
      {
        endpoint_name: 'api',
        bind_scope: 'loopback',
        bind_port: 54321,
        public_exposure: false,
        tls_terminated: false,
      },
    ],
    broker_binding_inventory: SUPABASE_BROKER_SLOTS.map((slot) => ({
      binding_name: `${NAMING.compose_project}:${slot}`,
      scope: 'compose',
      exists: true,
      shared_with_other_project: false,
      rotation_days: 30,
    })),
    capacity_inventory: SUPABASE_SERVICE_IDS.map((service) => ({
      resource_name: service,
      cpu_millicores: 100,
      memory_mb: 128,
      disk_mb: 128,
    })),
    backup_inventory: [],
  }
}

function makePort(
  input: {
    readonly rows?: Rows
    readonly host_target?: string
    readonly supported_reads?: ReadonlyArray<SupabaseReadId>
    readonly raw?: unknown
  } = {},
): {
  readonly port: SupabaseObservationPort
  readonly calls: Array<{
    read: SupabaseReadId
    params: Readonly<SupabaseReadParams>
  }>
} {
  const calls: Array<{
    read: SupabaseReadId
    params: Readonly<SupabaseReadParams>
  }> = []
  const port: SupabaseObservationPort = {
    host_target: input.host_target ?? INTENT.host_target,
    supported_reads: input.supported_reads ?? SUPABASE_READS,
    inspect: (read, params) => {
      calls.push({ read, params })
      if (input.raw !== undefined)
        return Promise.resolve(input.raw as ReadonlyArray<Row>)
      return Promise.resolve([...(input.rows?.[read] ?? [])])
    },
  }
  return { port, calls }
}

function observerWith(
  port: SupabaseObservationPort,
  flags = FLAGS_ON,
): SupabaseIsolatedObserver {
  return new SupabaseIsolatedObserver(port, {
    flags,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  })
}

function observe(
  rows: Rows = healthyRows(),
  options: {
    readonly flags?: ReturnType<typeof resolveProjectCenterV2Flags>
    readonly naming?: typeof NAMING
    readonly intent?: ProjectIntent
  } = {},
) {
  const { port, calls } = makePort({ rows })
  const observer = observerWith(port, options.flags ?? FLAGS_ON)
  return {
    calls,
    port,
    result: observer.observe({
      intent: options.intent ?? INTENT,
      naming: options.naming ?? NAMING,
    }),
  }
}

describe('catálogo fechado de reads', () => {
  it('aceita apenas reads do catálogo', async () => {
    const { port, calls } = makePort({ rows: healthyRows() })
    const observer = observerWith(port)
    await expect(
      observer.readInventory('read_inventado' as unknown as SupabaseReadId),
    ).rejects.toBeInstanceOf(ReadCatalogError)
    expect(calls).toHaveLength(0)
    expect(SUPABASE_READS).toHaveLength(10)
  })

  it('recusa porta que declara read fora do catálogo', async () => {
    const { port } = makePort({
      rows: healthyRows(),
      supported_reads: ['read_inventado' as unknown as SupabaseReadId],
    })
    await expect(
      observerWith(port).readInventory('stack_inventory'),
    ).rejects.toBeInstanceOf(ReadCatalogError)
  })

  it('valida parâmetros: chave, padrão e faixa de limite', async () => {
    expect(() => sanitizeReadParams({ compose_project: 'ok-1' })).not.toThrow()
    expect(() =>
      sanitizeReadParams({ outra_chave: 'x' } as SupabaseReadParams),
    ).toThrow(InvalidReadParamError)
    expect(() => sanitizeReadParams({ compose_project: 'a b' })).toThrow(
      InvalidReadParamError,
    )
    expect(() => sanitizeReadParams({ compose_project: '../outro' })).toThrow(
      InvalidReadParamError,
    )
    expect(() => sanitizeReadParams({ limit: SUPABASE_MAX_ROWS + 1 })).toThrow(
      InvalidReadParamError,
    )
    expect(() => sanitizeReadParams({ limit: 0 })).toThrow(
      InvalidReadParamError,
    )
    const { port, calls } = makePort({ rows: healthyRows() })
    const observer = observerWith(port)
    await observer.readInventory('stack_inventory', {
      compose_project: NAMING.compose_project,
      limit: SUPABASE_MAX_ROWS,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual({
      compose_project: NAMING.compose_project,
      limit: SUPABASE_MAX_ROWS,
    })
    expect(Object.isFrozen(calls[0].params)).toBe(true)
  })

  it('recusa retorno que não é lista', async () => {
    const { port } = makePort({ raw: { rows: [] } })
    await expect(
      observerWith(port).readInventory('stack_inventory'),
    ).rejects.toBeInstanceOf(ObservationPortError)
  })
})

describe('flag e host target', () => {
  it('flag desligada fecha antes de qualquer leitura', async () => {
    const { port, calls } = makePort({ rows: healthyRows() })
    const observer = observerWith(port, FLAGS_OFF)
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toThrowError(/funcionalidade desligada/)
    await expect(
      observer.readInventory('stack_inventory'),
    ).rejects.toThrowError(/funcionalidade desligada/)
    expect(calls).toHaveLength(0)
  })

  it('flag parcialmente ligada não libera leitura', async () => {
    const { port, calls } = makePort({ rows: healthyRows() })
    const observer = observerWith(
      port,
      resolveProjectCenterV2Flags({
        PROJECT_CENTER_V2_WORKER_ENABLED: 'true',
      }),
    )
    await expect(
      observer.observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toThrowError(/funcionalidade desligada/)
    expect(calls).toHaveLength(0)
  })

  it('recusa host target fora da allowlist sem tocar na porta', async () => {
    const { port, calls } = makePort({
      rows: healthyRows(),
      host_target: 'outro-host',
    })
    await expect(
      observerWith(port).observe({ intent: INTENT, naming: NAMING }),
    ).rejects.toBeInstanceOf(HostNotAllowedError)
    expect(calls).toHaveLength(0)
  })

  it('recusa intenção apontando para outro host target', async () => {
    const { port } = makePort({ rows: healthyRows() })
    await expect(
      observerWith(port).observe({
        intent: {
          ...INTENT,
          host_target: 'vps-secundaria' as ProjectIntent['host_target'],
        },
        naming: NAMING,
      }),
    ).rejects.toBeInstanceOf(HostNotAllowedError)
  })
})

describe('escopo da observação', () => {
  const cases: ReadonlyArray<[string, Partial<typeof NAMING>]> = [
    ['project_id', { project_id: 'acme-outro' }],
    ['compose_project', { compose_project: 'je4ndev-sb-outro-site' }],
    ['network', { network: 'je4ndev-sb-outro-site-net' }],
    ['data_store', { data_store: 'je4ndev-sb-outro-site-postgres-data' }],
    ['database', { database: 'je4ndev_acme_outro' }],
    ['app_role', { app_role: 'je4ndev_acme_outro_app' }],
  ]

  it('recusa naming que não corresponde à intenção', async () => {
    for (const [field, patch] of cases) {
      const { port, calls } = makePort({ rows: healthyRows() })
      await expect(
        observerWith(port).observe({
          intent: INTENT,
          naming: { ...NAMING, ...patch },
        }),
      ).rejects.toBeInstanceOf(ObservationScopeError)
      expect(calls, field).toHaveLength(0)
    }
  })
})

describe('projeção sanitizada', () => {
  it('descarta coluna fora da projeção do read', () => {
    const projected = projectReadRows('service_inventory', [
      {
        service_name: 'gotrue',
        image_ref: pinnedImageRefFor('gotrue'),
        password: 'segredo',
        dsn: 'postgres://usuario:senha@host:5432/banco',
        token: `e${'y'}JhbGciOi.assinatura.parte`,
        secret_ref: `sref_${'a'.repeat(43)}`,
        host_path: '/srv/projetos/acme',
      },
    ])
    expect(projected).toHaveLength(1)
    expect(Object.keys(projected[0])).toEqual(['service_name', 'image_ref'])
    const json = JSON.stringify(projected)
    expect(json).not.toContain('segredo')
    expect(json).not.toContain('postgres://')
    expect(json).not.toContain('sref_')
    expect(json).not.toContain('/srv/')
  })

  it('aplica redaction e corte de tamanho em cada célula', () => {
    const projected = projectReadRows('backup_inventory', [
      {
        artifact_ref: 'projetos/acme-site/development/postgres/dump.sql',
        created_at: 'x'.repeat(300),
        checksum: 'postgres://usuario:senha@host:5432/banco',
      },
    ])
    expect(String(projected[0].created_at)).toHaveLength(200)
    expect(String(projected[0].checksum)).not.toContain('postgres://')
    expect(String(projected[0].checksum)).toBe(
      redactText('postgres://usuario:senha@host:5432/banco'),
    )
  })

  it('limita linhas e itens de célula', () => {
    const rows = Array.from({ length: SUPABASE_MAX_ROWS + 10 }, (_, index) => ({
      service_name: `s${index}`,
    }))
    expect(projectReadRows('service_inventory', rows)).toHaveLength(
      SUPABASE_MAX_ROWS,
    )
    const projected = projectReadRows('role_inventory', [
      {
        role_name: 'je4ndev_acme_site_app',
        memberships: Array.from({ length: 50 }, (_, index) => `m${index}`),
      },
    ])
    expect((projected[0].memberships as Array<string>).length).toBe(20)
  })

  it('não preserva endereço bruto nem entrega credencial', async () => {
    const rows = healthyRows()
    rows.endpoint_inventory = [
      {
        endpoint_name: 'api',
        bind_scope: 'public',
        bind_port: 54321,
        bind_host: '203.0.113.7',
        public_exposure: true,
        tls_terminated: false,
      },
    ]
    const { result } = observe(rows)
    const observation = await result
    const json = JSON.stringify(observation)
    expect(json).not.toContain('203.0.113.7')
    expect(json).not.toContain('sref_')
    expect(observation.stack.endpoints[0].scope).toBe('public')
    expect(observation.state.endpoint_masked).toBeNull()
  })

  it('falha fechado quando ainda resta material sensível na projeção', () => {
    expect(() =>
      assertNoCredentialMaterialInProjection({
        note: 'ok',
        detail: `sref_${'a'.repeat(43)}`,
      }),
    ).toThrow(ObservationPortError)
    expect(() =>
      assertNoCredentialMaterialInProjection({
        note: 'postgres://usuario:senha@host:5432/banco',
      }),
    ).toThrow(/material sensivel/)
  })

  it('mascara valor sensível vindo da porta em célula projetada', async () => {
    const rows = healthyRows()
    const token = `sref_${'b'.repeat(43)}`
    rows.broker_binding_inventory = [
      {
        binding_name: token,
        exists: true,
        shared_with_other_project: false,
        rotation_days: 30,
      },
    ]
    const { result } = observe(rows)
    const observation = await result
    const json = JSON.stringify(observation)
    expect(json).not.toContain(token)
    expect(json).toContain(SECRET_REF_MASK)
    expect(observation.stack.broker_bindings[0].name).toBe(SECRET_REF_MASK)
  })
})

describe('observação saudável', () => {
  it('projeta existência, ownership, saúde e capacidade sem drift', async () => {
    const { calls, result } = observe()
    const observation = await result
    expect(calls).toHaveLength(SUPABASE_READS.length)
    expect(calls.every((call) => call.params.limit === SUPABASE_MAX_ROWS)).toBe(
      true,
    )

    const { state, stack } = observation
    expect(stack.compose_project.exists).toBe(true)
    expect(stack.compose_project.ownership_verified).toBe(true)
    expect(stack.network.ownership_verified).toBe(true)
    expect(stack.data_store.ownership_verified).toBe(true)
    expect(stack.ownership_verified).toBe(true)
    expect(stack.template_id).toBe(TEMPLATE.template_id)
    expect(stack.expected_template_id).toBe(TEMPLATE.template_id)
    expect(stack.template_complete).toBe(true)
    expect(stack.missing_services).toEqual([])
    expect(stack.drift_findings).toEqual([])
    expect(stack.services).toHaveLength(SUPABASE_SERVICE_IDS.length)
    expect(stack.services.every((service) => service.pinned)).toBe(true)
    expect(stack.capacity).toHaveLength(SUPABASE_SERVICE_IDS.length)
    expect(stack.broker_bindings).toHaveLength(SUPABASE_BROKER_SLOTS.length)

    expect(() => observedStateSchema.parse(state)).not.toThrow()
    expect(state.ownership_verified).toBe(true)
    expect(state.database.exists).toBe(true)
    expect(state.database.ownership_marker).toBe(NAMING.ownership_marker)
    expect(state.app_role.exists).toBe(true)
    expect(state.privileges).toHaveLength(1)
    expect(state.endpoint_masked).toBe('127.0.0.1:54321')
    expect(state.unsafe_findings).toEqual([])
    expect(state.revision).toMatch(/^obsrev_[a-f0-9]{32}$/)
    expect(state.observed_at).toBe('2026-09-25T12:00:00.000Z')
  })

  it('é determinístico no carimbo e sensível a mudança de conteúdo', async () => {
    const first = await observe().result
    const { port } = makePort({ rows: healthyRows() })
    const other = new SupabaseIsolatedObserver(port, {
      flags: FLAGS_ON,
      now: () => new Date('2026-10-01T08:30:00.000Z'),
    })
    const second = await other.observe({ intent: INTENT, naming: NAMING })
    expect(second.state.revision).toBe(first.state.revision)
    expect(second.state.observed_at).not.toBe(first.state.observed_at)

    const changed = await observe({
      ...healthyRows(),
      data_store_inventory: [
        {
          store_name: NAMING.data_store,
          exists: true,
          ownership_marker: NAMING.ownership_marker,
          engine: 'postgres',
          engine_version: '16.14',
          size_mb: 2048,
          shared_with_other_project: false,
        },
      ],
    }).result
    expect(changed.state.revision).not.toBe(first.state.revision)
  })
})

describe('drift observado', () => {
  it('detecta ownership marker ausente e de outro projeto', async () => {
    const rows = healthyRows()
    rows.stack_inventory = [
      {
        project_name: NAMING.compose_project,
        exists: true,
        ownership_marker: null,
        template_id: TEMPLATE.template_id,
        template_version: TEMPLATE.version,
        status: 'running',
      },
    ]
    const missing = await observe(rows).result
    expect(missing.stack.drift_findings).toContain('missing_ownership_marker')
    expect(missing.stack.compose_project.ownership_verified).toBe(false)
    expect(missing.stack.ownership_verified).toBe(false)
    expect(missing.state.unsafe_findings).toContain('missing_ownership_marker')

    const foreign = healthyRows()
    foreign.stack_inventory = [
      {
        project_name: NAMING.compose_project,
        exists: true,
        ownership_marker:
          'je4ndev:pcv2:supabase_isolated:development:outro-projeto',
        template_id: TEMPLATE.template_id,
        template_version: TEMPLATE.version,
        status: 'running',
      },
    ]
    const result = await observe(foreign).result
    expect(result.stack.drift_findings).toContain('foreign_ownership_marker')
    expect(result.stack.compose_project.ownership_verified).toBe(false)
  })

  it('detecta template desconhecido e versão divergente', async () => {
    const rows = healthyRows()
    rows.stack_inventory = [
      {
        project_name: NAMING.compose_project,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        template_id: 'sb-stack-livre',
        template_version: '2020.01',
        status: 'running',
      },
    ]
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('unlisted_template')
    expect(result.stack.drift_findings).toContain('template_version_drift')
    expect(result.stack.template_complete).toBe(false)
  })

  it('detecta imagem sem digest e digest divergente do catálogo', async () => {
    const rows = healthyRows()
    rows.service_inventory = SUPABASE_SERVICE_IDS.map((service) => ({
      service_name: service,
      image_ref:
        service === 'gotrue'
          ? 'supabase/gotrue:v2.197.0'
          : service === 'realtime'
            ? pinnedImageRefFor(service)
            : pinnedImageRefFor(service),
      image_digest:
        service === 'gotrue'
          ? null
          : service === 'realtime'
            ? `sha256:${'f'.repeat(64)}`
            : SUPABASE_IMAGE_PINS[service].digest,
      status: 'running',
      health: 'healthy',
      template_id: TEMPLATE.template_id,
      restart_count: 0,
    }))
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('unlisted_image')
    expect(result.stack.drift_findings).toContain('image_digest_drift')
    expect(result.stack.template_complete).toBe(false)
    const gotrue = result.stack.services.find(
      (service) => service.name === 'gotrue',
    )
    expect(gotrue?.pinned).toBe(false)
  })

  it('detecta stack parada, serviço sem health e serviço fora do template', async () => {
    const rows = healthyRows()
    rows.stack_inventory = [
      {
        project_name: NAMING.compose_project,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        template_id: TEMPLATE.template_id,
        template_version: TEMPLATE.version,
        status: 'exited',
      },
    ]
    rows.service_inventory = [
      ...SUPABASE_SERVICE_IDS.map((service) => ({
        service_name: service,
        image_ref: pinnedImageRefFor(service),
        image_digest: SUPABASE_IMAGE_PINS[service].digest,
        status: service === 'realtime' ? 'stopped' : 'running',
        health: service === 'gotrue' ? 'unhealthy' : 'healthy',
        template_id: TEMPLATE.template_id,
        restart_count: service === 'realtime' ? 7 : 0,
      })),
      {
        service_name: 'servico-extra',
        image_ref: pinnedImageRefFor('postgrest'),
        image_digest: SUPABASE_IMAGE_PINS.postgrest.digest,
        status: 'running',
        health: 'healthy',
        template_id: TEMPLATE.template_id,
        restart_count: 0,
      },
    ]
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('stack_not_running')
    expect(result.stack.drift_findings).toContain('service_unhealthy')
    expect(result.stack.drift_findings).toContain('unlisted_service')
    expect(result.stack.template_complete).toBe(false)
    expect(
      result.stack.services.find((service) => service.name === 'realtime')
        ?.restart_count,
    ).toBe(7)
    const warnings = result.state.warnings.join(' ')
    expect(warnings).toContain('fora de running')
    expect(warnings).toContain('sem health')
    expect(warnings).toContain('fora do template')
  })

  it('detecta serviço ausente do template', async () => {
    const rows = healthyRows()
    rows.service_inventory = (rows.service_inventory ?? []).slice(0, 3)
    const result = await observe(rows).result
    expect(result.stack.missing_services.length).toBeGreaterThan(0)
    expect(result.stack.template_complete).toBe(false)
    expect(result.stack.services.some((service) => !service.observed)).toBe(
      true,
    )
  })

  it('detecta exposição pública e bind curinga', async () => {
    const rows = healthyRows()
    rows.endpoint_inventory = [
      {
        endpoint_name: 'api',
        bind_scope: 'public',
        bind_port: 443,
        public_exposure: true,
        tls_terminated: true,
      },
      {
        endpoint_name: 'postgres',
        bind_scope: 'wildcard',
        bind_port: 5432,
        public_exposure: false,
        tls_terminated: false,
      },
    ]
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('public_endpoint_exposure')
    expect(result.stack.drift_findings).toContain('wildcard_endpoint_binding')
    expect(result.state.endpoint_masked).toBeNull()
    expect(result.state.unsafe_findings).toContain('public_postgres_bind')
    expect(result.state.unsafe_findings).toContain('wildcard_listen_addresses')
    expect(formatLoopbackEndpoint(0)).toBeNull()
    expect(formatLoopbackEndpoint(54321)).toBe('127.0.0.1:54321')
  })

  it('detecta rede, data store e binding compartilhados', async () => {
    const rows = healthyRows()
    rows.network_inventory = [
      {
        network_name: NAMING.network,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        driver: 'bridge',
        internal: false,
        externally_attached: true,
      },
    ]
    rows.data_store_inventory = [
      {
        store_name: NAMING.data_store,
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        engine: 'postgres',
        engine_version: '16.13',
        size_mb: 1024,
        shared_with_other_project: true,
      },
    ]
    rows.broker_binding_inventory = SUPABASE_BROKER_SLOTS.map((slot) => ({
      binding_name: `${NAMING.compose_project}:${slot}`,
      exists: true,
      shared_with_other_project: true,
      rotation_days: 30,
    }))
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('shared_network')
    expect(result.stack.drift_findings).toContain('shared_data_store')
    expect(result.stack.drift_findings).toContain('shared_broker_binding')
  })

  it('detecta capacidade acima do perfil e resource name divergente', async () => {
    const rows = healthyRows()
    rows.capacity_inventory = [
      {
        resource_name: 'postgres',
        cpu_millicores: 99,
        memory_mb: 999999,
        disk_mb: 10,
      },
      {
        resource_name: 'desconhecido',
        cpu_millicores: 1,
        memory_mb: 1,
        disk_mb: 1,
      },
    ]
    rows.network_inventory = [
      {
        network_name: 'outra-rede',
        exists: true,
        ownership_marker: NAMING.ownership_marker,
        driver: 'bridge',
        internal: true,
        externally_attached: false,
      },
    ]
    const result = await observe(rows).result
    expect(result.stack.drift_findings).toContain('capacity_exceeded')
    expect(result.stack.drift_findings).toContain('unlisted_service')
    expect(result.stack.capacity.map((entry) => entry.name)).toEqual([
      'postgres',
    ])
    // Nome livre vindo da porta não entra na projeção: a expectativa é a
    // derivada do naming e a ausência vira fail-closed.
    expect(result.stack.network.name).toBe(NAMING.network)
    expect(result.stack.network.exists).toBe(false)
    const json = JSON.stringify(result)
    expect(json).not.toContain('outra-rede')
    expect(json).not.toContain('desconhecido')
  })

  it('detecta app role privilegiada e descarta backup inválido', async () => {
    const rows = healthyRows()
    rows.role_inventory = [
      {
        role_name: NAMING.app_role,
        exists: true,
        can_login: true,
        is_superuser: true,
        can_create_db: true,
        can_create_role: false,
        can_replicate: false,
        bypass_rls: true,
        memberships: ['postgres'],
      },
    ]
    rows.backup_inventory = [
      {
        artifact_ref: '/srv/projetos/acme/dump.sql',
        created_at: '2026-09-25T10:00:00.000Z',
        checksum: 'abc',
        size_mb: 10,
        retention_days: 7,
        destination: 'local',
      },
      {
        artifact_ref: 'projetos/acme-site/development/postgres/dump.sql',
        created_at: '2026-09-25T11:00:00.000Z',
        checksum: 'def',
        size_mb: 12,
        retention_days: 14,
        destination: 'r2',
      },
      {
        artifact_ref: 'projetos/acme-site/production/postgres/dump.sql',
        created_at: '2026-09-25T11:30:00.000Z',
        checksum: 'ghi',
        size_mb: 12,
        retention_days: 14,
        destination: 'ftp',
      },
    ]
    const result = await observe(rows).result
    expect(result.state.unsafe_findings).toContain('app_role_privileged')
    expect(result.stack.backup_artifacts).toHaveLength(1)
    expect(result.stack.backup_artifacts[0].destination).toBe('r2')
    expect(result.state.backup_artifacts).toHaveLength(1)
    expect(result.state.warnings.join(' ')).toContain('descartado')
    const json = JSON.stringify(result)
    expect(json).not.toContain('/srv/')
  })
})
