# Project Center v2 — Especificação técnica

- Status: proposta executável para Gate 3/4
- Issue: `JE4NVRG/je4ndev-platform-core#5`
- Contrato HTTP: `specs/contracts/project-center-v2.openapi.yaml`
- Decisão arquitetural: `docs/adr/0001-project-center-v2-control-plane.md`

## 1. Objetivo e limites

O Project Center v2 é um control plane para provisionar e reconciliar recursos isolados por projeto. Ele substitui o fluxo atual de criação direta de schema em `src/server/supabase-registry.ts` por operações tipadas, idempotentes, auditáveis e sujeitas a aprovação.

Esta especificação não implementa nem autoriza alterações reais em PostgreSQL, roles, secrets, Docker, Nginx, DNS, Cloudflare, systemd ou produção. O fluxo legado `schema_shared` permanece somente leitura/migração e não pode ser selecionado para novos projetos independentes.

Princípios invioláveis:

- toda mutação começa em `dry-run` e usa o mesmo plano imutável na execução;
- execução exige aprovação válida e explícita;
- agentes nunca recebem segredo real nem conexão administrativa;
- drivers aceitam comandos tipados de allowlist, nunca shell ou SQL arbitrário enviado pelo cliente;
- o estado observado vence o estado presumido; retries reconciliam antes de repetir;
- auditoria é append-only, sanitizada e correlacionada por operação;
- `5432` permanece acessível apenas em loopback/rede privada autorizada.

## 2. Atores e autorização

| Ator                         | Capacidades mínimas                                               |
| ---------------------------- | ----------------------------------------------------------------- |
| `agent:read`                 | consultar status, auditoria sanitizada e contexto registrado      |
| `admin:project-factory`      | criar dry-run, solicitar execução, verificar e solicitar rollback |
| `admin:approve-side-effects` | aprovar ou rejeitar plano dentro da validade                      |
| `platform-worker`            | consumir operação aprovada e executar ações internas tipadas      |
| `auditor`                    | consultar eventos e evidências sanitizadas, sem secrets           |

Para `environment=production`, o aprovador deve ser humano, possuir `admin:approve-side-effects` e ser diferente do solicitante. Tokens de agente não podem aprovar, mesmo acumulando outros scopes. Autorização é validada novamente em `execute` e `rollback`; aprovação expirada ou revogada não é reutilizada.

## 3. Modelo de domínio

### 3.1 ProjectIntent

Entrada declarativa desejada:

- `client_id`: slug do cliente;
- `project_slug`: slug curto do projeto;
- `display_name` e descrição sem dados sensíveis;
- `driver`: `postgresql_isolated` ou `supabase_isolated`;
- `environment`: `development`, `staging` ou `production`;
- `capabilities`: auth, storage, realtime, PostgREST e backup;
- `region`/`host_target`: identificadores de allowlist, nunca hostname arbitrário;
- `repository`: referência pública/scoped já registrada, sem token;
- `requested_limits`: limites dentro das cotas do driver.

### 3.2 Operation

Registro imutável de intenção e plano, mais estado mutável controlado:

- `operation_id` UUID;
- `project_id = <client_id>-<project_slug>`;
- `request_hash` canônico;
- `idempotency_key_hash` (a chave bruta não é persistida em logs);
- snapshot da política e da versão do driver;
- plano tipado e hash SHA-256;
- estado, versão otimista e timestamps;
- approval, attempts, verificação, rollback e referências de auditoria;
- resultado sanitizado contendo apenas nomes, estados, IDs públicos/scoped e secret references opacas.

### 3.3 ArtifactRef

Artefatos retornados são referências, nunca conteúdo sensível. Tipos permitidos: `database`, `app_role`, `compose_project`, `network`, `data_store`, `secret_ref`, `backup_policy`, `r2_prefix`, `restore_test`, `registry_record`, `platform_context`, `endpoint_masked`.

`secret_ref` usa identificador opaco como `secret://projects/<project_id>/database-url`; a API não expõe path absoluto, senha, DSN real, JWT secret, service-role key ou conteúdo de `.env`.

