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

| #   | Verificação                                                        | Resultado                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Parse YAML/OpenAPI 3.1 do contrato                                 | **PASS** — `openapi: 3.1.0`, `version: 2.0.0-draft`                                                                                                                                                                                                                            |
| 2   | Máquina de estados vs. enum canônico                               | **PASS** — 15 estados, 23 arestas, 0 alvos inválidos, 0 fontes ausentes, 0 terminais com saída, 0 não-terminais sem saída                                                                                                                                                      |
| 3   | Aliases de estado nas projeções                                    | **GAP** — 4 ocorrências de candidatos: 3 em contexto explícito de proibição (`ux:272` `pending`/`running`, `ux:378` `needs_recovery`) e **1 residual em `threat-model:205` (`needs_reconcile`)** → P2-02                                                                       |
| 4   | RBAC: `default: deny`, partição role→operação→scope                | **PASS** — `default=deny`, 5 roles, 9 `operationId`, 0 órfãs, 0 multi-role, 0 sem `x-required-scopes`                                                                                                                                                                          |
| 5   | Verificabilidade da segregação de funções a partir do token        | **GAP** — `x-rbac-policy.segregation` declara `approver_must_be_human: true` e `agent_tokens_may_approve: false`, mas `bearerAuth` (`bearerFormat: scoped-token`) e a política não definem claim de tipo de ator (`actor_type`/`principal_type`/`token_kind` ausentes) → P2-01 |
| 6   | `Idempotency-Key` obrigatória nas mutações                         | **PASS** — 7 mutações `POST`, 0 sem header                                                                                                                                                                                                                                     |
| 7   | Rate limit declarado por mutação                                   | **GAP** — apenas `createProjectDryRun` declara `429`; as outras 6 mutações não → P3-01                                                                                                                                                                                         |
| 8   | Entrada hostil: nenhum campo de comando/SQL/path/env/imagem        | **PASS** — 12 schemas de request, 0 campos proibidos (`command`, `sql`, `script`, `argv`, `shell`, `exec`, `path`, `mount`, `image`, `env`, `password`, `dsn`, `token`) e todos fechados (`additionalProperties: false` ou `oneOf`)                                            |
| 9   | Confirmação de aprovação estruturalmente vinculada à frase exigida | **GAP** — `ApproveRequest.confirmation` e `RollbackApproveRequest.confirmation` são strings livres `minLength: 3`, sem `pattern` → P3-02                                                                                                                                       |
| 10  | `SecretRef` opaca + máscara neutra                                 | **PASS** — `^sref_[A-Za-z0-9_-]{43,128}$`, exemplo com 49 caracteres (44 úteis ≥ 43 exigidos / ≥ 256 bits), condicional `if/then` presente em `ArtifactRef`                                                                                                                    |
| 11  | Campos sanitizados sem restrição estrutural                        | **GAP** — `AuditEvent.safe_payload` (valores), `VerificationCheck.safe_detail`, `VerificationCheck.evidence_ref` e `SafeFailure.message` são strings livres → P3-03                                                                                                            |
| 12  | Forma de `ArtifactRef.ref` para artefatos não secretos             | **GAP** — string livre até 256 caracteres, sem pattern que proíba `://`, path absoluto ou credencial embutida → P3-04                                                                                                                                                          |
| 13  | Varredura dura de secrets (9 padrões × 9 arquivos)                 | **PASS** — 0 hits                                                                                                                                                                                                                                                              |
| 14  | Varredura de paths absolutos                                       | **GAP documental** — 2 linhas (`docs/qa/project-center-v2-discovery-review.md:103` e `:269`) com citação histórica de `/home/...` → P3-05, evidência de achado já corrigido, não vazamento                                                                                     |
| 15  | Hash SHA-256 dos 9 artefatos (integridade do insumo)               | **PASS** — registrado na seção 3.4                                                                                                                                                                                                                                             |

### 3.2 Gate versionado do pacote (execução própria)

```
node scripts/project-center-v2-discovery-retest.mjs
→ verdict: "GO"; 12/12 checks "PASS"; failures: []
→ heads usados: prd a743bbda, spec e330a83a, security 5854da43, ux 4a291a03
```

Cobertura declarada pelo próprio gate: parse e refs (135 refs locais, 0 não resolvidas), `operationId`/path params (9, 0 duplicados), RBAC (`default deny`), estados/transições, três fases de rollback com hash e `approval_id`, discriminação approve/reject, idempotência (7 mutações), schema de `SecretRef` + `ArtifactRef` condicional, projeções de opacidade em PRD/ADR/spec/threat/UX, ausência de paths absolutos/placeholders deriváveis/`sref_` integral, e scan de secrets nos diffs das quatro branches.

Drift entre o head agregado e as branches retestadas, medido por mim (`git rev-parse <head>:<path>` × `<branch>:<path>`): **6/6 blobs idênticos** — o gate não está medindo uma revisão diferente da publicada.

### 3.3 Verificação das evidências do threat model contra o código real

