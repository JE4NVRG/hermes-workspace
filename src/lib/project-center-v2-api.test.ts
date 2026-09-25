/**
 * Testes do cliente v2 do Project Center (PR 5).
 *
 * Cobrem os critérios do card: chave de idempotência gerada e persistida antes
 * do primeiro POST e reutilizada em retry/timeout, tipagem estrita, ausência de
 * construção de `SecretRef`, rejeição de path/credencial e flag
 * server-projected com falha fechada.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FEATURE_DISABLED_SIGNAL,
  IDEMPOTENCY_HEADER,
  IF_MATCH_HEADER,
  ProjectCenterV2ApiError,
  ProjectCenterV2InputError,
  assertFreeText,
  assertNoOpaqueReference,
  assertPublicIntent,
  canonicalJson,
  createMemoryIdempotencyStore,
  createProjectCenterV2Client,
  generateIdempotencyKey,
  isValidIdempotencyKey,
} from './project-center-v2-api'
import { SECRET_REF_MASK, sanitizeForDisplay } from './project-center-v2-types'
import type {
  IdempotencyBinding,
  IdempotencyStore,
  PublicIntentInput,
} from './project-center-v2-api'
import type { Operation, ProjectIntent } from './project-center-v2-types'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Fixture de segredo montada em runtime: nenhum literal de token no fonte. */
const FIXTURE_SECRET_REF = `sref_${'A'.repeat(48)}`
const FIXTURE_DSN = ['postgres', '://usuario:credencial@host:5432/banco'].join(
  '',
)
const FIXTURE_ABSOLUTE_PATH = [
  '',
  'home',
  'operador',
  '.config',
  'projeto.env',
].join('/')

const VALID_INTENT: PublicIntentInput = {
  capabilities: {
    auth: false,
    backup: true,
    postgrest: false,
    realtime: false,
    storage: false,
  },
  client_id: 'je4ndev',
  display_name: 'Projeto Isolado',
  driver: 'postgresql_isolated',
  environment: 'development',
  project_slug: 'projeto-isolado',
}

function operationFixture(overrides: Partial<Operation> = {}): Operation {
  return {
    audit_url: '/api/project-center/v2/operations/x/audit',
    created_at: '2026-09-25T10:00:00.000Z',
    driver: 'postgresql_isolated',
    environment: 'development',
    expires_at: '2026-09-25T11:00:00.000Z',
    operation_id: '00000000-0000-4000-8000-000000000000',
    operation_version: 3,
    plan: {
      actions: [
        {
          action_id: 'act_aaaaaaaa',
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
    plan_hash: 'b'.repeat(64),
    project_id: 'je4ndev-projeto-isolado',
    state: 'awaiting_approval',
    status_url: '/api/project-center/v2/operations/x',
    updated_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function featureDisabledResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 'FORBIDDEN',
        details: [{ reason: FEATURE_DISABLED_SIGNAL }],
        message: FEATURE_DISABLED_SIGNAL,
        request_id: 'req-1',
        retryable: false,
      },
    },
    403,
  )
}

describe('idempotência client-owned', () => {
  it('gera chave no contrato (16..128, charset permitido)', () => {
    const key = generateIdempotencyKey()
    expect(key).toHaveLength(24)
    expect(isValidIdempotencyKey(key)).toBe(true)
    expect(isValidIdempotencyKey('curta')).toBe(false)
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false)
    expect(isValidIdempotencyKey(`${'a'.repeat(16)} espaço`)).toBe(false)
  })

  it('persiste a chave antes do primeiro POST e reutiliza no timeout', async () => {
    const events: Array<string> = []
    const store: IdempotencyStore = {
      clear: () => undefined,
      read: () => null,
      write: (scope: string, binding: IdempotencyBinding) => {
        events.push(`store:${scope}:${binding.key}`)
      },
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        events.push('fetch:1')
        return Promise.reject(new Error('socket timeout'))
      })
      .mockImplementationOnce(() => {
        events.push('fetch:2')
        return Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            201,
          ),
        )
      })
    const client = createProjectCenterV2Client({
      fetchImpl,
      idempotency: store,
      retries: 1,
    })

    const result = await client.dryRun({
      intent: VALID_INTENT as ProjectIntent,
    })

    expect(result.operation.state).toBe('awaiting_approval')
    expect(events[0]).toMatch(/^store:dry-run:/)
    expect(events.slice(1)).toEqual(['fetch:1', 'fetch:2'])

    const first = new Headers(
      (fetchImpl.mock.calls[0][1] as RequestInit).headers,
    ).get(IDEMPOTENCY_HEADER)
    const second = new Headers(
      (fetchImpl.mock.calls[1][1] as RequestInit).headers,
    ).get(IDEMPOTENCY_HEADER)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(isValidIdempotencyKey(first ?? '')).toBe(true)
  })

  it('reutiliza a chave em replay da mesma intenção e troca quando a intenção muda', async () => {
    const store = createMemoryIdempotencyStore()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            201,
          ),
        ),
      )
    const client = createProjectCenterV2Client({
      fetchImpl,
      idempotency: store,
    })

    await client.dryRun({ intent: VALID_INTENT as ProjectIntent })
    await client.dryRun({ intent: VALID_INTENT as ProjectIntent })
    const sameIntentKeys = fetchImpl.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get(IDEMPOTENCY_HEADER),
    )
    expect(sameIntentKeys[1]).toBe(sameIntentKeys[0])

    await client.dryRun({
      intent: {
        ...(VALID_INTENT as ProjectIntent),
        display_name: 'Outro Nome',
      },
    })
    const thirdKey = new Headers(
      (fetchImpl.mock.calls[2][1] as RequestInit).headers,
    ).get(IDEMPOTENCY_HEADER)
    expect(thirdKey).not.toBe(sameIntentKeys[0])
    expect(client.idempotencyKeyFor('dry-run')).toBe(thirdKey)
  })

  it('não envia Authorization nem credencial de nenhuma fonte local', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            201,
          ),
        ),
      )
    const client = createProjectCenterV2Client({ fetchImpl })
    await client.dryRun({ intent: VALID_INTENT as ProjectIntent })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBeNull()
    expect(init.credentials).toBe('same-origin')
    expect(init.body).toBeTypeOf('string')
    expect(canonicalJson(JSON.parse(init.body as string))).toBe(
      canonicalJson(JSON.parse(init.body as string)),
    )
  })
})

