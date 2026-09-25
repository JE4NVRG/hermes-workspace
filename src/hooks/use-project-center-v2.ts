/**
 * Hooks do Project Center v2 (PR 5).
 *
 * - `useProjectCenterV2Surface`: flag **server-projected**. O cliente não lê
 *   env var, storage de token nem decide localmente; pergunta ao servidor e,
 *   sem confirmação, mantém a experiência atual (fail-closed).
 * - `useProjectCenterV2Operation`: acompanha uma operação persistida e
 *   retoma o job por `operation_id` após reload (polling só enquanto o estado
 *   pode mudar sem decisão humana).
 * - `useProjectCenterV2Action`: despacha as ações tipadas (dry-run, aprovação,
 *   execução, verificação e as três fases de rollback) reutilizando a
 *   `Idempotency-Key` da intenção.
 * - `usePrefersReducedMotion`: respeita `prefers-reduced-motion`.
 *
 * Sem `@tanstack/react-query` por decisão explícita: no Vitest 3 deste repo a
 * combinação React 19 + jsdom + react-query carrega uma segunda cópia de React
 * ("Invalid hook call"), o que tornaria qualquer teste de tela impossível — o
 * padrão documentado no repo (`React.act` + `createRoot`, ver
 * `src/screens/mcp/-marketplace-install-confirmation.test.tsx`) só funciona com
 * hooks de React puro. O estado aqui é local e explícito: a fonte canônica
 * continua sendo a operação persistida no servidor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  OperationCallResult,
  ProjectCenterV2ActionRequest,
  ProjectCenterV2Client,
  ProjectCenterV2Surface,
} from '@/lib/project-center-v2-api'
import type { Operation, OperationState } from '@/lib/project-center-v2-types'
import { createProjectCenterV2Client } from '@/lib/project-center-v2-api'
import { isTerminalOperationState } from '@/lib/project-center-v2-types'

/** Intervalo de polling da operação enquanto ela pode mudar sozinha. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000
/** Intervalo de reprojeção da flag server-projected. */
export const SURFACE_REFRESH_INTERVAL_MS = 60_000

let sharedClient: ProjectCenterV2Client | null = null

/** Cliente compartilhado do browser (sem credencial, sessão same-origin). */
export function resolveProjectCenterV2Client(
  overrides?: Partial<Parameters<typeof createProjectCenterV2Client>[0]>,
): ProjectCenterV2Client {
  if (overrides !== undefined) return createProjectCenterV2Client(overrides)
  sharedClient ??= createProjectCenterV2Client()
  return sharedClient
}

export function useProjectCenterV2Client(
  overrides?: Partial<Parameters<typeof createProjectCenterV2Client>[0]>,
): ProjectCenterV2Client {
  // `overrides` é comparado por identidade: passe um objeto estável (memo) ou
  // omita para usar o cliente compartilhado.
  return useMemo(() => resolveProjectCenterV2Client(overrides), [overrides])
}

function toError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught))
}

/**
 * Superfície v2 projetada pelo servidor. `apiEnabled: false` = flag off (seja
 * por `403 feature_disabled`, seja porque o servidor não respondeu: fail-closed).
 */
