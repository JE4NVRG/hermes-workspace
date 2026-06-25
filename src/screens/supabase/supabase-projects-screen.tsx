import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Alert02Icon,
  Cancel01Icon,
  Copy01Icon,
  Database01Icon,
  DatabaseAddIcon,
  RefreshIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons'
import { useMemo, useState } from 'react'
import type {
  SupabaseRegistryProject,
  SupabaseRegistryRisk,
  SupabaseRegistrySnapshot,
} from '@/lib/supabase-registry-types'
import { toast } from '@/components/ui/toast'
import { writeTextToClipboard } from '@/lib/clipboard'
import {
  SUPABASE_PUBLIC_PROJECT_URL,
  SUPABASE_STUDIO_PROJECT_URL,
  buildSupabaseAgentAccessPackage as buildAgentAccessPackage,
} from '@/lib/supabase-agent-access-package'
import { cn } from '@/lib/utils'

const QUERY_KEY = ['supabase-registry'] as const
const SUPABASE_BASE_URL = SUPABASE_PUBLIC_PROJECT_URL
const SUPABASE_STUDIO_URL = SUPABASE_STUDIO_PROJECT_URL

type ApiSuccess<T> = { ok: true; data: T }
type ApiError = { ok: false; error: string }
type RegistryResponse = ApiSuccess<SupabaseRegistrySnapshot> | ApiError

type CreateProjectPayload = {
  slug: string
  name: string
  owner: string
  description: string
  environment: 'production' | 'staging' | 'development'
  schemaName: string
  sensitivity: 'low' | 'medium' | 'high' | 'critical'
  confirmation: string
}

async function fetchRegistry(): Promise<SupabaseRegistrySnapshot> {
  const response = await fetch('/api/supabase-registry')
  const body = (await response.json()) as RegistryResponse
  if (!response.ok || !body.ok) {
    throw new Error(body.ok ? `HTTP ${response.status}` : body.error)
  }
  return body.data
}

async function createProject(payload: CreateProjectPayload) {
  const response = await fetch('/api/supabase-registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await response.json()) as
    | { ok: true; project: SupabaseRegistryProject }
    | ApiError
  if (!response.ok || !body.ok) {
    throw new Error(body.ok ? `HTTP ${response.status}` : body.error)
  }
  return body.project
}

function riskRank(risk: SupabaseRegistryRisk) {
  const severity = { P0: 0, P1: 1, P2: 2, P3: 3 }[risk.severity]
  const status = risk.status === 'resolved' || risk.status === 'false_positive' ? 10 : 0
  return status + severity
}

function severityClass(severity: SupabaseRegistryRisk['severity']) {
  if (severity === 'P0') return 'border-red-500/40 bg-red-500/10 text-red-300'
  if (severity === 'P1') return 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  if (severity === 'P2') return 'border-sky-500/40 bg-sky-500/10 text-sky-300'
  return 'border-primary-500/30 bg-primary-500/10 text-primary-300'
}

function sensitivityClass(value: string) {
  if (value === 'critical') return 'text-red-300'
  if (value === 'high') return 'text-amber-300'
  if (value === 'medium') return 'text-sky-300'
  return 'text-emerald-300'
}

async function copyAgentPackage(project: SupabaseRegistryProject) {
  try {
    await writeTextToClipboard(buildAgentAccessPackage(project))
    toast(`Pacote ${project.slug} copiado`, { type: 'success' })
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Falha ao copiar pacote', {
      type: 'error',
    })
  }
}

function StatCard({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-2xl border border-primary-200/60 bg-primary-50/60 p-4 dark:border-primary-800/80 dark:bg-primary-950/30">
      <div className="text-2xl font-semibold text-primary-950 dark:text-primary-50">
        {value}
      </div>
      <div className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary-500">
        {label}
      </div>
      <div className="mt-2 text-xs text-primary-500">{detail}</div>
    </div>
  )
}