| Achado                                                    | Verificação independente                                                                                                                                                                       | Conclusão      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| TM-01 — autorização administrativa ausente                | `src/routes/api/supabase-registry.ts:18,65` protege GET e POST apenas com `isAuthenticated`; `src/server/auth-middleware.ts:254-258` retorna `true` quando não há senha configurada            | **Confirmado** |
| TM-02 — API web acoplada a credencial equivalente a admin | `src/server/supabase-registry.ts:127-134` executa `execFileSync` com `docker compose exec db psql`; `:10` tem diretório de infra absoluto fixo; `:116` resolve socket Docker rootless          | **Confirmado** |
| TM-04 — confirmação textual não é approval                | `src/screens/supabase/supabase-projects-screen.tsx:374-375`: o próprio cliente calcula e compara `CRIAR <slug>`                                                                                | **Confirmado** |
| TM-05 — controles de mutação incompletos                  | A rota legada não usa `requireJsonContentType`, ao contrário de 10+ outras rotas mutáveis do repositório                                                                                       | **Confirmado** |
| TM-06 — erro do banco revela metadados internos           | `src/server/supabase-registry.ts:188-198` propaga o detalhe `ERROR:` do PostgreSQL; `src/server/supabase-registry.test.ts:161` **afirma** que `platform_registry.projects` aparece na mensagem | **Confirmado** |

Essa verificação é o que sustenta a classificação de severidade do threat model: o NO-GO não depende de uma narrativa sobre a implementação atual, mas de comportamento reproduzível no código do próprio head.

### 3.4 Integridade do insumo (SHA-256 dos 9 artefatos)

