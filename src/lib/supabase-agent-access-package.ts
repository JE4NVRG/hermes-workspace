import type {
  SupabaseRegistryAgentProfile,
  SupabaseRegistryProject,
} from './supabase-registry-types'

export const SUPABASE_PUBLIC_PROJECT_URL = 'https://db.agenciamep.com'
export const SUPABASE_STUDIO_PROJECT_URL = `${SUPABASE_PUBLIC_PROJECT_URL}/project/default`

export type SupabaseAgentAccessDecision = {
  allowed: boolean
  accessLevel: SupabaseRegistryAgentProfile['access_level'] | 'missing'
  mode: 'denied' | 'metadata' | 'readonly' | 'write_scoped' | 'admin_breakglass'
  readOnly: boolean
  reason: string
  profile: SupabaseRegistryAgentProfile | null
  blockingRisks: Array<string>
}

export type BuildSupabaseAgentAccessPackageOptions = {
  agentName?: string
  enforceAgentAccess?: boolean
}

function isClosedRisk(status: string): boolean {
  return status === 'resolved' || status === 'false_positive'
}

function getBlockingRisks(project: SupabaseRegistryProject) {
  return project.risks.filter(
    (risk) => !isClosedRisk(risk.status) && (risk.severity === 'P0' || risk.severity === 'P1'),
  )
}

export function getPrimarySupabaseSchema(project: SupabaseRegistryProject): string {
  return project.schemas[0]?.schema_name ?? project.slug.replace(/-/g, '_')
}

export function evaluateSupabaseAgentAccess(
  project: SupabaseRegistryProject,
  agentName?: string,
): SupabaseAgentAccessDecision {
  const normalizedAgent = agentName?.trim().toLowerCase()
  const blockingRisks = getBlockingRisks(project).map(
    (risk) => `${risk.severity}:${risk.title}`,
  )

  if (!normalizedAgent) {
    return {
      allowed: true,
      accessLevel: 'metadata',
      mode: blockingRisks.length > 0 ? 'readonly' : 'metadata',
      readOnly: true,
      reason: blockingRisks.length > 0
        ? 'Pacote de UI em modo somente leitura porque há risco P0/P1 ativo.'
        : 'Pacote de UI sem identidade de agente; não concede escrita nem credenciais.',
      profile: null,
      blockingRisks,
    }
  }

  const profile = project.agent_profiles.find(
    (item) => item.agent_name.trim().toLowerCase() === normalizedAgent,
  )

  if (!profile || profile.access_level === 'none') {
    return {
      allowed: false,
      accessLevel: profile?.access_level ?? 'missing',
      mode: 'denied',
      readOnly: true,
      reason: `Agente ${normalizedAgent} não possui grant em platform_registry.agent_access_profiles para ${project.slug}.`,
      profile: profile ?? null,
      blockingRisks,
    }
  }

  const riskBlocksBroadAutomation = blockingRisks.length > 0
  const wantsWrite = profile.access_level === 'write_scoped' || profile.access_level === 'admin_breakglass'
  const forcedReadOnly = profile.requires_human_gate || (riskBlocksBroadAutomation && wantsWrite)
  const mode = forcedReadOnly
    ? 'readonly'
    : profile.access_level === 'metadata'
      ? 'metadata'
      : profile.access_level

  return {
    allowed: true,
    accessLevel: profile.access_level,
    mode,
    readOnly: forcedReadOnly || profile.access_level === 'metadata' || profile.access_level === 'readonly',
    reason: forcedReadOnly
      ? 'Grant encontrado, mas pacote rebaixado para read-only por gate humano ou risco P0/P1 ativo.'
      : 'Grant encontrado em platform_registry.agent_access_profiles.',
    profile,
    blockingRisks,
  }
}

