# PRD — Project Center v2

Status: proposta para aprovação no Gate 2

Owner de produto: Luna / JE4NDEV

Responsável pelo PRD: Gerente
Issues: [raiz #2](https://github.com/JE4NVRG/je4ndev-platform-core/issues/2) · [discovery #3](https://github.com/JE4NVRG/je4ndev-platform-core/issues/3)

## 1. Resumo executivo

O Project Center v2 será o control plane auditável para criar e operar infraestrutura isolada por projeto sem entregar credenciais administrativas ou execução direta a agentes. O produto substitui o comportamento atual de “novo projeto” em `/supabase`, que cria somente um schema dentro da stack Supabase principal e, portanto, compartilha Auth, Storage, JWT, roles estruturais, API, processo PostgreSQL e blast radius de backup e restore.

A v2 oferece dois modos autorizados:

1. `postgresql_isolated`, padrão para novos projetos: database e role app exclusivos no PostgreSQL 16 local, secret externo ao repositório, backup e restore test por projeto;
2. `supabase_isolated`, exceção justificada para projetos que precisam de Auth, Storage, Realtime ou PostgREST integrados: stack Compose completa, rede, Postgres, data path, credenciais, domínio, backup e monitoramento exclusivos.

`schema_shared` deixa de ser opção de criação para clientes e produtos novos. Ele permanece apenas como classificação de legado/interno e como origem de migrações individuais, sem expansão automática de permissões.

Toda mutação segue obrigatoriamente o ciclo:

```text
dry-run → aprovação explícita → execução → verificação → encerramento
                                      └→ falha → rollback/reconciliação → verificação
```

O lançamento só avança quando os Gates 2 a 6 têm evidência objetiva e decisão registrada de GO. A aprovação de um gate nunca substitui os gates de operação para efeitos reais.

## 2. Contexto e evidência do problema

A implementação atual:

- recebe `slug`, nome, ambiente, schema e confirmação `CRIAR <slug>`;
- executa `CREATE SCHEMA` na database `postgres` da stack Supabase principal;
- registra projeto, schema, perfis de agentes e risco em `platform_registry`;
- apresenta o schema como “projeto Supabase” na UI.

Essa separação é lógica, não infraestrutural. Um incidente em Auth, Storage, JWT/service-role, PostgREST, Postgres, backup ou restore da stack principal pode alcançar múltiplos projetos. A confirmação textual atual reduz acionamento acidental, mas não implementa dry-run, aprovação segregada, idempotência de uma operação completa, verificação de isolamento ou rollback orquestrado.

A auditoria de 2026-08-11 encontrou na stack principal os schemas `autocortes`, `gestao_ml`, `nexpanel`, `renderia`, `renderia_test`, `stop`, `web3scan` e um schema de smoke, com grants compartilhados para `anon`, `authenticated` e `service_role`. A stack Máximo, com Compose, rede, Postgres, data path, configuração e backups separados, é a referência de isolamento forte para o modo `supabase_isolated`.

### 2.1 Problemas a resolver

1. “Projeto” significa hoje schema, não unidade isolada de operação e recuperação.
2. Novos clientes podem herdar blast radius e credenciais estruturais compartilhadas.
3. A criação atual combina intenção e execução, sem plano imutável revisável.
4. Não existe prova automatizada de que a identidade do projeto A é negada no projeto B.
5. Falhas intermediárias não têm estado de reconciliação e rollback padronizado.
6. Backups e restore tests não são rastreados por projeto.
7. Agentes precisam de contexto e contratos, mas não podem receber senhas ou acesso administrativo.
8. Legados compartilhados precisam migrar sem big bang e sem presumir compatibilidade entre projetos.

## 3. Visão e princípios

### 3.1 Visão

Permitir que Luna/Jean provisionem uma unidade de projeto reproduzível, isolada, verificável e recuperável pelo Workspace, enquanto agentes trabalham apenas com metadados, contratos, URLs mascaradas e propostas versionadas.

### 3.2 Princípios invioláveis

- Git e specs versionadas são a fonte da verdade do produto.
- O Project Center é o único executor autorizado do fluxo de provisionamento.
- Agente avulso não cria database, role, stack, secret, domínio ou regra de rede.
- Segredo real nunca entra em prompt, repositório, Kanban, resposta de API ou log.
- `postgresql_isolated` é o default; exceções exigem decisão documentada.
- `schema_shared` é proibido para clientes e produtos novos.
- Toda operação real nasce de um dry-run e exige aprovação explícita e vigente.
- Quem propõe não autoaprova a própria operação quando houver efeito real.
- A aprovação vincula-se ao hash do plano; qualquer alteração invalida a aprovação.
- A identidade interna de projeto é um UUID imutável; `client_id`, `project_slug`, nome e aliases são metadados mutáveis e não podem ser reutilizados como prova de ownership.
- Secret material é endereçado internamente pelo UUID e nunca exposto; API, UI, auditoria e handoffs recebem somente `secret_ref` opaca, sem path absoluto ou valor.
- Toda mutação recebe `Idempotency-Key` gerada e persistida pelo cliente/SDK antes da primeira tentativa; repetição equivalente não duplica recursos nem efeitos.
- A porta PostgreSQL `5432` permanece restrita a `127.0.0.1`; nunca é exposta publicamente.
- Falha nunca é escondida como sucesso parcial: gera rollback ou estado reconciliável auditável.
- Backup sem restore test válido não conta como capacidade de recuperação.

## 4. Objetivos e resultados

### 4.1 Objetivos

- Criar projetos novos com isolamento adequado à capacidade solicitada.
- Tornar plano, aprovação, execução, verificação e rollback rastreáveis ponta a ponta.
- Impedir vazamento de credenciais e privilégios administrativos para agentes.
- Provar isolamento cruzado antes de liberar um projeto.
- Garantir backup e restore test independentes por projeto.
- Catalogar legados compartilhados e migrá-los individualmente, com rollback próprio.
- Mostrar na UI modo, custo de recursos, estado, artefatos, auditoria, bloqueios e ações irreversíveis.

### 4.2 Resultados não negociáveis

- Nenhum cliente/produto novo é criado em `schema_shared`.
- Nenhuma operação fica `succeeded` sem verificação completa.
- Nenhuma execução ocorre sem dry-run aprovado para o mesmo hash.
- Nenhuma resposta ou evento auditável contém secret real.
- Nenhum projeto é considerado recuperável sem restore test recente e identificado.

## 5. Personas e responsabilidades

| Persona                    | Necessidade                                  | Pode                                                                                  | Não pode                                                                  |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Jean (sponsor/admin)       | Decidir risco, custo e efeitos irreversíveis | atuar como `project_approver` quando autorizado; decidir exceções e go-live           | receber senha em UI/log; contornar segregação ou evidências do Gate 6     |
| Luna (control-plane owner) | Orquestrar ciclo e gates                     | atuar como `project_operator`, `project_reader` ou `project_approver`, conforme token | autoaprovar produção; executar plano alterado; expor secret               |
| Gerente                    | Governança, status e risco                   | atuar como `project_reader` e acompanhar KPIs, gates, dependências e migrações        | executar DDL, gerenciar secret ou autoatestar segurança                   |
| Dev/Builder                | Entregar código e migrations                 | propor manifestos, migrations, contratos e rollback em Git                            | aplicar produção, criar role/database ou ler credencial real              |
| Security                   | Least privilege e análise de ameaça          | atuar como `project_auditor`; revisar política, exposição e provas negativas          | aprovar sem evidência; operar com segredo em prompt                       |
| QA                         | Prova funcional e de isolamento              | atuar como `project_reader`/`project_auditor` e registrar evidência                   | marcar GO com teste omitido ou mock                                       |
| Worker do Project Center   | Execução controlada                          | atuar internamente como `platform_worker` e consumir somente fila aprovada            | expor operação HTTP pública; alterar escopo durante a execução            |
| Agente externo             | Consumir contexto do projeto                 | ler contexto sanitizado somente quando autorizado com `project:read`                  | obter admin DSN, JWT secret, env real ou acesso ao banco de outro projeto |

### 5.1 Segregação mínima de deveres

- Proponente: solicita dry-run.
- Aprovador: Jean, Luna ou identidade administrativa explicitamente autorizada.
- Executor: serviço do Project Center; nunca o browser ou o agente diretamente.
- Verificador: automação + QA/Security conforme o gate.
- Para produção ou ação destrutiva, proponente e aprovador devem ser identidades distintas.

### 5.2 Matriz RBAC canônica

O OpenAPI `specs/contracts/project-center-v2.openapi.yaml`, no branch `project-center-v2/spec`, é a única fonte canônica para `x-rbac-policy`, `x-required-scopes`, ambientes e segregação. A tabela abaixo é somente sua projeção humana; aliases de role ou scope são proibidos.

| Role canônica      | Scopes canônicos                                                        | Operações HTTP (`operationId`)                                                                                                      | Ambientes                        |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `project_reader`   | `project:read`                                                          | `getProjectOperation`                                                                                                               | development, staging, production |
| `project_operator` | `project:plan`, `project:execute`, `project:verify`, `project:rollback` | `createProjectDryRun`, `executeProjectOperation`, `verifyProjectOperation`, `createProjectRollbackDryRun`, `executeProjectRollback` | development, staging, production |
| `project_approver` | `project:approve`                                                       | `decideProjectOperationApproval`, `decideProjectRollbackApproval`                                                                   | development, staging, production |
| `project_auditor`  | `project:audit`                                                         | `listProjectOperationAudit`                                                                                                         | development, staging, production |
| `platform_worker`  | `project:worker`                                                        | nenhuma operação HTTP pública; consumo interno da fila aprovada                                                                     | development, staging, production |

O default é `deny`. Em produção, o aprovador é humano, difere do solicitante e token de agente nunca aprova. Em rollback destrutivo, o aprovador também difere do solicitante da operação original, e a decisão fica vinculada ao `rollback_plan_hash`.

## 6. Modos de isolamento

### 6.1 `postgresql_isolated` — padrão

Indicado quando o produto precisa de PostgreSQL e módulos de aplicação independentes, sem exigir o conjunto integrado Supabase.

Artefatos mínimos planejados:

- database exclusiva `je4ndev_<cliente>_<projeto>`;
- role `je4ndev_<cliente>_<projeto>_app` exclusiva;
- role sem `SUPERUSER`, `CREATEDB`, `CREATEROLE` ou `BYPASSRLS`;
- connect/grants limitados à database e aos schemas autorizados;
- secret em storage interno seguro, endereçado pelo UUID imutável do projeto e com modo `0600` quando materializado; path absoluto nunca integra contrato, UI, auditoria ou handoff;
- `secret_ref` opaca como único identificador retornável do secret, sem codificar slug, path ou valor;
- URL mascarada e schema exportado para agentes;
- prefixo de backup local/R2 e política de retenção próprios;
- restore test identificado por projeto;
- audit trail da criação e das verificações.

Capacidades de Auth, Storage e Realtime devem ser módulos de aplicação e contratos explícitos. A necessidade futura de full Supabase não autoriza conversão silenciosa; exige ADR e novo plano.

### 6.2 `supabase_isolated` — exceção justificada

Indicado somente quando requisitos aprovados dependem de Auth, Storage, Realtime ou PostgREST integrados e o custo operacional da stack dedicada é aceito.

Artefatos mínimos planejados:

- Compose project exclusivo;
- rede exclusiva e portas sem colisão;
- processo/serviço PostgreSQL e data path/volume exclusivos;
- JWT, keys e credenciais exclusivos;
- config e env exclusivos, fora do repositório;
- domínio/rotas de proxy exclusivos e sujeitos a gate próprio;
- backup, prefixo R2, restore test e monitoramento exclusivos;
- health checks e inventário de versões;
- prova de que credenciais, rede e APIs de A não acessam B.

O modo deve exibir estimativa de CPU, memória, disco, operação e superfície de atualização antes da aprovação.

### 6.3 `schema_shared` — legado/interno bloqueado

- Não aparece como opção habilitada no wizard de cliente/produto novo.
- API rejeita criação nova com código de política estável, independentemente da UI.
- Não pode ser habilitado por feature flag comum, parâmetro oculto ou identidade de agente.
- Registros existentes são classificados `legacy_shared`, com banner de risco e ações limitadas a leitura de metadados, inventário, plano de migração e controles emergenciais autorizados.
- Exceção interna temporária exige ADR, prazo de expiração, owner, justificativa, Security e aprovação explícita de Jean; não pode hospedar cliente novo.

### 6.4 Matriz de decisão

| Critério                         | `postgresql_isolated`                                     | `supabase_isolated` |
| -------------------------------- | --------------------------------------------------------- | ------------------- |
| Padrão para projeto novo         | sim                                                       | não                 |
| Database/role exclusivas         | sim                                                       | sim                 |
| Processo Postgres exclusivo      | não, instância local compartilhada com databases isoladas | sim                 |
| Auth/Storage/Realtime integrados | módulos separados, se necessários                         | sim                 |
| Blast radius de stack            | menor no dado/role; processo ainda compartilhado          | dedicado            |
| Custo operacional                | menor                                                     | maior               |
| Aprovação de exceção/ADR         | só para desvios                                           | obrigatória         |

### 6.5 Identidade imutável e referências externas

- `project_uuid` é gerado uma única vez pelo registry, não é aceito como escolha do cliente e é a chave interna de ownership, secrets, recursos, backup, restore e auditoria.
- O `project_id` do contrato é o identificador público/scoped determinístico criado como `<client_id>-<project_slug>` na reserva inicial. Ele resolve para `project_uuid`, não é prova de ownership, não é recalculado após rename e nunca pode ser atribuído a outro UUID.
- `project_slug`, display name e aliases podem mudar com histórico e prevenção de reutilização; a mudança não altera UUID, ownership, backup namespace ou vínculo de secrets.
- `secret_ref` é um identificador opaco emitido pelo broker e resolvido apenas no executor autorizado. Clientes não a constroem a partir de UUID, `project_id`, slug ou path, e seu valor não revela a topologia do host.

## 7. Jornada e ciclo obrigatório de operação

### 7.1 Estados canônicos

O enum e a tabela de transições em `components.schemas.OperationState` do OpenAPI canônico são a fonte da verdade. PRD e UX apenas projetam esses identificadores e não definem aliases semânticos.

```text
planned → awaiting_approval
awaiting_approval → approved | rejected | expired | cancelled
approved → queued | expired | cancelled
queued → executing | approved
executing → verifying | failed | rollback_pending | manual_intervention_required
verifying → succeeded | rollback_pending | manual_intervention_required
succeeded → rollback_pending
failed → queued | rollback_pending
rollback_pending → rolling_back
rolling_back → rolled_back | manual_intervention_required
```

`rolled_back`, `manual_intervention_required`, `rejected`, `expired` e `cancelled` são terminais. Qualquer transição não listada retorna `INVALID_STATE_TRANSITION`. Cada transição registra actor, timestamp, motivo, `operation_id`, hash da `Idempotency-Key`, hash do plano e referências de evidência. Eventos não carregam chaves brutas nem secrets.

### 7.2 Etapa 1 — Dry-run

Entrada mínima:

- `client_id`, `project_slug`, nome de exibição e ambiente; o registry resolve ou cria uma identidade interna UUID imutável, separada desses metadados;
- modo solicitado e capacidades necessárias;
- classificação de dados;
- estimativa de recursos;
- política de backup/restore;
- header `Idempotency-Key` gerado e persistido pelo cliente/SDK antes da primeira tentativa;
- referências Git para manifesto, migrations e rollback aplicáveis.

Saída mínima:

- plano ordenado de operações e dependências;
- nomes/identificadores de recursos, sempre sem secret;
- diff entre estado observado e desejado;
- efeitos reversíveis, compensáveis e irreversíveis destacados;
- verificações e provas negativas que serão executadas;
- plano de rollback/reconciliação por etapa;
- custo estimado e riscos;
- hash imutável do plano e validade temporal;
- blockers/NO-GO encontrados.

Dry-run não pode executar DDL, criar role/database/volume, escrever secret, alterar rede/DNS/proxy ou tocar produção.

### 7.3 Etapa 2 — Aprovação

- A UI mostra integralmente o plano sanitizado, riscos, custo e rollback.
- O aprovador confirma o `operation_id` e o hash do plano, não apenas o slug.
- `approve` e `reject` são ramos distintos de `ApprovalRequest`, discriminados por `decision`: aprovação exige `plan_hash` e frase `APROVAR <project_id> <prefixo-do-hash>`; rejeição exige `reason` e não aceita confirmação semanticamente falsa.
- Ações destrutivas usam confirmação forte específica ao efeito.
- Aprovação expira; execução após expiração é rejeitada.
- Alteração de input, manifesto ou estado que mude o plano exige novo dry-run.
- Rejeição registra motivo e não produz efeito real.

### 7.4 Etapa 3 — Execução

- O serviço busca o plano aprovado e valida hash, prazo, identidade e idempotência.
- Cada passo grava status sanitizado e marcador de compensação.
- O cliente/SDK reutiliza a mesma `Idempotency-Key` após timeout; o servidor persiste somente seu hash por 24 horas, vinculado a ator, método, template de rota e hash canônico do payload.
- Mesma chave e payload retornam a operação original com `Idempotency-Replayed: true`; mesma chave com payload diferente retorna `409 IDEMPOTENCY_KEY_REUSED`.
- Um lock por projeto impede operações mutáveis concorrentes incompatíveis.
- O executor para no primeiro erro não tolerado e aciona rollback ou reconciliação.

### 7.5 Etapa 4 — Verificação

Uma operação só fica `succeeded` após, no mínimo:

- inventário observado corresponde ao plano aprovado;
- role app não possui atributos administrativos;
- role/database/stack A é negada ao tentar acessar B;
- agentes recebem apenas contexto mascarado e contratos autorizados;
- logs e respostas passam por teste de ausência de secrets;
- backup foi gerado sob namespace do projeto;
- restore test do projeto passou em alvo isolado;
- health checks/capacidades do modo passaram;
- evidências têm timestamp, executor, resultado e referência reproduzível.

Falha de verificação impede `succeeded`, ainda que a execução técnica tenha terminado.

### 7.6 Etapa 5 — Rollback e intervenção manual

- Rollback é uma operação tipada própria: `rollback/dry-run` observa ownership e drift e produz compensações, `rollback_plan_hash`, revisão observada, expiração e classificação destrutiva sem executar efeitos.
- `RollbackApprovalRequest` usa `oneOf` discriminado por `decision`: aprovação exige `rollback_plan_hash` e frase `APROVAR ROLLBACK <project_id> <prefixo-do-hash>`; rejeição exige somente motivo.
- Aprovação de rollback é independente da aprovação de provisionamento. Em produção ou rollback destrutivo, o aprovador humano difere do solicitante do rollback e do solicitante da operação original.
- `rollback/execute` exige `rollback_plan_hash` e `approval_id` e revalida expiração, ownership, drift, política e segregação antes de adquirir o lease.
- Artefato com dado pode ser colocado em quarentena antes de remoção; não se presume que `DROP` seja seguro. Alteração de plano ou revisão observada invalida a aprovação e exige novo dry-run.
- Se a segurança para continuar ou compensar não puder ser provada, o estado vira `manual_intervention_required`, terminal, com novas mutações bloqueadas, owner e runbook.
- Depois do rollback, provas negativas e inventário são executados novamente. `rolled_back` significa estado verificado, não apenas comando de compensação enviado.
- Credenciais potencialmente materializadas durante falha são rotacionadas/revogadas por mecanismo seguro, sem serem exibidas.

## 8. Requisitos funcionais

| ID    | Requisito                                                                                                       | Prioridade |
| ----- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| RF-01 | Wizard cria somente `postgresql_isolated` ou `supabase_isolated` para novos clientes/produtos.                  | P0         |
| RF-02 | Backend rejeita `schema_shared` novo mesmo se a requisição contornar a UI.                                      | P0         |
| RF-03 | Toda criação real exige dry-run persistido, aprovado, não expirado e com hash válido.                           | P0         |
| RF-04 | Dry-run é livre de efeitos reais e produz diff, custo, riscos, verificações e rollback.                         | P0         |
| RF-05 | Toda mutação exige `Idempotency-Key` client-owned; replay equivalente não duplica recursos.                     | P0         |
| RF-06 | Aprovação/rejeição usam ramos discriminados e registram identidade, hash, prazo, escopo e decisão.              | P0         |
| RF-07 | Executor aplica lock por projeto e impede concorrência incompatível.                                            | P0         |
| RF-08 | Estado parcial dispara rollback seguro ou `manual_intervention_required` terminal e bloqueante.                 | P0         |
| RF-09 | Verificação inclui teste cruzado A→B e B→A com resultado negado.                                                | P0         |
| RF-10 | Nenhuma API, UI, log, evento ou handoff retorna secret real.                                                    | P0         |
| RF-11 | `postgresql_isolated` planeja database, role least-privilege, env externo e backup/restore próprios.            | P0         |
| RF-12 | `supabase_isolated` planeja stack, rede, Postgres/data path, keys, domínio, backup e monitoramento exclusivos.  | P0         |
| RF-13 | UI mostra modo, ambiente, custo, estado, artefatos, riscos, auditoria e ações irreversíveis.                    | P1         |
| RF-14 | Agentes acessam manifesto, schema exportado, contratos e URL mascarada por token scoped.                        | P1         |
| RF-15 | Registry distingue `legacy_shared`, `postgresql_isolated` e `supabase_isolated`.                                | P0         |
| RF-16 | Cada legado tem inventário e operação de migração independentes.                                                | P0         |
| RF-17 | Dashboard exibe idade do último backup e restore test por projeto.                                              | P1         |
| RF-18 | Audit trail é pesquisável por projeto, operação, ator, estado e período.                                        | P1         |
| RF-19 | Rollback tem dry-run, hash e aprovação próprios; efeitos destrutivos exigem confirmação e segregação reforçada. | P0         |
| RF-20 | O sistema exporta pacote de evidências do gate sem dados sensíveis.                                             | P1         |
| RF-21 | Registry usa UUID imutável para identidade/ownership; slug, nome e aliases são metadados mutáveis.              | P0         |
| RF-22 | API/UI/auditoria retornam somente `secret_ref` opaca e nunca path absoluto ou valor de secret.                  | P0         |

## 9. Requisitos não funcionais

### 9.1 Segurança

- Deny-by-default para criação, execução e leitura de metadados sensíveis.
- Tokens scoped e de curta duração onde aplicável.
- Criptografia em trânsito nas superfícies de rede autorizadas.
- Secret persistido somente no local seguro definido e com permissão `0600`.
- Redação testável de DSNs, senhas, JWTs, keys e valores de env.
- Nenhum caminho de API aceita comandos SQL, shell ou Compose arbitrários fornecidos pelo usuário/agente.
- Porta `5432` não é aberta publicamente.

### 9.2 Confiabilidade e consistência

- State machine persistida e retomável após reinício do Workspace/executor.
- Idempotência cobre retries HTTP, reinício de worker e timeout do cliente.
- Estado desejado e observado são reconciliados antes e depois da mutação.
- Eventos de auditoria são append-only na superfície de aplicação.

### 9.3 Operabilidade

- Alertas para operação parada, aprovação expirada, rollback falho, backup vencido e restore test vencido.
- Runbooks versionados para falhas por etapa.
- Métricas não incluem labels com secrets ou cardinalidade ilimitada.
- Modo `supabase_isolated` expõe versão e health de cada serviço sem credencial.

### 9.4 Desempenho inicial

- p95 do dry-run sem chamadas longas de infraestrutura: até 10 segundos.
- p95 de leitura da lista/detalhe de projetos: até 2 segundos sob carga operacional normal.
- Atualização de estado visível na UI: até 5 segundos após evento persistido.
- Tempos de criação e restore são medidos por modo; não são mascarados por timeout de UI.

## 10. Escopo

### 10.1 MVP de implementação

- Modelo de domínio, state machine e audit trail.
- API/serviço de dry-run, aprovação, execução, verificação e rollback/reconciliação.
- `postgresql_isolated` completo com provas negativas, backup e restore test.
- Contrato e executor inicial de `supabase_isolated` apenas após capacidade e segurança aprovadas.
- Wizard e telas de detalhe/atividade/risco.
- Bloqueio de `schema_shared` em UI e backend.
- Inventário dos legados e suporte a planos individuais de migração.
- Pacote de contexto mascarado para agentes.
- Métricas, alertas e exportação de evidências.

### 10.2 Não-escopo da discovery/spec

- Criar ou remover database/role real.
- Criar stack Supabase real.
- Alterar secrets, Docker, Nginx, DNS, Cloudflare, systemd ou produção.
- Migrar imediatamente Renderia, Gestão ML, Nexpanel, Stop ou qualquer outro legado.
- Desligar stacks Supabase existentes.
- Abrir a porta `5432` ou permitir acesso externo direto ao PostgreSQL.

### 10.3 Não-escopo do MVP

- Clone genérico do Supabase Studio.
- Migração big bang de todos os legados.
- Marketplace de templates de infraestrutura.
- Provisionamento multi-cloud genérico.
- Autoscaling autônomo de stacks Supabase.
- Entrega de credenciais administrativas a agentes.
- Execução de SQL/commands arbitrários pela UI.

## 11. Estratégia de migração dos legados

Cada schema compartilhado é um projeto de migração independente. Ordem, janela e estratégia são decididas por risco e dependências, nunca por uma transformação global.

### 11.1 Fases por legado

1. **Inventário**: owner, tabelas, funções, extensões, RLS, grants, buckets, Auth, jobs, integrações, volume e criticidade.
2. **Classificação**: decidir `postgresql_isolated` ou `supabase_isolated` com ADR quando necessário.
3. **Contrato**: congelar schema exportado, APIs, eventos, identities e SLOs observados.
4. **Plano**: dry-run de destino, cópia, validação, cutover, rollback e janela.
5. **Ensaio**: restaurar/copiá-lo em ambiente isolado e executar testes funcionais, segurança e reconciliação de contagens/checksums.
6. **Aprovação**: revisar impacto, downtime, RPO/RTO, evidências e rollback.
7. **Migração individual**: executar sob lock e audit trail próprios.
8. **Verificação**: provar integridade, isolamento, aplicações conectadas e ausência de acesso cruzado.
9. **Cutover reversível**: manter origem protegida em modo definido pelo plano durante janela de observação.
10. **Encerramento**: remover dependência apenas após GO específico e política de retenção; nenhuma deleção implícita.

### 11.2 Regras de migração

- Um legado com NO-GO não bloqueia nem é acoplado à migração de outro.
- A origem não recebe novos grants amplos para facilitar migração.
- Toda transformação de dados é versionada, reproduzível e validada.
- Cutover e rollback têm responsáveis, janela, gatilhos e tempos máximos definidos.
- O estado `legacy_shared` permanece visível até verificação final e encerramento aprovado.
- Dependências cross-schema precisam ser eliminadas, encapsuladas ou explicitamente tratadas antes do GO.

## 12. KPIs e metas

As metas abaixo valem após a fase de estabilização do MVP; a baseline é coletada no Gate 5.

| KPI                                                              |                                                            Meta | Janela/fonte                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------: | ----------------------------------- |
| Novos clientes/produtos criados em `schema_shared`               |                                                               0 | contínuo; registry/audit trail      |
| Operações reais originadas de dry-run aprovado com hash válido   |                                                            100% | mensal; audit trail                 |
| Retries que duplicam recurso                                     |                                                               0 | contínuo; reconciliação/inventário  |
| Operações `succeeded` com prova cruzada A/B aprovada             |                                                            100% | por criação/migração                |
| Respostas/logs com secret real                                   |                                                               0 | contínuo; scanners/testes negativos |
| Projetos com backup dentro da política                           |                                                           ≥ 99% | diário                              |
| Projetos com restore test válido                                 | 100% antes de `succeeded`; ≥ 95% dentro da periodicidade depois | diário/mensal                       |
| Rollbacks automáticos seguros concluídos dentro do runbook       |                                                           ≥ 95% | trimestral                          |
| Operações `manual_intervention_required` sem owner/SLA           |                                                               0 | contínuo                            |
| Lead time mediano `planned`→`succeeded` em `postgresql_isolated` |                               ≤ 30 min, excluindo espera humana | mensal                              |
| Aprovações executadas após expiração ou com hash divergente      |                                                               0 | contínuo                            |
| Legados com inventário e owner definidos                         |                                 100% antes da primeira migração | programa de migração                |

### 12.1 Guardrails

A meta de velocidade nunca autoriza reduzir os KPIs de isolamento, secrets, idempotência, backup/restore ou gates. Se segurança e throughput conflitarem, o fluxo entra em NO-GO até correção.

## 13. Riscos e mitigação

| ID   | Risco                                                                     | Impacto/probabilidade | Mitigação                                                                                | NO-GO associado                                |
| ---- | ------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| R-01 | “Database isolada” ainda compartilhar processo e blast radius operacional | alto/médio            | comunicar limite; oferecer `supabase_isolated` quando requisito exigir processo dedicado | promessa de isolamento incompatível com o modo |
| R-02 | Escape de privilégio da role app                                          | crítico/médio         | allowlist de grants, inspeção de atributos e testes cruzados negativos                   | qualquer atributo/admin ou acesso A→B          |
| R-03 | Secret em API, log, UI, Git ou Kanban                                     | crítico/médio         | vault/arquivo externo 0600, redação central e scanners                                   | qualquer secret detectado                      |
| R-04 | Retry cria database, role, volume ou stack duplicada                      | alto/médio            | `Idempotency-Key` client-owned, hash, locks e observação                                 | teste de retry falha                           |
| R-05 | Aprovação aplicada a plano diferente                                      | crítico/baixo         | hash imutável, expiração e re-dry-run                                                    | hash/estado divergente                         |
| R-06 | Falha parcial deixa recurso órfão ou inseguro                             | alto/médio            | rollback com plano/hash próprios, quarantine e `manual_intervention_required`            | ausência de rollback/runbook/owner             |
| R-07 | Backup existe, mas restore não funciona                                   | crítico/médio         | restore test obrigatório e periódico                                                     | restore test falha/ausente                     |
| R-08 | Stack Supabase dedicada excede capacidade da VPS                          | alto/médio            | capacity plan, limites e fase piloto                                                     | headroom abaixo do aprovado                    |
| R-09 | Migração quebra integração ou perde dados                                 | crítico/médio         | ensaio, checksums/contagens, dual validation e cutover reversível                        | divergência não explicada                      |
| R-10 | Dependência cross-schema impede isolamento                                | alto/alto             | inventário individual e desacoplamento antes do cutover                                  | dependência de escrita não resolvida           |
| R-11 | UI bloqueia opção, mas API ainda aceita `schema_shared`                   | crítico/médio         | policy enforcement no domínio/backend + teste negativo                                   | endpoint aceita modo proibido                  |
| R-12 | Auditoria pode ser alterada ou não correlaciona etapas                    | alto/baixo            | eventos append-only, IDs e referências de evidência                                      | cadeia incompleta                              |
| R-13 | Operador contorna segregação de deveres                                   | crítico/baixo         | RBAC, policy-as-code e teste de autoaprovação                                            | proponente autoaprova produção/destrutivo      |
| R-14 | Rollback destrutivo apaga dado válido                                     | crítico/baixo         | dry-run, `rollback_plan_hash`, ownership/drift, quarantine e aprovação segregada         | compensação sem proteção de dado               |

## 14. Gates de produto — Fases 2 a 6

Regra comum: GO exige todos os itens obrigatórios aprovados e evidência vinculada. Um único item P0 ausente ou falho determina NO-GO. “Parcialmente pronto” não promove fase.

### Gate 2 — PRD e Constitution

**Evidências obrigatórias**

- PRD aprovado com personas, problema, modos, escopo/não-escopo, KPIs, riscos e migração individual.
- Constituição e PRD coerentes sobre database por projeto, role dedicada, secrets e `5432` local.
- `schema_shared` explicitamente proibido para cliente/produto novo.
- Fluxo e estados canônicos `planned`→aprovação→execução→verificação→rollback definidos sem aliases.
- UUID interno imutável e `secret_ref` opaca definidos, sem path absoluto em superfície externa.
- Owner de produto, aprovadores e segregação de deveres definidos.

**GO**: 100% das evidências presentes, sem contradição P0 e com decisão registrada por Luna/Jean.

**NO-GO**: modo ambíguo, schema compartilhado permitido, segredo entregue a agente, ausência de rollback/verificação ou conflito com a Constitution.

### Gate 3 — Specs e contratos

**Evidências obrigatórias**

- ADR de seleção dos modos e limites de isolamento.
- Threat model com boundaries, ativos, atores, abuso, mitigação e NO-GO.
- OpenAPI validável para dry-run, aprovação, execução/status, verificação e rollback/reconciliação.
- Schemas compartilhados de domínio para modos, estados, operação, plano, evidência e erro.
- Semântica client-owned de `Idempotency-Key`, locks, hash, expiração e concorrência definida.
- Política de secrets/redação e RBAC testável.
- UX especificada para todos os estados, loading, vazio, erro, expiração e ação irreversível.

**GO**: contratos passam validação automatizada; links/paths resolvem; Security, Dev e QA não registram inconsistência bloqueante.

**NO-GO**: endpoint mutável sem idempotência/aprovação, comando arbitrário, resposta com secret, estado sem transição segura ou divergência entre OpenAPI, tipos e UX.

### Gate 4 — Plano técnico e ADRs

**Evidências obrigatórias**

- Plano em PRs atômicos, com dependências e owners.
- Plano de rollout por capability e rollback da própria feature.
- Runbooks de falha parcial, reconciliação, backup e restore.
- Capacity plan para o piloto `supabase_isolated`.
- Plano de observabilidade, alertas, retenção de auditoria e KPIs.
- Estratégia de testes reais sem tocar produção durante desenvolvimento.
- Plano individual para cada legado candidato; sem big bang.

**GO**: sequência implementável, reversível, com ambiente de teste, critérios por PR e recursos disponíveis.

**NO-GO**: mudança direta em produção, migração acoplada de legados, ausência de capacity/rollback, dependência não resolvida ou plano que exige secret em Git/prompt.

### Gate 5 — Implementação

**Evidências obrigatórias**

- Backend bloqueia `schema_shared` e todas as mutações sem plano aprovado.
- State machine, hash, expiração, idempotência, locks e audit trail implementados.
- Executor não aceita SQL/shell/Compose arbitrários.
- UI representa estados, riscos, custos, evidências e ações irreversíveis.
- Testes unitários, integração e contrato aprovados.
- Scanner de secrets e testes de redação aprovados.
- Rollback com dry-run/hash/aprovação próprios e intervenção manual exercitados em falhas injetadas.
- Build, lint, types/checks e testes do repositório verdes.

**GO**: 100% dos requisitos P0 implementados; zero falha crítica/alta aberta; pipelines e demonstração em ambiente autorizado verdes.

**NO-GO**: bypass de gate, duplicação em retry, secret exposto, estado parcial sem reconciliação, comando arbitrário ou regressão crítica/alta.

### Gate 6 — QA e Security

**Evidências obrigatórias**

- Dois projetos reais de teste isolados no ambiente autorizado.
- Role/identidade A não conecta, lê ou escreve B; e B não acessa A.
- Mesma `Idempotency-Key` client-owned repetida não duplica nenhum recurso.
- Mesma chave com payload divergente retorna conflito seguro.
- Aprovação expirada, hash divergente e autoaprovação proibida são rejeitados.
- Respostas, UI, logs, auditoria e handoffs não contêm credencial real.
- Falhas em cada etapa crítica terminam em rollback verificado ou reconciliação bloqueante.
- Backup e restore test por projeto passam com evidência.
- Testes funcionais, regressão, UX, acessibilidade, performance e segurança passam.
- Security e QA emitem parecer independente com severidade e evidências.

**GO**: todos os testes P0 passam; zero achado crítico/alto aberto; restore e isolamento cruzado comprovados; QA e Security aprovam.

**NO-GO**: qualquer acesso cruzado, secret, duplicação, bypass de aprovação, rollback não verificável, restore falho ou achado crítico/alto aberto.

## 15. Critérios de aceite ponta a ponta

1. Ao solicitar projeto novo sem modo, o sistema seleciona `postgresql_isolated`.
2. Ao solicitar `schema_shared`, backend retorna rejeição de política e nenhum efeito ocorre.
3. Dry-run retorna plano sanitizado, hash, custo, riscos, checks e rollback sem criar recurso.
4. Execução sem aprovação, com aprovação expirada ou hash divergente é rejeitada.
5. Retry da operação com mesma chave retorna a mesma operação sem duplicação.
6. Duas operações mutáveis concorrentes para o mesmo projeto não executam simultaneamente.
7. Operação só muda para `succeeded` após todas as verificações obrigatórias.
8. Testes A→B e B→A falham com acesso negado.
9. Agente obtém contexto útil e URL mascarada, mas nenhuma credencial real.
10. Falha intermediária resulta em `rolled_back` verificado ou `manual_intervention_required` terminal com lock, owner e runbook.
11. Backup e restore test são atribuídos somente ao projeto correto.
12. Cada legado possui inventário, modo de destino, ensaio, cutover e rollback independentes.

## 16. Rollout proposto

1. **Foundation**: domínio, contratos, audit trail e bloqueio de novo `schema_shared`, ainda sem executor real.
2. **Safe orchestration**: dry-run, approval, state machine, idempotência e simulação determinística.
3. **PostgreSQL pilot**: `postgresql_isolated` em ambiente de teste autorizado, com dois projetos e provas cruzadas.
4. **Recovery**: backup/restore por projeto, falhas injetadas e reconciliação.
5. **Supabase pilot**: uma stack isolada de teste após capacity e Security GO.
6. **Legacy migration program**: inventário e migrações uma a uma, ordenadas por risco.
7. **General availability**: somente após Gate 6 e observação do piloto sem P0/P1 aberto.

Nenhuma fase deste rollout autoriza alteração de produção sem aprovação operacional específica.

## 17. Dependências e decisões abertas para fases seguintes

- ADR dos limites de isolamento do PostgreSQL local e critério obrigatório para full Supabase.
- Política de validade de aprovação e periodicidade de restore test.
- Capacity threshold do modo `supabase_isolated`.
- Retenção do audit trail e das origens legadas após cutover.

Essas decisões devem ser fechadas nos Gates 3 e 4; não podem ser assumidas silenciosamente pela implementação.

## 18. Referências canônicas

- [Constitution — je4ndev Platform Core](https://github.com/JE4NVRG/je4ndev-platform-core/blob/main/CONSTITUTION.md)
- [Provisionamento de banco por projeto](https://github.com/JE4NVRG/je4ndev-platform-core/blob/main/docs/database-provisioning.md)
- [Substituição do Supabase](https://github.com/JE4NVRG/je4ndev-platform-core/blob/main/docs/supabase-replacement.md)
- [je4ndev Platform API](https://github.com/JE4NVRG/je4ndev-platform-core/blob/main/docs/je4ndev-platform-api.md)
- Contrato canônico: `specs/contracts/project-center-v2.openapi.yaml` no branch `project-center-v2/spec` (commit de baseline `0bbe2492`)
- Especificação funcional: `specs/features/project-center-v2.spec.md` no branch `project-center-v2/spec`
- ADR do control plane: `docs/adr/0001-project-center-v2-control-plane.md` no branch `project-center-v2/spec`
- Implementação atual: `src/server/supabase-registry.ts`
- UI atual: `src/screens/supabase/supabase-projects-screen.tsx`

## 19. Decisão solicitada no Gate 2

Aprovar este PRD como baseline de produto e autorizar avanço para specs, threat model, ADR, OpenAPI e UX. A aprovação não autoriza criar/remover databases, roles, secrets, stacks, redes, DNS ou qualquer mudança em produção.
