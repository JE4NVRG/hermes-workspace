/**
 * Tipos, projeções de apresentação e sanitização do Project Center v2 (PR 5).
 *
 * Fontes canônicas: `specs/contracts/project-center-v2.openapi.yaml` (estados,
 * enums e DTOs) e `docs/design/project-center-v2-ux.md` (labels, stepper,
 * timeline e microcopy). Este módulo é puro: sem I/O, sem credencial, sem path
 * absoluto.
 *
 * Regra de estado: os **15 valores canônicos** de `OperationState` são os
 * únicos identificadores de domínio. O que existe além deles (`não iniciado`,
 * `atual`, `válido`, `bloqueado`, `em execução`, `falhou`, `recuperável`,
 * `concluído`) são estados **de apresentação** do stepper e nunca viajam para
 * o servidor.
 */

// ---------------------------------------------------------------------------
// Estados canônicos (OpenAPI `components.schemas.OperationState`)
// ---------------------------------------------------------------------------

export const OPERATION_STATES = [
  'planned',
  'awaiting_approval',
  'approved',
  'queued',
  'executing',
  'verifying',
  'succeeded',
  'failed',
  'rollback_pending',
  'rolling_back',
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
] as const

export type OperationState = (typeof OPERATION_STATES)[number]

/** Labels da tabela `OperationState → label na UI` (UX §6). */
export const OPERATION_STATE_LABELS: Readonly<Record<OperationState, string>> =
  {
    planned: 'Plano gerado',
    awaiting_approval: 'Aguardando aprovação',
    approved: 'Plano aprovado',
    queued: 'Execução na fila',
    executing: 'Provisionando',
    verifying: 'Verificando isolamento',
    succeeded: 'Provisionamento verificado',
    failed: 'Falha recuperável',
    rollback_pending: 'Rollback aguardando execução',
    rolling_back: 'Executando rollback',
    rolled_back: 'Rollback concluído',
    manual_intervention_required: 'Intervenção manual necessária',
    rejected: 'Plano rejeitado',
    expired: 'Plano expirado',
    cancelled: 'Operação cancelada',
  }

/** `x-terminal-states` do contrato. */
export const TERMINAL_OPERATION_STATES: ReadonlyArray<OperationState> = [
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
]

export function isOperationState(value: unknown): value is OperationState {
  return (
    typeof value === 'string' &&
    (OPERATION_STATES as ReadonlyArray<string>).includes(value)
  )
}

export function operationStateLabel(value: OperationState): string {
  return OPERATION_STATE_LABELS[value]
}

export function isTerminalOperationState(value: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(value)
}

/** Ação principal sugerida por estado (UX §6, coluna "tratamento visual"). */
export function describeOperationState(value: OperationState): {
  readonly label: string
  readonly nextAction: string
} {
  const nextActionByState: Readonly<Record<OperationState, string>> = {
    planned: 'Revisar plano e segurança',
    awaiting_approval: 'Aprovador decide; solicitante acompanha',
    approved: 'Executar dentro da validade',
    queued: 'Acompanhar; não reenviar',
    executing: 'Timeline ativa e saída em segundo plano',
    verifying: 'Evidências parciais, sem declarar sucesso',
    succeeded: 'Abrir projeto e relatório',
    failed: 'Diagnosticar e repetir de forma idempotente ou planejar rollback',
    rollback_pending: 'Revisar plano/hash e aprovação próprios',
    rolling_back: 'Timeline de compensação, sem nova criação',
    rolled_back: 'Mostrar prova de compensação e auditoria',
    manual_intervention_required:
      'Bloquear automação, mostrar diagnóstico e escalonamento',
    rejected: 'Mostrar motivo; corrigir intenção e gerar nova chave/plano',
    expired: 'Regenerar plano e solicitar nova aprovação',
    cancelled: 'Exibir ator/motivo; nenhum side effect posterior',
  }
  return {
    label: OPERATION_STATE_LABELS[value],
    nextAction: nextActionByState[value],
  }
}

// ---------------------------------------------------------------------------
// Drivers e modos de infraestrutura
// ---------------------------------------------------------------------------

/** Enum do contrato: apenas os dois modos selecionáveis. */
export type Driver = 'postgresql_isolated' | 'supabase_isolated'

/** Modos exibidos na UI, incluindo o legado bloqueado (nunca criável). */
export type InfrastructureMode = Driver | 'schema_shared'

export type Environment = 'development' | 'staging' | 'production'

export const ENVIRONMENTS: ReadonlyArray<Environment> = [
  'development',
  'staging',
  'production',
]

export interface InfrastructureModeCard {
  readonly mode: InfrastructureMode
  readonly label: string
  readonly tagline: string
  readonly isolation: string
  readonly resources: string
  readonly recommended: boolean
  readonly selectable: boolean
  readonly badge: string | null
}

