# Release 2.9.0 — fila durável e execução retomável do Copiloto

## Objetivo

Fechar a lacuna entre a IA entender uma solicitação, a ferramenta realmente executar e o resultado chegar ao responsável. O histórico conversacional continua sendo enviado ao modelo, mas agora não é usado como substituto de um registro operacional.

## O que muda

- **Fila persistente no Supabase:** cada tarefa tem ID, chave de idempotência derivada de um ID estável da mensagem WhatsApp, solicitante, pedido original, etapas, estado, resultado, tentativa, lease e estado de entrega. Sem ID de mensagem, a fila recusa o registro.
- **Worker de segundo plano:** o servidor reivindica tarefas atomicamente, executa etapas sequenciais e grava checkpoints. Uma tarefa não depende de o webhook original permanecer aberto.
- **Retomada após reinício:** consultas de leitura e criação de Pix estático podem ser recuperadas após expiração de lease. Etapas já concluídas não são executadas novamente.
- **Entrega recuperável:** resultado concluído fica salvo antes de a resposta ser enviada. Se o processo cair entre conclusão e envio, o worker recupera a entrega pendente. Uma entrega que ficou em estado \`sending\` além do prazo passa a \`uncertain\` e não é reenviada.
- **Consulta de andamento:** “onde está?”, “estou esperando” e variações consultam o último registro real da fila e apresentam estado/resultado. Não dependem de o modelo adivinhar a etapa.
- **Escolha Pix determinística:** “Direto”, “Pix direto”, “Copia e Cola” e “QR Code” são reconhecidos como resposta à pergunta de modalidade Pix/checkout, somente quando a mensagem anterior realmente oferece as duas opções. O contexto preservado fornece valor e descrição; a escolha direta não é convertida para InfinitePay.
- **Promessas verificáveis:** formas conjugadas e gerúndios como “estou gerando” ou “entendido, pesquisando” não são apresentados como operação iniciada sem resultado de ferramenta ou ID de tarefa persistida.
- **Cancelamento:** o responsável pode cancelar a tarefa ativa; o cancelamento só é confirmado após a RPC atualizar o estado e invalidar o lease. Se o cancelamento não for confirmado, o contexto permanece visível.

## Estados da tarefa

| Estado | Significado |
| --- | --- |
| \`queued\` | Registrada e aguardando worker |
| \`running\` | Worker executando etapa com lease |
| \`awaiting_input\` | Falta informação ou confirmação |
| \`succeeded\` | Todas as etapas concluíram |
| \`failed\` | Falha reportada pelo executor |
| \`uncertain\` | Não há prova segura do resultado; exige conferência |
| \`cancelled\` | Cancelada |

A entrega tem estado próprio: \`pending\`, \`sending\`, \`sent\`, \`uncertain\` ou \`skipped\`.

## Escopo do worker e segurança

O worker só aceita planos de até quatro etapas que passaram pela validação do catálogo e por uma allowlist de ações de baixo risco:
- Consultas de leitura, incluindo busca web, saúde/infra, contato, base de conhecimento, agenda de leitura, Sheets de leitura e Drive de busca/listagem.
- Pix estático para gerar o código e o link. O worker força \`enviarWhatsApp=false\` e usa TXID determinístico por ID de tarefa; o resultado (Copia e Cola e link) é entregue ao responsável pela saída única do worker.

Criação de checkout InfinitePay, gravações em CRM/Sheets, criação/cancelamento de agenda, envio de mensagens/arquivos, alterações de memória/configuração e mudanças de código continuam fora do worker genérico. Esses fluxos preservam as confirmações e proteções existentes. Não se tenta converter qualquer chamada de ferramenta em job assíncrono indiscriminadamente.

Uma falha em consulta termina como falha visível; uma queda do processo durante uma etapa marcada como segura pode ser retomada. Operações externas incertas nunca recebem retry automático. A auditoria registra evento, ator, ferramenta/estado e duração sanitizados, sem guardar conteúdo de mensagem ou parâmetros em claro.

## Pré-requisito de banco

**Aplicar antes de implantar o código:**

\`supabase/migrations/20261120160000_copilot_tasks.sql\`

A migration cria \`public.copilot_tasks\`, os índices, RLS sem policies e as RPCs de claim/lease/checkpoint/finalização/entrega. O runtime valida a existência da tabela na inicialização. Se a migration não tiver sido aplicada, registra o motivo e mantém o fluxo legado; não afirma que a fila está ativa.

Não é necessário reiniciar manualmente o Supabase. A migration é aditiva e deve ser aplicada pelo SQL Editor/fluxo de migrations já usado no ambiente.

## Auditoria e validação

Testes novos cobrem:
- escolha contextual “Direto” versus checkout;
- reconhecimento de pedidos de andamento;
- allowlist de etapas background e bloqueio de efeitos externos;
- TXID estável e Pix sem envio incidental de imagem;
- idempotência do enqueue inclusive quando a resposta do INSERT se perde;
- checkpoints sequenciais;
- retomada de uma entrega cujo resultado já está persistido;
- bloqueio de retry quando a entrega ao WhatsApp fica incerta.

A suíte completa, lint, build, contrato e publicação Docker devem ser confirmados no GitHub Actions do PR. A publicação da imagem e o deploy na VPS só ocorrem depois dos checks aprovados e do merge.

## Limites conhecidos

- O worker processa uma tarefa por tick por processo; o claim transacional suporta várias réplicas sem executar a mesma tarefa ao mesmo tempo.
- Planos têm no máximo quatro etapas.
- Apenas operações explicitamente classificadas como seguras entram na fila genérica.
- Tarefas dependem do Supabase service role; não há fallback local que simule durabilidade distribuída.
- Mensagens de WhatsApp não oferecem garantia de exactly-once após timeout do provedor. A arquitetura usa estado de entrega \`uncertain\` e bloqueia repetição cega, privilegiando não duplicar.