| Artefato                                              | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/PRD-project-center-v2.md`                       | `fcb88c78548197ba54d1540a4f88f9280bb85fc6348cd865eb0982ed78fb15db` |
| `docs/adr/0001-project-center-v2-control-plane.md`    | `2623ee5e4230b0eb927701fde27fbe25b56fc0110a0f1e9363650277bc41e81f` |
| `specs/contracts/project-center-v2.openapi.yaml`      | `e303a391a0f543fc159766186f07986058cc62a6c18c1c382be5c3545b676f65` |
| `specs/features/project-center-v2.spec.md`            | `538e8cb0568b36c445b43a9ce74f318f73a1fc84196dcd8122dbc2d09cd657d6` |
| `docs/security/project-center-v2-threat-model.md`     | `eeb0c788304dc86cb25caba719832114bb09f7fcb537d36dc8629c08ff7e96d7` |
| `docs/design/project-center-v2-ux.md`                 | `8de72ab4fc456984075372252fecf5d4c791ea1ea042cdefae9fd9e01a36b4de` |
| `docs/plans/project-center-v2-implementation-plan.md` | `dccb49797041bc0ee09fa69414959d4d14a89a3af4b550bdc6540683962903ce` |
| `docs/qa/project-center-v2-discovery-review.md`       | `948a97158d5ce9f436ca8770331353602186f62f7e9ce92d7aca9b56904934e7` |
| `scripts/project-center-v2-discovery-retest.mjs`      | `cd29636b16fc82ef3f0c9f5bed34e89c9111a5eb1cc5c75f52ac05733e6b6da7` |

## 4. Conformidade com os critérios do card

| Critério exigido                         | Resultado                  | Evidência                                                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least privilege                          | **PASS**                   | Role app/migration com atributos negativos explícitos e grants por objeto (threat model §4.2, I-06); `platform_worker` sem operação HTTP; `host_target` restrito a um ID de allowlist; provisionador dedicado sem credencial global (ADR, §3) |
| Default deny                             | **PASS**                   | `x-rbac-policy.default: deny` com 5 roles e 9 `operationId` particionados (check #4); I-05 exige bloqueio quando auth/RBAC/secret store/lock/policy R2 não estiverem configurados                                                             |
| Idempotência                             | **PASS**                   | `Idempotency-Key` obrigatória nas 7 mutações (check #6); chave client-owned persistida antes do primeiro POST, servidor guarda só o hash, fingerprint canônico, lock por `project_uuid`, `409 IDEMPOTENCY_KEY_REUSED`                         |
| Auditoria                                | **PASS com P3-03**         | Eventos append-only com `actor_ref`, `project_uuid`, `plan_hash`, `approval_id`, hash da chave e correlation ID (I-13, spec §13); o contrato não restringe estruturalmente os campos sanitizados                                              |
| Blast radius                             | **PASS**                   | Isolamento por database/role (I-06) e por stack/rede/data store/keys/domínio (I-07); três fases de rollback com plano e aprovação próprios; falha sem prova segura termina em `manual_intervention_required` sem delete cego                  |
| Proibir DSN/senha/JWT/service key        | **PASS**                   | Check #13: 0 hits em 9 arquivos e 9 padrões duros; `SecretRef` opaca com `sref_` + ≥ 256 bits CSPRNG; redaction obrigatória antes da serialização                                                                                             |
| Proibir shell/SQL livre                  | **PASS**                   | Check #8: nenhum campo de comando/SQL/argv/script nos 12 schemas de request; ações do planner são enum fechado; `resolvedor` recusado no ADR ("shell/SQL administrativo com aprovação" rejeitado explicitamente)                              |
| Proibir paths não allowlisted            | **PASS**                   | `host_target` é enum de allowlist; nomes de database/role/rede/volume/prefixo R2 derivados server-side do `project_uuid` + slug validado; I-09 exige confinamento por `realpath`/openat-safe; ressalva P3-04 em `ArtifactRef.ref`             |
| Gate DDL                                 | **PASS**                   | PR 1–3 do plano são puros/dry-run sem DDL; worker desligado por `PROJECT_CENTER_V2_WORKER_ENABLED=false`; PR 4 só enfileira                                                                                                                   |
| Gate Docker                              | **PASS**                   | Stack isolada por projeto, imagens pinadas por digest, templates versionados, socket apenas no provisionador rootless (ADR, checks #8)                                                                                                        |
| Gate R2                                  | **PASS**                   | Prefixo derivado por `project_uuid`/ambiente, credencial scoped por prefixo, manifesto/checksum, negativa de restore cruzado (I-12, §11)                                                                                                      |
| Gate restore                             | **PASS**                   | Restore só em destino vazio/efêmero do mesmo projeto, com validação de manifesto e aprovação separada para produção                                                                                                                           |
| Gate rollback                            | **PASS**                   | `rollback/dry-run` → `rollback/approve` → `rollback/execute`, com `rollback_plan_hash`, novo `approval_id`, revalidação de ownership/drift e segundo ator humano em ação destrutiva                                                           |
| APPROVE ou REQUEST_CHANGES com evidência | **APPROVE (condicionado)** | Seções 1, 3 e 7                                                                                                                                                                                                                               |

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

# Parte II — Parecer de Security da implementação (cadeia `impl-1..impl-7`)

- Data: 2026-09-25
- Task: `t_570cba7c` (tenant `project-center-v2-20260811`), skill `agency-agents/security`
- PR revisado: [JE4NVRG/hermes-workspace#16](https://github.com/JE4NVRG/hermes-workspace/pull/16)
- Head revisado: `project-center-v2/impl-7-gate` @ `2aef8ceca168c80a5429dbd1500559da33e106c9`
- Base do PR: `project-center-v2/impl-6-exec` @ `d9411096`; diff do pacote: `project-center-v2/base-20260811...HEAD` (88 arquivos, +49.641/−89, 15 commits)
- Branch desta revisão: `project-center-v2/security-impl` (este documento é o único artefato alterado)
- Papel: revisão **independente do autor e do QA** — o gate do PR 7 (`t_7d77038e`) e o parecer de QA (`docs/qa/project-center-v2-final-gate.md`) foram tratados como alegações a reproduzir, não como evidência
- Escopo operacional: leitura de repositório + harness efémero isolado + container descartável `je4ndev_pcv2_<hex>`. Nenhum recurso de produção foi tocado (seção 16)

## 9. Parecer

**REQUEST_CHANGES — o pacote de implementação não pode ser integrado na base enquanto o alvo do rollback continuar selecionando o SQL pelo `driver:kind` e ignorando o tipo do `target_ref`.**

Motivos objetivos:

- o achado **crítico P7-01** do gate de QA é **real e foi reproduzido por mim com execução própria** — não por leitura do relatório do QA: o harness efémero que eu mesmo rodei entregou `DROP DATABASE IF EXISTS je4ndev_harness_retry WITH (FORCE)` ao `psql` num rollback cujo alvo era `role:je4ndev_harness_retry_app`, com `exit_code=0` e a role **intacta** (seção 13.1);
- existe uma **segunda ocorrência da mesma causa raiz** que não consta do parecer de QA: o kind `disable_resource` aceita `role:`/`stack:`/`compose-project:`/`data-store:`/`network:` e executa `REVOKE ALL ON DATABASE {{database}} FROM PUBLIC` em todos eles (seção 13.2). Corrigir só o `drop_resource_created_by_operation` deixa o defeito vivo;
- **todo o resto do pacote é sólido e passa com execução própria**: os dois scripts determinísticos do PR 7 (`GO 15/15` e `PASS critical=0`), o `gate` completo (32 arquivos / 566 testes), 121 testes reexecutados nos 6 arquivos de maior risco, além dos achados anteriores de R4 (F1–F5), R6 (F1–F2) e dos P2-01/P2-02/P2-03 do discovery que eu **verifiquei fechados no código**, não apenas no parecer de quem corrigiu;
- nenhum segredo real, DSN com credencial, JWT, service key ou `sref_` integral aparece no pacote nem no diff (116 avisos do scanner são fixtures sintéticas e linhas justificadas; a minha varredura independente de 12 padrões sobre 50.653 linhas de diff deu **0 críticos**);
- a fronteira de ambiente foi honrada: nenhum container/volume sobrevivente, endpoint publicado só em loopback, porta 5432 do host intocada, flags `false` em todo o caminho de runtime.

Este parecer **não** é GO operacional e **não** autoriza ativação de flag, deploy, DDL, Docker de produção, R2, Nginx, DNS ou systemd.

## 10. Independência e método

1. **Branch próprio a partir do head:** `git checkout -b project-center-v2/security-impl je4n/project-center-v2/impl-7-gate`, com worktree próprio e `node_modules` simbólico para a raiz. Nenhum arquivo do PR 7 (contrato ou parecer de QA) foi editado.
2. **Reexecução dos gates do PR 7** em vez de confiar nos `command_exits` do handoff (seção 11).
3. **Reexecução do harness efémero real** com UUID próprio, relatório próprio e verificação de teardown (seção 14).
4. **Sonda adversarial própria** (13 testes, arquivo temporário removido antes do commit) escrita para reproduzir o caminho real do executor com adapter falso instrumentado — prova o que o processo **receberia**, sem depender de Docker. Preservada fora do repositório em `~/.hermes/profiles/security/cache/scratch/pcv2-security-probe.test.ts`.
5. **Varredura dura própria de secrets** (12 padrões + IP real do VPS + path absoluto) sobre o diff e sobre o pacote, com triagem manual de cada acerto.
6. **Verificação de fechamento por código** dos achados anteriores de Security (R4 e R6) e das condições P2 do discovery, com `file:line` e teste de regressão correspondente.

## 11. Evidência executada (minha, neste head `2aef8cec`)

| Comando                                                                                              | Resultado                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm project-center:v2:contract`                                                                    | `verdict=GO 15/15 checks PASS`, exit 0                                                                                                                       |
| `pnpm project-center:v2:scan`                                                                        | `verdict=PASS critical=0 warn=116`, diff `base-20260811...HEAD` (49.641 linhas, 88 arquivos, 1 arquivo de captura), allowlist 3/3 usada, 0 obsoleta, exit 0  |
| `pnpm project-center:v2:gate`                                                                        | exit 0: contrato + varredura + **32 arquivos / 566 testes PASS**                                                                                             |
| `PROJECT_CENTER_V2_TEST_HARNESS=1 pnpm project-center:v2:harness`                                    | exit 1: **24/25 provas PASS, 60 comandos reais**, `git_sha=2aef8cec`, relatório `qa-artifacts/pcv2-harness/b04a31aa-bb6c-4c9b-8690-00b5513b7ab0/report.json` |
| `vitest run` (http, redaction-canary, lease-store, action-executor, rollback-service, secret-broker) | **121 testes PASS** em 6 arquivos                                                                                                                            |
| Sonda própria (13 casos)                                                                             | **13/13 PASS** — 6 provando o defeito, 7 provando que as defesas fecham                                                                                      |
| `tsc -p tsconfig.json --noEmit`                                                                      | **0 erros** no escopo `project-center` (pré-existentes fora do escopo permanecem)                                                                            |
| `eslint src/server/project-center-v2`                                                                | **0 erros**, 68 avisos (`require-await`)                                                                                                                     |
| `prettier --check` (pacote + scripts do PR 7)                                                        | `All matched files use Prettier code style!`                                                                                                                 |
| `git diff --check base-20260811...HEAD`                                                              | exit 0, limpo                                                                                                                                                |

