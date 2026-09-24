# QA independente — Project Center v2 discovery

- Data: 2026-08-11
- Task: `t_8967bde6`
- Issue de QA: `JE4NVRG/je4ndev-platform-core#7`
- Base revisada: `project-center-v2/base-20260811` (`8e62b3169afa72032fa828b5b66f6c30da29a383`)
- Veredito atual: **GO para consolidar o Gate 3 após o segundo reteste; não autoriza operação ou produção**
- Escopo operacional: somente leitura; nenhum banco, role, secret, Docker, rede ou produção foi alterado
- Correções da onda PCv2/W0 (reteste parametrizado, escopo do scan, ambiente, `.gitignore`): 2026-09-24 — task `t_1b1f55b3`, §9

## 1. Resumo executivo

Os quatro PRs descrevem corretamente o risco central: o fluxo atual cria apenas um schema dentro da stack Supabase principal, enquanto a stack Máximo isola Compose, rede, Postgres/data path, material criptográfico e backup. O pacote também acerta ao tornar `postgresql_isolated` o padrão, reservar `supabase_isolated` para capacidades justificadas e bloquear `schema_shared` para projetos novos.

A revisão, porém, encontrou **dois bloqueadores P0 e quatro inconsistências P1**. O vocabulário de estados não é canônico entre PRD, ADR/OpenAPI/spec, threat model e UX. Além disso, o contrato OpenAPI não modela o novo plano/aprovação exigido para rollback destrutivo. Esses gaps deixam implementações incompatíveis igualmente “conformes” aos documentos e violam o próprio critério de saída da discovery.

O pacote está adequado como material de discovery, mas **não deve ser consolidado como baseline implementável** até os P0/P1 abaixo serem corrigidos e retestados.

## 2. Evidência coletada

### 2.1 PRs e commits

