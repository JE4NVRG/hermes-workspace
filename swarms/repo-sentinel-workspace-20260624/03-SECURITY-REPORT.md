# 03 — Security Report: Workspace GitHub Sentinel

Data: 2026-06-24T18:51:23+02:00
Agente: Warden / security
Escopo: endpoint nativo Workspace `/api/webhooks/github`, HMAC, logs/secrets, payload mínimo e superfície OWASP.

## Veredito

Status: PASS COM GATES DE HARDENING ANTES DO CUTOVER PRODUÇÃO.

O endpoint implementado tem uma base segura para o P1: valida HMAC SHA-256 com `timingSafeEqual`, usa corpo bruto antes do parse JSON, falha fechado quando o sentinel está habilitado sem secret, não loga secrets, persiste apenas metadados mínimos de delivery e escapa HTML antes de enviar mensagens ao Telegram.

Ainda assim, eu NÃO recomendo cutover final do webhook GitHub de produção sem aplicar pelo menos os gates HIGH/MEDIUM abaixo: limite de tamanho de payload, idempotência anti-replay antes de reenviar Telegram, timeout/tratamento de erro no fetch Telegram e redução/autenticação do GET de health.

## Evidência real executada

Comandos executados em `/home/jean/hermes-workspace`:

1. Teste unitário específico do Sentinel:

```text
$ pnpm vitest run src/server/github-sentinel.test.ts
Vitest "deps.inline" is deprecated. If you rely on vite-node directly, use "server.deps.inline" instead. Otherwise, consider using "deps.optimizer.ssr.include"
[hermes-agent] Already running — reusing existing process

 RUN  v3.2.4 /home/jean/hermes-workspace

 ✓ src/server/github-sentinel.test.ts (6 tests) 88ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  18:50:27
   Duration  1.64s (transform 463ms, setup 0ms, collect 483ms, tests 88ms, environment 0ms, prepare 357ms)
```

2. Lint focado nos arquivos do Sentinel:

```text
$ pnpm eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
(node:4108775) ESLintIgnoreWarning: The ".eslintignore" file is no longer supported. Switch to using the "ignores" property in "eslint.config.js": https://eslint.org/docs/latest/use/configure/migration-guide#ignore-files
```

Resultado: exit code 0. O warning é de configuração global do ESLint 10 e não bloqueia os arquivos revisados.

3. Secret scan textual focado em literais comuns nos arquivos novos:

```text
search_files regex: ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|[0-9]{8,10}:[A-Za-z0-9_-]{35,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+
Arquivos:
- src/server/github-sentinel.ts
- src/server/github-sentinel.test.ts
- src/routes/api/webhooks/github.ts
Resultado: 0 matches em todos.
```

4. Estado Git focado:

```text
$ git status --short src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts src/routeTree.gen.ts
M  src/routeTree.gen.ts
?? src/routes/api/webhooks/github.ts
?? src/server/github-sentinel.test.ts
?? src/server/github-sentinel.ts
```

## Arquivos revisados

- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`
- `/home/jean/hermes-workspace/src/server/workspace-state-dir.ts`
- `/home/jean/hermes-workspace/00-BRIEF.md` via missão em `swarms/repo-sentinel-workspace-20260624/00-BRIEF.md`

## Controles validados

### HMAC / assinatura GitHub

Status: PASS.

Evidência no código:

- `handleGitHubWebhook()` lê `rawBody` via `await request.arrayBuffer()` antes de qualquer JSON parse.
- `verifyGitHubSignature(rawBody, header, secret)` exige header `sha256=`.
- Assinatura esperada é `createHmac('sha256', secret).update(rawBody).digest('hex')`.
- Comparação usa `timingSafeEqual` após checar mesmo comprimento.
- Testes cobrem assinatura válida e inválida:
  - `accepts valid HMAC SHA-256 signatures`
  - `rejects invalid HMAC SHA-256 signatures`

Risco residual:

- A comparação retorna cedo quando o comprimento diverge. Para GitHub `sha256=<64 hex>` isso não compromete o segredo na prática, mas o endpoint poderia normalizar para sempre comparar contra buffer de tamanho fixo para reduzir sinal lateral. Severidade: Low.

### Fail-closed sem secret

Status: PASS.

Quando `HERMES_GITHUB_SENTINEL_ENABLED=1` e não há `HERMES_GITHUB_WEBHOOK_SECRET`/`GITHUB_WEBHOOK_SECRET`, o endpoint retorna `503` com erro genérico `github_webhook_secret_not_configured` e não processa o payload, salvo se a flag explícita de bypass estiver ativa.

Teste real passou: `returns a secure error when sentinel is enabled without a secret`.

Risco residual:

- Existe bypass por env `HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE` / `GITHUB_WEBHOOK_ALLOW_INSECURE`. Isso é aceitável só para dev local. Em produção precisa gate explícito: fail startup ou alerta crítico se `ALLOW_INSECURE=true`. Severidade: Medium.

### Logs sem secrets

Status: PASS no escopo dos arquivos revisados.

Não encontrei `console.log`, logger ou persistência de token/secret dentro do fluxo Sentinel. O código:

- Não grava `HERMES_GITHUB_WEBHOOK_SECRET`.
- Não grava token Telegram.
- Em erros Telegram, persiste apenas `telegram_http_<status>`.
- Health expõe apenas booleanos `secretConfigured` e `telegramConfigured`, não valores.

Secret scan textual focado retornou 0 literais óbvios para GitHub PAT, Telegram bot token, OpenAI-style key e Slack token nos arquivos do Sentinel.

### Payload mínimo / minimização de dados

Status: PASS PARCIAL.

Persistência em `github-sentinel-deliveries.json` guarda somente:

- deliveryId
- event
- status
- repository
- sender
- summary
- telegramSent / telegramSkipped
- reason
- receivedAt

Não persiste payload bruto, commits completos, emails, URLs internas de API nem headers. Isso está alinhado com minimização de dados e LGPD.

A mensagem Telegram para `push` inclui até 5 commits, SHA curto, primeira linha da mensagem truncada a 120 chars, autor e compare URL. É aceitável para alerta operacional, mas pode conter PII ou segredo acidental se alguém commitar segredo na mensagem. Recomendação: opcionalmente redigir padrões de token em mensagens de commit antes de enviar. Severidade: Low/Defense-in-depth.

### Escape de saída / XSS-HTML Telegram

Status: PASS.

Todos os campos vindos do payload usados no HTML do Telegram passam por `htmlEscape()` para `&`, `<`, `>`. Testes cobrem `<script>` em commit message, `<b>` em título de PR e `<main>` em workflow.

Risco residual:

- `htmlEscape()` não escapa aspas, mas os valores não são colocados em atributos HTML; são somente texto/conteúdo de tags Telegram. Risco prático baixo.

### Arquivo de estado

Status: PASS.

`saveDeliveryStore()` cria diretório com modo `0700` e arquivo com modo `0600`. O path vem de `getStateDir()`, que resolve caminho absoluto por `HERMES_WORKSPACE_STATE_DIR` ou `HERMES_HOME/workspace`.

Risco residual:

- Se `HERMES_WORKSPACE_STATE_DIR` for configurado para local inseguro por operador, o código respeita. Isso é risco operacional, não vulnerabilidade direta do endpoint. Documentar em runbook.

## Achados priorizados

### HIGH-01 — Sem limite explícito de tamanho do payload antes de `arrayBuffer()`

Categoria: OWASP API4:2023 Unrestricted Resource Consumption / DoS.

Evidência:

- `handleGitHubWebhook()` faz `const rawBody = new Uint8Array(await request.arrayBuffer())` sem checar `content-length` e sem limite de bytes.

Impacto:

- Um atacante externo que alcance `/api/webhooks/github` pode enviar corpos grandes e forçar alocação de memória antes da validação HMAC/JSON, causando consumo de RAM/CPU e possível degradação do Workspace.
- HMAC protege autenticidade depois que o corpo já foi carregado; não protege contra DoS de upload grande.

Remediação sugerida:

- Definir limite rígido, por exemplo 1 MiB ou 5 MiB conforme eventos esperados.
- Rejeitar por `content-length` antes de ler quando disponível.
- Para ausência de `content-length`, ler stream com acumulador limitado em vez de `arrayBuffer()` direto.

Exemplo de direção de fix:

```ts
const MAX_GITHUB_WEBHOOK_BYTES = 1_000_000
const contentLength = Number(request.headers.get('content-length') ?? '0')
if (contentLength > MAX_GITHUB_WEBHOOK_BYTES) {
  return Response.json({ ok: false, error: 'payload_too_large' }, { status: 413 })
}
```

Ideal: função utilitária `readLimitedBody(request, MAX_GITHUB_WEBHOOK_BYTES)` para cobrir bodies chunked sem `content-length`.

Gate: bloquear cutover público até existir teste `rejects oversized payload before processing`.

### MEDIUM-01 — Duplicatas/replay de `x-github-delivery` podem reenviar Telegram

Categoria: OWASP API8:2023 Security Misconfiguration / lógica de idempotência; confiabilidade operacional.

Evidência:

- `persistGitHubDelivery()` remove duplicado e grava o novo status, mas isso acontece depois de `sendTelegramMessage(message)`.
- Não há checagem antes do envio para `deliveryId` já processado.

Impacto:

- Reentrega legítima do GitHub, retry de rede ou replay de request assinado com mesmo delivery pode gerar alertas duplicados no Telegram.
- Se um request assinado vazar via logs externos/proxy, replay dentro de janela indefinida poderia gerar spam. Não há timestamp freshness.

Remediação sugerida:

- Antes de enviar Telegram, consultar store por `deliveryId` existente com status `accepted` e retornar `duplicate_delivery` sem reenviar.
- Opcional: TTL de delivery IDs e/ou aceitar somente delivery novo.
- Teste: duas chamadas com mesmo `x-github-delivery` devem chamar `fetch` Telegram uma vez.

### MEDIUM-02 — Fetch Telegram sem timeout e sem `try/catch`

Categoria: OWASP API4 Resource Consumption / resiliência.

Evidência:

- `sendTelegramMessage()` chama `fetch(`${apiBase}/bot${token}/sendMessage`, ...)` sem `AbortSignal.timeout()`.
- Exceções de rede não são capturadas e podem virar 500 genérico do framework.

Impacto:

- Webhook pode ficar preso até timeout default do runtime/proxy.
- Erros de rede podem não persistir delivery como `failed`, reduzindo auditabilidade.

Remediação sugerida:

- Usar `AbortSignal.timeout(5_000)`.
- Envolver `fetch` em `try/catch` e retornar `{ sent:false, skipped:false, reason:'telegram_network_error' }` sem incluir erro bruto.
- Persistir delivery failed com reason genérico.

### MEDIUM-03 — GET `/api/webhooks/github` expõe health e último delivery se rota ficar pública

Categoria: OWASP API3 Excessive Data Exposure.

Evidência:

- `GET` retorna `{ ok: true, data: readGitHubSentinelHealth() }`.
- `readGitHubSentinelHealth()` inclui `lastDelivery`, com repo, sender, summary, timestamps.

Impacto:

- Se a rota de webhook precisar ficar pública para GitHub, o GET pode revelar atividade recente do repo e usuário emissor para qualquer visitante, dependendo do proxy/auth do Workspace.

Remediação sugerida:

- Para rota pública, GET deve retornar somente `{ ok: true }` ou 404/405.
- Mover health completo para rota interna autenticada, por exemplo `/api/internal/github-sentinel/health`, protegida pela autenticação do Workspace/gateway.
- No mínimo, remover `lastDelivery` do GET público.

### LOW-01 — `ALLOW_INSECURE` precisa proteção operacional de produção

Categoria: Security Misconfiguration.

Evidência:

- `allowInsecureWebhook()` permite processar sem secret quando env `HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE` ou `GITHUB_WEBHOOK_ALLOW_INSECURE` é truthy.

Impacto:

- Configuração errada em produção transforma endpoint em webhook sem autenticação.

Remediação sugerida:

- Ignorar `ALLOW_INSECURE` quando `NODE_ENV=production` ou `HERMES_ENV=production`.
- Alternativa: startup warning/erro explícito se sentinel habilitado + insecure em produção.
- Documentar que a flag é somente para dev local.

### LOW-02 — Sem validação de `content-type`

Categoria: hardening de API.

Evidência:

- O handler não exige `content-type: application/json`.

Impacto:

- Não é bypass de HMAC, mas amplia superfície para inputs inesperados.

Remediação sugerida:

- Rejeitar content-types que não contenham `application/json` com 415, exceto se houver motivo GitHub documentado para outro tipo.

## Mapeamento OWASP API Top 10

| Categoria | Status | Observação |
|---|---|---|
| API1 Broken Object Level Authorization | N/A | Endpoint não opera objetos por usuário. |
| API2 Broken Authentication | PASS parcial | HMAC ok; risco se `ALLOW_INSECURE` em produção. |
| API3 Excessive Data Exposure | MEDIUM | GET health expõe último delivery se público. |
| API4 Unrestricted Resource Consumption | HIGH | Sem limite de payload; fetch Telegram sem timeout. |
| API5 Broken Function Level Authorization | N/A/Pendente | Webhook público esperado; health deveria ser separado/autenticado. |
| API6 Unrestricted Access to Sensitive Business Flows | LOW | Replay/duplicata gera spam, não altera dados sensíveis. |
| API7 SSRF | PASS | Não há URL fetch controlada pelo payload; Telegram API base vem de env. |
| API8 Security Misconfiguration | MEDIUM | `ALLOW_INSECURE`, health público, falta de limite. |
| API9 Improper Inventory Management | PASS | Rota está em `src/routes/api/webhooks/github.ts` e routeTree gerada. |
| API10 Unsafe Consumption of APIs | MEDIUM | Telegram fetch precisa timeout/catch e reason sanitizado. |

## Checklist de cutover seguro

Antes de trocar webhook GitHub de produção para Workspace:

- [ ] Implementar limite de payload e teste oversized.
- [ ] Implementar idempotência: mesmo `x-github-delivery` não reenvia Telegram.
- [ ] Implementar timeout/catch para Telegram fetch.
- [ ] Remover `lastDelivery` do GET público ou mover health para rota autenticada.
- [ ] Garantir `HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE` ausente/false em produção.
- [ ] Configurar `HERMES_GITHUB_WEBHOOK_SECRET` forte e único; não reutilizar secrets de legado.
- [ ] Fazer teste assinado local e teste de delivery GitHub real em ambiente controlado.
- [ ] Confirmar rollback: manter webhook legado ativo ou documentar URL anterior até QA aprovar paridade.

## Próximo gate claro

Gate recomendado: BUILDER-HARDENING antes de QA final.

Encaminhar para Dev/Builder corrigir HIGH-01, MEDIUM-01, MEDIUM-02 e MEDIUM-03. Depois, QA deve validar:

1. POST assinado válido retorna 200 e persiste delivery.
2. POST com assinatura inválida retorna 401 e não envia Telegram.
3. POST oversized retorna 413 sem parse/envio.
4. Duplo delivery ID envia Telegram apenas uma vez.
5. GET público não vaza último delivery, ou health completo exige autenticação.

## Conclusão

A implementação atual é defensável para teste local/controlado e cumpre a base de HMAC + minimização + ausência de secrets em logs. Para internet pública e cutover do GitHub, ainda precisa hardening de DoS, idempotência e exposição do endpoint de health.