Detalhe do harness que eu rodei (não o do QA): container `je4ndev_pcv2_b04a31aabb6c`, volume `je4ndev_pcv2_b04a31aabb6c_data`, endpoint `127.0.0.1:39460` (loopback), imagem pinada por digest `postgres@sha256:18cfe3ef…`, teardown `container_removido=true volume_removido=true residuo_apos=0`, e `material_presente=false pepper_presente=false` com 51.406 bytes de evidência conferidos contra o material sintético gerado em runtime.

## 12. Critérios do card, um por um

| Critério             | Situação               | Evidência (executada ou `file:line`)                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Least privilege**  | Atende                 | `env:0.self` para todo recurso de banco (`src/server/project-center-v2/executors/action-executor.ts:411-421`); `apply_least_privilege` faz `REVOKE ALL … FROM PUBLIC`; prova real A×B no meu harness: `A->A exit=0; A->B exit=2; B->A exit=2` com `FATAL: permission denied for database`                                                                                                               |
| **Default deny**     | Atende                 | `POLICY_DEFAULT = 'deny'` (`src/server/project-center-v2/policy.ts:14`); RBAC default-deny com dono único por operação (`contract-check` check `rbac-default-deny`); token de agente em `project:approve` → `403` sem side effect (`src/server/project-center-v2/http.test.ts:1141`)                                                                                                                    |
| **Idempotência**     | Atende                 | chave client-owned persistida só como hash vinculada a ator+rota+payload por 24 h (`src/server/project-center-v2/idempotency.ts:96-113`); outbox atómico; provas reais `replay-sem-duplicacao`, `reentrega-conflita-sem-duplicar`, `retry-conclui-sem-duplicar` (PASS no meu harness)                                                                                                                   |
| **Auditoria**        | Atende                 | trilha append-only com `update`/`delete` sempre negados (`src/server/project-center-v2/audit-store.ts:11,26-32`); paginação com teto (`:21-23`); nenhum evento entrega material (canário P3-03 vivo em `redaction-canary.test.ts:227-315`)                                                                                                                                                              |
| **Blast radius**     | **Reprovado em P7-01** | a ação de rollback de um recurso lógico apaga o **database** do projeto (seção 13.1); fora desse caminho, alvos proibidos (`*`, `database:postgres`, `role:postgres`, `template[01]`) são recusados com `POLICY_DENIED` (`src/server/project-center-v2/rollback-service.ts:70-75,215-241`) e recurso pré-existente nunca é removido (prova `rollback-preserva-preexistente` PASS)                       |
| **Allowlists**       | Atende                 | binários `psql/pg_dump/pg_restore/pg_isready` (`action-executor.ts:333-338`); host target, driver, endpoint loopback e janela de porta validados **antes** de qualquer adapter (`:1127-1162`); `assertFixedArgv` recusa binário fora da allowlist, path absoluto, `..`, `\`, `://` e metacaractere de shell (`:736-778`) — confirmado pela minha sonda (0 chamadas ao adapter em 6 `target_ref` hostis) |
| **Secret broker**    | Atende                 | `SecretRef` opaca gerada com `randomBytes` (≥32 bytes) e falha fechado se a CSPRNG devolver forma inesperada (`src/server/project-center-v2/secret-broker.ts:133-158`); binding atómico por digest com pepper privado, `masked_ref`/`fingerprint` não deriváveis; material nunca em argv nem em log; prova real `sem-vazamento-de-material` PASS                                                        |
| **Gate de DDL**      | Atende (com P7-01)     | SQL administrativo **só** de templates versionados internos, sem caminho para SQL do request (`action-executor.ts:404-422,687-702`); a seleção do template é que está errada em P7-01                                                                                                                                                                                                                   |
| **Gate de Docker**   | Atende                 | endpoint/host de execução com denylist da 5432 (`action-executor.ts:186-188`); guard do harness recusa produção, host não allowlisted, porta 5432 e path de produção (`src/server/project-center-v2/harness-guard.ts`), com as 6 provas `harness-guard-*` PASS no meu run                                                                                                                               |
| **Gate de R2**       | Atende nesta fronteira | destino R2 real proibido; porta de destino injetada com prefixo dedicado e sem path do request (`src/server/project-center-v2/backup-service.ts:123`); provado `backup-por-projeto` (checksum + retenção 30 d)                                                                                                                                                                                          |
| **Gate de restore**  | Atende                 | restore só em alvo efémero com forma própria, distinto da origem, destruído no fim (`src/server/project-center-v2/restore-verifier.ts:61-149`); provas `restore-efemero-verificado` e `verificacao-e-restore-efemero` PASS (alvo `je4ndev_pcv2_…` criado, usado e destruído)                                                                                                                            |
| **Gate de rollback** | Reprovado em P7-01     | gate próprio com hash, `approval_id` novo e ownership provado (`rollback-service.ts:260-286`) funciona — `rollback-com-gate-proprio` PASS — mas o **efeito** do alvo `role:` está errado                                                                                                                                                                                                                |
| **Redaction**        | Atende                 | 5 classes de padrão + teto de profundidade/propriedades (`src/server/project-center-v2/redaction.ts`); `evidence_ref` (R6-F2) passou a ser redigido nos **três** produtores (`action-executor.ts:1084,1195,1250`) com forma restrita e teto 256; canário vivo nos três canais (`redaction-canary.test.ts:456-520`)                                                                                      |

