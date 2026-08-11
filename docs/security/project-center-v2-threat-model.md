# Threat model e invariantes de isolamento — Project Center v2

**Status:** discovery/spec — **NO-GO para execução real**

**Escopo:** modos `postgresql_isolated` e `supabase_isolated`

**Fora de escopo:** alterar banco, roles, secrets, Docker, Nginx, DNS, Cloudflare, systemd ou produção

**Referências:** issue raiz JE4NVRG/je4ndev-platform-core#2; issue de segurança #4; correção de segurança #14; brief `project-center-v2-20260811/ISSUE.md`; contrato canônico `specs/contracts/project-center-v2.openapi.yaml` no PR #2; `CONSTITUTION.md`; `docs/database-provisioning.md`; `docs/supabase-replacement.md`; `docs/je4ndev-platform-api.md`

O OpenAPI do PR #2 é a fonte canônica para `OperationState.x-allowed-transitions`, `x-rbac-policy`, `x-required-scopes`, endpoints, schemas e códigos de erro. Este threat model projeta esses identificadores sem criar aliases. A identidade de segurança dos recursos continua sendo o `project_uuid` imutável mantido no registro server-side; nomes derivados de `client_id`/`project_slug` são aliases operacionais, nunca a chave de ownership. A API/UI só expõe referências de secret opacas, nunca o path físico.

## 1. Veredito executivo

O Project Center v2 permanece **NO-GO para qualquer provisionamento real**. A implementação atual de `/api/supabase-registry` cria apenas um schema na stack Supabase compartilhada, executa `psql` como `postgres` por Docker e aceita qualquer sessão autenticada como autoridade suficiente. Isso não fornece isolamento de database, role, stack, backup, restore, Auth, Storage, JWT ou blast radius.

O GO futuro exige, cumulativamente:

1. autenticação fail-closed e autorização server-side por operação/projeto;
2. separação entre API e provisionador privilegiado, com uma capability curta, vinculada ao plano aprovado;
3. dry-run determinístico, aprovação explícita e execução vinculada ao hash do plano;
4. identifiers derivados de slugs canônicos e nunca interpolados a partir de texto livre;
5. role app sem atributos administrativos e bloqueada de todos os databases de outros projetos;
6. isolamento próprio de Compose/rede/data path/keys/domínio para `supabase_isolated`;
7. secrets gerados, armazenados, injetados, rotacionados e redigidos fora de prompts, Git, Kanban, UI e logs;
8. idempotência forte, lock por projeto e reconciliação segura após falha parcial;
9. backup local, prefixo R2 e restore test independentes por projeto;
10. testes negativos A × B e evidência auditável dos gates deste documento.

Nenhum checkbox, texto `CRIAR <slug>` ou confirmação somente no cliente substitui autenticação, autorização, aprovação criptograficamente vinculada ao plano e segregação de funções.

## 2. Objetivos de segurança e ativos

### 2.1 Objetivos

- Impedir leitura, escrita, conexão, restore ou administração cruzada entre projetos.
- Reduzir o blast radius de uma aplicação, credencial, stack ou backup comprometido a um único projeto.
- Impedir que agentes e usuários do Workspace obtenham credenciais reais ou poderes administrativos.
- Garantir que cada side effect corresponda exatamente a um plano revisado e aprovado.
- Tornar retries seguros, falhas parciais reconciliáveis e ações irreversíveis auditáveis.
- Manter PostgreSQL em `127.0.0.1:5432`; nunca expor a porta publicamente.

### 2.2 Ativos e classificação

| Ativo | Classificação | Impacto de comprometimento |
|---|---|---|
| Credencial do provisionador PostgreSQL/Docker/R2 | Crítica | Controle de todos os projetos |
| Senha/DSN da role app por projeto | Crítica | Dados e disponibilidade do projeto |
| JWT secrets, anon/service keys e secrets de Auth | Crítica | Falsificação de identidade e bypass de políticas |
| Dados PostgreSQL, volumes e backups | Crítica/alta | Vazamento, corrupção ou perda permanente |
| Objetos R2 e credenciais de acesso | Alta | Exfiltração ou destruição de backups |
| Plano, aprovação, idempotency key e audit trail | Alta | Execução indevida ou não repudiável |
| Manifesto do projeto e inventário de recursos | Interna | Reconhecimento e confused deputy |
| Logs, erros e respostas da API | Interna, potencialmente crítica | Vazamento indireto de secrets/topologia |

## 3. Arquitetura de segurança proposta

```text
Operador/Agente
      |
      | TLS + sessão/token scoped + CSRF/rate limit
      v
Project Center API (sem credencial admin e sem Docker socket)
      |
      | plano imutável + approval_id + plan_hash/rollback_plan_hash + capability curta
      v
Fila/IPC autenticado e allowlisted
      |
      v
Provisionador dedicado (privilégio mínimo, single-purpose)
  |              |                 |                 |
  v              v                 v                 v
PostgreSQL 16   Docker rootless    R2 por prefixo    Secret store 0600
(loopback)      (stack isolada)    + policy scoped   fora do repo
```

