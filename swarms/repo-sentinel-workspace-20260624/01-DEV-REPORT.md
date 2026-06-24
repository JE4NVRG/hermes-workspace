# DEV Report — Repo Sentinel nativo no Workspace

Data: 2026-06-24T16:51:13Z
Agente: dev
Task: t_a0c6c2bd
Missão: repo-sentinel-workspace-20260624

## Resumo executivo

Repo Sentinel nativo foi implementado no Workspace com endpoint `/api/webhooks/github` para receber eventos do GitHub, validar HMAC SHA-256, persistir status mínimo de delivery e enviar alertas ao Telegram quando configurado.

O legado `luna-mc-v5-backend` NÃO foi desligado. O corte deve acontecer somente depois de QA/cutover com ping real do GitHub e rollback validado.

## Endpoint nativo localizado/implementado

Rota Workspace:

- `GET /api/webhooks/github`
  - Health/status do Sentinel.
  - Retorna se está habilitado, se secret está configurado, se Telegram está configurado, total de deliveries persistidos e último delivery.

- `POST /api/webhooks/github`
  - Handler nativo de webhook GitHub.
  - Eventos suportados nesta entrega:
    - `ping`
    - `push`
    - `pull_request`
    - `workflow_run`

Arquivos alterados/criados:

- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`
- `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/01-DEV-REPORT.md`

A rota também está presente em `/home/jean/hermes-workspace/src/routeTree.gen.ts` como `/api/webhooks/github`.

## Segurança implementada

- Validação de assinatura `X-Hub-Signature-256` com HMAC SHA-256.
- Comparação com `timingSafeEqual` para evitar comparação insegura de segredo.
- Se `HERMES_GITHUB_SENTINEL_ENABLED=1` e o secret não estiver configurado, o endpoint falha fechado com HTTP 503 e erro genérico `github_webhook_secret_not_configured`.
- Assinatura inválida retorna HTTP 401 e erro genérico `invalid_github_signature`.
- Payload inválido retorna HTTP 400 e erro genérico `invalid_json_payload`.
- Eventos não suportados são persistidos como `skipped`, sem executar alerta.
- Mensagens Telegram usam HTML escapado para campos vindos do payload (`repo`, `sender`, `branch`, `commit message`, PR title, workflow name etc.).
- Logs/retornos não imprimem token Telegram, webhook secret nem payload bruto.
- Persistência de status salva apenas metadados mínimos:
  - deliveryId
  - event
  - status
  - repository
  - sender
  - summary
  - flags de Telegram
  - reason
  - receivedAt

## Configuração de ambiente

Variáveis principais:

```bash
HERMES_GITHUB_SENTINEL_ENABLED=1
HERMES_GITHUB_WEBHOOK_SECRET=<secret configurado no webhook do GitHub>
TELEGRAM_BOT_TOKEN=<token do bot Telegram>
TELEGRAM_CHAT_ID=<chat/thread de destino>
# opcional
TELEGRAM_MESSAGE_THREAD_ID=<thread id>
HERMES_WORKSPACE_STATE_DIR=/home/jean/.hermes/workspace
```

Compatibilidade de nomes também aceita:

```bash
GITHUB_SENTINEL_ENABLED=1
GITHUB_WEBHOOK_SECRET=<secret>
HERMES_TELEGRAM_BOT_TOKEN=<token>
HERMES_TELEGRAM_CHAT_ID=<chat>
HERMES_TELEGRAM_MESSAGE_THREAD_ID=<thread id>
```

Variável de emergência para ambiente local controlado, NÃO recomendada em produção:

```bash
HERMES_GITHUB_WEBHOOK_ALLOW_INSECURE=1
```

## Validação local executada

### 1) Testes unitários/handler

Comando:

```bash
./node_modules/.bin/vitest run src/server/github-sentinel.test.ts
```

Resultado real:

```text
✓ src/server/github-sentinel.test.ts (7 tests) 85ms
Test Files  1 passed (1)
Tests       7 passed (7)
```

Cobertura validada pelos testes:

- Assinatura HMAC SHA-256 válida é aceita.
- Assinatura HMAC SHA-256 inválida é rejeitada.
- Request de webhook com assinatura inválida retorna 401 e persiste status seguro sem vazar secret.
- Sentinel habilitado sem secret retorna 503 e falha fechado.
- Payload `ping` é aceito e persistido sem envio Telegram.
- Payload `push` gera mensagem Telegram escapada, persiste delivery e não expõe token/secret.
- Payloads `pull_request` e `workflow_run` são formatados com escape HTML.

### 2) Lint direcionado

Comando:

```bash
./node_modules/.bin/eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
```

Resultado real:

```text
exit_code=0
ESLintIgnoreWarning: The ".eslintignore" file is no longer supported...
```

Sem erros nos arquivos do Sentinel. O aviso é repo-level e não foi introduzido por esta entrega.

### 3) Smoke local com payload assinado

Comando executado com segredo temporário local e sem Telegram configurado:

```bash
HERMES_WORKSPACE_STATE_DIR=/tmp/github-sentinel-smoke-$$ \
HERMES_GITHUB_SENTINEL_ENABLED=1 \
HERMES_GITHUB_WEBHOOK_SECRET=<secret temporário local> \
node --import tsx - <<'EOF'
import { createHmac } from 'node:crypto'
import { handleGitHubWebhook, readGitHubSentinelHealth } from './src/server/github-sentinel.ts'
const body = JSON.stringify({ repository: { full_name: 'JE4NVRG/hermes-workspace' }, ref: 'refs/heads/main', sender: { login: 'jean' }, commits: [{ id: 'abcdef1234567890', message: 'smoke: validate sentinel', author: { username: 'jean' } }] })
const signature = 'sha256=' + createHmac('sha256', process.env.HERMES_GITHUB_WEBHOOK_SECRET).update(body).digest('hex')
const request = new Request('http://localhost/api/webhooks/github', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'smoke-delivery-1', 'x-hub-signature-256': signature }, body })
const response = await handleGitHubWebhook(request)
console.log(JSON.stringify({ status: response.status, body: await response.json(), health: readGitHubSentinelHealth() }, null, 2))
EOF
```

Resultado real resumido:

```json
{
  "status": 200,
  "body": {
    "ok": true,
    "data": {
      "event": "push",
      "delivery": "smoke-delivery-1",
      "persisted": true,
      "sent": false,
      "skipped": true,
      "reason": "telegram_not_configured"
    }
  },
  "health": {
    "enabled": true,
    "secretConfigured": true,
    "telegramConfigured": false,
    "deliveryCount": 1,
    "lastDelivery": {
      "deliveryId": "smoke-delivery-1",
      "event": "push",
      "status": "accepted",
      "repository": "JE4NVRG/hermes-workspace",
      "sender": "jean",
      "summary": "push 1 commit(s) em main",
      "telegramSent": false,
      "telegramSkipped": true,
      "reason": "telegram_not_configured"
    }
  }
}
```

### 4) TypeScript global

Comando:

```bash
./node_modules/.bin/tsc --noEmit --pretty false
```

Resultado real:

- Falhou com erros globais já existentes fora dos arquivos do Sentinel.
- Exemplos: specs Playwright sem `@playwright/test`, tipos de `playground-ws-worker`, `prompt-kit/text-shimmer`, `workspace-shell`, `swarm2`, `three`, etc.
- Nenhum erro novo apontou para:
  - `src/server/github-sentinel.ts`
  - `src/server/github-sentinel.test.ts`
  - `src/routes/api/webhooks/github.ts`

## Plano de deploy

1. Revisar os arquivos alterados.
2. Configurar variáveis no ambiente do serviço Workspace, sem hardcode em repo:
   - `HERMES_GITHUB_SENTINEL_ENABLED=1`
   - `HERMES_GITHUB_WEBHOOK_SECRET=<secret do webhook GitHub>`
   - `TELEGRAM_BOT_TOKEN=<token>`
   - `TELEGRAM_CHAT_ID=<destino>`
   - opcional: `TELEGRAM_MESSAGE_THREAD_ID=<thread>`
3. Reiniciar o serviço Workspace:

```bash
sudo systemctl restart hermes-workspace.service
sudo systemctl status hermes-workspace.service --no-pager
```

4. Validar health público/roteado:

```bash
curl -sS https://workspace.agenciamep.com/api/webhooks/github
```

5. No GitHub, configurar webhook com:
   - Payload URL: `https://workspace.agenciamep.com/api/webhooks/github`
   - Content type: `application/json`
   - Secret: mesmo valor de `HERMES_GITHUB_WEBHOOK_SECRET`
   - Eventos: `ping`, `push`, `pull_request`, `workflow_run`