export function useProjectCenterV2Surface(client?: ProjectCenterV2Client): {
  readonly surface: ProjectCenterV2Surface | null
  readonly apiEnabled: boolean
  readonly isLoading: boolean
  readonly isError: boolean
  readonly refetch: () => void
} {
  const resolved = useProjectCenterV2Client()
  const target = client ?? resolved
  const [surface, setSurface] = useState<ProjectCenterV2Surface | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isError, setIsError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => {
    setNonce((current) => current + 1)
  }, [])

  useEffect(() => {
    // Objeto mutável: o TS não estreita propriedades como estreita locais, então
    // o guard de cancelamento continua sendo verificado em runtime.
    const lifecycle = { cancelled: false }
    let timer: ReturnType<typeof setTimeout> | null = null
    void (async () => {
      try {
        const result = await target.surface()
        if (lifecycle.cancelled) return
        setSurface(result)
        setIsError(false)
        timer = setTimeout(() => {
          setNonce((current) => current + 1)
        }, SURFACE_REFRESH_INTERVAL_MS)
      } catch {
        if (lifecycle.cancelled) return
        setIsError(true)
        setSurface({
          apiEnabled: false,
          source: 'unavailable',
          workerEnabled: null,
        })
      } finally {
        if (!lifecycle.cancelled) setIsLoading(false)
      }
    })()
    return () => {
      lifecycle.cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [target, nonce])

  return {
    apiEnabled: surface?.apiEnabled === true,
    isError,
    isLoading,
    refetch,
    surface,
  }
}

/**
 * Polling só enquanto a operação pode mudar sem ação humana. Estado terminal e
 * `awaiting_approval` (que depende de decisão) não geram tráfego.
 */
export function shouldPollOperationState(
  state: OperationState | undefined,
): boolean {
  if (state === undefined) return false
  return !isTerminalOperationState(state) && state !== 'awaiting_approval'
}

/**
 * Operação persistida, recuperável por `operation_id` após reload. O estado da
 * operação é do servidor: o hook nunca escreve estado, só o projeta.
 */
export function useProjectCenterV2Operation(
  operationId: string | null,
  client?: ProjectCenterV2Client,
): {
  readonly operation: Operation | null
  readonly call: OperationCallResult | null
  readonly isLoading: boolean
  readonly error: Error | null
  readonly refetch: () => void
} {
  const resolved = useProjectCenterV2Client()
  const target = client ?? resolved
  const [call, setCall] = useState<OperationCallResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(operationId !== null)
  const [nonce, setNonce] = useState(0)
  const mountedRef = useRef(true)
  const refetch = useCallback(() => {
    setNonce((current) => current + 1)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (operationId === null) {
      setCall(null)
      setError(null)
      setIsLoading(false)
      return undefined
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      setIsLoading(true)
      try {
        const result = await target.getOperation(operationId)
        if (cancelled) return
        setCall(result)
        setError(null)
        setIsLoading(false)
        if (shouldPollOperationState(result.operation.state)) {
          timer = setTimeout(() => {
            void tick()
          }, DEFAULT_POLL_INTERVAL_MS)
        }
      } catch (caught) {
        if (cancelled) return
        setError(toError(caught))
        setIsLoading(false)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [operationId, target, nonce])

  return {
    call,
    error,
    isLoading,
    operation: call?.operation ?? null,
    refetch,
  }
}

function dispatch(
  client: ProjectCenterV2Client,
  request: ProjectCenterV2ActionRequest,
): Promise<OperationCallResult> {
  switch (request.kind) {
    case 'dryRun':
      return client.dryRun(request.request)
    case 'approve':
      return client.approveOperation(
        request.operationId,
        request.request,
        request.operationVersion,
      )
    case 'execute':
      return client.executeOperation(
        request.operationId,
        request.planHash,
        request.operationVersion,
      )
    case 'verify':
      return client.verifyOperation(
        request.operationId,
        request.operationVersion,
        request.checks,
      )
    case 'rollbackDryRun':
      return client.rollbackDryRun(
        request.operationId,
        request.request,
        request.operationVersion,
      )
    case 'rollbackApprove':
      return client.rollbackApprove(
        request.operationId,
        request.request,
        request.operationVersion,
      )
    case 'rollbackExecute':
      return client.rollbackExecute(
        request.operationId,
        request.request,
        request.operationVersion,
      )
    default: {
      const exhaustive: never = request
      throw new Error(`ação desconhecida: ${String(exhaustive)}`)
    }
  }
}

/**
 * Ações tipadas do fluxo. `run` devolve a operação persistida resultante para
 * que a tela projete o novo estado; o erro do servidor é preservado (código
 * incluído) para a UI distinguir `403` de falha de rede.
 */
export function useProjectCenterV2Action(client?: ProjectCenterV2Client): {
  readonly run: (
    request: ProjectCenterV2ActionRequest,
  ) => Promise<OperationCallResult>
  readonly isPending: boolean
  readonly error: Error | null
  readonly reset: () => void
} {
  const resolved = useProjectCenterV2Client()
  const target = client ?? resolved
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)
  const reset = useCallback(() => {
    setError(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(
    async (
      request: ProjectCenterV2ActionRequest,
    ): Promise<OperationCallResult> => {
      setIsPending(true)
      setError(null)
      try {
        const result = await dispatch(target, request)
        if (mountedRef.current) setIsPending(false)
        return result
      } catch (caught) {
        const failure = toError(caught)
        if (mountedRef.current) {
          setError(failure)
          setIsPending(false)
        }
        throw failure
      }
    },
    [target],
  )

  return {
    error,
    isPending,
    reset,
    run,
  }
}

/**
 * `prefers-reduced-motion`: quando verdadeiro o wizard desliga animação e
 * publica `data-reduced-motion` no container (progresso nunca depende de
 * animação).
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(() =>
    readReducedMotion(),
  )

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return undefined
    }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      setPrefersReduced(media.matches)
    }
    onChange()
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])

  return prefersReduced
}

function readReducedMotion(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
