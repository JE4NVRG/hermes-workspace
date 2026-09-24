# Revisão de Security independente — pacote de discovery do Project Center v2

- Data: 2026-09-24
- Task: `t_f0a22eb3` (tenant `project-center-v2-20260811`), skill `agency-agents/security`
- Issue da task: `JE4NVRG/je4ndev-platform-core#10` (raiz: `#2`)
- PR revisado: [JE4NVRG/hermes-workspace#6](https://github.com/JE4NVRG/hermes-workspace/pull/6)
- Head revisado: `project-center-v2/synthesis` @ `3df6dc77f0d35d30d5752ae89b0d4a453ee853ba`
- Base do PR: `project-center-v2/base-20260811` @ `8e62b3169afa72032fa828b5b66f6c30da29a383`
- Branch desta revisão: `project-center-v2/security-final` (este documento é o único artefato adicionado)
- Papel: revisão **independente do autor** (o threat model veio da branch `project-center-v2/security`; a autoria deste parecer é de outro agente/task)
- Escopo operacional: somente leitura. Nenhum banco, role, secret, Docker, Nginx, DNS, Cloudflare, systemd ou ambiente de produção foi acessado, alterado ou exercitado.

## 1. Parecer

**APPROVE (condicionado) — o pacote de discovery pode ser consolidado no Gate 3. O NO-GO operacional do Project Center v2 permanece integralmente mantido.**

Motivos objetivos:

- todos os critérios de segurança do card passam com evidência executada nesta revisão (seção 3 e 4): least privilege, default deny, idempotência, auditoria, blast radius, proibição de DSN/senha/JWT/service key, ausência de shell/SQL livre e de paths arbitrários no contrato, e gates de DDL/Docker/R2/restore/rollback declarados com allowlist e aprovação segregada;
- as três vulnerabilidades críticas da implementação legada (**TM-01, TM-02, TM-04, TM-05, TM-06**) foram **verificadas por mim contra o código real** — o diagnóstico do threat model não é declaração de intenção, é constatação reproduzível (seção 3.3);
- nenhum segredo real, DSN, JWT, service key ou `SecretRef` integral aparece nos 9 artefatos, e nenhum caminho absoluto aparece nos 6 artefatos contratuais;
- 3 achados **P2** e 6 **P3** foram encontrados. Nenhum deles permite exploração hoje (nada está implementado e as duas feature flags nascem `false`), mas os P2 são **obrigatórios antes do PR correspondente da implementação** e um deles (P2-01) só se resolve alterando o contrato canônico.

Este parecer **não** é GO operacional, **não** valida executabilidade real de isolamento A×B, backup/restore ou rollback, e **não** autoriza nenhuma ativação de flag, deploy ou toque em produção.

## 2. Independência e método

Esta revisão não reutiliza os números do QA: cada verificação foi refeita com ferramenta própria e, quando aplicável, contra a fonte original (o contrato e o código no worktree).

1. **Hash e integridade do insumo.** Os 9 artefatos do head foram extraídos para diretório de trabalho sob `/home/jean/.hermes/profiles/dev2/cache/scratch/` (fora do repositório) e hasheados em SHA-256 antes de qualquer análise.
2. **Verificação própria do contrato.** Script próprio em Python (`yaml.safe_load` + regras regex/estruturais), 15 checks independentes do script do PR — inclusive `if/then` de `ArtifactRef`, fechamento de schemas de request, enum/arestas de `OperationState`, partição RBAC, cobertura de `Idempotency-Key` e ausência de campos de comando/SQL/path.
3. **Varredura própria de secrets e paths.** 9 padrões duros (private key, PAT GitHub, DSN com credencial, JWT, service/anon key, `sref_` integral, AWS key, atribuição literal de senha/token, `Bearer` literal) × 9 arquivos; varredura separada de paths absolutos (`/home`, `/root`, `/etc`, `/var`, `/srv`, `/opt`).
4. **Varredura própria de aliases de estado.** 9 candidatos não canônicos (`needs_reconcile`, `needs_recovery`, `compensating`, `reconcile_pending`, `pending_approval`, `manual_review`, `rollback_failed`, `in_progress`, `partially_succeeded`) em 6 artefatos de projeção, com separação entre uso real e contexto explícito de proibição.
5. **Execução própria do gate versionado.** `scripts/project-center-v2-discovery-retest.mjs` do próprio PR (somente leitura, sem side effect) rodado por mim no head: `verdict=GO`, 12/12 `PASS`, `failures: []`.
6. **Verificação de evidência no código real.** As constatações TM-01 a TM-06 do threat model foram conferidas linha a linha contra `src/routes/api/supabase-registry.ts`, `src/server/auth-middleware.ts`, `src/server/supabase-registry.ts`, `src/server/supabase-registry.test.ts` e `src/screens/supabase/supabase-projects-screen.tsx` no worktree.

## 3. Evidência executada

### 3.1 Verificação própria do contrato canônico

| # | Verificação | Resultado |
| --- | --- | --- |
| 1 | Parse YAML/OpenAPI 3.1 do contrato | **PASS** — `openapi: 3.1.0`, `version: 2.0.0-draft` |
| 2 | Máquina de estados vs. enum canônico | **PASS** — 15 estados, 23 arestas, 0 alvos inválidos, 0 fontes ausentes, 0 terminais com saída, 0 não-terminais sem saída |
| 3 | Aliases de estado nas projeções | **GAP** — 4 ocorrências de candidatos: 3 em contexto explícito de proibição (`ux:272` `pending`/`running`, `ux:378` `needs_recovery`) e **1 residual em `threat-model:205` (`needs_reconcile`)** → P2-02 |
| 4 | RBAC: `default: deny`, partição role→operação→scope | **PASS** — `default=deny`, 5 roles, 9 `operationId`, 0 órfãs, 0 multi-role, 0 sem `x-required-scopes` |
| 5 | Verificabilidade da segregação de funções a partir do token | **GAP** — `x-rbac-policy.segregation` declara `approver_must_be_human: true` e `agent_tokens_may_approve: false`, mas `bearerAuth` (`bearerFormat: scoped-token`) e a política não definem claim de tipo de ator (`actor_type`/`principal_type`/`token_kind` ausentes) → P2-01 |
| 6 | `Idempotency-Key` obrigatória nas mutações | **PASS** — 7 mutações `POST`, 0 sem header |
| 7 | Rate limit declarado por mutação | **GAP** — apenas `createProjectDryRun` declara `429`; as outras 6 mutações não → P3-01 |
| 8 | Entrada hostil: nenhum campo de comando/SQL/path/env/imagem | **PASS** — 12 schemas de request, 0 campos proibidos (`command`, `sql`, `script`, `argv`, `shell`, `exec`, `path`, `mount`, `image`, `env`, `password`, `dsn`, `token`) e todos fechados (`additionalProperties: false` ou `oneOf`) |
| 9 | Confirmação de aprovação estruturalmente vinculada à frase exigida | **GAP** — `ApproveRequest.confirmation` e `RollbackApproveRequest.confirmation` são strings livres `minLength: 3`, sem `pattern` → P3-02 |
| 10 | `SecretRef` opaca + máscara neutra | **PASS** — `^sref_[A-Za-z0-9_-]{43,128}$`, exemplo com 49 caracteres (44 úteis ≥ 43 exigidos / ≥ 256 bits), condicional `if/then` presente em `ArtifactRef` |
| 11 | Campos sanitizados sem restrição estrutural | **GAP** — `AuditEvent.safe_payload` (valores), `VerificationCheck.safe_detail`, `VerificationCheck.evidence_ref` e `SafeFailure.message` são strings livres → P3-03 |
| 12 | Forma de `ArtifactRef.ref` para artefatos não secretos | **GAP** — string livre até 256 caracteres, sem pattern que proíba `://`, path absoluto ou credencial embutida → P3-04 |
| 13 | Varredura dura de secrets (9 padrões × 9 arquivos) | **PASS** — 0 hits |
| 14 | Varredura de paths absolutos | **GAP documental** — 2 linhas (`docs/qa/project-center-v2-discovery-review.md:103` e `:269`) com citação histórica de `/home/...` → P3-05, evidência de achado já corrigido, não vazamento |
| 15 | Hash SHA-256 dos 9 artefatos (integridade do insumo) | **PASS** — registrado na seção 3.4 |

### 3.2 Gate versionado do pacote (execução própria)

```
node scripts/project-center-v2-discovery-retest.mjs
→ verdict: "GO"; 12/12 checks "PASS"; failures: []
→ heads usados: prd a743bbda, spec e330a83a, security 5854da43, ux 4a291a03
```

Cobertura declarada pelo próprio gate: parse e refs (135 refs locais, 0 não resolvidas), `operationId`/path params (9, 0 duplicados), RBAC (`default deny`), estados/transições, três fases de rollback com hash e `approval_id`, discriminação approve/reject, idempotência (7 mutações), schema de `SecretRef` + `ArtifactRef` condicional, projeções de opacidade em PRD/ADR/spec/threat/UX, ausência de paths absolutos/placeholders deriváveis/`sref_` integral, e scan de secrets nos diffs das quatro branches.

Drift entre o head agregado e as branches retestadas, medido por mim (`git rev-parse <head>:<path>` × `<branch>:<path>`): **6/6 blobs idênticos** — o gate não está medindo uma revisão diferente da publicada.

### 3.3 Verificação das evidências do threat model contra o código real

| Achado | Verificação independente | Conclusão |
| --- | --- | --- |
| TM-01 — autorização administrativa ausente | `src/routes/api/supabase-registry.ts:18,65` protege GET e POST apenas com `isAuthenticated`; `src/server/auth-middleware.ts:254-258` retorna `true` quando não há senha configurada | **Confirmado** |
| TM-02 — API web acoplada a credencial equivalente a admin | `src/server/supabase-registry.ts:127-134` executa `execFileSync` com `docker compose exec db psql`; `:10` tem diretório de infra absoluto fixo; `:116` resolve socket Docker rootless | **Confirmado** |
| TM-04 — confirmação textual não é approval | `src/screens/supabase/supabase-projects-screen.tsx:374-375`: o próprio cliente calcula e compara `CRIAR <slug>` | **Confirmado** |
| TM-05 — controles de mutação incompletos | A rota legada não usa `requireJsonContentType`, ao contrário de 10+ outras rotas mutáveis do repositório | **Confirmado** |
| TM-06 — erro do banco revela metadados internos | `src/server/supabase-registry.ts:188-198` propaga o detalhe `ERROR:` do PostgreSQL; `src/server/supabase-registry.test.ts:161` **afirma** que `platform_registry.projects` aparece na mensagem | **Confirmado** |

Essa verificação é o que sustenta a classificação de severidade do threat model: o NO-GO não depende de uma narrativa sobre a implementação atual, mas de comportamento reproduzível no código do próprio head.

### 3.4 Integridade do insumo (SHA-256 dos 9 artefatos)

| Artefato | SHA-256 |
| --- | --- |
| `docs/PRD-project-center-v2.md` | `fcb88c78548197ba54d1540a4f88f9280bb85fc6348cd865eb0982ed78fb15db` |
| `docs/adr/0001-project-center-v2-control-plane.md` | `2623ee5e4230b0eb927701fde27fbe25b56fc0110a0f1e9363650277bc41e81f` |
| `specs/contracts/project-center-v2.openapi.yaml` | `e303a391a0f543fc159766186f07986058cc62a6c18c1c382be5c3545b676f65` |
| `specs/features/project-center-v2.spec.md` | `538e8cb0568b36c445b43a9ce74f318f73a1fc84196dcd8122dbc2d09cd657d6` |
| `docs/security/project-center-v2-threat-model.md` | `eeb0c788304dc86cb25caba719832114bb09f7fcb537d36dc8629c08ff7e96d7` |
| `docs/design/project-center-v2-ux.md` | `8de72ab4fc456984075372252fecf5d4c791ea1ea042cdefae9fd9e01a36b4de` |
| `docs/plans/project-center-v2-implementation-plan.md` | `dccb49797041bc0ee09fa69414959d4d14a89a3af4b550bdc6540683962903ce` |
| `docs/qa/project-center-v2-discovery-review.md` | `948a97158d5ce9f436ca8770331353602186f62f7e9ce92d7aca9b56904934e7` |
| `scripts/project-center-v2-discovery-retest.mjs` | `cd29636b16fc82ef3f0c9f5bed34e89c9111a5eb1cc5c75f52ac05733e6b6da7` |

## 4. Conformidade com os critérios do card

| Critério exigido | Resultado | Evidência |
| --- | --- | --- |
| Least privilege | **PASS** | Role app/migration com atributos negativos explícitos e grants por objeto (threat model §4.2, I-06); `platform_worker` sem operação HTTP; `host_target` restrito a um ID de allowlist; provisionador dedicado sem credencial global (ADR, §3) |
| Default deny | **PASS** | `x-rbac-policy.default: deny` com 5 roles e 9 `operationId` particionados (check #4); I-05 exige bloqueio quando auth/RBAC/secret store/lock/policy R2 não estiverem configurados |
| Idempotência | **PASS** | `Idempotency-Key` obrigatória nas 7 mutações (check #6); chave client-owned persistida antes do primeiro POST, servidor guarda só o hash, fingerprint canônico, lock por `project_uuid`, `409 IDEMPOTENCY_KEY_REUSED` |
| Auditoria | **PASS com P3-03** | Eventos append-only com `actor_ref`, `project_uuid`, `plan_hash`, `approval_id`, hash da chave e correlation ID (I-13, spec §13); o contrato não restringe estruturalmente os campos sanitizados |
| Blast radius | **PASS** | Isolamento por database/role (I-06) e por stack/rede/data store/keys/domínio (I-07); três fases de rollback com plano e aprovação próprios; falha sem prova segura termina em `manual_intervention_required` sem delete cego |
| Proibir DSN/senha/JWT/service key | **PASS** | Check #13: 0 hits em 9 arquivos e 9 padrões duros; `SecretRef` opaca com `sref_` + ≥ 256 bits CSPRNG; redaction obrigatória antes da serialização |
| Proibir shell/SQL livre | **PASS** | Check #8: nenhum campo de comando/SQL/argv/script nos 12 schemas de request; ações do planner são enum fechado; `resolvedor` recusado no ADR ("shell/SQL administrativo com aprovação" rejeitado explicitamente) |
| Proibir paths não allowlisted | **PASS** | `host_target` é enum de allowlist; nomes de database/role/rede/volume/prefixo R2 derivados server-side do `project_uuid` + slug validado; I-09 exige confinamento por `realpath`/openat-safe; ressalva P3-04 em `ArtifactRef.ref` |
| Gate DDL | **PASS** | PR 1–3 do plano são puros/dry-run sem DDL; worker desligado por `PROJECT_CENTER_V2_WORKER_ENABLED=false`; PR 4 só enfileira |
| Gate Docker | **PASS** | Stack isolada por projeto, imagens pinadas por digest, templates versionados, socket apenas no provisionador rootless (ADR, checks #8) |
| Gate R2 | **PASS** | Prefixo derivado por `project_uuid`/ambiente, credencial scoped por prefixo, manifesto/checksum, negativa de restore cruzado (I-12, §11) |
| Gate restore | **PASS** | Restore só em destino vazio/efêmero do mesmo projeto, com validação de manifesto e aprovação separada para produção |
| Gate rollback | **PASS** | `rollback/dry-run` → `rollback/approve` → `rollback/execute`, com `rollback_plan_hash`, novo `approval_id`, revalidação de ownership/drift e segundo ator humano em ação destrutiva |
| APPROVE ou REQUEST_CHANGES com evidência | **APPROVE (condicionado)** | Seções 1, 3 e 7 |

## 5. Achados

### P2-01 — A segregação "só humano aprova" não é verificável a partir do contrato canônico

**Local:** `specs/contracts/project-center-v2.openapi.yaml` — `x-rbac-policy.segregation.production_approval` (`:50-55`), `components.securitySchemes.bearerAuth` (`:342-346`) e `x-segregation` das operações de decisão (`:112`, `:257`).

**Evidência:** a política declara `approver_must_be_human: true` e `agent_tokens_may_approve: false`, mas o esquema de segurança é apenas `http bearer` com `bearerFormat: scoped-token`, e nenhum artefato define a claim que distingue humano de agente (busca por `actor_type`, `actorType`, `principal_type`, `token_kind`, `is_human` em toda a política RBAC + esquema: 0 ocorrências em 1.459 caracteres). O threat model (`:102`, `:106`) e a spec (`:36`) repetem a mesma exigência sem definir a primitiva de verificação, e o plano de testes negativos do threat model (`§12.1`, API-01 a API-19) não contém nenhum caso "token de agente tenta aprovar" — o cenário de spoofing por aprovação delegada não tem prova prevista.

**Impacto:** um implementador pode cumprir "literalmente" o contrato com um token opaco que carregue `project:approve` e ainda alegar conformidade com `approver_must_be_human`; a segregação de funções dependeria de um acordo verbal de emissão de token, fora do artefato versionado. É a mesma classe de falha que o próprio pacote classifica como Crítica em "Spoofing | Approval".

**Correção exigida (antes do PR 4, que expõe os gates de aprovação):**

1. adicionar ao contrato o vocabulário de identidade — por exemplo `x-rbac-policy.actor-claims: {subject: sub, actor_type: actor_type, allowed_values: [human, agent, worker]}` e exigir `actor_type` no `bearerAuth`;
2. explicitar que `actor_type != human` é `403 FORBIDDEN` em `decideProjectOperationApproval`/`decideProjectRollbackApproval` quando o ambiente ou a segregação exigirem humano;
3. acrescentar o teste negativo correspondente (agente com `project:approve` → `403`, zero side effect) em `§12.1` do threat model, ao lado de API-05.

### P2-02 — Estado não canônico `needs_reconcile` no threat model

**Local:** `docs/security/project-center-v2-threat-model.md:205`

**Evidência:** a linha lista, como mitigação de "Rollback parcial", o estado `needs_reconcile`, que não existe no enum canônico `OperationState` (15 valores) nem nas 23 arestas de `x-allowed-transitions`. Minha varredura de aliases em 6 artefatos encontrou exatamente **uma** ocorrência residual — esta. O cenário descrito corresponde a `manual_intervention_required` (conflito sem prova segura) ou a `failed → queued|rollback_pending`.

**Impacto:** é o mesmo defeito que o `PCV2-QA-001` mandou eliminar; um implementador pode criar um estado de domínio `needs_reconcile` e ainda citar o threat model como justificativa. A checagem automática do pacote não cobre aliases fora da tabela de projeção — só a varredura dirigida pega.

**Correção:** substituir por identificadores canônicos na linha 205 (ou rotular o termo como proibido, como a UX já faz em `:272` e `:378`).

### P2-03 — PRD fixa o contrato canônico em commit anterior à correção da SecretRef

**Local:** `docs/PRD-project-center-v2.md:582`

**Evidência:** o PRD aponta `specs/contracts/project-center-v2.openapi.yaml` no branch `project-center-v2/spec`, "commit de baseline `0bbe2492`". Verifiquei no git: `0bbe2492` é ancestral de `e330a83a` (head aprovado da branch), mas é **anterior** a `e330a83a fix(project-center): tornar SecretRef opaca`, cujo diff no contrato é **+27/−2** (`SecretRef`, o `if/then` de `ArtifactRef` e a descrição de `secret_ref`).

**Impacto:** quem seguir a referência do PRD obtém a revisão **sem** o schema que resolve o achado P0/P1 do `PCV2-QA-003` — divergência silenciosa entre o que o PRD chama de canônico e o que o pacote aprovado usa.

**Correção:** atualizar o pin para `e330a83a` (ou remover o pin e manter apenas branch + path).

### P3-01 — `429` declarado apenas em `createProjectDryRun`

**Local:** `specs/contracts/project-center-v2.openapi.yaml` (`:106` tem `429`; as demais mutações não).

**Evidência:** 6 das 7 mutações (`decideProjectOperationApproval`, `executeProjectOperation`, `verifyProjectOperation`, `createProjectRollbackDryRun`, `decideProjectRollbackApproval`, `executeProjectRollback`) não declaram `429`/`Retry-After`, embora a spec (`§10`) defina limite de 5 mutações/min por ator e o threat model exija rate limit em B1 e mitigação de DoS no provisionador.

**Impacto:** o contrato é a fonte canônica; um handler escrito a partir dele tende a não aplicar rate limit nas decisões e execuções — exatamente os endpoints com maior potencial de abuso (fila, lease, DDL).

**Correção:** declarar `429` com `Retry-After` nas 6 mutações (e manter a tabela de limites da spec como projeção).

### P3-02 — `confirmation` de aprovação sem `pattern`

**Local:** `specs/contracts/project-center-v2.openapi.yaml:573-585` e `:635-647`.

**Evidência:** `ApproveRequest.confirmation` e `RollbackApproveRequest.confirmation` aceitam qualquer string de 3 a 160 caracteres. A spec (`:145`, `:156`) e a UX (`:313`) exigem a frase exata `APROVAR <project_id> <prefixo-do-hash>` / `APROVAR ROLLBACK ...`; o `description` do próprio campo repete a exigência, mas o schema não a impõe.

**Impacto:** o valor é secundário (a vinculação real é `plan_hash`/`rollback_plan_hash` + aprovação single-use), mas a defesa em profundidade exigida pelo threat model (TM-04: "confirmação textual não é approval; não usar como gate") fica sem verificação estrutural e sem contract test.

**Correção:** `pattern` ancorado nas duas frases (com escape do `project_id`) ou remoção do campo em favor do hash — em ambos os casos, contract test correspondente no PR 4.

### P3-03 — Campos sanitizados sem restrição estrutural

**Local:** `specs/contracts/project-center-v2.openapi.yaml:988-992` (`AuditEvent.safe_payload`), `:871-872` (`VerificationCheck.evidence_ref`, `safe_detail`), `:928-936` (`SafeFailure.message`).

**Evidência:** são strings livres (algumas sem sequer `maxLength` por valor) — o contrato não proíbe `sref_` integral, DSN, `Bearer` ou path absoluto nesses campos. A garantia real depende da redaction de runtime (módulo `redaction.ts`, PR 1) e do scan do PR 7.

**Impacto:** auditoria e verificação são superfícies de vazamento indireto (threat model B10, I-13). Sem teste negativo sobre payload vivo, "auditoria sanitizada" permanece não comprovada.

**Correção:** manter a redaction como controle primário e exigir, no PR 7, teste negativo que injete canary (DSN, `sref_`, JWT, path) em `safe_payload`/`safe_detail`/`evidence_ref`/`message` e prove ausência do valor — o scan documental atual não cobre payload em execução.

### P3-04 — `ArtifactRef.ref` livre para artefatos não secretos

**Local:** `specs/contracts/project-center-v2.openapi.yaml:873-913`.

**Evidência:** o `if/then` cobre corretamente `type: secret_ref`, mas para `database`, `app_role`, `endpoint_masked`, `r2_prefix`, etc. o `ref` é string livre até 256 caracteres, sem `pattern`/`format`.

**Impacto:** o contrato permite, sem violar schema, devolver path absoluto, DSN com credencial ou URI arbitrária nesses campos — o oposto da política de payload sanitizado que o pacote promete. Hoje nada implementa o endpoint, e o scan documental passa; o risco é de implementação futura.

**Correção:** impor forma por tipo (por exemplo `pattern` que proíba `://`, `/` inicial e `@` com credencial, ou `format` por classe de artefato) e incluir o caso no contract test do PR 4.

### P3-05 — Citações históricas de path absoluto no documento de discovery do QA

**Local:** `docs/qa/project-center-v2-discovery-review.md:103` e `:269` (minha medição; o QA reporta 7 linhas de citação, incluindo URIs `secret://`).

**Evidência:** as linhas citam o caminho absoluto do fluxo legado como **evidência dos achados já corrigidos** (o achado do path absoluto foi fechado; os 6 artefatos contratuais têm 0 ocorrências).

**Julgamento:** **não é achado de segurança** — é citação de evidência em documento de revisão, sem credencial, sem segredo e sem instrução operacional. Recomendação de forma apenas: declarar explicitamente o escopo do scan ("6 artefatos contratuais") para que a afirmação "0 paths absolutos" não seja lida como absoluta sobre o pacote inteiro.

### P3-06 — `docs/security/` está no `.gitignore` e o caminho exigido do parecer vive ali

**Local:** `.gitignore:117` (`docs/security/`) + `docs/plans/project-center-v2-implementation-plan.md:261`.

**Evidência:** o plano (PR 7) exige `docs/security/project-center-v2-independent-review.md`, mas `.gitignore:117` ignora `docs/security/`. `git add` sem `-f` recusa o arquivo — este parecer foi adicionado com `git add -f`, como o threat model da v2 já havia sido. Consequência prática: qualquer gate que dependa de `git status`/`git diff` sem caminho explícito não enxerga o artefato como novo, e ferramentas de pre-commit por lista ignorada podem pulá-lo.

**Impacto:** baixo (nada de segurança), mas é atrito real de rastreabilidade para os PRs 7 e para o próprio pipeline de revisão.

**Correção:** negar a exceção no `.gitignore` (`!docs/security/`) ou mover o parecer para um diretório versionado por padrão, alinhando o caminho com o plano antes do PR 7.

## 6. O que não foi executado e por quê

O card pede gates de DDL/Docker/R2/restore/rollback e provas A×B. No head revisado **não existe implementação para exercitar**, e exercitá-la violaria o próprio escopo proibido do card:

- `src/server/project-center-v2/**` e `src/routes/api/project-center/v2/**` não existem no PR (são PRs 1–4 do plano);
- `scripts/project-center-v2-contract-check.mjs`, `scripts/project-center-v2-secret-scan.mjs` e `docs/runbooks/project-center-v2-deploy-and-rollback.md` são artefatos futuros (PR 7);
- nenhum banco, role, volume, stack, socket Docker, prefixo R2 ou restore foi criado, lido ou testado por esta revisão;
- a verificação de isolamento A×B, least privilege efetivo, backup/restore e rollback é, nesta fase, **contratual e documental** — e assim foi feita, com verificação da evidência no código legado (seção 3.3).

A execução real dessas provas **permanece obrigatória** nos PRs 6/7, com `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`, e não é substituída por este parecer.

## 7. Condições da aprovação

1. **Obrigatório antes do PR 4 da implementação (gates de API/RBAC/aprovação):** corrigir P2-01 (claim de tipo de ator + teste negativo de aprovação por agente), P2-02 (`needs_reconcile` no threat model) e P2-03 (pin `0bbe2492` → `e330a83a` no PRD).
2. **Obrigatório antes do PR 6/7 (execução, backup/restore, gate final):** P3-03 (teste negativo com canary sobre payload sanitizado vivo) e P3-04 (forma restrita de `ArtifactRef.ref`), além das provas reais A×B já exigidas pelo plano.
3. **Recomendado:** P3-01 (`429` nas 6 mutações), P3-02 (`pattern` da frase de confirmação) e P3-05 (declarar o escopo do scan no doc de QA), P3-06 (exceção de `docs/security/` no `.gitignore` antes do PR 7).
4. **Mantido:** `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false` como default; nenhuma ativação, deploy, DDL, Docker ou acesso R2 é autorizado por este parecer.
5. Qualquer `REQUEST_CHANGES` de QA ou Security nesta fase mantém as flags desligadas e o rollout bloqueado — condição já satisfeita.
6. Este documento cobre o **Gate 3 do pacote de discovery**. O PR 7 reutilizará este mesmo caminho para o gate da **implementação**; o conteúdo aqui não substitui aquela evidência.

## 8. Decisão

**APPROVE (condicionado) — pacote de discovery consolidável no Gate 3, com NO-GO operacional mantido e as correções P2 obrigatórias antes dos PRs 4, 6 e 7 da implementação.**
