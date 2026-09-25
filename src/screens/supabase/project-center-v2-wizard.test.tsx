// @vitest-environment jsdom
/**
 * Testes do wizard de provisionamento do Project Center v2 (PR 5).
 *
 * Cobre os critérios do card: oito etapas persistentes, foco movido para o
 * título ao avançar, resumo de erros `role="alert"` focado com links para os
 * campos, rótulo em todo controle, gate de ação irreversível por frase exata,
 * payload de rejeição sem `plan_hash`/confirmação, máscaras
 * (hash/Idempotency-Key/`secret_ref`) e 403 do servidor sem inferência local de
 * permissão.
 *
 * Render: `React.act` + `createRoot` (React 19 em jsdom; ver
 * `src/screens/mcp/-marketplace-install-confirmation.test.tsx` — o
 * `@testing-library/react` carrega uma segunda cópia de React neste setup).
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCenterV2Wizard } from './project-center-v2-wizard'
import type { ProjectCenterV2Client } from '@/lib/project-center-v2-api'
import type { ArtifactRef, Operation } from '@/lib/project-center-v2-types'
import { Toaster } from '@/components/ui/toast'
import { ProjectCenterV2ApiError } from '@/lib/project-center-v2-api'
import {
  WIZARD_STEPS,
  approvalPhrase,
  maskIdempotencyKey,
  maskOpaqueIdentifier,
  maskSecretRef,
  provisioningPhrase,
} from '@/lib/project-center-v2-types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const PLAN_HASH = 'b'.repeat(64)
/** Fixture sem literal de token no fonte: montada em runtime. */
const SECRET_REF_VALUE = `sref_${'C'.repeat(48)}`
const IDEMPOTENCY_KEY = 'Zk9q1Wm4Tb7xLp2Rc5Vh3N'
const RAW_PATH = ['', 'home', 'operador', 'supabase', '.env'].join('/')

function operationFixture(overrides: Partial<Operation> = {}): Operation {
  return {
    artifacts: [
      { ref: 'je4ndev_projeto_isolado', status: 'planned', type: 'database' },
      { ref: SECRET_REF_VALUE, status: 'planned', type: 'secret_ref' },
    ] as ReadonlyArray<ArtifactRef>,
    audit_url: '/api/project-center/v2/operations/x/audit',
    created_at: '2026-09-25T10:00:00.000Z',
    driver: 'postgresql_isolated',
    environment: 'development',
    expires_at: '2026-09-25T11:00:00.000Z',
    operation_id: OPERATION_ID,
    operation_version: 3,
    plan: {
      actions: [
        {
          action_id: 'act_1',
          dependencies: [],
          kind: 'create_database',
          reversible: true,
          risk: 'reversible',
          target_ref: 'je4ndev_projeto_isolado',
        },
      ],
      estimated_resources: { memory_mb: 256 },
      policy_version: 'pcv2-policy-v1',
      warnings: [],
    },
    plan_hash: PLAN_HASH,
    project_id: 'je4ndev-projeto-isolado',
    state: 'awaiting_approval',
    status_url: '/api/project-center/v2/operations/x',
    updated_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  }
}

function fakeClient(
  overrides: Partial<ProjectCenterV2Client> = {},
): ProjectCenterV2Client {
  return {
    approveOperation: vi.fn(),
    dryRun: vi.fn().mockResolvedValue({
      operation: operationFixture(),
      replayed: false,
      requestId: 'req-1',
    }),
    executeOperation: vi.fn().mockResolvedValue({
      operation: operationFixture({ state: 'queued' }),
      replayed: false,
      requestId: 'req-1',
    }),
    getOperation: vi.fn().mockResolvedValue({
      operation: operationFixture({ state: 'queued' }),
      replayed: false,
      requestId: 'req-1',
    }),
    idempotencyKeyFor: vi.fn(() => IDEMPOTENCY_KEY),
    listAudit: vi.fn(),
    rollbackApprove: vi.fn(),
    rollbackDryRun: vi.fn(),
    rollbackExecute: vi.fn(),
    surface: vi.fn(),
    verifyOperation: vi.fn(),
    ...overrides,
  } as ProjectCenterV2Client
}