## 4. Naming determinístico

Entradas `client_id` e `project_slug` devem casar `^[a-z][a-z0-9-]{1,23}$`. O `project_id` é `<client_id>-<project_slug>`.

| Recurso         | Regra                                                            |
| --------------- | ---------------------------------------------------------------- |
| database        | `je4ndev_<client_id>_<project_slug>` com hífen convertido em `_` |
| app role        | `<database>_app`                                                 |
| Compose project | `je4ndev-sb-<client_id>-<project_slug>`                          |
| network         | `<compose_project>-net`                                          |
| data store      | `<compose_project>-postgres-data`                                |
| secret alias    | `projects/<project_id>/<purpose>`                                |
| backup local    | `<project_id>/<environment>/postgres/`                           |
| R2 prefix       | `projects/<project_id>/<environment>/postgres/`                  |

Os limites de slug mantêm database e role abaixo de 63 bytes. Nomes são normalizados em ASCII minúsculo. Não há fallback silencioso: nome inválido ou colisão com recurso pertencente a outro projeto retorna `NAMING_CONFLICT`. Recursos preexistentes só são adotados quando possuem ownership marker compatível com `project_id`, `driver` e ambiente.

## 5. Máquina de estados idempotente

Estados:

- `planned`: dry-run válido, sem efeito real;
- `awaiting_approval`: plano final aguardando gate;
- `approved`: aprovação válida vinculada ao hash do plano;
- `queued`: lease adquirido para execução;
- `executing`: ações tipadas em andamento;
- `verifying`: execução concluída, verificações em andamento;
- `succeeded`: estado desejado e isolamento comprovados;
- `failed`: falha segura sem side effect pendente;
- `rollback_pending`: falha parcial ou rollback solicitado;
- `rolling_back`: compensações em andamento;
- `rolled_back`: recursos criados pela operação foram compensados ou desativados;
- `manual_intervention_required`: não foi possível provar segurança para continuar/compensar;
- `rejected`, `expired` e `cancelled`: estados terminais antes da execução.

Transições permitidas:

```text
planned -> awaiting_approval
awaiting_approval -> approved | rejected | expired | cancelled
approved -> queued | expired | cancelled
queued -> executing | approved
executing -> verifying | failed | rollback_pending | manual_intervention_required
verifying -> succeeded | rollback_pending | manual_intervention_required
failed -> queued | rollback_pending
rollback_pending -> rolling_back
rolling_back -> rolled_back | manual_intervention_required
succeeded -> rollback_pending (somente rollback explícito permitido pela política)
```

Qualquer outra transição retorna `INVALID_STATE_TRANSITION`. Estados terminais devolvem a mesma representação em retries equivalentes.

### 5.1 Idempotência

- Toda mutação exige `Idempotency-Key` (UUID ou 16–128 caracteres de `[A-Za-z0-9._:-]`).
- A chave é vinculada a `actor_id + method + route template + canonical request hash` por 24 horas.
- Mesma chave e mesmo payload devolvem a operação original e `Idempotency-Replayed: true`.
- Mesma chave com payload diferente retorna `409 IDEMPOTENCY_KEY_REUSED`.
- O plano recebe `plan_hash`; aprovação e execução recusam plano alterado.
- Antes de cada ação, o driver chama `observe`; se o recurso já existe com ownership correto e configuração equivalente, marca `already_satisfied` sem repetir side effect.
- Após timeout, a operação volta a `approved`/`failed` somente depois de observar o recurso. Nunca repetir ação com resultado desconhecido.

## 6. Fluxo HTTP

