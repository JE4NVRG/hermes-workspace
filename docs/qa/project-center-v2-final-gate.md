# QA final — PR agregado de discovery do Project Center v2

- Data: 2026-09-24
- Task: `t_a6bdf58b` (tenant `project-center-v2-20260811`)
- Issue de QA: `JE4NVRG/je4ndev-platform-core#9`
- PR revisado: [JE4NVRG/hermes-workspace#6](https://github.com/JE4NVRG/hermes-workspace/pull/6)
- Branch avaliada: `project-center-v2/synthesis` @ `3df6dc77f0d35d30d5752ae89b0d4a453ee853ba`
- Base do PR: `project-center-v2/base-20260811` @ `8e62b3169afa72032fa828b5b66f6c30da29a383`
- Branch desta revisão: `project-center-v2/qa-final` (este documento é o único artefato adicionado)
- Escopo operacional: somente leitura. Nenhum banco, role, secret, Docker, Nginx, DNS, Cloudflare, systemd ou ambiente de produção foi acessado ou alterado.

## 1. Parecer

**APPROVE — aprovação condicionada para consolidação do Gate 3, escopo documental/contratual. NO-GO operacional mantido.**

- Os critérios bloqueantes do card estão verdes com evidência executada: OpenAPI parseia e valida, refs existem, sem secrets, rastreabilidade contratual completa nas projeções, gates versionados 12/12 GO.
- Dois achados **P2** e quatro **P3** foram encontrados. Nenhum invalida o contrato canônico nem os gates verdes, e nenhum bloqueia o merge do pacote de discovery.
- As correções P2 são obrigatórias **antes do PR 1 da implementação** (ver §7).
- A revisão **não** executou testes cross-database/stack, rollback e restore de verdade porque o pacote é docs-only: nenhum artefato de implementação existe no head (§6). Isso não é GO operacional.

## 2. Escopo revisado

O PR #6 é estritamente documental/contratual: 9 arquivos adicionados, 4.270 linhas, nenhum arquivo de código de aplicação, nenhum Docker/Nginx/systemd/infra.

| Artefato | Linhas | Origem (branch) | Head verificado |
| --- | --- | --- | --- |
| `docs/PRD-project-center-v2.md` | 590 | `project-center-v2/prd` | `a743bbda` |
| `docs/adr/0001-project-center-v2-control-plane.md` | 131 | `project-center-v2/spec` | `e330a83a` |
| `specs/contracts/project-center-v2.openapi.yaml` | 1042 | `project-center-v2/spec` | `e330a83a` |
| `specs/features/project-center-v2.spec.md` | 358 | `project-center-v2/spec` | `e330a83a` |
| `docs/security/project-center-v2-threat-model.md` | 495 | `project-center-v2/security` | `5854da43` |
| `docs/design/project-center-v2-ux.md` | 539 | `project-center-v2/ux` | `4a291a03` |
| `docs/plans/project-center-v2-implementation-plan.md` | 310 | sintetizado no PR agregado | `3df6dc77` |
| `docs/qa/project-center-v2-discovery-review.md` | 387 | `project-center-v2/qa-discovery` | `3df6dc77` |
| `scripts/project-center-v2-discovery-retest.mjs` | 418 | `project-center-v2/qa-discovery` | `3df6dc77` |

## 3. Evidência executada

Todas as verificações foram rodadas no worktree `t_a6bdf58b`, sem side effect externo.

| # | Verificação | Comando / ferramenta | Resultado |
| --- | --- | --- | --- |
| 1 | Gate versionado do pacote | `node scripts/project-center-v2-discovery-retest.mjs` | **GO — 12/12 checks PASS** (verdict `GO`, `failures: []`) |
| 2 | Validação OpenAPI independente | `@apidevtools/swagger-parser@13.1.0` → `validate()` | **PASS** — OpenAPI 3.1.0, 9 paths, 34 schemas, `bearerAuth` |
| 3 | Lint OpenAPI | `npx @redocly/cli@1.34.5 lint specs/contracts/project-center-v2.openapi.yaml` | **PASS** — *"Your API description is valid."* |
| 4 | Refs locais (resolver próprio, independente do script do PR) | script QA próprio (13 checks) | **PASS** — 135 refs, 0 não resolvidas |
| 5 | Estados/transições/terminais (PCV2-QA-001) | contagem própria sobre `x-allowed-transitions` | **PASS** — 15 estados, 23 arestas, 0 fora do enum, 0 terminais com saída, inicial `planned` |
| 6 | RBAC (PCV2-QA-004) | partição `roles[*].operations` × `x-required-scopes` | **PASS** — `default: deny`, 5 roles, 9 `operationId`, 0 órfãs, 0 multi-role, 0 escopo descoberto |
| 7 | Idempotência (PCV2-QA-005) | 7 mutações POST × `IdempotencyKey` | **PASS** — 7/7 exigem o header |
| 8 | SecretRef opaca + máscara (PCV2-QA-003) | pattern publicado × exemplo | **PASS** — `^sref_[A-Za-z0-9_-]{43,128}$`, máscara `sref_REDACTED_…` (len 49, casa), `ArtifactRef` condicional presente |
| 9 | Rollback + approve/reject (PCV2-QA-002/006) | 3 rotas `rollback/*`, `oneOf`/discriminator, segregação | **PASS** — `approval_bound_to: rollback_plan_hash` |
| 10 | Scan duro de secrets (private key, PAT, DSN com credencial, JWT/service key, `sref_` integral, `Bearer`) | script QA próprio sobre os 9 arquivos | **PASS** — 0 hits |
| 11 | Scan de path absoluto / `secret://` fora do doc de QA | script QA próprio | **PASS** — 0 ocorrências nos 8 artefatos restantes |
| 12 | Drift entre head do PR e branches retestadas | `git rev-parse <head>:<path>` vs branch | **PASS** — 6/6 blobs idênticos |
| 13 | Heads remotos vs SHAs registrados no reteste | `git ls-remote` (SSH) | **PASS** — prd `a743bbda`, spec `e330a83a`, security `5854da43`, ux `4a291a03`, synthesis `3df6dc77` |
| 14 | Issues citadas existem (antes bloqueado por falta de credencial) | `gh issue list -R JE4NVRG/je4ndev-platform-core` | **PASS** — #2 a #20 existem; token atual válido |
| 15 | Formatação | `npx prettier@3.8.1 --check` nos 9 arquivos | **PASS** — *"All matched files use Prettier code style!"* |
| 16 | Whitespace do patch | `git diff --check <base>...3df6dc77` | **PASS** — 0 erros |
| 17 | Teste escopado da superfície de banco existente | `vitest run src/server/supabase-registry.test.ts` (Node 22.23.2) | **PASS** — 5/5 |
| 18 | Suíte global do checkout (informativo, fora do escopo do PR) | `vitest run --reporter=basic` (Node 22.23.2) | **42 failed / 710 passed (752)**, 17 arquivos — pré-existente e sem relação com o PR |

Comandos reproduzíveis:

```bash
git fetch je4n 'refs/heads/project-center-v2/*:refs/remotes/je4n/project-center-v2/*'
node scripts/project-center-v2-discovery-retest.mjs
npx --yes @redocly/cli@1.34.5 lint specs/contracts/project-center-v2.openapi.yaml
npx --yes prettier@3.8.1 --check docs/PRD-project-center-v2.md \
  docs/adr/0001-project-center-v2-control-plane.md docs/design/project-center-v2-ux.md \
  docs/plans/project-center-v2-implementation-plan.md docs/qa/project-center-v2-discovery-review.md \
  docs/security/project-center-v2-threat-model.md scripts/project-center-v2-discovery-retest.mjs \
  specs/contracts/project-center-v2.openapi.yaml specs/features/project-center-v2.spec.md
git diff --check je4n/project-center-v2/base-20260811...3df6dc77
PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" node_modules/.bin/vitest run src/server/supabase-registry.test.ts
```

A suíte global exige Node ≥ 22.13 (`pnpm 11.1.3`). O worker expõe `node v20.20.2` por padrão, mas **`v22.23.2` está instalado em `/home/jean/.nvm/versions/node/v22.23.2`** e é suficiente para rodar vitest/prettier diretamente. Nenhum teste que falha na suíte global toca `supabase` ou `project-center` (0 arquivos); o PR não altera código de aplicação, portanto não introduz nem corrige essas falhas.

## 4. Critérios do card

| Critério | Resultado | Evidência |
| --- | --- | --- |
| OpenAPI parseia | **PASS** | #2 swagger-parser 13.1.0 + #3 Redocly 1.34.5 |
| Refs existem | **PASS** | #4 — 135 refs locais, 0 não resolvidas (resolver independente do script do PR) |
| Sem secrets | **PASS** | #10/#11 — 0 hits duros; citações históricas no doc de QA isoladas e justificadas (§5, P3-02) |
| Rastreabilidade completa | **PASS com 2 lacunas P2** | #5–#9, #12–#14 verdes; achados P2-01/P2-02 abaixo |
| Testes cross-database/stack, rollback e restore | **NÃO EXECUTÁVEL nesta fase** | §6 — discovery docs-only; cobertura verificada no contrato/plano, sem implementação para executar |
| APPROVE ou REQUEST_CHANGES com evidência | **APPROVE condicionado** | §1, §7 |

## 5. Achados

### P2-01 — Threat model mantém estado não canônico `needs_reconcile` (rastreabilidade PCV2-QA-001)

**Evidência:** `docs/security/project-center-v2-threat-model.md:205`

> `| Rollback parcial | Workflow | DB criado e secret falha; retry colide ou compensação remove recurso antigo | **Alta** | journal durável, compensação baseada em ownership desta operation ID, estado `needs_reconcile`, sem delete cego |`

`needs_reconcile` não existe no enum canônico `OperationState` (15 valores) nem nas 23 arestas de `x-allowed-transitions`. É exatamente o alias que o PCV2-QA-001 pediu para eliminar; o reteste o declarou corrigido e a checagem automática do pacote ("0 lacunas") não cobre aliases residuais fora da tabela de projeção. Cenário descrito corresponde a `manual_intervention_required` (conflito sem prova segura) ou `failed` → retry/`rollback_pending`.

**Impacto:** implementador pode criar um estado de domínio `needs_reconcile` e ainda alegar conformidade local com o threat model.

**Correção:** usar apenas identificadores canônicos na linha 205 (ou rotular explicitamente o alias como proibido, como já faz a UX em `docs/design/project-center-v2-ux.md:272,381`).

### P2-02 — PRD fixa o contrato canônico em commit superado (pré-correção da SecretRef)

**Evidência:** `docs/PRD-project-center-v2.md:582` — *"Contrato canônico: `specs/contracts/project-center-v2.openapi.yaml` no branch `project-center-v2/spec` (commit de baseline `0bbe2492`)"*.

- `0bbe2492` é ancestral de `e330a83a` (head aprovado), mas **anterior** à correção que tornou a `SecretRef` opaca: `git diff 0bbe2492 e330a83a -- specs/contracts/project-center-v2.openapi.yaml` = **+27/−2**, incluindo `components/schemas/SecretRef`, o `allOf`/`if…then` de `ArtifactRef` e a descrição de `secret_ref`.
- Ou seja: o PRD aponta como fonte canônica uma revisão **sem** o schema que resolve o P0/P1 do PCV2-QA-003.

**Impacto:** quem seguir a referência do PRD obtém um contrato divergente do aprovado.

**Correção:** atualizar o pin para `e330a83a` (ou remover o pin e manter só branch + path).

### P3-01 — O reteste versionado valida as quatro branches, não o head agregado

**Evidência:** `scripts/project-center-v2-discovery-retest.mjs` lê `je4n/project-center-v2/{prd,spec,security,ux}`; `refs.base` é usado para o diff do secret scan. O commit de síntese não é verificado.

**Mitigação medida nesta revisão (PASS):** os 6 blobs do head `3df6dc77` são **idênticos** aos das branches retestadas (`git rev-parse 3df6dc77:<path>` == `git rev-parse <branch>:<path>`), então não há drift hoje. Recomendação: parametrizar o script para o head agregado, tornando o gate auto-suficiente.

### P3-02 — O reteste não escaneia o próprio documento de QA

**Evidência:** o scan do script cobre 6 artefatos (PRD, ADR, OpenAPI, spec, threat, UX); `docs/qa/project-center-v2-discovery-review.md` fica fora. Meu scan encontrou 7 ocorrências lá (`qa:103`, `qa:106`, `qa:269`, `qa:272`, `qa:273`, `qa:274`, `qa:347`) de path absoluto (`/home/jean/.config/je4ndev/projects/<slug>.env`) e URIs `secret://projects/<id>/…`.

**Julgamento:** são **citações de evidência histórica** dos achados já removidos do contrato — não são credencial, segredo nem implementação. Não é achado de segurança. A afirmação "0 ocorrências de `/home/`" deve ser lida como escopada aos 6 artefatos contratuais, o que está correto, mas convém declarar o escopo para evitar leitura absoluta.

### P3-03 — Rastreabilidade unidirecional para o plano de implementação

**Evidência:** nenhum dos cinco documentos de projeção (PRD, ADR, spec, threat model, UX) referencia `docs/plans/project-center-v2-implementation-plan.md` ou os artefatos de gate final (`docs/qa/project-center-v2-final-gate.md`, `docs/security/project-center-v2-independent-review.md`); ADR e UX também não citam o path do contrato canônico (só PRD, spec e threat citam). O plano referencia o contrato (correto) e cita 0 dos 9 `operationId` por nome (PR 4 exige contract test por `operationId`, o que cobre o vínculo de forma indireta).

**Impacto:** baixo. Sugestão: acrescentar "Referências" no ADR/UX e uma nota no plano listando os 9 `operationId`.

### P3-04 — Divergência entre o estado do ambiente relatado no reteste e o ambiente real

**Evidência:** `docs/qa/project-center-v2-discovery-review.md:381` afirma que os scripts `pnpm run …` não iniciaram porque o worker expõe apenas Node `v20.20.2`. Fato medido agora: `v22.23.2` existe em `/home/jean/.nvm/versions/node/v22.23.2` e o vitest roda normalmente com ele (`5/5` no teste escopado, suíte global completa em 22,6 s). O número reportado de falhas globais era 38 em 752; a medição atual é **42 failed / 710 passed (752)**.

**Impacto:** o relato de limitação de ambiente está incorreto e o número de falhas globais está desatualizado. As falhas continuam pré-existentes e fora do escopo do PR (nenhum arquivo tocado por ele). Recomendação: registrar comando, versão de Node e contagem fresca.

## 6. O que não foi executado e por quê

O critério do card pede "testes cross-database/stack, rollback e restore". No head revisado **não existe implementação para exercitar**:

- `src/server/project-center-v2/**` e `src/routes/api/project-center/v2/**` (criados no plano, PRs 1–6) não existem no PR — verificado por `fs.existsSync` para paths representativos;
- `scripts/project-center-v2-contract-check.mjs`, `scripts/project-center-v2-secret-scan.mjs`, `docs/runbooks/project-center-v2-deploy-and-rollback.md` também são artefatos futuros (PR 7);
- o único teste executável ligado à superfície de banco no head é `src/server/supabase-registry.test.ts` (fluxo legado, portas injetadas, sem I/O real): **5/5 PASS**;
- rodar DDL, Docker ou restore real seria violação do escopo proibido do card e está fora do discovery por definição.

Portanto, nesta fase a verificação de rollback/restore/isolation é **contratual e documental**, e assim foi feita: 3 fases de rollback com hash e `approval_id` próprios, segregação de atores, `approval_bound_to: rollback_plan_hash`, `restore_test` no enum de `ArtifactRef`, e o plano exigindo harness efêmero, prova negativa A→B por driver, backup/restore por projeto e rollback com gate próprio (PR 6), com gate final automatizado no PR 7. Isso **não substitui** a execução real: ela permanece obrigatória nos PRs 6/7 com flags desligadas.

## 7. Condições para a aprovação

1. **Obrigatório antes do PR 1 da implementação:** corrigir P2-01 (`needs_reconcile` no threat model) e P2-02 (pin `0bbe2492` → `e330a83a` no PRD).
2. **Recomendado:** P3-01 (script apontar para o head agregado), P3-02 (declarar escopo do scan), P3-03 (referências cruzadas), P3-04 (atualizar relato de ambiente/contagem).
3. **Mantido:** `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`; nenhuma ativação, deploy ou alteração de produção é autorizada por este parecer.
4. Este documento cobre o gate do **pacote de discovery**. O PR 7 do plano reutilizará o mesmo caminho para o gate da **implementação** (testes cross-database/stack, rollback e restore executados); o conteúdo aqui não substitui aquela evidência.

## 8. Decisão

**APPROVE (condicionado) — consolidação do Gate 3 liberada para o pacote de discovery. NO-GO operacional.**

---

# Parte II — Gate da implementação (PR 7)

Parecer do gate final automatizado da implementação, conforme a seção "PR 7 —
Gate final de QA e Security" de `docs/plans/project-center-v2-implementation-plan.md`.
Esta parte **substitui** a evidência contratual da Parte I no que ela própria
declarou pendente (provas executadas de verdade); nada aqui autoriza ativação.

## 9. Escopo, ambiente e commits

- **Escopo:** OpenAPI/contrato, varredura de segredos, testes escopados, build e
  provas reais em harness efémero (dois projetos por driver, replay, falha
  reconciliável, lease stale, isolamento A×B, backup/restore e rollback).
- **Ambiente:** Linux 6.8.0-139-generic; Node v22.23.2 (nvm); Docker 29.4.1;
  cliente/servidor PostgreSQL 17.11 em container descartável
  (`postgres@sha256:18cfe3ef…b8bbe5d73`); porta efémera publicada apenas em
  loopback.
- **Commits:** base do PR = `d9411096` (`je4n/project-center-v2/impl-6-exec`);
  código do gate = `c585f85b` (scripts, runbook, plano/ADR, `package.json`);
  este parecer e o relatório do harness entram no commit seguinte do mesmo PR.
- **Fronteira respeitada:** nenhum recurso existente foi tocado. Proibidos por
  desenho e não usados: PostgreSQL do host na 5432, database de lab, Docker de
  produção, R2 real, Nginx, DNS, Cloudflare e systemd.
- **Artefatos:** `scripts/project-center-v2-contract-check.mjs`,
  `scripts/project-center-v2-secret-scan.mjs`,
  `scripts/project-center-v2-real-harness.mts`,
  `docs/runbooks/project-center-v2-deploy-and-rollback.md` e o relatório
  versionado `qa-artifacts/pcv2-harness/pr7-final-report.json`.

## 10. Comandos e saídas (escopo separado)

| Comando | Exit | Saída resumida |
| --- | --- | --- |
| `pnpm project-center:v2:contract` | 0 | `verdict=GO 15/15 checks PASS` (141 `$ref` locais resolvidos, 9 operationIds únicos, 15 estados/23 arestas/5 terminais, RBAC default deny 9/9, 7/7 mutações com `Idempotency-Key`, 24 artefatos referenciados, 38 arquivos de runtime sem ligar as flags) |
| `pnpm project-center:v2:scan` | 0 | `"critical": 0`, `"warn": 101` — todo warn tem classe justificada (fixture sintética, catálogo de redaction, denylist do próprio scanner, alvo interno do harness, citação histórica) |
| `node scripts/project-center-v2-discovery-retest.mjs` | 0 | `failures: []` (reteste do pacote de discovery segue GO) |
| `vitest run src/server/project-center-v2 src/routes/api/project-center src/lib/project-center-v2-*.test.ts` | 0 | 32 arquivos, 566 testes, 0 falhas |
| `prettier --check <arquivos deste PR>` | 0 | `All matched files use Prettier code style!` |
| `prettier --check .` | 1 | 523 arquivos **pré-existentes** fora de escopo (nenhum deste PR) |
| `eslint scripts/project-center-v2-*.mjs` | 0 | 0 erros; 1 aviso: `.mts` não coberto pelo `eslint.config.js` do repositório |
| `git diff --check project-center-v2/base-20260811...HEAD` | 0 | sem erro de whitespace |
| `pnpm run build` | 0 | `vite build` concluído (`built in 18.13s`) |
| `PROJECT_CENTER_V2_TEST_HARNESS=1 tsx scripts/project-center-v2-real-harness.mts --report …` | 1 | 24/25 provas PASS, 1 defeito crítico, 60 comandos reais, 45.9s |
| `tsx scripts/project-center-v2-real-harness.mts` (sem opt-in) | 2 | `harness efemero exige opt-in explicito` — zero container, zero DDL, zero alteração de arquivo |

## 11. Provas reais em harness efémero

Postgres 17.11 real em container `je4ndev_pcv2_<uuid>` com volume exclusivo,
endpoint em loopback e teardown verificado (container, volume, clientes efémeros
e work dir removidos; `teardown-sem-residuo` PASS, `sem-vazamento-de-material`
PASS). 24 das 25 provas passaram:

| Prova | Status | Evidência |
| --- | --- | --- |
| `harness-guard-opt-in` | PASS | guard aceita só com opt-in e endpoint/work dir dentro da janela efémera |
| `harness-guard-recusa-ambiente-production` | PASS | `HarnessGuardError` (fail closed) |
| `harness-guard-recusa-host-target-producao` | PASS | `HarnessGuardError` (fail closed) |
| `harness-guard-recusa-porta-5432` | PASS | `HarnessGuardError` (fail closed) |
| `harness-guard-recusa-work-dir-producao` | PASS | `HarnessGuardError` (fail closed) |
| `harness-guard-recusa-porta-fora-da-janela` | PASS | `HarnessGuardError` (fail closed) |
| `container-efemero` | PASS | nome/volume derivados de UUID, porta efémera, imagem pinada |
| `servidor-real` | PASS | `server_version=17.11` respondendo por TCP |
| `provisiona-dois-projetos` | PASS | A e B em `verifying`, **0 publicados** antes da verificação |
| `backup-por-projeto` | PASS | dump real de A (`1375` bytes, checksum, prefixo dedicado, retenção 30d) |
| `prova-negativa-a-b` | PASS | A→A `exit=0`; A→B `exit=2`; B→A `exit=2` (isolamento cruzado real) |
| `restore-efemero-verificado` | PASS | restore real com bytes conferidos, canário contado e alvo destruído |
| `verificacao-e-restore-efemero` | PASS | A publica só depois de PASS; alvo efémero destruído |
| `replay-sem-duplicacao` | PASS | tick pós-conclusão reexecuta 0 DDL (11 antes, 11 depois) |
| `reentrega-conflita-sem-duplicar` | PASS | reentrega com `outbox_id` novo é recusada na revalidação (`estado_nao_executavel`), 0 comandos novos, 0 duplicação |
| `falha-transitoria-reconciliavel` | PASS | conexão recusada agenda retry (`tentativa 2/3`), estado parcial zero |
| `retry-conclui-sem-duplicar` | PASS | retry conclui com exatamente 1 database e 1 role |
| `falha-parcial-escala-manual` | PASS | database pré-existente ⇒ `manual_intervention_required` |
| `lease-stale-recusado` | PASS | `LeaseHeldError` para segundo writer; `StaleWriterError` para token velho, 0 comandos novos, fencing 3→4 |
| `rollback-com-gate-proprio` | PASS | hash e aprovação próprios; remove os 2 recursos do projeto e preserva o par |
| `rollback-alvo-role-nao-remove-role` | **FAIL** | **DEFEITO P7-01 (crítica)** — detalhe na seção 12 |
| `rollback-preserva-preexistente` | PASS | recurso sem proveniência recusa o plano e vai para manual sem remover nada |
| `flags-desligadas` | PASS | `FeatureDisabledError`, 0 DDL novo com o default do repositório |
| `teardown-sem-residuo` | PASS | container, volume e clientes efémeros ausentes após o run |
| `sem-vazamento-de-material` | PASS | nenhuma credencial/pepper sintético na evidência (51.393 bytes varridos) |

## 12. Achado P7-01 (crítica) — rollback de alvo `role:` apaga o database

**Esperado pelo contrato:** `drop_resource_created_by_operation` com
`target_ref` de prefixo `role:`/`app-role:` remove a **role** do projeto, e
somente ela.

**Observado (prova real):** a ação é aceita pela allowlist, executa SQL de
**drop de database** e a role permanece órfã. No run de referência, a role
`je4ndev_harness_retry_app` continuou existindo depois de o plano de rollback
ser marcado como concluído.

**Causa raiz (dois pontos confirmados no código):**

1. `src/server/project-center-v2/executors/action-executor.ts` aceita
   `database:`, `role:`, `app-role:`, `stack:`, `compose-project:`,
   `data-store:` e `network:` para o kind `drop_resource_created_by_operation`
   (allowlist compilada), ou seja, o tipo do recurso **não** seleciona template.
2. Existe **um único** template para o kind no catálogo
   (`postgresql_isolated:drop_resource_created_by_operation`), e o `argv` dele
   usa `{{sql:drop_database}}` fixo — `DROP DATABASE IF EXISTS {{database}}
   WITH (FORCE)`. O SQL `drop_role` (`DROP ROLE IF EXISTS {{app_role}}`) está
   definido em `ADMIN_SQL_TEMPLATES` e **nunca é referenciado** por nenhum
   template: é código morto.

**Blast radius:** qualquer rollback com alvo de tipo diferente de `database:`
(`role:`, `app-role:`, `stack:`, `compose-project:`, `data-store:`, `network:`)
executa o drop de **database**, não do recurso pedido — em especial
`data-store:`/`network:` não têm SQL próprio algum.

**Impacto:** destruição do recurso errado (inclusive perda do database do
projeto em um rollback pedido para remover a role), com a role órfã
remanescente; o próximo provisionamento do mesmo projeto falha em
`role already exists` e escala para `manual_intervention_required`. Em cenário
multi-projeto, basta um plano de rollback com alvo de tipo errado para atingir
o database errado do mesmo projeto.

**Correção mínima exigida antes de aprovar:** o template (e a allowlist) do kind
passam a ser selecionados pelo prefixo do `target_ref`, com SQL próprio por tipo
de recurso (`drop_role` para `role:`/`app-role:`), e a prova
`rollback-alvo-role-nao-remove-role` precisa passar. Enquanto isso, a mitigação
operacional (remoção manual auditada da role) está declarada em
`docs/runbooks/project-center-v2-deploy-and-rollback.md`, seção 6.

## 13. Observações menores (não bloqueantes isoladamente)

1. `supabase_isolated:drop_resource_created_by_operation` **não existe** no
   catálogo: pelo driver Supabase o kind falha com
   `template_not_in_catalog`. Não foi provado em execução porque o driver
   Supabase não é executável nesta fronteira (seção 14).
2. Escalada para intervenção manual a partir de estado terminal não move a
   máquina de estados (`succeeded` permanece `succeeded`), o que é coerente com
   o contrato, mas significa que "status failed" e "estado canónico" divergem —
   documentar no runbook para o operador não se guiar só pelo campo de estado.
3. `eslint.config.js` não cobre `scripts/**/*.mts`; o harness real fica sem
   lint. Recomendação: incluir o glob e revisar erros em card próprio.
4. `prettier --check .` acusa 523 arquivos pré-existentes fora do escopo deste
   PR (`.md` de `agents/`, `swarms/` etc.); a contagem fresca está na seção 10,
   sem mascarar o resultado global.

## 14. O que não foi executável nesta fronteira

1. **Driver Supabase (`supabase_isolated`) ponta a ponta:** o executor exige um
   `StackAdapter` (`adapter_id` dedicado) e uma porta de projeção de projeto que
   o repositório não contém (o PR 6 deixa a implementação para o deployment), e
   o template `sb-stack-full` exige seis serviços com imagens pinadas por digest
   ausentes neste host. **As provas reais de dois projetos por driver não estão
   completas**: `postgresql_isolated` foi provado de verdade;
   `supabase_isolated` permanece contratual/documental.
2. **Lease store durável do deployment:** a prova usa o store em memória
   declarado no PR 6 como fixture de referência; o comportamento distribuído
   (relógio/latência reais entre writers) não é exercitado.
3. **Destino R2 real:** proibido nesta fronteira; a prova usa a porta de destino
   local com prefixo dedicado.
4. **Recursos de produção** (PostgreSQL do host na 5432, database de lab,
   Docker/Nginx/DNS/Cloudflare/systemd existentes) e **merge/release**: fora do
   escopo por decisão do card.

## 15. Flags e side effects

- `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`
  confirmados ao final: nenhuma atribuição viva de `=true` em 38 arquivos de
  runtime (check `flags-desligadas` do gate contratual) e prova de execução
  recusada com `FeatureDisabledError` (check `flags-desligadas` do harness).
- Zero side effect em produção: nenhum recurso existente tocado, nenhum
  container/volume/porta sobrevivente, nenhum segredo real usado (fixtures
  sintéticas em runtime e varredura `critical: 0`).
- Rastreabilidade do achado QA P3-03 verificada: ADR, UX e plano citam os
  pareceres, o contrato canónico e os gates versionados (agora incluindo o
  runbook e o harness); o gate contratual enforça essa checagem
  (`referencias-cruzadas-p3-03` PASS).

## 16. Decisão

**REQUEST_CHANGES — gate contratual verde, mas a prova real encontrou 1 defeito
crítico (P7-01) no caminho de rollback. NO-GO operacional mantido.**

- Automatizado: `contract` GO 15/15, `scan` 0 críticos, reteste de discovery GO,
  566 testes escopados, build e diff-check verdes.
- Real: 24/25 provas PASS em Postgres 17.11 efémero; a única falha é um defeito
  **crítico** que destrói o recurso errado no rollback.
- Condição para APPROVE: corrigir P7-01 (seleção de recurso por prefixo, com
  SQL próprio por tipo e `drop_role` realmente ligado) e reexecutar o harness
  verde; as lacunas da seção 14 continuam impedindo ativação em produção.
