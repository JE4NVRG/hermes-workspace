# Project Center v2 — Plano de Implementação

> **Para Hermes:** usar a skill `subagent-driven-development` para executar este plano tarefa por tarefa, mantendo revisão de conformidade e qualidade em cada PR.

**Objetivo:** substituir a criação síncrona de schema compartilhado por um control plane tipado, idempotente, auditável e seguro para `postgresql_isolated` e `supabase_isolated`, sem habilitar efeitos reais durante a implementação inicial.

**Arquitetura:** a API recebe intenção, produz um plano imutável em dry-run e persiste aprovação vinculada ao hash. Um worker separado executa somente ações tipadas de drivers allowlisted, com lease/fencing, secret broker e auditoria append-only; publicação no registry ocorre apenas após verificação. A UI acompanha a máquina de estados canônica do OpenAPI e nunca recebe credenciais ou paths do host.

**Stack:** TypeScript 5.7, TanStack Start/Router, React 19, Zod, Vitest, YAML/OpenAPI 3.1 e storage PostgreSQL acessado por adapter server-side.

**Baseline obrigatório:** `project-center-v2/base-20260811` + pacote de discovery aprovado no Gate 3. Fonte canônica: `specs/contracts/project-center-v2.openapi.yaml`; projeções: PRD, ADR, spec, threat model e UX.

---

## Regras globais e ordem de entrega

1. Cada seção abaixo é um PR atômico contra a head aprovada do PR anterior.
2. `PROJECT_CENTER_V2_ENABLED` e `PROJECT_CENTER_V2_WORKER_ENABLED` nascem ausentes/`false`; o código deve interpretar qualquer valor diferente de `true` como desligado.
3. Enquanto as flags estiverem desligadas, nenhum caminho novo pode abrir conexão administrativa, executar DDL, chamar Docker, escrever secret, publicar registry ou alterar backup/R2.
4. O POST legado de `src/routes/api/supabase-registry.ts` permanece inalterado até existir migração aprovada separadamente; o v2 usa `/api/project-center/v2/...`.
5. Nenhum segredo, DSN, senha, JWT, service key, conteúdo de `.env`, SQL livre, shell livre ou path absoluto entra em request, response, log, audit, teste fixture ou commit.
6. Toda mutação exige `Idempotency-Key` gerada e persistida pelo cliente antes da primeira tentativa; o servidor persiste somente seu hash.
7. Produção permanece NO-GO até QA e Security finais aprovarem e um operador autorizar explicitamente o rollout.

## Contrato comum de verificação

Executar em todos os PRs:

```bash
pnpm exec prettier --check <arquivos-do-PR>
pnpm exec eslint <arquivos-ts-tsx-do-PR>
pnpm exec vitest run <testes-do-PR>
git diff --check project-center-v2/base-20260811...HEAD
```

Antes de qualquer merge, executar também:

```bash
node scripts/project-center-v2-discovery-retest.mjs
pnpm exec redocly lint specs/contracts/project-center-v2.openapi.yaml
pnpm run build
```

Resultado esperado: verificações scoped verdes; o reteste deve reportar PCV2-QA-001 a 006 como PASS. Falhas globais preexistentes devem ser registradas com comando, contagem e separação clara do escopo — nunca mascaradas.

---

## PR 1 — Domínio, máquina de estados e auditoria append-only

**Objetivo:** implementar o núcleo puro, sem I/O privilegiado, a partir do OpenAPI canônico.

**Arquivos:**

- Criar: `src/server/project-center-v2/domain.ts`
- Criar: `src/server/project-center-v2/state-machine.ts`
- Criar: `src/server/project-center-v2/policy.ts`
- Criar: `src/server/project-center-v2/redaction.ts`
- Criar: `src/server/project-center-v2/audit-store.ts`
- Criar: `src/server/project-center-v2/operation-store.ts`
- Criar: `src/server/project-center-v2/feature-flags.ts`
- Criar testes homônimos `*.test.ts` no mesmo diretório

### Passos TDD