1. `POST /api/v1/project-center/operations/dry-run`: valida intenção, políticas, cotas e estado observado; cria plano sem side effects.
2. `POST .../{operation_id}/approve`: aprova/rejeita exatamente `plan_hash`, com frase `APROVAR <project_id> <plan_hash-prefix>` para aprovação.
3. `POST .../{operation_id}/execute`: enfileira operação aprovada; responde `202` e nunca executa no request web.
4. `GET .../{operation_id}`: status e resultado sanitizado.
5. `POST .../{operation_id}/verify`: enfileira verificação read-only e prova isolamento/backup/health conforme driver.
6. `POST .../{operation_id}/rollback`: cria plano de compensação, sujeito a confirmação e política; rollback destrutivo exige nova aprovação de produção.
7. `GET .../{operation_id}/audit`: eventos append-only paginados e sanitizados.

O contrato canônico, erros e exemplos estão no OpenAPI. Respostas incluem `request_id`; operações assíncronas incluem `operation_id`, `state` e `status_url`.

## 7. Planner e ações tipadas

O planner lê intenção, registry, inventário sanitizado, política e versão do driver. Ele produz uma lista ordenada de `PlannedAction`, cada uma com:

- `action_id`, `kind`, `target_ref`, dependências e classificação de risco;
- estado anterior sanitizado e estado desejado;
- `reversible`, `compensation_kind` e precondições;
- estimativa de recursos e verificações pós-condição;
- nenhum campo de command, SQL, argv, script, env ou secret value.

Allowlist inicial de ações:

`reserve_project`, `create_database`, `create_app_role`, `apply_least_privilege`, `create_secret_ref`, `configure_backup`, `configure_r2_prefix`, `render_compose_template`, `create_network`, `create_data_store`, `start_stack`, `health_check`, `verify_cross_isolation`, `verify_backup_restore`, `publish_registry`, `publish_platform_context`, `disable_resource`, `drop_resource_created_by_operation`.

A implementação de cada ação vive dentro do driver revisado e versionado. Requests externos não escolhem executável, SQL, imagem livre, path, volume mount, porta, domínio ou variável de ambiente.

## 8. Drivers

### 8.1 Interface

Cada driver implementa:

```text
validate(intent, policy) -> ValidationResult
observe(project_id) -> ObservedState
plan(intent, observed, policy) -> PlannedAction[]
execute(action, lease, secretBroker) -> ActionResult
verify(intent, observed) -> VerificationResult
compensate(action, observed, policy) -> ActionResult
sanitize(error_or_result) -> SafePayload
```

Drivers são selecionados por enum compilado, fixados por `driver_version` no plano e executados por worker dedicado sem entrada de shell livre.

### 8.2 `postgresql_isolated` (padrão)

Cria database e role app exclusivos no PostgreSQL 16 local. A role app não possui `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`. O acesso administrativo pertence somente ao worker/secret broker.

Plano mínimo:

1. reservar `project_id` no registry;
2. observar database/role/ownership;
3. criar database e role app com secret gerado pelo broker;
4. aplicar grants least-privilege e revogar `PUBLIC` quando aplicável;
5. registrar secret reference fora do repo com modo equivalente a `0600`;
6. configurar backup local, prefixo R2 e política de retenção;
7. executar teste de conectividade da role app e prova negativa contra projeto canário;
8. executar backup e restore test isolado;
9. publicar registry/contexto somente após verify.

A API retorna database, app role e URL mascarada; nunca senha ou DSN real.

### 8.3 `supabase_isolated`

Usado apenas quando Auth, Storage, Realtime ou PostgREST justificarem stack completa. Cada projeto recebe Compose project, rede, PostgreSQL data store, configuração, JWT/keys, backup, restore test, domínio e monitoramento exclusivos.

Plano mínimo:

1. reservar `project_id` e cota;
2. selecionar template/version/digests da allowlist;
3. alocar nomes e portas internas a partir do registry, sem entrada livre;
4. gerar secrets no broker e renderizar configuração privada;
5. criar rede e data store exclusivos;
6. iniciar stack com imagens pinadas por digest;
7. verificar health de database, Auth, Storage, Realtime e PostgREST habilitados;
8. provar que rede/data store/JWT/service-role não são compartilhados;
9. configurar backup/R2 e executar restore test;
10. publicar endpoints mascarados e contexto após verify.

