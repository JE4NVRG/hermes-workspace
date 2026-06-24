# 06-QA-AFTER-HARDENING — Repo Sentinel Workspace

Data: 2026-06-24T17:13:50Z
Agente: Sentinel / QA
Missão: repo-sentinel-workspace-20260624
Veredito: PASS LOCAL PARA HARDENING / BLOCKED PARA CUTOVER REAL

## Resumo executivo

Reexecutei o QA pós-hardening do Sentinel nativo `/api/webhooks/github` no Workspace. O hardening local passou: ping assinado retorna 200, push assinado com Telegram fake 200 retorna `sent=true`, Telegram indisponível não gera 500 e persiste delivery `failed`, payload oversized retorna 413, content-type inválido retorna 415, testes unitários focados passam 14/14, ESLint focado passa e `pnpm build` passa.

Mesmo assim, o cutover real continua BLOQUEADO. O serviço ativo local em `127.0.0.1:3000` ainda responde com Sentinel desabilitado e sem secret/Telegram configurados, e a URL pública `https://workspace.agenciamep.com/api/webhooks/github` está protegida por Cloudflare Access (302 para login), portanto ainda não há evidência de ping/push real do GitHub chegando no Workspace. Não aprovar desligamento do legado nem troca de webhook de produção sem gate de env/secret/restart e redelivery real do GitHub.

## Escopo validado