| PR                                                       | Artefato            | HEAD verificado                            | Estado observado |
| -------------------------------------------------------- | ------------------- | ------------------------------------------ | ---------------- |
| [#1](https://github.com/JE4NVRG/hermes-workspace/pull/1) | PRD                 | `6fcb7f6f70e301e93aa92325f92e35d3ec3c4419` | open, mergeable  |
| [#2](https://github.com/JE4NVRG/hermes-workspace/pull/2) | ADR, OpenAPI e spec | `010e2d57798acca38100689ee7f77fe7ae1b5a55` | open, mergeable  |
| [#3](https://github.com/JE4NVRG/hermes-workspace/pull/3) | Threat model        | `ae15b5cecd110a7e9937dcc465ca5b257ecd9a72` | open, mergeable  |
| [#4](https://github.com/JE4NVRG/hermes-workspace/pull/4) | UX                  | `6093d9718985f88a8569f04689495dc6efea8e0b` | open, mergeable  |

Os quatro HEADs foram buscados de `refs/pull/<n>/head` e comparados com a base declarada. Cada PR altera somente os arquivos informados no handoff.

### 2.2 Validações automatizadas

| Validação                                                                  | Resultado                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Parse OpenAPI 3.1 com pacote `yaml` do projeto                             | PASS                                                                     |
| Referências locais `$ref`                                                  | PASS — 100 referências, 0 não resolvidas                                 |
| `operationId` duplicado                                                    | PASS — 0                                                                 |
| Parâmetros de path ausentes                                                | PASS — 0                                                                 |
| Formatação dos 6 artefatos com `prettier@3.8.1 --check`                    | PASS                                                                     |
| Scan de padrões de private key, PAT e atribuição de token/secret nos diffs | PASS — 0 hits                                                            |
| Paths canônicos locais do platform core                                    | PASS — 4/4 existem                                                       |
| Links públicos do `je4ndev-platform-core`                                  | BLOQUEADO — GitHub devolve 404 sem credencial para o repositório privado |

A API pública do GitHub confirmou estado, HEAD, base e mergeabilidade dos PRs do `hermes-workspace`. A autenticação API configurada no ambiente está inválida; a autenticação SSH `JE4NVRG` está funcional. Isso não impediu a revisão dos blobs, mas impede publicar comentários via API até renovar o token.

### 2.3 Implementação atual confrontada

A revisão direta confirmou:

- `src/server/supabase-registry.ts:126-153` executa `docker compose exec ... psql -U postgres -d postgres` no processo web;
- `src/server/supabase-registry.ts:217-278` cria schema e registros no mesmo PostgreSQL compartilhado;
- `src/routes/api/supabase-registry.ts:64-79` protege o POST apenas com `isAuthenticated`, sem RBAC, idempotência, content-type gate ou aprovação persistida;
- `src/server/auth-middleware.ts:248-269` considera qualquer request autenticado quando não existe senha configurada;
- `src/screens/supabase/supabase-projects-screen.tsx:385-527` usa somente a confirmação previsível `CRIAR <slug>`;
- `src/screens/supabase/supabase-projects-screen.tsx:604-629` ainda descreve criação de schema e pacote da stack compartilhada.

Portanto, o threat model está correto ao manter **NO-GO operacional**. O pacote de discovery não executou side effect real.

## 3. Achados

### PCV2-QA-001 — P0 bloqueante — quatro máquinas de estado incompatíveis

**Evidência**

- PRD #1, linhas 177-193 e 512-524: `draft`, `dry_run_pending`, `dry_run_ready`, `approval_pending`, `ready`, `reconciliation_required`;
- ADR #2, linha 24: `manual_intervention_required`;
- OpenAPI #2, linhas 339-358: `planned`, `awaiting_approval`, `queued`, `succeeded`, `failed`, `manual_intervention_required`;
- spec #2, linhas 89-122: repete o enum OpenAPI;
- threat model #3, linhas 280-316: `DRAFT`, `PLANNED`, `NEEDS_RECONCILE`, `FAILED_ROLLED_BACK`, `SUCCEEDED`;
- UX #4, linhas 243-280 e 331-350: `pending_approval`, `needs_recovery`, `success` e estados de timeline distintos.

**Impacto**

Backend, banco, SDK, auditoria e UI podem implementar transições e estados terminais diferentes sem violar seu documento local. O próprio threat model, linha 451, exige que os artefatos usem os mesmos nomes e estados para encerrar discovery. O Gate 3 do PRD também determina NO-GO quando há divergência entre OpenAPI, tipos e UX.

**Correção obrigatória**

Definir um único enum canônico no contrato, uma única tabela de transições e um mapa separado de labels de UX. PRD, threat model, ADR, spec e UX devem referenciar esse contrato sem criar aliases semânticos.

### PCV2-QA-002 — P0 bloqueante — rollback destrutivo não possui contrato de novo plano/aprovação

**Evidência**

- PRD #1, linhas 258-265 e 289: rollback deve usar compensações do plano aprovado; ação destrutiva exige confirmação e aprovação segregada;
- ADR #2, linhas 104-108: compensação de recursos usa contrato com novo gate;
- spec #2, linhas 134-142 e 288-308: rollback destrutivo exige nova aprovação;
- threat model #3, linhas 445-447: segundo ator, backup, preview e confirmação vinculada ao resource UUID;
- UX #4, linhas 304-329: destruição é outra operação e outra aprovação;
- OpenAPI #2, linhas 170-200 e 457-468: `POST /rollback` recebe apenas `reason`, `confirmation` e `preserve_data`; não existe `rollback_plan_hash`, `approval_id`, endpoint de aprovação do rollback ou resposta que diferencie planejamento de execução.

**Impacto**

O contrato permite uma implementação que enfileira compensação destrutiva diretamente após uma frase previsível, sem provar que o aprovador revisou o mesmo plano de rollback. Isso reabre o risco de plano divergente que o v2 pretende eliminar.

**Correção obrigatória**

Modelar rollback como operação tipada com dry-run/plan hash próprio. A API deve separar solicitar plano, aprovar/rejeitar o hash e executar. O contrato deve representar aprovação expirada, drift, ownership não comprovado e ação destrutiva que exige segundo ator.

### PCV2-QA-003 — P1 alto — identidade e exposição do secret path divergem

**Evidência**

- brief e PRD #1, linha 129: `/home/jean/.config/je4ndev/projects/<slug>.env`;
- UX #4, linhas 135-141: mostra esse path absoluto na UI;
- threat model #3, linhas 128-134 e 326-331: path por `project-uuid`, slug apenas como metadado;
- spec #2, linhas 66-70 e 245-263: API não expõe path absoluto e usa somente `secret://projects/<project_id>/database-url`.

**Impacto**

Slug mutável/reciclável é uma identidade mais fraca que UUID para ownership e confinamento. Expor o path absoluto também contradiz a política de payload sanitizado e vaza topologia do host sem necessidade operacional.

**Correção obrigatória**

Adotar UUID/ID imutável no storage interno e `secret_ref` opaca em API/UI. Se o path por slug permanecer como decisão de produto, documentar formalmente collision/reuse/rename e retirar a afirmação de que paths absolutos nunca são expostos.

### PCV2-QA-004 — P1 alto — RBAC não tem vocabulário nem representação contratual única

**Evidência**

- spec #2, linhas 24-34: `admin:project-factory`, `admin:approve-side-effects`, `platform-worker`, `auditor`;
- OpenAPI #2, linhas 14-15 e 225-229: somente `bearerAuth: []`; os scopes aparecem apenas em descrições;
- threat model #3, linhas 92-106: `operator:plan`, `approver:execute`, `provisioner`, `auditor`;
- PRD #1, linhas 96-115: personas e identidades administrativas sem mapa para os scopes do contrato.

**Impacto**

Handlers, tokens, testes 401/403 e a UX de permissões não têm uma fonte única para decidir quem planeja, aprova, executa, verifica ou solicita rollback. Descrição textual de scope não é validável pelo OpenAPI.

**Correção obrigatória**

Publicar matriz canônica `role → scopes → ambiente → segregação`. Usar os mesmos identificadores nos quatro documentos e representar os requisitos por operação no contrato, ainda que a autenticação final continue bearer customizada.

### PCV2-QA-005 — P1 alto — ownership da idempotency key é contraditório

**Evidência**

- PRD #1, linhas 198-208: `idempotency_key` fornecida pelo cliente;
- OpenAPI #2, linhas 236-245: header obrigatório em todas as mutações;
- UX #4, linhas 119-149: key gerada pelo control plane;
- UX #4, linhas 344-349: intenção alterada cria plano e nova key.

**Impacto**

Clientes/SDKs não sabem se devem persistir uma chave estável antes da primeira tentativa ou aguardar o servidor. Em timeout antes da resposta, geração server-side sem chave do cliente não garante retry seguro.

**Correção obrigatória**

Manter a chave de request fornecida pelo cliente/SDK para deduplicação do primeiro POST; o servidor pode gerar IDs internos separados. Atualizar a UX para dizer que o client gera/persiste a key ou modelar explicitamente um endpoint de criação de draft sem side effects.

### PCV2-QA-006 — P1 alto — rejeição exige confirmação de aprovação no OpenAPI

**Evidência**

- OpenAPI #2, linhas 418-430: `ApprovalRequest` exige sempre `decision`, `plan_hash` e `confirmation`; a descrição de `confirmation` define frase `APROVAR ...`;
- UX #4, linhas 229-251: aprovador pode **Rejeitar com motivo**;
- PRD #1, linhas 224-231: rejeição registra motivo e não produz efeito.

**Impacto**

Uma rejeição segura pode ser rejeitada pelo schema por não conter uma frase de aprovação, ou o cliente pode enviar texto semanticamente falso só para satisfazer o contrato.

**Correção obrigatória**

Usar `oneOf` discriminado por `decision`: `approve` exige confirmação/hash; `reject` exige motivo e não exige frase de aprovação.

## 4. Observações não bloqueantes

1. O OpenAPI é estruturalmente parseável e todas as referências locais resolvem.
2. `postgresql_isolated` é descrito honestamente como database/role isolados dentro de processo PostgreSQL compartilhado; não há promessa falsa de processo dedicado.
3. O baseline Máximo é usado como referência de isolamento forte e de capacidade, não como equivalência automática.
4. O threat model reproduz corretamente as vulnerabilidades do endpoint atual, inclusive auth fail-open, ausência de `requireJsonContentType`, uso de `postgres` via Docker e vazamento de metadado no primeiro `ERROR:`.
5. Há tensão a esclarecer entre “dry-run não abre conexão administrativa” no threat model e a necessidade da spec de observar estado real/collisions. Recomenda-se um observer read-only separado do executor, sem capability de side effect.
6. A verificação de URLs do repositório privado deve ser repetida com token GitHub válido. Os mesmos quatro paths canônicos foram confirmados no checkout local do platform core.

## 5. Matriz GO/NO-GO

| Gate                         | Resultado                           | Motivo                                                                        |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| PRD / risco central          | PASS condicionado                   | Modos, legado, gates e risco compartilhado estão claros                       |
| OpenAPI estrutural           | PASS                                | Parse, refs, operation IDs e path params verdes                               |
| Consistência entre artefatos | **FAIL**                            | Estados, RBAC, idempotência e secret refs divergem                            |
| Rollback seguro              | **FAIL**                            | Contrato não modela novo plano/aprovação destrutiva                           |
| Links e paths                | PASS local / BLOCKED remoto privado | Paths existem; API GitHub sem credencial válida                               |
| Secret scan dos diffs        | PASS                                | 0 hits nos padrões executados                                                 |
| GO operacional               | **NO-GO explícito**                 | Implementação atual continua schema compartilhado e executor privilegiado web |
| GO para consolidação Gate 3  | **NO-GO**                           | PCV2-QA-001 a 006 devem ser corrigidos                                        |

## 6. Reteste obrigatório

O reteste deve comprovar:

1. um enum e uma tabela de transições idênticos nos quatro PRs;
2. rollback destrutivo com plano/hash/aprovação próprios no OpenAPI;
3. secret identity/ref única e sem path absoluto na UI/API;
4. matriz RBAC única e operações contratuais rastreáveis a scopes;
5. semântica única de idempotency key para primeiro request e retries após timeout;
6. schema discriminado para approve/reject;
7. OpenAPI parse/refs/format novamente verdes;
8. links GitHub verificados com autenticação válida;
9. zero side effect real durante o reteste da discovery.

**Decisão final desta rodada inicial: NO-GO.**

## 7. Reteste das correções — 2026-08-11

### 7.1 Escopo e HEADs revalidados

Este reteste buscou as heads atualizadas das quatro branches, sem GitHub API, e validou os refs remotos por SSH:

| PR  | Branch                       | HEAD remoto no reteste                     |
| --- | ---------------------------- | ------------------------------------------ |
| #1  | `project-center-v2/prd`      | `a743bbdaf60ad068a6dc2be8e328a067ee071b58` |
| #2  | `project-center-v2/spec`     | `0bbe2492455754c2d0fe8073d7f51fce03ba537c` |
| #3  | `project-center-v2/security` | `d19a49ca719b32d190fb6d11ab7723f6a16fc0e2` |
| #4  | `project-center-v2/ux`       | `eb5fac3529392479a132a31f9043691d70b5ccbe` |

Comandos reproduzíveis:

```bash
git fetch je4n project-center-v2/prd project-center-v2/spec project-center-v2/security project-center-v2/ux
git ls-remote git@github.com:JE4NVRG/hermes-workspace.git \
  refs/heads/project-center-v2/prd refs/heads/project-center-v2/spec \
  refs/heads/project-center-v2/security refs/heads/project-center-v2/ux
node scripts/project-center-v2-discovery-retest.mjs
npx --yes @redocly/cli@1.34.5 lint \
  <(git show je4n/project-center-v2/spec:specs/contracts/project-center-v2.openapi.yaml)
npx --yes prettier@3.8.1 --check \
  docs/qa/project-center-v2-discovery-review.md scripts/project-center-v2-discovery-retest.mjs
npx --yes eslint@10.2.0 scripts/project-center-v2-discovery-retest.mjs
git diff --check
```

O script versionado lê os seis artefatos diretamente dos refs Git, parseia o OpenAPI e retorna JSON com veredito. O exit code `1` é esperado enquanto houver achado bloqueante.

### 7.2 Gates automatizados reexecutados

| Gate                               | Resultado | Evidência do reteste                                                                                                       |
| ---------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Parse OpenAPI 3.1 e `$ref` locais  | PASS      | 134 refs; 0 não resolvidas                                                                                                 |
| `operationId` e parâmetros de path | PASS      | 9 IDs únicos; 0 duplicados; 0 parâmetros ausentes                                                                          |
| Estados e transições               | PASS      | 15 estados; 23 transições válidas; 0 destinos fora do enum                                                                 |
| Projeções de estado nos documentos | PASS      | PRD, spec, threat model e UX referenciam `OperationState`/tabela canônica; 0 lacunas                                       |
| RBAC contratual                    | PASS      | `default: deny`; 5 roles; cada uma das 9 operações pertence a uma role e seus `x-required-scopes` estão cobertos           |
| Idempotência                       | PASS      | 7/7 mutações exigem `Idempotency-Key`; contrato declara geração/persistência client-owned antes do primeiro POST           |
| Rollback                           | PASS      | endpoints `dry-run`, `approve` e `execute`; `rollback_plan_hash`, `approval_id` e segregação destrutiva presentes          |
| Approve/reject                     | PASS      | provisionamento e rollback usam `oneOf` discriminado; approve exige hash/confirmação e reject exige motivo sem confirmação |
| Identidade e referência de secret  | **FAIL**  | 0 paths absolutos, mas três artefatos ainda usam duas identidades incompatíveis na `secret_ref`                            |
| Secret scan dos diffs              | PASS      | 4 branches; 4 classes de padrão; 0 hits                                                                                    |
| Redocly CLI 1.34.5                 | PASS      | `Woohoo! Your API description is valid.`                                                                                   |
| Prettier 3.8.1                     | PASS      | os dois artefatos do reteste usam o estilo configurado                                                                     |
| ESLint                             | PASS      | script sem erros; somente aviso upstream sobre `.eslintignore` legado                                                      |
| `git diff --check`                 | PASS      | 0 erros de whitespace no patch do reteste                                                                                  |
| Referências dos artefatos          | PASS      | `git cat-file -e` resolveu 6/6 arquivos nas heads revisadas                                                                |

O reteste foi estritamente documental/contratual. Nenhum banco, role, secret, Docker, Nginx, DNS, Cloudflare, systemd ou ambiente de produção foi acessado ou alterado.

### 7.3 Resultado por achado

#### PCV2-QA-001 — PASS — estados canônicos

`OperationState` contém 15 valores e `x-allowed-transitions` contém 23 arestas válidas. PRD (`docs/PRD-project-center-v2.md:201-218`), spec (`specs/features/project-center-v2.spec.md:89-122`), threat model (`docs/security/project-center-v2-threat-model.md:283-297`) e UX (`docs/design/project-center-v2-ux.md:339-361`) projetam os mesmos identificadores sem reintroduzir aliases de domínio.

#### PCV2-QA-002 — PASS — rollback com plano e aprovação próprios

O OpenAPI agora separa `POST .../rollback/dry-run`, `POST .../rollback/approve` e `POST .../rollback/execute`. `RollbackPlan` exige `rollback_plan_hash`; execute exige hash e `approval_id`; a policy `destructive_rollback` vincula a decisão ao hash e separa os atores. PRD, ADR, spec, threat model e UX descrevem as mesmas três fases.

#### PCV2-QA-003 — FAIL P1 — `secret_ref` ainda alterna identidade pública e UUID interno

O vazamento de path absoluto foi corrigido: o scanner encontrou 0 ocorrências de `/home/` nos seis artefatos. A identidade, porém, continua contraditória:

- o PRD (`docs/PRD-project-center-v2.md:194-197`) determina `project_uuid` imutável e afirma que clientes não constroem `secret_ref` a partir de UUID, `project_id`, slug ou path;
- o threat model (`docs/security/project-center-v2-threat-model.md:158`) exemplifica `secret://projects/<project-uuid>/<purpose>`;
- a spec (`specs/features/project-center-v2.spec.md:72`) exemplifica `secret://projects/<project_id>/database-url`;
- a UX (`docs/design/project-center-v2-ux.md:140`) exibe `secret://projects/<project_id>/d•••••••-url`;
- o OpenAPI deixa `ArtifactRef.ref` como string genérica e não resolve qual identidade é canônica.

Assim, implementações podem vincular o secret ao identificador público determinístico ou ao UUID interno e ainda alegar conformidade local. Correção obrigatória: definir no contrato uma referência opaca emitida pelo broker, sem placeholder derivável pelo cliente, e projetar exatamente a mesma regra/exemplo em PRD, spec, threat model e UX.

#### PCV2-QA-004 — PASS — RBAC canônico e validável

O `x-rbac-policy` contém cinco roles, `default: deny`, ambientes e regras de segregação. As nove operações possuem `x-required-scopes`; todos os `operationId` referenciados existem e cada operação está atribuída exatamente a uma role HTTP canônica.

#### PCV2-QA-005 — PASS — idempotência client-owned

As sete mutações referenciam o header obrigatório. Sua descrição determina criação e persistência pelo cliente/SDK antes da primeira tentativa, reutilização após timeout e persistência somente do hash no servidor. PRD, ADR, spec, threat model e UX repetem essa semântica.

#### PCV2-QA-006 — PASS — approve/reject discriminados

`ApprovalRequest` e `RollbackApprovalRequest` usam `oneOf` com discriminator `decision`. Os ramos approve exigem hash e confirmação; os ramos reject exigem `decision` e `reason`, sem hash nem frase de aprovação.

### 7.4 Matriz final do reteste

| Decisão                               | Resultado         | Motivo                                                                                                     |
| ------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Correções PCV2-QA-001/002/004/005/006 | **PASS**          | contratos e projeções agora são consistentes e validados automaticamente                                   |
| Correção PCV2-QA-003                  | **FAIL P1**       | `secret_ref` alterna `<project_id>` e `<project-uuid>` e o OpenAPI não torna a identidade opaca inequívoca |
| GO operacional                        | **NO-GO mantido** | discovery não implementa nem autoriza side effects reais                                                   |
| GO para consolidação do Gate 3        | **NO-GO**         | não consolidar PRs #1–#4 enquanto PCV2-QA-003 permanecer divergente                                        |

**Decisão final do reteste: NO-GO. Cinco de seis achados foram corrigidos; PCV2-QA-003 permanece bloqueante para consolidação.**

## 8. Segundo reteste — SecretRef opaca — 2026-08-11

### 8.1 Escopo, método e heads SSH

Task de reteste: `t_1906b882`. Issue de acompanhamento: `JE4NVRG/je4ndev-platform-core#20`.

O segundo reteste buscou as heads corrigidas diretamente por Git SSH, sem GitHub API, browser ou credencial HTTP. Os refs locais e remotos foram comparados antes dos testes:

| PR  | Branch                       | HEAD remoto verificado por SSH             |
| --- | ---------------------------- | ------------------------------------------ |
| #1  | `project-center-v2/prd`      | `a743bbdaf60ad068a6dc2be8e328a067ee071b58` |
| #2  | `project-center-v2/spec`     | `e330a83a5570a7c917d1f4c38cdddb7fdb0411a0` |
| #3  | `project-center-v2/security` | `5854da43eabc8b0de46cfb58d6ec183812406856` |
| #4  | `project-center-v2/ux`       | `4a291a039e6191bda53f9beec89fcc02af865713` |

Comandos principais reproduzíveis:

```bash
git fetch git@github.com:JE4NVRG/hermes-workspace.git \
  project-center-v2/prd:refs/remotes/je4n/project-center-v2/prd \
  project-center-v2/spec:refs/remotes/je4n/project-center-v2/spec \
  project-center-v2/security:refs/remotes/je4n/project-center-v2/security \
  project-center-v2/ux:refs/remotes/je4n/project-center-v2/ux
git ls-remote git@github.com:JE4NVRG/hermes-workspace.git \
  refs/heads/project-center-v2/prd refs/heads/project-center-v2/spec \
  refs/heads/project-center-v2/security refs/heads/project-center-v2/ux
node scripts/project-center-v2-discovery-retest.mjs
npx --yes @redocly/cli@1.34.5 lint \
  <(git show je4n/project-center-v2/spec:specs/contracts/project-center-v2.openapi.yaml)
npx --yes prettier@3.8.1 --check \
  docs/qa/project-center-v2-discovery-review.md scripts/project-center-v2-discovery-retest.mjs
npx --yes eslint@10.2.0 scripts/project-center-v2-discovery-retest.mjs
git diff --check
```

### 8.2 PCV2-QA-003 — PASS — contrato opaco e não derivável

O achado foi corrigido na fonte canônica e nas projeções:

- OpenAPI `SecretRef` exige `sref_` seguido de 43–128 caracteres base64url, `minLength: 48`, `maxLength: 133` e pelo menos 256 bits CSPRNG;
- `ArtifactRef` aplica condicionalmente `#/components/schemas/SecretRef` quando `type = secret_ref`, em vez de aceitar uma referência genérica;
- ADR, spec, threat model e UX definem emissão exclusivamente server-side pelo broker e proíbem construir, analisar ou derivar o token de `project_id`, `project_uuid`, UUID, slug, purpose, provider, locator ou path;
- o broker persiste digest e binding interno protegido de forma durável e atômica antes de publicar o artefato;
- retry idempotente recupera a referência persistida; rotação emite nova referência aleatória;
- token integral e binding privado são redigidos de UI, DOM, URL, clipboard, export, suporte, logs, traces, métricas, erros e auditoria;
- o scanner encontrou **0** URIs `secret://`, placeholders deriváveis, paths absolutos e tokens integrais não mascarados nos seis artefatos.

O exemplo `sref_REDACTED_REDACTED_REDACTED_REDACTED_REDACTED` é uma máscara neutra explícita, não uma referência real nem um alias derivável.

**Escopo declarado do scan (path absoluto, placeholder derivável, URI `secret://`, token integral):** as contagens desta seção valem para os **6 artefatos contratuais** — PRD, ADR, OpenAPI, spec, threat model e UX —, que são exatamente os arquivos lidos pelo reteste. Este documento de QA **não é alvo do scan**: as citações históricas de `/home/jean/.config/je4ndev/projects/<slug>.env` (§3) e de `secret://projects/<id>/…` (§7.3) são evidência de achados já corrigidos, não credencial, segredo, instrução operacional nem implementação. A afirmação “0 paths absolutos” deve portanto ser lida como escopada aos 6 artefatos contratuais (§9.1).

### 8.3 Regressão completa dos seis achados

| Achado      | Resultado | Evidência automatizada                                                                           |
| ----------- | --------- | ------------------------------------------------------------------------------------------------ |
| PCV2-QA-001 | **PASS**  | 15 estados, 23 transições válidas e 0 lacunas nas projeções PRD/spec/threat/UX                   |
| PCV2-QA-002 | **PASS**  | rollback `dry-run/approve/execute`, hash, `approval_id` e segregação destrutiva                  |
| PCV2-QA-003 | **PASS**  | schema condicional, broker-issued CSPRNG, binding atômico e 0 placeholders/tokens/paths expostos |
| PCV2-QA-004 | **PASS**  | `default: deny`, 5 roles, 9 operações e 0 inconsistências de scopes/ownership                    |
| PCV2-QA-005 | **PASS**  | 7/7 mutações exigem `Idempotency-Key` client-owned antes do primeiro POST                        |
| PCV2-QA-006 | **PASS**  | provisionamento e rollback usam `oneOf` discriminado para approve/reject                         |

### 8.4 Gates técnicos reexecutados

| Gate                                                        | Resultado                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| OpenAPI 3.1 parse e `$ref` locais                           | **PASS** — 135 refs, 0 não resolvidas                           |
| `operationId` e parâmetros de path                          | **PASS** — 9 IDs únicos, 0 ausências                            |
| Referências dos seis artefatos nos refs Git                 | **PASS** — 6/6 resolvidas por `git cat-file -e`                 |
| Redocly CLI 1.34.5                                          | **PASS** — API description valid                                |
| Estados e projeções                                         | **PASS** — 15 estados, 23 transições, 0 inconsistências/lacunas |
| RBAC                                                        | **PASS** — default deny, 5 roles, 9 operações cobertas          |
| Idempotência                                                | **PASS** — 7 mutações cobertas                                  |
| Rollback e approve/reject                                   | **PASS** — contratos segregados e discriminados                 |
| SecretRef schema/projeções                                  | **PASS** — contrato opaco em PRD/ADR/OpenAPI/spec/threat/UX     |
| Placeholder/path/token scan                                 | **PASS** — 0/0/0                                                |
| Secret scan dos diffs das quatro branches                   | **PASS** — 0 hits                                               |
| Prettier e ESLint dos dois artefatos QA; `git diff --check` | **PASS**                                                        |

O reteste permaneceu estritamente documental e contratual. Nenhum banco, role, secret real, Docker, Nginx, DNS, Cloudflare, systemd ou ambiente de produção foi acessado ou alterado.

Como observação de baseline fora do critério desta discovery, o relato de ambiente desta seção estava incompleto: Node `v22.23.2` existe em `$HOME/.nvm/versions/node/v22.23.2` e a suíte global roda com ele. A medição fresca, o comando e a contagem corrigida estão em §9.2. O gate scoped deste PR permanece verde: 0 erro de ESLint/Prettier nos artefatos QA.

### 8.5 Veredito

**GO para consolidar o Gate 3.** As versões verificadas dos PRs #1–#4 corrigem PCV2-QA-001 a PCV2-QA-006, inclusive a `SecretRef` opaca emitida pelo broker, e todos os gates aplicáveis estão verdes.

Este GO permite somente a consolidação dos artefatos de discovery nas heads acima. **Não é GO operacional nem autorização de deploy/produção**: implementação, feature flag, dry-run e gates finais de QA/Security permanecem etapas posteriores obrigatórias.

## 9. Correções da onda PCv2/W0 — 2026-09-24

Task: `t_1b1f55b3` (Wave 0 da onda de implementação; gate CEO `t_b3ca5a60`). Branch de trabalho: `project-center-v2/qa-discovery`, com a base consolidada `je4n/project-center-v2/base-20260811` (`6e2a36f5`) integrada antes das edições. Escopo estritamente local: nenhum banco, DDL, Docker, R2, Nginx, DNS, Cloudflare, systemd, produção, segredo ou DSN real foi acessado, e nenhum side effect externo foi produzido.

### 9.1 Escopo do scan de path absoluto e secret (P3-02)

Declaração explícita, válida para as seções 7 e 8: o scan de path absoluto, placeholder derivável, URI `secret://`, token integral e padrões de segredo cobre **os 6 artefatos contratuais** — `docs/PRD-project-center-v2.md`, `docs/adr/0001-project-center-v2-control-plane.md`, `specs/contracts/project-center-v2.openapi.yaml`, `specs/features/project-center-v2.spec.md`, `docs/security/project-center-v2-threat-model.md` e `docs/design/project-center-v2-ux.md`. É esse o conjunto lido pelo reteste em qualquer modo.

`docs/qa/project-center-v2-discovery-review.md` (este documento) **não** entra no scan: as citações históricas de path absoluto e de URI `secret://` em §3 e §7.3 são evidência dos achados já corrigidos — não são credencial, segredo, implementação nem instrução operacional. A leitura correta de “0 paths absolutos” é, portanto, escopada aos 6 artefatos contratuais.

### 9.2 Relato de ambiente corrigido (P3-04)

Ambiente medido nesta rodada: Node `v22.23.2` em `$HOME/.nvm/versions/node/v22.23.2` (`/home/jean/.nvm/versions/node/v22.23.2` no worker), `prettier 3.8.1` e `eslint v10.2.0` dos `node_modules` do checkout.

Comando da suíte global, executado a partir do worktree:

```bash
PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" \
  node_modules/.bin/vitest run --reporter=basic
```

Resultado: **42 failed / 710 passed (752)**, 17 arquivos com falha de 119, 24,07 s, exit code `1`. As falhas são pré-existentes e **fora do escopo** deste PR: os arquivos que falham são de chat, workspace, router, playground, mcp, swarm2 e vt-capital, e **nenhum** toca `project-center` ou `supabase` — o único teste da superfície Supabase, `src/server/supabase-registry.test.ts`, passa 5/5. Este PR não altera código de aplicação: altera o reteste, este parecer e o `.gitignore`.

### 9.3 Reteste parametrizado para o head agregado (P3-01)

`scripts/project-center-v2-discovery-retest.mjs` passou a ter dois modos:

| Modo              | Alvo dos artefatos                                                 | Seleção                                            |
| ----------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| agregado (padrão) | os 6 artefatos no **head do próprio checkout/worktree**            | `--ref <ref>` ou `PCV2_RETEST_REF`; default `HEAD` |
| legado            | as quatro branches `je4n/project-center-v2/{prd,spec,security,ux}` | `--branches`                                       |

A base de comparação do secret scan é configurável por `--base <ref>`/`PCV2_RETEST_BASE`; o default continua `je4n/project-center-v2/base-20260811` quando comparável (senão o pai do alvo). O JSON de saída expõe `mode`, `comparison_base` (ref, origem e ranges efetivos), `artifacts` (ref, path e blob por artefato) e mantém `heads`, `checks`, `failures` e `verdict`. Exit codes: `0` GO, `1` NO-GO, `2` uso/ref inválida.

Evidência executada (Node `v22.23.2`):

| Comando                                                                    | Resultado                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/project-center-v2-discovery-retest.mjs` (default = `HEAD`)   | exit `0`, `verdict: GO`, 13/13 checagens PASS, base default `je4n/project-center-v2/base-20260811`; `heads` registra o sha do alvo no momento da execução (`56042e45…` nesta medição) |
| mesmo comando repetido                                                     | JSON **byte a byte idêntico** (`cmp` limpo) — determinístico para a mesma ref                                                                                                         |
| `node … --ref 6e2a36f5`                                                    | exit `0`, `verdict: GO`, `heads {"6e2a36f5":"6e2a36f59d903b28…"}`                                                                                                                     |
| `PCV2_RETEST_REF=6e2a36f5 node …`                                          | saída **byte a byte idêntica** à do `--ref` equivalente                                                                                                                               |
| `node … --base 8e62b3169afa72032fa828b5b66f6c30da29a383`                   | exit `0`, `verdict: GO`, range `8e62b316…...HEAD`                                                                                                                                     |
| `node … --branches` (legado)                                               | exit `0`, `verdict: GO`, `heads` `a743bbda`/`e330a83a`/`5854da43`/`4a291a03` — **idênticos aos registrados em §8.1**                                                                  |
| comparação legado × script anterior                                        | `verdict`, `heads`, `failures` e as **12 checagens originais** byte a byte idênticos; acrescenta apenas a checagem aditiva `artifact-references` (6/6 artefatos resolvidos)           |
| `node … --ref je4n/project-center-v2/prd` (ref sem os 6 artefatos)         | exit `1`, `verdict: NO-GO`, `failures[]` preenchido, **sem crash** e sem stack trace — degrada para FAIL                                                                              |
| `--bogus`, `--ref` sem valor, `--branches` + `--ref`, ref/base inexistente | exit `2` com mensagem de uso em `stderr`                                                                                                                                              |

No modo agregado o range do secret scan é `<base>...<alvo>`; como o alvo já contém a base consolidada, o range efetivo é o delta do alvo sobre a base — o mesmo critério que o modo legado aplicava por branch. O range usado fica registrado em `comparison_base.ranges`, mantendo o gate auditável.

### 9.4 Exceção de `docs/security/` no `.gitignore` (P3-06, Security)

O `.gitignore` mantém `docs/security/` ignorado e passa a negá-lo (`!docs/security/`), porque o plano (PR 7) exige `docs/security/project-center-v2-independent-review.md` em caminho versionado. Evidência: `git check-ignore -v --no-index docs/security/project-center-v2-independent-review.md` apontava `.gitignore:117:docs/security/` antes e não aponta mais nada depois; um arquivo novo naquele diretório passou a aparecer em `git status --short` e o `git add` o aceita **sem** `-f`. As demais regras do arquivo foram reconferidas e seguem valendo (`docs/QA/`, `skills-bundle/`, `SHIP-REPORT.md`, `.env`).

### 9.5 Gates scoped desta rodada

| Gate                                                                                                                  | Resultado                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `prettier 3.8.1 --check docs/qa/project-center-v2-discovery-review.md scripts/project-center-v2-discovery-retest.mjs` | **PASS**                                                                                   |
| `eslint v10.2.0 scripts/project-center-v2-discovery-retest.mjs`                                                       | **PASS** — somente o aviso upstream sobre `.eslintignore` legado                           |
| `git diff --check`                                                                                                    | **PASS** — 0 erros de whitespace; cobre também o `.gitignore`, que não tem parser Prettier |
| Reteste default, `--ref`, env, `--base` e `--branches`                                                                | **PASS** — §9.3                                                                            |

O veredito de §8.5 permanece o mesmo: **GO para consolidar o Gate 3 do discovery; NO-GO operacional.** Estas correções não autorizam deploy, ativação de flag, DDL, Docker/R2 de produção ou qualquer side effect externo.