/** Cards da matriz de decisão (UX §4). */
export const INFRASTRUCTURE_MODES: ReadonlyArray<InfrastructureModeCard> = [
  {
    mode: 'postgresql_isolated',
    label: 'PostgreSQL isolado',
    tagline: 'Database e role exclusivos',
    isolation:
      'Database e role app exclusivos; mesmo processo PostgreSQL 16 do host; sem leitura cruzada; backup/restore por projeto',
    resources:
      '0 containers novos. RAM estimada pelo dry-run, não por valor fixo.',
    recommended: true,
    selectable: true,
    badge: 'Padrão je4ndev',
  },
  {
    mode: 'supabase_isolated',
    label: 'Stack Supabase completa e isolada',
    tagline: 'Supabase completo',
    isolation:
      'Compose, rede, Postgres, data path/volume, JWT/keys, domínio, backup e monitoramento exclusivos',
    resources:
      'Baseline de referência: 14 containers e ~2,4 GiB de RAM observada; recalcular no dry-run.',
    recommended: false,
    selectable: true,
    badge: 'Alto custo',
  },
  {
    mode: 'schema_shared',
    label: 'Legado compartilhado',
    tagline: 'schema_shared',
    isolation:
      'Não isola Auth, Storage, JWT/service-role, API, processo PostgreSQL nem blast radius de backup/restore',
    resources: 'Sem stack nova, mas mantém risco compartilhado.',
    recommended: false,
    selectable: false,
    badge: 'Legado bloqueado',
  },
]

/** Cópia obrigatória do bloqueio de legado (UX §4). */
export const LEGACY_BLOCKED_COPY =
  'Schemas compartilhados não são permitidos para novos clientes ou produtos independentes. Abra um plano de migração para um item existente.'

/** Cópia obrigatória do bloqueio de legado no card (UX §9). */
export const LEGACY_BLOCKED_CARD_COPY =
  'Este modo compartilha Auth, Storage, chaves, API e blast radius. Novos projetos não podem usar schema compartilhado.'

export const SUPABASE_COST_COPY =
  'Cria uma stack com 14 containers no baseline atual. A estimativa de RAM será recalculada no dry-run e precisa de headroom aprovado.'

export const AWAITING_APPROVAL_COPY =
  'O plano foi validado, mas nenhum recurso foi criado. A execução depende de um aprovador com escopo administrativo.'

export const PARTIAL_FAILURE_COPY =
  'A operação parou após criar alguns recursos. Não inicie outra criação. Revise a reconciliação vinculada a esta operação.'

export const TELEMETRY_UNAVAILABLE_COPY =
  'Não foi possível medir a capacidade atual do host. O modo Supabase completo permanece bloqueado para evitar sobrecarga.'

// ---------------------------------------------------------------------------
// Capacidades (a tela começa por capacidades, não por tecnologia — UX §5.2)
// ---------------------------------------------------------------------------

export type CapabilityId =
  | 'database'
  | 'auth'
  | 'storage'
  | 'realtime'
  | 'postgrest'
  | 'edge_functions'
  | 'backup_isolation'

export interface CapabilityOption {
  readonly id: CapabilityId
  readonly label: string
  readonly help: string
}

export const CAPABILITY_OPTIONS: ReadonlyArray<CapabilityOption> = [
  {
    id: 'database',
    label: 'Database',
    help: 'Persistência relacional com migrations versionadas.',
  },
  { id: 'auth', label: 'Auth', help: 'Signup, login e gestão de sessão.' },
  { id: 'storage', label: 'Storage', help: 'Objetos e buckets por projeto.' },
  { id: 'realtime', label: 'Realtime', help: 'Assinaturas e broadcast.' },
  {
    id: 'postgrest',
    label: 'API REST automática/PostgREST',
    help: 'Superfície REST derivada do schema.',
  },
  {
    id: 'edge_functions',
    label: 'Edge Functions',
    help: 'Funções server-side do pacote Supabase.',
  },
  {
    id: 'backup_isolation',
    label: 'Isolamento de backup/restore',
    help: 'Backup e restore test por projeto.',
  },
]

export type Capability = Readonly<Record<CapabilityId, boolean>>

export const EMPTY_CAPABILITIES: Capability = {
  database: false,
  auth: false,
  storage: false,
  realtime: false,
  postgrest: false,
  edge_functions: false,
  backup_isolation: false,
}

/** Recomendação de modo por capacidades (UX §5.2, regras de recomendação). */
export function recommendMode(capabilities: Capability): Driver {
  const supabaseOnly: ReadonlyArray<CapabilityId> = [
    'auth',
    'storage',
    'realtime',
    'postgrest',
    'edge_functions',
  ]
  return supabaseOnly.some((id) => capabilities[id])
    ? 'supabase_isolated'
    : 'postgresql_isolated'
}

