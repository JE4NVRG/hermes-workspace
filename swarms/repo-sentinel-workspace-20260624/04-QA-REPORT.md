# 04-QA-REPORT — Repo Sentinel Workspace

Data: 2026-06-24T18:57:14+02:00
Agente: Sentinel / QA
Missão: repo-sentinel-workspace-20260624
Veredito: FAIL / BLOCKED PARA CUTOVER

## Resumo executivo

O endpoint nativo `/api/webhooks/github` existe e passou no fluxo local assinado quando testado em servidor dev isolado na porta 3017 com HMAC SHA-256, healthcheck, ping assinado, push assinado e Telegram fake retornando 200.

Mesmo assim, o cutover real GitHub → Workspace NÃO deve ser liberado ainda porque encontrei um bug P1: quando Telegram está configurado mas a chamada HTTP falha por erro de rede, o POST de `push` retorna HTTP 500 `HTTPError` e não persiste o delivery de sucesso/falha do push. Também confirmei que o serviço local atual em `127.0.0.1:3000` está com Sentinel desabilitado e sem secret/Telegram configurados, então ainda não existe base para redelivery real do GitHub em produção.

## Escopo validado

Brief validado: `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/00-BRIEF.md`

Arquivos-alvo inspecionados:
- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`

## Evidência real executada

### 1) Serviço local atual / produção local

Comando:
```bash
curl -sS -i http://127.0.0.1:3000/api/webhooks/github
systemctl --user status hermes-workspace.service --no-pager -l
```

Resultado relevante:
```text
HTTP/1.1 200 OK
{"ok":true,"data":{"enabled":false,"secretConfigured":false,"telegramConfigured":false,"deliveryCount":0,"lastDelivery":null}}

hermes-workspace.service: active (running)
```

Conclusão: a rota está acessível no serviço local, mas Sentinel ainda está desligado no ambiente ativo. Não há secret nem Telegram configurados nesse serviço.

### 2) Testes unitários focados

Comando:
```bash
./node_modules/.bin/vitest run src/server/github-sentinel.test.ts --reporter=verbose
```

Resultado:
```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

Cobertura observada:
- assinatura HMAC válida aceita;
- assinatura HMAC inválida rejeitada;
- falta de secret com Sentinel ativo retorna erro seguro;
- ping assinado persiste status sem Telegram;
- push assinado com fetch mockado envia HTML escapado para Telegram;
- PR/workflow formatados com escape.

### 3) ESLint dos arquivos alterados

Comando:
```bash
./node_modules/.bin/eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
```

Resultado:
```text
exit_code=0
ESLintIgnoreWarning: ".eslintignore" file is no longer supported
```

Conclusão: sem erros nos arquivos Sentinel; só warning global de configuração ESLint.

### 4) Build de produção

Comando:
```bash
pnpm build
```

Resultado:
```text
vite build client: built in 44.24s
vite build ssr: built in 19.42s
exit_code=0
```

Conclusão: build passa. Warnings de chunk size/dynamic import são existentes e não específicos do Sentinel.

### 5) TypeScript global

Comando:
```bash
./node_modules/.bin/tsc --noEmit --pretty false
```

Resultado:
```text
exit_code=2
```

Falhas observadas: múltiplos erros globais já existentes fora do escopo Sentinel, incluindo `@playwright/test` ausente em e2e, tipos de DurableObject/WebSocket no `playground-ws-worker`, e erros em componentes/rotas de chat/swarm/playground. Não vi erro específico nos três arquivos Sentinel alterados no trecho retornado.

### 6) Healthcheck no servidor dev isolado com Sentinel habilitado

Ambiente de QA isolado:
- URL: `http://127.0.0.1:3017/api/webhooks/github`
- `HERMES_WORKSPACE_STATE_DIR`: `/tmp/repo-sentinel-qa-1782319960/state`
- Sentinel habilitado
- Secret de teste local
- Telegram fake em `http://127.0.0.1:3021`

Resultado:
```text
health-before HTTP 200 {"ok":true,"data":{"enabled":true,"secretConfigured":true,"telegramConfigured":true,"deliveryCount":0,"lastDelivery":null}}
```

### 7) Ping assinado local

Resultado:
```text
POST ping qa3-ping-001 HTTP 200
{"ok":true,"data":{"event":"ping","delivery":"qa3-ping-001","persisted":true,"sent":false,"skipped":true,"reason":"ping"}}
```

Conclusão: PASS. Ping assinado é aceito e persistido; Telegram é corretamente ignorado para ping.

### 8) Push assinado local com Telegram fake 200

Resultado:
```text
POST push qa3-push-001 HTTP 200
{"ok":true,"data":{"event":"push","delivery":"qa3-push-001","persisted":true,"sent":true,"skipped":false,"reason":null}}
```

Health após push:
```text
health-after-valid HTTP 200
{"ok":true,"data":{"enabled":true,"secretConfigured":true,"telegramConfigured":true,"deliveryCount":5,"lastDelivery":{"deliveryId":"qa3-push-001","event":"push","status":"accepted","repository":"JE4NVRG/hermes-workspace","sender":"jean","summary":"push 1 commit(s) em main","telegramSent":true,"telegramSkipped":false,"reason":null,"receivedAt":"2026-06-24T16:53:40.691Z"}}}
```

Telegram fake recebeu:
```text
POST /bot***/sendMessage
text: 🚀 GitHub push / Repo JE4NVRG/hermes-workspace / Branch main / 1 commit
parse_mode: HTML
```

