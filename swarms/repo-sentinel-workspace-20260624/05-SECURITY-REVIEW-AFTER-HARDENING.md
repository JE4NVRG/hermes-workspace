# 05 — Security Review After Hardening: Workspace GitHub Sentinel

Data: 2026-06-24T19:14:11+02:00
Agente: Warden / security
Task: t_958c31a8
Missão: repo-sentinel-workspace-20260624
Escopo: re-review pós-fix de payload limit, content-type, insecure bypass, idempotência e Telegram network error nos arquivos:

- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`

## Veredito

Status Security: PASS.

Cutover: LIBERADO PELO SECURITY PARA PRÓXIMO GATE QA/CUTOVER CONTROLADO, mas ainda BLOQUEADO para cutover final de produção/desligamento do legado sem:

1. configurar o serviço ativo com `HERMES_GITHUB_SENTINEL_ENABLED=1`, secret forte e Telegram;
2. reiniciar o Workspace de forma controlada;
3. executar ping/redelivery real do GitHub e push/PR/workflow controlados;
4. validar paridade operacional com o legado e rollback.

Motivo: os achados HIGH/MEDIUM do código foram corrigidos e validados localmente, mas a própria QA anterior já comprovou que o ambiente ativo ainda estava sem Sentinel/secret/Telegram. Security não deve autorizar troca real do webhook ou desativação do `luna-mc-v5-backend` antes do gate operacional real.

## Evidência real executada nesta revisão

Comandos executados em `/home/jean/hermes-workspace`.

### 1) Testes focados do Sentinel

Comando:

```bash
./node_modules/.bin/vitest run src/server/github-sentinel.test.ts --reporter=verbose
```

Resultado real:

```text
Test Files  1 passed (1)
Tests       14 passed (14)
```

Os 14 testes cobriram:

- HMAC válido e inválido;
- rejeição segura sem secret;
- rejeição de content-type não JSON;
- payload oversized por `content-length` antes de assinatura/JSON;
- payload oversized sem `content-length` durante leitura do stream;
- bypass insecure rejeitado em produção;
- ping aceito sem Telegram;
- push aceito com HTML escapado;
- idempotência de delivery aceito sem reenvio Telegram;
- erro de rede Telegram persistido como `failed` com reason genérico;
- health público sem `lastDelivery`/metadados;
- PR/workflow com escape HTML.

### 2) ESLint focado

Comando:

```bash
./node_modules/.bin/eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
```

Resultado real:

```text
exit_code=0
ESLintIgnoreWarning: The ".eslintignore" file is no longer supported...
```

Sem erro nos arquivos revisados. O warning é global de configuração ESLint e não foi introduzido por este hardening.

### 3) Secret scan textual focado

Comando executado via Python nos três arquivos do Sentinel procurando padrões comuns de GitHub PAT, Telegram bot token, OpenAI-style key e Slack token.

Resultado real:

```text
{'secret_like_matches': [], 'count': 0}
```

Não encontrei novo vazamento de secret/token literal nos arquivos revisados.

### 4) Smoke manual independente dos novos gates

Comando: script `node --import tsx` chamando `handleGitHubWebhook()` diretamente com env temporário e state em `/tmp`.

Resultado real resumido:

```json
{
  "first": {
    "status": 200,
    "body": {
      "ok": true,
      "data": {
        "event": "push",
        "delivery": "manual-dup-1",
        "persisted": true,
        "sent": true,
        "skipped": false,
        "reason": null
      }
    }
  },
  "second": {
    "status": 200,
    "body": {
      "ok": true,
      "data": {
        "event": "push",
        "delivery": "manual-dup-1",
        "persisted": true,
        "sent": false,
        "skipped": true,
        "reason": "duplicate_delivery"
      }
    },
    "fetchCallsAfterDuplicate": 1
  },
  "oversized": {
    "status": 413,
    "body": { "ok": false, "error": "payload_too_large" }
  },
  "wrongType": {
    "status": 415,
    "body": { "ok": false, "error": "unsupported_media_type" }
  },
  "network": {
    "status": 200,
    "body": {
      "ok": true,
      "data": {
        "event": "push",
        "delivery": "manual-network",
        "persisted": true,
        "sent": false,
        "skipped": false,
        "reason": "telegram_network_error"
      }
    },
    "lastDelivery": {
      "deliveryId": "manual-network",
      "event": "push",
      "status": "failed",
      "repository": "JE4NVRG/workspace",
      "sender": "jean",
      "summary": "push 1 commit(s) em main",
      "telegramSent": false,
      "telegramSkipped": false,
      "reason": "telegram_network_error"
    }
  },
  "publicHealth": { "ok": true }
}
```

Conclusão do smoke: os gates críticos pós-fix funcionam fora do runner de teste também.

## Reavaliação dos achados anteriores

### HIGH-01 — Sem limite explícito de tamanho do payload antes de `arrayBuffer()`

Status após hardening: FIXED / PASS.

Evidência no código:

- `MAX_GITHUB_WEBHOOK_BYTES = 1_048_576`.
- `readLimitedBody()` rejeita `content-length` maior que o limite antes de processar assinatura/JSON.
- Para body sem `content-length`, lê `request.body` por stream acumulando bytes e lança `PayloadTooLargeError` assim que excede o limite.
- `handleGitHubWebhook()` retorna `413 { ok:false, error:'payload_too_large' }`.

Evidência de teste:

- `rejects oversized payloads from content-length before signature and JSON processing` passou.
- `rejects oversized payloads without content-length while reading the stream` passou.
- Smoke manual retornou HTTP 413.

Risco residual: Low. Limite de 1 MiB é defensável para eventos esperados de `ping`, `push`, `pull_request` e `workflow_run`; se o uso futuro exigir payloads maiores, aumentar por decisão explícita e manter teste de DoS.

### MEDIUM-01 — Duplicatas/replay de `x-github-delivery` podem reenviar Telegram

Status após hardening: FIXED / PASS.

Evidência no código:

- `findAcceptedDelivery(stableId)` consulta store antes do envio Telegram.
- Se já existe delivery `accepted`, retorna `reason:'duplicate_delivery'`, `sent:false`, `skipped:true` e não chama Telegram novamente.

Evidência de teste/smoke:

- Teste `does not send Telegram again for an already accepted delivery id` passou.
- Smoke manual: dois POSTs com o mesmo delivery resultaram em `fetchCallsAfterDuplicate: 1`.

Risco residual: Low. O código só deduplica deliveries já `accepted`; retries de delivery `failed` ainda podem tentar Telegram novamente, o que é desejável para recuperação de falha transitória.

### MEDIUM-02 — Fetch Telegram sem timeout e sem `try/catch`

Status após hardening: FIXED / PASS.

Evidência no código:

- `TELEGRAM_FETCH_TIMEOUT_MS = 5_000`.
- `fetch()` usa `signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS)`.
- `sendTelegramMessage()` captura exceções e retorna `{ sent:false, skipped:false, reason:'telegram_network_error' }` sem erro bruto.
- `handleGitHubWebhook()` persiste delivery autenticado como `status:'failed'` quando Telegram falha.
- Resposta ao GitHub permanece HTTP 200 com `ok:true`, porque o evento foi autenticado/recebido; a falha é no canal secundário de alerta.

Evidência de teste/smoke:

- Teste `records generic Telegram network failures with a timeout signal and without leaking raw errors` passou.
- Smoke manual retornou HTTP 200 e `lastDelivery.status = failed`, `reason = telegram_network_error`.

Risco residual: Low/operacional. A política 200 + delivery failed reduz redelivery em massa do GitHub e preserva auditoria local; exige monitoramento do delivery store para falhas Telegram.

### MEDIUM-03 — GET `/api/webhooks/github` expõe health e último delivery se rota ficar pública

Status após hardening: FIXED / PASS para endpoint público.

Evidência no código:

- Rota `GET /api/webhooks/github` agora chama `readGitHubSentinelPublicHealth()`.
- `readGitHubSentinelPublicHealth()` retorna somente `{ ok: true }`.
- Health completo permanece disponível internamente via `readGitHubSentinelHealth()`, não exposto pela rota pública revisada.

Evidência de teste/smoke:

- Teste `keeps public health free of last delivery metadata` passou.
- Smoke manual retornou `publicHealth: { ok: true }`.

Risco residual: Low. Se um painel interno precisar de health completo, criar rota interna autenticada separada; não reexpandir o GET público do webhook.

### LOW-01 — `ALLOW_INSECURE` precisa proteção operacional de produção

Status após hardening: FIXED / PASS.

Evidência no código:

- `allowInsecureWebhook()` retorna `false` quando `NODE_ENV` ou `HERMES_ENV` é `production`.

Evidência de teste:

- Teste `rejects insecure webhook bypass in production` passou.

Risco residual: Low. Ainda recomendo manter `HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE` ausente/false no ambiente real e nunca usá-la fora de dev local controlado.

### LOW-02 — Sem validação de `content-type`

Status após hardening: FIXED / PASS.

Evidência no código:

- `hasJsonContentType()` exige `application/json`.
- `handleGitHubWebhook()` retorna `415 { ok:false, error:'unsupported_media_type' }` antes de ler o body.

Evidência de teste/smoke:

- Teste `rejects webhook requests with non-JSON content types` passou.
- Smoke manual retornou HTTP 415.

Risco residual: Low. GitHub deve ser configurado com `Content type: application/json`, conforme plano de cutover.

## Logs, secrets e minimização

Status: PASS.

Não encontrei `console.log`, logger de payload bruto, persistência de webhook secret, token Telegram ou erro bruto dentro do fluxo do Sentinel.

A persistência continua limitada a:

- `deliveryId`
- `event`
- `status`
- `repository`
- `sender`
- `summary`
- flags Telegram
- `reason`
- `receivedAt`

O novo tratamento de erro Telegram persiste somente `telegram_network_error` ou `telegram_http_<status>`, sem incluir URL completa com token, exceção bruta, stack trace, env vars ou payload completo.

## Observação de higiene de release

Durante a revisão, `git diff --cached` mostrou `src/routeTree.gen.ts` com a rota `/api/webhooks/github`, mas também entradas relacionadas a `/supabase` e `/api/supabase-registry`. Não classifiquei isso como vulnerabilidade do Sentinel, mas recomendo conferir antes do commit/release se essas entradas Supabase pertencem ao mesmo lote ou são alterações geradas por outro card. Evitar misturar escopos reduz risco de regressão e facilita rollback.

## Checklist de pronto deste re-review

- [x] 14/14 testes focados validados.
- [x] ESLint focado exit code 0.
- [x] Sem novo vazamento de secrets/logs detectado nos arquivos revisados.
- [x] HIGH-01 reavaliado como fixed/pass.
- [x] MEDIUM-01 reavaliado como fixed/pass.
- [x] MEDIUM-02 reavaliado como fixed/pass.
- [x] MEDIUM-03 reavaliado como fixed/pass.
- [x] LOW-01 e LOW-02 reavaliados como fixed/pass.
- [x] Cutover classificado: Security libera próximo gate QA/cutover controlado, mas produção/legado continuam bloqueados até configuração ativa e validação real.

## Recomendação final

Security aprova o hardening de código do Workspace GitHub Sentinel para avançar ao card de cutover seguro/QA real.

Não desligar o legado e não trocar webhook GitHub principal ainda sem o próximo gate operacional:

1. configurar env real do serviço sem expor secret em repo/log;
2. restart controlado;
3. `GET /api/webhooks/github` deve expor apenas `{ ok:true }` publicamente;
4. redelivery/ping real GitHub com secret correto;
5. push/PR/workflow controlados;
6. confirmar delivery store/Telegram/rollback;
7. só então avaliar desativação do `luna-mc-v5-backend`.