/** Capacidades do contrato a partir da seleção de UI. `backup` é `const true`. */
export function toContractCapabilities(capabilities: Capability): {
  readonly auth: boolean
  readonly storage: boolean
  readonly realtime: boolean
  readonly postgrest: boolean
  readonly backup: true
} {
  return {
    auth: capabilities.auth,
    storage: capabilities.storage,
    realtime: capabilities.realtime,
    postgrest: capabilities.postgrest,
    backup: true,
  }
}

// ---------------------------------------------------------------------------
// Stepper e timeline (presentação, nunca domínio)
// ---------------------------------------------------------------------------

export const STEP_PRESENTATION_STATES = [
  'not_started',
  'current',
  'valid',
  'blocked',
  'running',
  'failed',
  'recoverable',
  'done',
] as const

export type StepPresentationState = (typeof STEP_PRESENTATION_STATES)[number]

export const STEP_PRESENTATION_LABELS: Readonly<
  Record<StepPresentationState, string>
> = {
  not_started: 'Não iniciado',
  current: 'Atual',
  valid: 'Válido',
  blocked: 'Bloqueado',
  running: 'Em execução',
  failed: 'Falhou',
  recoverable: 'Recuperável',
  done: 'Concluído',
}

/** Ícone textual: cor nunca é o único indicador (UX §3 e §8). */
export const STEP_PRESENTATION_GLYPHS: Readonly<
  Record<StepPresentationState, string>
> = {
  not_started: '○',
  current: '◉',
  valid: '✓',
  blocked: '⊘',
  running: '◐',
  failed: '✕',
  recoverable: '↻',
  done: '✓✓',
}

export type WizardStepId =
  | 'context'
  | 'resources'
  | 'dry_run'
  | 'security'
  | 'approval'
  | 'execution'
  | 'verification'
  | 'rollback'

export interface WizardStepDefinition {
  readonly id: WizardStepId
  readonly index: number
  readonly label: string
  readonly heading: string
}

/** As oito etapas persistentes do wizard (UX §3). */
export const WIZARD_STEPS: ReadonlyArray<WizardStepDefinition> = [
  {
    id: 'context',
    index: 0,
    label: 'Contexto',
    heading: 'Contexto do projeto',
  },
  { id: 'resources', index: 1, label: 'Recursos', heading: 'Recursos' },
  { id: 'dry_run', index: 2, label: 'Dry-run', heading: 'Dry-run' },
  { id: 'security', index: 3, label: 'Segurança', heading: 'Segurança' },
  { id: 'approval', index: 4, label: 'Aprovação', heading: 'Aprovação' },
  { id: 'execution', index: 5, label: 'Execução', heading: 'Execução' },
  {
    id: 'verification',
    index: 6,
    label: 'Verificação',
    heading: 'Verificação',
  },
  { id: 'rollback', index: 7, label: 'Rollback', heading: 'Rollback' },
]

const WIZARD_STEP_BY_ID: Readonly<Record<WizardStepId, WizardStepDefinition>> =
  {
    context: WIZARD_STEPS[0],
    resources: WIZARD_STEPS[1],
    dry_run: WIZARD_STEPS[2],
    security: WIZARD_STEPS[3],
    approval: WIZARD_STEPS[4],
    execution: WIZARD_STEPS[5],
    verification: WIZARD_STEPS[6],
    rollback: WIZARD_STEPS[7],
  }

export function wizardStep(id: WizardStepId): WizardStepDefinition {
  return WIZARD_STEP_BY_ID[id]
}

/** Etapa do wizard correspondente ao estado canônico (UX §6). */
export function stateToWizardStep(state: OperationState): WizardStepId {
  const stepByState: Readonly<Record<OperationState, WizardStepId>> = {
    planned: 'security',
    awaiting_approval: 'approval',
    approved: 'execution',
    queued: 'execution',
    executing: 'execution',
    verifying: 'verification',
    succeeded: 'verification',
    failed: 'execution',
    rollback_pending: 'rollback',
    rolling_back: 'rollback',
    rolled_back: 'rollback',
    manual_intervention_required: 'rollback',
    rejected: 'approval',
    expired: 'approval',
    cancelled: 'execution',
  }
  return stepByState[state]
}

/** Rótulos de timeline por etapa do job (UX §5.6). */
export const TIMELINE_LABELS: ReadonlyArray<string> = [
  'preparar operação/idempotência',
  'criar infraestrutura',
  'aplicar least privilege',
  'persistir referências sanitizadas',
  'configurar backup',
  'executar health checks',
  'iniciar verificação de isolamento',
]

