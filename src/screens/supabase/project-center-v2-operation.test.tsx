// @vitest-environment jsdom
/**
 * Testes das projeções de operação do Project Center v2 (PR 5).
 *
 * Os componentes são de apresentação: consomem o estado canônico da operação e
 * nunca inventam estado. Aqui se verifica que artefatos sensíveis saem
 * mascarados, que a timeline usa a live region e que a lista de evidências
 * projeta a verificação persistida.
 *
 * Render: `React.act` + `createRoot` (React 19 em jsdom; ver
 * `src/screens/mcp/-marketplace-install-confirmation.test.tsx`).
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectCenterV2ArtifactList,
  ProjectCenterV2EvidenceList,
  ProjectCenterV2Timeline,
} from './project-center-v2-operation'
import type { ArtifactRef, Operation } from '@/lib/project-center-v2-types'
import { maskSecretRef } from '@/lib/project-center-v2-types'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Fixture sem literal de token no fonte: montada em runtime. */
const SECRET_REF_VALUE = `sref_${'D'.repeat(48)}`

function operationFixture(overrides: Partial<Operation> = {}): Operation {
  return {
    artifacts: [],
    audit_url: '/api/project-center/v2/operations/x/audit',
    created_at: '2026-09-25T10:00:00.000Z',
    driver: 'postgresql_isolated',
    environment: 'development',
    expires_at: '2026-09-25T11:00:00.000Z',
    operation_id: '11111111-1111-4111-8111-111111111111',
    operation_version: 4,
    plan: {
      actions: [],
      estimated_resources: {},
      policy_version: 'pcv2-policy-v1',
      warnings: [],
    },
    plan_hash: 'b'.repeat(64),
    project_id: 'je4ndev-projeto-isolado',
    state: 'executing',
    status_url: '/api/project-center/v2/operations/x',
    updated_at: '2026-09-25T10:00:05.000Z',
    ...overrides,
  }
}

let activeCleanup: (() => Promise<void>) | null = null

async function renderInto(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(() => {
    root.render(element)
  })
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
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
})

describe('ProjectCenterV2ArtifactList', () => {
  it('nunca renderiza o valor integral de uma referência opaca', async () => {
    const artifacts: ReadonlyArray<ArtifactRef> = [
      { ref: 'je4ndev_projeto_isolado', status: 'created', type: 'database' },
      { ref: SECRET_REF_VALUE, status: 'planned', type: 'secret_ref' },
    ]
    const container = await renderInto(
      <ProjectCenterV2ArtifactList artifacts={artifacts} />,
    )

    const text = container.textContent
    expect(text).toContain(maskSecretRef())
    expect(text).not.toContain(SECRET_REF_VALUE)
    expect(text).toContain('valor integral nunca é renderizado')
    expect(text).toContain('je4ndev_projeto_isolado')
    expect(text).toContain('created')
  })

  it('não renderiza nada quando não há artefatos', async () => {
    const container = await renderInto(
      <ProjectCenterV2ArtifactList artifacts={[]} />,
    )
    expect(container.querySelector('[data-testid="pcv2-artifacts"]')).toBeNull()
  })
})

describe('ProjectCenterV2EvidenceList', () => {
  it('projeta as checagens persistidas da verificação', async () => {
    const container = await renderInto(
      <ProjectCenterV2EvidenceList
        verification={{
          checks: [
            {
              name: 'porta não pública',
              outcome: 'passed',
              safe_detail: '5432 fechada para 0.0.0.0/0',
            },
            { name: 'isolamento entre clientes', outcome: 'inconclusive' },
          ],
          observed_at: '2026-09-25T10:05:00.000Z',
          outcome: 'inconclusive',
        }}
      />,
    )
    const text = container.textContent
    expect(text).toContain('porta não pública')
    expect(text).toContain('5432 fechada para 0.0.0.0/0')
    expect(text).toContain('isolamento entre clientes')
  })

  it('sem verificação mostra o estado pendente sem inventar dados', async () => {
    const container = await renderInto(
      <ProjectCenterV2EvidenceList verification={null} />,
    )
    expect(container.textContent.trim().length).toBeGreaterThan(0)
  })
})

describe('ProjectCenterV2Timeline', () => {
  it('anuncia mudança de estado em live region e projeta o estado canônico', async () => {
    const container = await renderInto(
      <ProjectCenterV2Timeline operation={operationFixture()} />,
    )
    const announcement = container.querySelector(
      '[data-testid="pcv2-timeline-announcement"]',
    )
    expect(announcement?.getAttribute('aria-live')).toBe('polite')
    expect(announcement?.getAttribute('role')).toBe('status')
    expect(announcement?.textContent).toBe('Estado atual: Provisionando')
    expect(container.textContent).toContain('Timeline da operação')
    expect(
      container.querySelectorAll('ol > li[data-outcome="active"]').length,
    ).toBe(1)
  })

  it('desliga a animação do passo ativo com movimento reduzido', async () => {
    const animated = await renderInto(
      <ProjectCenterV2Timeline operation={operationFixture()} />,
    )
    expect(
      animated
        .querySelector('li[data-outcome="active"]')
        ?.className.includes('animate-pulse'),
    ).toBe(true)
    await activeCleanup?.()
    activeCleanup = null

    const still = await renderInto(
      <ProjectCenterV2Timeline
        operation={operationFixture({ state: 'rolled_back' })}
        reducedMotion
      />,
    )
    expect(still.textContent).toContain('Rollback concluído')
    expect(
      still
        .querySelector('li[data-outcome="active"]')
        ?.className.includes('animate-pulse') ?? false,
    ).toBe(false)
  })
})