export function buildSupabaseAgentAccessPackage(
  project: SupabaseRegistryProject,
  options: BuildSupabaseAgentAccessPackageOptions = {},
): string {
  const decision = evaluateSupabaseAgentAccess(project, options.agentName)
  if (options.enforceAgentAccess && !decision.allowed) {
    throw new Error(decision.reason)
  }

  const activeRisks = project.risks.filter((risk) => !isClosedRisk(risk.status))
  const blockingRisks = getBlockingRisks(project)
  const readableSchemas = decision.readOnly
    ? project.schemas.filter((schema) => schema.allow_agent_read)
    : project.schemas.filter((schema) => schema.allow_agent_read || schema.allow_agent_write)
  const blockedSchemas = project.schemas.filter(
    (schema) => !schema.allow_agent_read || decision.readOnly || !schema.allow_agent_write,
  )
  const primarySchema = getPrimarySupabaseSchema(project)
  const accessProfiles = project.agent_profiles
    .map(
      (profile) =>
        `${profile.agent_name}:${profile.access_level}${profile.requires_human_gate ? ':gate' : ''}`,
    )
    .join(', ')
  const bucketSummary = project.buckets
    .map((bucket) => `${bucket.bucket_id}:${bucket.public ? 'public' : 'private'}`)
    .join(', ')
  const gateStatus = blockingRisks.length > 0
    ? 'BLOCKED_P0_P1_READ_ONLY'
    : decision.readOnly
      ? 'READ_ONLY'
      : 'READY_FOR_SAFE_AUTOMATION'

  return [
    `# Supabase Agent Access Package — ${project.name}`,
    `project_slug: ${project.slug}`,
    `environment: ${project.environment}`,
    `agent: ${options.agentName?.trim().toLowerCase() || 'ui-preview'}`,
    `agent_access: ${decision.accessLevel}`,
    `access_mode: ${decision.mode}`,
    `read_only: ${decision.readOnly ? 'true' : 'false'}`,
    `gate_status: ${gateStatus}`,
    `gate_reason: ${decision.reason}`,
    `project_url: ${SUPABASE_PUBLIC_PROJECT_URL}`,
    `studio_url: ${SUPABASE_STUDIO_PROJECT_URL}`,
    `rest_url: ${SUPABASE_PUBLIC_PROJECT_URL}/rest/v1`,
    `auth_url: ${SUPABASE_PUBLIC_PROJECT_URL}/auth/v1`,
    `storage_url: ${SUPABASE_PUBLIC_PROJECT_URL}/storage/v1`,
    `primary_schema: ${primarySchema}`,
    `readable_schemas: ${readableSchemas.map((schema) => schema.schema_name).join(', ') || 'none'}`,
    `blocked_schemas: ${blockedSchemas.map((schema) => schema.schema_name).join(', ') || 'none'}`,
    `buckets: ${bucketSummary || 'none'}`,
    `agent_profiles: ${accessProfiles || 'not_configured'}`,
    '',
    '# Env seguro para Codex/Claude/Hermes',
    `SUPABASE_URL=${SUPABASE_PUBLIC_PROJECT_URL}`,
    `SUPABASE_REST_URL=${SUPABASE_PUBLIC_PROJECT_URL}/rest/v1`,
    `SUPABASE_AUTH_URL=${SUPABASE_PUBLIC_PROJECT_URL}/auth/v1`,
    `SUPABASE_STORAGE_URL=${SUPABASE_PUBLIC_PROJECT_URL}/storage/v1`,
    `SUPABASE_SCHEMA=${primarySchema}`,
    'PUBLIC_CLIENT_KEY_STATUS=OMITTED_UNTIL_CLASSIFIED_SHAREABLE',
    '',
    '# Regras para o agente',
    '- Use somente os endpoints acima e o schema autorizado.',
    '- Nunca solicite ou use credenciais elevadas, senhas de banco, segredos JWT, tokens pessoais ou qualquer chave sensível em UI aberta.',
    '- Acesso elevado só pode ser liberado via Vault/ACL com gate humano explícito.',
    '- Chave pública de cliente só pode ser anexada quando o projeto estiver classificado como compartilhável e sem bloqueio de segurança.',
    decision.readOnly
      ? '- Escrita bloqueada neste pacote. Qualquer DDL/DML precisa de gate humano explícito.'
      : '- Escrita limitada ao escopo do grant e aos schemas listados; DDL ampla continua proibida sem gate humano.',
    blockingRisks.length > 0
      ? `- BLOQUEADO: existe risco P0/P1 aberto (${blockingRisks.map((risk) => `${risk.severity} ${risk.title}`).join('; ')}). Faça apenas planejamento/auditoria metadata/read-only.`
      : '- Gate P0/P1 livre: automação segura somente conforme allow_agent_read/allow_agent_write e agent_access.',
    activeRisks.length > blockingRisks.length
      ? `- Riscos não bloqueantes ainda ativos: ${activeRisks
          .filter((risk) => !blockingRisks.includes(risk))
          .map((risk) => `${risk.severity} ${risk.title}`)
          .join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