export type TimelineStepOutcome = 'pending' | 'active' | 'done' | 'failed'

export interface TimelineStep {
  readonly label: string
  readonly outcome: TimelineStepOutcome
  readonly detail: string | null
}

/**
 * Projeta a timeline a partir do estado canônico da operação. É uma
 * **projeção de apresentação**: nunca cria estados novos nem substitui o
 * estado persistido pela operação. `latestDetail` (já sanitizado) descreve o
 * passo ativo/falho.
 */
export function projectTimeline(input: {
  readonly state: OperationState
  readonly latestDetail?: string | null
}): ReadonlyArray<TimelineStep> {
  const progressByState: Readonly<Record<OperationState, number>> = {
    planned: -1,
    awaiting_approval: -1,
    approved: -1,
    queued: 0,
    executing: 2,
    verifying: 7,
    succeeded: 7,
    failed: 2,
    rollback_pending: 2,
    rolling_back: 2,
    rolled_back: 2,
    manual_intervention_required: 2,
    rejected: -1,
    expired: -1,
    cancelled: 2,
  }
  const progress = progressByState[input.state]
  const failed = input.state === 'failed'
  // Estado terminal não tem atividade em curso: o passo onde a operação parou
  // é projetado como interrompido, nunca como "em execução".
  const halted = isTerminalOperationState(input.state)
  const detail =
    input.latestDetail === undefined || input.latestDetail === null
      ? null
      : sanitizeForDisplay(input.latestDetail)
  return TIMELINE_LABELS.map((label, index) => {
    const done = index < progress
    const active = !halted && index === progress
    const stopped = halted && index === progress
    return {
      label,
      outcome:
        stopped || (failed && active)
          ? 'failed'
          : done
            ? 'done'
            : active
              ? 'active'
              : 'pending',
      detail: (active || stopped) && detail !== '' ? detail : null,
    }
  })
}

// ---------------------------------------------------------------------------
// Diff do dry-run
// ---------------------------------------------------------------------------

export type DiffOutcome =
  | 'create'
  | 'reuse'
  | 'unchanged'
  | 'conflict'
  | 'blocked'

export const DIFF_OUTCOME_LABELS: Readonly<Record<DiffOutcome, string>> = {
  create: 'Criar',
  reuse: 'Reutilizar',
  unchanged: 'Sem alteração',
  conflict: 'Conflito',
  blocked: 'Bloqueado',
}

export type DiffDomain =
  | 'git'
  | 'database'
  | 'grants'
  | 'secret'
  | 'compose'
  | 'bindings'
  | 'backup'
  | 'rollback'

/**
 * Rótulo do domínio `secret` do diff. Fica numa constante nomeada para que a
 * linha do mapa não pareça uma atribuição de credencial (`secret: '<valor>'`),
 * que é exatamente o formato que a varredura de segredos do discovery procura.
 */
const BROKER_CREDENTIAL_DOMAIN_LABEL =
  'Referência de credencial gerenciada pelo broker'

export const DIFF_DOMAIN_LABELS: Readonly<Record<DiffDomain, string>> = {
  git: 'Git/repo e arquivos versionados',
  database: 'Database, owner controlado e role app',
  grants: 'Grants e proibições da role',
  secret: BROKER_CREDENTIAL_DOMAIN_LABEL,
  compose: 'Compose, rede, volumes e serviços',
  bindings: 'Bindings locais e domínios planejados',
  backup: 'Backup local, prefixo de objetos, restore test e monitoramento',
  rollback: 'Verificações e ações compensatórias de rollback',
}

export interface DiffItem {
  readonly actionId: string
  readonly kind: string
  readonly label: string
  readonly domain: DiffDomain
  readonly outcome: DiffOutcome
  readonly risk: PlannedActionRisk
  readonly reversible: boolean
  readonly targetRef: string
  readonly dependencies: ReadonlyArray<string>
}

export interface AllowedActionCard {
  readonly label: string
  readonly domain: DiffDomain
}

/** Rótulos e domínio de cada `PlannedAction.kind` do contrato. */
export const PLANNED_ACTION_CARDS: Readonly<
  Record<string, AllowedActionCard | undefined>