## 13. Achados

### 13.1 S7-01 — **CRÍTICA / BLOQUEANTE** — a ação de rollback escolhe o SQL pelo `driver:kind` e ignora o tipo do alvo

Equivalente ao P7-01 do gate de QA, **reproduzido por execução própria** (não por leitura do relatório alheio).

**Local:** `src/server/project-center-v2/executors/action-executor.ts:607-632` (único template do kind, `argv` fixo em `'{{sql:drop_database}}'`), contra a allowlist de `:380-388` (`database:`, `role:`, `app-role:`, `stack:`, `compose-project:`, `data-store:`, `network:`) e os parâmetros de `:1279-1290` (`database: naming.database`).

**Prova real (minha execução, harness efémero, Postgres 17.11):** a ação de rollback com alvo `role:je4ndev_harness_retry_app` entregou ao `psql`, com `exit_code=0`:

```
DROP DATABASE IF EXISTS je4ndev_harness_retry WITH (FORCE)
```

e a role `je4ndev_harness_retry_app` continuou existindo (`rollback-alvo-role-nao-remove-role` = FAIL no relatório `qa-artifacts/pcv2-harness/b04a31aa-bb6c-4c9b-8690-00b5513b7ab0/report.json`).

**Prova determinística adicional (sonda própria, sem Docker):** `templateFor('drop_resource_created_by_operation','postgresql_isolated')` + `templateParamsFor` renderiza `DROP DATABASE` para `role:`, `stack:`, `network:` e `data-store:`; e o caminho end-to-end pelo `createActionExecutor` entrega esse mesmo argv ao adapter. Também confirmei que `ADMIN_SQL_TEMPLATES.drop_role` (`:421`) é **código morto**: nenhum `argv` de `ACTION_TEMPLATES` o referencia.

