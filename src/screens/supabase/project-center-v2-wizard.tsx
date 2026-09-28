/**
 * Wizard de provisionamento seguro do Project Center v2 (PR 5).
 *
 * Implementa as oito etapas persistentes de `docs/design/project-center-v2-ux.md`
 * (Contexto, Recursos, Dry-run, Segurança, Aprovação, Execução, Verificação,
 * Rollback) atrás da flag server-projected, com:
 *
 * - labels mapeados **apenas** aos 15 estados canônicos (nenhum alias de
 *   domínio: `não iniciado`, `bloqueado`, `atual` e afins são estados de
 *   apresentação do stepper);
 * - acessibilidade WCAG 2.1/2.2 AA: stepper como lista ordenada com
 *   `aria-current="step"`, foco no `h1` ao avançar, foco no resumo de erros no
 *   primeiro erro, labels/`aria-describedby` estáveis, live region da timeline,
 *   `role="alert"` só quando o bloqueio surge, alvos ≥ 44 × 44 px e
 *   `prefers-reduced-motion`;
 * - mascaramento neutro de credenciais e ausência de path absoluto ou
 *   credencial em DOM, clipboard e toast;
 * - ações irreversíveis exigindo confirmação tipada e aprovação válida, com a
 *   permissão sempre decidida pelo servidor (a UI nunca infere acesso por
 *   esconder botão).
 */
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Alert02Icon,
  Cancel01Icon,
  DatabaseAddIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PCV2_CARD,
  PCV2_DESTRUCTIVE_BUTTON,
  PCV2_FIELD_INPUT,
  PCV2_HEADING,
  PCV2_LABEL,
  PCV2_MUTED,
  PCV2_PANEL,
  PCV2_PRIMARY_BUTTON,
  PCV2_SECONDARY_BUTTON,
  ProjectCenterV2BlockedState,
  ProjectCenterV2DeniedState,
} from './project-center-v2-gate'
import {
  ProjectCenterV2ArtifactList,
  ProjectCenterV2EvidenceList,
  ProjectCenterV2OperationView,
} from './project-center-v2-operation'
import type { SecurityGateView } from './project-center-v2-gate'
import type {
  OperationCallResult,
  ProjectCenterV2Client,
} from '@/lib/project-center-v2-api'
import type {
  Capability,
  DiffItem,
  Driver,
  Environment,
  Operation,
  StepPresentationState,
  Verification,
  WizardStepId,
} from '@/lib/project-center-v2-types'
import {
  ProjectCenterV2ApiError,
  ProjectCenterV2InputError,
  assertFreeText,
  assertNoOpaqueReference,
  assertPublicIntent,
} from '@/lib/project-center-v2-api'
import {
  AWAITING_APPROVAL_COPY,
  CAPABILITY_OPTIONS,
  CREDENTIAL_INTENT_COPY,
  DIFF_DOMAIN_LABELS,
  DIFF_OUTCOME_LABELS,
  EMPTY_CAPABILITIES,
  ENVIRONMENTS,
  EXPECTED_RELATIVE_PATHS,
  INFRASTRUCTURE_MODES,
  LEGACY_BLOCKED_CARD_COPY,
  LEGACY_BLOCKED_COPY,
  PARTIAL_FAILURE_COPY,
  SUPABASE_COST_COPY,
  TELEMETRY_UNAVAILABLE_COPY,
  WIZARD_STEPS,
  approvalPhrase,
  deriveProjectNames,
  destructionPhrase,
  executionCtaLabel,
  maskIdempotencyKey,
  maskOpaqueIdentifier,
  maskSecretRef,
  operationStateLabel,
  projectArtifactForDisplay,
  projectDiff,
  provisioningPhrase,
  recommendMode,
  rollbackApprovalPhrase,
  sanitizeForDisplay,
  toContractCapabilities,
  wizardStep,
} from '@/lib/project-center-v2-types'
import { writeTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/components/ui/toast'
import {
  usePrefersReducedMotion,
  useProjectCenterV2Action,
} from '@/hooks/use-project-center-v2'
import { cn } from '@/lib/utils'

type ContextDraft = {
  readonly clientId: string
  readonly projectSlug: string
  readonly displayName: string
  readonly description: string
  readonly repositoryId: string
  readonly environment: Environment
  readonly owner: string
  readonly sensitivity: 'low' | 'medium' | 'high' | 'critical'
}

const EMPTY_CONTEXT: ContextDraft = {
  clientId: 'je4ndev',
  description: '',
  displayName: '',
  environment: 'development',
  owner: '',
  projectSlug: '',
  repositoryId: '',
  sensitivity: 'medium',
}

interface FieldError {
  readonly field: string
  readonly message: string
}

export interface ProjectCenterV2WizardProps {
  readonly client?: ProjectCenterV2Client
  readonly reducedMotion?: boolean
  readonly onLeaveInBackground?: () => void
}

function stepStateFor(input: {
  readonly step: WizardStepId
  readonly current: WizardStepId
  readonly blocked: boolean
  readonly running: boolean
  readonly failed: boolean
  readonly valid: boolean
}): StepPresentationState {
  const currentIndex = wizardStep(input.current).index
  const index = wizardStep(input.step).index
  if (index === currentIndex) {
    if (input.blocked) return 'blocked'
    if (input.running) return 'running'
    if (input.failed) return 'recoverable'
    return 'current'
  }
  if (index < currentIndex) return input.failed ? 'failed' : 'done'
  return input.valid ? 'valid' : 'not_started'
}

const STEP_STATE_TEXT: Readonly<Record<StepPresentationState, string>> = {
  not_started: 'Não iniciado',
  current: 'Atual',
  valid: 'Válido',
  blocked: 'Bloqueado',
  running: 'Em execução',
  failed: 'Falhou',
  recoverable: 'Recuperável',
  done: 'Concluído',
}

export function ProjectCenterV2Wizard({
  client,
  reducedMotion,
  onLeaveInBackground,
}: ProjectCenterV2WizardProps) {
  const prefersReduced = usePrefersReducedMotion()
  const reduced = reducedMotion ?? prefersReduced
  const action = useProjectCenterV2Action(client)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorSummaryRef = useRef<HTMLDivElement>(null)

  const [step, setStep] = useState<WizardStepId>('context')
  const [context, setContext] = useState<ContextDraft>(EMPTY_CONTEXT)
  const [capabilities, setCapabilities] = useState<Capability>({
    ...EMPTY_CAPABILITIES,
    backup_isolation: true,
    database: true,
  })
  const [modeOverride, setModeOverride] = useState<Driver | null>(null)
  const [supabaseReason, setSupabaseReason] = useState('')
  const [costAcknowledged, setCostAcknowledged] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [errors, setErrors] = useState<ReadonlyArray<FieldError>>([])
  const [actionError, setActionError] = useState<unknown>(null)
  const [denied, setDenied] = useState(false)
  const [approvePhraseValue, setApprovePhraseValue] = useState('')
  const [approveReason, setApproveReason] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [executePhraseValue, setExecutePhraseValue] = useState('')
  const [executeReviewed, setExecuteReviewed] = useState(false)
  const [rollbackReason, setRollbackReason] = useState('')
  const [preserveData, setPreserveData] = useState(true)
  const [destructivePhraseValue, setDestructivePhraseValue] = useState('')
  const [destructiveReason, setDestructiveReason] = useState('')

  const mode: Driver = modeOverride ?? recommendMode(capabilities)
  const names = useMemo(
    () =>
      deriveProjectNames({
        clientId: context.clientId,
        projectSlug: context.projectSlug,
      }),
    [context.clientId, context.projectSlug],
  )
  const plan = operation?.plan ?? null
  const artifacts = operation?.artifacts ?? []
  const diff = useMemo(
    () => (plan === null ? [] : projectDiff(plan, artifacts)),
    [plan, artifacts],
  )
  const estimated = plan?.estimated_resources ?? null
  const telemetryAvailable =
    estimated?.memory_mb !== undefined ||
    estimated?.cpu_millicores !== undefined

  const securityGates: ReadonlyArray<SecurityGateView> = useMemo(() => {
    const gates: Array<SecurityGateView> = [
      {
        evidence: plan
          ? `Plano ${maskOpaqueIdentifier(operation?.plan_hash ?? '', 4)} com ${plan.actions.length} ação(ões).`
          : 'Dry-run ainda não executado.',
        fix: 'Gerar dry-run válido antes de aprovar.',
        gate: 'dry-run válido antes da aprovação',
        passed: plan !== null && operation?.state !== 'expired',
        severity: 'P1',
      },
      {
        evidence: telemetryAvailable
          ? 'Estimativa de RAM/CPU presente no plano.'
          : 'Host sem medição atual disponível.',
        fix: 'Restabelecer telemetria ou escolher PostgreSQL isolado.',
        gate: 'telemetria/capacidade do host',
        passed: !(mode === 'supabase_isolated' && !telemetryAvailable),
        severity: 'P1',
      },
      {
        evidence: mode === 'supabase_isolated' ? supabaseReason : 'modo padrão',
        fix: 'Justificar por que a stack modular não atende ou voltar ao padrão.',
        gate: 'justificativa de capacidades para stack completa',
        passed:
          mode !== 'supabase_isolated' || supabaseReason.trim().length >= 10,
        severity: 'P1',
      },
      {
        evidence: 'Nenhum path absoluto, credencial ou token entra na UI.',
        fix: 'Remover qualquer valor sensível do contexto.',
        gate: 'segredos fora de prompt, payload e log',
        passed: errors.length === 0,
        severity: 'P0',
      },
    ]
    for (const warning of plan?.warnings ?? []) {
      gates.push({
        evidence: sanitizeForDisplay(warning),
        fix: 'Corrigir o conflito observado e gerar novo dry-run.',
        gate: 'conflito observado no dry-run',
        passed: false,
        severity: 'P1',
      })
    }
    return gates
  }, [errors.length, mode, operation, plan, supabaseReason, telemetryAvailable])

  const blockers = securityGates.filter(
    (gate) =>
      !gate.passed && (gate.severity === 'P0' || gate.severity === 'P1'),
  )
  const canRequestApproval =
    plan !== null &&
    blockers.length === 0 &&
    (mode !== 'supabase_isolated' ||
      (supabaseReason.trim().length >= 10 && costAcknowledged))

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (errors.length === 0) return
    errorSummaryRef.current?.focus()
  }, [errors])

  function reportFailure(error: unknown) {
    setDenied(
      error instanceof ProjectCenterV2ApiError && error.code === 'FORBIDDEN',
    )
    setActionError(error)
    const message =
      error instanceof ProjectCenterV2ApiError
        ? sanitizeForDisplay(error.message)
        : error instanceof Error
          ? sanitizeForDisplay(error.message)
          : 'Falha sem detalhe tipado'
    toast(message, { type: 'error' })
  }

  /**
   * Aplica o estado canônico devolvido pelo servidor. `advance: false` mantém a
   * etapa atual para que a etapa conduzida (ex.: dry-run) renderize o resumo do
   * plano e o usuário avance pelo CTA — sem pular a revisão de segurança.
   */
  function applyResult(
    result: OperationCallResult,
    options: { readonly advance?: boolean } = {},
  ) {
    const { advance = true } = options
    setActionError(null)
    setDenied(false)
    setOperation(result.operation)
    if (advance) setStep(wizardStepState(result.operation))
  }

  function wizardStepState(next: Operation): WizardStepId {
    if (next.state === 'succeeded' || next.state === 'verifying') {
      return 'verification'
    }
    if (
      next.state === 'rollback_pending' ||
      next.state === 'rolling_back' ||
      next.state === 'rolled_back' ||
      next.state === 'manual_intervention_required'
    ) {
      return 'rollback'
    }
    if (
      next.state === 'queued' ||
      next.state === 'executing' ||
      next.state === 'cancelled'
    ) {
      return 'execution'
    }
    if (
      next.state === 'awaiting_approval' ||
      next.state === 'rejected' ||
      next.state === 'expired'
    ) {
      return 'approval'
    }
    if (next.state === 'approved') return 'execution'
    return 'dry_run'
  }

  function validateContext(): boolean {
    const found: Array<FieldError> = []
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(context.clientId)) {
      found.push({
        field: 'pcv2-client-id',
        message: 'Cliente deve usar letras minúsculas, dígitos e hífen (2–24).',
      })
    }
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(context.projectSlug)) {
      found.push({
        field: 'pcv2-project-slug',
        message:
          'Slug inválido: use letras minúsculas, dígitos e hífen (2–24).',
      })
    }
    if (context.displayName.trim().length < 3) {
      found.push({
        field: 'pcv2-display-name',
        message: 'Nome do projeto exige ao menos 3 caracteres.',
      })
    }
    if (context.owner.trim().length < 3) {
      found.push({
        field: 'pcv2-owner',
        message: 'Informe o proprietário operacional.',
      })
    }
    for (const [field, value] of [
      ['pcv2-description', context.description],
      ['pcv2-owner', context.owner],
      ['pcv2-display-name', context.displayName],
      ['pcv2-repository', context.repositoryId],
    ] as ReadonlyArray<readonly [string, string]>) {
      if (/sref_/.test(value)) {
        found.push({
          field,
          message: 'Referência opaca é emitida apenas pelo broker no servidor.',
        })
      }
    }
    setErrors(found)
    if (found.length > 0) {
      toast('Revise os campos destacados antes de continuar.', {
        type: 'warning',
      })
      return false
    }
    return true
  }

  async function runDryRun() {
    try {
      const intent = assertPublicIntent({
        capabilities: toContractCapabilities(capabilities),
        client_id: context.clientId,
        description:
          context.description === '' ? undefined : context.description,
        display_name: context.displayName,
        driver: mode,
        environment: context.environment,
        project_slug: context.projectSlug,
        ...(context.repositoryId === ''
          ? {}
          : { repository: { registry_id: context.repositoryId } }),
      })
      const result = await action.run({
        kind: 'dryRun',
        request: {
          intent,
          reason:
            mode === 'supabase_isolated'
              ? assertFreeText(supabaseReason, 'reason', { max: 500, min: 3 })
              : undefined,
        },
      })
      applyResult(result, { advance: false })
      toast('Dry-run concluído sem side effects.', { type: 'success' })
    } catch (error) {
      if (error instanceof ProjectCenterV2InputError) {
        setErrors([
          { field: error.field, message: sanitizeForDisplay(error.message) },
        ])
        toast(sanitizeForDisplay(error.message), { type: 'error' })
        return
      }
      reportFailure(error)
    }
  }

  async function decide(input: { readonly decision: 'approve' | 'reject' }) {
    if (operation === null) return
    try {
      const request =
        input.decision === 'approve'
          ? {
              confirmation: approvePhraseValue,
              decision: 'approve' as const,
              plan_hash: operation.plan_hash,
              ...(approveReason.trim() === ''
                ? {}
                : {
                    reason: assertFreeText(approveReason, 'reason', {
                      max: 500,
                      min: 3,
                    }),
                  }),
            }
          : {
              decision: 'reject' as const,
              reason: assertFreeText(rejectReason, 'reason', {
                max: 500,
                min: 3,
              }),
            }
      const result = await action.run({
        kind: 'approve',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
        request,
      })
      applyResult(result)
      toast(
        input.decision === 'approve'
          ? 'Decisão registrada: aprovação vinculada ao hash do plano.'
          : 'Decisão registrada: plano rejeitado com motivo.',
        { type: 'success' },
      )
    } catch (error) {
      if (error instanceof ProjectCenterV2InputError) {
        toast(sanitizeForDisplay(error.message), { type: 'error' })
        return
      }
      reportFailure(error)
    }
  }

  async function execute() {
    if (operation === null) return
    try {
      const result = await action.run({
        kind: 'execute',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
        planHash: operation.plan_hash,
      })
      applyResult(result)
      toast('Execução enfileirada. Acompanhe pela timeline.', {
        type: 'success',
      })
    } catch (error) {
      reportFailure(error)
    }
  }

  async function verify() {
    if (operation === null) return
    try {
      const result = await action.run({
        kind: 'verify',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
      })
      applyResult(result)
      toast('Verificação enfileirada (read-only).', { type: 'success' })
    } catch (error) {
      reportFailure(error)
    }
  }

  async function rollbackDryRun() {
    if (operation === null) return
    try {
      const reason = assertFreeText(rollbackReason, 'reason', {
        max: 500,
        min: 10,
      })
      const result = await action.run({
        kind: 'rollbackDryRun',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
        request: { preserve_data: preserveData, reason },
      })
      applyResult(result)
      toast('Plano de rollback criado sem side effects.', { type: 'success' })
    } catch (error) {
      if (error instanceof ProjectCenterV2InputError) {
        toast(sanitizeForDisplay(error.message), { type: 'error' })
        return
      }
      reportFailure(error)
    }
  }

  async function rollbackDecide(decision: 'approve' | 'reject') {
    if (operation?.rollback === null || operation?.rollback === undefined)
      return
    try {
      const rollbackPlan = operation.rollback
      const request =
        decision === 'approve'
          ? {
              confirmation: rollbackApprovalPhrase(
                operation.project_id,
                rollbackPlan.rollback_plan_hash,
              ),
              decision: 'approve' as const,
              rollback_plan_hash: rollbackPlan.rollback_plan_hash,
            }
          : {
              decision: 'reject' as const,
              reason: assertFreeText(destructiveReason, 'reason', {
                max: 500,
                min: 3,
              }),
            }
      const result = await action.run({
        kind: 'rollbackApprove',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
        request,
      })
      applyResult(result)
      toast('Decisão de rollback registrada.', { type: 'success' })
    } catch (error) {
      if (error instanceof ProjectCenterV2InputError) {
        toast(sanitizeForDisplay(error.message), { type: 'error' })
        return
      }
      reportFailure(error)
    }
  }

  async function rollbackExecute() {
    if (operation?.rollback === null || operation?.rollback === undefined)
      return
    try {
      const approval = operation.rollback.approval
      assertNoOpaqueReference(destructivePhraseValue, 'confirmation')
      assertFreeText(destructiveReason, 'reason', { max: 500, min: 3 })
      const result = await action.run({
        kind: 'rollbackExecute',
        operationId: operation.operation_id,
        operationVersion: operation.operation_version,
        request: {
          approval_id: approval?.approval_id ?? '',
          rollback_plan_hash: operation.rollback.rollback_plan_hash,
        },
      })
      applyResult(result)
      toast('Compensação enfileirada com aprovação própria.', {
        type: 'success',
      })
    } catch (error) {
      if (error instanceof ProjectCenterV2InputError) {
        toast(sanitizeForDisplay(error.message), { type: 'error' })
        return
      }
      reportFailure(error)
    }
  }

  async function copySanitizedPlan() {
    if (operation === null || plan === null) return
    const lines = [
      `Plano sanitizado — ${operation.project_id}`,
      `operacao: ${maskOpaqueIdentifier(operation.operation_id, 4)}`,
      `hash do plano: ${maskOpaqueIdentifier(operation.plan_hash, 4)}`,
      `driver: ${operation.driver} · ambiente: ${operation.environment}`,
      `politica: ${plan.policy_version} · expira em: ${operation.expires_at}`,
      `acoes:`,
      ...diff.map(
        (item) =>
          `- ${item.label} [${DIFF_OUTCOME_LABELS[item.outcome]}] risco=${item.risk} reversivel=${String(item.reversible)}`,
      ),
      `aviso: nenhum segredo, path absoluto ou referencia integral esta incluido.`,
    ]
    try {
      await writeTextToClipboard(sanitizeForDisplay(lines.join('\n')))
      toast(`Plano sanitizado de ${operation.project_id} copiado`, {
        type: 'success',
      })
    } catch (error) {
      toast(
        error instanceof Error
          ? sanitizeForDisplay(error.message)
          : 'Falha ao copiar plano',
        { type: 'error' },
      )
    }
  }

  const approvalNeeded = operation?.state === 'awaiting_approval'
  const executePhrase =
    operation === null
      ? ''
      : provisioningPhrase(operation.project_id, operation.environment)
  const executeReady =
    executePhraseValue === executePhrase &&
    executeReviewed &&
    operation?.state === 'approved'

  return (
    <section
      aria-labelledby="pcv2-wizard-heading"
      className="space-y-4"
      data-reduced-motion={reduced ? 'true' : 'false'}
      data-testid="pcv2-wizard"
    >
      <Stepper current={step} blocked={blockers.length > 0} />

      <div className={cn(PCV2_CARD, 'space-y-4')}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className={cn('text-xs uppercase tracking-[0.18em]', PCV2_MUTED)}
            >
              Project Center v2 · provisionamento isolado
            </p>
            <h1
              className={cn('mt-1 text-2xl font-semibold', PCV2_HEADING)}
              id="pcv2-wizard-heading"
              ref={headingRef}
              tabIndex={-1}
            >
              {wizardStep(step).heading}
            </h1>
          </div>
          {operation ? (
            <p
              aria-live="polite"
              className={cn('text-right text-xs', PCV2_MUTED)}
              data-testid="pcv2-wizard-state"
              role="status"
            >
              {operationStateLabel(operation.state)}
            </p>
          ) : null}
        </div>

        {actionError !== null ? (
          <ProjectCenterV2ErrorPanel
            error={actionError}
            onRetry={() => {
              setActionError(null)
            }}
            operationId={operation?.operation_id ?? null}
          />
        ) : null}

        {denied ? (
          <ProjectCenterV2DeniedState
            requiredRole="project_approver"
            requiredScope="project:approve"
          />
        ) : null}

        {errors.length > 0 ? (
          <div
            className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100"
            data-testid="pcv2-error-summary"
            ref={errorSummaryRef}
            role="alert"
            tabIndex={-1}
          >
            <h2 className="font-semibold">
              {errors.length} erro(s) impedem o avanço
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  <a className="underline" href={`#${error.field}`}>
                    {sanitizeForDisplay(error.message)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === 'context' ? (
          <ContextStep
            context={context}
            names={names}
            onChange={setContext}
            idempotencyKey={client?.idempotencyKeyFor('dry-run') ?? null}
            errors={errors}
          />
        ) : null}

        {step === 'resources' ? (
          <ResourcesStep
            capabilities={capabilities}
            costAcknowledged={costAcknowledged}
            mode={mode}
            onCapabilities={setCapabilities}
            onCostAcknowledged={setCostAcknowledged}
            onMode={setModeOverride}
            onReason={setSupabaseReason}
            reason={supabaseReason}
            telemetryAvailable={telemetryAvailable}
          />
        ) : null}

        {step === 'dry_run' ? (
          <DryRunStep
            artifacts={artifacts}
            diff={diff}
            estimated={estimated}
            idempotencyKey={client?.idempotencyKeyFor('dry-run') ?? null}
            isPending={action.isPending}
            onCopy={() => void copySanitizedPlan()}
            onGenerate={() => void runDryRun()}
            operation={operation}
          />
        ) : null}

        {step === 'security' ? (
          <section className="space-y-3">
            <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
              Gates de segurança do plano
            </h2>
            <ul className="space-y-2" data-testid="pcv2-security-gates">
              {securityGates.map((gate) => (
                <li
                  className={cn(
                    PCV2_PANEL,
                    'text-sm',
                    gate.passed
                      ? 'border-emerald-500/30'
                      : 'border-amber-500/40',
                  )}
                  data-passed={gate.passed ? 'true' : 'false'}
                  key={`${gate.severity}-${gate.gate}`}
                >
                  <p className={PCV2_HEADING}>
                    {gate.passed ? '✓' : '⨯'} {gate.severity} · {gate.gate}
                  </p>
                  <p className={cn('mt-1 text-xs', PCV2_MUTED)}>
                    Evidência: {gate.evidence}
                  </p>
                  <p className={cn('mt-1 text-xs', PCV2_MUTED)}>
                    Correção: {gate.fix}
                  </p>
                </li>
              ))}
            </ul>
            <ProjectCenterV2BlockedState
              gates={securityGates}
              onFixFirst={(gate) => {
                toast(`Corrija o gate ${gate.gate} e gere novo dry-run.`, {
                  type: 'warning',
                })
                setStep(mode === 'supabase_isolated' ? 'resources' : 'dry_run')
              }}
            />
          </section>
        ) : null}

        {step === 'approval' ? (
          <ApprovalStep
            actionError={actionError}
            approvePhrase={approvePhraseValue}
            approveReason={approveReason}
            canRequest={canRequestApproval}
            isPending={action.isPending}
            onApprovePhrase={setApprovePhraseValue}
            onApproveReason={setApproveReason}
            onDecide={(decision) => void decide({ decision })}
            onRejectReason={setRejectReason}
            operation={operation}
            rejectReason={rejectReason}
            requiredPhrase={
              operation === null
                ? ''
                : approvalPhrase(operation.project_id, operation.plan_hash)
            }
          />
        ) : null}

        {step === 'execution' ? (
          <section className="space-y-3">
            <div className={cn(PCV2_PANEL, 'space-y-2')}>
              <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
                Execução em background
              </h2>
              <p className={cn('text-sm', PCV2_MUTED)}>
                A execução não roda no request web. O job é durável e
                recuperável pelo identificador da operação.
              </p>
            </div>
            {operation === null ? (
              <p className={cn('text-sm', PCV2_MUTED)}>
                Nenhuma operação persistida ainda.
              </p>
            ) : operation.state === 'approved' ||
              operation.state === 'failed' ? (
              <div className={cn(PCV2_PANEL, 'space-y-3')}>
                <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
                  Confirmação forte
                </h3>
                <p className={cn('text-xs', PCV2_MUTED)}>
                  Digite exatamente{' '}
                  <span className="font-mono">{executePhrase}</span>. O texto é
                  case-sensitive.
                </p>
                <p className={cn('text-xs', PCV2_MUTED)}>
                  Projeto {operation.project_id} · ambiente{' '}
                  {operation.environment}
                </p>
                <div>
                  <label className={PCV2_LABEL} htmlFor="pcv2-execute-phrase">
                    Frase de confirmação
                  </label>
                  <input
                    aria-describedby="pcv2-execute-phrase-help"
                    className={cn(PCV2_FIELD_INPUT, 'mt-1 font-mono')}
                    id="pcv2-execute-phrase"
                    onChange={(event) => {
                      setExecutePhraseValue(event.target.value)
                    }}
                    value={executePhraseValue}
                  />
                  <p
                    className={cn('mt-1 text-xs', PCV2_MUTED)}
                    id="pcv2-execute-phrase-help"
                  >
                    A confirmação deriva do plano e do ambiente; nunca é colada
                    silenciosamente.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm text-primary-800 dark:text-primary-200">
                  <input
                    checked={executeReviewed}
                    id="pcv2-execute-reviewed"
                    onChange={(event) => {
                      setExecuteReviewed(event.target.checked)
                    }}
                    type="checkbox"
                  />
                  Revisei recursos, riscos e rollback
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    className={PCV2_DESTRUCTIVE_BUTTON}
                    disabled={!executeReady || action.isPending}
                    onClick={() => void execute()}
                    type="button"
                  >
                    {action.isPending
                      ? 'Enfileirando execução…'
                      : executionCtaLabel(operation.state)}
                  </button>
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
              </div>
            ) : operation.state === 'awaiting_approval' ? (
              <p className={cn('text-sm', PCV2_MUTED)}>
                {AWAITING_APPROVAL_COPY}
              </p>
            ) : null}
            {operation === null ? null : (
              <ProjectCenterV2OperationView
                client={client}
                onLeaveInBackground={onLeaveInBackground}
                operationId={operation.operation_id}
                reducedMotion={reduced}
              />
            )}
          </section>
        ) : null}

        {step === 'verification' ? (
          <VerificationStep
            isPending={action.isPending}
            onRecover={() => void verify()}
            operation={operation}
          />
        ) : null}

        {step === 'rollback' ? (
          <RollbackStep
            destructivePhrase={destructivePhraseValue}
            destructiveReason={destructiveReason}
            isPending={action.isPending}
            onDestructivePhrase={setDestructivePhraseValue}
            onDestructiveReason={setDestructiveReason}
            onPlan={() => void rollbackDryRun()}
            onPreserveData={setPreserveData}
            onReason={setRollbackReason}
            onDecide={(decision) => void rollbackDecide(decision)}
            onExecute={() => void rollbackExecute()}
            operation={operation}
            preserveData={preserveData}
            reason={rollbackReason}
          />
        ) : null}

        <footer className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            className={PCV2_SECONDARY_BUTTON}
            disabled={wizardStep(step).index === 0}
            onClick={() => {
              const previous = WIZARD_STEPS[wizardStep(step).index - 1]
              setStep(previous.id)
            }}
            type="button"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.6} />
            Voltar etapa
          </button>
          {step === 'context' ? (
            <button
              className={PCV2_PRIMARY_BUTTON}
              onClick={() => {
                if (validateContext()) {
                  setStep('resources')
                }
              }}
              type="button"
            >
              Continuar para recursos
            </button>
          ) : null}
          {step === 'resources' ? (
            <button
              className={PCV2_PRIMARY_BUTTON}
              disabled={
                mode === 'supabase_isolated' &&
                (!telemetryAvailable ||
                  supabaseReason.trim().length < 10 ||
                  !costAcknowledged)
              }
              onClick={() => {
                if (
                  mode === 'supabase_isolated' &&
                  (!telemetryAvailable ||
                    supabaseReason.trim().length < 10 ||
                    !costAcknowledged)
                ) {
                  toast(
                    telemetryAvailable
                      ? 'Justifique a stack completa e reconheça o custo observado.'
                      : TELEMETRY_UNAVAILABLE_COPY,
                    { type: 'warning' },
                  )
                  return
                }
                setStep('dry_run')
              }}
              type="button"
            >
              Gerar dry-run
            </button>
          ) : null}
          {step === 'dry_run' ? (
            <button
              className={PCV2_PRIMARY_BUTTON}
              disabled={plan === null}
              onClick={() => {
                setStep('security')
              }}
              type="button"
            >
              Revisar segurança
            </button>
          ) : null}
          {step === 'security' ? (
            <button
              className={PCV2_PRIMARY_BUTTON}
              disabled={!canRequestApproval}
              onClick={() => {
                setStep('approval')
                toast('Plano enviado para aprovação.', { type: 'info' })
              }}
              type="button"
            >
              Solicitar aprovação
            </button>
          ) : null}
          {step === 'approval' && approvalNeeded ? (
            <p className={cn('text-xs', PCV2_MUTED)}>
              {AWAITING_APPROVAL_COPY}
            </p>
          ) : null}
          {step === 'verification' ? (
            <button
              className={PCV2_PRIMARY_BUTTON}
              disabled={operation?.verification?.outcome !== 'passed'}
              onClick={() => {
                setStep('rollback')
              }}
              type="button"
            >
              Revisar rollback
            </button>
          ) : null}
        </footer>
      </div>
    </section>
  )
}