1. Escrever testes que importem os 15 valores de `OperationState` e rejeitem qualquer transição fora das 23 arestas canônicas do OpenAPI.
2. Executar os testes e confirmar RED por módulos ausentes.
3. Implementar tipos Zod para `ProjectIntent`, `Operation`, `PlannedAction`, `ArtifactRef`, aprovação discriminada e rollback discriminado; não duplicar aliases de estado de UX.
4. Implementar `transitionOperation(current, next, expectedRevision)` com optimistic revision e erro fechado para transição inválida.
5. Escrever testes de RBAC para as cinco roles do `x-rbac-policy`, incluindo default deny, ambiente e segregação de funções.
6. Implementar policy engine puro por `operationId` + scopes; descrições textuais nunca concedem acesso.
7. Escrever testes de redaction com DSN, password, JWT, service key, path absoluto e `sref_` integral; confirmar que nenhum valor reaparece serializado.
8. Implementar catálogo fechado de erros e redaction antes de serializar log/audit.
9. Escrever testes de auditoria append-only, sequência monotônica, correlação, paginação e tentativa de update/delete negada pelo adapter.
10. Implementar stores por interfaces in-memory somente para testes unitários; nenhum store de runtime deve ser instanciado neste PR.
11. Testar flags ausentes, `false`, valores inválidos e `true`; default esperado: desligado.

**Critérios de aceite:** máquina canônica exata; RBAC default deny; audit sanitizado; zero import de `child_process`, Docker ou cliente PostgreSQL; flags off por padrão.

**Commit:** `feat(project-center): adiciona domínio e auditoria sem efeitos`

---

## PR 2 — Driver PostgreSQL em dry-run estrito

**Objetivo:** planejar `postgresql_isolated` observando apenas metadados sanitizados, sem executar DDL ou emitir credencial.

**Arquivos:**

- Criar: `src/server/project-center-v2/drivers/types.ts`
- Criar: `src/server/project-center-v2/drivers/postgresql-isolated.ts`
- Criar: `src/server/project-center-v2/observers/postgresql-observer.ts`
- Criar: `src/server/project-center-v2/naming.ts`
- Criar: `src/server/project-center-v2/planner.ts`
- Criar testes `drivers/postgresql-isolated.test.ts`, `observers/postgresql-observer.test.ts`, `naming.test.ts` e `planner.test.ts`

### Passos TDD

1. Testar nomes `je4ndev_<cliente>_<projeto>` e `<database>_app`, normalização, limites, colisões e rejeição de identificadores arbitrários.
2. Implementar naming determinístico a partir de IDs/slug validados; nunca aceitar SQL identifier bruto do cliente.
3. Testar o observer com uma porta injetada read-only: host apenas de allowlist, statement catalog fechado e resultado sem credenciais.
4. Implementar observer sem método de escrita e sem fallback para shell/SQL livre.
5. Testar que o planner retorna ações tipadas `reserve_project`, `create_database`, `create_app_role`, `apply_least_privilege`, `create_secret_ref`, `configure_backup`, `configure_r2_prefix`, `verify_cross_isolation`, `verify_backup_restore` e publicação, mas não as executa.
6. Implementar hash canônico do plano incluindo driver/version, observed revision, ações, política e prazo.
7. Testar idempotência: mesma intenção + mesma observação gera mesmo plano/hash; mudança material exige nova key/plano.
8. Testar que flag off impede até a observação runtime e retorna erro tipado `feature_disabled`.

**Critérios de aceite:** dry-run não executa DDL; nenhuma senha/DSN; PostgreSQL nunca aponta para `0.0.0.0:5432`; plano imutável e reproduzível.

**Commit:** `feat(project-center): planeja PostgreSQL isolado em dry-run`

---

## PR 3 — Driver Supabase em dry-run estrito

**Objetivo:** planejar uma stack Supabase completa e isolada usando somente templates, imagens e destinos allowlisted.

**Arquivos:**

- Criar: `src/server/project-center-v2/drivers/supabase-isolated.ts`
- Criar: `src/server/project-center-v2/observers/supabase-observer.ts`
- Criar: `src/server/project-center-v2/catalogs/supabase-catalog.ts`
- Criar: `src/server/project-center-v2/catalogs/supabase-catalog.test.ts`
- Criar testes `drivers/supabase-isolated.test.ts` e `observers/supabase-observer.test.ts`