**Alcançabilidade (confirmada, não teórica):** o plano de rollback é construído a partir de `resource.target_ref` observado pelo driver (`rollback-service.ts:260-286`), e só `database:` cai no ramo correto; `role:`, `stack:`, `compose-project:`, `data-store:` e `network:` escolhem o drop errado. O `FORBIDDEN_ROLLBACK_TARGETS` (`:70-75`) não protege: barra apenas `role:postgres` e `database:postgres`.

**Blast radius:** qualquer recurso do projeto cujo alvo não seja `database:` executa `DROP DATABASE … WITH (FORCE)` no **database do próprio projeto** — destruição de dados por uma ação cujo intento era remover uma role/rede/stack, com a role órfã permanecendo e a operação terminando `rolled_back` com aparência de sucesso. Hoje mitigado apenas por: flags `false`, nenhum adapter privilegiado real injetado e a mitigação operacional da seção 6 do runbook.

**Remediação exigida:** selecionar o template pelo **prefixo do `target_ref`** (não só por `driver:kind`), com `argv`/SQL próprios por tipo (`drop_role` para `role:`/`app-role:`, `drop_database` para `database:`), **falhar fechado** com erro tipado para prefixos sem template próprio, e teste unitário do mapeamento prefixo→SQL incluindo os casos negativos. Decisão explícita sobre o driver Supabase registrada no parecer/runbook.

### 13.2 S7-02 — **ALTA / BLOQUEANTE (mesma causa raiz)** — `disable_resource` também executa operação de database para alvos que não são database

**Local:** `src/server/project-center-v2/executors/action-executor.ts:581-606` (template `pg-disable-resource`, `argv` fixo em `'{{sql:revoke_public}}'`) contra a allowlist de `:371-379` (`database:`, `role:`, `app-role:`, `stack:`, `compose-project:`, `data-store:`, `network:`).

**Prova (sonda própria, execução):** para alvos `role:`, `network:`, `stack:` e `data-store:` o executor renderiza `REVOKE ALL ON DATABASE je4ndev_acme_site_development FROM PUBLIC`.

**Alcançabilidade:** `DISABLE_FIRST_PREFIXES` (`rollback-service.ts:58-63`) faz `stack:`, `compose-project:`, `network:` e `data-store:` caírem **justamente** neste kind (`:274-286`) — ou seja, o ramo "desative antes de remover" de qualquer rollback com stack/rede passa por aqui.

**Impacto:** menor que S7-01 (não destrutivo e idempotente no database do próprio projeto), mas é a **mesma classe de defeito**: a ação não opera no recurso que diz operar e o operador recebe sucesso. Corrigir só S7-01 deixa o caminho vivo.

**Remediação:** a mesma de S7-01 — dispatch por prefixo de `target_ref` com recusa fechada para prefixos sem template próprio (rede/stack sem operação de desativação implementada devem **falhar**, não revogar PUBLIC).

### 13.3 S7-03 — **BAIXA / NÃO BLOQUEANTE** — divergência de contagem no handoff do PR 7

O handoff do gate declara `eslint scripts (0 erros, 1 aviso .mts fora do config)` e o comentário do PR 6 declarou 66 avisos; eu medi **68 avisos `require-await`** em `src/server/project-center-v2` (0 erros) — mesma natureza dos já existentes, nenhum novo introduzido por este PR. É atrito de rastreabilidade, não risco. (A mesma divergência de contagem já tinha sido observada de 56 vs 66 no cross-review de R6.)

### 13.4 Fechamento verificado dos achados anteriores (minha conferência, com execução)

