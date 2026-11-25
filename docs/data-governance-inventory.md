# Inventário de dados pessoais e retenção — Lia Sync

**Tipo:** inventário técnico e plano de governança.  
**Última verificação do schema:** 25/11/2026.  
**Importante:** este documento não substitui a definição jurídica de finalidade, base legal, prazos, aviso de privacidade ou contratos com operadores.

## 1. Dados que a aplicação persiste

| Área | Campos/categorias observados | Finalidade operacional |
|---|---|---|
| Contatos (`contacts`) | telefone, identificador do canal, nome exibido, nome do WhatsApp, notas, metadata e datas de primeiro/último contato | identificar o contato e recuperar contexto |
| Conversas (`conversations`) | identificador externo, contato, nome, estado, modo bot/humano, intenções, handoff, motivo/urgência, timestamps, follow-up, metadata e legal hold | continuidade do atendimento e coordenação humana |
| Mensagens (`conversation_messages`) | conteúdo textual, remetente/role, tipo, status de entrega, provider/model e metadata | histórico e auditoria operacional da conversa |
| Pedidos (`payment_orders`) | telefone, nome, valor, valor pago, descrição, método, URLs, identificadores de transação, status e metadata | criação e conciliação de cobranças/pagamentos |
| Relacionamento (`lia_relationships`) | preferências, melhores horários, interesses, objeções, padrões de resposta, estágio comercial, sensibilidade, frequência e última interação | personalização e continuidade comercial |
| Memória explícita | conteúdo curto, categoria e scope por tenant/telefone; arquivo local `data/memories.json` | lembrar preferências, projetos e decisões explicitamente registradas |
| Tarefas do Copiloto (`copilot_tasks`) | pedido resumido, telefone de destino, passos/ferramentas, status, resultado e reconciliação | executar tarefas longas e notificar o responsável |
| Autonomia (`lia_proactive_notifications`) | assunto, motivo, status e chave de deduplicação | controlar notificações proativas |
| Auditoria (`audit_log`) | ator, ação, entidade, metadata e timestamp | rastreabilidade administrativa |
| Telemetria de IA (`ai_calls`) | provider/model, tokens, latência, intenção, sucesso/erro e timestamp | custo, desempenho e diagnóstico |
| Ledger de webhooks (`webhook_events`) | chave derivada/hash, tipo, instância, estado, tentativas e timestamps | deduplicação e diagnóstico sem guardar payload bruto |

O schema confirma que `contacts`, `conversations`, `conversation_messages` e `payment_orders` contêm identificadores pessoais ou financeiros. A presença de uma coluna `metadata` ou `result_text` exige que a aplicação continue a limitar e sanitizar o conteúdo gravado.

## 2. Onde os dados ficam

- O Supabase/PostgreSQL guarda contatos, conversas, mensagens, pedidos de pagamento e dados operacionais.
- O processo Node mantém arquivos persistentes locais em `/app/data`, incluindo sessões/archives, autenticação do WhatsApp e memória explícita.
- A memória explícita é separada por tenant/contato e possui ações de consultar, salvar, corrigir e esquecer. O código também rejeita padrões comuns de CPF, CNPJ, cartão e segredos antes de salvar memória.
- O transporte de WhatsApp e os provedores de IA recebem os dados necessários para entregar a mensagem e gerar a resposta. Integrações Google e o provedor de pagamento recebem os dados usados nas operações solicitadas.

Não foi identificado bucket de Storage ou Edge Function ativo na verificação do projeto em 25/11/2026. Isso não significa que nenhum fornecedor externo processe dados: WhatsApp, IA, Google e pagamento continuam sendo operadores/terceiros relevantes.

## 3. Retenção que o código já implementa