A API pública nunca deve executar `psql`, `docker compose`, shell ou operações R2 diretamente. O provisionador não recebe request arbitrário: recebe somente um plano validado, versionado, aprovado, dentro de uma allowlist de operações. A credencial de aprovação é single-use, expira rapidamente e está vinculada a `actor_ref`, `project_uuid`, `driver`, ao `plan_hash` ou `rollback_plan_hash` exato e ao hash da `Idempotency-Key` client-owned.

### 3.1 Trust boundaries

| Boundary | Origem → destino | Risco dominante | Controles obrigatórios |
|---|---|---|---|
| B1 | Browser/agente → API | spoofing, CSRF, BOLA, replay, payload hostil | TLS, auth fail-closed, RBAC/ABAC, `Content-Type` JSON, CSRF/origin check, limite de corpo, rate limit, schema estrito |
| B2 | API → estado do control plane | cross-project, tampering, race | project scope no servidor, constraints únicas, transação, optimistic version, audit append-only |
| B3 | API → provisionador | confused deputy, command injection, replay | processo/serviço separado, capability curta e single-use, plano assinado/hasheado, allowlist, sem shell |
| B4 | Provisionador → PostgreSQL | SQL/identifier injection, privilégio excessivo | driver parametrizado para valores, identifiers derivados/quotados, role administrativa dedicada e limitada, loopback |
| B5 | Provisionador → Docker | host takeover, traversal, colisão de Compose | rootless, socket não exposto à API, paths canônicos sob raiz fixa, project name/rede/volumes exclusivos, drop capabilities |
| B6 | Provisionador → R2 | overwrite/cross-prefix/exfiltração | credencial scoped, prefixo imutável por project UUID, SSE, checksums, object lock/versioning quando disponível |
| B7 | Provisionador → secret store/runtime | secret leak, symlink/race, permissões | criação atômica `O_CREAT|O_EXCL|O_NOFOLLOW`, diretório 0700, arquivo 0600, owner verificado, redaction |
| B8 | App A → PostgreSQL/stack B | cross-project/BOLA | database e role exclusivos, CONNECT revogado, `pg_hba`/network policy, credenciais e rede distintas |
| B9 | Backup/restore → projeto | restore cruzado, corrupção, rollback destrutivo | manifesto assinado, project UUID/mode verificados, restore em destino vazio/teste, aprovação separada |
| B10 | Logs/monitoramento → operadores/agentes | divulgação de secrets/PII | allowlist de campos, redaction estrutural, retenção e acesso mínimo, nenhum payload/env bruto |

## 4. Identidades, roles e segregação de funções

### 4.1 Roles e scopes canônicos do control plane

| Role canônica | Scopes canônicos | `operationId` canônicos | Explicitamente proibido |
|---|---|---|---|
| `project_reader` | `project:read` | `getProjectOperation` | secrets, audit privilegiado e side effects |
| `project_operator` | `project:plan`, `project:execute`, `project:verify`, `project:rollback` | `createProjectDryRun`, `executeProjectOperation`, `verifyProjectOperation`, `createProjectRollbackDryRun`, `executeProjectRollback` | aprovar a própria operação ou enviar comandos livres |
| `project_approver` | `project:approve` | `decideProjectOperationApproval`, `decideProjectRollbackApproval` | alterar plano, executar worker ou aprovar como token de agente |
| `project_auditor` | `project:audit` | `listProjectOperationAudit` | secret material ou side effects |
| `platform_worker` | `project:worker` | nenhuma operação HTTP pública; somente consumo interno | login interativo, API geral ou conteúdo arbitrário |

O mapeamento role → scope → `operationId` e cada `x-required-scopes` pertencem ao `x-rbac-policy` do OpenAPI e usam `default: deny` em todos os ambientes. Nenhum agente possui `project:approve`, credencial administrativa PostgreSQL, acesso ao Docker socket ou credencial R2 global. Em produção, o aprovador deve ser humano e diferente do solicitante. Em rollback destrutivo, também deve diferir do solicitante da operação original; a autorização é revalidada em `execute` e `rollback/execute`.

### 4.2 Role PostgreSQL da aplicação

A role `je4ndev_<cliente>_<projeto>_app` deve ser criada com:

- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`;
- `CONNECTION LIMIT` e timeouts adequados ao projeto;
- `CONNECT` somente no database do projeto;
- `USAGE` somente nos schemas allowlisted;
- grants explícitos por tabela, sequência e função; sem grants globais;
- `search_path` fixo e seguro, sem schemas graváveis por terceiros;
- nenhuma ownership de database, extensão, schema estrutural ou objetos administrativos;
- default privileges definidos pela role de migration do projeto, não por admin global;
- senha aleatória exclusiva e rotacionável, nunca reutilizada.

Separar a role app da role de migrations. A role de migrations também não pode ter `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`; seu uso é efêmero, gated e limitado ao database do projeto. O provisionador usa uma role administrativa própria, não `postgres`, e apenas com permissões necessárias à criação/revogação controlada.

## 5. Invariantes invioláveis

Cada invariante deve virar constraint, teste e evidência operacional.

### I-01 — Escopo canônico

`client_id`, `project_uuid`, alias público do projeto e `driver` vêm da autorização e do registro server-side. O cliente não pode selecionar outro tenant apenas alterando path, query, body, header, cookie ou `Idempotency-Key`. Toda consulta por alias resolve primeiro para o UUID imutável dentro do escopo autorizado.

### I-02 — Naming seguro

Slugs aceitam apenas ASCII lowercase conforme regex estrita e são normalizados uma única vez. Database, role, Compose project, network, volume, data path e prefixo R2 são derivados de um `project_uuid` imutável mais slug canônico. Renomear ou reciclar slug não altera ownership. Texto livre nunca vira identifier, path, argumento de processo ou nome R2.

### I-03 — Dry-run sem side effect

`dry_run` não abre conexão administrativa, não cria arquivo, secret, database, role, diretório, volume, rede, bucket, objeto R2, DNS ou processo. Retorna somente plano redigido, custos/riscos, precondições, `plan_hash` e expiração.

### I-04 — Aprovação vinculada

A execução aceita somente uma aprovação single-use, não expirada, emitida para o mesmo `actor_ref`/`project_uuid`/`driver`/`plan_hash`/hash de `Idempotency-Key`. Qualquer mudança no plano invalida a aprovação. Aprovação e rejeição são ramos discriminados por `decision`: `approve` exige hash e confirmação; `reject` exige motivo e nunca uma frase de aprovação. Repetição equivalente retorna o resultado anterior, não reexecuta.

### I-05 — Default deny

Ausência ou erro de configuração de senha, provider de identidade, RBAC, secret store, audit store, lock store ou política R2 bloqueia a operação. Nunca degradar para “sem auth”, “local é confiável” ou credencial global.

### I-06 — Isolamento PostgreSQL A × B

A role app A não conecta no database B e não lê/escreve objetos B. A role de migration A também não acessa B. `PUBLIC` não recebe `CONNECT`, `CREATE` ou grants que contornem esse isolamento.

### I-07 — Isolamento Supabase A × B

Cada stack possui Compose project, rede, Postgres/data path, volumes, JWT secrets, anon/service keys, Auth, Storage, Realtime, PostgREST, domínio, backup e monitoramento exclusivos. Containers A não ingressam na rede B; volumes e env files não são compartilhados.

### I-08 — Secrets não observáveis

Nenhuma resposta, UI, log, trace, erro, audit event, shell history, process argv, Git diff, PR, Kanban ou prompt contém senha, DSN real, JWT secret, service key, credencial R2 ou path físico do secret. API/UI recebem apenas `secret_ref` opaca, como `secret://projects/<project-uuid>/<purpose>`. Representações mascaradas não preservam tamanho ou prefixo útil além do necessário.

### I-09 — Filesystem confinado

Todos os paths são resolvidos sob raízes fixas por project UUID; `realpath`/openat-style confinement impede `..`, path absoluto, separator alternativo, NUL, symlink e hardlink escape. Dono e modo são verificados antes e depois da escrita.

### I-10 — Idempotência e serialização

A `Idempotency-Key` é gerada e persistida pelo cliente/SDK antes da primeira tentativa, inclusive o primeiro POST, e reutilizada após timeout. O servidor armazena somente seu hash e aplica unicidade por ator + método + route template + request hash canônico, com lock por `project_uuid`. Mesma key + mesmo payload retorna o resultado persistido; mesma key + payload diferente retorna `409 IDEMPOTENCY_KEY_REUSED`. IDs internos server-owned não substituem essa chave. Operações concorrentes incompatíveis são rejeitadas/serializadas.

### I-11 — Falha parcial reconciliável

Cada etapa tem precondição, postcondição, compensação segura e estado durável. O estado nunca avança antes da postcondição. Recursos pré-existentes nunca são apagados por compensação de uma tentativa atual.

### I-12 — Backup e restore confinados

Backup inclui manifesto com project UUID, database/stack ID, timestamp, schema/version e checksum. Restore valida o manifesto e só usa destino vazio/teste do mesmo projeto, salvo fluxo de migração aprovado separadamente. Prefixos R2 não podem ser fornecidos pelo cliente.

### I-13 — Auditoria não repudiável

