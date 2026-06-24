import { createFileRoute } from '@tanstack/react-router'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BEARER_TOKEN, CLAUDE_API } from '../../../server/gateway-capabilities'
import { isAuthenticated } from '../../../server/auth-middleware'

function hermesHome(): string {
  return (
    process.env.HERMES_HOME ??
    process.env.CLAUDE_HOME ??
    path.join(os.homedir(), '.hermes')
  )
}

function parseDotenvValue(rawLine: string): [string, string] | null {
  const line = rawLine.trim()
  if (!line || line.startsWith('#') || !line.includes('=')) return null
  const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
  const eq = withoutExport.indexOf('=')
  if (eq <= 0) return null
  const key = withoutExport.slice(0, eq).trim()
  let value = withoutExport.slice(eq + 1).trim()
  if (
    (value.startsWith('\"') && value.endsWith('\"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return [key, value]
}

function readDotenvValue(keys: string[]): string {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(hermesHome(), '.env'),
  ]
  const seen = new Set<string>()
  for (const file of candidates) {
    if (seen.has(file)) continue
    seen.add(file)
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseDotenvValue(line)
        if (!parsed) continue
        const [key, value] = parsed
        if (keys.includes(key) && value) return value
      }
    } catch {
      // Missing/unreadable .env is fine; process.env is preferred.
    }
  }
  return ''
}

function gatewayBearerToken(): string {
  return (
    process.env.HERMES_API_TOKEN ||
    process.env.CLAUDE_API_TOKEN ||
    process.env.API_SERVER_KEY ||
    readDotenvValue([
      'HERMES_API_TOKEN',
      'CLAUDE_API_TOKEN',
      'API_SERVER_KEY',
    ]) ||
    BEARER_TOKEN
  )
}

/**
 * Vanilla hermes-agent (any version through 2026-05) does not expose
 * `/api/available-models` — that's a legacy fork-only endpoint. When the
 * proxy gets a 404, synthesize a compatible response from `/v1/models`
 * filtered by provider so the chat composer / settings dialog don't
 * silently break for users on vanilla agent.
 */
async function fallbackAvailableModels(
  provider: string,
  authHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const res = await fetch(`${CLAUDE_API}/v1/models`, { headers: authHeaders })
    if (!res.ok) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const list = Array.isArray(data?.data) ? data.data : []
    const wanted = provider.toLowerCase()
    const models = list
      .map((m) => {
        const id = typeof m.id === 'string' ? m.id : ''
        if (!id) return null
        const owned =
          typeof m.owned_by === 'string' ? m.owned_by.toLowerCase() : ''
        const idProvider = id.includes('/')
          ? id.split('/')[0].toLowerCase()
          : owned
        if (wanted && idProvider !== wanted) return null
        return { id }
      })
      .filter((m): m is { id: string } => Boolean(m))
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function proxyRequest(request: Request, splat: string) {
  const incomingUrl = new URL(request.url)
  const targetPath = splat.startsWith('/') ? splat : `/${splat}`
  const targetUrl = new URL(`${CLAUDE_API}${targetPath}`)
  targetUrl.search = incomingUrl.search

  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')
  // Read at request time — follows the same fix as PR #234.
  const bearer = gatewayBearerToken()
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    init.body = await request.text()
  }

  const upstream = await fetch(targetUrl, init)
  // Vanilla agent fallback for /api/available-models — synthesize from /v1/models.
  if (
    upstream.status === 404 &&
    request.method.toUpperCase() === 'GET' &&
    /\/api\/available-models\b/.test(targetPath)
  ) {
    const provider = incomingUrl.searchParams.get('provider') || ''
    const authHeaders: Record<string, string> = bearer
      ? { Authorization: `Bearer ${bearer}` }
      : {}
    return fallbackAvailableModels(provider, authHeaders)
  }

  const body = await upstream.text()
  const responseHeaders = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) responseHeaders.set('content-type', contentType)
  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

export const Route = createFileRoute('/api/claude-proxy/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Unauthorized' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        return proxyRequest(request, params._splat || '')
      },
    },
  },
})