Nenhum mount arbitrário, `docker compose` arbitrário, imagem não aprovada ou exposição pública é aceito. DNS/Nginx/Cloudflare são etapas futuras separadas, com allowlist e approval próprios; não fazem parte do driver MVP.

## 9. Locks, leases, retries e concorrência

- Lock exclusivo por `environment + project_id`; lock adicional por recurso físico normalizado.
- Aquisição atômica com `lease_id`, fencing token monotônico e TTL de 60 s; worker renova a cada 20 s.
- Apenas o maior fencing token pode persistir resultado.
- Falha ao adquirir retorna `409 OPERATION_LOCKED` com `retry_after_seconds`, sem revelar outro ator.
- Uma operação em execução por projeto; dry-runs paralelos são permitidos, mas approvals invalidam planos baseados em `observed_revision` antigo.
- Versão otimista (`operation_version`) protege updates do estado.

Retries automáticos: máximo 5 attempts por ação, backoff exponencial com jitter (1 s, 2 s, 4 s, 8 s, 16 s; teto 30 s). Somente erros `TRANSIENT` são repetidos. `POLICY`, `VALIDATION`, `AUTHORIZATION`, `CONFLICT`, `SECURITY` e resultado desconhecido exigem reconciliação ou intervenção. Timeout padrão: 30 s por ação PostgreSQL, 120 s por ação de stack, 15 min por operação PostgreSQL e 45 min por operação Supabase.

## 10. Limites e allowlists

| Limite inicial                  |          Valor |
| ------------------------------- | -------------: |
| body HTTP                       |         64 KiB |
| ações por plano                 |             50 |
| projetos por dry-run            |              1 |
| dry-runs por ator               |         10/min |
| mutações por ator               |          5/min |
| eventos de auditoria por página | 100 (máx. 500) |
| validade do plano               |         30 min |
| validade da aprovação           |         15 min |
| tentativas por ação             |              5 |
| concorrência por projeto        |              1 |

Allowlists versionadas cobrem drivers, ambientes, host targets, capabilities, template Supabase, image digests, extensões PostgreSQL, classes de recurso, portas internas e destinos de backup. Valores fora da lista falham em dry-run com `POLICY_DENIED`.

## 11. Erros sanitizados

