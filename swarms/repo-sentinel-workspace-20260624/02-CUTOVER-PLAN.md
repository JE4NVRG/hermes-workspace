# Plano de cutover seguro — GitHub Webhook → Workspace Sentinel

Missão: `repo-sentinel-workspace-20260624`
Data: 2026-06-24
Owner operacional: Gerente
Status: pronto para revisão; execução bloqueada até Dev + Security + QA validarem paridade.

## 1. Resumo executivo

Objetivo: mover o tráfego GitHub → Telegram/Workspace do Sentinel standalone legado para o endpoint nativo do Hermes Workspace, sem perder alertas e sem expor segredo.

Recomendação de menor risco: manter a URL pública que o GitHub já usa e trocar apenas o upstream interno no Nginx.

- URL pública atual/recomendada para o GitHub: `https://api.agenciamep.com/api/webhooks/github`
- Backend atual: `127.0.0.1:9780` — script standalone `/home/jean/.hermes/scripts/github_telegram_sentinel_standalone.py`
- Backend alvo: `127.0.0.1:3000` — Hermes Workspace/TanStack Start route `/api/webhooks/github`
- Motivo: evita alteração manual de URL nos webhooks GitHub e evita a barreira de Basic Auth de `workspace.agenciamep.com`.

Não executar cutover enquanto qualquer gate abaixo estiver vermelho:

1. Dev: endpoint Workspace habilitado, com HMAC e Telegram configurados.
2. Security: segredo configurado via env/secret store, logs sem token/secret, HMAC obrigatório.
3. QA: ping real GitHub e push real GitHub validados ponta a ponta.

## 2. Estado atual verificado

### 2.1 Endpoint atual

Endpoint público atual:

```text
https://api.agenciamep.com/api/webhooks/github
```

Nginx atual:

```text
/etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf
location = /api/webhooks/github {
    proxy_pass http://127.0.0.1:9780/api/webhooks/github;
}
location = /api/webhooks/github/health {
    proxy_pass http://127.0.0.1:9780/api/health;
}
```

Serviço/processo atual observado:

```text
/usr/bin/python3 /home/jean/.hermes/scripts/github_telegram_sentinel_standalone.py
LISTEN 127.0.0.1:9780
```

Health público atual observado:

```text
GET https://api.agenciamep.com/api/webhooks/github/health
→ {"ok": true, "service": "github-telegram-sentinel", "mc5_dependency": false, ...}
```

Observação: `GET /api/webhooks/github` no backend atual retorna 404; isso é esperado, pois o legado aceita POST no webhook e health em `/api/health`.

### 2.2 Endpoint alvo Workspace

Endpoint nativo implementado no Workspace:

```text
Route: /api/webhooks/github
Arquivo: /home/jean/hermes-workspace/src/routes/api/webhooks/github.ts
Handler: /home/jean/hermes-workspace/src/server/github-sentinel.ts
```

Backend local alvo:

```text
http://127.0.0.1:3000/api/webhooks/github
```

Health local observado via GET:

```json
{
  "ok": true,
  "data": {
    "enabled": false,
    "secretConfigured": false,
    "telegramConfigured": false,
    "deliveryCount": 0,
    "lastDelivery": null
  }
}
```

Interpretação: código/rota existem, mas o ambiente alvo ainda precisa de configuração antes do cutover:

- `HERMES_GITHUB_SENTINEL_ENABLED=1`
- `HERMES_GITHUB_WEBHOOK_SECRET` ou `GITHUB_WEBHOOK_SECRET` configurado com o mesmo segredo esperado pelo GitHub
- `TELEGRAM_BOT_TOKEN`/`HERMES_TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`/`HERMES_TELEGRAM_CHAT_ID` configurados se o alerta Telegram continuar no escopo

### 2.3 Endpoint público direto Workspace não recomendado

`https://workspace.agenciamep.com/api/webhooks/github` fica atrás do Nginx do Workspace, que hoje aplica Basic Auth em `location /`.

GitHub não envia Basic Auth nessa integração. Portanto, só usar esse domínio se for criado um `location = /api/webhooks/github` com `auth_basic off` e proxy para `127.0.0.1:3000`.

Preferência operacional: manter `api.agenciamep.com` e trocar upstream.

## 3. Diferenças de paridade obrigatórias

Antes do cutover, comparar eventos suportados:

Standalone atual suporta, entre outros:

```text
push, pull_request, workflow_run, workflow_job, issues, issue_comment,
pull_request_review, pull_request_review_comment, commit_comment, discussion,
discussion_comment, star, fork, watch, create, delete, release, ping
```

Workspace atual suporta explicitamente:

```text
ping, push, pull_request, workflow_run
```

Gate crítico: se os webhooks GitHub ativos enviam eventos além de `ping`, `push`, `pull_request` e `workflow_run`, Dev deve ampliar o Workspace Sentinel ou Security/QA devem aprovar a perda consciente desses eventos. Sem essa decisão, não cortar.

## 4. Plano de cutover

### Fase 0 — Congelar execução destrutiva

- Não desligar `github_telegram_sentinel_standalone.py`.
- Não desativar `luna-mc-v5-backend` como parte deste card.
- Não alterar DNS/Cloudflare.
- Não imprimir, copiar para docs ou colar em logs o valor do webhook secret ou tokens Telegram.

### Fase 1 — Pré-configurar Workspace

1. Configurar variáveis de ambiente do processo Workspace:
   - `HERMES_GITHUB_SENTINEL_ENABLED=1`
   - `HERMES_GITHUB_WEBHOOK_SECRET=<mesmo segredo do webhook GitHub>`
   - Telegram envs necessários, sem expor valores.
2. Reiniciar o Workspace de forma controlada.
3. Validar localmente:

```bash
curl -fsS http://127.0.0.1:3000/api/webhooks/github
```

Critério esperado:

```text
enabled=true
secretConfigured=true
telegramConfigured=true se Telegram estiver no escopo imediato
```

### Fase 2 — Teste local assinado antes de mexer no Nginx

Executar POST local assinado contra o Workspace com payload `ping` e depois `push` mínimo. O segredo deve ser lido de ambiente local, nunca escrito no comando em texto puro.

Modelo seguro de comando:

```bash
BODY='{"zen":"cutover-test","repository":{"full_name":"outsourc-e/hermes-workspace"},"sender":{"login":"jean"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$HERMES_GITHUB_WEBHOOK_SECRET" -binary | xxd -p -c 256)"
curl -fsS \
  -X POST http://127.0.0.1:3000/api/webhooks/github \
  -H 'content-type: application/json' \
  -H 'x-github-event: ping' \
  -H 'x-github-delivery: local-cutover-ping-001' \
  -H "x-hub-signature-256: $SIG" \
  --data-binary "$BODY"
```

Critério esperado:

```text
HTTP 200
ok=true
event=ping
persisted=true ou delivery gravado no health
sem secret/token em stdout/log
```

### Fase 3 — Trocar upstream Nginx mantendo URL pública

Alterar somente o arquivo:

```text
/etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf
```

Troca proposta:

```nginx
location = /api/webhooks/github {
    proxy_pass http://127.0.0.1:3000/api/webhooks/github;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Hub-Signature-256 $http_x_hub_signature_256;
    proxy_set_header X-GitHub-Event $http_x_github_event;
    proxy_set_header X-GitHub-Delivery $http_x_github_delivery;
    proxy_read_timeout 15s;
}

location = /api/webhooks/github/health {
    proxy_pass http://127.0.0.1:3000/api/webhooks/github;
}
```

Validação antes de reload:

```bash
sudo nginx -t
```

Aplicação:

```bash
sudo systemctl reload nginx
```

Validação imediata:

```bash
curl -fsS https://api.agenciamep.com/api/webhooks/github/health
curl -fsS https://api.agenciamep.com/api/webhooks/github
```

Critério esperado: resposta JSON do Workspace com `enabled=true` e `secretConfigured=true`.

### Fase 4 — Ping real GitHub

Executar via UI do GitHub ou API oficial `ping`/`redeliver`, sem registrar secret.

Checklist real:

- [ ] Abrir repo GitHub que contém o webhook ativo.
- [ ] Confirmar URL do webhook: `https://api.agenciamep.com/api/webhooks/github`.
- [ ] Clicar em “Redeliver” no evento `ping` ou usar API de ping com escopo apropriado.
- [ ] GitHub mostra resposta 2xx.
- [ ] `GET https://api.agenciamep.com/api/webhooks/github/health` mostra `lastDelivery.event=ping`.
- [ ] Logs do Workspace não contêm segredo, token Telegram, assinatura completa sensível ou payload excessivo.

Nota de permissão: no momento da preparação, `gh api repos/outsourc-e/hermes-workspace/hooks` falhou por falta do escopo `admin:repo_hook`. Se a validação for por CLI, Jean precisa autorizar `gh auth refresh -h github.com -s admin:repo_hook` ou alguém com permissão admin deve operar pela UI.

