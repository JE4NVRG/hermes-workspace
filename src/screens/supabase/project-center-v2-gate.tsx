/**
 * Gate de superfície e estados base do Project Center v2 (PR 5).
 *
 * O gate usa a flag **server-projected**: ele só libera a UI v2 quando o
 * servidor confirma que a superfície está habilitada. Flag desligada, servidor
 * indisponível ou resposta ambígua ⇒ nada novo é renderizado e a experiência
 * atual permanece exatamente como está (fail-closed).
 *
 * Os painéis de estado cobrem loading, empty, error, permission denied,
 * bloqueio por gate P0/P1 e snapshot stale (UX §6). Nenhum deles exibe path
 * absoluto, credencial, comando administrativo ou referência opaca integral.
 */
import type { ReactNode } from 'react'
import type {
  ProjectCenterV2Client,
  ProjectCenterV2Surface,
} from '@/lib/project-center-v2-api'
import type { ErrorCode } from '@/lib/project-center-v2-types'
import { useProjectCenterV2Surface } from '@/hooks/use-project-center-v2'
import { ProjectCenterV2ApiError } from '@/lib/project-center-v2-api'
import {
  ERROR_CODE_HINTS,
  safeText,
  sanitizeForDisplay,
} from '@/lib/project-center-v2-types'
import { cn } from '@/lib/utils'

export const PCV2_CARD =
  'rounded-3xl border border-primary-200/70 bg-white/70 p-5 shadow-sm dark:border-primary-800/80 dark:bg-primary-950/40'
export const PCV2_PANEL =
  'rounded-2xl border border-primary-200/70 bg-primary-50/60 p-4 dark:border-primary-800 dark:bg-primary-900/30'
export const PCV2_HEADING = 'text-primary-950 dark:text-primary-50'
export const PCV2_MUTED = 'text-primary-600 dark:text-primary-400'
export const PCV2_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-50 dark:focus-visible:ring-offset-primary-950'

/** Alvo mínimo de 44 × 44 px (UX §8). Nunca reduzir em telas estreitas. */
export const PCV2_TOUCH_TARGET = 'min-h-11 min-w-11'
export const PCV2_PRIMARY_BUTTON = cn(
  PCV2_TOUCH_TARGET,
  PCV2_FOCUS,
  'inline-flex items-center justify-center gap-2 rounded-xl bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50',
)
export const PCV2_SECONDARY_BUTTON = cn(
  PCV2_TOUCH_TARGET,
  PCV2_FOCUS,
  'inline-flex items-center justify-center gap-2 rounded-xl border border-primary-300 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-primary-700 dark:text-primary-300 dark:hover:bg-primary-900',
)
export const PCV2_DESTRUCTIVE_BUTTON = cn(
  PCV2_TOUCH_TARGET,
  PCV2_FOCUS,
  'inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/50 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50',
)
export const PCV2_FIELD_INPUT = cn(
  PCV2_FOCUS,
  'w-full rounded-xl border border-primary-300 bg-white px-3 py-2 text-sm text-primary-950 dark:border-primary-700 dark:bg-primary-950 dark:text-primary-50',
)
export const PCV2_LABEL = cn(
  'block text-sm font-medium text-primary-800 dark:text-primary-200',
)

export interface ProjectCenterV2GateProps {
  readonly children: ReactNode
  /** Conteúdo da experiência atual; default: nada (flag off é invisível). */
  readonly fallback?: ReactNode
  readonly client?: ProjectCenterV2Client
  /** Superfície já resolvida (testes/integração); evita uma consulta extra. */
  readonly surface?: ProjectCenterV2Surface | null
}

/**
 * Só renderiza `children` quando o servidor projeta a superfície v2 ligada.
 * Enquanto a consulta não responde, nada novo aparece: a UI legada continua.
 */
export function ProjectCenterV2Gate({
  children,
  fallback = null,
  client,
  surface,
}: ProjectCenterV2GateProps) {
  if (surface !== undefined) {
    return surface?.apiEnabled === true ? <>{children}</> : <>{fallback}</>
  }
  return (
    <ProjectCenterV2GateWithQuery client={client} fallback={fallback}>
      {children}
    </ProjectCenterV2GateWithQuery>
  )
}

