# Release 2.9.0 — Execução persistente do Copiloto

## Objetivo

Separar a compreensão conversacional da execução operacional. Uma resposta do modelo ou uma frase como “estou gerando” nunca é tratada como prova de que uma ferramenta foi executada.

## Arquitetura

- `src/copilot-tasks.mjs`: fila persistente, chave idempotente por mensagem/plano, leases, checkpoints e estados terminais.
- `src/copilot-task-worker.mjs`: worker independente iniciado pelo servidor, execução sequencial limitada a quatro etapas, verificação de resultado e notificação terminal.
- `src/flow/owner.mjs`: registra planos elegíveis, reconhece escolhas de modalidade Pix e consulta o estado real quando o responsável pergunta onde está o resultado.
- `src/flow/copilot-continuity.mjs`: interpretação determinística de respostas curtas dependentes da pergunta anterior.
- `src/flow.mjs` e `src/server.mjs`: injeção da fila e ciclo de vida do worker.
- `supabase/migrations/20261120150000_copilot_task_queue.sql`: tabela backend-only e RPC atômica de claim com `FOR UPDATE SKIP LOCKED`.

## Estados

`queued`, `running`, `awaiting_input`, `succeeded`, `failed`, `uncertain` e `cancelled`. O estado da notificação é controlado separadamente (`pending`, `sending`, `sent`, `uncertain` ou `unaddressable`).

Cada tarefa registra solicitante, destino de retorno, pedido resumido, plano, política de repetição, tentativas, etapa atual, resultado, erro sanitizado, timestamps e lease. A chave da tarefa impede que o mesmo evento de mensagem e plano seja enfileirado duas vezes.

## Política de execução

O worker só aceita uma allowlist de consultas seguras e operações Pix explicitamente autorizadas pelo fluxo. Revalida se a ferramenta continua habilitada antes de executá-la. A fila não é uma autorização: o fluxo original ainda valida intenção, argumentos, identidade do responsável e política da ferramenta.

- Consultas somente-leitura podem voltar à fila após expiração de lease, respeitando o limite de tentativas.
- Criação de cobrança Pix não é repetida automaticamente. Se o lease expirar ou o resultado não puder ser confirmado, a tarefa vira `uncertain`.
- Mensagens externas, atualizações de CRM, alterações de agenda, publicação de configuração e mudanças de código não são movidas para o worker genérico.
- Uma falha terminal ou resultado incerto é persistido e notificado. Falha de entrega da notificação também vira `uncertain`; não há reenvio automático após resultado ambíguo.
- A notificação é enviada ao número configurado do responsável em dígitos, nunca ao JID bruto recebido da Evolution.

## Supabase e fallback

Aplicar a migration `20261120150000_copilot_task_queue.sql` no SQL Editor do projeto Supabase do bot. A tabela `copilot_tasks` tem RLS habilitado, sem acesso para `anon` ou `authenticated`, e grants somente para `service_role`.

Quando o Supabase está configurado e a tabela existe, o banco é a fonte distribuída e a RPC faz o claim atômico entre réplicas. Se a migration ainda não estiver aplicada, o runtime usa `data/copilot-tasks.json` como fallback local de uma única instância e registra aviso. Esse fallback não oferece coordenação multi-réplica.

Não aplicar a migration automaticamente pelo processo Node. Conferir o histórico do banco e aplicar explicitamente.

## Operação

Após deploy:
1. Confirmar que o log indica fila Supabase ativa (não fallback local).
2. Consultar `/ready` e logs do worker.
3. Testar uma consulta web de baixo risco e confirmar que o resultado chega ao responsável.
4. Perguntar “estou esperando” e confirmar que o estado vem da tabela, não de inferência do modelo.
5. Testar falha de consulta e confirmar notificação terminal.
6. Em ambiente de homologação, testar lease expirado para leitura e para Pix; leitura pode ser retomada, Pix deve ficar incerto sem nova cobrança.

## Limitações conhecidas

- O worker genérico é deliberadamente limitado a consultas permitidas e geração Pix direta; ferramentas com escrita externa ou confirmação específica continuam no fluxo síncrono protegido.
- O fallback JSON é somente para uma instância. Para múltiplas réplicas, a migration Supabase é obrigatória.
- Um lease expirado durante uma chamada externa pode deixar o resultado incerto; não existe garantia universal de exactly-once em APIs externas. A proteção é não repetir ações com efeito financeiro ou de entrega.
- A confirmação de envio da notificação representa aceitação pelo transporte; não substitui recibo de leitura/entrega do WhatsApp.

## Validação

A suíte acrescenta cobertura para:
- escolha curta “Direto” no contexto da pergunta de modalidade;
- “estou esperando” e consulta de status;
- idempotência da fila, persistência local, claim, checkpoint e expiração de lease;
- retomada de leitura sem repetir cobrança;
- notificação de sucesso e de falha terminal;
- allowlist de ferramentas de segundo plano.

Executar `npm ci`, `npm run lint`, `npm run build`, `npm test` e `npm run test:contract`. A migration deve ser aplicada no Supabase antes de considerar a coordenação distribuída ativa.