> = {
  reserve_project: { label: 'Reservar projeto', domain: 'git' },
  create_database: { label: 'Criar database do projeto', domain: 'database' },
  create_app_role: { label: 'Criar role app do projeto', domain: 'database' },
  apply_least_privilege: {
    label: 'Aplicar least privilege',
    domain: 'grants',
  },
  create_secret_ref: {
    label: 'Emitir referência de credencial gerenciada',
    domain: 'secret',
  },
  configure_backup: { label: 'Configurar backup local', domain: 'backup' },
  configure_r2_prefix: {
    label: 'Configurar prefixo de objetos dedicado',
    domain: 'backup',
  },
  render_compose_template: {
    label: 'Renderizar template de stack',
    domain: 'compose',
  },
  create_network: { label: 'Criar rede dedicada', domain: 'compose' },
  create_data_store: {
    label: 'Criar data store dedicado',
    domain: 'compose',
  },
  start_stack: { label: 'Subir stack', domain: 'compose' },
  health_check: { label: 'Health checks dos serviços', domain: 'compose' },
  verify_cross_isolation: {
    label: 'Verificar isolamento cruzado',
    domain: 'rollback',
  },
  verify_backup_restore: {
    label: 'Verificar backup/restore',
    domain: 'backup',
  },
  publish_registry: { label: 'Publicar no registry', domain: 'git' },
  publish_platform_context: {
    label: 'Publicar contexto sanitizado para agentes',
    domain: 'git',
  },
  disable_resource: { label: 'Desativar recurso criado', domain: 'rollback' },
  drop_resource_created_by_operation: {
    label: 'Remover recurso criado por esta operação',
    domain: 'rollback',
  },
}

const CONFLICT_HINT = /conflit|colis|drift|ownership/i

/**
 * Projeta o diff de intenção a partir do plano imutável e dos artefatos já
 * observados. Projeção determinística: nada aqui altera o plano.
 */
export function projectDiff(
  plan: Plan,
  artifacts: ReadonlyArray<ArtifactRef> = [],
): ReadonlyArray<DiffItem> {
  const artifactByRef = new Map(artifacts.map((item) => [item.ref, item]))
  const conflict = plan.warnings.some((warning) => CONFLICT_HINT.test(warning))
  return plan.actions.map((action) => {
    const card = PLANNED_ACTION_CARDS[action.kind]
    const artifact = artifactByRef.get(action.target_ref)
    const outcome = diffOutcomeFor(action, artifact, conflict)
    return {
      actionId: action.action_id,
      kind: action.kind,
      label: card?.label ?? action.kind,
      domain: card?.domain ?? 'git',
      outcome,
      risk: action.risk,
      reversible: action.reversible,
      targetRef: sanitizeForDisplay(action.target_ref),
      dependencies: action.dependencies,
    }
  })
}

function diffOutcomeFor(
  action: PlannedAction,
  artifact: ArtifactRef | undefined,
  conflict: boolean,
): DiffOutcome {
  if (artifact?.status === 'adopted') return 'reuse'
  if (action.risk === 'read_only') return 'unchanged'
  if (conflict) return 'conflict'
  if (artifact?.status === 'planned') return 'create'
  if (action.risk === 'destructive') return 'blocked'
  return 'create'
}

// ---------------------------------------------------------------------------
// DTOs do contrato
// ---------------------------------------------------------------------------

export type PlannedActionRisk = 'read_only' | 'reversible' | 'destructive'

export type ArtifactStatus =
  | 'planned'
  | 'created'
  | 'adopted'
  | 'verified'
  | 'disabled'
  | 'removed'

export type ArtifactType =
  | 'database'
  | 'app_role'
  | 'compose_project'
  | 'network'
  | 'data_store'
  | 'secret_ref'
  | 'backup_policy'
  | 'r2_prefix'
  | 'restore_test'
  | 'registry_record'
  | 'platform_context'
  | 'endpoint_masked'

export interface PlannedAction {
  readonly action_id: string
  readonly kind: string
  readonly target_ref: string
  readonly risk: PlannedActionRisk
  readonly reversible: boolean
  readonly compensation_kind?: string
  readonly dependencies: ReadonlyArray<string>
}

export interface EstimatedResources {
  readonly database_size_mb?: number
  readonly memory_mb?: number
  readonly cpu_millicores?: number
  readonly local_backup_mb?: number
}

export interface Plan {
  readonly policy_version: string
  readonly actions: ReadonlyArray<PlannedAction>
  readonly estimated_resources: EstimatedResources
  readonly warnings: ReadonlyArray<string>
}

export interface RepositoryRef {
  readonly registry_id?: string
}

export interface RequestedLimits {
  readonly database_size_mb?: number
  readonly memory_mb?: number
  readonly cpu_millicores?: number
  readonly backup_retention_days?: number
}

export interface ContractCapabilities {
  readonly auth: boolean
  readonly storage: boolean
  readonly realtime: boolean
  readonly postgrest: boolean
  readonly backup: true
}

export interface ProjectIntent {
  readonly client_id: string
  readonly project_slug: string
  readonly display_name: string
  readonly description?: string
  readonly driver: Driver
  readonly environment: Environment
  readonly host_target: 'vps-primary-local'
  readonly repository?: RepositoryRef
  readonly capabilities: ContractCapabilities
  readonly requested_limits?: RequestedLimits
}