6. Enviar `Redeliver` de um ping GitHub e validar:
   - GitHub mostra HTTP 200.
   - `GET /api/webhooks/github` mostra `lastDelivery.event = ping`.
   - Push/PR/workflow simulado ou real gera delivery aceito.
   - Telegram só envia quando token/chat estiverem configurados.

## Plano de cutover

1. Manter webhook/serviço legado ativo durante validação de paridade.
2. Ativar Workspace Sentinel em paralelo.
3. Executar sequência de eventos:
   - ping
   - push pequeno em branch controlada
   - pull_request opened/synchronize/closed
   - workflow_run completed success/failure
4. Comparar comportamento legado vs Workspace:
   - evento recebido
   - alerta esperado
   - ausência de secret em logs
   - status persistido
5. Depois de QA aprovar paridade, alterar webhook principal do GitHub para Workspace ou remover endpoint legado do webhook.
6. Só então seguir com card específico de desativação do legado `t_a7a8b1b9`.

## Rollback

Se o Workspace Sentinel falhar após cutover:

1. Reverter Payload URL do webhook GitHub para o endpoint legado anterior ou reativar entrega para legado.
2. Definir `HERMES_GITHUB_SENTINEL_ENABLED=0` no Workspace ou remover a variável.
3. Reiniciar `hermes-workspace.service`.
4. Confirmar que `GET /api/webhooks/github` retorna `enabled: false`.
5. Redeliver no GitHub para o endpoint legado e confirmar entrega.
6. Não desligar `luna-mc-v5-backend` até correção e nova validação.

