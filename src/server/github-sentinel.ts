import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getStateDir } from './workspace-state-dir'

export type GitHubSentinelEvent = string

export type TelegramSendResult = {
  sent: boolean
  skipped: boolean
  reason: string | null
}

export type GitHubDeliveryStatus = {
  deliveryId: string
  event: string
  status: 'accepted' | 'rejected' | 'skipped' | 'failed'
  repository: string
  sender: string
  summary: string
  telegramSent: boolean
  telegramSkipped: boolean
  reason: string | null
  receivedAt: string
}

type DeliveryStore = {
  deliveries: Array<GitHubDeliveryStatus>
}

type GitHubPayload = Record<string, unknown>

const MAX_GITHUB_WEBHOOK_BYTES = 1_048_576
const TELEGRAM_FETCH_TIMEOUT_MS = 5_000

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large')
  }
}

function boolFromEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

export function isGitHubSentinelEnabled(): boolean {
  return boolFromEnv(
    process.env.HERMES_GITHUB_SENTINEL_ENABLED ?? process.env.GITHUB_SENTINEL_ENABLED,
    false,
  )
}

export function getGitHubWebhookSecret(): string {
  return (process.env.HERMES_GITHUB_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? '').trim()
}

function allowInsecureWebhook(): boolean {
  const environment = (process.env.NODE_ENV ?? process.env.HERMES_ENV ?? '').trim().toLowerCase()
  if (environment === 'production') return false
  return boolFromEnv(
    process.env.HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE ?? process.env.GITHUB_WEBHOOK_ALLOW_INSECURE,
    false,
  )
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  return contentType.split(';').some((part) => part.trim() === 'application/json')
}

