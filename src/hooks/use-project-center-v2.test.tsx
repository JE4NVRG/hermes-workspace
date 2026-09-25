// @vitest-environment jsdom
/**
 * Testes dos hooks do Project Center v2 (PR 5).
 *
 * Usa `React.act` + `createRoot` diretamente (mesmo padrão de
 * `src/screens/mcp/-marketplace-install-confirmation.test.tsx`): com React 19 em
 * jsdom, o `@testing-library/react` carrega uma segunda cópia de React e todo
 * componente com hook falha com "Invalid hook call".
 *
 * Cobre: flag server-projected com fail-closed, polling só em estado que muda
 * sozinho, despacho tipado das ações e `prefers-reduced-motion`.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  shouldPollOperationState,
  usePrefersReducedMotion,
  useProjectCenterV2Action,
  useProjectCenterV2Operation,
  useProjectCenterV2Surface,
} from './use-project-center-v2'
import type { ProjectCenterV2Client } from '@/lib/project-center-v2-api'
import type { Operation } from '@/lib/project-center-v2-types'
import { createProjectCenterV2Client } from '@/lib/project-center-v2-api'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function operationFixture(overrides: Partial<Operation> = {}): Operation {
  return {
    audit_url: '/api/project-center/v2/operations/x/audit',
    created_at: '2026-09-25T10:00:00.000Z',
    driver: 'postgresql_isolated',
    environment: 'development',
    expires_at: '2026-09-25T11:00:00.000Z',
    operation_id: '11111111-1111-4111-8111-111111111111',
    operation_version: 2,
    plan: {
      actions: [],
      estimated_resources: {},
      policy_version: 'pcv2-policy-v1',
      warnings: [],
    },
    plan_hash: 'a'.repeat(64),
    project_id: 'je4ndev-projeto-isolado',
    state: 'executing',
    status_url: '/api/project-center/v2/operations/x',
    updated_at: '2026-09-25T10:00:05.000Z',
    ...overrides,
  }
}

function fakeClient(
  overrides: Partial<ProjectCenterV2Client> = {},
): ProjectCenterV2Client {
  return {
    approveOperation: vi.fn(),
    dryRun: vi.fn(),
    executeOperation: vi.fn(),
    getOperation: vi.fn(),
    idempotencyKeyFor: vi.fn(() => null),
    listAudit: vi.fn(),
    rollbackApprove: vi.fn(),
    rollbackDryRun: vi.fn(),
    rollbackExecute: vi.fn(),
    surface: vi.fn(),
    verifyOperation: vi.fn(),
    ...overrides,
  } as ProjectCenterV2Client
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

/** Descarrega microtasks e timers de 0ms pendentes dentro de `act`. */
async function flush(): Promise<void> {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('shouldPollOperationState', () => {
  it('não faz polling em estado terminal nem aguardando decisão humana', () => {
    expect(shouldPollOperationState(undefined)).toBe(false)
    expect(shouldPollOperationState('awaiting_approval')).toBe(false)
    expect(shouldPollOperationState('rolled_back')).toBe(false)
    expect(shouldPollOperationState('cancelled')).toBe(false)
    expect(shouldPollOperationState('executing')).toBe(true)
    expect(shouldPollOperationState('verifying')).toBe(true)
    expect(shouldPollOperationState('failed')).toBe(true)
  })
})

describe('useProjectCenterV2Surface', () => {
  it('flag desligada permanece desligada', async () => {
    const client = fakeClient({
      surface: vi.fn().mockResolvedValue({
        apiEnabled: false,
        source: 'server',
        workerEnabled: null,
      }),
    })
    function Probe() {
      const value = useProjectCenterV2Surface(client)
      return (
        <span data-testid="surface">
          {value.apiEnabled ? 'on' : 'off'}|{value.surface?.source ?? 'none'}|
          {value.isLoading ? 'loading' : 'idle'}
        </span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(
      container.querySelector('[data-testid="surface"]')?.textContent,
    ).toBe('off|server|idle')
    await unmount()
  })

  it('flag ligada habilita a superfície v2', async () => {
    const client = fakeClient({
      surface: vi.fn().mockResolvedValue({
        apiEnabled: true,
        source: 'server',
        workerEnabled: false,
      }),
    })
    function Probe() {
      const value = useProjectCenterV2Surface(client)
      return (
        <span data-testid="surface">{value.apiEnabled ? 'on' : 'off'}</span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(
      container.querySelector('[data-testid="surface"]')?.textContent,
    ).toBe('on')
    await unmount()
  })

  it('cliente real com falha de rede mantém a experiência atual', async () => {
    const client = createProjectCenterV2Client({
      fetchImpl: () => Promise.reject(new Error('offline')),
    })
    function Probe() {
      const value = useProjectCenterV2Surface(client)
      return (
        <span data-testid="surface">
          {value.apiEnabled ? 'on' : 'off'}|{value.surface?.source ?? 'none'}|
          {value.isError ? 'error' : 'ok'}
        </span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(
      container.querySelector('[data-testid="surface"]')?.textContent,
    ).toBe('off|unavailable|ok')
    await unmount()
  })
})

describe('useProjectCenterV2Operation', () => {
  it('não consulta nada sem operation_id', async () => {
    const client = fakeClient()
    function Probe() {
      const value = useProjectCenterV2Operation(null, client)
      return (
        <span data-testid="operation">
          {value.operation?.state ?? 'none'}|
          {value.isLoading ? 'loading' : 'idle'}
        </span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(
      container.querySelector('[data-testid="operation"]')?.textContent,
    ).toBe('none|idle')
    expect(client.getOperation).not.toHaveBeenCalled()
    await unmount()
  })

  it('recupera a operação persistida e não polla em estado terminal', async () => {
    vi.useFakeTimers()
    const getOperation = vi.fn().mockResolvedValue({
      operation: operationFixture({ state: 'rolled_back' }),
      replayed: false,
      requestId: 'req-1',
    })
    const client = fakeClient({ getOperation })
    function Probe() {
      const value = useProjectCenterV2Operation(
        '11111111-1111-4111-8111-111111111111',
        client,
      )
      return (
        <span data-testid="operation">{value.operation?.state ?? 'none'}</span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(
      container.querySelector('[data-testid="operation"]')?.textContent,
    ).toBe('rolled_back')
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(getOperation).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('continua pollando enquanto o estado pode mudar sozinho', async () => {
    vi.useFakeTimers()
    const getOperation = vi.fn().mockResolvedValue({
      operation: operationFixture({ state: 'executing' }),
      replayed: false,
      requestId: 'req-1',
    })
    const client = fakeClient({ getOperation })
    function Probe() {
      const value = useProjectCenterV2Operation(
        '11111111-1111-4111-8111-111111111111',
        client,
      )
      return (
        <span data-testid="operation">{value.operation?.state ?? 'none'}</span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getOperation).toHaveBeenCalledTimes(1)
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(getOperation.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(
      container.querySelector('[data-testid="operation"]')?.textContent,
    ).toBe('executing')
    await unmount()
  })

  it('expõe erro do servidor sem descartar a mensagem', async () => {
    const client = fakeClient({
      getOperation: vi.fn().mockRejectedValue(new Error('RATE_LIMITED')),
    })
    function Probe() {
      const value = useProjectCenterV2Operation(
        '11111111-1111-4111-8111-111111111111',
        client,
      )
      return (
        <span data-testid="operation">{value.error?.message ?? 'none'}</span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(
      container.querySelector('[data-testid="operation"]')?.textContent,
    ).toBe('RATE_LIMITED')
    await unmount()
  })
})

describe('useProjectCenterV2Action', () => {
  it('despacha verify com a revisão da operação', async () => {
    const verifyOperation = vi.fn().mockResolvedValue({
      operation: operationFixture({ state: 'verifying' }),
      replayed: false,
      requestId: 'req-1',
    })
    const client = fakeClient({ verifyOperation })
    const seen: Array<string> = []
    function Probe() {
      const action = useProjectCenterV2Action(client)
      return (
        <button
          type="button"
          data-testid="run"
          onClick={() => {
            void action
              .run({
                kind: 'verify',
                operationId: '11111111-1111-4111-8111-111111111111',
                operationVersion: 2,
              })
              .then((result) => {
                seen.push(result.operation.state)
              })
          }}
        >
          {action.isPending ? 'pending' : 'idle'}
        </button>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    const button = container.querySelector('[data-testid="run"]')
    await React.act(() => {
      ;(button as HTMLButtonElement).click()
    })
    await flush()
    expect(verifyOperation).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      2,
      undefined,
    )
    expect(seen).toEqual(['verifying'])
    expect(container.querySelector('[data-testid="run"]')?.textContent).toBe(
      'idle',
    )
    await unmount()
  })

  it('propaga erro tipado e publica em `error`', async () => {
    const executeOperation = vi.fn().mockRejectedValue(new Error('FORBIDDEN'))
    const client = fakeClient({ executeOperation })
    const failures: Array<string> = []
    function Probe() {
      const action = useProjectCenterV2Action(client)
      return (
        <button
          type="button"
          data-testid="run"
          onClick={() => {
            void action
              .run({
                kind: 'execute',
                operationId: '11111111-1111-4111-8111-111111111111',
                operationVersion: 1,
                planHash: 'a'.repeat(64),
              })
              .catch((error: Error) => {
                failures.push(error.message)
              })
          }}
        >
          {action.error?.message ?? 'sem-erro'}
        </button>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await React.act(() => {
      ;(
        container.querySelector('[data-testid="run"]') as HTMLButtonElement
      ).click()
    })
    await flush()
    expect(executeOperation).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'a'.repeat(64),
      1,
    )
    expect(failures).toEqual(['FORBIDDEN'])
    expect(container.querySelector('[data-testid="run"]')?.textContent).toBe(
      'FORBIDDEN',
    )
    await unmount()
  })
})

describe('usePrefersReducedMotion', () => {
  it('lê e acompanha prefers-reduced-motion', async () => {
    const listeners = new Set<() => void>()
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      return {
        addEventListener: (_event: string, handler: () => void) => {
          listeners.add(handler)
        },
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        removeEventListener: (_event: string, handler: () => void) => {
          listeners.delete(handler)
        },
      } as unknown as MediaQueryList
    })
    function Probe() {
      const prefersReduced = usePrefersReducedMotion()
      return (
        <span data-testid="motion">
          {prefersReduced ? 'reduced' : 'normal'}
        </span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(container.querySelector('[data-testid="motion"]')?.textContent).toBe(
      'reduced',
    )
    await unmount()
    expect(listeners.size).toBe(0)
  })

  it('sem matchMedia assume movimento normal', async () => {
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    })
    function Probe() {
      const prefersReduced = usePrefersReducedMotion()
      return (
        <span data-testid="motion">
          {prefersReduced ? 'reduced' : 'normal'}
        </span>
      )
    }
    const { container, unmount } = await renderInto(<Probe />)
    await flush()
    expect(container.querySelector('[data-testid="motion"]')?.textContent).toBe(
      'normal',
    )
    await unmount()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: original,
    })
  })
})
