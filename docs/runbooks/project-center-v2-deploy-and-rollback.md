# Runbook — deploy seguro e rollback do Project Center v2

- Público: operador de plantão e gerente de release.
- Fonte da verdade: seção **"Deploy seguro"** e **"Rollback de deploy"** de
  `docs/plans/project-center-v2-implementation-plan.md`, o threat model
  (`docs/security/project-center-v2-threat-model.md`) e o parecer de gate de QA
  (`docs/qa/project-center-v2-final-gate.md`).
- Estado do pacote no momento da escrita: **não operacional**.
  `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`.
  Nada aqui autoriza ativação em produção: a ativação exige decisão humana
  separada, janela operacional, backup verificado e plano de rollback aprovado.

## 1. Pré-requisitos de qualquer janela

1. Parecer de QA verde e parecer de Security verde no commit exato do release.
2. `pnpm project-center:v2:gate` verde (contrato + varredura de segredos +
   testes escopados) no mesmo commit.
3. Build publicado com as duas flags desligadas; health do gateway e das rotas
   legadas medido antes e depois.
4. Backup verificado do que a janela pode tocar (manifesto + checksum), com
   caminho de restore já testado em alvo efémero.
5. Operador presente. O worker **nunca** roda sozinho em janela de ativação.

## 2. Sequência de deploy seguro (flags desligadas → API → worker)

| Passo | Ação                                                                                                                                                                    | Critério de parada                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1     | Publicar o build com `PROJECT_CENTER_V2_ENABLED=false` e `PROJECT_CENTER_V2_WORKER_ENABLED=false`                                                                       | Qualquer rota `/api/project-center/v2/...` responde `feature_disabled` e nenhum observer/executor é aberto |
| 2     | Verificar health e rotas legadas (as mesmas que existiam antes da janela)                                                                                               | Qualquer regressão ⇒ abortar a janela e manter as flags desligadas                                         |
| 3     | Ligar somente a API em development: `PROJECT_CENTER_V2_ENABLED=true`, worker ainda `false`                                                                              | `pnpm project-center:v2:contract` e `pnpm project-center:v2:scan` verdes                                   |
| 4     | Rodar os dry-runs dos dois drivers (`postgresql_isolated` e `supabase_isolated`)                                                                                        | Zero side effect: nenhum `psql`/`pg_dump`/`pg_restore`, nenhum container, nenhum DDL                       |
| 5     | Ligar o worker **somente** em harness efémero allowlisted (`je4ndev_pcv2_<uuid>`, porta/volume exclusivos, guard recusando host/path de produção) com operador presente | O harness só pode apontar para recursos efémeros; nunca para database, role, stack ou volume existente     |
| 6     | Promover para staging/development depois de A×B, replay, backup/restore e rollback provados                                                                             | Sem essas quatro provas no commit do release: não promover                                                 |
| 7     | Produção                                                                                                                                                                | Fora deste plano de discovery; exige aprovação humana separada                                             |

O worker exige **as duas** flags: `PROJECT_CENTER_V2_WORKER_ENABLED=true` com
`PROJECT_CENTER_V2_ENABLED=false` não tem superfície de API nem outbox, e nada
executa. Confirmar sempre o par.

## 3. Verificação pós-mudança de flag

1. `describeFlags`/health: registrar o estado observado das duas flags.
2. Chamada autenticada a um endpoint v2: com as flags desligadas a resposta é
   `feature_disabled`, sem criação de observer, executor ou lease.
3. Confirmar que uma entrada de outbox pendente **não** foi processada (nenhum
   comando de processo novo, nenhum DDL novo).
4. Auditoria: registrar quem mudou a flag, quando e por qual janela.

## 4. Rollback de deploy (parar primeiro, diagnosticar depois)

1. `PROJECT_CENTER_V2_WORKER_ENABLED=false` — para novas execuções imediatamente.
2. `PROJECT_CENTER_V2_ENABLED=false` — remove a superfície v2.
3. **Preservar** operation store, outbox, leases, audit e bindings do secret
   broker para investigação e reconciliação. Nada de limpeza destrutiva.
4. **Não remover** automaticamente database, role, volume, stack, backup ou
   secret criado pela operação. A remoção de recursos é um fluxo próprio:
   `rollback/dry-run → rollback/approval → rollback/execute`, com hash novo e
   aprovação própria (nunca reaproveitando a aprovação da criação).