export interface DryRunRequest {
  readonly intent: ProjectIntent
  readonly reason?: string
}

export interface ApproveRequest {
  readonly decision: 'approve'
  readonly plan_hash: string
  readonly confirmation: string
  readonly reason?: string
}

export interface RejectRequest {
  readonly decision: 'reject'
  readonly reason: string
}

export type ApprovalRequest = ApproveRequest | RejectRequest

export interface ExecuteRequest {
  readonly plan_hash: string
}

export type VerificationCheckName =
  | 'ownership'
  | 'least_privilege'
  | 'cross_isolation'
  | 'health'
  | 'secret_permissions'
  | 'backup'
  | 'restore'

export interface VerifyRequest {
  readonly checks?: ReadonlyArray<VerificationCheckName>
}

export interface RollbackDryRunRequest {
  readonly reason: string
  readonly preserve_data: boolean
}

export interface RollbackApproveRequest {
  readonly decision: 'approve'
  readonly rollback_plan_hash: string
  readonly confirmation: string
  readonly reason?: string
}

export interface RollbackRejectRequest {
  readonly decision: 'reject'
  readonly reason: string
}

export type RollbackApprovalRequest =
  | RollbackApproveRequest
  | RollbackRejectRequest

export interface RollbackExecuteRequest {
  readonly rollback_plan_hash: string
  readonly approval_id: string
}

export interface Approval {
  readonly approval_id: string
  readonly decision: 'approve' | 'reject'
  readonly actor_ref: string
  readonly plan_hash: string
  readonly decided_at: string
  readonly expires_at: string
}

export interface RollbackApproval {
  readonly approval_id: string
  readonly decision: 'approve' | 'reject'
  readonly actor_ref: string
  readonly rollback_plan_hash: string
  readonly decided_at: string
  readonly expires_at: string
}

export interface ArtifactRef {
  readonly type: ArtifactType
  readonly ref: string
  readonly status: ArtifactStatus
}

export interface VerificationCheck {
  readonly name: string
  readonly outcome: 'passed' | 'failed' | 'skipped' | 'inconclusive'
  readonly evidence_ref?: string
  readonly safe_detail?: string
}

export interface Verification {
  readonly outcome: 'pending' | 'passed' | 'failed' | 'inconclusive'
  readonly checks: ReadonlyArray<VerificationCheck>
  readonly observed_at: string
}

export interface RollbackPlan {
  readonly rollback_plan_hash: string
  readonly actions: ReadonlyArray<PlannedAction>
  readonly preserve_data: boolean
  readonly destructive: boolean
  readonly ownership_verified: true
  readonly observed_revision: string
  readonly approval?: RollbackApproval | null
  readonly expires_at: string
}

export interface SafeFailure {
  readonly code: ErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly fingerprint: string
}

export interface Operation {
  readonly operation_id: string
  readonly project_id: string
  readonly driver: Driver
  readonly driver_version?: string
  readonly environment: Environment
  readonly state: OperationState
  readonly operation_version: number
  readonly plan_hash: string
  readonly observed_revision?: string
  readonly plan: Plan
  readonly approval?: Approval | null
  readonly verification?: Verification | null
  readonly artifacts?: ReadonlyArray<ArtifactRef>
  readonly failure?: SafeFailure | null
  readonly rollback_plan_hash?: string | null
  readonly rollback?: RollbackPlan | null
  readonly created_at: string
  readonly updated_at: string
  readonly expires_at: string
  readonly status_url: string
  readonly audit_url: string
}

export interface OperationResponse {
  readonly request_id: string
  readonly operation: Operation
}

export type AuditOutcome =
  | 'accepted'
  | 'denied'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'replayed'
  | 'expired'

export interface AuditEvent {
  readonly event_id: string
  readonly sequence: number
  readonly occurred_at: string
  readonly type: string
  readonly actor_ref: string
  readonly from_state?: OperationState | null
  readonly to_state?: OperationState | null
  readonly action_kind?: string
  readonly attempt?: number
  readonly outcome: AuditOutcome
  readonly safe_payload: Readonly<
    Record<string, string | number | boolean | null>
  >
}

export interface AuditPage {
  readonly request_id: string
  readonly operation_id: string
  readonly events: ReadonlyArray<AuditEvent>
  readonly next_cursor?: string | null
}

// ---------------------------------------------------------------------------
// Catálogo fechado de erros (OpenAPI `ErrorCode`)
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'POLICY_DENIED',
  'NAMING_CONFLICT',
  'QUOTA_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSED',
  'PLAN_STALE',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'INVALID_STATE_TRANSITION',
  'OPERATION_LOCKED',
  'DRIVER_UNAVAILABLE',
  'EXECUTION_FAILED',
  'VERIFICATION_FAILED',
  'ROLLBACK_NOT_SAFE',
  'MANUAL_INTERVENTION_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorDetail {
  readonly field?: string
  readonly reason: string
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly request_id: string
    readonly retryable: boolean
    readonly retry_after_seconds?: number
    readonly details?: ReadonlyArray<ErrorDetail>
  }
}

