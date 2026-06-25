export type SupabaseRegistryRiskSeverity = 'P0' | 'P1' | 'P2' | 'P3'
export type SupabaseRegistryRiskStatus =
  | 'open'
  | 'accepted'
  | 'mitigating'
  | 'resolved'
  | 'false_positive'

export type SupabaseRegistrySchema = {
  schema_name: string
  purpose: string
  sensitivity: 'low' | 'medium' | 'high' | 'critical'
  allow_agent_read: boolean
  allow_agent_write: boolean
}

export type SupabaseRegistryBucket = {
  bucket_id: string
  public: boolean
  purpose: string | null
  sensitivity: 'low' | 'medium' | 'high' | 'critical'
}

export type SupabaseRegistryRisk = {
  severity: SupabaseRegistryRiskSeverity
  title: string
  status: SupabaseRegistryRiskStatus
  recommendation: string | null
  updated_at: string
}

export type SupabaseRegistryAgentProfile = {
  agent_name: string
  access_level:
    | 'none'
    | 'metadata'
    | 'readonly'
    | 'write_scoped'
    | 'admin_breakglass'
  requires_human_gate: boolean
}

export type SupabaseRegistryProject = {
  slug: string
  name: string
  owner: string
  status: 'active' | 'standby' | 'archived'
  environment: 'production' | 'staging' | 'development'
  description: string | null
  created_at: string
  updated_at: string
  schemas: Array<SupabaseRegistrySchema>
  buckets: Array<SupabaseRegistryBucket>
  risks: Array<SupabaseRegistryRisk>
  agent_profiles: Array<SupabaseRegistryAgentProfile>
}

export type SupabaseRegistrySnapshot = {
  source: 'platform_registry'
  generated_at: string
  projects: Array<SupabaseRegistryProject>
}