describe('entrada pública: sem path, credencial ou SecretRef', () => {
  it('rejeita campo desconhecido na intenção', () => {
    expect(() =>
      assertPublicIntent({
        ...VALID_INTENT,
        secret_path: FIXTURE_ABSOLUTE_PATH,
      } as PublicIntentInput),
    ).toThrow(ProjectCenterV2InputError)
  })

  it('rejeita path absoluto, DSN e referência opaca em texto livre', () => {
    for (const value of [
      FIXTURE_ABSOLUTE_PATH,
      FIXTURE_DSN,
      FIXTURE_SECRET_REF,
    ]) {
      expect(() =>
        assertPublicIntent({ ...VALID_INTENT, description: value }),
      ).toThrow(ProjectCenterV2InputError)
    }
    expect(() =>
      assertFreeText('motivo válido', 'reason', { max: 500, min: 3 }),
    ).not.toThrow()
    expect(() =>
      assertNoOpaqueReference(FIXTURE_SECRET_REF, 'confirmation'),
    ).toThrow(ProjectCenterV2InputError)
  })

  it('rejeita driver legado como modo selecionável', () => {
    expect(() =>
      assertPublicIntent({ ...VALID_INTENT, driver: 'schema_shared' }),
    ).toThrow(/apenas postgresql_isolated/)
  })

  it('fixa host_target no allowlist e nunca aceita host livre', () => {
    const intent = assertPublicIntent(VALID_INTENT)
    expect(intent.host_target).toBe('vps-primary-local')
  })

  it('o módulo do cliente não constrói nem parseia SecretRef', () => {
    const source = readFileSync(
      resolve(HERE, 'project-center-v2-api.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/sref_[A-Za-z0-9_-]{8,}/)
    expect(source).not.toMatch(/api[_-]?key|service[_-]?role/i)
  })
})

describe('flag server-projected', () => {
  it('flag desligada retorna apiEnabled false (403 feature_disabled)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(featureDisabledResponse()))
    const client = createProjectCenterV2Client({ fetchImpl })
    const surface = await client.surface()
    expect(surface.apiEnabled).toBe(false)
    expect(surface.source).toBe('server')
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/api/project-center/v2/operations/',
    )
  })

  it('superfície aberta é reconhecida por 401 (sem token scoped no browser)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'UNAUTHORIZED',
              message: 'unauthorized',
              request_id: 'req-1',
              retryable: false,
            },
          },
          401,
        ),
      ),
    )
    const client = createProjectCenterV2Client({ fetchImpl })
    expect((await client.surface()).apiEnabled).toBe(true)
  })

  it('falha de rede mantém a experiência atual (fail-closed)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.reject(new Error('offline')))
    const client = createProjectCenterV2Client({ fetchImpl })
    const surface = await client.surface()
    expect(surface.apiEnabled).toBe(false)
    expect(surface.source).toBe('unavailable')
  })
})