Eventos registram `actor_ref`, `project_uuid`, ação, `plan_hash` ou `rollback_plan_hash`, `approval_id`, somente o hash da `Idempotency-Key`, transições canônicas, resultado redigido e correlation ID. Não registram secrets nem paths físicos. Logs de auditoria são append-only, com acesso restrito e relógio confiável.

### I-14 — Legado compartilhado não expande

`schema_shared` é somente leitura/migração e não pode criar novos projetos independentes. A UI e API não podem rotular schema compartilhado como “isolado”.

## 6. STRIDE e cenários prioritários

| STRIDE | Componente | Cenário/prova de explorabilidade | Severidade | Mitigação/verificação |
|---|---|---|---|---|
| Spoofing | API | Sessão comum chama endpoint administrativo; atualmente `isAuthenticated` não distingue papéis e permite acesso quando nenhuma senha está configurada | **Crítica** | auth fail-closed, identidade forte, RBAC/ABAC por rota e projeto; testes sem config/sem role/role errada = 401/403 sem side effect |
| Spoofing | Approval | Reuso/roubo de `approval_id` executa outro plano | **Crítica** | token single-use curto e vinculado ao hash exato/actor/project UUID/hash de idempotência; teste de replay e troca de campo |
| Tampering | Identifiers/SQL | slug/schema/path malicioso altera SQL ou escapa diretório | **Crítica** | schema estrito, derivação server-side, driver parametrizado, quoting seguro e path confinement; fuzz de quotes, Unicode, separators, NUL e `..` |
| Tampering | Plan | Payload muda depois da aprovação | **Crítica** | plano canônico imutável e hash; provisionador recalcula e compara antes de cada execução |
| Repudiation | Control plane | Operador nega criação/rotação/restore | **Alta** | audit append-only com identidade, aprovação e hashes; correlação ponta a ponta |
| Information disclosure | Erros/logs/UI | stderr, argv, env ou snapshot expõe DSN/keys; a implementação atual repassa parte do erro PostgreSQL | **Alta** | erros codificados, redaction estrutural, nenhum env/command bruto; testes com canary secrets em todas as saídas |
| Information disclosure | Context API | BOLA permite agente A obter schema/metadata B | **Alta** | autorização server-side por project membership/scope; matriz A × B |
| DoS | Provisionador | requisições concorrentes criam stacks/volumes ou esgotam Postgres/R2 | **Alta** | quotas, rate limit, fila limitada, lock, preflight de recursos, circuit breaker e cancelamento seguro |
| Elevation | PostgreSQL | role app recebe membership/owner/default grants e alcança outros bancos | **Crítica** | atributos negativos explícitos, revoke `PUBLIC`, role audit por catálogo, testes reais A × B |
| Elevation | Docker | API com Docker socket equivale a host root e aceita compose/path controlado | **Crítica** | socket apenas no provisionador rootless dedicado, templates fixos, allowlist e sandbox |
| Confused deputy | Provisionador | agente autorizado em A induz provisionador privilegiado a operar B ou prefixo R2 B | **Crítica** | escopo vem da capability e registro; recursos derivados de UUID; nunca confiar em target fornecido pelo cliente |
| Cross-project | PostgreSQL | `CONNECT`, foreign server, dblink, shared role ou search_path cruza A/B | **Crítica** | revokes, sem extensões de conexão, egress restrito, roles exclusivas e testes negativos |
| Cross-project | Supabase | JWT/service key, rede, volume ou Storage compartilhado cruza A/B | **Crítica** | material criptográfico, rede, data path e domínio exclusivos; inventário e probes A × B |
| Race/TOCTOU | Secret/path | symlink troca destino entre validação e escrita | **Alta** | open atômico sem seguir link, owner/mode, rename atômico e raiz não gravável por terceiros |
| Race/idempotência | API/fila | duas execuções criam role/database/stack duplicado ou uma apaga recurso da outra | **Alta** | constraint + fingerprint + advisory/distributed lock + resource ownership tags |
| Rollback parcial | Workflow | DB criado e secret falha; retry colide ou compensação remove recurso antigo | **Alta** | journal durável, compensação baseada em ownership desta operation ID, estado `needs_reconcile`, sem delete cego |
| Tampering | Backup/R2 | path/prefixo cruzado sobrescreve backup B ou restore A em B | **Crítica** | prefixo derivado, IAM scoped, manifest project-bound, checksum/assinatura e restore negativo A × B |

## 7. Vulnerabilidades concretas da implementação atual

Estas constatações justificam o NO-GO; não autorizam correções de produção nesta fase.

### TM-01 — Autorização administrativa ausente

**Severidade:** Crítica.

**Evidência:** `src/routes/api/supabase-registry.ts` protege GET/POST apenas com `isAuthenticated`. `src/server/auth-middleware.ts` retorna autenticado para qualquer request quando não há senha configurada. Não há role, scope, approval object, project binding ou separação solicitante/aprovador.

