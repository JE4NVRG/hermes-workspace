/**
 * Visão de operação do Project Center v2 (PR 5).
 *
 * Mostra o estado **persistido** da operação (recuperável por `operation_id`
 * após reload): timeline por etapa, evidências de verificação, artefatos
 * sanitizados, falha segura e trilha de auditoria. Nada aqui declara sucesso
 * otimista: o sucesso só aparece com as verificações obrigatórias persistidas.
 */
import { HugeiconsIcon } from '@hugeicons/react'
import { Refresh01Icon, Shield01Icon } from '@hugeicons/core-free-icons'
import { useEffect, useState } from 'react'
import {
  PCV2_CARD,
  PCV2_HEADING,
  PCV2_MUTED,
  PCV2_PANEL,
  PCV2_SECONDARY_BUTTON,
  ProjectCenterV2DeniedState,
  ProjectCenterV2ErrorState,
  ProjectCenterV2LoadingState,
  ProjectCenterV2StaleState,
} from './project-center-v2-gate'
import type { ProjectCenterV2Client } from '@/lib/project-center-v2-api'
import type {
  ArtifactRef,
  AuditEvent,
  Operation,
  Verification,
} from '@/lib/project-center-v2-types'
import {
  describeOperationState,
  isTerminalOperationState,
  maskOpaqueIdentifier,
  operationStateLabel,
  projectArtifactForDisplay,
  projectTimeline,
  safeText,
  sanitizeForDisplay,
} from '@/lib/project-center-v2-types'
import { useProjectCenterV2Operation } from '@/hooks/use-project-center-v2'
import { cn } from '@/lib/utils'

const OUTCOME_GLYPHS: Readonly<Record<string, string>> = {
  passed: '✓',
  failed: '✕',
  skipped: '○',
  inconclusive: '?',
}