function RiskBadge({ risk }: { risk: SupabaseRegistryRisk }) {
  const resolved = risk.status === 'resolved' || risk.status === 'false_positive'
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2 text-sm',
        resolved
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : severityClass(risk.severity),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium">{risk.title}</span>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest">
          {risk.severity} · {risk.status}
        </span>
      </div>
      {risk.recommendation ? (
        <p className="mt-1 text-xs opacity-80">{risk.recommendation}</p>
      ) : null}
    </div>
  )
}

function ProjectCard({ project }: { project: SupabaseRegistryProject }) {
  const activeRisks = project.risks.filter(
    (risk) => risk.status !== 'resolved' && risk.status !== 'false_positive',
  )
  const blocked = activeRisks.some((risk) => risk.severity === 'P0' || risk.severity === 'P1')
  const riskList = [...project.risks].sort((a, b) => riskRank(a) - riskRank(b))

  return (
    <article className="rounded-3xl border border-primary-200/70 bg-white/70 p-5 shadow-sm dark:border-primary-800/80 dark:bg-primary-950/40">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-primary-950 dark:text-primary-50">
              {project.name}
            </h2>
            <span className="rounded-full border border-primary-300/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary-600 dark:border-primary-700 dark:text-primary-300">
              {project.slug}
            </span>
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider',
                blocked
                  ? 'bg-red-500/10 text-red-300'
                  : 'bg-emerald-500/10 text-emerald-300',
              )}
            >
              {blocked ? 'Gate P0/P1 ativo' : 'Gate livre'}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-primary-600 dark:text-primary-400">
            {project.description || 'Sem descrição cadastrada no registry.'}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center md:min-w-72">
          <div className="rounded-2xl bg-primary-100/70 px-3 py-2 dark:bg-primary-900/60">
            <div className="text-lg font-bold text-primary-950 dark:text-primary-50">
              {project.schemas.length}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-primary-500">
              schemas
            </div>
          </div>
          <div className="rounded-2xl bg-primary-100/70 px-3 py-2 dark:bg-primary-900/60">
            <div className="text-lg font-bold text-primary-950 dark:text-primary-50">
              {project.buckets.length}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-primary-500">
              buckets
            </div>
          </div>
          <div className="rounded-2xl bg-primary-100/70 px-3 py-2 dark:bg-primary-900/60">
            <div className="text-lg font-bold text-primary-950 dark:text-primary-50">
              {activeRisks.length}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-primary-500">
              riscos
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl border border-accent-500/20 bg-accent-500/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-500">
                Como o agente enxerga
              </h3>
              <p className="mt-1 text-sm text-primary-600 dark:text-primary-400">
                URL e endpoints seguros para Codex/Claude/Hermes. Chaves sensíveis ficam fora da UI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copyAgentPackage(project)}
              className="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-3 py-2 text-xs font-semibold text-white hover:bg-accent-600"
            >
              <HugeiconsIcon icon={Copy01Icon} size={15} strokeWidth={1.7} />
              Copiar pacote
            </button>
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="uppercase tracking-widest text-primary-500">Project URL</dt>
              <dd className="mt-1 break-all font-mono text-primary-950 dark:text-primary-50">{SUPABASE_BASE_URL}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-widest text-primary-500">Schema principal</dt>
              <dd className="mt-1 font-mono text-primary-950 dark:text-primary-50">
                {project.schemas[0]?.schema_name ?? project.slug.replace(/-/g, '_')}
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-widest text-primary-500">REST</dt>
              <dd className="mt-1 break-all font-mono text-primary-950 dark:text-primary-50">{SUPABASE_BASE_URL}/rest/v1</dd>
            </div>
            <div>
              <dt className="uppercase tracking-widest text-primary-500">Auth / Storage</dt>
              <dd className="mt-1 break-all font-mono text-primary-950 dark:text-primary-50">{SUPABASE_BASE_URL}/auth/v1 · {SUPABASE_BASE_URL}/storage/v1</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-primary-200/70 bg-primary-50/70 p-4 text-xs dark:border-primary-800 dark:bg-primary-900/30">
          <h3 className="font-semibold uppercase tracking-[0.16em] text-primary-500">
            Pacote seguro
          </h3>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-primary-950 p-3 font-mono text-[11px] leading-relaxed text-primary-100">
            {buildAgentAccessPackage(project)}
          </pre>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-4">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-500">
            Schemas
          </h3>
          <div className="mt-3 space-y-2">
            {project.schemas.map((schema) => (
              <div
                key={schema.schema_name}
                className="rounded-xl border border-primary-200/70 bg-primary-50/60 p-3 text-sm dark:border-primary-800 dark:bg-primary-900/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-primary-950 dark:text-primary-50">
                    {schema.schema_name}
                  </span>
                  <span className={cn('text-xs font-semibold', sensitivityClass(schema.sensitivity))}>
                    {schema.sensitivity}
                  </span>
                </div>
                <p className="mt-1 text-xs text-primary-500">{schema.purpose}</p>
                <p className="mt-2 text-xs text-primary-500">
                  Agentes: leitura {schema.allow_agent_read ? 'liberada' : 'bloqueada'} · escrita{' '}
                  {schema.allow_agent_write ? 'liberada' : 'bloqueada'}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-500">
            Buckets
          </h3>
          <div className="mt-3 space-y-2">
            {project.buckets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-primary-300/70 p-4 text-sm text-primary-500 dark:border-primary-700">
                Nenhum bucket registrado para este projeto.
              </div>
            ) : (
              project.buckets.map((bucket) => (
                <div
                  key={bucket.bucket_id}
                  className="rounded-xl border border-primary-200/70 bg-primary-50/60 p-3 text-sm dark:border-primary-800 dark:bg-primary-900/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-primary-950 dark:text-primary-50">
                      {bucket.bucket_id}
                    </span>
                    <span className="text-xs text-primary-500">
                      {bucket.public ? 'público' : 'privado'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-primary-500">{bucket.purpose}</p>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-500">
            Agentes e grants
          </h3>
          <div className="mt-3 space-y-2">
            {project.agent_profiles.length === 0 ? (
              <div className="rounded-xl border border-dashed border-primary-300/70 p-4 text-sm text-primary-500 dark:border-primary-700">
                Nenhum grant de agente configurado; API de pacote retorna 403 para agentes sem perfil.
              </div>
            ) : (
              project.agent_profiles.map((profile) => (
                <div
                  key={`${profile.agent_name}-${profile.access_level}`}
                  className="rounded-xl border border-primary-200/70 bg-primary-50/60 p-3 text-sm dark:border-primary-800 dark:bg-primary-900/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-primary-950 dark:text-primary-50">
                      {profile.agent_name}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                      {profile.access_level}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-primary-500">
                    {profile.requires_human_gate
                      ? 'Requer gate humano antes de qualquer automação.'
                      : 'Grant registrado; pacote ainda respeita riscos P0/P1 e permissões de schema.'}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-500">
            Riscos e gates
          </h3>
          <div className="mt-3 space-y-2">
            {riskList.length === 0 ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
                Nenhum risco registrado.
              </div>
            ) : (
              riskList.map((risk) => <RiskBadge key={`${risk.severity}-${risk.title}`} risk={risk} />)
            )}
          </div>
        </section>
      </div>
    </article>
  )
}

function NewProjectPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [schemaName, setSchemaName] = useState('')
  const [description, setDescription] = useState('')
  const [environment, setEnvironment] = useState<CreateProjectPayload['environment']>('production')
  const [sensitivity, setSensitivity] = useState<CreateProjectPayload['sensitivity']>('high')
  const [confirmation, setConfirmation] = useState('')

  const expectedConfirmation = slug ? `CRIAR ${slug.toLowerCase()}` : 'CRIAR <slug>'
  const canSubmit = Boolean(slug && name && schemaName && confirmation === expectedConfirmation)

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      onClose()
    },
  })

  return (
    <div className="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-primary-950 dark:text-primary-50">
            Novo projeto Supabase
          </h2>
          <p className="mt-1 text-sm text-primary-600 dark:text-primary-400">
            Cria o schema isolado, registra o projeto no platform_registry e mantém agentes sem leitura/escrita por padrão.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl p-2 text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-900"
          aria-label="Fechar novo projeto"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={1.6} />
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium text-primary-800 dark:text-primary-200">Slug</span>
          <input
            value={slug}
            onChange={(event) => {
              const next = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
              setSlug(next)
              if (!schemaName) setSchemaName(next.replace(/-/g, '_'))
            }}
            placeholder="meu-projeto"
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium text-primary-800 dark:text-primary-200">Nome</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Meu Projeto"
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium text-primary-800 dark:text-primary-200">Schema</span>
          <input
            value={schemaName}
            onChange={(event) => setSchemaName(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            placeholder="meu_projeto"
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 font-mono text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium text-primary-800 dark:text-primary-200">Ambiente</span>
          <select
            value={environment}
            onChange={(event) => setEnvironment(event.target.value as CreateProjectPayload['environment'])}
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          >
            <option value="production">production</option>
            <option value="staging">staging</option>
            <option value="development">development</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium text-primary-800 dark:text-primary-200">Sensibilidade</span>
          <select
            value={sensitivity}
            onChange={(event) => setSensitivity(event.target.value as CreateProjectPayload['sensitivity'])}
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm md:col-span-2">
          <span className="font-medium text-primary-800 dark:text-primary-200">Descrição</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="Contexto do projeto sem dados sensíveis."
            className="w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-primary-950 outline-none focus:border-accent-500 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50"
          />
        </label>
      </div>

      <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3 text-sm text-red-300">
          <HugeiconsIcon icon={Shield01Icon} size={18} strokeWidth={1.6} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Gate de produção</p>
            <p className="mt-1 text-red-200/80">
              Para executar DDL transacional, digite exatamente <span className="font-mono font-bold">{expectedConfirmation}</span>.
            </p>
          </div>
        </div>
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={expectedConfirmation}
          className="mt-3 w-full rounded-xl border border-red-500/30 bg-primary-950/70 px-3 py-2 font-mono text-primary-50 outline-none focus:border-red-400"
        />
      </div>

      {mutation.isError ? (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {mutation.error instanceof Error ? mutation.error.message : 'Falha ao criar projeto'}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-primary-300 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canSubmit || mutation.isPending}
          onClick={() =>
            mutation.mutate({
              slug,
              name,
              owner: 'je4ndev',
              description,
              environment,
              schemaName,
              sensitivity,
              confirmation,
            })
          }
          className="rounded-xl bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Criando...' : 'Criar com gate'}
        </button>
      </div>
    </div>
  )
}

export function SupabaseProjectsScreen() {
  const [creating, setCreating] = useState(false)
  const registryQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchRegistry,
    refetchInterval: 30_000,
  })

  const snapshot = registryQuery.data
  const metrics = useMemo(() => {
    const projects = snapshot?.projects ?? []
    const risks = projects.flatMap((project) => project.risks)
    const activeRisks = risks.filter(
      (risk) => risk.status !== 'resolved' && risk.status !== 'false_positive',
    )
    return {
      projects: projects.length,
      schemas: projects.reduce((sum, project) => sum + project.schemas.length, 0),
      buckets: projects.reduce((sum, project) => sum + project.buckets.length, 0),
      p0p1: activeRisks.filter((risk) => risk.severity === 'P0' || risk.severity === 'P1').length,
    }
  }, [snapshot])

  return (
    <main className="h-full overflow-auto bg-primary-50 px-4 py-5 dark:bg-primary-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 pb-10">
        <header className="rounded-3xl border border-primary-200/70 bg-white/80 p-5 shadow-sm backdrop-blur dark:border-primary-800/80 dark:bg-primary-950/50">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-accent-500/10 p-3 text-accent-500">
                <HugeiconsIcon icon={Database01Icon} size={28} strokeWidth={1.5} />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-500">
                  platform_registry
                </p>
                <h1 className="mt-1 text-3xl font-semibold tracking-tight text-primary-950 dark:text-primary-50">
                  Supabase Projects
                </h1>
                <p className="mt-2 max-w-3xl text-sm text-primary-600 dark:text-primary-400">
                  Painel read-only por padrão, puxando dados reais do Supabase self-hosted. Riscos P0/P1 aparecem como gate antes de liberar automação ou escrita.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href={SUPABASE_STUDIO_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-primary-300 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900"
              >
                Abrir Studio protegido
              </a>
              <button
                type="button"
                onClick={() => void registryQuery.refetch()}
                className="inline-flex items-center gap-2 rounded-xl border border-primary-300 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900"
              >
                <HugeiconsIcon icon={RefreshIcon} size={16} strokeWidth={1.6} />
                Atualizar
              </button>
              <button
                type="button"
                onClick={() => setCreating((value) => !value)}
                className="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600"
              >
                <HugeiconsIcon icon={DatabaseAddIcon} size={16} strokeWidth={1.6} />
                Novo projeto
              </button>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-accent-500/20 bg-accent-500/5 p-5">
          <div className="grid gap-4 lg:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-500">
                1. Criar projeto
              </p>
              <p className="mt-1 text-sm text-primary-600 dark:text-primary-400">
                Clique em Novo projeto, informe slug/nome/schema e confirme com CRIAR &lt;slug&gt;. O Workspace cria o schema e registra no platform_registry.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-500">
                2. Como o agente conecta
              </p>
              <p className="mt-1 text-sm text-primary-600 dark:text-primary-400">
                Em cada card, Copiar pacote entrega URL, REST, Auth, Storage, schema, buckets e gates para Codex/Claude/Hermes.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-500">
                3. Chaves e escrita
              </p>
              <p className="mt-1 text-sm text-primary-600 dark:text-primary-400">
                A UI nunca mostra credenciais elevadas, senhas, segredos ou tokens. Chave pública de cliente só entra por gate/vault quando o projeto estiver classificado e sem P0.
              </p>
            </div>
          </div>
        </section>

        {creating ? <NewProjectPanel onClose={() => setCreating(false)} /> : null}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Projetos" value={metrics.projects} detail="Registrados no platform_registry" />
          <StatCard label="Schemas" value={metrics.schemas} detail="Mapeados por ownership" />
          <StatCard label="Buckets" value={metrics.buckets} detail="Storage classificado" />
          <StatCard label="P0/P1 ativos" value={metrics.p0p1} detail="Bloqueiam automação ampla" />
        </section>

        {registryQuery.isLoading ? (
          <div className="rounded-3xl border border-primary-200/70 bg-white/70 p-8 text-center text-primary-600 dark:border-primary-800 dark:bg-primary-950/40 dark:text-primary-400">
            Carregando registry real do Supabase...
          </div>
        ) : registryQuery.isError ? (
          <div className="rounded-3xl border border-red-500/30 bg-red-500/10 p-6 text-red-300">
            <div className="flex items-start gap-3">
              <HugeiconsIcon icon={Alert02Icon} size={22} strokeWidth={1.6} className="mt-0.5 shrink-0" />
              <div>
                <h2 className="font-semibold">Falha ao ler platform_registry</h2>
                <p className="mt-1 text-sm opacity-80">
                  {registryQuery.error instanceof Error ? registryQuery.error.message : 'Erro desconhecido'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <section className="space-y-4">
            {(snapshot?.projects ?? []).map((project) => (
              <ProjectCard key={project.slug} project={project} />
            ))}
          </section>
        )}
      </div>
    </main>
  )
}
