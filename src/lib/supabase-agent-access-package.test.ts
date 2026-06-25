import { describe, expect, it } from 'vitest'
import {
  buildSupabaseAgentAccessPackage,
  evaluateSupabaseAgentAccess,
} from './supabase-agent-access-package'
import type { SupabaseRegistryProject } from './supabase-registry-types'

const baseProject: SupabaseRegistryProject = {
  slug: 'renderia',
  name: 'Renderia',
  owner: 'je4ndev',
  status: 'active',
  environment: 'production',
  description: 'Projeto real de renderização',
  created_at: '2026-05-03T00:00:00Z',
  updated_at: '2026-05-03T00:00:00Z',
  schemas: [
    {
      schema_name: 'renderia',
      purpose: 'schema principal',
      sensitivity: 'high',
      allow_agent_read: true,
      allow_agent_write: false,
    },
  ],
  buckets: [
    {
      bucket_id: 'public-assets',
      public: true,
      purpose: 'assets públicos',
      sensitivity: 'low',
    },
  ],
  risks: [],
  agent_profiles: [
    {
      agent_name: 'luna',
      access_level: 'metadata',
      requires_human_gate: false,
    },
  ],
}

describe('buildSupabaseAgentAccessPackage', () => {
  it('exports only safe URLs, schema, environment and agent-ready guardrails', () => {
    const pkg = buildSupabaseAgentAccessPackage(baseProject)

    expect(pkg).toContain('project_url: https://db.agenciamep.com')
    expect(pkg).toContain('rest_url: https://db.agenciamep.com/rest/v1')
    expect(pkg).toContain('auth_url: https://db.agenciamep.com/auth/v1')
    expect(pkg).toContain('storage_url: https://db.agenciamep.com/storage/v1')
    expect(pkg).toContain('environment: production')
    expect(pkg).toContain('primary_schema: renderia')
    expect(pkg).toContain('PUBLIC_CLIENT_KEY_STATUS=OMITTED_UNTIL_CLASSIFIED_SHAREABLE')
    expect(pkg).toContain('Vault/ACL')
    expect(pkg).toContain('Codex/Claude/Hermes')
  })

  it('does not expose sensitive credential names as assignable env values', () => {
    const pkg = buildSupabaseAgentAccessPackage(baseProject)

    expect(pkg).not.toMatch(/SERVICE_ROLE\s*=/i)
    expect(pkg).not.toMatch(/POSTGRES_PASSWORD\s*=/i)
    expect(pkg).not.toMatch(/JWT_SECRET\s*=/i)
    expect(pkg).not.toMatch(/SUPABASE_ANON_KEY\s*=/i)
    expect(pkg).not.toMatch(/service_role|postgres password|jwt secret|anon key/i)
  })

  it('marks P0/P1 projects as read-only blocked for broad automation', () => {
    const pkg = buildSupabaseAgentAccessPackage({
      ...baseProject,
      risks: [
        {
          severity: 'P0',
          title: 'Policy bypass aberto',
          status: 'open',
          recommendation: 'Corrigir RLS antes de automação',
          updated_at: '2026-05-03T00:00:00Z',
        },
      ],
    })

    expect(pkg).toContain('gate_status: BLOCKED_P0_P1_READ_ONLY')
    expect(pkg).toContain('BLOQUEADO: existe risco P0/P1 aberto')
    expect(pkg).toContain('read_only: true')
  })

  it('denies package API mode when the agent has no grant', () => {
    const decision = evaluateSupabaseAgentAccess(baseProject, 'dev3')

    expect(decision.allowed).toBe(false)
    expect(decision.accessLevel).toBe('missing')
    expect(() =>
      buildSupabaseAgentAccessPackage(baseProject, {
        agentName: 'dev3',
        enforceAgentAccess: true,
      }),
    ).toThrow('não possui grant')
  })

  it('downgrades write grants to read-only while P1 risk is open', () => {
    const pkg = buildSupabaseAgentAccessPackage(
      {
        ...baseProject,
        risks: [
          {
            severity: 'P1',
            title: 'Grants aguardam revisão humana',
            status: 'open',
            recommendation: 'Revisar antes de liberar escrita',
            updated_at: '2026-05-03T00:00:00Z',
          },
        ],
        agent_profiles: [
          {
            agent_name: 'dev3',
            access_level: 'write_scoped',
            requires_human_gate: false,
          },
        ],
      },
      { agentName: 'dev3', enforceAgentAccess: true },
    )

    expect(pkg).toContain('agent_access: write_scoped')
    expect(pkg).toContain('access_mode: readonly')
    expect(pkg).toContain('gate_status: BLOCKED_P0_P1_READ_ONLY')
  })
})