function Stepper({
  current,
  blocked,
}: {
  readonly current: WizardStepId
  readonly blocked: boolean
}) {
  return (
    <nav aria-label="Etapas do provisionamento" data-testid="pcv2-stepper">
      <ol className="flex flex-wrap gap-2">
        {WIZARD_STEPS.map((entry) => {
          const state = stepStateFor({
            blocked: false,
            current,
            failed: false,
            running: false,
            step: entry.id,
            valid: blocked ? false : true,
          })
          const isCurrent = entry.id === current
          return (
            <li key={entry.id}>
              <span
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs',
                  isCurrent
                    ? 'border-accent-500/60 bg-accent-500/10 text-accent-500'
                    : 'border-primary-200/70 text-primary-600 dark:border-primary-800 dark:text-primary-300',
                )}
                data-step-state={state}
              >
                <span aria-hidden="true" className="font-mono">
                  {entry.index + 1}
                </span>
                {entry.label}
                <span className="uppercase tracking-wider">
                  {STEP_STATE_TEXT[state]}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function ContextStep({
  context,
  errors,
  idempotencyKey,
  names,
  onChange,
}: {
  readonly context: ContextDraft
  readonly errors: ReadonlyArray<FieldError>
  readonly idempotencyKey: string | null
  readonly names: ReturnType<typeof deriveProjectNames>
  readonly onChange: (next: ContextDraft) => void
}) {
  const errorFor = (field: string) =>
    errors.find((error) => error.field === field)
  function update(patch: Partial<ContextDraft>) {
    onChange({ ...context, ...patch })
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          error={errorFor('pcv2-client-id')}
          help="Identificador do cliente (minúsculas, dígitos e hífen)."
          id="pcv2-client-id"
          label="Cliente"
          onValue={(value) => {
            update({ clientId: value.toLowerCase() })
          }}
          value={context.clientId}
        />
        <Field
          error={errorFor('pcv2-project-slug')}
          help="Slug do projeto; define nomes derivados sem colisão."
          id="pcv2-project-slug"
          label="Slug do projeto"
          onValue={(value) => {
            update({ projectSlug: value.toLowerCase() })
          }}
          value={context.projectSlug}
        />
        <Field
          error={errorFor('pcv2-display-name')}
          help="Nome exibido (3–80 caracteres)."
          id="pcv2-display-name"
          label="Nome do projeto"
          onValue={(value) => {
            update({ displayName: value })
          }}
          value={context.displayName}
        />
        <Field
          error={errorFor('pcv2-owner')}
          help="Proprietário operacional do projeto."
          id="pcv2-owner"
          label="Proprietário operacional"
          onValue={(value) => {
            update({ owner: value })
          }}
          value={context.owner}
        />
        <Field
          error={errorFor('pcv2-repository')}
          help="Identificador do repositório no registry (sem URL ou path)."
          id="pcv2-repository"
          label="Repositório"
          onValue={(value) => {
            update({ repositoryId: value })
          }}
          value={context.repositoryId}
        />
        <div>
          <label className={PCV2_LABEL} htmlFor="pcv2-environment">
            Ambiente
          </label>
          <select
            aria-describedby="pcv2-environment-help"
            className={cn(PCV2_FIELD_INPUT, 'mt-1')}
            id="pcv2-environment"
            onChange={(event) => {
              update({ environment: event.target.value as Environment })
            }}
            value={context.environment}
          >
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {environment}
              </option>
            ))}
          </select>
          <p
            className={cn('mt-1 text-xs', PCV2_MUTED)}
            id="pcv2-environment-help"
          >
            Produção exige aprovador humano diferente do solicitante.
          </p>
        </div>
        <div>
          <label className={PCV2_LABEL} htmlFor="pcv2-sensitivity">
            Classificação de sensibilidade
          </label>
          <select
            className={cn(PCV2_FIELD_INPUT, 'mt-1')}
            id="pcv2-sensitivity"
            onChange={(event) => {
              update({
                sensitivity: event.target.value as ContextDraft['sensitivity'],
              })
            }}
            value={context.sensitivity}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className={PCV2_LABEL} htmlFor="pcv2-description">
            Descrição sem dados sensíveis
          </label>
          <textarea
            aria-describedby="pcv2-description-help"
            className={cn(PCV2_FIELD_INPUT, 'mt-1')}
            id="pcv2-description"
            onChange={(event) => {
              update({ description: event.target.value })
            }}
            rows={3}
            value={context.description}
          />
          <p
            className={cn('mt-1 text-xs', PCV2_MUTED)}
            id="pcv2-description-help"
          >
            Não inclua path absoluto, senha, DSN ou token.
          </p>
        </div>
      </div>

      <aside className={cn(PCV2_PANEL, 'space-y-3 text-xs')}>
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Pré-visualizações derivadas (read-only)
        </h3>
        <dl className="space-y-2">
          <div>
            <dt className={PCV2_MUTED}>project_id</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {names.projectId || '—'}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>database</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {names.databaseName || '—'}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>role app</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {names.appRoleName || '—'}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>intenção de credencial</dt>
            <dd className={PCV2_HEADING}>{CREDENTIAL_INTENT_COPY}</dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>diretórios esperados (relativos)</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>
              {EXPECTED_RELATIVE_PATHS.join(' · ')}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>Idempotency-Key (mascarada)</dt>
            <dd
              className={cn('font-mono', PCV2_HEADING)}
              data-testid="pcv2-idempotency-key"
            >
              {idempotencyKey === null
                ? 'gerada e persistida pelo cliente antes do primeiro envio'
                : maskIdempotencyKey(idempotencyKey)}
            </dd>
          </div>
          <div>
            <dt className={PCV2_MUTED}>SecretRef</dt>
            <dd className={cn('font-mono', PCV2_HEADING)}>{maskSecretRef()}</dd>
          </div>
        </dl>
      </aside>
    </div>
  )
}

function Field({
  error,
  help,
  id,
  label,
  onValue,
  value,
}: {
  readonly error: FieldError | undefined
  readonly help: string
  readonly id: string
  readonly label: string
  readonly onValue: (next: string) => void
  readonly value: string
}) {
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  return (
    <div>
      <label className={PCV2_LABEL} htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={error === undefined ? helpId : `${helpId} ${errorId}`}
        aria-invalid={error === undefined ? undefined : true}
        className={cn(PCV2_FIELD_INPUT, 'mt-1')}
        id={id}
        onChange={(event) => {
          onValue(event.target.value)
        }}
        value={value}
      />
      <p className={cn('mt-1 text-xs', PCV2_MUTED)} id={helpId}>
        {help}
      </p>
      {error === undefined ? null : (
        <p className="mt-1 text-xs text-red-300" id={errorId}>
          {sanitizeForDisplay(error.message)}
        </p>
      )}
    </div>
  )
}

function ResourcesStep({
  capabilities,
  costAcknowledged,
  mode,
  onCapabilities,
  onCostAcknowledged,
  onMode,
  onReason,
  reason,
  telemetryAvailable,
}: {
  readonly capabilities: Capability
  readonly costAcknowledged: boolean
  readonly mode: Driver
  readonly onCapabilities: (next: Capability) => void
  readonly onCostAcknowledged: (next: boolean) => void
  readonly onMode: (next: Driver) => void
  readonly onReason: (next: string) => void
  readonly reason: string
  readonly telemetryAvailable: boolean
}) {
  return (
    <div className="space-y-4">
      <fieldset className={cn(PCV2_PANEL, 'space-y-3')}>
        <legend className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Capacidades necessárias
        </legend>
        <div className="grid gap-2 md:grid-cols-2">
          {CAPABILITY_OPTIONS.map((option) => (
            <label
              className="flex min-h-11 items-start gap-2 text-sm text-primary-800 dark:text-primary-200"
              key={option.id}
              htmlFor={`pcv2-cap-${option.id}`}
            >
              <input
                checked={capabilities[option.id]}
                id={`pcv2-cap-${option.id}`}
                onChange={(event) => {
                  onCapabilities({
                    ...capabilities,
                    [option.id]: event.target.checked,
                  })
                }}
                type="checkbox"
              />
              <span>
                {option.label}
                <span className={cn('mt-1 block text-xs', PCV2_MUTED)}>
                  {option.help}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Modo de infraestrutura
        </legend>
        <div className="grid gap-3 lg:grid-cols-3">
          {INFRASTRUCTURE_MODES.map((card) => {
            const selected = card.mode === mode
            return (
              <article
                className={cn(
                  PCV2_PANEL,
                  'space-y-2 text-sm',
                  card.selectable ? '' : 'opacity-70',
                  selected ? 'border-accent-500/60' : '',
                )}
                data-mode={card.mode}
                key={card.mode}
              >
                <header className="flex items-center justify-between gap-2">
                  <h3 className={cn('font-semibold', PCV2_HEADING)}>
                    {card.label}
                  </h3>
                  {card.badge ? (
                    <span className="rounded-full border border-primary-300/70 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-500">
                      {card.badge}
                    </span>
                  ) : null}
                </header>
                <p className={cn('text-xs', PCV2_MUTED)}>{card.isolation}</p>
                <p className={cn('text-xs', PCV2_MUTED)}>{card.resources}</p>
                {card.selectable ? (
                  <label className="flex min-h-11 items-center gap-2 text-xs">
                    <input
                      checked={selected}
                      id={`pcv2-mode-${card.mode}`}
                      name="pcv2-mode"
                      onChange={() => {
                        onMode(card.mode as Driver)
                      }}
                      type="radio"
                    />
                    Selecionar modo
                  </label>
                ) : (
                  <p
                    className="text-xs text-amber-200"
                    data-testid="pcv2-legacy-copy"
                  >
                    {LEGACY_BLOCKED_CARD_COPY}
                  </p>
                )}
              </article>
            )
          })}
        </div>
        <p className={cn('text-xs', PCV2_MUTED)}>{LEGACY_BLOCKED_COPY}</p>
      </fieldset>

      {mode === 'supabase_isolated' ? (
        <div className={cn(PCV2_PANEL, 'space-y-3')}>
          <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
            {SUPABASE_COST_COPY}
          </h3>
          <div>
            <label className={PCV2_LABEL} htmlFor="pcv2-supabase-reason">
              Por que a stack modular não atende?
            </label>
            <textarea
              className={cn(PCV2_FIELD_INPUT, 'mt-1')}
              id="pcv2-supabase-reason"
              onChange={(event) => {
                onReason(event.target.value)
              }}
              rows={3}
              value={reason}
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm text-primary-800 dark:text-primary-200">
            <input
              checked={costAcknowledged}
              id="pcv2-cost-ack"
              onChange={(event) => {
                onCostAcknowledged(event.target.checked)
              }}
              type="checkbox"
            />
            Reconheço o custo observado e o headroom necessário
          </label>
        </div>
      ) : null}

      <div className={cn(PCV2_PANEL, 'text-xs')} data-testid="pcv2-cost-panel">
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Impacto e qualidade da estimativa
        </h3>
        <p className={cn('mt-1', PCV2_MUTED)}>
          Containers novos:{' '}
          {mode === 'postgresql_isolated' ? '0' : '14 (baseline)'} · RAM e CPU:
          recalculados no dry-run · headroom: medido na execução do plano.
        </p>
        <p
          className={cn('mt-1', PCV2_MUTED)}
          data-testid="pcv2-estimate-quality"
        >
          Qualidade da estimativa:{' '}
          {telemetryAvailable
            ? 'observado/estimado'
            : 'Estimativa indisponível'}
        </p>
        {telemetryAvailable ? null : (
          <p className="mt-1 text-amber-200">{TELEMETRY_UNAVAILABLE_COPY}</p>
        )}
      </div>
      <p className={cn('text-xs', PCV2_MUTED)}>
        “0 containers” não significa “0 RAM”: o custo marginal vem do plano de
        capacidade.
      </p>
    </div>
  )
}

function DryRunStep({
  artifacts,
  diff,
  estimated,
  idempotencyKey,
  isPending,
  onCopy,
  onGenerate,
  operation,
}: {
  readonly artifacts: Operation['artifacts']
  readonly diff: ReadonlyArray<DiffItem>
  readonly estimated: Operation['plan']['estimated_resources'] | null
  readonly idempotencyKey: string | null
  readonly isPending: boolean
  readonly onCopy: () => void
  readonly onGenerate: () => void
  readonly operation: Operation | null
}) {
  return (
    <div className="space-y-4">
      {operation === null ? (
        <div className={cn(PCV2_PANEL, 'space-y-2 text-sm')}>
          <p className={cn(PCV2_HEADING)} aria-busy={isPending}>
            {isPending
              ? 'Validando contexto, capacidade e colisões'
              : 'Nenhum plano gerado'}
          </p>
          <p className={cn('text-xs', PCV2_MUTED)}>
            O dry-run é determinístico, idempotente e sem side effects. A chave
            de idempotência é gerada e persistida pelo cliente antes do primeiro
            envio e reutilizada após timeout.
          </p>
          <p className={cn('text-xs', PCV2_MUTED)}>
            Idempotency-Key{' '}
            <span className="font-mono">
              {idempotencyKey === null
                ? 'ainda não alocada'
                : maskIdempotencyKey(idempotencyKey)}
            </span>{' '}
            · o valor integral nunca é renderizado (retries reutilizam a mesma
            chave).
          </p>
          <button
            className={PCV2_PRIMARY_BUTTON}
            disabled={isPending}
            onClick={onGenerate}
            type="button"
          >
            {isPending ? 'Gerando dry-run…' : 'Gerar dry-run'}
          </button>
        </div>
      ) : null}

      {operation === null ? null : (
        <>
          <div className={cn(PCV2_PANEL, 'space-y-2 text-xs')}>
            <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
              Plano {maskOpaqueIdentifier(operation.operation_id, 4)} · hash{' '}
              {maskOpaqueIdentifier(operation.plan_hash, 4)}
            </h3>
            <p className={PCV2_MUTED}>
              Idempotency-Key{' '}
              {idempotencyKey === null
                ? 'mascarada'
                : maskIdempotencyKey(idempotencyKey)}{' '}
              · válido até {operation.expires_at} · gerado em{' '}
              {operation.created_at}
            </p>
            <p className={PCV2_MUTED}>
              RAM estimada:{' '}
              {estimated?.memory_mb === undefined
                ? 'indisponível'
                : `${estimated.memory_mb} MB`}{' '}
              · CPU:{' '}
              {estimated?.cpu_millicores === undefined
                ? 'indisponível'
                : `${estimated.cpu_millicores} m`}{' '}
              · disco:{' '}
              {estimated?.database_size_mb === undefined
                ? 'indisponível'
                : `${estimated.database_size_mb} MB`}
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <button
                className={PCV2_SECONDARY_BUTTON}
                onClick={onCopy}
                type="button"
              >
                Baixar plano sanitizado
              </button>
              <button
                className={PCV2_SECONDARY_BUTTON}
                disabled={isPending}
                onClick={onGenerate}
                type="button"
              >
                Regerar dry-run
              </button>
            </div>
          </div>

          <section className="space-y-3" data-testid="pcv2-diff">
            <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
              Diff de intenção por domínio
            </h3>
            {(
              Object.keys(DIFF_DOMAIN_LABELS) as ReadonlyArray<
                keyof typeof DIFF_DOMAIN_LABELS
              >
            ).map((domain) => {
              const items = diff.filter((item) => item.domain === domain)
              if (items.length === 0) return null
              return (
                <div className={PCV2_PANEL} key={domain}>
                  <h4
                    className={cn(
                      'text-xs uppercase tracking-wider',
                      PCV2_MUTED,
                    )}
                  >
                    {DIFF_DOMAIN_LABELS[domain]}
                  </h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    {items.map((item) => (
                      <li
                        className="flex flex-wrap items-center gap-2"
                        data-diff-outcome={item.outcome}
                        key={item.actionId}
                      >
                        <span aria-hidden="true" className="font-mono">
                          {item.outcome === 'create'
                            ? '+'
                            : item.outcome === 'reuse'
                              ? '↻'
                              : item.outcome === 'conflict'
                                ? '!'
                                : item.outcome === 'blocked'
                                  ? '⊘'
                                  : '='}
                        </span>
                        <span className={PCV2_HEADING}>{item.label}</span>
                        <span className="text-xs text-primary-500">
                          {DIFF_OUTCOME_LABELS[item.outcome]}
                        </span>
                        <span className={cn('text-xs', PCV2_MUTED)}>
                          {item.risk} · reversível{' '}
                          {item.reversible ? 'sim' : 'não'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>
          <ProjectCenterV2ArtifactList artifacts={artifacts ?? []} />
          <div className={cn(PCV2_PANEL, 'text-xs')}>
            <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
              Credencial gerenciada
            </h3>
            <p className={cn('mt-1', PCV2_MUTED)}>
              Referência opaca no formato {maskSecretRef()} — emitida apenas
              pelo broker no servidor, com label funcional e nunca o valor
              integral.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function ApprovalStep({
  actionError,
  approvePhrase,
  approveReason,
  canRequest,
  isPending,
  onApprovePhrase,
  onApproveReason,
  onDecide,
  onRejectReason,
  operation,
  rejectReason,
  requiredPhrase,
}: {
  readonly actionError: unknown
  readonly approvePhrase: string
  readonly approveReason: string
  readonly canRequest: boolean
  readonly isPending: boolean
  readonly onApprovePhrase: (next: string) => void
  readonly onApproveReason: (next: string) => void
  readonly onDecide: (decision: 'approve' | 'reject') => void
  readonly onRejectReason: (next: string) => void
  readonly operation: Operation | null
  readonly rejectReason: string
  readonly requiredPhrase: string
}) {
  if (operation === null) {
    return (
      <p className={cn('text-sm', PCV2_MUTED)}>
        Gere o dry-run antes de solicitar aprovação.
      </p>
    )
  }
  const decideBlocked = isPending || !canRequest
  const approval = operation.approval ?? null
  return (
    <div className="space-y-4">
      <section
        className={cn(PCV2_PANEL, 'space-y-2 text-sm')}
        data-testid="pcv2-approval-summary"
      >
        <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
          Resumo do plano revisado
        </h2>
        <p className={PCV2_MUTED}>
          Projeto {operation.project_id} · ambiente {operation.environment} ·
          driver {operation.driver}
        </p>
        <p className={PCV2_MUTED}>
          Modalidade:{' '}
          {operation.driver === 'postgresql_isolated'
            ? 'Database e role exclusivos'
            : 'Stack Supabase completa e isolada'}
        </p>
        <p className={PCV2_MUTED}>
          Hash do plano {maskOpaqueIdentifier(operation.plan_hash, 4)} · válido
          até {operation.expires_at}
        </p>
        <p className={PCV2_MUTED}>
          Side effects previstos: {operation.plan.actions.length} ação(ões);
          rollback planejado em três fases.
        </p>
        <p className={cn('text-xs', PCV2_MUTED)}>{AWAITING_APPROVAL_COPY}</p>
        {actionError !== null ? (
          <p className="text-xs text-red-300">
            A última decisão não foi aplicada; revise a policy do seu ator.
          </p>
        ) : null}
      </section>

      {approval ? (
        <p className={cn(PCV2_PANEL, 'text-sm')}>
          Decisão registrada: {approval.decision} · expira em{' '}
          {approval.expires_at}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section
            className={cn(PCV2_PANEL, 'space-y-3')}
            data-testid="pcv2-approve-form"
          >
            <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
              Aprovar plano
            </h3>
            <p className={cn('text-xs', PCV2_MUTED)}>
              Frase exata: <span className="font-mono">{requiredPhrase}</span>
            </p>
            <div>
              <label className={PCV2_LABEL} htmlFor="pcv2-approve-phrase">
                Frase de aprovação
              </label>
              <input
                className={cn(PCV2_FIELD_INPUT, 'mt-1 font-mono')}
                id="pcv2-approve-phrase"
                onChange={(event) => {
                  onApprovePhrase(event.target.value)
                }}
                value={approvePhrase}
              />
            </div>
            <div>
              <label className={PCV2_LABEL} htmlFor="pcv2-approve-reason">
                Razão (opcional)
              </label>
              <input
                className={cn(PCV2_FIELD_INPUT, 'mt-1')}
                id="pcv2-approve-reason"
                onChange={(event) => {
                  onApproveReason(event.target.value)
                }}
                value={approveReason}
              />
            </div>
            <button
              className={PCV2_PRIMARY_BUTTON}
              disabled={decideBlocked || approvePhrase !== requiredPhrase}
              onClick={() => {
                onDecide('approve')
              }}
              type="button"
            >
              Aprovar plano
            </button>
          </section>

          <section
            className={cn(PCV2_PANEL, 'space-y-3')}
            data-testid="pcv2-reject-form"
          >
            <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
              Rejeitar com motivo
            </h3>
            <p className={cn('text-xs', PCV2_MUTED)}>
              Rejeição nunca pede, mostra ou envia hash ou frase de aprovação.
            </p>
            <div>
              <label className={PCV2_LABEL} htmlFor="pcv2-reject-reason">
                Motivo (3–500 caracteres)
              </label>
              <textarea
                className={cn(PCV2_FIELD_INPUT, 'mt-1')}
                id="pcv2-reject-reason"
                onChange={(event) => {
                  onRejectReason(event.target.value)
                }}
                rows={3}
                value={rejectReason}
              />
            </div>
            <button
              className={PCV2_DESTRUCTIVE_BUTTON}
              disabled={decideBlocked || rejectReason.trim().length < 3}
              onClick={() => {
                onDecide('reject')
              }}
              type="button"
            >
              Rejeitar plano
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

function VerificationStep({
  isPending,
  onRecover,
  operation,
}: {
  readonly isPending: boolean
  readonly onRecover: () => void
  readonly operation: Operation | null
}) {
  if (operation === null) {
    return (
      <p className={cn('text-sm', PCV2_MUTED)}>
        Nenhuma operação persistida para verificar.
      </p>
    )
  }
  const verification: Verification | null = operation.verification ?? null
  const passed = verification?.outcome === 'passed'
  return (
    <div className="space-y-4">
      <ProjectCenterV2EvidenceList verification={verification} />
      <section className={cn(PCV2_PANEL, 'space-y-2 text-xs')}>
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          Checklist obrigatório de verificação
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Database/role ou stack/containers existem exatamente uma vez.</li>
          <li>Rerun com a mesma Idempotency-Key não duplica recursos.</li>
          <li>Role app sem privilégios proibidos.</li>
          <li>Porta 5432 não pública.</li>
          <li>Projeto A não conecta, lê ou escreve o banco B.</li>
          <li>Respostas, logs e artefatos sem credencial real.</li>
          <li>Backup e restore test por projeto executados.</li>
          <li>Auditoria liga request, approval, operation e verificação.</li>
        </ul>
      </section>
      {passed ? null : (
        <p className="text-xs text-amber-200">{PARTIAL_FAILURE_COPY}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          className={PCV2_SECONDARY_BUTTON}
          disabled={isPending}
          onClick={onRecover}
          type="button"
        >
          {isPending ? 'Enfileirando verificação…' : 'Iniciar recuperação'}
        </button>
        <button
          className={PCV2_PRIMARY_BUTTON}
          disabled={!passed}
          onClick={() => {
            toast('Projeto liberado somente após verificação PASS.', {
              type: 'success',
            })
          }}
          type="button"
        >
          Abrir projeto
        </button>
      </div>
    </div>
  )
}

function RollbackStep({
  destructivePhrase,
  destructiveReason,
  isPending,
  onDecide,
  onDestructivePhrase,
  onDestructiveReason,
  onExecute,
  onPlan,
  onPreserveData,
  onReason,
  operation,
  preserveData,
  reason,
}: {
  readonly destructivePhrase: string
  readonly destructiveReason: string
  readonly isPending: boolean
  readonly onDecide: (decision: 'approve' | 'reject') => void
  readonly onDestructivePhrase: (next: string) => void
  readonly onDestructiveReason: (next: string) => void
  readonly onExecute: () => void
  readonly onPlan: () => void
  readonly onPreserveData: (next: boolean) => void
  readonly onReason: (next: string) => void
  readonly operation: Operation | null
  readonly preserveData: boolean
  readonly reason: string
}) {
  if (operation === null) {
    return (
      <p className={cn('text-sm', PCV2_MUTED)}>
        Nenhuma operação para compensar.
      </p>
    )
  }
  const rollback = operation.rollback ?? null
  const approval = rollback?.approval ?? null
  const approved = approval?.decision === 'approve'
  const destructionTarget = operation.project_id
  const rollbackState = describeRollbackState({
    approved,
    destructive: rollback?.destructive === true,
    state: operation.state,
  })
  return (
    <div className="space-y-4">
      <section
        className={cn(PCV2_PANEL, 'space-y-2 text-sm')}
        data-testid="pcv2-rollback"
      >
        <h2 className={cn('text-lg font-semibold', PCV2_HEADING)}>
          Rollback em três fases
        </h2>
        <p data-testid="pcv2-rollback-state">
          Estado do rollback:{' '}
          <span className={PCV2_HEADING}>{rollbackState}</span>
        </p>
        <p className={cn('text-xs', PCV2_MUTED)}>
          Nunca existe “rollback” genérico: cancelar recurso não criado, remover
          recurso vazio desta operação, restaurar configuração, restaurar backup
          e excluir dados são ações distintas.
        </p>
      </section>

      <section
        className={cn(PCV2_PANEL, 'space-y-3')}
        data-testid="pcv2-rollback-plan"
      >
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          1. Planejar rollback
        </h3>
        <div>
          <label className={PCV2_LABEL} htmlFor="pcv2-rollback-reason">
            Motivo (10–500 caracteres)
          </label>
          <textarea
            className={cn(PCV2_FIELD_INPUT, 'mt-1')}
            id="pcv2-rollback-reason"
            onChange={(event) => {
              onReason(event.target.value)
            }}
            rows={3}
            value={reason}
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm text-primary-800 dark:text-primary-200">
          <input
            checked={preserveData}
            id="pcv2-preserve-data"
            onChange={(event) => {
              onPreserveData(event.target.checked)
            }}
            type="checkbox"
          />
          Preservar dados (recomendado)
        </label>
        <button
          className={PCV2_SECONDARY_BUTTON}
          disabled={isPending || reason.trim().length < 10}
          onClick={onPlan}
          type="button"
        >
          Gerar dry-run de rollback
        </button>
        {rollback === null ? null : (
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className={PCV2_MUTED}>rollback_plan_hash</dt>
              <dd className={cn('font-mono', PCV2_HEADING)}>
                {maskOpaqueIdentifier(rollback.rollback_plan_hash, 4)}
              </dd>
            </div>
            <div>
              <dt className={PCV2_MUTED}>destrutivo · ownership</dt>
              <dd className={PCV2_HEADING}>
                {rollback.destructive ? 'sim' : 'não'} · ownership verificado
              </dd>
            </div>
            <div>
              <dt className={PCV2_MUTED}>revisão observada</dt>
              <dd className={cn('font-mono', PCV2_HEADING)}>
                {sanitizeForDisplay(rollback.observed_revision)}
              </dd>
            </div>
            <div>
              <dt className={PCV2_MUTED}>expira em</dt>
              <dd className={PCV2_HEADING}>{rollback.expires_at}</dd>
            </div>
          </dl>
        )}
      </section>

      <section
        className={cn(PCV2_PANEL, 'space-y-3')}
        data-testid="pcv2-rollback-approval"
      >
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          2. Decidir rollback
        </h3>
        <p className={cn('text-xs', PCV2_MUTED)}>
          Aprovação própria, vinculada ao{' '}
          <span className="font-mono">rollback_plan_hash</span>.
          {rollback?.destructive === true
            ? ' Em rollback destrutivo o aprovador humano difere dos dois solicitantes.'
            : ''}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className={PCV2_PRIMARY_BUTTON}
            disabled={isPending || rollback === null || approved}
            onClick={() => {
              onDecide('approve')
            }}
            type="button"
          >
            Aprovar rollback
          </button>
          <button
            className={PCV2_SECONDARY_BUTTON}
            disabled={isPending || rollback === null}
            onClick={() => {
              onDecide('reject')
            }}
            type="button"
          >
            Rejeitar rollback
          </button>
        </div>
        {approval ? (
          <p className={cn('text-xs', PCV2_MUTED)}>
            Aprovação {maskOpaqueIdentifier(approval.approval_id, 4)} ·{' '}
            {approval.decision} · expira em {approval.expires_at}
          </p>
        ) : null}
      </section>

      <section
        className={cn(PCV2_PANEL, 'space-y-3')}
        data-testid="pcv2-rollback-execute"
      >
        <h3 className={cn('text-sm font-semibold', PCV2_HEADING)}>
          3. Executar rollback
        </h3>
        <p className={cn('text-xs', PCV2_MUTED)}>
          Frase destrutiva:{' '}
          <span className="font-mono">
            {destructionPhrase(destructionTarget)}
          </span>
        </p>
        {approved ? null : (
          <p className="text-xs text-amber-200">
            Ação irreversível bloqueada: exige plano destrutivo persistido e
            aprovação válida vinculada ao hash.
          </p>
        )}
        <div>
          <label className={PCV2_LABEL} htmlFor="pcv2-destructive-phrase">
            Frase de destruição
          </label>
          <input
            className={cn(PCV2_FIELD_INPUT, 'mt-1 font-mono')}
            id="pcv2-destructive-phrase"
            onChange={(event) => {
              onDestructivePhrase(event.target.value)
            }}
            value={destructivePhrase}
          />
        </div>
        <div>
          <label className={PCV2_LABEL} htmlFor="pcv2-destructive-reason">
            Motivo da ação irreversível
          </label>
          <input
            className={cn(PCV2_FIELD_INPUT, 'mt-1')}
            id="pcv2-destructive-reason"
            onChange={(event) => {
              onDestructiveReason(event.target.value)
            }}
            value={destructiveReason}
          />
        </div>
        <button
          className={PCV2_DESTRUCTIVE_BUTTON}
          disabled={
            !approved ||
            isPending ||
            destructivePhrase !== destructionPhrase(destructionTarget) ||
            destructiveReason.trim().length < 3
          }
          onClick={onExecute}
          type="button"
        >
          Enfileirar compensação aprovada
        </button>
      </section>
    </div>
  )
}

function describeRollbackState(input: {
  readonly approved: boolean
  readonly destructive: boolean
  readonly state: Operation['state']
}): string {
  if (input.destructive && !input.approved) return 'Bloqueado'
  if (input.state === 'rolled_back') return 'Concluído'
  if (input.state === 'rolling_back') return 'Em compensação'
  if (input.state === 'manual_intervention_required') return 'Parcial'
  if (input.state === 'rollback_pending') return 'Disponível'
  if (input.state === 'succeeded') return 'Não necessário'
  if (input.state === 'failed') return 'Disponível'
  return 'Disponível'
}

function ProjectCenterV2ErrorPanel({
  error,
  onRetry,
  operationId,
}: {
  readonly error: unknown
  readonly onRetry: () => void
  readonly operationId: string | null
}) {
  return (
    <section
      className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100"
      data-testid="pcv2-action-error"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          className="mt-0.5 shrink-0"
          icon={Alert02Icon}
          size={18}
          strokeWidth={1.6}
        />
        <div className="space-y-1">
          <p className="font-semibold">
            <HugeiconsIcon
              className="mr-2 inline"
              icon={Shield01Icon}
              size={15}
              strokeWidth={1.6}
            />
            Ação recusada pelo control plane
          </p>
          <p className="text-xs">
            {error instanceof ProjectCenterV2ApiError
              ? sanitizeForDisplay(error.message)
              : error instanceof Error
                ? sanitizeForDisplay(error.message)
                : 'Falha sem detalhe tipado'}
          </p>
          {operationId === null ? null : (
            <p className="text-xs">
              Operação {maskOpaqueIdentifier(operationId, 4)} preservada para
              investigação.
            </p>
          )}
          <button
            className={PCV2_SECONDARY_BUTTON}
            onClick={onRetry}
            type="button"
          >
            <HugeiconsIcon icon={DatabaseAddIcon} size={15} strokeWidth={1.6} />
            limpar aviso
          </button>
        </div>
      </div>
    </section>
  )
}
