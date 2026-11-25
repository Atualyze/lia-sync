# Reconciliação do histórico de migrations do Supabase

**Status: pendente de reconciliação — não executar `db push` em produção.**

Este documento registra uma divergência detectada na revisão de produção em **25/11/2026**. A aplicação continua operando; esta pendência trata da capacidade de reproduzir e evoluir o schema de forma segura.

## Evidências observadas

- O repositório contém **22 arquivos SQL** em `supabase/migrations/`.
- O histórico consultado no projeto Supabase contém **13 versões** em `supabase_migrations.schema_migrations`.
- O banco já contém objetos de versões recentes, incluindo `copilot_tasks`, `runtime_projections`, `lia_runtime_state`, `payment_orders` e `lia_proactive_notifications`.
- Há divergências de timestamp entre alguns arquivos versionados e as versões registradas. Exemplos por nome/assunto:
  - `campaigns_bridge`: arquivo `20261112210000`, histórico `20261112235602`;
  - `phone_suppressions`: arquivo `20261112220000`, histórico `20261112235858`;
  - `operations_observability`: arquivo `20261113000000`, histórico `20261113134613`;
  - `prospecting`, `sync_archive` e `review_hardening`: os nomes registrados usam versões diferentes das versões dos arquivos.
- As migrations de Runtime, Learning, Autonomy, Copilot e pagamentos não aparecem todas como versões no histórico consultado, embora suas tabelas principais existam no banco.

Essas evidências demonstram **drift de histórico**, mas não demonstram, por si só, que o schema esteja incorreto. A presença de uma tabela também não comprova que todas as colunas, constraints, índices, policies, funções e triggers de uma migration estejam aplicados.

## Regras até concluir a reconciliação

1. Não executar `supabase db push` diretamente no projeto de produção.
2. Não inserir linhas em `supabase_migrations.schema_migrations` manualmente.
3. Não usar `supabase migration repair --status applied` para versões que ainda não foram comparadas com o schema real.
4. Não reaplicar migrations antigas apenas para “alinhar” o histórico.
5. Não apagar ou renomear arquivos de migration já versionados.

## Procedimento seguro

### 1. Congelar alterações de schema

Manter a aplicação em operação e evitar mudanças DDL até concluir a comparação. Correções de aplicação sem alteração do schema podem continuar em PRs normais.

### 2. Capturar o estado real

Usar a Supabase CLI em ambiente de trabalho controlado e consultar a ajuda da versão instalada antes de executar comandos:

- conferir o vínculo do projeto e o histórico remoto;
- obter uma representação somente de schema do banco remoto;
- preservar esse snapshot em local seguro, sem dados de clientes;
- registrar tabelas, colunas, tipos, defaults, constraints, índices, policies, grants, funções e triggers.

Não exportar conteúdo de conversas, telefones ou outros dados pessoais para o snapshot.

### 3. Comparar migration por migration

Para cada arquivo do repositório, classificar como:

- **aplicada e equivalente**: todos os objetos esperados estão presentes e equivalentes;
- **aplicada parcialmente**: existem diferenças em colunas, constraints, índices, policies ou funções;
- **não aplicada**: os objetos esperados não existem;
- **legado/renomeado**: a intenção está representada por outra migration; a equivalência SQL ainda precisa ser demonstrada.

Não considerar apenas o nome da tabela ou da migration para declarar equivalência.

### 4. Definir a estratégia de alinhamento

Depois da comparação, escolher e documentar um destes caminhos:

- reparar o histórico somente para migrations comprovadamente aplicadas;
- criar uma baseline versionada do schema atual e definir o ponto de partida de novos ambientes;
- criar migrations corretivas aditivas para diferenças reais.

O caminho escolhido deve ser testado em um banco descartável/staging antes de tocar na produção.

### 5. Validar o bootstrap limpo

Executar toda a sequência de migrations em um banco vazio de teste e comparar o schema produzido com o schema esperado. Também validar que a aplicação sobe e passa por testes de contrato e readiness.

### 6. Só então liberar mudanças futuras

Após revisão, registrar:
- a relação entre versão do arquivo e versão aplicada;
- quais migrations são baseline/legadas;
- o procedimento de deploy e rollback;
- a prova de que o schema novo equivale ao schema de produção.

## Critério para encerrar

A pendência só pode ser encerrada quando:

- cada migration do repositório estiver classificada;
- cada versão remota estiver associada a uma migration ou documentada como legado;
- a sequência de bootstrap em banco limpo funcionar;
- não houver DDL pendente não explicado;
- a comparação e os testes estiverem anexados à revisão.

**Nenhuma alteração foi feita no schema ou nos dados de produção durante a auditoria.**