**Exploitabilidade:** qualquer sessão Workspace — ou qualquer request quando a senha não está configurada — pode emitir o POST que chega ao executor DDL.

**Remediação exigida:** endpoint v2 fail-closed, `project_operator` + `project:plan` para dry-run e `project_approver` + `project:approve` para decisão, CSRF/content-type/rate limit e provisionador separado. Remover execução real do endpoint legado.

### TM-02 — API web acoplada a credenciais equivalentes a admin

**Severidade:** Crítica.

**Evidência:** `src/server/supabase-registry.ts` chama Docker Compose e `psql -U postgres -d postgres` diretamente no processo do Workspace.

**Exploitabilidade:** comprometimento do processo web ou falha futura de injection herda poder de banco/stack e potencialmente Docker host.

**Remediação exigida:** API sem Docker socket/credencial admin; provisionador dedicado com capability e template allowlisted; role administrativa limitada em vez de `postgres`.

### TM-03 — “Projeto” atual é schema compartilhado

**Severidade:** Alta para confidencialidade e blast radius; incompatibilidade arquitetural bloqueante.

**Evidência:** o fluxo atual executa `CREATE SCHEMA` na mesma stack e compartilha Auth, Storage, JWT/service role, processo PostgreSQL e backups.

**Exploitabilidade:** uma service key, role compartilhada, policy incorreta, restore ou comprometimento da stack pode atingir múltiplos projetos.

**Remediação exigida:** marcar como `schema_shared` legado; novos projetos usam database/role exclusivos ou stack completa exclusiva.

### TM-04 — Confirmação textual não é approval

**Severidade:** Alta.

**Evidência:** o servidor compara apenas `confirmation === "CRIAR <slug>"`; o próprio cliente conhece e envia esse valor.

**Exploitabilidade:** script, CSRF compatível ou sessão comprometida reproduz o texto sem revisão de plano.

**Remediação exigida:** dry-run imutável, approval server-side curta/single-use vinculada ao hash e segundo gate para ação destrutiva.

### TM-05 — Controles de mutação incompletos

**Severidade:** Alta.

**Evidência:** diferente de outras rotas mutáveis do repositório, o POST não chama `requireJsonContentType`; também não há rate limit ou idempotency key persistida.

**Exploitabilidade:** amplia superfície CSRF/replay e permite concorrência/retries não controlados.

**Remediação exigida:** JSON estrito, origin/CSRF, limite de corpo, rate limit, key+fingerprint+lock durável.

### TM-06 — Erro do banco ainda revela metadados internos

**Severidade:** Média.

**Evidência:** `formatSupabaseRegistryError` extrai e devolve a primeira linha `ERROR:` do PostgreSQL, inclusive nomes de relações; o teste existente espera exposição de `platform_registry.projects`.

**Exploitabilidade:** usuário autenticado usa erros para mapear catálogo e topologia; mensagens futuras podem conter valores sensíveis.

**Remediação exigida:** código de erro público genérico + correlation ID; detalhe apenas em log restrito já redigido.

## 8. Injection, traversal e argumentos de processo

- Usar driver PostgreSQL e prepared statements para valores. DDL com identifiers só pode usar nomes derivados de slug já validado e quoting da biblioteca; nunca concatenação ad hoc.
- Não aceitar SQL, migration body, Compose YAML, command, image, executable path, host, port, env key/value, filesystem path, R2 bucket/prefix ou database/role name arbitrário no endpoint de execução.
- Executar processos com argv (`execFile`/spawn sem shell), binário absoluto pinado, ambiente mínimo e `cwd` canônico. Remover tokens/secrets de argv.
- Rejeitar Unicode confusável, normalizações divergentes, nomes reservados, sufixos truncados e colisões após transformação. O nome final e seu UUID devem ter constraints únicas.
- Paths: rejeitar absoluto, `..`, `.`, NUL, slash/backslash inesperado, percent/double encoding; verificar confinamento no descritor do diretório e não apenas por prefixo textual.
- Compose: templates versionados e imutáveis; imagens pinadas por digest; project name, network e volume derivados; nunca executar Compose fornecido pelo usuário.
- R2: chave de objeto e prefixo derivados pelo servidor; object key do backup não pode conter input bruto.

## 9. Idempotência, concorrência e rollback parcial

### 9.1 Máquina de estados canônica

```text
planned -> awaiting_approval
awaiting_approval -> approved | rejected | expired | cancelled
approved -> queued | expired | cancelled
queued -> executing | approved
executing -> verifying | failed | rollback_pending | manual_intervention_required
verifying -> succeeded | rollback_pending | manual_intervention_required
failed -> queued | rollback_pending
succeeded -> rollback_pending
rollback_pending -> rolling_back
rolling_back -> rolled_back | manual_intervention_required
```