function ProjectCenterV2GateWithQuery({
  children,
  fallback,
  client,
}: {
  readonly children: ReactNode
  readonly fallback: ReactNode
  readonly client?: ProjectCenterV2Client
}) {
  const { apiEnabled } = useProjectCenterV2Surface(client)
  return apiEnabled ? <>{children}</> : <>{fallback}</>
}

// ---------------------------------------------------------------------------
// Estados base
// ---------------------------------------------------------------------------

export function ProjectCenterV2LoadingState({
  label = 'Carregando estado da operação',
  elapsedSeconds,
}: {
  readonly label?: string
  readonly elapsedSeconds?: number
}) {
  return (
    <section
      aria-busy="true"
      className={cn(PCV2_CARD, 'space-y-2')}
      data-testid="pcv2-loading"
    >
      <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>{label}</h2>
      <div className="space-y-2" aria-hidden="true">
        <div className="h-3 w-2/3 animate-pulse rounded bg-primary-200/70 dark:bg-primary-800/70" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-primary-200/70 dark:bg-primary-800/70" />
      </div>
      <p className={cn('text-sm', PCV2_MUTED)}>
        {elapsedSeconds === undefined
          ? 'Aguardando o control plane.'
          : `Decorrido: ${elapsedSeconds}s. Você pode acompanhar em segundo plano.`}
      </p>
    </section>
  )
}

export function ProjectCenterV2EmptyState({
  canCreate,
  onCreate,
  onImportLegacy,
}: {
  readonly canCreate: boolean
  readonly onCreate?: () => void
  readonly onImportLegacy?: () => void
}) {
  return (
    <section className={cn(PCV2_CARD, 'space-y-3')} data-testid="pcv2-empty">
      <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
        Nenhum projeto isolado provisionado
      </h2>
      <p className={cn('text-sm', PCV2_MUTED)}>
        Esta lista mostra projetos com infraestrutura isolada (
        <span className="font-mono">postgresql_isolated</span> ou{' '}
        <span className="font-mono">supabase_isolated</span>), verificações e
        operações em andamento.
      </p>
      <div className="flex flex-wrap gap-3">
        {canCreate && onCreate ? (
          <button
            className={PCV2_PRIMARY_BUTTON}
            onClick={onCreate}
            type="button"
          >
            Novo projeto isolado
          </button>
        ) : null}
        {onImportLegacy ? (
          <button
            className={PCV2_SECONDARY_BUTTON}
            onClick={onImportLegacy}
            type="button"
          >
            Importar inventário legado
          </button>
        ) : null}
      </div>
      <p className={cn('text-xs', PCV2_MUTED)}>
        Schemas compartilhados não são permitidos para novos clientes ou
        produtos independentes. Abra um plano de migração para um item
        existente.
      </p>
    </section>
  )
}

export function ProjectCenterV2ErrorState({
  error,
  onRetry,
  operationId,
}: {
  readonly error: unknown
  readonly onRetry?: () => void
  readonly operationId?: string | null
}) {
  const code: ErrorCode | null =
    error instanceof ProjectCenterV2ApiError ? error.code : null
  const detail =
    error instanceof ProjectCenterV2ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Falha sem detalhe tipado'
  return (
    <section
      className={cn(PCV2_CARD, 'space-y-3 border-red-500/40 bg-red-500/5')}
      data-testid="pcv2-error"
      role="alert"
    >
      <h2 className="text-lg font-semibold text-red-200">
        Operação não concluída
      </h2>
      <p className="text-sm text-red-100/90">{sanitizeForDisplay(detail)}</p>
      <p className={cn('text-xs', PCV2_MUTED)}>
        {code === null
          ? 'Próximo passo: revisar o estado da operação e repetir a tentativa.'
          : ERROR_CODE_HINTS[code]}
      </p>
      <p className={cn('text-xs', PCV2_MUTED)}>
        {operationId === undefined || operationId === null
          ? 'Sem operação persistida: nenhuma ação foi enfileirada.'
          : `Referencie a operação ao abrir suporte.`}
      </p>
      {onRetry ? (
        <button
          className={PCV2_SECONDARY_BUTTON}
          onClick={onRetry}
          type="button"
        >
          Tentar novamente
        </button>
      ) : null}
    </section>
  )
}