Arquivos-alvo inspecionados/testados:
- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`

Artefatos de contexto lidos:
- `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/00-BRIEF.md`
- `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/01-DEV-REPORT.md`
- `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/03-SECURITY-REPORT.md`
- `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/04-QA-REPORT.md`

Script manual usado para smoke local:
- `/home/jean/.hermes/kanban/workspaces/t_5220e31c/qa-retest-github-sentinel.mjs`

## Evidência real executada

### 1) Estado git focado

Comando:

```bash
git status --short src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts src/routeTree.gen.ts
```

Resultado:

```text
M  src/routeTree.gen.ts
?? src/routes/api/webhooks/github.ts
?? src/server/github-sentinel.test.ts
?? src/server/github-sentinel.ts
```

Conclusão: os arquivos do Sentinel continuam em workspace local, ainda não são release/cutover aplicado em produção por si só.

### 2) Testes unitários focados

Comando:

```bash
pnpm vitest run src/server/github-sentinel.test.ts --reporter=verbose
```

Resultado real:

```text
Test Files  1 passed (1)
Tests       14 passed (14)
Duration    995ms
```

Casos relevantes cobertos:
- HMAC SHA-256 válido aceito.
- HMAC inválido rejeitado e persistido como status seguro.
- Sentinel habilitado sem secret retorna 503.
- Content-type não JSON rejeitado com 415.
- Payload oversized rejeitado por `content-length` com 413.
- Payload oversized sem `content-length` rejeitado durante leitura do stream com 413.
- `ALLOW_INSECURE` ignorado em `NODE_ENV=production`.
- Ping assinado aceito e persistido sem Telegram.
- Push assinado envia Telegram fake e persiste `accepted`.
- Delivery duplicado não reenvia Telegram.
- Falha de rede Telegram retorna 200 controlado e persiste `failed` com reason genérico.
- Public health não expõe `lastDelivery`/repo.
- PR/workflow continuam com HTML escapado.

### 3) ESLint focado

Comando:

```bash
pnpm eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
```

Resultado:

```text
exit_code=0
ESLintIgnoreWarning: The ".eslintignore" file is no longer supported...
```

Conclusão: sem erros nos arquivos Sentinel. O warning é global do repo e não foi introduzido por este fluxo.

### 4) Smoke manual direto do handler com payloads assinados

Comando:

```bash
node --import tsx /home/jean/.hermes/kanban/workspaces/t_5220e31c/qa-retest-github-sentinel.mjs
```

Ambiente do smoke:
- `HERMES_GITHUB_SENTINEL_ENABLED=1`
- `HERMES_GITHUB_WEBHOOK_SECRET=<secret local de QA>`
- `TELEGRAM_BOT_TOKEN=<token fake local>`
- `TELEGRAM_CHAT_ID=<chat fake local>`
- `HERMES_WORKSPACE_STATE_DIR=/tmp/repo-sentinel-after-hardening-*/state`

Resultados relevantes:

```json
{
  "label": "public-health-before",
  "publicHealth": { "ok": true },
  "internalHealth": {
    "enabled": true,
    "secretConfigured": true,
    "telegramConfigured": true,
    "deliveryCount": 0,
    "lastDelivery": null
  }
}
```

```json
{
  "label": "signed-ping",
  "status": 200,
  "json": {
    "ok": true,
    "data": {
      "event": "ping",
      "delivery": "qa-after-ping-001",
      "persisted": true,
      "sent": false,
      "skipped": true,
      "reason": "ping"
    }
  }
}
```

```json
{
  "label": "signed-push-telegram-fake-200",
  "status": 200,
  "json": {
    "ok": true,
    "data": {
      "event": "push",
      "delivery": "qa-after-push-001",
      "persisted": true,
      "sent": true,
      "skipped": false,
      "reason": null
    }
  }
}
```

```json
{
  "label": "signed-push-telegram-network-error",
  "status": 200,
  "json": {
    "ok": true,
    "data": {
      "event": "push",
      "delivery": "qa-after-push-netfail-001",
      "persisted": true,
      "sent": false,
      "skipped": false,
      "reason": "telegram_network_error"
    }
  }
}
```

```json
{
  "label": "invalid-content-type",
  "status": 415,
  "json": {
    "ok": false,
    "error": "unsupported_media_type"
  }
}
```

```json
{
  "label": "oversized-content-length",
  "status": 413,
  "json": {
    "ok": false,
    "error": "payload_too_large"
  }
}
```

Health final interno do smoke:

```json
{
  "enabled": true,
  "secretConfigured": true,
  "telegramConfigured": true,
  "deliveryCount": 3,
  "lastDelivery": {
    "deliveryId": "qa-after-push-netfail-001",
    "event": "push",
    "status": "failed",
    "repository": "JE4NVRG/hermes-workspace",
    "sender": "jean",
    "summary": "push 1 commit(s) em main",
    "telegramSent": false,
    "telegramSkipped": false,
    "reason": "telegram_network_error"
  }
}
```

Secret/token/raw error leakage check:

```json
{
  "forbiddenTokensFound": []
}
```

Conclusão: o bug P1 anterior de Telegram indisponível foi corrigido no handler testado. O webhook não retorna 500 nesse caso e mantém auditabilidade via delivery `failed`.

### 5) Build de produção

Comando:

```bash
pnpm build
```

Resultado real:

```text
vite build client: ✓ built in 41.39s
vite build ssr:    ✓ built in 20.69s
exit_code=0
```

Warnings observados: chunk size/dynamic imports/sourcemap de plugin, já de escopo global do Workspace. Não bloquearam o build e não apontaram erro Sentinel.

### 6) Serviço ativo local e URL pública

Comando:

```bash
curl -sS -i --max-time 10 http://127.0.0.1:3000/api/webhooks/github
curl -sS -i --max-time 15 https://workspace.agenciamep.com/api/webhooks/github
systemctl --user is-active hermes-workspace.service
```

Resultado local ativo:

```text
HTTP/1.1 200 OK
{"ok":true,"data":{"enabled":false,"secretConfigured":false,"telegramConfigured":false,"deliveryCount":0,"lastDelivery":null}}