Essa tabela é uma projeção exata de `OperationState.x-allowed-transitions`; qualquer mudança deve começar no OpenAPI. Transições usam compare-and-swap/`operation_version`. `rolled_back`, `manual_intervention_required`, `rejected`, `expired` e `cancelled` são terminais. `succeeded` admite apenas rollback explícito pela política. `manual_intervention_required` bloqueia novas mutações do projeto até inspeção/reconciliação.

### 9.2 Contrato de idempotência

- key aleatória client-owned, persistida antes da primeira tentativa, com entropia suficiente e retenção de 24 horas;
- fingerprint canônico inclui `driver`, ambiente e todos os campos semanticamente relevantes;
- mesma key/fingerprint retorna status/resultado anterior;
- mesma key com fingerprint diferente retorna `409 IDEMPOTENCY_KEY_REUSED`;
- lock por project UUID cobre preflight, side effects, verificação e journal;
- cada recurso recebe ownership tag/manifest `{project_uuid, operation_id, plan_hash}`.

### 9.3 Rollback em três gates

1. `rollback/dry-run` observa ownership e drift sem side effect e persiste `RollbackPlan`, `observed_revision`, expiração, classificação destrutiva e `rollback_plan_hash` próprios.
2. `rollback/approve` recebe `RollbackApprovalRequest` discriminado por `decision`. Aprovação exige o hash exato e produz novo `approval_id`; rejeição exige motivo. A aprovação de provisionamento nunca é reutilizada.
3. `rollback/execute` revalida `approval_id`, `rollback_plan_hash`, validade, revisão observada, ownership, policy e segregação antes de adquirir lease ou produzir side effect.

Em produção e para ação destrutiva, o aprovador humano deve diferir do solicitante do rollback e do solicitante original. Falha de ownership/drift ou aprovação resulta em erro tipado ou `manual_intervention_required`, nunca em compensação especulativa.

### 9.4 Saga e compensações

| Etapa | Postcondição | Compensação permitida |
|---|---|---|
| Reservar projeto/names | registro único `EXECUTING` | liberar apenas reserva da mesma operation ID |
| Gerar secret | secret existe com owner/mode corretos | destruir apenas versão ainda não injetada |
| Criar role/database | atributos e owner auditados | remover somente se criados por esta operação, vazios e sem dependências |
| Criar stack/volumes | health e ownership verificados | parar/remover somente recursos tagueados desta operação |
| Configurar backup/R2 | upload canário/checksum/policy passam | remover somente canário e config da operação |
| Publicar runtime | app usa credencial nova e health passa | voltar à versão anterior ainda válida |
| Finalizar | evidências persistidas e secrets redigidos | não aplicável |

Compensação nunca tenta “adivinhar” estado. Falha de compensação gera `manual_intervention_required`, alerta e bloqueio; não continua nem declara sucesso parcial.

## 10. Lifecycle de secrets

### 10.1 Geração

- CSPRNG do sistema; mínimo 256 bits para senhas/tokens de alta entropia.
- Secrets exclusivos por projeto, ambiente e finalidade; não derivar de slug, timestamp ou secret global.
- JWT signing material do `supabase_isolated` exclusivo por stack; suportar `kid` e sobreposição durante rotação.

### 10.2 Armazenamento

- path físico canônico por `<project-uuid>` (slug apenas como metadado), fora do repo, em diretório 0700 e arquivo 0600; o path concreto é detalhe privado do secret broker e não faz parte do contrato público;
- escrita atômica, no-follow, owner `jean`/runtime dedicado e backup apenas se cifrado e explicitamente necessário;
- preferir secret manager/credentials do systemd ou Docker secrets; arquivo env é baseline mínimo, não autorização para expor env ao agente;
- nunca versionar, anexar ao Kanban, incluir em PR, copiar para UI ou retornar por API.

### 10.3 Distribuição e uso

- provisionador injeta secret diretamente no runtime autorizado; agentes recebem somente URL mascarada e metadados;
- nenhum secret em command line, process title, health response, telemetry ou exception;
- leitores limitados ao runtime do projeto e ao mecanismo de rotação; API do Workspace não lê valor após provisionamento.

### 10.4 Rotação e revogação

1. gerar nova versão;
2. instalar sem remover a anterior;
3. reiniciar/recarregar runtime e provar conexão/assinatura pela nova versão;
4. revogar versão anterior;
5. verificar que a antiga falha e a nova passa;
6. registrar somente IDs/tempos/status redigidos;
7. destruir resíduos temporários.

Rotacionar imediatamente após suspeita de vazamento, mudança de operador ou restore fora do ambiente original; rotina máxima definida por classe do secret. Rollback de rotação reutiliza a versão anterior apenas durante janela curta e auditada.

### 10.5 Redaction tests

Injetar canary secrets conhecidos em fixtures isoladas e provar ausência em response body/headers, logs, traces, audit events, UI, snapshots, errors e arquivos versionados. Procurar também URL-encoded, JSON-escaped, base64 e fragmentos relevantes sem registrar o valor real no CI.

