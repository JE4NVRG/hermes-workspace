# 07 — Consolidação Luna: Repo Sentinel Workspace

Data: 2026-06-24T19:18:27
Missão: `repo-sentinel-workspace-20260624`

## Veredito

- Código/hardening do Repo Sentinel nativo: PASS local.
- Security re-review: PASS.
- QA pós-hardening: PASS local.
- Cutover real produção: BLOCKED por envolver env/secrets/restart público/Nginx/GitHub webhook real.
- Legado `127.0.0.1:9780`: manter ativo até redelivery real do GitHub validar paridade.

## Evidências

- `01-DEV-REPORT.md`: implementação do endpoint `/api/webhooks/github`.
- `02-CUTOVER-PLAN.md`: plano de trocar upstream mantendo URL pública.
- `03-SECURITY-REPORT.md`: primeira revisão security.
- `04-QA-REPORT.md`: QA encontrou bug P1 quando Telegram indisponível.
- `05-SECURITY-REVIEW-AFTER-HARDENING.md`: Security PASS após hardening.
- `06-QA-AFTER-HARDENING.md`: QA PASS local após hardening.

## Validações executadas pela Luna

- `pnpm vitest run src/server/github-sentinel.test.ts --reporter=dot`: 14/14 tests passaram.
- `pnpm eslint src/server/github-sentinel.ts src/server/github-sentinel.test.ts src/routes/api/webhooks/github.ts`: exit 0, só warning global `.eslintignore`.
- `pnpm build`: exit 0.
- Smoke direto do handler com Telegram indisponível: HTTP 200 controlado, delivery `failed` persistido com reason `telegram_network_error`.

## Decisão pendente

Para ir além do PASS local, precisa gate explícito para mexer em:

1. env/secrets do `hermes-workspace.service`;
2. restart controlado do Workspace com Sentinel habilitado;
3. redelivery/ping real no GitHub;
4. troca de upstream Nginx ou webhook;
5. posterior desligamento do legado.

Até isso acontecer, o legado continua como proteção operacional.