function parseContentLength(request: Request): number | null {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return null
  const parsed = Number(contentLength)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

async function readLimitedBody(request: Request, maxBytes = MAX_GITHUB_WEBHOOK_BYTES): Promise<Uint8Array> {
  const contentLength = parseContentLength(request)
  if (contentLength !== null && contentLength > maxBytes) throw new PayloadTooLargeError()

  if (!request.body) return new Uint8Array(await request.arrayBuffer())

  const reader = request.body.getReader()
  const chunks: Array<Uint8Array> = []
  let totalBytes = 0
  try {
    let done = false
    while (!done) {
      const result = await reader.read()
      done = result.done
      const value = result.value
      if (!done && value) {
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) throw new PayloadTooLargeError()
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}

function firstLine(value: unknown, maxLength: number): string {
  return String(value ?? '').split(/\r?\n/)[0]?.slice(0, maxLength) ?? ''
}

function shortSha(value: unknown): string {
  return String(value ?? '').slice(0, 7)
}

function repositoryName(payload: GitHubPayload): string {
  return String(asRecord(payload.repository).full_name ?? 'unknown/repository')
}

function senderLogin(payload: GitHubPayload): string {
  return String(asRecord(payload.sender).login ?? 'unknown')
}

function branchFromRef(ref: unknown): string {
  return String(ref ?? '').replace(/^refs\/heads\//, '')
}

export function verifyGitHubSignature(rawBody: Uint8Array, signatureHeader: string | null, secret: string): boolean {
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const providedBuffer = Buffer.from(signatureHeader, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

export function buildGitHubTelegramMessage(event: string, payload: GitHubPayload): string {
  const repo = htmlEscape(repositoryName(payload))
  const sender = htmlEscape(senderLogin(payload))

  if (event === 'ping') {
    return [
      '🏓 <b>GitHub webhook ping</b>',
      `Repo: <b>${repo}</b>`,
      `Sender: @${sender}`,
    ].join('\n')
  }

  if (event === 'push') {
    const commits = asArray(payload.commits)
    const branch = htmlEscape(branchFromRef(payload.ref))
    const lines = [
      '🚀 <b>GitHub push</b>',
      `Repo: <b>${repo}</b>`,
      `Branch: <code>${branch}</code>`,
      `Sender: @${sender}`,
      `Commits: <b>${commits.length}</b>`,
    ]
    for (const rawCommit of commits.slice(0, 5)) {
      const commit = asRecord(rawCommit)
      const author = asRecord(commit.author)
      const authorName = author.username ?? author.name ?? ''
      lines.push(
        `• <code>${htmlEscape(shortSha(commit.id))}</code> ${htmlEscape(firstLine(commit.message, 120))} — ${htmlEscape(authorName)}`,
      )
    }
    if (commits.length > 5) lines.push(`• … +${commits.length - 5} commits`)
    if (payload.compare) lines.push(`Ver: ${htmlEscape(payload.compare)}`)
    return lines.join('\n')
  }

  if (event === 'pull_request') {
    const pr = asRecord(payload.pull_request)
    const base = asRecord(pr.base)
    const head = asRecord(pr.head)
    const action = String(payload.action ?? 'updated')
    const merged = Boolean(pr.merged)
    return [
      `${merged ? '✅' : '🔀'} <b>GitHub PR ${htmlEscape(merged ? 'merged' : action)}</b>`,
      `Repo: <b>${repo}</b>`,
      `PR: <b>#${htmlEscape(pr.number ?? payload.number ?? '')}</b> ${htmlEscape(pr.title ?? 'sem título')}`,
      `Fluxo: <code>${htmlEscape(head.ref ?? '')}</code> → <code>${htmlEscape(base.ref ?? '')}</code>`,
      `Sender: @${sender}`,
      `Ver: ${htmlEscape(pr.html_url ?? '')}`,
    ].join('\n')
  }

  if (event === 'workflow_run') {
    const workflow = asRecord(payload.workflow_run)
    const conclusion = workflow.conclusion ?? 'pending'
    const icon = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚙️'
    return [
      `${icon} <b>GitHub workflow</b>`,
      `Repo: <b>${repo}</b>`,
      `Workflow: <b>${htmlEscape(workflow.name ?? 'workflow')}</b>`,
      `Status: <code>${htmlEscape(workflow.status ?? 'unknown')}</code> / <code>${htmlEscape(conclusion)}</code>`,
      `Branch: <code>${htmlEscape(workflow.head_branch ?? '')}</code>`,
      `Sender: @${sender}`,
      `Ver: ${htmlEscape(workflow.html_url ?? '')}`,
    ].join('\n')
  }

  return [
    `📣 <b>GitHub ${htmlEscape(event)}</b>`,
    `Repo: <b>${repo}</b>`,
    `Sender: @${sender}`,
  ].join('\n')
}

function deliveryStorePath(): string {
  return join(getStateDir(), 'github-sentinel-deliveries.json')
}

function loadDeliveryStore(): DeliveryStore {
  const path = deliveryStorePath()
  if (!existsSync(path)) return { deliveries: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeliveryStore>
    return { deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [] }
  } catch {
    return { deliveries: [] }
  }
}

function saveDeliveryStore(store: DeliveryStore): void {
  const path = deliveryStorePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function stableDeliveryId(event: string, payload: GitHubPayload, deliveryId: string | null): string {
  if (deliveryId?.trim()) return deliveryId.trim()
  const digest = createHash('sha256')
    .update(event)
    .update(JSON.stringify({ repo: repositoryName(payload), sender: senderLogin(payload), ref: payload.ref ?? '' }))
    .digest('hex')
    .slice(0, 16)
  return `missing-delivery-${digest}`
}

export function summarizeGitHubEvent(event: string, payload: GitHubPayload): string {
  if (event === 'ping') return 'webhook ping recebido'
  if (event === 'push') return `push ${asArray(payload.commits).length} commit(s) em ${branchFromRef(payload.ref)}`
  if (event === 'pull_request') {
    const pr = asRecord(payload.pull_request)
    return `pr #${String(pr.number ?? payload.number ?? '')} ${String(payload.action ?? 'updated')}`
  }
  if (event === 'workflow_run') {
    const workflow = asRecord(payload.workflow_run)
    return `workflow ${String(workflow.name ?? 'workflow')} ${String(workflow.status ?? 'unknown')}/${String(workflow.conclusion ?? 'pending')}`
  }
  return `${event} recebido`
}

export function persistGitHubDelivery(input: Omit<GitHubDeliveryStatus, 'receivedAt'> & { receivedAt?: string }): GitHubDeliveryStatus {
  const next: GitHubDeliveryStatus = {
    ...input,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  }
  const store = loadDeliveryStore()
  const withoutDuplicate = store.deliveries.filter((delivery) => delivery.deliveryId !== next.deliveryId)
  saveDeliveryStore({ deliveries: [next, ...withoutDuplicate].slice(0, 200) })
  return next
}

function findAcceptedDelivery(deliveryId: string): GitHubDeliveryStatus | null {
  if (!deliveryId.trim()) return null
  return loadDeliveryStore().deliveries.find((delivery) => (
    delivery.deliveryId === deliveryId && delivery.status === 'accepted'
  )) ?? null
}

export function readGitHubSentinelHealth(): {
  enabled: boolean
  secretConfigured: boolean
  telegramConfigured: boolean
  deliveryCount: number
  lastDelivery: GitHubDeliveryStatus | null
} {
  const store = loadDeliveryStore()
  return {
    enabled: isGitHubSentinelEnabled(),
    secretConfigured: getGitHubWebhookSecret().length > 0,
    telegramConfigured: Boolean((process.env.TELEGRAM_BOT_TOKEN ?? process.env.HERMES_TELEGRAM_BOT_TOKEN)?.trim()) && Boolean((process.env.TELEGRAM_CHAT_ID ?? process.env.HERMES_TELEGRAM_CHAT_ID)?.trim()),
    deliveryCount: store.deliveries.length,
    lastDelivery: store.deliveries[0] ?? null,
  }
}

export function readGitHubSentinelPublicHealth(): { ok: true } {
  return { ok: true }
}

export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? process.env.HERMES_TELEGRAM_BOT_TOKEN ?? '').trim()
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? process.env.HERMES_TELEGRAM_CHAT_ID ?? '').trim()
  if (!token || !chatId) return { sent: false, skipped: true, reason: 'telegram_not_configured' }

  const apiBase = (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/$/, '')
  const threadId = (process.env.TELEGRAM_MESSAGE_THREAD_ID ?? process.env.HERMES_TELEGRAM_MESSAGE_THREAD_ID ?? '').trim()
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (threadId) body.message_thread_id = Number.isNaN(Number(threadId)) ? threadId : Number(threadId)

  let response: Response
  try {
    response = await fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
    })
  } catch {
    return { sent: false, skipped: false, reason: 'telegram_network_error' }
  }
  if (!response.ok) return { sent: false, skipped: false, reason: `telegram_http_${response.status}` }
  return { sent: true, skipped: false, reason: null }
}

export async function handleGitHubWebhook(request: Request): Promise<Response> {
  if (!isGitHubSentinelEnabled()) {
    return Response.json({ ok: true, data: { sent: false, skipped: true, reason: 'sentinel_disabled' } })
  }

  if (!hasJsonContentType(request)) {
    return Response.json({ ok: false, error: 'unsupported_media_type' }, { status: 415 })
  }

  let rawBody: Uint8Array
  try {
    rawBody = await readLimitedBody(request)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ ok: false, error: 'payload_too_large' }, { status: 413 })
    }
    throw error
  }
  const event = request.headers.get('x-github-event') ?? 'unknown'
  const deliveryId = request.headers.get('x-github-delivery')
  const secret = getGitHubWebhookSecret()

  if (!secret) {
    if (!allowInsecureWebhook()) {
      if (deliveryId) {
        persistGitHubDelivery({
          deliveryId,
          event,
          status: 'rejected',
          repository: '',
          sender: '',
          summary: 'secret ausente com sentinel habilitado',
          telegramSent: false,
          telegramSkipped: true,
          reason: 'github_webhook_secret_not_configured',
        })
      }
      return Response.json(
        { ok: false, error: 'github_webhook_secret_not_configured' },
        { status: 503 },
      )
    }
  } else if (!verifyGitHubSignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) {
    if (deliveryId) {
      persistGitHubDelivery({
        deliveryId,
        event,
        status: 'rejected',
        repository: '',
        sender: '',
        summary: 'assinatura GitHub inválida',
        telegramSent: false,
        telegramSkipped: true,
        reason: 'invalid_github_signature',
      })
    }
    return Response.json({ ok: false, error: 'invalid_github_signature' }, { status: 401 })
  }

  let payload: GitHubPayload
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as GitHubPayload
  } catch {
    return Response.json({ ok: false, error: 'invalid_json_payload' }, { status: 400 })
  }

  const stableId = stableDeliveryId(event, payload, deliveryId)
  const duplicate = findAcceptedDelivery(stableId)
  if (duplicate) {
    return Response.json({
      ok: true,
      data: {
        event,
        delivery: duplicate.deliveryId,
        persisted: true,
        sent: false,
        skipped: true,
        reason: 'duplicate_delivery',
      },
    })
  }

  const message = buildGitHubTelegramMessage(event, payload)
  const telegram = event === 'ping'
    ? { sent: false, skipped: true, reason: 'ping' }
    : await sendTelegramMessage(message)
  const delivery = persistGitHubDelivery({
    deliveryId: stableId,
    event,
    status: telegram.sent || telegram.skipped ? 'accepted' : 'failed',
    repository: repositoryName(payload),
    sender: senderLogin(payload),
    summary: summarizeGitHubEvent(event, payload),
    telegramSent: telegram.sent,
    telegramSkipped: telegram.skipped,
    reason: telegram.reason,
  })

  return Response.json({
    ok: true,
    data: {
      event,
      delivery: delivery.deliveryId,
      persisted: true,
      sent: telegram.sent,
      skipped: telegram.skipped,
      reason: telegram.reason,
    },
  })
}