// ---------------------------------------------------------------------------
// Harness: render e interação sempre dentro de `act`, com limpeza garantida
// mesmo quando uma asserção falha (sem nós React pendurados entre testes).
// ---------------------------------------------------------------------------

let activeCleanup: (() => Promise<void>) | null = null

/** Descarrega microtasks/efeitos pendentes dentro de `act`. */
async function settle(): Promise<void> {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function interact(action: () => void): Promise<void> {
  await React.act(() => {
    action()
  })
  await settle()
}

async function renderInto(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(() => {
    root.render(element)
  })
  await settle()
  activeCleanup = async () => {
    await React.act(() => {
      root.unmount()
    })
    container.remove()
  }
  return container
}

afterEach(async () => {
  await activeCleanup?.()
  activeCleanup = null
  vi.restoreAllMocks()
})

function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector)
  if (element === null) {
    throw new Error(
      `elemento não encontrado: ${selector} · título: ${
        container.querySelector('#pcv2-wizard-heading')?.textContent ??
        'sem-título'
      }`,
    )
  }
  return element as HTMLElement
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes(text),
  )
  if (match === undefined) throw new Error(`botão não encontrado: ${text}`)
  return match
}

/**
 * CTA irreversível da execução: prefere `data-testid` e cai no rótulo do estado
 * (`executionCtaLabel`), sempre como `HTMLButtonElement`.
 */
function executionCta(container: HTMLElement): HTMLButtonElement {
  const byTestId = container.querySelector('[data-testid="pcv2-execute"]')
  if (byTestId instanceof HTMLButtonElement) return byTestId
  return buttonByText(container, 'Provisionar infraestrutura')
}

