import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ZodError, z } from 'zod'
import type {
  SupabaseRegistryProject,
  SupabaseRegistrySnapshot,
} from '@/lib/supabase-registry-types'

const DEFAULT_SUPABASE_DOCKER_DIR =
  '/home/jean/supabase-self-hosted/supabase/docker'

const LIST_REGISTRY_SQL = `
WITH project_rows AS (
  SELECT
    p.slug,
    p.name,
    p.owner,
    p.status,
    p.environment,
    p.description,
    p.created_at,
    p.updated_at,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'schema_name', s.schema_name,
        'purpose', s.purpose,
        'sensitivity', s.sensitivity,
        'allow_agent_read', s.allow_agent_read,
        'allow_agent_write', s.allow_agent_write
      ) ORDER BY s.schema_name)
      FROM platform_registry.project_schemas s
      WHERE s.project_id = p.id
    ), '[]'::jsonb) AS schemas,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'bucket_id', b.bucket_id,
        'public', b.public,
        'purpose', b.purpose,
        'sensitivity', b.sensitivity
      ) ORDER BY b.bucket_id)
      FROM platform_registry.project_buckets b
      WHERE b.project_id = p.id
    ), '[]'::jsonb) AS buckets,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'severity', r.severity,
        'title', r.title,
        'status', r.status,
        'recommendation', r.recommendation,
        'updated_at', r.updated_at
      ) ORDER BY CASE r.severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, r.title)
      FROM platform_registry.risk_register r
      WHERE r.project_slug = p.slug
    ), '[]'::jsonb) AS risks,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_name', a.agent_name,
        'access_level', a.access_level,
        'requires_human_gate', a.requires_human_gate
      ) ORDER BY a.agent_name)
      FROM platform_registry.agent_access_profiles a
      WHERE a.project_slug = p.slug
    ), '[]'::jsonb) AS agent_profiles
  FROM platform_registry.projects p
  ORDER BY p.slug
)
SELECT jsonb_build_object(
  'source', 'platform_registry',
  'generated_at', now(),
  'projects', COALESCE(jsonb_agg(to_jsonb(project_rows)), '[]'::jsonb)
)::text
FROM project_rows;
`

const createProjectInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{2,62}$/, 'Invalid project slug'),
  name: z.string().trim().min(3).max(80),
  owner: z.string().trim().min(2).max(80).default('je4ndev'),
  description: z.string().trim().max(500).optional().nullable(),
  environment: z
    .enum(['production', 'staging', 'development'])
    .default('production'),
  schemaName: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{2,62}$/, 'Invalid schema name'),
  sensitivity: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  confirmation: z.string().trim(),
})

export type CreateSupabaseProjectInput = z.input<
  typeof createProjectInputSchema
>

type SupabaseRegistryRuntime = {
  runPsql?: (sql: string) => string
}

function getSupabaseDockerDir(): string {
  return process.env.SUPABASE_DOCKER_DIR?.trim() || DEFAULT_SUPABASE_DOCKER_DIR
}

function getDockerBin(): string {
  const configured = process.env.SUPABASE_DOCKER_BIN?.trim()
  if (configured) return configured
  if (existsSync('/home/jean/bin/docker')) return '/home/jean/bin/docker'
  return 'docker'
}

function getDockerEnv(): NodeJS.ProcessEnv {
  const rootlessSocket = '/run/user/1000/docker.sock'
  const configuredHost = process.env.DOCKER_HOST?.trim()
  if (configuredHost || !existsSync(rootlessSocket)) return process.env

  return {
    ...process.env,
    DOCKER_HOST: `unix://${rootlessSocket}`,
  }
}

function runPsql(sql: string): string {
  return execFileSync(
    getDockerBin(),
    [
      'compose',
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    {
      cwd: getSupabaseDockerDir(),
      encoding: 'utf8',
      env: getDockerEnv(),
      maxBuffer: 1024 * 1024 * 4,
      timeout: 30_000,
    },
  ).trim()
}

function getRunner(runtime: SupabaseRegistryRuntime = {}): (sql: string) => string {
  return runtime.runPsql ?? runPsql
}

function quoteLiteral(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'NULL'
  return `'${value.replace(/'/g, "''")}'`
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function parseSnapshot(raw: string): SupabaseRegistrySnapshot {
  const parsed = JSON.parse(raw) as SupabaseRegistrySnapshot
  if (!Array.isArray(parsed.projects)) {
    throw new Error('Invalid platform_registry response')
  }
  return parsed
}

function extractPostgresError(message: string): string {
  const match = message.match(/ERROR:\s*([^\n]+)/)
  if (match?.[1]) return match[1].trim()

  if (message.includes('permission denied while trying to connect to the docker API')) {
    return 'sem permissão para acessar Docker/Supabase local neste runtime'
  }

  if (message.includes('Command failed')) return 'comando psql falhou'
  return 'erro desconhecido do Supabase local'
}

export function formatSupabaseRegistryError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join('; ')
  }

  const raw = error instanceof Error ? error.message : String(error)
  if (raw.startsWith('Confirmation must be exactly:')) return raw
  if (raw === 'Project was not found after creation') return raw

  const detail = extractPostgresError(raw)
  return `Falha ao aplicar DDL transacional no Supabase Project Center: ${detail}. Verifique se o stack Supabase está ativo, se platform_registry existe e tente novamente pelo gate CRIAR <slug>. Nenhuma credencial sensível foi exposta.`
}