## 11. Backups, R2 e restore

- Um job, diretório local, retenção, prefixo R2 e credencial/policy por projeto ou política que tecnicamente restringe ao prefixo imutável do project UUID.
- Backup cifrado em trânsito e repouso, checksum forte e manifesto versionado; não declarar sucesso antes de upload + verificação.
- Restore test diário/regular conforme criticidade, em database/stack efêmera do mesmo projeto; validar schema e amostras não sensíveis, depois destruir com ownership verificado.
- Restore em produção exige novo plano, aprovação separada, backup pré-restore e janela operacional.
- Negar restore quando manifest project UUID/mode não corresponde ao destino, checksum falha, versão é incompatível ou o destino não está vazio.
- Alertar backup ausente, atrasado, checksum inválido, restore test falho, retenção divergente e acesso cross-prefix.

## 12. Plano de testes negativos e evidências obrigatórias

### 12.1 API/control plane

| ID | Teste | Resultado obrigatório |
|---|---|---|
| API-01 | sem senha/provider/RBAC configurado | 401/503 fail-closed; zero side effect |
| API-02 | sessão válida sem role `project_operator` ou scope `project:plan` | 403; zero side effect |
| API-03 | operador A usa alias ou `project_uuid` B em path/body/query | 403/404 uniforme; nenhum metadata B |
| API-04 | content type form/text, origin hostil, CSRF e body oversized | rejeição antes de parse/side effect |
| API-05 | approval expirada, usada, de outro actor/projeto ou plan hash | rejeição; audit event redigido |
| API-06 | mesma idempotency key, mesmo payload, N retries concorrentes | um side effect; mesmo resultado |
| API-07 | key client-owned criada antes do primeiro POST; mesma key com payload diferente | replay seguro no primeiro caso; `409 IDEMPOTENCY_KEY_REUSED` no segundo; nenhuma segunda execução |
| API-08 | slugs com quotes, `..`, slash, backslash, NUL, Unicode confusável e encoding duplo | 400; nenhum SQL/path/process iniciado |
| API-09 | canary secret em erro de dependência | resposta/log/audit sem canary/DSN/argv/stack |
| API-10 | flood de planos/execuções | rate limit/quota; fila e host permanecem saudáveis |
| API-11 | alias/slug A reciclado ou enviado com `project_uuid` B | 403/409; ownership e recursos continuam vinculados ao UUID original |
| API-12 | resposta/status/erro/audit de operação com secret criado | somente `secret_ref` opaca; nenhum valor ou path físico |
| API-13 | approve e reject de provisionamento/rollback | ramos `oneOf` discriminados; approve exige hash/confirmação, reject exige motivo |
| API-14 | rollback dry-run/approve/execute com hash, ator ou revisão trocados | rejeição antes do lease e de qualquer side effect |
| API-15 | token sem scope requerido chama cada `operationId` | 403 uniforme conforme `x-rbac-policy`; zero side effect |

### 12.2 PostgreSQL A × B

Criar databases e roles efêmeros A e B em ambiente de teste aprovado, nunca produção, e provar:

| ID | Credencial/origem | Alvo | Resultado obrigatório |
|---|---|---|---|
| PG-01 | app A | database A, operações allowlisted | sucesso |
| PG-02 | app A | `CONNECT` database B | falha `permission denied` |
| PG-03 | app A conectada em A | objetos/schema B via qualquer nome/search_path | inexistente/negado |
| PG-04 | app A | `CREATE DATABASE/ROLE`, `ALTER ROLE`, extensão | negado |
| PG-05 | app A | `SET ROLE` admin/B, membership herdada | negado |
| PG-06 | migration A | database B | negado |
| PG-07 | `PUBLIC`/usuário sem grant | CONNECT/CREATE em A ou B | negado |
| PG-08 | catálogo | atributos de app A/B | todos os flags admin falsos, roles distintas |
| PG-09 | tentativa `dblink`/FDW/copy program | host/outro DB | extensão ausente ou permissão negada |
| PG-10 | 2 creates concorrentes A | catálogo/recursos | exatamente um conjunto consistente |

Capturar comandos, exit status e assertions sem credenciais. O gate não aceita somente inspeção visual de grants.

### 12.3 Stack Supabase A × B

| ID | Teste | Resultado obrigatório |
|---|---|---|
| ST-01 | container A resolve/conecta serviço DB/Auth/Storage de B | falha por rede/policy |
| ST-02 | anon JWT A em endpoints B | 401/403 |
| ST-03 | service key A em B | 401/403, sem metadata/dados B |
| ST-04 | upload/list/download com credencial A em bucket B | 401/403 |
| ST-05 | volumes, networks, Compose project, env/JWT/data path | IDs/paths/material exclusivos, sem compartilhamento |
| ST-06 | parar/remover stack A | stack B permanece saudável e dados intactos |
| ST-07 | backup A restaurado como B sem fluxo de migração | bloqueado por manifesto |
| ST-08 | falha após criação de volume/rede | somente recursos da operation A compensados; B intacta |
| ST-09 | domínio/Host A direcionado a B | rejeitado; certificados/routes sem wildcard perigoso |
| ST-10 | logs/inspect/config export | nenhum secret real em saída persistida ou API |

