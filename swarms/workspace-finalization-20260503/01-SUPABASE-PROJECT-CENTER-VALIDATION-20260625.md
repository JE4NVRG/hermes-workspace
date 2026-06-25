# 01 — Supabase Project Center Validation

Data: 2026-06-25T22:27Z
Missão: `workspace-finalization-20260503`
Executor: Luna

## Veredito

PASS parcial forte para RBAC/gates/pacote seguro e listagem real.

O Workspace está servindo `/supabase` com dados reais do `platform_registry` do Supabase self-hosted. O pacote seguro para agentes agora respeita `agent_access_profiles`, rebaixa automação quando há risco P0/P1 e retorna 403 para agente sem grant. A criação real de novo projeto/schemas via UI continua bloqueada até Jean aprovar explicitamente um slug/schema de produção ou um projeto smoke descartável, porque isso executa DDL/DML no PostgreSQL/Supabase real.

## Mudanças consolidadas

- `src/lib/supabase-agent-access-package.ts`
  - Adiciona `evaluateSupabaseAgentAccess()`.
  - `buildSupabaseAgentAccessPackage()` passa a aceitar `agentName` e `enforceAgentAccess`.
  - Agente sem grant retorna erro em modo API.
  - Risco P0/P1 ativo força pacote read-only e bloqueia automação ampla.
  - Pacote não inclui service_role, Postgres password, JWT secret, anon key ou token sensível.

- `src/routes/api/supabase-registry.ts`
  - `GET /api/supabase-registry` continua listando snapshot real.
  - `GET /api/supabase-registry?package_project=<slug>&agent=<agent>` retorna pacote seguro com decisão de acesso.
  - Sem grant retorna HTTP 403.

- `src/screens/supabase/supabase-projects-screen.tsx`
  - UI mostra `Agentes e grants` por projeto.
  - Gate visual considera P0/P1, não só P0.
  - Card de pacote seguro continua disponível sem secrets.

## Evidência de execução

### Testes focalizados

Comando:

```bash
/home/jean/.npm-global/bin/pnpm exec vitest run src/lib/supabase-agent-access-package.test.ts src/server/supabase-registry.test.ts --reporter=dot
```

Resultado:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
```

### ESLint focalizado

Comando:

```bash
/home/jean/.npm-global/bin/pnpm exec eslint src/lib/supabase-agent-access-package.ts src/lib/supabase-agent-access-package.test.ts src/routes/api/supabase-registry.ts src/screens/supabase/supabase-projects-screen.tsx src/server/supabase-registry.ts src/server/supabase-registry.test.ts
```

Resultado: exit 0.

### Build

Comando:

```bash
/home/jean/.npm-global/bin/pnpm build
```

Resultado:

```text
client build: built in 1m 36s
ssr build: built in 37.96s
exit: 0
```

Warnings: chunk size/dynamic import já existentes; não bloquearam build.

### Restart controlado e endpoints

Comandos/resultado:

```text
systemctl --user restart hermes-workspace.service -> active
GET http://127.0.0.1:3000/supabase -> 200
GET http://127.0.0.1:3000/api/supabase-registry -> 200
```

Snapshot real:

```json
{"ok": true, "projects": 2, "slugs": ["nexpanel", "renderia"]}
```

### API de pacote seguro / RBAC

Resultados reais:

```text
nexpanel + luna -> 200, mode metadata, readOnly true, sem env sensível
nexpanel + dev3 -> 403, sem grant
nexpanel + no-such-agent -> 403, sem grant
renderia + luna -> 200, mode metadata, readOnly true, sem env sensível
renderia + dev3 -> 200, mode readonly, readOnly true, sem env sensível
renderia + no-such-agent -> 403, sem grant
```

Riscos reais observados:

- `nexpanel`: P0 `Tabelas sensiveis com colunas de login/senha` em `mitigating`, portanto pacote fica read-only.
- `renderia`: P1 `Buckets legados sem prefixo de projeto` em `open`, portanto automação ampla fica bloqueada/read-only.

### Secret scan focalizado

Busca em `src` por atribuições diretas de credenciais sensíveis:

```text
SERVICE_ROLE= / POSTGRES_PASSWORD= / JWT_SECRET= / SUPABASE_ANON_KEY= -> nenhum match em código de runtime
```

Único match textual ficou no teste que garante não exposição desses nomes como env de pacote.

### QA visual headless

Playwright headless carregou `/supabase`, recebeu `/api/supabase-registry` HTTP 200, encontrou no DOM:

- `Supabase Projects`
- `platform_registry`
- `Nexpanel`
- `Renderia`
- `AGENTES E GRANTS`
- `P1 · OPEN`
- `Pacote seguro`

Screenshot:

`/home/jean/hermes-workspace/qa-artifacts/supabase-project-center/supabase-rbac-gates-after-wait-1440x900.png`

## Status dos cards

- `t_f667ce47` — pacote seguro de URL/API para agentes: pronto para marcar `done`.
- `t_fffb65cf` — RBAC de agentes e gates P0/P1: pronto para marcar `done`.
- `t_1cc0a1d0` — QA fluxo Workspace Sentinel Supabase: pronto para marcar `done` para o escopo sem DDL real.
- `t_71bdd3ea` — criação real de projetos: manter `blocked` até Jean aprovar um slug/schema real ou smoke. Motivo: envolve DDL/DML no Supabase/PostgreSQL real.

## Próxima decisão necessária

Para fechar 100% o card de criação real, Jean precisa escolher:

1. Criar projeto real agora com slug/schema definidos; ou
2. Criar projeto smoke descartável para validar o fluxo DDL transacional; ou
3. Deixar criação real bloqueada e avançar para outra frente.