## Status dos critérios de pronto

- [x] Endpoint Workspace nativo localizado/implementado: `/api/webhooks/github`.
- [x] Validação HMAC/payload testada localmente: 7 testes + smoke assinado.
- [x] Logs/retornos não expõem secrets: testes e revisão garantem resposta mínima e sem payload bruto/token/secret.
- [x] Rollback/cutover documentado neste relatório.
- [ ] QA real pós-deploy/cutover: pendente de card QA/cutover com webhook real do GitHub.

## Atualização P1 — Resiliência quando Telegram está indisponível

Data: 2026-06-24T19:02:22+02:00
Task: t_1e1cc71a

Correção aplicada/validada para o bug encontrado pelo QA:

- `sendTelegramMessage()` agora envolve o `fetch` Telegram em `try/catch`, usa `AbortSignal.timeout(5000)` e retorna `{ sent:false, skipped:false, reason:'telegram_network_error' }` em falhas de rede sem propagar exceção bruta.
- `handleGitHubWebhook()` persiste deliveries autenticados como `status: 'failed'` quando o Telegram falha após o evento GitHub já ter sido recebido e autenticado.
- A resposta HTTP escolhida para GitHub neste cenário é `200` com `ok:true`, porque o webhook foi autenticado/recebido e a falha é do canal secundário de alerta; o delivery fica auditável como `failed` para correção operacional.
- O reason persistido é sanitizado e não inclui erro bruto, token, secret ou payload completo.

Arquivos relevantes:

- `/home/jean/hermes-workspace/src/server/github-sentinel.ts`
- `/home/jean/hermes-workspace/src/server/github-sentinel.test.ts`
- `/home/jean/hermes-workspace/src/routes/api/webhooks/github.ts`

Validação real executada nesta rodada:

```text
$ ./node_modules/.bin/vitest run src/server/github-sentinel.test.ts --reporter=verbose
Test Files  1 passed (1)
Tests       14 passed (14)
```

```text
$ ./node_modules/.bin/eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts
exit_code=0
ESLintIgnoreWarning: The ".eslintignore" file is no longer supported...
```

Smoke manual do caso P1 com `globalThis.fetch` rejeitando:

```text
status 200
body {"ok":true,"data":{"event":"push","delivery":"manual-telegram-network-failure","persisted":true,"sent":false,"skipped":false,"reason":"telegram_network_error"}}
lastDelivery {"deliveryId":"manual-telegram-network-failure","event":"push","status":"failed","repository":"JE4NVRG/workspace","sender":"jean","summary":"push 1 commit(s) em main","telegramSent":false,"telegramSkipped":false,"reason":"telegram_network_error",...}
```

Observação: por hardening de Security, o `GET /api/webhooks/github` público pode retornar somente `{ ok:true }`. A persistência completa continua disponível via store/leitura interna (`readGitHubSentinelHealth()`), não deve ser exposta publicamente sem autenticação.

## Observações

- Esta entrega não altera DNS, Cloudflare, webhook real do GitHub nem desliga legado.
- O repositório já contém muitas alterações não relacionadas em andamento; escopo desta task ficou restrito aos arquivos listados acima.
- Próximo passo recomendado: revisão Security/QA e depois card `t_c35f597e` para corte seguro do webhook GitHub para Workspace.
