# Project Center v2 — UX do wizard de provisionamento seguro

Status: especificação de discovery; não altera a UI nem autoriza provisionamento real
Issue: [je4ndev-platform-core#6](https://github.com/JE4NVRG/je4ndev-platform-core/issues/6)
Issue raiz: [je4ndev-platform-core#2](https://github.com/JE4NVRG/je4ndev-platform-core/issues/2)
Responsável: Design / Neo
Data: 2026-08-11

## 1. Objetivo e limites

O wizard transforma a criação de infraestrutura em uma decisão explícita, revisável e auditável. Ele deve impedir que a aparência de um fluxo simples esconda diferenças reais de isolamento, custo e blast radius.

Esta especificação parte de três fatos:

1. O fluxo atual de `/supabase` cria um schema na stack Supabase principal. Isso não cria um projeto isolado.
2. O modo padrão futuro é um database e uma role app exclusivos no PostgreSQL 16 local.
3. Uma stack Supabase completa só é adequada quando Auth, Storage, Realtime ou PostgREST forem requisitos explícitos e o custo adicional tiver sido aceito.

Não faz parte desta entrega alterar banco, roles, secrets, Docker, Nginx, DNS, Cloudflare, systemd ou produção. Também não faz parte desta entrega redesenhar ou implementar a tela atual.

## 2. Direção de experiência

### Referências

- **Linear** para hierarquia, densidade controlada, stepper preciso e progressive disclosure.
- **Sentry** para estados operacionais, eventos, severidade e investigação de falhas.
- **Supabase Studio** apenas como referência mental de capacidades; nunca como promessa de isolamento equivalente.

A interface permanece dark-themed e técnica, mas deve ser entendida sem conhecimento de infraestrutura. O usuário precisa responder primeiro “do que o produto precisa?” e só depois “qual infraestrutura criar?”.

### Princípios

1. **Segurança antes de velocidade:** nenhuma ação real existe antes de dry-run válido e aprovação explícita.
2. **Comparação honesta:** “database isolado”, “stack isolada” e “schema compartilhado” não podem usar a mesma linguagem visual.
3. **Sem credenciais na UI:** exibir nomes, caminhos mascarados, fingerprints e IDs; nunca senha, token, JWT secret ou DSN real.
4. **Sem sucesso otimista:** concluir apenas após verificações reais e persistidas.
5. **Falha é estado, não toast:** falhas parciais permanecem visíveis e recuperáveis.
6. **Ação irreversível é rara e deliberada:** cor, cópia, confirmação e autorização distintas das ações comuns.
7. **Auditoria legível:** toda mudança mostra ator, momento, razão, aprovação e artefatos afetados.

## 3. Arquitetura de informação

### Entrada no Project Center

A listagem principal deve separar visualmente:

- **Projetos isolados:** `postgresql_isolated` e `supabase_isolated`.
- **Legado compartilhado:** `schema_shared`, somente leitura/migração.
- **Operações em andamento:** provisionamento, verificação, rollback e recuperação.

O CTA primário é **Novo projeto isolado**. “Migrar legado” é uma ação secundária e abre outro fluxo. Não existe CTA “Novo schema compartilhado”.

Cada card de projeto deve mostrar, sem expansão:

- nome e slug;
- modo de infraestrutura;
- ambiente;
- estado operacional;
- nível de isolamento;
- custo observado/estimado de RAM e containers;
- último backup e último restore test;
- riscos P0/P1 ativos;
- última verificação.

### Estrutura do wizard

O wizard usa oito etapas persistentes:

1. **Contexto**
2. **Recursos**
3. **Dry-run**
4. **Segurança**
5. **Aprovação**
6. **Execução**
7. **Verificação**
8. **Rollback**

O stepper deve diferenciar `não iniciado`, `atual`, `válido`, `bloqueado`, `em execução`, `falhou`, `recuperável` e `concluído`. Cor nunca é o único indicador: cada estado possui ícone e texto.

Até a etapa Aprovação, o usuário pode voltar sem side effect. Depois do início da Execução, a navegação não cancela o job e o fechamento do painel não perde o estado; o usuário retorna pela operação persistida.

## 4. Escolha de modo

### Matriz de decisão apresentada em Recursos

| Modo                                       | Quando escolher                                                                                            | Isolamento real                                                                                                       | Recursos                                                                                                                                            | Exposição na UX                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `postgresql_isolated` — PostgreSQL isolado | Padrão para apps com backend próprio, migrations versionadas e sem necessidade do pacote Supabase completo | Database e role app exclusivos; mesmo processo PostgreSQL 16 do host; sem leitura cruzada; backup/restore por projeto | **0 containers novos**. RAM marginal depende de conexões e workload; mostrar estimativa do dry-run, não um valor fixo                               | Card recomendado, selecionado por padrão. Badge “Padrão je4ndev”               |
| `supabase_isolated` — Supabase completo    | Só quando Auth, Storage, Realtime ou PostgREST forem requisitos explícitos                                 | Compose, rede, Postgres, data path/volume, JWT/keys, domínio, backup e monitoramento exclusivos                       | Baseline de referência: **14 containers** e aproximadamente **2,4 GiB de RAM observada** na stack Máximo; reservar headroom e recalcular no dry-run | Card de alto custo. Exige justificar capacidades e aceitar impacto de recursos |
| `schema_shared` — legado compartilhado     | Somente inventário e migração de projetos existentes                                                       | Não isola Auth, Storage, JWT/service-role, API, processo PostgreSQL nem blast radius de backup/restore                | Sem stack nova, mas mantém risco compartilhado                                                                                                      | Card desabilitado com badge “Legado bloqueado”. Sem radio/CTA de criação       |

**Cópia obrigatória do legado:** “Schemas compartilhados não são permitidos para novos clientes ou produtos independentes. Abra um plano de migração para um item existente.”

### Recursos e custo

O painel de impacto deve apresentar:

- containers novos e total projetado no host;
- RAM observada agora, RAM estimada após execução e headroom restante;
- disco inicial e política de crescimento;
- portas/bindings, sempre mascarados e identificando bind local;
- serviços/capacidades incluídos;
- backup local, prefixo R2 e restore test;
- fonte e horário da medição;
- qualidade da estimativa: `observado`, `estimado` ou `indisponível`.

Dados de referência coletados em leitura em 2026-08-11:

- stack Máximo: 14 containers em execução e 2.475,5 MiB (2,42 GiB) de RAM no snapshot;
- stack Supabase principal: 14 containers em execução e 2.875,7 MiB (2,81 GiB) de RAM no snapshot;
- o Compose Máximo possui 13 serviços base e um `templates-server` no override, totalizando 14 containers.

Esses números são baseline operacional, não quota nem garantia. O consumo muda por tráfego, pool, cache e dados. A implementação deve obter uma medição atual no dry-run. Se a telemetria estiver indisponível, mostrar **Estimativa indisponível** e bloquear `supabase_isolated`; nunca substituir por zero.

O `postgresql_isolated` não deve ser descrito como processo PostgreSQL exclusivo. Sua promessa é database/role/backup/restore por projeto dentro do PostgreSQL nativo controlado. O custo marginal deve vir do plano de capacidade; “0 containers” não significa “0 RAM”.

## 5. Fluxo detalhado

## 5.1 Contexto

**Objetivo:** identificar o projeto e o ambiente sem coletar segredo.

Campos:

- cliente (`client_id`);
- nome do projeto;
- slug do projeto;
- repositório;
- ambiente: development, staging ou production;
- proprietário operacional;
- descrição sem dados sensíveis;
- classificação de sensibilidade;
- idempotency key gerada pelo control plane, visível parcialmente.

Pré-visualizações derivadas, read-only:

- `project_id`;
- database `je4ndev_<cliente>_<projeto>`;
- role `je4ndev_<cliente>_<projeto>_app`;
- caminho de secret mascarado `/home/jean/.config/je4ndev/projects/<slug>.env`;
- diretórios esperados de migrations, schema e rollback.

Validações:

- slug e nomes válidos e sem colisão;
- repo existente/permitido;
- ambiente compatível com o nível de aprovação;
- nenhum campo contém padrão de token, senha, DSN ou secret;
- contexto obrigatório presente antes de avançar.

CTA: **Continuar para recursos**.

## 5.2 Recursos

**Objetivo:** escolher a menor infraestrutura que atende ao produto.

A tela começa por capacidades, não por tecnologia:

- Database;
- Auth;
- Storage;
- Realtime;
- API REST automática/PostgREST;
- Edge Functions;
- isolamento de backup/restore.

Regras de recomendação:

- apenas Database selecionado recomenda `postgresql_isolated`;
- Auth/Storage/Realtime/PostgREST pode recomendar `supabase_isolated`, mas mostra também a alternativa modular je4ndev quando aplicável;
- `schema_shared` nunca é recomendação válida;
- mudar uma capacidade recalcula modo, containers, RAM, disco e riscos.

Para escolher `supabase_isolated`, o usuário deve preencher “Por que a stack modular não atende?” e reconhecer o custo observado. Para production, telemetria e headroom são gates; falta de capacidade bloqueia o avanço.

CTA: **Gerar dry-run**. Não usar “Criar” nesta etapa.

## 5.3 Dry-run

**Objetivo:** gerar um plano determinístico, idempotente e sem side effects.

O estado inicial é um skeleton com texto “Validando contexto, capacidade e colisões”. O resultado é um diff de intenção agrupado por domínio:

- Git/repo e arquivos versionados;
- database, owner controlado e role app;
- grants e proibições da role;
- secret path e permissão `0600`, sempre mascarados;
- Compose, rede, volumes e serviços quando Supabase completo;
- bindings locais e domínios planejados;
- backup local, R2, restore test e monitoramento;
- verificações e ações compensatórias de rollback.

Cada item possui `Criar`, `Reutilizar`, `Sem alteração`, `Conflito` ou `Bloqueado`. O plano mostra `plan_id`, `idempotency_key`, hash, validade e timestamp. Repetir o dry-run com o mesmo contexto deve produzir o mesmo plano ou explicar o drift.

Gates automáticos mínimos:

- porta 5432 pública: NO-GO;
- database/role/volume/stack com ownership incompatível: NO-GO;
- role com SUPERUSER, CREATEDB, CREATEROLE ou BYPASSRLS: NO-GO;
- secret em repo, prompt, Kanban, log ou payload de retorno: NO-GO;
- ausência de backup ou restore test por projeto: NO-GO;
- Supabase completo sem Compose/rede/data path/JWT/backup exclusivos: NO-GO;
- telemetria/capacidade insuficiente para Supabase completo: NO-GO;
- dry-run expirado ou alterado após aprovação: nova aprovação obrigatória.

CTAs: **Baixar plano sanitizado** e **Revisar segurança**. A cópia/arquivo nunca inclui segredo.

## 5.4 Segurança

**Objetivo:** transformar riscos técnicos em uma checklist explícita.

Seções:

- isolamento de dados;
- least privilege;
- superfície de rede;
- gestão de secrets;
- backup/restore;
- blast radius;
- logs e auditoria;
- rollback/reconciliação.

Cada gate mostra resultado, evidência sanitizada, severidade, responsável e correção. P0/P1 aberto mantém o CTA desabilitado e leva foco para o primeiro gate bloqueador.

Para PostgreSQL isolado, destacar que compartilhar o processo do host mantém algum blast radius operacional, embora database, role e restore sejam separados. Para Supabase completo, exigir prova planejada de rede, volumes, JWT/keys e backup exclusivos.

CTA liberado: **Solicitar aprovação**. CTA bloqueado: **Corrigir bloqueios**.

## 5.5 Aprovação

**Objetivo:** registrar uma decisão humana sobre exatamente o plano revisado.

Resumo fixo:

- projeto, ambiente e modo;
- recursos e headroom;
- side effects previstos;
- riscos aceitos e bloqueios resolvidos;
- plano de rollback;
- hash e validade do dry-run;
- aprovador exigido por policy.

A aprovação não executa. Ela cria um registro `pending_approval`, e apenas Luna/Jean/admin com escopo adequado pode aprovar side effects. O solicitante sem permissão vê estado **Aguardando aprovador**, não um botão falso.

Ao aprovar, registrar ator, role, timestamp, razão, hash do plano e expiração. Qualquer alteração de Contexto/Recursos ou drift do dry-run invalida a aprovação.

CTAs conforme permissão:

- solicitante: **Enviar para aprovação**;
- aprovador: **Aprovar plano** ou **Rejeitar com motivo**;
- sem permissão: nenhum CTA de execução.

## 5.6 Execução

**Objetivo:** acompanhar um job durável sem revelar comandos privilegiados ou secrets.

Antes do side effect, abrir confirmação forte apenas para quem possui autorização. A frase deriva do plano e do ambiente:

`PROVISIONAR <project_id> EM <AMBIENTE>`

Requisitos da confirmação:

- texto exato, case-sensitive;
- checkbox “Revisei recursos, riscos e rollback”;
- nome do projeto e ambiente repetidos fora do campo;
- para produção, confirmação não pode ser colada silenciosamente: a implementação deve decidir um mecanismo acessível que preserve digitação ou challenge equivalente sem bloquear tecnologias assistivas;
- CTA vermelho/âmbar com verbo e objeto: **Provisionar infraestrutura**;
- cancelar continua seguro até o job ser aceito.

Depois do aceite, a UI mostra timeline por etapa com `pending`, `running`, `succeeded`, `failed`, `compensating`, `rolled_back` ou `needs_recovery`:

- preparar operação/idempotência;
- criar infraestrutura;
- aplicar least privilege;
- persistir referências sanitizadas;
- configurar backup;
- executar health checks;
- iniciar verificação de isolamento.

O botão não muda otimisticamente para “Pronto”. Deve existir **Sair e continuar em segundo plano**. Atualizar a página ou trocar de dispositivo recupera o job pelo `operation_id`.

## 5.7 Verificação

**Objetivo:** provar o resultado, não apenas a ausência de erro no provisioner.

Checklist obrigatório:

- database/role ou stack/containers existem exatamente uma vez;
- rerun com a mesma idempotency key não duplica recursos;
- role app não possui privilégios proibidos;
- porta 5432 não está pública;
- projeto A não conecta, lê ou escreve o banco B;
- respostas, logs e artefatos não contêm credencial real;
- backup por projeto executado;
- restore test por projeto passou;
- health checks dos serviços passaram;
- schema/contratos sanitizados disponíveis para agentes;
- auditoria liga request, approval, operation e verificação.

Apresentar evidência por teste com timestamp e executor. “Concluído” exige todos os checks obrigatórios. Falha não destrutiva abre recuperação; falha de isolamento ou vazamento potencial é P0, bloqueia entrega e recomenda rollback/contenção.

CTAs: **Abrir projeto** apenas após PASS; **Ver detalhes da operação** sempre; **Iniciar recuperação** em falha reconciliável.

## 5.8 Rollback

**Objetivo:** tornar explícito o que pode ser revertido, compensado ou exige decisão humana.

O plano existe desde o dry-run, mas a etapa final mostra seu estado real:

- **Não necessário:** verificação passou;
- **Disponível:** operação concluída, rollback ainda possível;
- **Em compensação:** provisioner desfaz apenas recursos criados pela operação;
- **Parcial:** alguns side effects precisam de reconciliação;
- **Bloqueado:** remover dados/backup/stack exige novo gate;
- **Concluído:** compensação verificada e auditada.

Nunca oferecer “Rollback” genérico. Separar:

- cancelar recursos ainda não criados;
- remover recursos vazios criados por esta operação;
- restaurar configuração anterior;
- restaurar backup;
- excluir dados ou stack — irreversível, outra operação e outra aprovação.

A confirmação irreversível para destruição deve usar:

`EXCLUIR <resource_id> SEM RECUPERAÇÃO`

Ela exige motivo, segundo gate conforme policy, backup/restore test válido ou exceção formal e lista dos artefatos que serão destruídos. Um rollback nunca toca recurso preexistente sem prova de ownership pelo `operation_id`.

## 6. Modelo de estados e recuperação

| Estado de UX    | O que mostrar                                                                                      | Ação permitida                                               | O que não fazer                                        |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Loading         | Skeleton da área, etapa atual, texto da operação e tempo decorrido após 3 s                        | Sair e acompanhar em background quando houver `operation_id` | Spinner sem contexto ou apagar conteúdo anterior       |
| Empty           | Explicação do que será listado e CTA compatível com permissão                                      | Novo projeto isolado; importar inventário legado             | Sugerir schema compartilhado                           |
| Denied          | “Você pode visualizar, mas não aprovar/executar”, policy/role exigida e link para solicitar acesso | Voltar; solicitar aprovação/acesso                           | Mostrar segredo, comando admin ou CTA executável       |
| Blocked         | Gate, severidade, evidência sanitizada, motivo e correção                                          | Corrigir contexto; regerar dry-run                           | Permitir bypass silencioso de P0/P1                    |
| Partial failure | Timeline preservada, sucesso/falha por passo, recursos criados, compensação e `operation_id`       | Reconciliar; repetir passo idempotente; escalar              | Reexecutar tudo às cegas ou declarar rollback completo |
| Recovery        | Diagnóstico, ação recomendada, ownership e efeito previsto                                         | Retomar; compensar; solicitar rollback                       | Tocar recurso sem ownership confirmado                 |
| Offline/stale   | Último snapshot, horário e aviso de que ações estão desabilitadas                                  | Tentar novamente                                             | Tratar cache como estado atual                         |
| Success         | Verificações, auditoria, recursos sanitizados e próximos passos                                    | Abrir projeto; baixar relatório                              | Exibir senha/DSN real ou sucesso só por toast          |

### Regras de repetição

- O botão de execução é desabilitado após aceite e substituído pelo estado do job.
- Retry usa a mesma idempotency key quando a intenção não mudou.
- Alterar intenção cria novo plano e nova chave.
- Conflito entre estado esperado e real vira `needs_recovery`; nunca deve ser resolvido por nova criação automática.
- Toast é apenas aviso transitório; o estado persistente vive na página e na auditoria.

## 7. Auditoria

Cada operação expõe um painel **Trilha de auditoria** com:

- `request_id`, `plan_id`, `approval_id` e `operation_id`;
- projeto, ambiente, modo e idempotency key mascarada;
- evento, ator/role, timestamp e origem;
- hash do plano aprovado;
- recursos afetados por ID não sensível;
- transição de estado anterior → novo;
- motivo de aprovação, rejeição, retry, recovery ou rollback;
- evidências e relatórios sanitizados.

Ações de copiar/exportar devem gerar um artefato sanitizado e identificá-lo como tal. Não renderizar payload bruto. Aplicar redaction tanto no servidor quanto na camada visual; CSS ocultando conteúdo não é segurança.

## 8. Acessibilidade e responsividade

Meta: WCAG 2.2 AA.

- Contraste mínimo 4,5:1 para texto normal e 3:1 para texto grande/controles.
- Stepper é uma lista ordenada com etapa atual anunciada por `aria-current="step"`.
- Todos os controles operam por teclado, com foco visível de pelo menos 2 px e ordem lógica.
- Ao avançar, o foco vai para o `h1` da nova etapa; em erro, vai para o resumo de erros, que referencia os campos.
- Timeline usa texto e ícone além de cor; eventos novos são anunciados em região `aria-live="polite"`, sem narrar cada atualização de progresso.
- Alertas P0 e falhas de execução usam `role="alert"` apenas quando surgem; conteúdo persistente não repete anúncio.
- Labels, ajuda e erro permanecem associados via `for`, `aria-describedby` e IDs estáveis.
- Targets interativos têm no mínimo 44 × 44 px.
- Confirmações tipadas não dependem de tempo curto, gesto de mouse ou cor.
- Respeitar `prefers-reduced-motion`; progresso não usa animação indispensável.
- Zoom de 200% não perde conteúdo ou ação; texto não fica preso em containers com altura fixa.
- Desktop: stepper lateral e conteúdo com largura legível; resumo de impacto pode permanecer sticky.
- Tablet/mobile: stepper vira cabeçalho horizontal rolável com texto da etapa atual; resumo aparece antes do CTA; timeline é vertical; nenhuma tabela exige scroll bidimensional para a decisão principal.
- Em telas estreitas, ação segura vem antes da destrutiva; botões destrutivos nunca ficam adjacentes ao CTA primário sem separação e rótulo claros.

## 9. Linguagem e microcopy

Usar linguagem orientada a consequência:

- Preferir **Gerar dry-run** a “Continuar”.
- Preferir **Solicitar aprovação** a “Enviar”.
- Preferir **Provisionar infraestrutura** a “Confirmar”.
- Preferir **Reconciliar operação** a “Tentar novamente” quando houve side effect.
- Preferir **Stack Supabase completa e isolada** a “Projeto Supabase”.
- Preferir **Database e role exclusivos** a “Postgres separado”.

Evitar:

- “100% isolado” para database no processo PostgreSQL compartilhado;
- “sem custo” quando apenas não há container novo;
- “rollback automático” quando existe possibilidade de compensação parcial;
- “erro desconhecido” sem `operation_id`, próximo passo e ação de suporte;
- nomes de secret, senhas, tokens ou comandos administrativos.

### Cópias críticas

**Bloqueio legado**
“Este modo compartilha Auth, Storage, chaves, API e blast radius. Novos projetos não podem usar schema compartilhado.”

**Supabase completo**
“Cria uma stack com 14 containers no baseline atual. A estimativa de RAM será recalculada no dry-run e precisa de headroom aprovado.”

**Aguardando aprovação**
“O plano foi validado, mas nenhum recurso foi criado. A execução depende de um aprovador com escopo administrativo.”

**Falha parcial**
“A operação parou após criar alguns recursos. Não inicie outra criação. Revise a reconciliação vinculada a esta operação.”

**Telemetria indisponível**
“Não foi possível medir a capacidade atual do host. O modo Supabase completo permanece bloqueado para evitar sobrecarga.”

## 10. Componentes e handoff de implementação futura

Componentes-alvo, sem implementação nesta task:

- `ProvisioningWizard` com estado restaurável por URL/operation ID;
- `ProvisioningStepper`;
- `InfrastructureModeCard`;
- `CapabilitySelector`;
- `ResourceImpactPanel`;
- `DryRunDiff`;
- `SecurityGateList`;
- `ApprovalSummary`;
- `TypedConfirmationDialog`;
- `OperationTimeline`;
- `VerificationEvidenceList`;
- `RecoveryPanel`;
- `AuditTrail`.

A implementação deve reutilizar os componentes do Workspace (`Button`, `Dialog`/`AlertDialog`, `Input`, `Toast`) e os tokens existentes. Antes de qualquer alteração visual, criar/adaptar o `DESIGN.md` do projeto conforme o gate visual da je4ndev; hoje não há `DESIGN.md` na raiz deste worktree.

## 11. Instrumentação de produto

Eventos, sempre sem payload sensível:

- `provisioning_wizard_started`;
- `infrastructure_mode_recommended`;
- `infrastructure_mode_overridden` com reason classificada;
- `dry_run_requested`, `dry_run_blocked`, `dry_run_succeeded`;
- `approval_requested`, `approval_approved`, `approval_rejected`, `approval_expired`;
- `provisioning_started`, `provisioning_step_changed`, `provisioning_failed`, `provisioning_succeeded`;
- `verification_failed`, `verification_succeeded`;
- `recovery_started`, `rollback_requested`, `rollback_completed`.

Métricas:

- abandono por etapa;
- taxa de bloqueio por gate;
- tempo entre dry-run, aprovação e execução;
- taxa de retry idempotente;
- falha parcial por tipo de recurso;
- diferença entre RAM estimada e observada;
- tempo até recuperação;
- porcentagem de projetos no modo padrão versus exceção Supabase.

## 12. Critérios de aceite de UX

- [ ] Os três modos aparecem com diferenças de isolamento e custo explícitas.
- [ ] `postgresql_isolated` é o padrão e não promete processo exclusivo.
- [ ] `supabase_isolated` só avança com capacidades justificadas, telemetria e headroom.
- [ ] `schema_shared` está bloqueado para criação e direciona para migração.
- [ ] As oito etapas Contexto/Recursos/Dry-run/Segurança/Aprovação/Execução/Verificação/Rollback existem e preservam estado.
- [ ] Dry-run precede qualquer aprovação ou side effect.
- [ ] Plano, aprovação e execução são ligados por hash, validade e IDs auditáveis.
- [ ] RAM, containers, fonte, horário e qualidade da estimativa aparecem antes da aprovação.
- [ ] Loading, empty, denied, blocked, partial failure, recovery, stale e success têm comportamento definido.
- [ ] Uma falha parcial nunca sugere nova criação antes de reconciliação.
- [ ] Ações irreversíveis têm frase derivada, motivo, gate e consequência explícita.
- [ ] Nenhum estado, export ou auditoria revela credencial real.
- [ ] Verificação cobre idempotência, least privilege, isolamento cruzado, backup e restore test.
- [ ] O fluxo atende WCAG 2.2 AA, teclado, screen reader, reduced motion, zoom e touch targets.
- [ ] O fluxo funciona em desktop, tablet e mobile sem esconder riscos ou ações críticas.

## 13. Referências técnicas

- `CONSTITUTION.md`: Git como fonte da verdade, provisionamento pela plataforma e secrets fora de prompts/repos/logs.
- `docs/database-provisioning.md`: naming, least privilege, migrations, review e rollback.
- `docs/supabase-replacement.md`: stack modular je4ndev como padrão.
- `docs/je4ndev-platform-api.md`: dry-run e approval de side effects.
- `src/server/supabase-registry.ts`: comportamento atual de criação de schema compartilhado e gate `CRIAR <slug>`.
- `src/screens/supabase/supabase-projects-screen.tsx`: UI atual que será substituída/evoluída em fase futura.
- `/home/jean/maximo-supabase/docker-compose.yml` e override: baseline de 14 containers da stack isolada Máximo.

A UX aqui descrita não valida a arquitetura por si só. Ela torna decisões, gates e evidências visíveis; o backend continua responsável por autorização, idempotência, redaction, ownership, rollback e provas reais de isolamento.