| Achado anterior                                              | Situação    | Como verifiquei                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-F1 (ALTA) — sem teto de corpo HTTP                        | **Fechado** | `MAX_REQUEST_BODY_BYTES = 64 * 1024` (`http.ts:141`); leitura incremental com `reader.cancel()` no teto e recusa por `content-length` sem ler um byte (`http.ts:975-1006`); testes `http.test.ts:589,635,691` PASS na minha execução                                                                                                                                         |
| R4-F2 (MÉDIA) — rate limit uniforme 30/min                   | **Fechado** | `RATE_LIMIT_MAX_BY_OPERATION` com 10/min no dry-run e 5/min nas 6 mutações (`http.ts:366-376`); `429` + `Retry-After` (`http.test.ts:797`) PASS                                                                                                                                                                                                                              |
| R4-F3 (MÉDIA) — claim `environment` só no dry-run            | **Fechado** | `assertEnvironmentMatch` em **8** pontos do pipeline (`http.ts:1525,1624,1736,1825,1886,1979,2051,2143`); `http.test.ts:2047` PASS                                                                                                                                                                                                                                           |
| R4-F4 (BAIXA) — allowlist de `SecretRef` por sufixo          | **Fechado** | comparação do caminho exato com `path.length === 4` (`http.ts:807-816`); `http.test.ts:1904` PASS                                                                                                                                                                                                                                                                            |
| R4-F5 (BAIXA) — ramo morto `environment_not_granted`         | **Fechado** | tabela de roles injetável e ramo exercitado por teste (`policy.test.ts`, 23 testes PASS)                                                                                                                                                                                                                                                                                     |
| R6-F1 (ALTA) — exclusividade do lease com identidade default | **Fechado** | identidade por processo `deps.holderRef ?? \`${process.pid}-${randomUUID()}\`` (`worker.ts:496`); reaquisição idempotente **exige prova de posse** (`lease_id`+`holder_ref`+`operation_id`) e o mesmo `holder_ref` sem prova recebe 409 (`lease-store.ts:350-371`); confirmado pela minha sonda (`LeaseHeldError`nos dois casos) e por`lease-store.test.ts:101,127,149` PASS |
| R6-F2 (MÉDIA) — `evidence_ref` sem redaction/forma           | **Fechado** | `safeEvidenceRef` nos 3 produtores (`action-executor.ts:1084,1195,1250`), teto 256 e recusa de forma (`redaction.ts:198-266`); canário vivo nos 3 canais (`redaction-canary.test.ts:456-520`) e na minha sonda (DSN/JWT/path/`sref_` neutralizados)                                                                                                                          |
| R6-observação — `context.templateId` por sufixo              | **Fechado** | igualdade exata (`action-executor.ts:1208-1213`)                                                                                                                                                                                                                                                                                                                             |
| R6-observação — IP real do VPS em teste                      | **Fechado** | `0` ocorrências de `109.199.114.111`/`100.106.125.67` em todo o diff; fixtures usam RFC 5737 (`198.51.100.7`, `192.0.2.10`)                                                                                                                                                                                                                                                  |
| P2-01 — `needs_reconcile` no threat model                    | **Fechado** | `threat-model:207` agora usa `manual_intervention_required`; **0** ocorrências residuais em `specs/`/`src/` (as que existem são citações históricas nos próprios pareceres)                                                                                                                                                                                                  |
| P2-02/P2-03 — pin `0bbe2492` no PRD                          | **Fechado** | `docs/PRD-project-center-v2.md:582` referencia branch + path, sem pin de commit                                                                                                                                                                                                                                                                                              |
| Actor claims verificáveis (API-20)                           | **Fechado** | `x-rbac-policy.actor-claims` + `x-segregation` com `actor_type_required: human` (`threat-model:108,410,412`) e enforcement real: `http.test.ts:1141` "recusa token de agente com project:approve sem side effect" PASS na minha execução                                                                                                                                     |

## 14. Provas reais: o que foi executado e o que não foi

**Executado de fato** (com comando real, não narrativa):

- provisionamento real de **dois projetos por driver disponível** (`A=je4ndev_harness_alpha`, `B=je4ndev_harness_bravo`) num PostgreSQL 17.11 em container descartável, por `psql` de verdade dentro da imagem pinada por digest;
- **prova negativa A×B completa** com controle positivo: `A->A exit=0`, `A->B exit=2`, `B->A exit=2` (negação real do servidor, `permission denied for database`);
- **backup real** por `pg_dump` com checksum, prefixo dedicado e retenção (`bytes=1375`, `retencao=30d`);
- **restore efémero verificado** (`pg_restore`, 1 linha canário, alvo destruído e confirmado ausente do cluster);
- **rollback** com gate próprio (`plano=064f…`, 2 recursos removidos, B intacto) e **replay/reentrega sem duplicação** (DDL antes=11, depois=11; reentrega `skipped` com 0 comandos novos);
- **lease**: segundo writer recusado, writer stale recusado **antes** do adapter (`fencing=3->4`, 0 comandos novos);
- **falha transitória** reconciliada (retry 2/3 sem duplicar) e **falha parcial** escalando para `manual_intervention_required`;
- **flags desligadas** impedem execução (`FeatureDisabledError`, 0 DDL novo);
- **teardown sem resíduo** (`docker ps -a` / `docker volume ls` filtrados por `je4ndev_pcv2`: vazio).

**Não executado, com o motivo:**

1. **Driver `supabase_isolated` ponta a ponta** — o executor exige `StackAdapter` (`supabase-stack-adapter`) e `SupabaseProjectionPort`, que **não existem no repositório** (o PR 6 os deixa para o deployment), e o template `sb-stack-full` exige 6 serviços pinados por digest ausentes no host. Registrado como nota explícita pelo harness e **reproduzido por mim**: nenhuma prova real de dois projetos por esse driver.
2. **Lease store durável do deployment** — as provas usam o store in-memory declarado como fixture de referência; a atomicidade do adapter durável (Redis/Postgres) **não** foi exercitada por ninguém nesta cadeia.
3. **Destino R2 real** — proibido por esta fronteira; usa porta de destino local com prefixo dedicado. O gate de R2 real permanece aberto para a ativação.
4. **Recursos de produção** — Postgres do host em `127.0.0.1:5432`, lab, Docker/Nginx/DNS/Cloudflare/systemd e merge/release: não tocados.
5. **Teste dinâmico de HTTP contra servidor vivo** (DAST) — não fiz nem o PR 7 fez. O limite de corpo, o rate limit, a segregação por `actor_type` e a allowlist de `SecretRef` foram verificados por **reexecução dos testes do próprio pacote** (49 em `http.test.ts`) e por leitura de código, não por sonda minha contra um listener real. É a lacuna metodológica mais relevante deste parecer e deve constar como tal.
6. **Prova negativa A×B para o driver Supabase** e **`sb-stack-full`** — dependem do item 1.