hermes-workspace.service active
```

Resultado público:

```text
HTTP/2 302
location: https://je4ndev.cloudflareaccess.com/cdn-cgi/access/login/workspace.agenciamep.com?...&redirect_url=%2Fapi%2Fwebhooks%2Fgithub
www-authenticate: Cloudflare-Access resource_metadata="https://workspace.agenciamep.com/.well-known/cloudflare-access-protected-resource/api/webhooks/github"
```

Conclusão: o código fonte/harness local do handler passa, mas o serviço ativo não está configurado para Sentinel e a rota pública ainda não está disponível para GitHub por causa de Cloudflare Access. Isso mantém o cutover real bloqueado.

## Checklist do critério de pronto desta task

- [x] Ping assinado retorna 200.
  - Evidência: smoke `signed-ping` retornou HTTP 200 com `persisted=true`, `sent=false`, `skipped=true`, `reason=ping`.
- [x] Push assinado com Telegram fake retorna 200 e `sent=true`.
  - Evidência: smoke `signed-push-telegram-fake-200` retornou HTTP 200 com `persisted=true`, `sent=true`.
- [x] Telegram indisponível retorna 200 controlado e persiste `failed`.
  - Evidência: smoke `signed-push-telegram-network-error` retornou HTTP 200, `reason=telegram_network_error`, health final com `lastDelivery.status=failed`.
- [x] Payload oversized/content-type inválido rejeitados.
  - Evidência: smoke retornou 413 `payload_too_large` e 415 `unsupported_media_type`; Vitest cobre ambos inclusive stream sem `content-length`.
- [x] Endpoint health endurecido no código fonte.
  - Evidência: `readGitHubSentinelPublicHealth()` retorna apenas `{ ok: true }`; teste unitário garante ausência de `lastDelivery`/repo no public health.
- [ ] Endpoint health endurecido no serviço ativo local.
  - Evidência: `127.0.0.1:3000` ainda retorna formato antigo com `data.enabled/lastDelivery`, indicando serviço não reiniciado/reconstruído com esta versão ou env/estado ainda antigo.
- [ ] Cutover real liberado.
  - Bloqueado: serviço ativo sem `enabled/secret/telegram`, URL pública protegida por Cloudflare Access, sem ping/push real do GitHub.

## Achados atuais por severidade

### P1 / HIGH — Cutover real segue bloqueado por ambiente ativo sem Sentinel configurado e URL pública protegida

Evidência:

```text
GET http://127.0.0.1:3000/api/webhooks/github
{"enabled":false,"secretConfigured":false,"telegramConfigured":false,"deliveryCount":0}

GET https://workspace.agenciamep.com/api/webhooks/github
HTTP/2 302 Cloudflare Access login
```

Impacto:
- GitHub não conseguirá validar ping/push real na URL pública enquanto Cloudflare Access interceptar o endpoint sem bypass/service token compatível.
- O serviço ativo local ainda não está pronto para receber webhook real: sem secret e Telegram configurados.
- Desligar legado agora causaria risco de perda de alertas.

Correção/gate:
1. Configurar variáveis no serviço Workspace: `HERMES_GITHUB_SENTINEL_ENABLED=1`, `HERMES_GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
2. Reiniciar/recarregar o serviço com a build que contém `readGitHubSentinelPublicHealth()`.
3. Ajustar Cloudflare Access/WAF para permitir POST do GitHub no endpoint de webhook sem abrir o resto do Workspace indevidamente.
4. Fazer redelivery real de `ping` no GitHub e validar HTTP 200.
5. Fazer push controlado real e validar delivery persistido/alerta Telegram.
6. Só depois considerar cutover/desligamento do legado.

### P2 / MEDIUM — Serviço ativo local ainda expõe formato antigo de health

Evidência:

```text
GET http://127.0.0.1:3000/api/webhooks/github
{"ok":true,"data":{"enabled":false,"secretConfigured":false,"telegramConfigured":false,"deliveryCount":0,"lastDelivery":null}}
```

Impacto:
- O código fonte já reduz o GET público para `{ ok:true }`, mas o processo rodando em `:3000` ainda não reflete isso.
- Se esse formato antigo for o que está em produção depois do cutover, pode expor metadados de delivery quando houver eventos.

Correção/gate:
- Rebuild/restart do serviço ativo e revalidar GET local/público antes de expor a rota ao GitHub.

## Veredito final

PASS LOCAL PARA HARDENING.

Não reproduzi mais o bug crítico anterior de Telegram indisponível retornando 500. O handler agora responde 200 controlado e persiste `failed`; as proteções de payload oversized, content-type, public health reduzido, duplicate delivery e production insecure bypass estão cobertas por testes.

BLOCKED PARA CUTOVER REAL.

O endpoint ainda não pode ser considerado pronto para trocar o webhook de produção porque faltam env/secret/Telegram no serviço ativo, restart com a versão endurecida e validação real GitHub através da rota pública. Não aprovar desativação do legado `luna-mc-v5-backend` até esses gates passarem.