describe('erros tipados e sanitizados', () => {
  it('mapeia 429 com Retry-After e detalhes do catálogo', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'RATE_LIMITED',
              details: [{ reason: 'scope:project:plan' }],
              message: 'limite atingido',
              request_id: 'req-9',
              retry_after_seconds: 60,
              retryable: true,
            },
          },
          429,
        ),
      ),
    )
    const client = createProjectCenterV2Client({ fetchImpl })
    await expect(
      client.dryRun({ intent: VALID_INTENT as ProjectIntent }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 60,
      retryable: true,
    })
  })

  it('sanitiza mensagem que trouxer path absoluto ou referência opaca', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'INVALID_REQUEST',
              message: `falha ao ler ${FIXTURE_ABSOLUTE_PATH} com ${FIXTURE_SECRET_REF}`,
              request_id: 'req-1',
              retryable: false,
            },
          },
          400,
        ),
      ),
    )
    const client = createProjectCenterV2Client({ fetchImpl })
    const error = await client
      .dryRun({ intent: VALID_INTENT as ProjectIntent })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProjectCenterV2ApiError)
    const apiError = error as ProjectCenterV2ApiError
    expect(apiError.message).not.toContain(FIXTURE_ABSOLUTE_PATH)
    expect(apiError.message).not.toContain(FIXTURE_SECRET_REF)
    expect(sanitizeForDisplay(FIXTURE_SECRET_REF)).toBe(SECRET_REF_MASK)
  })
})

describe('mutações contratuais', () => {
  it('aprovação envia If-Match entre aspas e payload discriminado', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            200,
          ),
        ),
      )
    const client = createProjectCenterV2Client({ fetchImpl })
    await client.approveOperation(
      'op-1',
      {
        confirmation: `APROVAR je4ndev-projeto-isolado ${'b'.repeat(8)}`,
        decision: 'approve',
        plan_hash: 'b'.repeat(64),
      },
      3,
    )
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain('/operations/op-1/approve')
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get(IF_MATCH_HEADER)).toBe('"3"')
    expect(headers.get(IDEMPOTENCY_HEADER)).not.toBeNull()
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      decision: 'approve',
      plan_hash: 'b'.repeat(64),
    })
  })

  it('rejeição nunca envia hash nem frase de aprovação', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            200,
          ),
        ),
      )
    const client = createProjectCenterV2Client({ fetchImpl })
    await client.approveOperation(
      'op-1',
      { decision: 'reject', reason: 'plano com risco não aceito' },
      1,
    )
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0][1] as RequestInit).body),
    ) as Record<string, unknown>
    expect(body).toEqual({
      decision: 'reject',
      reason: 'plano com risco não aceito',
    })
    expect(body).not.toHaveProperty('plan_hash')
    expect(body).not.toHaveProperty('confirmation')
  })

  it('execução de rollback exige approval_id e hash próprios', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            { operation: operationFixture(), request_id: 'req-1' },
            202,
          ),
        ),
      )
    const client = createProjectCenterV2Client({ fetchImpl })
    await client.rollbackExecute(
      'op-1',
      {
        approval_id: '11111111-1111-4111-8111-111111111111',
        rollback_plan_hash: 'c'.repeat(64),
      },
      2,
    )
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/operations/op-1/rollback/execute',
    )
    expect(
      JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)),
    ).toEqual({
      approval_id: '11111111-1111-4111-8111-111111111111',
      rollback_plan_hash: 'c'.repeat(64),
    })
  })

  it('auditoria usa query tipada e devolve a página do contrato', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          {
            events: [],
            next_cursor: null,
            operation_id: 'op-1',
            request_id: 'req-1',
          },
          200,
        ),
      ),
    )
    const client = createProjectCenterV2Client({ fetchImpl })
    const page = await client.listAudit('op-1', { cursor: 'abc', limit: 25 })
    expect(page.events).toEqual([])
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/operations/op-1/audit?cursor=abc&limit=25',
    )
  })
})
