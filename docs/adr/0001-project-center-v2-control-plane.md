# ADR 0001: Control plane por operações tipadas para o Project Center v2

- Status: Proposto
- Data: 2026-08-11
- Decisores: Jean / JE4NDEV, Luna, Dev, Security e QA
- Issues: `JE4NVRG/je4ndev-platform-core#2`, `#5`, `#12`, `#17`

## Contexto

O Project Center atual cria um schema na stack Supabase compartilhada e atualiza `platform_registry` no mesmo fluxo síncrono. Esse desenho não entrega isolamento de database, role, processo, rede, storage, secrets, backup ou restore. Também acopla a UI a DDL administrativo e a um comando operacional local.

A decisão de produto exige dois modos reais: PostgreSQL dedicado por projeto como padrão e stack Supabase completa dedicada quando Auth/Storage/Realtime/PostgREST forem necessários. O control plane deve permitir automação por agentes sem entregar credenciais administrativas, shell ou SQL livre.

## Decisão

Adotar um control plane baseado em operações declarativas, tipadas, idempotentes e assíncronas:

1. A API recebe `ProjectIntent`, nunca comandos.
2. Um dry-run observa o ambiente e produz plano imutável com hash.
3. Uma aprovação explícita é vinculada ao hash e expira.
4. Um worker com lease e fencing token executa somente ações de allowlist embutidas em drivers versionados.
5. O worker reconcilia estado antes/depois de cada side effect.
6. Verificação comprova isolamento, least privilege, backup e restore antes de publicar no registry/Platform API.
7. Falhas geram compensação segura ou estado `manual_intervention_required`.
8. Auditoria append-only e respostas usam payload sanitizado e secret references opacas.
9. O OpenAPI é a fonte canônica para o enum e a tabela de transições (`OperationState`), a matriz role → scope → `operationId` (`x-rbac-policy`) e os requisitos por operação (`x-required-scopes`). Outros artefatos apenas projetam esses identificadores.
10. Rollback usa três fases separadas: dry-run tipado, decisão segregada vinculada ao `rollback_plan_hash` e execute assíncrono com revalidação de drift/ownership.
11. `SecretRef` é um token opaco, aleatório e emitido exclusivamente pelo secret broker; identidade, finalidade e localização permanecem no binding privado persistido pelo broker, nunca no token.

Drivers iniciais:

- `postgresql_isolated`: database e role app exclusivos, grants least-privilege, secret broker, backup/R2 e restore test.
- `supabase_isolated`: Compose project, rede, PostgreSQL data store, config, JWT/keys, backup e monitoramento exclusivos.

`schema_shared` fica legado/read-only e não é um driver selecionável para criação.

## Consequências positivas

- retries não duplicam database, role, volume ou stack;
- aprovação corresponde exatamente ao plano executado;
- execução privilegiada fica fora do processo HTTP e do alcance de agentes;
- isolamento e backup tornam-se verificáveis, não apenas declarados;
- registry e Platform API refletem somente estado verificado;
- novos drivers podem reutilizar máquina de estados, locks, audit e policy engine.

## Consequências negativas

- exige storage durável de operações, outbox, leases e auditoria;
- aumenta latência e complexidade em comparação ao POST síncrono atual;
- rollback não pode ser prometido para todo side effect; alguns casos exigem intervenção humana;
- a stack Supabase dedicada consome mais CPU, memória, disco e operação;
- requer catálogo rigoroso de templates, imagens, hosts, extensões e limites.

## Alternativas rejeitadas

### Continuar criando schema compartilhado

Rejeitada porque Auth, Storage, roles estruturais, JWT, backup e blast radius continuam compartilhados. Pode existir apenas para migração/leitura de legados.

### Permitir shell/SQL administrativo com aprovação

Rejeitada porque aprovação não torna entrada arbitrária segura. Shell/SQL livre aumenta risco de injection, exfiltração e mudanças fora do plano revisado.

### Executar provisionamento dentro do request HTTP

Rejeitada por timeout, retries ambíguos, ausência de lease/fencing e dificuldade de reconciliar falhas parciais.

### Publicar no registry antes de verificar

Rejeitada porque agentes poderiam consumir contexto de um projeto incompleto ou inseguro. A publicação será outbox idempotente após verify.

### Usar Supabase isolado para todos os projetos

Rejeitada por custo e complexidade. `postgresql_isolated` é padrão; `supabase_isolated` requer capacidades que o justifiquem.

## Controles obrigatórios

