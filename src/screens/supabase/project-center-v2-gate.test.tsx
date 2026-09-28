// @vitest-environment jsdom
/**
 * Testes do gate da superfície v2 (PR 5).
 *
 * A flag é **server-projected**: nada de v2 aparece enquanto o servidor não
 * confirmar a superfície e, em erro/indisponibilidade, a experiência atual
 * permanece intacta (fail-closed).
 *
 * Padrão de render: `React.act` + `createRoot` (React 19 em jsdom; ver
 * `src/screens/mcp/-marketplace-install-confirmation.test.tsx`).
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ProjectCenterV2Gate } from './project-center-v2-gate'
import type { ProjectCenterV2Client } from '@/lib/project-center-v2-api'

function fakeClient(
  overrides: Partial<ProjectCenterV2Client> = {},
): ProjectCenterV2Client {
  return { surface: vi.fn(), ...overrides } as ProjectCenterV2Client
}

async function renderInto(element: React.ReactElement): Promise<{
  readonly container: HTMLElement
  readonly unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(() => {
    root.render(element)
  })
  return {
    container,
    unmount: async () => {
      await React.act(() => {
        root.unmount()
      })
      document.body.removeChild(container)
    },
  }
}

async function flush(): Promise<void> {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ProjectCenterV2Gate', () => {
  it('flag desligada preserva exatamente a experiência atual', async () => {
    const { container, unmount } = await renderInto(
      <ProjectCenterV2Gate
        fallback={<p data-testid="legado">Experiência atual</p>}
        surface={{ apiEnabled: false, source: 'server', workerEnabled: null }}
      >
        <p data-testid="v2">Novo wizard</p>
      </ProjectCenterV2Gate>,
    )
    expect(container.textContent).toContain('Experiência atual')
    expect(container.querySelector('[data-testid="v2"]')).toBeNull()
    await unmount()
  })

  it('flag ligada renderiza a superfície v2', async () => {
    const { container, unmount } = await renderInto(
      <ProjectCenterV2Gate
        fallback={<p data-testid="legado">Experiência atual</p>}
        surface={{ apiEnabled: true, source: 'server', workerEnabled: false }}
      >
        <p data-testid="v2">Novo wizard</p>
      </ProjectCenterV2Gate>,
    )
    expect(container.querySelector('[data-testid="v2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="legado"]')).toBeNull()
    await unmount()
  })

  it('sem projeção do servidor o gate fica invisível', async () => {
    const client = fakeClient({
      surface: vi.fn().mockResolvedValue({
        apiEnabled: false,
        source: 'server',
        workerEnabled: null,
      }),
    })
    const { container, unmount } = await renderInto(
      <ProjectCenterV2Gate
        client={client}
        fallback={<p data-testid="legado">Experiência atual</p>}
      >
        <p data-testid="v2">Novo wizard</p>
      </ProjectCenterV2Gate>,
    )
    await flush()
    expect(container.querySelector('[data-testid="v2"]')).toBeNull()
    expect(container.textContent).toContain('Experiência atual')
    await unmount()
  })

  it('falha do servidor mantém a experiência atual', async () => {
    const client = fakeClient({
      surface: vi.fn().mockRejectedValue(new Error('offline')),
    })
    const { container, unmount } = await renderInto(
      <ProjectCenterV2Gate
        client={client}
        fallback={<p data-testid="legado">Experiência atual</p>}
      >
        <p data-testid="v2">Novo wizard</p>
      </ProjectCenterV2Gate>,
    )
    await flush()
    expect(container.querySelector('[data-testid="v2"]')).toBeNull()
    expect(container.textContent).toContain('Experiência atual')
    await unmount()
  })
})