Envelope público:

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "A solicitação não atende à política do Project Center.",
    "request_id": "req_...",
    "retryable": false,
    "details": [{ "field": "capabilities.realtime", "reason": "not_allowed" }]
  }
}
```

Sanitização remove/redige DSNs, senhas, tokens, JWTs, headers de autorização, env values, paths absolutos, stack traces, SQL, argv e saída de subprocesso. O evento interno pode guardar `internal_error_fingerprint` e referência a log restrito, nunca o conteúdo no audit público. Mensagens públicas vêm de catálogo fechado por `code`.

Códigos mínimos: `INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `POLICY_DENIED`, `NAMING_CONFLICT`, `QUOTA_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`, `PLAN_STALE`, `APPROVAL_REQUIRED`, `APPROVAL_EXPIRED`, `INVALID_STATE_TRANSITION`, `OPERATION_LOCKED`, `DRIVER_UNAVAILABLE`, `EXECUTION_FAILED`, `VERIFICATION_FAILED`, `ROLLBACK_NOT_SAFE`, `MANUAL_INTERVENTION_REQUIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## 12. Registry e Platform API

O Project Center mantém um registry de control plane separado da execução. O adapter do `platform_registry` atual é usado para descoberta e migração de registros legados, não como autoridade para isolamento real.

Publicação ocorre via outbox idempotente após `verify=succeeded`:

1. upsert do projeto por `project_id` e `provisioning_generation`;
2. persistência de driver, ambiente, nomes públicos, capabilities, health, backup e referências opacas;
3. atualização do contexto da je4ndev Platform API;
4. evento de auditoria `registry.published`.

A Platform API expõe em `GET /api/v1/projects/{project_id}/context` o modo, estado, database/app role, masked URL, capabilities, schema/contract refs, backup status e regras para agentes. Não expõe secrets nem acesso admin. O endpoint legado `/api/supabase-registry` torna-se read-only e recebe banner/metadata `legacy_mode=schema_shared`; sua mutação deve ser removida somente após migração e rollout do v2.

Se a publicação falhar, recursos não são recriados. A operação fica reconciliável em `manual_intervention_required` ou retry de outbox, preservando a mesma generation.

## 13. Auditoria e observabilidade

Cada evento contém: `event_id`, `operation_id`, sequence, timestamp UTC, actor pseudonimizado/scoped, tipo, estado anterior/novo, `plan_hash`, action kind, outcome, attempt, duration, request ID, policy/driver version e payload sanitizado.

Eventos obrigatórios: dry-run criado/replay, approval aprovado/rejeitado/expirado, lease adquirido/perdido, ação iniciada/concluída/falhou, retry, verify, rollback, intervenção manual, registry publish e acesso negado. Auditoria é append-only, ordenada por sequence e consultável com cursor.

Métricas mínimas: duração por driver/ação, operações por estado, retries, leases expirados, falhas de verify, rollbacks, publicação pendente e contagem de sanitizações. Alertas nunca incluem payload bruto.

## 14. Verificação e rollback

Verificação `postgresql_isolated`:

- database e role pertencem ao projeto esperado;
- role app conecta somente ao database alvo e não possui atributos elevados;
- acesso cruzado ao database canário/projeto B falha;
- grants e schemas correspondem ao plano;
- secret reference existe e permissões do material privado são seguras;
- backup local/R2 e restore test possuem evidência recente.

Verificação `supabase_isolated` adiciona:

- Compose project, network, data store e config não são compartilhados;
- image digests correspondem à allowlist;
- componentes habilitados estão healthy;
- JWT/service-role refs são exclusivos;
- não existe bind público de PostgreSQL;
- backup e restore test da stack passam.

Rollback compensa apenas recursos criados pela operação e confirmados por ownership marker. Nunca remove recurso preexistente/adotado, com dados não vazios ou generation diferente sem novo plano destrutivo e aprovação. Falha em provar ownership resulta em `MANUAL_INTERVENTION_REQUIRED`.

## 15. Critérios de aceite para implementação

- OpenAPI validado e handlers conformes aos schemas/status codes.
- Duas requisições equivalentes com a mesma chave não duplicam recursos.
- Reuso da chave com payload diferente retorna 409.
- Plano alterado após approval não executa.
- Dois workers concorrentes não executam a mesma ação.
- Role A não conecta/lê/escreve database B; PostgreSQL não é exposto publicamente.
- Stack Supabase A não compartilha rede, data store, secrets ou backup com B.
- Nenhuma resposta/log/audit contém segredo real, shell, SQL administrativo ou path privado.
- Falhas injetadas em cada ação produzem retry seguro, rollback ou estado reconciliável.
- Registry e Platform API só publicam projeto depois de verificação bem-sucedida.
- Backup e restore test passam por projeto.
- `schema_shared` não aparece como opção de criação.

## 16. Plano de implementação e deploy futuro

1. Implementar modelos e storage de operações/outbox sem driver real; validar contrato e máquina de estados com testes determinísticos.
2. Implementar auth, policy engine, idempotência, leases e audit sanitizado.
3. Implementar `postgresql_isolated` atrás de feature flag, primeiro em ambiente descartável; executar prova A/B e restore.
4. Integrar registry/Platform API e migrar endpoint legado para read-only.
5. Implementar `supabase_isolated` com templates/imagens pinados, também atrás de feature flag.
6. Fazer rollout `development -> staging -> production`, com aprovação humana por ambiente, métricas e rollback ensaiado.

Deploy exige migrations versionadas do storage de control plane, backup prévio, revisão Dev/QA/Security, configuração de secrets pelo operador (fora do Git), ativação gradual das feature flags e smoke real. O rollback do deploy desativa workers/flags e preserva operações/auditoria; nunca apaga automaticamente recursos provisionados.