### Passos TDD

1. Testar rejeição de imagem sem digest, template desconhecido, hostname/path/rede fornecido livremente e capacidade não suportada.
2. Implementar catálogo compilado de versões, digests, perfis de recurso, target IDs e templates permitidos; nenhum valor sensível no catálogo.
3. Testar observer read-only por porta injetada e projeção sanitizada de existência, ownership marker, drift e capacidade.
4. Implementar observer sem `exec`, `spawn`, compose up/down ou escrita em filesystem.
5. Testar ações tipadas para compose project, rede, data store, secret refs, health, backup e restore; cada recurso inclui ownership marker esperado.
6. Implementar planner do driver e estimativa de recursos; `schema_shared` deve falhar como driver não selecionável.
7. Testar que dry-run não chama executor mesmo se um adapter executor for acidentalmente injetado.

**Critérios de aceite:** zero comando Docker; zero renderização com secret real; imagens pinadas; stack, rede e data store distintos no plano; flag off.

**Commit:** `feat(project-center): planeja Supabase isolado em dry-run`

---

## PR 4 — API v2, idempotência, aprovações e gates

**Objetivo:** expor os nove `operationId` do OpenAPI com autenticação/RBAC, content-type, idempotência e segregação, ainda sem worker executor.

**Arquivos:**

- Criar: `src/routes/api/project-center/v2/operations/index.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/approval.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/execute.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/verify.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/audit.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/rollback/dry-run.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/rollback/approval.ts`
- Criar: `src/routes/api/project-center/v2/operations/$operationId/rollback/execute.ts`
- Criar: `src/server/project-center-v2/http.ts`
- Criar: `src/server/project-center-v2/idempotency.ts`
- Criar: `src/server/project-center-v2/approval-service.ts`
- Criar testes de rota e serviços no mesmo diretório

### Passos TDD

1. Criar contract tests que comparem método/path/`operationId`, requests e responses das rotas com o OpenAPI.
2. Testar 401, 403, content-type inválido, body inválido, scope ausente e role fora do ambiente.
3. Implementar middleware fechado usando a política do PR 1; não reutilizar apenas `isAuthenticated` como autorização suficiente.
4. Testar header obrigatório, hash persistido, replay idêntico e conflito quando a mesma key acompanha payload diferente.
5. Implementar idempotência client-owned e transação operação + outbox; resposta após timeout deve ser recuperável.
6. Testar approve/reject `oneOf`, expiração, plan hash divergente, revisão divergente e dupla pessoa em produção.
7. Implementar aprovação vinculada a hash/revision; rejeição exige motivo, nunca frase de aprovação.
8. Testar rollback em três fases com `rollback_plan_hash`, novo `approval_id`, ownership/drift e segregação destrutiva.
9. Implementar endpoints execute/verify apenas como enfileiramento; com worker flag off, nenhuma ação privilegiada ocorre.
10. Testar que todos os erros e payloads passam por sanitização e nunca retornam `SecretRef` integral fora de campo tipado permitido.

**Critérios de aceite:** nove operações contratuais; default deny; replay seguro; outbox atômico; execute não produz side effect com worker off.

**Commit:** `feat(project-center): expõe API v2 com gates fechados`

---

## PR 5 — UI do wizard, timeline e acessibilidade

**Objetivo:** implementar a UX aprovada, com cliente idempotente e apresentação sanitizada, atrás da feature flag desligada.

**Arquivos:**

- Criar: `src/lib/project-center-v2-api.ts`
- Criar: `src/lib/project-center-v2-types.ts`
- Criar: `src/hooks/use-project-center-v2.ts`
- Criar: `src/screens/supabase/project-center-v2-wizard.tsx`
- Criar: `src/screens/supabase/project-center-v2-operation.tsx`
- Criar: `src/screens/supabase/project-center-v2-gate.tsx`
- Criar testes `src/lib/project-center-v2-api.test.ts`, `src/hooks/use-project-center-v2.test.tsx` e `src/screens/supabase/project-center-v2-wizard.test.tsx`
- Modificar: `src/screens/supabase/supabase-projects-screen.tsx`

