# Missão P1 — Repo Sentinel nativo no Workspace

Data: 2026-06-24
Owner: Luna
Status: iniciada após PASS da missão `workspace-standard-20260624`.

## Objetivo

Mover o fluxo GitHub → Telegram/Workspace para uma implementação nativa do Workspace, reduzindo dependência de legado e mantendo alertas de repo/PR/push confiáveis.

## Contexto verificado

Prioridade anterior concluída:
- Workspace Standard / missão atual: PASS visual desktop/mobile após restart.
- Artefato: `/home/jean/hermes-workspace/swarms/workspace-standard-20260624/05-QA-AFTER-RESTART.md`

Cards existentes relacionados:
- `t_a0c6c2bd` — `[Workspace Finalization] Implementar Repo Sentinel nativo no Workspace`
- `t_c35f597e` — `[Workspace Finalization] Configurar corte seguro do webhook GitHub para Workspace`
- `t_a7a8b1b9` — `[Workspace Finalization] Desativar legado luna-mc-v5-backend após paridade do Sentinel`
- `t_1cc0a1d0` — `[QA] Validar fluxo completo Workspace Sentinel Supabase`

## Escopo P1

- Inventariar o fluxo atual do GitHub Sentinel.
- Implementar/validar endpoint nativo no Workspace para eventos GitHub.
- Manter segurança: HMAC/assinatura, logs sem secrets, payload mínimo.
- Validar localmente com payload assinado.
- Preparar plano de cutover do webhook, mas não desligar legado antes de paridade comprovada.

## Fora de escopo sem gate explícito

- Alterar DNS/Cloudflare.
- Trocar webhook GitHub de produção sem teste assinado e rollback.
- Desativar `luna-mc-v5-backend` antes de paridade validada.
- Expor secrets/token em log ou relatório.

## Critério de pronto

- [ ] Endpoint Workspace nativo documentado e testado localmente.
- [ ] Validação HMAC funcionando.
- [ ] Evento real/simulado gera registro/alerta esperado sem mock de sucesso.
- [ ] Plano de cutover e rollback escrito.
- [ ] QA valida fluxo completo antes de desligar legado.

## Handoff

De: Luna | Para: Dev/Security/QA/Gerente
Artefato: `/home/jean/hermes-workspace/swarms/repo-sentinel-workspace-20260624/`
Próxima ação: inventário + implementação segura do Sentinel nativo.