| Categoria | Comportamento observado | Ponto de atenção |
|---|---|---|
| Sessões locais | TTL padrão de 30 dias por inatividade; handoff humano recente e legal hold têm proteção | validar a política com a necessidade de atendimento |
| Conversas arquivadas | limpeza remota após o TTL padrão (30 dias), respeitando legal hold | exclusão em cascata remove mensagens vinculadas |
| Conversas fechadas | não entram no expurgo padrão de archives | permanecem até ação específica; definir prazo |
| Registros com soft-delete | exclusão física após o TTL, respeitando legal hold | validar sincronização com o sistema de origem |
| `ai_calls` | 90 dias | evitar ampliar conteúdo técnico para incluir prompts |
| `webhook_events` | 30 dias | ledger guarda hash/estado, não payload de mensagem |
| `idempotency_keys` | padrão de 24 horas | prazo operacional, não histórico de cliente |
| Memória explícita | sem expiração temporal identificada; arquivo limita a 1.000 entradas e permite esquecer manualmente | definir expiração, revisão e exclusão por titular |
| Contatos, pedidos de pagamento, auditoria, relacionamentos e tarefas do Copiloto | não foi localizada política automática de retenção equivalente | definir prazo e procedimento antes de expurgar |

A limpeza local e remota não deve ser tratada como um processo único: a sincronização com o PostgreSQL, o status da conversa, o legal hold e os dados financeiros precisam ser considerados na mesma solicitação de exclusão.

## 4. Controles já presentes

- RLS habilitado em todas as tabelas públicas.
- Acesso direto às tabelas internas restrito; as tabelas backend-only não concedem acesso a `anon` ou `authenticated`.
- A chave privilegiada do Supabase é consumida no servidor e não deve ser publicada no navegador.
- Auditoria de execução de ferramentas registra metadata sanitizada; argumentos, conteúdo de mensagens e telefones completos não entram nessa trilha.
- Logs passam por mascaramento de segredos.
- Opt-out/supressão de prospecção possui tabela própria.
- Legal hold impede o expurgo automático de conversas protegidas.
- Memória explícita rejeita padrões comuns de dados financeiros/de autenticação.

Esses controles reduzem exposição, mas não substituem uma política de retenção, atendimento aos direitos dos titulares ou revisão de acesso por funcionário.

## 5. Pendências de governança

### P1 — Definições necessárias antes de ampliar a operação

1. Definir finalidade e prazo de retenção por categoria: contato, conversa aberta, conversa fechada, mensagem, pedido financeiro, auditoria, tarefa, relacionamento e memória.
2. Definir um fluxo autenticado para localizar, exportar, corrigir e excluir dados de um titular, com tratamento de vínculos entre contato, conversas, mensagens, memória, relacionamento e pedidos.
3. Definir quando uma memória de cliente pode ser criada, revisada, expirada e esquecida; preferir dados úteis e não sensíveis.
4. Documentar os provedores que recebem dados, finalidade, região/processamento, retenção e contrato aplicável.
5. Revisar os textos de privacidade e o mecanismo de aviso/consentimento aplicável ao canal e às campanhas.
6. Confirmar quais dados financeiros devem ser preservados para conciliação/obrigações legais antes de definir expurgo de `payment_orders`.

### P2 — Melhorias de engenharia

- Criar política central de retenção por entidade, evitando prazos espalhados em vários módulos.
- Criar testes para expurgo, legal hold, exclusão em cascata e não exclusão de registros protegidos.
- Criar relatório de dados por telefone/contato sem expor o conteúdo em logs.
- Adicionar revisão de metadata e payloads antes de novas tabelas armazenarem dados livres.
- Definir limites e TTL para `copilot_tasks` e `lia_relationships`.

## 6. Supabase Auth — limitação do plano atual

O Security Advisor sinaliza `auth_leaked_password_protection`. O projeto está no plano Free; a documentação atual do Supabase informa que a verificação de senhas vazadas pelo HaveIBeenPwned está disponível somente nos planos Pro e superiores.

No plano atual, a ação disponível é reforçar a configuração do provedor Email com comprimento mínimo de senha maior (recomendação operacional: 12 caracteres) e requisitos de composição. A opção de proteção contra senhas vazadas só pode ser ativada após mudança de plano. Não é uma migration SQL.

Referência: https://supabase.com/docs/guides/auth/password-security

## 7. Limites desta revisão

Este inventário é técnico e baseado no código e no schema observado. Não é uma auditoria jurídica LGPD, não comprova a base legal de cada tratamento e não confirma os contratos ou a retenção interna de cada provedor externo. Nenhum registro de cliente foi lido para elaborar este documento e nenhuma política de expurgo foi alterada.
