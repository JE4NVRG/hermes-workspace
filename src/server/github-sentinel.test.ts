import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGitHubTelegramMessage,
  handleGitHubWebhook,
  readGitHubSentinelHealth,
  readGitHubSentinelPublicHealth,
  verifyGitHubSignature,
} from './github-sentinel'

const originalEnv = { ...process.env }
let tempRoot = ''

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function requestFor(event: string, body: string, signature = sign(body, 'secret')): Request {
  return new Request('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `delivery-${event}`,
      'x-hub-signature-256': signature,
    },
    body,
  })
}

function oversizedRequest(body: string, contentLength: string | null = String(body.length)): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': 'delivery-oversized',
    'x-hub-signature-256': sign(body, 'secret'),
  }
  if (contentLength !== null) headers['content-length'] = contentLength
  return new Request('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers,
    body,
  })
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'github-sentinel-'))
  process.env = { ...originalEnv }
  process.env.HERMES_WORKSPACE_STATE_DIR = join(tempRoot, 'state')
  process.env.HERMES_GITHUB_SENTINEL_ENABLED = '1'
  process.env.HERMES_GITHUB_WEBHOOK_SECRET = 'secret'
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.HERMES_TELEGRAM_BOT_TOKEN
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env = { ...originalEnv }
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('github sentinel', () => {
  it('accepts valid HMAC SHA-256 signatures', () => {
    const body = new TextEncoder().encode('{"ok":true}')
    expect(verifyGitHubSignature(body, sign('{"ok":true}', 'secret'), 'secret')).toBe(true)
  })

  it('rejects invalid HMAC SHA-256 signatures', () => {
    const body = new TextEncoder().encode('{"ok":true}')
    expect(verifyGitHubSignature(body, 'sha256=bad', 'secret')).toBe(false)
  })

  it('rejects webhook requests with an invalid HMAC signature and stores a safe status', async () => {
    const body = '{"repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    const response = await handleGitHubWebhook(requestFor('push', body, 'sha256=bad'))
    const health = readGitHubSentinelHealth()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'invalid_github_signature',
    })
    expect(health.lastDelivery).toMatchObject({
      event: 'push',
      status: 'rejected',
      reason: 'invalid_github_signature',
    })
    expect(JSON.stringify(health.lastDelivery)).not.toContain('secret')
  })

  it('returns a secure error when sentinel is enabled without a secret', async () => {
    process.env.HERMES_GITHUB_WEBHOOK_SECRET = ''
    const body = '{"repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    const response = await handleGitHubWebhook(requestFor('push', body, ''))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'github_webhook_secret_not_configured',
    })
  })

  it('rejects webhook requests with non-JSON content types', async () => {
    const body = '{"repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'
    const response = await handleGitHubWebhook(new Request('http://localhost/api/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-wrong-content-type',
        'x-hub-signature-256': sign(body, 'secret'),
      },
      body,
    }))

    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'unsupported_media_type',
    })
  })

  it('rejects oversized payloads from content-length before signature and JSON processing', async () => {
    const body = '{"repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    const response = await handleGitHubWebhook(oversizedRequest(body, '1048577'))

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'payload_too_large',
    })
    expect(readGitHubSentinelHealth().deliveryCount).toBe(0)
  })

  it('rejects oversized payloads without content-length while reading the stream', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'JE4NVRG/workspace' },
      sender: { login: 'jean' },
      commits: [{ id: 'abcdef123456', message: 'x'.repeat(1_048_576), author: { username: 'jean' } }],
    })

    const response = await handleGitHubWebhook(oversizedRequest(body, null))

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'payload_too_large',
    })
    expect(readGitHubSentinelHealth().deliveryCount).toBe(0)
  })

  it('rejects insecure webhook bypass in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.HERMES_GITHUB_WEBHOOK_SECRET = ''
    process.env.HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE = '1'
    const body = '{"repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    const response = await handleGitHubWebhook(requestFor('push', body, ''))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'github_webhook_secret_not_configured',
    })
  })

  it('accepts GitHub ping payloads and persists delivery status without Telegram', async () => {
    const body = '{"zen":"Keep it logically awesome.","repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    const response = await handleGitHubWebhook(requestFor('ping', body))
    const json = await response.json() as { data: { event: string; sent: boolean; skipped: boolean; reason: string } }
    const health = readGitHubSentinelHealth()

    expect(response.status).toBe(200)
    expect(json.data).toMatchObject({ event: 'ping', sent: false, skipped: true, reason: 'ping' })
    expect(health.deliveryCount).toBe(1)
    expect(health.lastDelivery).toMatchObject({ event: 'ping', status: 'accepted', repository: 'JE4NVRG/workspace' })
  })

  it('accepts push payloads, sends escaped Telegram HTML, and persists delivery status', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'JE4NVRG/workspace' },
      ref: 'refs/heads/main',
      sender: { login: 'jean' },
      compare: 'https://github.com/JE4NVRG/workspace/compare/a...b',
      commits: [
        {
          id: 'abcdef123456',
          message: '<script>secret</script> implement webhook',
          author: { username: 'jean' },
        },
      ],
    })
    process.env.TELEGRAM_BOT_TOKEN = 'token'
    process.env.TELEGRAM_CHAT_ID = '-100123'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const response = await handleGitHubWebhook(requestFor('push', body))
    const json = await response.json() as { data: { sent: boolean; persisted: boolean } }
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { text: string }
    const health = readGitHubSentinelHealth()

    expect(response.status).toBe(200)
    expect(json.data).toMatchObject({ sent: true, persisted: true })
    expect(sentBody.text).toContain('GitHub push')
    expect(sentBody.text).toContain('&lt;script&gt;secret&lt;/script&gt;')
    expect(sentBody.text).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(health.lastDelivery).toMatchObject({ event: 'push', status: 'accepted', telegramSent: true })
  })

  it('does not send Telegram again for an already accepted delivery id', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'JE4NVRG/workspace' },
      ref: 'refs/heads/main',
      sender: { login: 'jean' },
      commits: [{ id: 'abcdef123456', message: 'implement webhook', author: { username: 'jean' } }],
    })
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token'
    process.env.TELEGRAM_CHAT_ID = '-100123'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const first = await handleGitHubWebhook(requestFor('push', body))
    const second = await handleGitHubWebhook(requestFor('push', body))
    const secondJson = await second.json() as { data: { sent: boolean; skipped: boolean; reason: string } }

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(secondJson.data).toMatchObject({ sent: false, skipped: true, reason: 'duplicate_delivery' })
    expect(readGitHubSentinelHealth().deliveryCount).toBe(1)
  })

  it('accepts generic GitHub events instead of dropping subscribed hook events', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'JE4NVRG/workspace' },
      sender: { login: 'jean' },
      ref_type: 'branch',
      ref: 'repo-sentinel-cutover-test',
    })
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token'
    process.env.TELEGRAM_CHAT_ID = '-100123'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const response = await handleGitHubWebhook(requestFor('delete', body))
    const json = await response.json() as { data: { event: string; sent: boolean; skipped: boolean; reason: string | null } }
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { text: string }
    const health = readGitHubSentinelHealth()

    expect(response.status).toBe(200)
    expect(json.data).toMatchObject({ event: 'delete', sent: true, skipped: false, reason: null })
    expect(sentBody.text).toContain('GitHub delete')
    expect(health.lastDelivery).toMatchObject({ event: 'delete', status: 'accepted', telegramSent: true })
  })

  it('records generic Telegram network failures with a timeout signal and without leaking raw errors', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'JE4NVRG/workspace' },
      ref: 'refs/heads/main',
      sender: { login: 'jean' },
      commits: [{ id: 'abcdef123456', message: 'implement webhook', author: { username: 'jean' } }],
    })
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token'
    process.env.TELEGRAM_CHAT_ID = '-100123'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('raw token leak risk'))

    const response = await handleGitHubWebhook(requestFor('push', body))
    const json = await response.json() as { data: { sent: boolean; skipped: boolean; reason: string } }
    const fetchInit = fetchMock.mock.calls[0]?.[1]
    const health = readGitHubSentinelHealth()

    expect(response.status).toBe(200)
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal)
    expect(json.data).toMatchObject({ sent: false, skipped: false, reason: 'telegram_network_error' })
    expect(health.lastDelivery).toMatchObject({ status: 'failed', reason: 'telegram_network_error' })
    expect(JSON.stringify(health.lastDelivery)).not.toContain('raw token leak risk')
  })

  it('keeps public health free of last delivery metadata', async () => {
    const body = '{"zen":"Keep it logically awesome.","repository":{"full_name":"JE4NVRG/workspace"},"sender":{"login":"jean"}}'

    await handleGitHubWebhook(requestFor('ping', body))

    expect(readGitHubSentinelPublicHealth()).toEqual({ ok: true })
    expect(JSON.stringify(readGitHubSentinelPublicHealth())).not.toContain('lastDelivery')
    expect(JSON.stringify(readGitHubSentinelPublicHealth())).not.toContain('JE4NVRG/workspace')
  })

  it('formats pull request and workflow run payloads safely', () => {
    const prMessage = buildGitHubTelegramMessage('pull_request', {
      repository: { full_name: 'JE4NVRG/workspace' },
      sender: { login: 'jean' },
      action: 'opened',
      pull_request: {
        number: 7,
        title: '<b>unsafe</b>',
        html_url: 'https://github.com/JE4NVRG/workspace/pull/7',
        head: { ref: 'feature' },
        base: { ref: 'main' },
      },
    })
    const workflowMessage = buildGitHubTelegramMessage('workflow_run', {
      repository: { full_name: 'JE4NVRG/workspace' },
      sender: { login: 'jean' },
      workflow_run: {
        name: 'CI <main>',
        status: 'completed',
        conclusion: 'success',
        head_branch: 'main',
        html_url: 'https://github.com/JE4NVRG/workspace/actions/runs/1',
      },
    })

    expect(prMessage).toContain('GitHub PR opened')
    expect(prMessage).toContain('&lt;b&gt;unsafe&lt;/b&gt;')
    expect(workflowMessage).toContain('GitHub workflow')
    expect(workflowMessage).toContain('CI &lt;main&gt;')
  })
})