Conclusão: PASS no caminho feliz assinado com Telegram respondendo 200. O texto escapou `<no secret>` como `&lt;no secret&gt;`.

### 9) Assinatura inválida

Resultado:
```text
POST push qa2-push-badsig HTTP 401
{"ok":false,"error":"invalid_github_signature"}
```

Delivery store:
```text
{'deliveryId': 'qa2-push-badsig', 'event': 'push', 'status': 'rejected', 'summary': 'assinatura GitHub inválida', 'reason': 'invalid_github_signature'}
```

Conclusão: PASS. Rejeita assinatura inválida e persiste status seguro.

### 10) Ausência de secrets no delivery store

Comando de inspeção procurou tokens sensíveis de teste no arquivo `/tmp/repo-sentinel-qa-1782319960/state/github-sentinel-deliveries.json`.

Resultado:
```text
forbidden_tokens_found []
```

Conclusão: PASS. Delivery store não expôs secret/token/env name sensível nos dados persistidos.

## Achados por severidade

### P1 / HIGH — POST push retorna 500 se Telegram estiver configurado mas indisponível

Passos para reproduzir:
1. Subir Workspace dev com:
   - `HERMES_GITHUB_SENTINEL_ENABLED=1`
   - `HERMES_GITHUB_WEBHOOK_SECRET=<secret>`
   - `TELEGRAM_BOT_TOKEN=<qualquer>`
   - `TELEGRAM_CHAT_ID=<qualquer>`
   - `TELEGRAM_API_BASE=http://127.0.0.1:9` ou outro endpoint indisponível
2. Enviar payload `push` com `x-github-event: push`, `x-github-delivery` e HMAC válido.

Evidência:
```text
POST push qa-push-001 -> HTTP 500 {"status":500,"unhandled":true,"message":"HTTPError"}
GET health -> lastDelivery ainda apontava para a rejeição anterior, sem delivery persistido para qa-push-001
```

Impacto:
- GitHub receberia 500 e tenderia a redeliver/retry.
- O Workspace perde observabilidade do push porque o delivery não é persistido após falha de rede no Telegram.
- O webhook fica acoplado à disponibilidade do Telegram; isso é perigoso no cutover.

Correção sugerida:
- `sendTelegramMessage()` deve capturar exceções de `fetch` e retornar `{ sent:false, skipped:false, reason:'telegram_network_error' }` ou similar.
- `handleGitHubWebhook()` deve persistir delivery `failed` e retornar resposta controlada, idealmente 200/202 para evento recebido com alerta falho, ou política explícita decidida por Security/Gerente.
- Adicionar teste unitário cobrindo `fetch` rejected/network error.

### P1 / HIGH — ambiente ativo ainda não está configurado para Sentinel

Evidência:
```text
GET http://127.0.0.1:3000/api/webhooks/github
{"enabled":false,"secretConfigured":false,"telegramConfigured":false,"deliveryCount":0}
```

Impacto:
- Não há como validar GitHub ping/push real no endpoint ativo sem gate de configuração/restart.
- Cutover real ainda não pode acontecer.

Correção / próximo gate:
- Definir secret de webhook e variáveis Telegram no serviço `hermes-workspace.service` ou `.env` aprovado.
- Restart controlado.
- Reexecutar `GET /api/webhooks/github` e exigir `enabled=true`, `secretConfigured=true`, `telegramConfigured=true` antes de pedir redelivery real do GitHub.

### P2 / MEDIUM — `tsc --noEmit` global continua quebrado

Evidência: `tsc --noEmit --pretty false` retornou exit code 2 com erros globais fora do Sentinel.

Impacto:
- Type gate global não pode ser usado como sinal limpo de release.
- Risco de mascarar regressões futuras.

Nota: build de produção passou; ESLint focado e Vitest focado passaram.

## Checklist do critério de pronto

- [x] Endpoint Workspace nativo localizado: `/api/webhooks/github`.
- [x] Health local validado com Sentinel habilitado em servidor dev isolado.
- [x] HMAC válido aceito em `ping` e `push`.
- [x] HMAC inválido rejeitado com 401 e delivery seguro.
- [x] Push assinado gera mensagem Telegram esperada quando Telegram retorna 200.
- [x] Delivery store não expôs secrets de teste.
- [x] Build de produção passa.
- [x] ESLint focado passa.
- [ ] TypeScript global limpo: FAIL por erros globais existentes.
- [ ] Resiliência Telegram indisponível: FAIL por HTTP 500 e delivery não persistido.
- [ ] Ambiente ativo configurado: FAIL (`enabled=false`, `secretConfigured=false`, `telegramConfigured=false`).
- [ ] GitHub ping/push real: NÃO EXECUTADO; bloqueado até Dev/Security/Gerente liberarem secret, restart e cutover/redelivery.

## Veredito final

FAIL / BLOCKED PARA CUTOVER.

O caminho feliz local assinado está comprovado, mas não aprovo troca de webhook real ainda. O próximo gate deve ser:

1. Dev corrigir falha de rede do Telegram para não explodir o webhook com 500 e persistir delivery `failed`.
2. Security revisar a política de status HTTP quando Telegram falha depois que o evento GitHub já foi autenticado e recebido.
3. Gerente confirmar plano de cutover/rollback.
4. Configurar serviço ativo com Sentinel + secret + Telegram e reiniciar.
5. QA reexecutar health ativo, ping real GitHub e push real GitHub antes de desligar legado.