/** Escreve em campo controlado pelo React (setter nativo + eventos). */
function setField(
  container: HTMLElement,
  selector: string,
  value: string,
): void {
  const element = requireElement(container, selector)
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Fluxos
// ---------------------------------------------------------------------------

/** Preenche o contexto mínimo válido e avança para a etapa de recursos. */
async function fillContext(container: HTMLElement): Promise<void> {
  await interact(() => {
    setField(container, '#pcv2-project-slug', 'projeto-isolado')
    setField(container, '#pcv2-display-name', 'Projeto Isolado')
    setField(container, '#pcv2-owner', 'jean')
  })
  await interact(() => {
    buttonByText(container, 'Continuar para recursos').click()
  })
}

/**
 * Recursos → dry-run → segurança → aprovação. O rótulo "Gerar dry-run" aparece
 * duas vezes: o CTA da etapa de recursos só navega; quem chama a API é o botão
 * interno da etapa de dry-run, que depois mantém o resumo do plano à vista.
 */
async function reachApprovalStep(container: HTMLElement): Promise<void> {
  await fillContext(container)
  await interact(() => {
    buttonByText(container, 'Gerar dry-run').click()
  })
  await interact(() => {
    buttonByText(container, 'Gerar dry-run').click()
  })
  await interact(() => {
    buttonByText(container, 'Revisar segurança').click()
  })
  await interact(() => {
    buttonByText(container, 'Solicitar aprovação').click()
  })
}

// ---------------------------------------------------------------------------
// Etapas e acessibilidade
// ---------------------------------------------------------------------------

describe('ProjectCenterV2Wizard · etapas e acessibilidade', () => {
  it('publica as oito etapas em lista ordenada com aria-current', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )

    const stepper = container.querySelector('[data-testid="pcv2-stepper"]')
    expect(stepper?.tagName).toBe('NAV')
    expect(stepper?.getAttribute('aria-label')).toBe(
      'Etapas do provisionamento',
    )
    const items = stepper?.querySelectorAll('ol > li') ?? []
    expect(items).toHaveLength(8)
    expect(items).toHaveLength(WIZARD_STEPS.length)

    const current = stepper?.querySelector('[aria-current="step"]')
    expect(current?.textContent).toContain(WIZARD_STEPS[0].label)
    expect(current?.textContent).toContain('Atual')
    expect(stepper?.textContent).toContain(WIZARD_STEPS[7].label)
  })

  it('move o foco para o título da etapa ao avançar', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    const first = container.querySelector('#pcv2-wizard-heading')
    expect(first?.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(first)

    await fillContext(container)

    const heading = container.querySelector('#pcv2-wizard-heading')
    expect(document.activeElement).toBe(heading)
    expect(heading?.textContent).toBe(WIZARD_STEPS[1].heading)
    expect(
      container.querySelector('[aria-current="step"]')?.textContent,
    ).toContain(WIZARD_STEPS[1].label)
  })

  it('bloqueia o avanço com resumo de erros focado e links para os campos', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await interact(() => {
      buttonByText(container, 'Continuar para recursos').click()
    })

    const summary = requireElement(
      container,
      '[data-testid="pcv2-error-summary"]',
    )
    expect(summary.getAttribute('role')).toBe('alert')
    expect(document.activeElement).toBe(summary)
    expect(summary.textContent).toContain('3 erro(s) impedem o avanço')

    const links = [...summary.querySelectorAll('a[href^="#"]')]
    expect(links).toHaveLength(3)
    for (const link of links) {
      const target = link.getAttribute('href') ?? ''
      expect(target).toMatch(/^#pcv2-/)
      expect(container.querySelector(target)).not.toBeNull()
    }

    const slug = requireElement(container, '#pcv2-project-slug')
    expect(slug.getAttribute('aria-invalid')).toBe('true')
    const describedBy = slug.getAttribute('aria-describedby') ?? ''
    const describedIds = describedBy.split(/\s+/).filter((id) => id !== '')
    expect(describedIds).toContain('pcv2-project-slug-help')
    expect(describedIds).toContain('pcv2-project-slug-error')
    for (const id of describedIds) {
      expect(container.querySelector(`#${id}`)).not.toBeNull()
    }
    expect(container.querySelector('#pcv2-wizard-state')).toBeNull()
  })

  it('associa rótulo a todo controle e usa alvo de toque nos CTAs', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    const controls = [
      ...container.querySelectorAll('input, select, textarea'),
    ].filter((control) => (control as HTMLInputElement).type !== 'hidden')
    expect(controls.length).toBeGreaterThan(4)
    for (const control of controls) {
      const id = control.getAttribute('id') ?? ''
      expect(id).not.toBe('')
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull()
    }

    const cta = buttonByText(container, 'Continuar para recursos')
    expect(cta.className).toContain('min-h-11')
  })

  it('respeita prefers-reduced-motion pelo contrato do container', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} reducedMotion />,
    )
    expect(
      container
        .querySelector('[data-testid="pcv2-wizard"]')
        ?.getAttribute('data-reduced-motion'),
    ).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// Dry-run, máscaras e decisão
// ---------------------------------------------------------------------------