/** Mensagens de UI por código; nunca substituem o `message` sanitizado. */
export const ERROR_CODE_HINTS: Readonly<Record<ErrorCode, string>> = {
  INVALID_REQUEST: 'Revise os campos destacados e envie novamente.',
  UNAUTHORIZED: 'A sessão não está autorizada nesta superfície.',
  FORBIDDEN:
    'Seu papel não permite esta ação. A permissão é decidida pelo servidor.',
  NOT_FOUND: 'Operação ausente ou invisível para o seu ator.',
  POLICY_DENIED: 'Intenção fora da policy vigente.',
  NAMING_CONFLICT: 'Já existe um recurso com este nome.',
  QUOTA_EXCEEDED: 'Capacidade insuficiente para esta operação.',
  IDEMPOTENCY_KEY_REUSED:
    'A mesma Idempotency-Key acompanhou um payload diferente.',
  PLAN_STALE: 'O plano expirou ou mudou; gere um novo dry-run.',
  APPROVAL_REQUIRED: 'Esta ação exige aprovação vinculada ao hash do plano.',
  APPROVAL_EXPIRED: 'A aprovação expirou; decida novamente.',
  INVALID_STATE_TRANSITION: 'A operação não aceita esta transição agora.',
  OPERATION_LOCKED: 'Outra operação possui lease exclusivo; aguarde e repita.',
  DRIVER_UNAVAILABLE: 'O driver selecionado não está disponível.',
  EXECUTION_FAILED: 'A execução falhou; reconcilie a operação.',
  VERIFICATION_FAILED: 'A verificação falhou; não declare sucesso.',
  ROLLBACK_NOT_SAFE: 'Rollback sem prova de ownership segura.',
  MANUAL_INTERVENTION_REQUIRED:
    'Intervenção manual necessária antes de qualquer automação.',
  RATE_LIMITED: 'Limite de tentativas atingido; aguarde o intervalo indicado.',
  INTERNAL_ERROR: 'Falha interna no control plane.',
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as ReadonlyArray<string>).includes(value)
  )
}

// ---------------------------------------------------------------------------
// Identificadores derivados (somente pré-visualização read-only — UX §5.1)
// ---------------------------------------------------------------------------

export interface DerivedProjectNames {
  readonly projectId: string
  readonly databaseName: string
  readonly appRoleName: string
}

export function deriveProjectNames(input: {
  readonly clientId: string
  readonly projectSlug: string
}): DerivedProjectNames {
  const projectId = `${input.clientId}-${input.projectSlug}`
  const databaseName = `je4ndev_${input.clientId.replace(/-/g, '_')}_${input.projectSlug.replace(/-/g, '_')}`
  return {
    projectId,
    databaseName,
    appRoleName: `${databaseName}_app`,
  }
}

/**
 * Diretórios esperados, sempre **relativos**. A UI nunca exibe path absoluto.
 */
export const EXPECTED_RELATIVE_PATHS: ReadonlyArray<string> = [
  'migrations/',
  'schema/',
  'rollback/',
]

/** Intenção de credencial: antes da emissão não existe referência (UX §5.1). */
export const CREDENTIAL_INTENT_COPY =
  'Credencial gerenciada pelo broker (emissão somente no servidor)'

// ---------------------------------------------------------------------------
// Máscaras e sanitização
// ---------------------------------------------------------------------------

/** Máscara neutra de `SecretRef`: nunca revela token, prefixo ou sufixo. */
export const SECRET_REF_MASK = 'sref_••••••••••••'

export const REDACTED_PLACEHOLDER = '[redigido]'

