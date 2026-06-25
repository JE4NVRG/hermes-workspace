import { describe, expect, it } from 'vitest'

import {
  createSupabaseRegistryProject,
  formatSupabaseRegistryError,
  listSupabaseRegistryProjects,
} from './supabase-registry'

const snapshotJson = JSON.stringify({
  source: 'platform_registry',
  generated_at: '2026-05-21T00:00:00.000Z',
  projects: [
    {
      slug: 'nexpanel',
      name: 'Nexpanel',
      owner: 'je4ndev',
      status: 'active',
      environment: 'production',
      description: 'Projeto real',
      created_at: '2026-05-03T00:00:00.000Z',
      updated_at: '2026-05-03T00:00:00.000Z',
      schemas: [
        {
          schema_name: 'nexpanel',
          purpose: 'schema principal',
          sensitivity: 'critical',
          allow_agent_read: false,
          allow_agent_write: false,
        },
      ],
      buckets: [],
      risks: [
        {
          severity: 'P0',
          title: 'RLS aberta',
          status: 'open',
          recommendation: 'Corrigir policies',
          updated_at: '2026-05-03T00:00:00.000Z',
        },
      ],
      agent_profiles: [
        {
          agent_name: 'luna',
          access_level: 'metadata',
          requires_human_gate: false,
        },
      ],
    },
  ],
})

describe('listSupabaseRegistryProjects', () => {
  it('lê o snapshot real do platform_registry retornado pelo psql', () => {
    const snapshot = listSupabaseRegistryProjects({ runPsql: () => snapshotJson })

    expect(snapshot.source).toBe('platform_registry')
    expect(snapshot.projects.map((project) => project.slug)).toEqual(['nexpanel'])
    expect(snapshot.projects[0]?.schemas[0]?.schema_name).toBe('nexpanel')
  })
})

describe('createSupabaseRegistryProject', () => {
  it('exige gate CRIAR <slug> antes de emitir DDL', () => {
    const calls: Array<string> = []

    expect(() =>
      createSupabaseRegistryProject(
        {
          slug: 'cliente-ai',
          name: 'Cliente AI',
          owner: 'je4ndev',
          description: 'Projeto novo',
          environment: 'production',
          schemaName: 'cliente_ai',
          sensitivity: 'high',
          confirmation: 'CRIAR errado',
        },
        {
          runPsql: (sql) => {
            calls.push(sql)
            return snapshotJson
          },
        },
      ),
    ).toThrow('Confirmation must be exactly: CRIAR cliente-ai')

    expect(calls).toEqual([])
  })

  it('cria schema isolado, registry, perfis de agentes e risco inicial dentro de transação', () => {
    const calls: Array<string> = []
    const createdSnapshot = JSON.stringify({
      ...JSON.parse(snapshotJson),
      projects: [
        ...JSON.parse(snapshotJson).projects,
        {
          slug: 'cliente-ai',
          name: 'Cliente AI',
          owner: 'je4ndev',
          status: 'active',
          environment: 'production',
          description: 'Projeto novo',
          created_at: '2026-05-21T00:00:00.000Z',
          updated_at: '2026-05-21T00:00:00.000Z',
          schemas: [],
          buckets: [],
          risks: [],
          agent_profiles: [],
        },
      ],
    })

    const project = createSupabaseRegistryProject(
      {
        slug: 'cliente-ai',
        name: 'Cliente AI',
        owner: 'je4ndev',
        description: 'Projeto novo',
        environment: 'production',
        schemaName: 'cliente_ai',
        sensitivity: 'high',
        confirmation: 'CRIAR cliente-ai',
      },
      {
        runPsql: (sql) => {
          calls.push(sql)
          return calls.length === 1 ? '' : createdSnapshot
        },
      },
    )

    expect(project.slug).toBe('cliente-ai')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('BEGIN;')
    expect(calls[0]).toContain('CREATE SCHEMA IF NOT EXISTS "cliente_ai";')
    expect(calls[0]).toContain('REVOKE ALL ON SCHEMA "cliente_ai" FROM PUBLIC;')
    expect(calls[0]).toContain('INSERT INTO platform_registry.projects')
    expect(calls[0]).toContain('INSERT INTO platform_registry.project_schemas')
    expect(calls[0]).toContain('INSERT INTO platform_registry.agent_access_profiles')
    expect(calls[0]).toContain('INSERT INTO platform_registry.risk_register')
    expect(calls[0]).toContain('Projeto recém-criado aguarda classificação de RLS e grants')
    expect(calls[0]).toContain('COMMIT;')
  })

  it('mantém erro de gate acionável sem fingir falha de DDL', () => {
    const message = formatSupabaseRegistryError(
      new Error('Confirmation must be exactly: CRIAR cliente-ai'),
    )

    expect(message).toBe('Confirmation must be exactly: CRIAR cliente-ai')
  })

  it('normaliza erro de DDL sem vazar comando, senha ou stack trace', () => {
    const error = new Error(
      'Command failed: docker compose exec db psql postgresql://postgres:secret@127.0.0.1/postgres\nERROR: relation "platform_registry.projects" does not exist\n    at runPsql (/app/src/server/supabase-registry.ts:120:1)',
    )

    const message = formatSupabaseRegistryError(error)

    expect(message).toContain('Falha ao aplicar DDL transacional')
    expect(message).toContain('platform_registry.projects')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('docker compose')
    expect(message).not.toContain('runPsql')
  })
})
