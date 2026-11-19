# Release 2.8.0 — Continuidade natural do Copiloto

## Resumo

A versão 2.8.0 melhora a continuidade conversacional do Copiloto Executivo. A Lia passa a tratar uma solicitação operacional como uma tarefa contextual, preservando o pedido original, a última pergunta, o tipo de tarefa e as ferramentas relacionadas enquanto ainda houver dados pendentes.

A release também adiciona revisão semântica de chamadas de ferramentas, suporte à transcrição de áudio recebido no chat interno e persistência segura do contexto de continuidade no Supabase.

## Principais mudanças

### Tarefas ativas e contexto

O Copiloto mantém `pendingCopilotTask` durante uma tarefa em andamento. O estado pode conter:

- `type`: categoria operacional, como pagamento, envio, agenda ou documento;
- `originCommand`: pedido original resumido;
- `lastQuestion`: última pergunta feita pela Lia;
- `turns` e `repeatCount`: controle limitado da progressão da conversa;
- `allowedTools`: ferramentas relacionadas ao contexto, sem autorização automática para execução.

Tarefas antigas expiram após 30 minutos. A persistência normaliza os campos, limita o tamanho das listas e rejeita tipos desconhecidos.

### Revisão semântica de ferramentas

O módulo `src/flow/copilot-continuity.mjs` revisa uma chamada de ferramenta quando a ligação com a mensagem atual não é explícita. A chamada pode ser classificada como:

- `continuation`: continuação da solicitação ativa;
- `new_request`: novo pedido que substitui o anterior;
- `clarify`: é necessário esclarecer o próximo passo;
- `unrelated`: não há relação segura com a tarefa atual.

Uma classificação incerta não executa a ferramenta. A Lia preserva o contexto quando possível e faz uma pergunta objetiva.

A lista `allowedTools` serve como contexto histórico. Ela não substitui a confirmação de dados nem autoriza uma execução isolada.

### Esclarecimentos e pagamentos

Frases como “não entendi”, “pode explicar?”, “como assim?” e “pode detalhar?” são tratadas como pedidos de esclarecimento. Durante um fluxo de pagamento, elas não geram cobrança Pix ou checkout automaticamente.

O mesmo princípio vale para mensagens que apenas pedem explicação durante envio de mensagem, agenda, documento, CRM ou transferência de setor.

### Áudio no chat interno

Quando o responsável envia um áudio ao Copiloto, o motor tenta transcrevê-lo antes de interpretar o comando. O áudio transcrito entra no histórico com indicação de origem.

Se não houver transcrição confiável, a Lia solicita que o responsável reenvie o áudio ou resuma o pedido por texto. Ela não presume o conteúdo nem dispara uma ação baseada em transcrição inexistente.

### Segurança e isolamento

A base `data/knowledge-bases/autoconhecimento/lia-autoconhecimento-operacoes.md` continua marcada como `copilot-only` e não é disponibilizada para clientes. O contexto de tarefas é armazenado na sessão do responsável e não é usado para autorizar ações em sessões externas.

As regras existentes continuam válidas:

- toda saída passa por `filterReply`;
- ações importantes dependem de dados suficientes e do resultado real da ferramenta;
- valores, pagamentos, horários e confirmações não são inventados;
- cancelamento limpa estados pendentes para impedir execução tardia;
- envios ambíguos não são repetidos automaticamente.

## Arquivos principais

- `src/flow/copilot-continuity.mjs`: revisão semântica de continuidade e relação de tool calls;
- `src/flow/owner.mjs`: manutenção do contexto ativo, transcrição de áudio e barreiras antes da execução;
- `src/ai/call.mjs`: chamadas de revisão sem ferramentas quando a análise semântica é necessária;
- `src/supabase-runtime.mjs`: normalização e persistência de `pendingCopilotTask`;
- `data/knowledge-bases/autoconhecimento/lia-autoconhecimento-operacoes.md`: manual operacional atualizado para a versão 2.8.0.

## Operação e deploy

O diretório ativo da VPS permanece `/home/ubuntu/lia-assistente`, com o serviço Compose `bot` e o contêiner `lia-bot`. Atualizações de código devem preservar `.env`, `data/` e `backups/`. O `rsync` de deploy deve excluir explicitamente `backups/` para não tentar acessar diretórios protegidos.

Após a atualização, validar:

```bash
sudo docker compose ps
curl -i http://127.0.0.1:3000/ready
sudo docker compose exec -T bot node -p "require('./package.json').version"
```

O readiness pode retornar `503` enquanto Evolution API, Supabase ou o provedor de IA não estiverem prontos. Nesse caso, analisar o corpo da resposta e os logs do serviço antes de reiniciar repetidamente o contêiner.

## Validação

A release foi validada com:

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:contract
```

A suíte local atual possui 350 testes aprovados. O commit publicado no GitHub também concluiu com sucesso os checks `validate` e `publish-docker`.

## Compatibilidade

A versão mantém Node.js 22 ou superior, as variáveis de ambiente existentes, a estrutura do Supabase e os contratos públicos anteriores. A mudança de versão é documental e de contexto de sessão; não exige migration de banco para continuar funcionando com sessões antigas.