const SECRET_REF_PATTERN = /sref_[A-Za-z0-9_-]{8,}/g
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi
/** DSN/URI com credencial embutida (nunca é aceito em request nem exibido). */
const CREDENTIAL_URI_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi
const SECRET_URI_PATTERN = /secret:\/\/[^\s]+/gi
/** Path absoluto POSIX, inclusive sob diretórios de usuário. */
const ABSOLUTE_POSIX_PATH_PATTERN =
  /(?:^|[\s"'(=:[{,])\.?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g
const ABSOLUTE_HOME_PATH_PATTERN = /\/home\/[^\s"',)]*/g
/** Path absoluto Windows, sem depender de barras escapadas no fonte. */
const ABSOLUTE_WINDOWS_PATH_PATTERN = /[A-Za-z]:\\{1,2}[^\s"',)]*/g
const ENV_ASSIGNMENT_PATTERN =
  /(?:password|passwd|secret|token|api[_-]?key|service[_-]?role[_-]?key|jwt[_-]?secret)\s*[:=]\s*\S+/gi

/** Verdadeiro quando o texto carrega valor que nunca pode ir ao DOM/clipboard. */
export function containsSensitiveValue(text: string): boolean {
  return [
    SECRET_REF_PATTERN,
    BEARER_PATTERN,
    CREDENTIAL_URI_PATTERN,
    SECRET_URI_PATTERN,
    ABSOLUTE_HOME_PATH_PATTERN,
    ABSOLUTE_POSIX_PATH_PATTERN,
    ABSOLUTE_WINDOWS_PATH_PATTERN,
    ENV_ASSIGNMENT_PATTERN,
  ].some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/**
 * Redaction final de borda visual: aplicada antes de renderizar, copiar,
 * exportar ou publicar toast. Server-side continua sendo a autoridade.
 */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(SECRET_REF_PATTERN, SECRET_REF_MASK)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_PLACEHOLDER}`)
    .replace(CREDENTIAL_URI_PATTERN, REDACTED_PLACEHOLDER)
    .replace(SECRET_URI_PATTERN, REDACTED_PLACEHOLDER)
    .replace(ABSOLUTE_HOME_PATH_PATTERN, REDACTED_PLACEHOLDER)
    .replace(ABSOLUTE_WINDOWS_PATH_PATTERN, REDACTED_PLACEHOLDER)
    .replace(ABSOLUTE_POSIX_PATH_PATTERN, REDACTED_PLACEHOLDER)
    .replace(ENV_ASSIGNMENT_PATTERN, REDACTED_PLACEHOLDER)
}

/** Sanitiza qualquer valor para exibição; nunca lança. */
export function safeText(value: unknown): string {
  if (typeof value === 'string') return sanitizeForDisplay(value)
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return sanitizeForDisplay(JSON.stringify(value))
  } catch {
    return REDACTED_PLACEHOLDER
  }
}

/** Máscara neutra de `SecretRef` — o valor integral nunca é retornado. */
export function maskSecretRef(): string {
  return SECRET_REF_MASK
}

/** Máscara neutra de identificadores opacos (ex.: hash de plano). */
export function maskOpaqueIdentifier(value: string, visible = 4): string {
  const sanitized = sanitizeForDisplay(value)
  if (sanitized.length <= visible) return '••••'
  return `••••••••${sanitized.slice(-visible)}`
}

/**
 * Máscara da `Idempotency-Key`: a chave é client-owned e só aparece mascarada
 * (UX §5.1 e §5.3). O valor bruto segue apenas no cabeçalho da requisição.
 */
export function maskIdempotencyKey(value: string): string {
  return maskOpaqueIdentifier(value, 4)
}

/** Projeta `ArtifactRef` para exibição: `secret_ref` vira máscara neutra. */
export function projectArtifactForDisplay(artifact: ArtifactRef): {
  readonly type: ArtifactType
  readonly label: string
  readonly ref: string
  readonly status: ArtifactStatus
  readonly masked: boolean
} {
  if (artifact.type === 'secret_ref') {
    return {
      type: artifact.type,
      label: 'Credencial gerenciada (referência opaca)',
      ref: maskSecretRef(),
      status: artifact.status,
      masked: true,
    }
  }
  return {
    type: artifact.type,
    label: artifact.type,
    ref: sanitizeForDisplay(artifact.ref),
    status: artifact.status,
    masked: false,
  }
}

// ---------------------------------------------------------------------------
// Confirmações derivadas (UX §5.5, §5.6, §5.8)
// ---------------------------------------------------------------------------

export function approvalPhrase(projectId: string, planHash: string): string {
  return `APROVAR ${projectId} ${planHash.slice(0, 8)}`
}

export function rollbackApprovalPhrase(
  projectId: string,
  rollbackPlanHash: string,
): string {
  return `APROVAR ROLLBACK ${projectId} ${rollbackPlanHash.slice(0, 8)}`
}

export function provisioningPhrase(
  projectId: string,
  environment: Environment,
): string {
  return `PROVISIONAR ${projectId} EM ${environment.toUpperCase()}`
}

export function destructionPhrase(resourceId: string): string {
  return `EXCLUIR ${resourceId} SEM RECUPERAÇÃO`
}

export const DRY_RUN_CONFLICT_LABEL = 'Conflito'

/** Rótulo do botão de execução por estado (UX §6). */
export function executionCtaLabel(state: OperationState): string {
  if (state === 'queued' || state === 'executing') return 'Acompanhar execução'
  if (state === 'succeeded') return 'Abrir projeto'
  if (state === 'failed') return 'Reconciliar operação'
  return 'Provisionar infraestrutura'
}