/** Timeline por etapa: texto + ícone, com anúncio só na mudança de estado. */
export function ProjectCenterV2Timeline({
  operation,
  reducedMotion = false,
}: {
  readonly operation: Operation
  readonly reducedMotion?: boolean
}) {
  const steps = projectTimeline({
    latestDetail: operation.failure?.message ?? null,
    state: operation.state,
  })
  const label = operationStateLabel(operation.state)
  const [announcement, setAnnouncement] = useState(label)

  useEffect(() => {
    setAnnouncement(`Estado atual: ${label}`)
  }, [label, operation.updated_at])

  return (
    <section className={cn(PCV2_CARD, 'space-y-3')} data-testid="pcv2-timeline">
      <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
        Timeline da operação
      </h2>
      <p
        aria-live="polite"
        className={cn('text-xs', PCV2_MUTED)}
        data-testid="pcv2-timeline-announcement"
        role="status"
      >
        {announcement}
      </p>
      <ol className="space-y-2">
        {steps.map((step) => (
          <li
            className={cn(
              PCV2_PANEL,
              'flex items-start gap-3 text-sm',
              step.outcome === 'failed' && 'border-red-500/40',
              step.outcome === 'active' && !reducedMotion && 'animate-pulse',
            )}
            data-outcome={step.outcome}
            key={step.label}
          >
            <span aria-hidden="true" className="font-mono text-primary-500">
              {glyphFor(step.outcome)}
            </span>
            <span className="flex-1">
              <span className={PCV2_HEADING}>{step.label}</span>
              <span className={cn('ml-2 text-xs uppercase', PCV2_MUTED)}>
                {step.outcome === 'done'
                  ? 'concluído'
                  : step.outcome === 'active'
                    ? 'em execução'
                    : step.outcome === 'failed'
                      ? 'falhou'
                      : 'não iniciado'}
              </span>
              {step.detail ? (
                <span className="mt-1 block text-xs text-amber-200">
                  {step.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function glyphFor(outcome: string): string {
  if (outcome === 'done') return '✓'
  if (outcome === 'failed') return '✕'
  if (outcome === 'active') return '◐'
  return '○'
}

export function ProjectCenterV2EvidenceList({
  verification,
}: {
  readonly verification: Verification | null | undefined
}) {
  if (verification === null || verification === undefined) {
    return (
      <section
        className={cn(PCV2_PANEL, 'text-sm')}
        data-testid="pcv2-evidence"
      >
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Verificação
        </h3>
        <p className={cn('mt-1 text-xs', PCV2_MUTED)}>
          Nenhuma verificação persistida. “Concluído” exige todos os checks
          obrigatórios.
        </p>
      </section>
    )
  }
  return (
    <section
      className={cn(PCV2_PANEL, 'space-y-2')}
      data-testid="pcv2-evidence"
    >
      <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
        Verificação · {safeText(verification.outcome)}
      </h3>
      <ul className="space-y-1 text-xs">
        {verification.checks.map((check) => (
          <li className="flex items-start gap-2" key={check.name}>
            <span aria-hidden="true" className="font-mono">
              {OUTCOME_GLYPHS[check.outcome] ?? '?'}
            </span>
            <span className={PCV2_HEADING}>{safeText(check.name)}</span>
            <span className={PCV2_MUTED}>{check.outcome}</span>
            {check.safe_detail ? (
              <span className={PCV2_MUTED}>
                · {sanitizeForDisplay(check.safe_detail)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className={cn('text-xs', PCV2_MUTED)}>
        Observado em {safeText(verification.observed_at)}
      </p>
    </section>
  )
}

export function ProjectCenterV2ArtifactList({
  artifacts,
}: {
  readonly artifacts: ReadonlyArray<ArtifactRef>
}) {
  if (artifacts.length === 0) return null
  return (
    <section
      className={cn(PCV2_PANEL, 'space-y-2')}
      data-testid="pcv2-artifacts"
    >
      <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
        Artefatos sanitizados
      </h3>
      <ul className="space-y-1 text-xs">
        {artifacts.map((artifact) => {
          const projected = projectArtifactForDisplay(artifact)
          return (
            <li
              className="flex flex-wrap items-center gap-2"
              key={`${artifact.type}-${projected.ref}`}
            >
              <span className={PCV2_HEADING}>{projected.label}</span>
              <span className="font-mono text-primary-500">
                {projected.ref}
              </span>
              <span className={PCV2_MUTED}>{projected.status}</span>
              {projected.masked ? (
                <span className={PCV2_MUTED}>
                  · valor integral nunca é renderizado, copiado ou exportado
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function ProjectCenterV2AuditTrail({
  events,
}: {
  readonly events: ReadonlyArray<AuditEvent>
}) {
  if (events.length === 0) {
    return (
      <section className={cn(PCV2_PANEL, 'text-sm')} data-testid="pcv2-audit">
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Trilha de auditoria
        </h3>
        <p className={cn('mt-1 text-xs', PCV2_MUTED)}>
          Nenhum evento visível para o seu ator.
        </p>
      </section>
    )
  }
  return (
    <section className={cn(PCV2_PANEL, 'space-y-2')} data-testid="pcv2-audit">
      <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
        Trilha de auditoria
      </h3>
      <ol className="space-y-1 text-xs">
        {events.map((event) => (
          <li
            className="flex flex-wrap items-center gap-2"
            key={event.event_id}
          >
            <span className="font-mono text-primary-500">
              #{event.sequence}
            </span>
            <span className={PCV2_HEADING}>{safeText(event.type)}</span>
            <span className={PCV2_MUTED}>{safeText(event.actor_ref)}</span>
            <span className={PCV2_MUTED}>
              {event.from_state ? operationStateLabel(event.from_state) : '—'} →{' '}
              {event.to_state ? operationStateLabel(event.to_state) : '—'}
            </span>
            <span className={PCV2_MUTED}>{safeText(event.occurred_at)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export interface ProjectCenterV2OperationViewProps {
  readonly operationId: string
  readonly client?: ProjectCenterV2Client
  readonly reducedMotion?: boolean
  readonly onStartRecovery?: (operation: Operation) => void
  readonly onLeaveInBackground?: () => void
  readonly denied?: boolean
}

export function ProjectCenterV2OperationView({
  operationId,
  client,
  reducedMotion = false,
  onStartRecovery,
  onLeaveInBackground,
  denied = false,
}: ProjectCenterV2OperationViewProps) {
  const { operation, error, isLoading, refetch } = useProjectCenterV2Operation(
    operationId,
    client,
  )

  if (isLoading && operation === null) return <ProjectCenterV2LoadingState />
  if (error !== null && operation === null) {
    return (
      <ProjectCenterV2ErrorState
        error={error}
        onRetry={refetch}
        operationId={operationId}
      />
    )
  }
  if (operation === null) {
    return (
      <ProjectCenterV2StaleState onRetry={refetch} snapshotAt="desconhecido" />
    )
  }
  if (denied) {
    return (
      <ProjectCenterV2DeniedState
        requiredRole="project_operator"
        requiredScope="project:execute"
      />
    )
  }

  const described = describeOperationState(operation.state)
  const canRecover =
    operation.state === 'failed' &&
    operation.failure?.retryable !== false &&
    isTerminalOperationState(operation.state) === false

  return (
    <section
      aria-labelledby="pcv2-operation-heading"
      className="space-y-4"
      data-testid="pcv2-operation"
    >
      <header className={cn(PCV2_CARD, 'space-y-2')}>
        <p className={cn('text-xs uppercase tracking-[0.16em]', PCV2_MUTED)}>
          Operação {maskOpaqueIdentifier(operation.operation_id, 4)}
        </p>
        <h2
          className={cn('text-xl font-semibold', PCV2_HEADING)}
          id="pcv2-operation-heading"
        >
          {described.label}
        </h2>
        <p className={cn('text-sm', PCV2_MUTED)}>{described.nextAction}</p>
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <dt className={PCV2_MUTED}>Projeto</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {safeText(operation.project_id)}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>Ambiente · driver</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {safeText(operation.environment)} · {safeText(operation.driver)}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>Revisão otimista</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {operation.operation_version}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            className={PCV2_SECONDARY_BUTTON}
            onClick={refetch}
            type="button"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={16} strokeWidth={1.6} />
            Atualizar estado
          </button>
          {onStartRecovery ? (
            <button
              className={PCV2_SECONDARY_BUTTON}
              disabled={!canRecover}
              onClick={() => {
                onStartRecovery(operation)
              }}
              type="button"
            >
              <HugeiconsIcon icon={Shield01Icon} size={16} strokeWidth={1.6} />
              Reconciliar operação
            </button>
          ) : null}
          {onLeaveInBackground ? (
            <button
              className={PCV2_SECONDARY_BUTTON}
              onClick={onLeaveInBackground}
              type="button"
            >
              Sair e continuar em segundo plano
            </button>
          ) : null}
        </div>
      </header>

      {operation.failure ? (
        <section
          className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
          data-testid="pcv2-failure"
          role="alert"
        >
          <h3 className="font-semibold">Falha registrada pelo control plane</h3>
          <p className="mt-1 text-xs">
            {sanitizeForDisplay(operation.failure.message)}
          </p>
          <p className="mt-1 text-xs">
            Código {operation.failure.code} · retry{' '}
            {operation.failure.retryable ? 'permitido' : 'bloqueado'} ·
            fingerprint {sanitizeForDisplay(operation.failure.fingerprint)}
          </p>
        </section>
      ) : null}

      <ProjectCenterV2Timeline
        operation={operation}
        reducedMotion={reducedMotion}
      />
      <ProjectCenterV2EvidenceList verification={operation.verification} />
      <ProjectCenterV2ArtifactList artifacts={operation.artifacts ?? []} />
    </section>
  )
}
