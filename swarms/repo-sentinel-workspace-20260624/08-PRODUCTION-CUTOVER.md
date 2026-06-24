# 08 — Production Cutover: Repo Sentinel Workspace

Data: 2026-06-24T19:34:54
Missão: `repo-sentinel-workspace-20260624`

## Veredito Luna

PASS para cutover público do webhook GitHub → Workspace.

O endpoint público `https://api.agenciamep.com/api/webhooks/github` agora passa pelo Workspace (`127.0.0.1:3000/api/webhooks/github`). O legado `127.0.0.1:9780` permanece ativo como hot-standby/rollback e não foi desligado nesta etapa.

## Ações executadas

1. Copiado runtime env do legado para o Workspace sem expor valores:
   - `HERMES_GITHUB_SENTINEL_ENABLED=1`
   - `HERMES_GITHUB_WEBHOOK_SECRET` configurado
   - `TELEGRAM_BOT_TOKEN` configurado
   - `TELEGRAM_CHAT_ID` configurado
   - `TELEGRAM_MESSAGE_THREAD_ID` configurado
   - `.env` com modo `0600`
   - backup: `/home/jean/hermes-workspace/.env.bak-repo-sentinel-20260624-192208`

2. Workspace reiniciado:
   - `hermes-workspace.service`: active
   - `/tasks`: 200
   - `/api/webhooks/github`: 200

3. Nginx cortado para Workspace:
   - arquivo: `/etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf`
   - backup: `/etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf.bak-workspace-cutover-20260624-192310`
   - `nginx -t`: successful
   - `systemctl reload nginx`: OK

4. Validação pública assinada:
   - public signed `ping`: HTTP 200, persisted, skipped por ser ping
   - public signed `push`: HTTP 200, persisted, Telegram enviado

5. Validação GitHub real:
   - `JE4NVRG/mc-v5` hook ping real: last_response 200 OK
   - `JE4NVRG/je4ndev-platform-core` hook ping real: last_response 200 OK
   - branch temporária em `JE4NVRG/je4ndev-platform-core`: criada, atualizada com commit de teste, deletada
   - push real GitHub: accepted, Telegram enviado
   - branch temporária removida: confirmado

6. Correção emergencial de paridade:
   - Durante o cutover, create/delete reais chegaram como eventos assinados de hook.
   - Antes do patch, eventos fora de ping/push/pull_request/workflow_run eram `unsupported_event`.
   - Patch aplicado para aceitar evento GitHub genérico com mensagem segura, evitando perda de alertas em hooks inscritos em muitos eventos.

## Validações pós-patch

- `vitest run src/server/github-sentinel.test.ts --reporter=dot`: 15/15 PASS
- `eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts`: exit 0
- `pnpm build`: exit 0
- Workspace restart pós-build: active
- GitHub real create/delete/push genérico pós-patch:
  - `create`: accepted, Telegram enviado
  - `delete`: accepted, Telegram enviado
  - `push`: accepted, Telegram enviado

## Rollback pronto

Se houver falha, rollback rápido:

```bash
sudo cp /etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf.bak-workspace-cutover-20260624-192310 /etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf
sudo nginx -t
sudo systemctl reload nginx
```

O backend legado `127.0.0.1:9780` segue ativo para esse rollback.

## Decisão operacional

Não desligar o legado imediatamente. Recomendação Luna: manter `127.0.0.1:9780` como hot standby por 24h e só então parar/desabilitar se não houver falhas no Workspace Sentinel.
