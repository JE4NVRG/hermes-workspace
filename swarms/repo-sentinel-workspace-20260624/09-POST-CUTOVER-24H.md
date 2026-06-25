# 09 — Post-Cutover 24H: Repo Sentinel Workspace

Status: CONCLUIDO — LEGADO DESLIGADO
Missão: `repo-sentinel-workspace-20260624`
Janela operacional: 2026-06-24T17:31:00Z → 2026-06-25T17:31:00Z
Auditoria final: 2026-06-25T21:05:38Z
Execução do desligamento: 2026-06-25T22:00:06Z
Decorrido no momento da auditoria: 27,58h / 24h

## Veredito Luna

PASS técnico concluído. Jean aprovou o desligamento controlado do hot-standby legado e o serviço `github-telegram-sentinel.service` foi parado/desabilitado.

O endpoint público `https://api.agenciamep.com/api/webhooks/github` permanece roteado para o Workspace em `127.0.0.1:3000/api/webhooks/github`. A porta legada `127.0.0.1:9780` está fechada.

## Decisão executada

- `systemctl --user stop github-telegram-sentinel.service`: OK
- `systemctl --user disable github-telegram-sentinel.service`: OK
- Drift check após 8s: serviço continuou `inactive/disabled`
- `ss`: nenhum listener em `127.0.0.1:9780`

## Checklist de pronto

- [x] Janela de 24h concluída
- [x] Hooks GitHub verificados com `last_response.code=200` nos repositórios do cutover
- [x] Deliveries pós-cutover no Workspace sem `failed`/`rejected`
- [x] Telegram enviado para eventos reais (`telegramSent=true` em 25/25 deliveries pós-cutover)
- [x] Workspace saudável localmente
- [x] Webhook público validado por `curl`: HTTP 200 em 2026-06-25 23:05:07 CEST
- [x] Decisão final de Jean sobre desligamento do legado `127.0.0.1:9780`: aprovado e executado
- [x] Legado `github-telegram-sentinel.service` parado/desabilitado
- [x] Porta `127.0.0.1:9780` fechada após drift check

## Métricas finais

| Métrica | Valor |
|---|---:|
| Deliveries totais persistidas | 42 |
| Deliveries pós-cutover (>= 2026-06-24T17:31Z) | 25 |
| Pós-cutover accepted | 25 |
| Pós-cutover failed/rejected/error | 0 |
| Telegram enviado pós-cutover | 25/25 |
| Hooks GitHub com last_response 200 | 2/2 |
| Horas observadas após cutover | 27,58h |

## Hooks GitHub verificados

| Repo | Hook ID | Active | URL | last_response |
|---|---:|---|---|---|
| `JE4NVRG/mc-v5` | 616071619 | true | `https://api.agenciamep.com/api/webhooks/github` | 200 OK / active |
| `JE4NVRG/je4ndev-platform-core` | 616071559 | true | `https://api.agenciamep.com/api/webhooks/github` | 200 OK / active |

## Saúde Workspace / Sentinel

| Check | Resultado |
|---|---|
| `systemctl --user is-active hermes-workspace.service` | active |
| `systemctl --user is-active hermes-gateway.service` | active |
| `systemctl --user is-active hermes-dashboard.service` | active |
| `systemctl --user is-active github-telegram-sentinel.service` | inactive |
| `systemctl --user is-enabled github-telegram-sentinel.service` | disabled |
| `curl http://127.0.0.1:3000/tasks` | HTTP 200 |
| `curl http://127.0.0.1:3000/api/claude-tasks?include_done=true` | HTTP 200 |
| `curl http://127.0.0.1:3000/api/webhooks/github/health` | HTTP 200 |
| `curl https://api.agenciamep.com/api/webhooks/github/health` | HTTP 200 |
| Workspace port | `127.0.0.1:3000` LISTEN |
| Legado hot-standby | `127.0.0.1:9780` fechado / sem listener |

## Últimos eventos reais pós-cutover observados

| Horário UTC | Repo | Evento | Status | Telegram |
|---|---|---|---|---|
| 2026-06-25T07:01:14Z | `JE4NVRG/BackuSage-Windows` | push | accepted | sent |
| 2026-06-25T06:00:42Z | `JE4NVRG/BackupVega-Mac` | push | accepted | sent |
| 2026-06-25T02:14:48Z | `JE4NVRG/vegasec` | push | accepted | sent |
| 2026-06-25T01:20:54Z | `JE4NVRG/BackupLuna-vps` | push | accepted | sent |
| 2026-06-24T22:53:30Z | `JE4NVRG/vegasec` | push | accepted | sent |
| 2026-06-24T22:46:48Z | `JE4NVRG/vegasec` | push | accepted | sent |
| 2026-06-24T21:06:46Z | `JE4NVRG/vegasec` | push | accepted | sent |
| 2026-06-24T21:01:22Z | `JE4NVRG/vegasec` | push | accepted | sent |

## Rollback pronto

Se houver falha após desligar o legado, rollback documentado no relatório de cutover:

```bash
sudo cp /etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf.bak-workspace-cutover-20260624-192310 /etc/nginx/sites-enabled/api-agenciamep-github-sentinel.conf
sudo nginx -t
sudo systemctl reload nginx
```

## Próxima ação

Task `t_74c44a85` pode ser marcada como done. Próxima frente recomendada: Supabase Project Center, porque há cards queued/blocked aguardando review e consolidação.