### Passos TDD

1. Testar cliente que gera/persiste `Idempotency-Key` antes do primeiro POST e a reutiliza em retry/timeout.
2. Implementar client estritamente tipado, sem construir `SecretRef` e sem aceitar path/credential.
3. Testar wizard para seleção de driver, intenção, dry-run, diff, custo/recurso, aprovação, execução, verificação e rollback.
4. Implementar componentes conforme `docs/design/project-center-v2-ux.md`, mapeando labels aos estados canônicos sem aliases no domínio.
5. Testar navegação por teclado, foco no primeiro erro, labels, live region de timeline, contraste e `prefers-reduced-motion`.
6. Implementar acessibilidade WCAG 2.1 AA e estados de loading/empty/error/permission denied.
7. Testar mascaramento neutro de secret refs e ausência de path absoluto/credential em DOM, clipboard e toast.
8. Integrar no screen atual apenas quando a flag server-projected estiver ativa; flag off mantém exatamente a experiência atual.
9. Testar que ações irreversíveis exigem aprovação válida e que UI não infere permissão por esconder botão.

**Critérios de aceite:** flag off preserva comportamento atual; nenhuma credencial no browser; fluxo completo navegável por teclado; cliente idempotente.

**Commit:** `feat(project-center): adiciona wizard v2 atrás de flag`

---

## PR 6 — Backup, restore, execução allowlisted e rollback

**Objetivo:** implementar adapters de execução e provas de backup/restore sem ativá-los; qualquer teste de integração usa harness efêmero e isolado, nunca produção.

**Arquivos:**

- Criar: `src/server/project-center-v2/worker.ts`
- Criar: `src/server/project-center-v2/lease-store.ts`
- Criar: `src/server/project-center-v2/executors/action-executor.ts`
- Criar: `src/server/project-center-v2/executors/postgresql-executor.ts`
- Criar: `src/server/project-center-v2/executors/supabase-executor.ts`
- Criar: `src/server/project-center-v2/secret-broker.ts`
- Criar: `src/server/project-center-v2/backup-service.ts`
- Criar: `src/server/project-center-v2/restore-verifier.ts`
- Criar: `src/server/project-center-v2/rollback-service.ts`
- Criar testes unitários homônimos e `src/server/project-center-v2/project-center-v2.integration.test.ts`

### Passos TDD

1. Testar lease exclusivo, expiração, fencing token crescente e recusa de writer stale.
2. Implementar worker que consome somente outbox aprovada e revalida flag, policy, hash, revision, approval, lease e observed state antes de cada ação.
3. Testar executor contra catálogo fechado; ação, template, host target ou path fora da allowlist falha antes do adapter externo.
4. Implementar comandos como argv fixo via adapter injetado, sem shell e sem SQL recebido do request; SQL administrativo deve vir de templates versionados internos.
5. Testar `SecretRef` com `sref_`, 32+ bytes CSPRNG, base64url, binding privado atômico por digest, replay idempotente, rotação e redaction.
6. Implementar broker por interface; fixture usa valor sintético gerado em runtime e nunca material real.
7. Testar backup por project UUID/environment, prefixo R2 dedicado, checksum, retenção e artefato sanitizado.
8. Implementar backup service e restore em destino efêmero distinto; nunca restaurar sobre origem.
9. Testar prova negativa A→B para database/role, stack/network/data store e restore; falha deve bloquear publicação.
10. Implementar verifier e publicação outbox somente após health + isolamento + backup/restore PASS.
11. Testar rollback com novo plano/aprovação, ownership marker, drift e recurso pré-existente; recurso sem ownership deve ir para `manual_intervention_required`, não ser removido.
12. Implementar rollback allowlisted; rollback de software apenas desliga flags/workers e preserva audit/operações.
13. Executar integration harness apenas com variáveis explícitas de teste e guard que recuse host/path de produção.

**Critérios de aceite:** flags continuam off; nenhum side effect no deploy; executor fechado; backup/restore e isolamento comprováveis em harness efêmero; rollback não destrói recurso sem ownership.

**Commit:** `feat(project-center): adiciona worker e recuperação desativados`

---

## PR 7 — Gate final de QA e Security