5. Operação sem ownership/drift comprovado termina em
   `manual_intervention_required` — e isso é o comportamento desejado.
6. Revalidar saúde e rotas legadas antes de encerrar a janela.

## 5. Rollback de recursos (o que o gate já provou)

- O plano de rollback tem **hash próprio** e exige aprovação própria; a
  aprovação da criação não serve.
- Recurso com proveniência comprovada (`created_by_operation_id` igual à
  operação + `ownership_marker` + mesmo projeto/ambiente/driver) é removido.
- Recurso pré-existente ou sem marcador **nunca** é removido: vai para a lista
  `manual` e a execução é recusada com `MANUAL_INTERVENTION_REQUIRED` antes de
  qualquer comando.
- A ordem canônica coloca `disable_resource` antes de qualquer `drop`.
- O alvo efémero de restore é destruído no fim; alvo órfão é falha, não aviso.

## 6. Ponto obrigatório de atenção operacional — remoção de role

**Achado P7-01 (crítico), medido em harness efémero real:** o kind
`drop_resource_created_by_operation` aceita os prefixos `role:` e `app-role:`,
mas o template `postgresql_isolated:drop_resource_created_by_operation` tem SQL
fixo em `DROP DATABASE IF EXISTS {{database}} WITH (FORCE)`. Uma ação de
rollback com alvo `role:<app_role>` portanto **apaga o database do projeto em
vez da role**, e a role permanece órfã.

Consequências operacionais, enquanto o defeito não for corrigido:

1. Um rollback que inclua o alvo `role:` remove o database e **deixa a role**.
   Um reprovisionamento posterior falha em `role already exists` e escala para
   `manual_intervention_required`.
2. Nunca tratar "rollback concluído" como "recursos limpos": conferir a role
   por consulta própria ao catálogo do cluster antes de fechar a janela.

Remediação mínima de janela (manual e auditada, nunca automática):

1. Confirmar, por consulta ao catálogo, que a role não é dona de database nem
   de objeto de outro projeto (`pg_database`, `pg_roles`, `pg_shdepend`).
2. Rodar `DROP ROLE IF EXISTS <app_role>` **como provisionador dedicado**, com
   janela aberta e registro de auditoria (quem, quando, operação de origem).
3. Registrar o passo manual na reconciliação da operação e manter as flags
   desligadas até o defeito ser corrigido e revalidado.

## 7. Operação em `manual_intervention_required`

1. Não relançar a operação como está: a causa raiz precisa ser identificada
   (conflito de recurso pré-existente, ownership divergente, drift de revisão).
2. Reconciliação em três passos: observar o cluster real, comparar com o plano
   (`plan_hash`) e o inventário esperado, decidir entre rollback aprovado ou
   nova operação a partir de estado limpo.
3. Toda decisão fica registrada na auditoria da operação; a última palavra é do
   operador, não do worker.

## 8. Gate automatizado (reprodutível)

```bash
pnpm project-center:v2:contract   # OpenAPI/refs/rotas/estados/flags
pnpm project-center:v2:scan       # segredos, paths e tokens por classe de risco
pnpm project-center:v2:gate       # contrato + scan + testes escopados
PROJECT_CENTER_V2_TEST_HARNESS=1 pnpm project-center:v2:harness
```

O harness só roda com opt-in explícito (`PROJECT_CENTER_V2_TEST_HARNESS=1`),
cria container/volume/porta exclusivos derivados de um UUID, recusa ambiente,
host e path de produção, e remove tudo no fim (inclusive clientes efémeros
presos por timeout). Sem o opt-in o processo sai com código 2 e não toca nada.

## 9. O que ainda não é executável neste ambiente

- **Stack Supabase real** (`supabase_isolated`): o executor exige uma
  implementação de `StackAdapter` e uma porta de projeção que o repositório não
  contém — o PR 6 as deixa para o deployment. O template `sb-stack-full` exige
  os seis serviços (`gotrue`, `storage`, `realtime`, `postgrest`, `gateway`) com
  imagens pinadas por digest ausentes neste host. Provas reais desse driver
  continuam pendentes e bloqueiam ativação.
- **Lease store durável** do deployment: a prova usa o store em memória
  declarado no PR 6 como fixture de referência.
- **Destino R2 real**: proibido nesta fronteira; a prova usa a porta de destino
  local com prefixo dedicado.