describe('ProjectCenterV2Wizard · dry-run, máscaras e decisão', () => {
  it('envia intenção sanitizada e projeta o estado canônico com máscaras', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await fillContext(container)
    await interact(() => {
      buttonByText(container, 'Gerar dry-run').click()
    })
    // A etapa de dry-run ainda não chamou a API: o CTA só navegou até ela.
    expect(client.dryRun).not.toHaveBeenCalled()
    // A Idempotency-Key só aparece mascarada e é a mesma do cliente.
    const dryRunText = container.textContent
    expect(dryRunText).toContain(maskIdempotencyKey(IDEMPOTENCY_KEY))
    expect(dryRunText).not.toContain(IDEMPOTENCY_KEY)
    await interact(() => {
      buttonByText(container, 'Gerar dry-run').click()
    })

    expect(client.dryRun).toHaveBeenCalledTimes(1)
    const request = vi.mocked(client.dryRun).mock.calls[0][0]
    expect(request.intent.client_id).toBe('je4ndev')
    expect(request.intent.project_slug).toBe('projeto-isolado')
    expect(request.intent.display_name).toBe('Projeto Isolado')
    expect(request.intent.driver).toBe('postgresql_isolated')
    // Host nunca é escolhido pelo cliente: allowlist do servidor é fixada.
    expect(request.intent.host_target).toBe('vps-primary-local')
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain(RAW_PATH)
    expect(serialized).not.toContain('sref_')
    expect(serialized).not.toMatch(/\/(home|etc|var)\//)

    const state = container.querySelector('[data-testid="pcv2-wizard-state"]')
    expect(state?.getAttribute('aria-live')).toBe('polite')
    expect(state?.textContent).toBe('Aguardando aprovação')

    const text = container.textContent
    expect(text).toContain(maskOpaqueIdentifier(PLAN_HASH, 4))
    expect(text).not.toContain(PLAN_HASH)
    expect(text).toContain(maskIdempotencyKey(IDEMPOTENCY_KEY))
    expect(text).not.toContain(IDEMPOTENCY_KEY)
    expect(text).toContain(maskSecretRef())
    expect(text).not.toContain(SECRET_REF_VALUE)
    expect(text).not.toContain(RAW_PATH)
    // O dry-run mantém o usuário na etapa: a revisão de segurança é explícita.
    expect(container.querySelector('#pcv2-wizard-heading')?.textContent).toBe(
      WIZARD_STEPS[2].heading,
    )
    expect(
      container.querySelector('[data-testid="pcv2-artifacts"]'),
    ).not.toBeNull()

    await interact(() => {
      buttonByText(container, 'Revisar segurança').click()
    })
    expect(
      container.querySelector('[data-testid="pcv2-security-gates"]'),
    ).not.toBeNull()
    expect(container.querySelector('#pcv2-wizard-heading')?.textContent).toBe(
      WIZARD_STEPS[3].heading,
    )

    await interact(() => {
      buttonByText(container, 'Solicitar aprovação').click()
    })
    expect(container.querySelector('#pcv2-wizard-heading')?.textContent).toBe(
      WIZARD_STEPS[4].heading,
    )
    expect(
      container.querySelector('[data-testid="pcv2-approval-summary"]'),
    ).not.toBeNull()
  })

  it('copia o plano mascarado sem path absoluto, segredo ou chave integral', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const client = fakeClient()
    const container = await renderInto(
      <>
        <ProjectCenterV2Wizard client={client} />
        <Toaster />
      </>,
    )
    await fillContext(container)
    await interact(() => {
      buttonByText(container, 'Gerar dry-run').click()
    })
    await interact(() => {
      buttonByText(container, 'Gerar dry-run').click()
    })
    await interact(() => {
      buttonByText(container, 'Baixar plano sanitizado').click()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    const payload = String(writeText.mock.calls[0][0])
    expect(payload).toContain(maskOpaqueIdentifier(PLAN_HASH, 4))
    expect(payload).toContain('nenhum segredo, path absoluto')
    expect(payload).not.toContain(PLAN_HASH)
    expect(payload).not.toContain(SECRET_REF_VALUE)
    expect(payload).not.toContain(RAW_PATH)
    expect(payload).not.toContain(IDEMPOTENCY_KEY)
    expect(payload).not.toMatch(/\/(home|etc|var)\//)
    // O toast de sucesso também não vaza o que foi mascarado (renderiza em
    // portal, fora do container do wizard).
    expect(document.body.textContent).toContain('Plano sanitizado de')
    expect(document.body.textContent).not.toContain(RAW_PATH)
    expect(document.body.textContent).not.toContain(SECRET_REF_VALUE)
  })

  it('lista os gates de segurança com severidade antes da aprovação', async () => {
    const client = fakeClient()
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await reachApprovalStep(container)
    await interact(() => {
      buttonByText(container, 'Voltar etapa').click()
    })

    const gates = requireElement(
      container,
      '[data-testid="pcv2-security-gates"]',
    )
    expect(gates.querySelectorAll('li').length).toBeGreaterThanOrEqual(4)
    expect(gates.textContent).toContain('P0')
    expect(gates.textContent).toContain('P1')
    expect(gates.textContent).toContain('dry-run válido antes da aprovação')
    expect(container.querySelector('#pcv2-wizard-heading')?.textContent).toBe(
      WIZARD_STEPS[3].heading,
    )
    expect(buttonByText(container, 'Solicitar aprovação').disabled).toBe(false)
  })

  it('rejeita o plano com motivo e sem hash/confirmação no payload', async () => {
    const client = fakeClient({
      approveOperation: vi.fn().mockResolvedValue({
        operation: operationFixture({ state: 'rejected' }),
        replayed: false,
        requestId: 'req-1',
      }),
    })
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await reachApprovalStep(container)

    const reject = buttonByText(container, 'Rejeitar plano')
    expect(reject.disabled).toBe(true)
    await interact(() => {
      setField(container, '#pcv2-reject-reason', 'plano com risco não aceito')
    })
    const enabled = buttonByText(container, 'Rejeitar plano')
    expect(enabled.disabled).toBe(false)
    await interact(() => {
      enabled.click()
    })

    const [operationId, payload, version] = vi.mocked(client.approveOperation)
      .mock.calls[0]
    expect(operationId).toBe(OPERATION_ID)
    expect(version).toBe(3)
    expect(payload).toEqual({
      decision: 'reject',
      reason: 'plano com risco não aceito',
    })
    expect(JSON.stringify(payload)).not.toContain(PLAN_HASH)
  })

  it('só enfileira execução com frase exata e revisão confirmada', async () => {
    const client = fakeClient({
      approveOperation: vi.fn().mockResolvedValue({
        operation: operationFixture({ state: 'approved' }),
        replayed: false,
        requestId: 'req-1',
      }),
    })
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await reachApprovalStep(container)

    // Aprovação usa o hash do plano; a execução usa a frase de provisionamento.
    const approvePhrase = approvalPhrase('je4ndev-projeto-isolado', PLAN_HASH)
    const phrase = provisioningPhrase('je4ndev-projeto-isolado', 'development')
    const approve = buttonByText(container, 'Aprovar plano')
    expect(approve.disabled).toBe(true)
    await interact(() => {
      setField(container, '#pcv2-approve-phrase', approvePhrase)
    })
    const approvable = buttonByText(container, 'Aprovar plano')
    expect(approvable.disabled).toBe(false)
    await interact(() => {
      approvable.click()
    })

    expect(executionCta(container).disabled).toBe(true)

    await interact(() => {
      setField(container, '#pcv2-execute-phrase', 'frase errada')
    })
    expect(executionCta(container).disabled).toBe(true)

    await interact(() => {
      setField(container, '#pcv2-execute-phrase', phrase)
      requireElement(container, '#pcv2-execute-reviewed').click()
    })
    const ready = executionCta(container)
    expect(ready.disabled).toBe(false)
    await interact(() => {
      ready.click()
    })

    expect(client.executeOperation).toHaveBeenCalledWith(
      OPERATION_ID,
      PLAN_HASH,
      3,
    )
  })

  it('mostra estado negado quando o servidor responde 403 (sem inferir permissão)', async () => {
    const client = fakeClient({
      approveOperation: vi.fn().mockRejectedValue(
        new ProjectCenterV2ApiError({
          code: 'FORBIDDEN',
          details: [],
          message: 'sem escopo project:approve',
          requestId: 'req-403',
          retryAfterSeconds: null,
          retryable: false,
          status: 403,
        }),
      ),
    })
    const container = await renderInto(
      <ProjectCenterV2Wizard client={client} />,
    )
    await reachApprovalStep(container)

    await interact(() => {
      setField(
        container,
        '#pcv2-reject-reason',
        'não tenho escopo para aprovar',
      )
    })
    await interact(() => {
      buttonByText(container, 'Rejeitar plano').click()
    })

    const denied = requireElement(container, '[data-testid="pcv2-denied"]')
    expect(denied.getAttribute('aria-live')).toBe('polite')
    expect(container.textContent).toContain('não aprovar/executar')
    expect(container.textContent).toContain('project_approver')
    expect(container.textContent).toContain('project:approve')
    expect(container.textContent).toContain('decidida pelo servidor')
  })
})