**Objetivo:** automatizar as provas finais, documentar evidências e manter rollout bloqueado até pareceres independentes.

**Arquivos:**

- Criar: `scripts/project-center-v2-contract-check.mjs`
- Criar: `scripts/project-center-v2-secret-scan.mjs`
- Criar: `docs/qa/project-center-v2-final-gate.md`
- Criar: `docs/security/project-center-v2-independent-review.md`
- Criar: `docs/runbooks/project-center-v2-deploy-and-rollback.md`
- Modificar: `package.json` para scripts scoped `project-center:v2:contract`, `project-center:v2:scan` e `project-center:v2:gate`

### Passos

1. Validar OpenAPI 3.1, `$ref`, operation IDs, path params, estados/transições, RBAC/scopes, mutações idempotentes e schemas discriminados.
2. Validar que todos os artefatos referenciados existem e que PRD/ADR/spec/threat/UX projetam o contrato canônico.
3. Escanear diff e respostas/fixtures/log captures por private keys, PAT, password/DSN, JWT, service key, path absoluto e token `sref_` integral.
4. Executar testes unitários, contract tests, build e harness efêmero de dois projetos por driver.
5. Provar replay sem duplicação, falha intermediária reconciliável, lease stale recusado, A sem acesso a B, backup/restore por projeto e rollback com gate próprio.
6. QA registra comandos, saídas, ambiente, commits e veredito APPROVE/REQUEST_CHANGES em `docs/qa/project-center-v2-final-gate.md`.
7. Security revisa least privilege, default deny, idempotência, auditoria, blast radius, allowlists, secret broker, gates e redaction em `docs/security/project-center-v2-independent-review.md`.
8. REQUEST_CHANGES de qualquer revisor mantém ambas as flags desligadas e bloqueia rollout.

**Critérios de aceite:** parse/docs/secret scan verdes; testes cross-database/stack, rollback e restore com evidência; QA e Security independentes aprovam; flags ainda off.

**Commit:** `test(project-center): consolida gates finais de QA e Security`

---

## Deploy seguro

Este pacote de discovery não deve ser implantado como funcionalidade operacional. Para os PRs futuros:

1. Fazer build e publicar o software com `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`.
2. Verificar health, rotas legadas e que `/api/project-center/v2/...` responde `feature_disabled` sem abrir observers/executors.
3. Após QA/Security GO, habilitar somente a API/dry-run em development: `PROJECT_CENTER_V2_ENABLED=true`, worker ainda `false`.
4. Executar contract gate, secret scan e dry-runs de ambos os drivers; confirmar zero side effect.
5. Habilitar worker somente em harness development allowlisted e com operador presente; nunca apontar para recursos atuais/produção.
6. Promover para staging somente após prova A→B, replay, backup/restore e rollback.
7. Produção exige aprovação humana separada, janela operacional, backup verificado e plano de rollback aprovado; não faz parte deste plano de discovery.

## Rollback de deploy

1. Definir imediatamente `PROJECT_CENTER_V2_WORKER_ENABLED=false` para parar novas execuções.
2. Definir `PROJECT_CENTER_V2_ENABLED=false` para remover a superfície v2.
3. Preservar operation store, outbox, leases, audit e bindings do broker para investigação/reconciliação.
4. Não remover automaticamente database, role, volume, stack, backup ou secret criado. Recursos usam o fluxo `rollback/dry-run → rollback/approval → rollback/execute` com novo hash e aprovação.
5. Operação sem ownership/drift comprovado termina em `manual_intervention_required`.
6. Revalidar o fluxo legado e health antes de encerrar a janela.

## Definição final de pronto

- Os sete PRs foram revisados e integrados na ordem definida.
- `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false` continuam sendo o default.
- OpenAPI, refs, docs, formatação, lint scoped, testes, build e secret scan estão verdes.
- Dois projetos efêmeros por driver provam isolamento cruzado, idempotência, backup/restore e rollback seguro.
- Nenhuma credencial, path absoluto, shell/SQL livre ou side effect não aprovado foi observado.
- QA e Security emitiram GO explícito; qualquer ativação de produção permanece uma decisão operacional separada.