- roles e scopes canônicos do `x-rbac-policy`, com `default: deny` e dupla pessoa em produção;
- `Idempotency-Key` gerada/persistida pelo cliente antes da primeira tentativa, hash de plano, optimistic version e locks com fencing;
- requests de aprovação discriminados por `decision`: aprovação exige hash/confirmação; rejeição exige motivo e não uma frase falsa de aprovação;
- allowlists versionadas e imagens/templates pinados;
- secret broker sem retorno de secret value e com emissão CSPRNG de `SecretRef` opaca;
- persistência atômica do digest/binding interno da `SecretRef` antes de publicar o artefato;
- redaction centralizada da `SecretRef` integral em logs, traces, métricas, erros, audit e UI;
- sanitização de erro por catálogo fechado;
- ownership marker antes de adoção/rollback;
- prova negativa de isolamento cruzado;
- backup e restore test por projeto;
- PostgreSQL nunca exposto em `0.0.0.0:5432`;
- rollout por feature flag e ambientes.

## Impacto no sistema atual

`src/server/supabase-registry.ts` deixa de ser executor de criação. O GET e o adapter de leitura podem permanecer temporariamente para inventário/migração. O POST legado deve ser desativado após o v2 estar disponível. A UI passa a consumir o contrato versionado e acompanhar operações assíncronas.

O `platform_registry` atual não é prova de isolamento. O novo registry registra `driver`, `environment`, `provisioning_generation`, artefatos públicos/scoped, health, backup e referências opacas. A je4ndev Platform API projeta esse estado para agentes sem secrets.

## Decisão de identidade para SecretRef

O broker gera cada `SecretRef` no servidor com prefixo de namespace `sref_` e pelo menos 256 bits de entropia CSPRNG em base64url. O token não contém, codifica ou concatena `project_id`, UUID do projeto, slug, purpose, provider, locator ou path. Não existe algoritmo cliente para construí-lo e nenhuma autorização pode ser inferida por parsing; consumidores tratam a referência como valor atômico.

A emissão só termina após persistência durável e atômica de um registro privado do broker, indexado por digest do token e vinculado internamente ao UUID do projeto, purpose, versão, estado e locator protegido do provider. A operação publica o artefato apenas depois dessa confirmação. Replay idempotente recupera o mesmo registro; rotação emite nova referência aleatória e revoga a anterior conforme política, sem alias determinístico.

O token integral circula apenas em campos tipados necessários entre API, worker e broker. Redaction ocorre antes da serialização de logs, traces, métricas, erros e eventos de auditoria. Observabilidade, UI e suporte recebem somente fingerprint não reversível ou valor mascarado neutro, como `sref_REDACTED_REDACTED_REDACTED_REDACTED_REDACTED`; nunca recebem o binding privado ou o locator.

## Verificação da decisão

A implementação só pode sair de feature flag quando:

- testes de contrato e máquina de estados estiverem verdes;
- concorrência/replay não duplicar recursos;
- projeto A falhar ao acessar recursos de B;
- respostas, logs e audit passarem scanner de secrets;
- rollback e recuperação de lease expirado forem ensaiados;
- backup/restore por driver estiver comprovado;
- QA e Security emitirem GO explícito.

## Deploy e rollback

Implementar em PRs atômicos, começando pelo storage/máquina de estados sem side effects. Ativar primeiro em development, depois staging e por último production. Secrets são instalados pelo operador no secret broker, nunca pelo deploy/repo.

Rollback do software desativa feature flags e workers, preservando operações, outbox e auditoria. Recursos já provisionados não são removidos por rollback de versão; sua compensação usa o contrato de rollback com novo gate.

O gate de compensação não reutiliza a aprovação de provisionamento. Primeiro, `rollback/dry-run` observa ownership e drift e persiste um `RollbackPlan` imutável com `rollback_plan_hash`. Depois, `rollback/approve` exige novo `approval_id`; em rollback destrutivo, o aprovador humano difere do solicitante do rollback e do solicitante original. Por fim, `rollback/execute` revalida hash, aprovação, validade, revision, ownership e policy antes de adquirir lease. Falha em qualquer prova encerra antes do side effect com erro tipado ou `manual_intervention_required`.

## Consequência para contratos e clientes

- SDK/UI gera e persiste `Idempotency-Key` antes do primeiro POST e a reutiliza após timeout; o servidor guarda apenas o hash.
- Tokens carregam roles/scopes do vocabulário canônico; descrições livres não concedem autorização.
- Labels de UX podem ser traduzidas, mas não criam aliases de estado no domínio.
- `ApprovalRequest` e `RollbackApprovalRequest` são `oneOf` discriminados, tornando aprovação e rejeição estruturalmente distintas.