### Fase 5 — Push real GitHub

Executar um push controlado em branch de teste ou commit vazio, após ping passar.

Opção segura:

```bash
git checkout -b cutover/github-sentinel-smoke-YYYYMMDD
git commit --allow-empty -m "chore: github sentinel cutover smoke"
git push origin cutover/github-sentinel-smoke-YYYYMMDD
```

Checklist real:

- [ ] GitHub delivery do evento `push` retorna 2xx.
- [ ] Workspace health mostra `lastDelivery.event=push`.
- [ ] Registro persistido inclui repo, sender e resumo correto.
- [ ] Telegram recebe alerta, se Telegram estiver configurado no escopo.
- [ ] Não há duplicidade de alerta entre standalone e Workspace.
- [ ] Não há secret/token em log.

### Fase 6 — Observação pós-cutover

Janela mínima: 30 minutos ou 3 eventos reais, o que vier primeiro.

Monitorar:

```bash
curl -fsS https://api.agenciamep.com/api/webhooks/github/health
journalctl ou logs do processo Workspace filtrando apenas status/erros, sem imprimir env
```

Métricas mínimas:

- taxa de resposta GitHub: 100% 2xx nos eventos de teste;
- latência por evento: alvo < 5s;
- alertas duplicados: 0;
- erros HMAC inesperados: 0;
- vazamento de segredo em log: 0.

## 5. Rollback claro

Rollback deve ser imediato se qualquer condição ocorrer:

- GitHub ping/push retorna 4xx/5xx no endpoint público.
- Workspace responde `sentinel_disabled`, `github_webhook_secret_not_configured` ou `invalid_github_signature` com payload real válido.
- Telegram deixa de receber alertas que recebia no standalone.
- Logs mostram risco de exposição de segredo/token.
- Eventos importantes do GitHub deixam de ser suportados.

Passos de rollback:

1. Restaurar upstream Nginx antigo:

```nginx
location = /api/webhooks/github {
    proxy_pass http://127.0.0.1:9780/api/webhooks/github;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Hub-Signature-256 $http_x_hub_signature_256;
    proxy_set_header X-GitHub-Event $http_x_github_event;
    proxy_set_header X-GitHub-Delivery $http_x_github_delivery;
    proxy_read_timeout 15s;
}

location = /api/webhooks/github/health {
    proxy_pass http://127.0.0.1:9780/api/health;
}
```

2. Validar e recarregar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

3. Confirmar retorno do legado:

```bash
curl -fsS https://api.agenciamep.com/api/webhooks/github/health
```

Esperado:

```text
service=github-telegram-sentinel
mc5_dependency=false
```

4. Redeliver do último evento GitHub que falhou.
5. Registrar motivo do rollback no card do Kanban e abrir follow-up para Dev/Security conforme falha.

## 6. Segurança e segredos

Regras obrigatórias:

- Nunca colar valor real de `GITHUB_WEBHOOK_SECRET`, `HERMES_GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN` ou `HERMES_TELEGRAM_BOT_TOKEN` neste documento, no Kanban ou em logs.
- HMAC SHA-256 (`x-hub-signature-256`) obrigatório em produção.
- `HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE`/`GITHUB_WEBHOOK_ALLOW_INSECURE` deve ficar desligado em produção.
- Usar comparação em tempo constante; o Workspace já usa `timingSafeEqual`.
- Persistir apenas metadados mínimos de delivery: delivery id, evento, repo, sender, resumo, status.
- Não persistir payload completo salvo necessidade de debug temporário com aprovação explícita.

## 7. Critério final de pronto

- [x] Endpoint atual documentado.
- [x] Endpoint alvo documentado.
- [x] Checklist de teste real GitHub ping/push definido.
- [x] Rollback claro definido.
- [x] Nenhum segredo exposto neste artefato.
- [ ] Dev validou paridade funcional/eventos.
- [ ] Security validou HMAC/logs/env.
- [ ] QA executou ping e push reais no endpoint público.
- [ ] Só depois: cortar upstream Nginx e observar 30min/3 eventos.

## 8. Decisão operacional

Ação aprovada agora: usar este plano como runbook de cutover.

Ação não aprovada neste card: executar o cutover real. O próprio brief bloqueia troca de webhook de produção antes de teste assinado e rollback, e exige paridade Dev + Security + QA.