export function ProjectCenterV2DeniedState({
  requiredRole,
  requiredScope,
  onRequestAccess,
}: {
  readonly requiredRole: string
  readonly requiredScope: string
  readonly onRequestAccess?: () => void
}) {
  return (
    <section
      aria-live="polite"
      className={cn(PCV2_CARD, 'space-y-2')}
      data-testid="pcv2-denied"
    >
      <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
        Você pode visualizar, mas não aprovar/executar
      </h2>
      <p className={cn('text-sm', PCV2_MUTED)}>
        Esta ação exige o papel{' '}
        <span className="font-mono">{requiredRole}</span> com o escopo{' '}
        <span className="font-mono">{requiredScope}</span>. A permissão é
        decidida pelo servidor; esconder um botão não concede nem remove acesso.
      </p>
      {onRequestAccess ? (
        <button
          className={PCV2_SECONDARY_BUTTON}
          onClick={onRequestAccess}
          type="button"
        >
          Solicitar acesso
        </button>
      ) : null}
    </section>
  )
}

export interface SecurityGateView {
  readonly gate: string
  readonly severity: 'P0' | 'P1' | 'P2' | 'P3'
  readonly evidence: string
  readonly fix: string
  readonly passed: boolean
}

export function ProjectCenterV2BlockedState({
  gates,
  onFixFirst,
}: {
  readonly gates: ReadonlyArray<SecurityGateView>
  readonly onFixFirst?: (gate: SecurityGateView) => void
}) {
  const blockers = gates.filter(
    (gate) =>
      !gate.passed && (gate.severity === 'P0' || gate.severity === 'P1'),
  )
  if (blockers.length === 0) return null
  return (
    <section
      className={cn(PCV2_CARD, 'space-y-3 border-amber-500/40 bg-amber-500/5')}
      data-testid="pcv2-blocked"
      role="alert"
    >
      <h2 className="text-lg font-semibold text-amber-200">
        {blockers.length} gate(s) bloqueando o avanço
      </h2>
      <ul className="space-y-2">
        {blockers.map((gate) => (
          <li
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
            key={`${gate.severity}-${gate.gate}`}
          >
            <p className="font-semibold">
              {gate.severity} · {sanitizeForDisplay(gate.gate)}
            </p>
            <p className="mt-1 text-xs">{sanitizeForDisplay(gate.evidence)}</p>
            <p className="mt-1 text-xs">
              Correção: {sanitizeForDisplay(gate.fix)}
            </p>
          </li>
        ))}
      </ul>
      {onFixFirst ? (
        <button
          className={PCV2_SECONDARY_BUTTON}
          onClick={() => {
            onFixFirst(blockers[0])
          }}
          type="button"
        >
          Corrigir bloqueios
        </button>
      ) : null}
    </section>
  )
}

export function ProjectCenterV2StaleState({
  snapshotAt,
  onRetry,
}: {
  readonly snapshotAt: string
  readonly onRetry?: () => void
}) {
  return (
    <section
      aria-live="polite"
      className={cn(PCV2_PANEL, 'space-y-2 border-amber-500/40')}
      data-testid="pcv2-stale"
    >
      <h2 className="text-sm font-semibold text-amber-200">
        Último snapshot conhecido ({safeText(snapshotAt)})
      </h2>
      <p className={cn('text-xs', PCV2_MUTED)}>
        Sem contato com o control plane: as ações estão desabilitadas até uma
        nova medição. Não trate o cache como estado atual.
      </p>
      {onRetry ? (
        <button
          className={PCV2_SECONDARY_BUTTON}
          onClick={onRetry}
          type="button"
        >
          Tentar novamente
        </button>
      ) : null}
    </section>
  )
}