### 12.4 Filesystem/R2/secrets

- tentativa de slug/path traversal e symlink swap não cria nem altera arquivo fora da raiz;
- permissões 0700/0600 e owner conferidos por `stat`; processo não autorizado não lê;
- credencial R2 A não lista/lê/escreve/apaga prefixo B;
- overwrite de backup existente é negado ou versionado de modo auditável;
- checksum corrompido e manifest B→A bloqueiam restore;
- rotação prova nova credencial válida e anterior revogada sem downtime indevido;
- scanner de Git/diff/log/artifacts não encontra canary secrets.

## 13. NO-GO gates

Qualquer item aberto mantém o sistema em **NO-GO**:

- [ ] Endpoint de execução fail-closed com RBAC/ABAC por projeto e segregação plan/approve/execute.
- [ ] Processo web sem Docker socket, credencial `postgres`, credencial R2 global ou leitura de secrets reais.
- [ ] Provisionador dedicado, sandboxed e limitado a templates/ações allowlisted.
- [ ] Dry-run comprovadamente sem side effects e approval vinculada ao `plan_hash`.
- [ ] Estados/transições e role → scope → `operationId` idênticos ao OpenAPI canônico, sem aliases locais.
- [ ] `project_uuid` imutável governa ownership; API/UI expõem somente `secret_ref` opaca, sem path físico.
- [ ] Idempotency store durável, fingerprint, lock por projeto e testes de concorrência.
- [ ] `Idempotency-Key` client-owned persiste antes do primeiro POST e approve/reject são schemas discriminados.
- [ ] Saga/journal, compensações com ownership e caminho `manual_intervention_required` testados.
- [ ] Rollback dry-run/approve/execute usa `rollback_plan_hash`, aprovação nova e segundo ator quando destrutivo.
- [ ] Role app/migration sem privilégios administrativos; PostgreSQL apenas loopback.
- [ ] Testes reais PG A × B completos, incluindo CONNECT, DDL admin e cross-role.
- [ ] Testes reais stack A × B completos para rede, keys, Auth, Storage, volumes e teardown.
- [ ] Secret lifecycle e canary redaction tests aprovados.
- [ ] Backup local + R2 + checksum + restore test por projeto comprovados.
- [ ] Traversal/symlink/injection/replay/confused deputy negativos aprovados.
- [ ] Audit trail append-only e redigido com actor/project/plan/approval/correlation.
- [ ] `schema_shared` bloqueado para novos projetos e rotulado como legado/não isolado.
- [ ] Security e QA independentes aprovam evidências; PRs e contratos são coerentes.

### Gates adicionais para ações destrutivas

Drop database/role/volume/stack, restore em produção, rotação de signing key e revogação de credencial exigem: backup recente verificado, inventário de dependências, preview explícito, aprovação de segundo ator, delay/cancel window quando aplicável e confirmação server-side vinculada ao resource UUID — nunca apenas nome digitado.

## 14. Rastreabilidade dos achados QA

| Achado | Alinhamento neste threat model |
|---|---|
| `PCV2-QA-001` | seção 9.1 projeta exatamente o enum/transições de `OperationState.x-allowed-transitions` e remove aliases locais |
| `PCV2-QA-002` | seção 9.3 exige rollback dry-run/approve/execute, hash próprio, approval nova, drift/ownership e segundo ator |
| `PCV2-QA-003` | invariantes I-01, I-02 e I-08 vinculam ownership ao `project_uuid` imutável e expõem somente `secret_ref` opaca |
| `PCV2-QA-004` | seção 4.1 usa roles/scopes do `x-rbac-policy` e referencia `x-required-scopes` como fonte contratual |
| `PCV2-QA-005` | I-10 e seção 9.2 tornam a `Idempotency-Key` client-owned antes do primeiro request; servidor persiste somente hash |
| `PCV2-QA-006` | I-04 e testes API-13 exigem `oneOf` discriminado para approve/reject de provisionamento e rollback |

## 15. Critério de saída da discovery

A discovery termina quando PRD, threat model, spec/OpenAPI e UX usam os mesmos nomes, estados, roles, códigos de erro e gates; os testes acima estão rastreados em um plano executável; e o NO-GO está visível na API/UI. Isso **não** concede GO operacional. O GO só pode ser emitido após implementação em ambiente de teste, evidência real A × B, revisão Security/QA e aprovação explícita para cada rollout.