export function listSupabaseRegistryProjects(
  runtime: SupabaseRegistryRuntime = {},
): SupabaseRegistrySnapshot {
  return parseSnapshot(getRunner(runtime)(LIST_REGISTRY_SQL))
}

export function createSupabaseRegistryProject(
  input: unknown,
  runtime: SupabaseRegistryRuntime = {},
): SupabaseRegistryProject {
  const parsed = createProjectInputSchema.parse(input)
  const expectedConfirmation = `CRIAR ${parsed.slug}`
  if (parsed.confirmation !== expectedConfirmation) {
    throw new Error(`Confirmation must be exactly: ${expectedConfirmation}`)
  }

  const schemaIdent = quoteIdent(parsed.schemaName)
  const createSql = `
BEGIN;

CREATE SCHEMA IF NOT EXISTS ${schemaIdent};
REVOKE ALL ON SCHEMA ${schemaIdent} FROM PUBLIC;
REVOKE ALL ON SCHEMA ${schemaIdent} FROM anon;
REVOKE ALL ON SCHEMA ${schemaIdent} FROM authenticated;

INSERT INTO platform_registry.projects
  (slug, name, owner, status, environment, description)
VALUES
  (${quoteLiteral(parsed.slug)}, ${quoteLiteral(parsed.name)}, ${quoteLiteral(parsed.owner)}, 'active', ${quoteLiteral(parsed.environment)}, ${quoteLiteral(parsed.description)})
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  owner = EXCLUDED.owner,
  status = EXCLUDED.status,
  environment = EXCLUDED.environment,
  description = EXCLUDED.description;

INSERT INTO platform_registry.project_schemas
  (project_id, schema_name, purpose, sensitivity, allow_agent_read, allow_agent_write)
SELECT
  p.id,
  ${quoteLiteral(parsed.schemaName)},
  ${quoteLiteral(`schema principal ${parsed.name}; acesso de agentes bloqueado por padrao`)},
  ${quoteLiteral(parsed.sensitivity)},
  false,
  false
FROM platform_registry.projects p
WHERE p.slug = ${quoteLiteral(parsed.slug)}
ON CONFLICT (project_id, schema_name) DO UPDATE SET
  purpose = EXCLUDED.purpose,
  sensitivity = EXCLUDED.sensitivity,
  allow_agent_read = EXCLUDED.allow_agent_read,
  allow_agent_write = EXCLUDED.allow_agent_write;

INSERT INTO platform_registry.agent_access_profiles
  (agent_name, project_slug, access_level, allowed_schemas, allowed_buckets, allowed_actions, requires_human_gate, notes)
VALUES
  ('luna', ${quoteLiteral(parsed.slug)}, 'metadata', ARRAY[${quoteLiteral(parsed.schemaName)}], ARRAY[]::text[], ARRAY['inspect','report','plan'], false, 'orquestracao e diagnostico; sem DDL/DML sem gate'),
  ('gerente', ${quoteLiteral(parsed.slug)}, 'metadata', ARRAY[${quoteLiteral(parsed.schemaName)}], ARRAY[]::text[], ARRAY['status','roadmap','report'], false, 'gestao de status/roadmap'),
  ('security', ${quoteLiteral(parsed.slug)}, 'metadata', ARRAY[${quoteLiteral(parsed.schemaName)}], ARRAY[]::text[], ARRAY['inspect','audit'], false, 'auditoria de policies/grants/logs sanitizados')
ON CONFLICT (agent_name, project_slug) DO UPDATE SET
  access_level = EXCLUDED.access_level,
  allowed_schemas = EXCLUDED.allowed_schemas,
  allowed_buckets = EXCLUDED.allowed_buckets,
  allowed_actions = EXCLUDED.allowed_actions,
  requires_human_gate = EXCLUDED.requires_human_gate,
  notes = EXCLUDED.notes;

INSERT INTO platform_registry.risk_register
  (project_slug, severity, title, status, evidence, recommendation)
VALUES
  (${quoteLiteral(parsed.slug)}, 'P1', 'Projeto recém-criado aguarda classificação de RLS e grants', 'open', ${quoteLiteral(`schema ${parsed.schemaName} criado pelo Workspace Project Center`)}, 'Executar auditoria metadata-only de grants, RLS e exposição de buckets antes de liberar leitura/escrita para agentes')
ON CONFLICT (project_slug, title) DO UPDATE SET
  severity = EXCLUDED.severity,
  status = EXCLUDED.status,
  evidence = EXCLUDED.evidence,
  recommendation = EXCLUDED.recommendation;

COMMIT;
`

  const runner = getRunner(runtime)
  try {
    runner(createSql)
  } catch (error) {
    throw new Error(formatSupabaseRegistryError(error))
  }

  const snapshot = listSupabaseRegistryProjects({ runPsql: runner })
  const project = snapshot.projects.find((item) => item.slug === parsed.slug)
  if (!project) throw new Error('Project was not found after creation')
  return project
}