## 15. Varredura dura de secrets

Varredura própria, independente do `project-center-v2-secret-scan.mjs`, sobre o diff `base-20260811...HEAD` (50.653 linhas) e sobre o pacote:

| Padrão                             | Diff | Triagem                                                                                                         |
| ---------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| Private key (PEM)                  | 0    | —                                                                                                               |
| PAT GitHub (`gh*_`, `github_pat_`) | 0    | —                                                                                                               |
| JWT de 3 segmentos                 | 1    | fixture canário P3-03 (`redaction-canary.test.ts:61`, linha justificada)                                        |
| AWS access key (`AKIA…`)           | 0    | —                                                                                                               |
| DSN com credencial                 | 16   | **todas** com senha mascarada (`:***@`) ou host sintético (`host`, `h`, `db.interno`) — nenhuma credencial real |
| Atribuição de senha/token          | 69   | constantes de teste (`TOKEN_OPERATOR`, `TOKEN_APPROVER`) e literais sintéticos (`'token=super-secreto-123'`)    |
| `Bearer` literal                   | 2    | `Bearer tok-scope-ausente-0000` / `tok-ambiente-invalido-000` (fixtures)                                        |
| `sref_` integral                   | 0    | —                                                                                                               |
| Slack (`xox*`)                     | 0    | —                                                                                                               |
| Google API key (`AIza…`)           | 0    | —                                                                                                               |
| OpenAI key (`sk-…`)                | 0    | —                                                                                                               |
| `service_role`                     | 8    | catálogo do próprio scanner + strings de propósito de teste                                                     |

Varredura do pacote **fora do diff** (private key, PAT, AWS, Slack, Google, `sref_` integral): **0 ocorrências**. IP real do VPS e do Tailscale: **0 ocorrências** no diff. Path absoluto: apenas em fixtures de teste, catálogos de detector e citações históricas de parecer (os 116 `warn` do scanner, todos classificados; allowlist 3/3 utilizada, 0 entrada obsoleta).

## 16. Fronteira de ambiente e side effects

- Nenhum container ou volume `je4ndev_pcv2_*` sobrevivente depois das minhas execuções (`docker ps -a` e `docker volume ls` filtrados: vazio).
- O endpoint do harness foi publicado **apenas em loopback** (`127.0.0.1:39460`) e o guard recusou explicitamente ambiente `production`, host target de produção, porta 5432 e `work_dir` de produção (6 provas `harness-guard-*` PASS).
- O Postgres de produção do host (`127.0.0.1:5432`) não foi conectado, alterado nem lido por esta revisão.
- Flags `PROJECT_CENTER_V2_ENABLED` / `PROJECT_CENTER_V2_WORKER_ENABLED`: **`false`** no default do repositório, sem nenhuma atribuição viva em caminho de runtime (as ocorrências de `'true'` no diff são testes e o harness, que roda sob opt-in explícito).
- Nenhum segredo real usado: credencial administrativa e pepper do broker são gerados em runtime no harness, e o relatório foi conferido contra ambos (`material_presente=false`, `pepper_presente=false`).
- Nada de DDL, Docker de produção, R2, Nginx, DNS, Cloudflare, systemd, deploy ou merge foi executado por esta revisão.

## 17. Condições, decisão e fluxo

**Decisão: REQUEST_CHANGES.** O parecer é favorável a **todo** o pacote exceto pelo dispatch de template por `target_ref`; a integração na base não pode acontecer antes da correção de S7-01 **e** S7-02, com o gate de QA reexecutado no commit da correção.

Condições para a próxima rodada:

1. Corrigir S7-01 e S7-02 no mesmo card de correção já existente (`t_7841dfea`, do gate de QA), com seleção de template por prefixo de `target_ref` e recusa fechada para prefixo sem template próprio.
2. Teste unitário do mapeamento prefixo→SQL, incluindo os casos negativos (`stack:`, `compose-project:`, `data-store:`, `network:` devem falhar, não cair no drop/revoke).
3. `PROJECT_CENTER_V2_TEST_HARNESS=1 pnpm project-center:v2:harness` verde com **25/25** provas, anexando o relatório JSON, e `pnpm project-center:v2:gate` verde no commit da correção.
4. Reexecução do gate de QA depois da correção (o parecer de QA do PR 7 permanece o do head atual).
5. `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false` mantidas; nenhuma ativação, deploy ou toque em produção é autorizado por este parecer.

**Fluxo:** o card de correção `t_7841dfea` (assignee `builder`) passou a ser **parent** do card de integração `t_ae806dc9`, para que o pacote não seja fechado sobre código não corrigido. Este PR não faz merge; a integração continua sendo exclusividade do card `t_ae806dc9`. Revalidação de Security obrigatória no head corrigido antes da integração.
