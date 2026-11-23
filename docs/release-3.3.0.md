# Release 3.3.0 — Ciclo Operacional Autônomo, Revisão Humana e Idempotência

Data: 2026-11-23

## Resumo

A versão 3.3.0 conecta a revisão operacional já existente ao scheduler do servidor e fecha o fluxo de solicitação de revisão humana. O foco é gestão interna: acompanhar objetivos, compromissos e saúde operacional, criar/monitorar agendamentos existentes e avisar o responsável quando uma decisão humana for necessária. **CRM permanece fora do escopo desta fase.**

## Revisão diária do Runtime

O scheduler dedicado do Runtime desperta a cada 15 segundos. Depois do horário `owner_preferences.digestHour` (padrão: 09:00), considera o fuso da configuração de expediente ativa e chama `runDailyReview` no máximo uma vez por data local em cada instância. Se o fuso configurado for inválido, usa `America/Sao_Paulo`.

A revisão consulta objetivos ativos, compromissos pendentes/atrasados/incertos e sinais de saúde operacional. Só produz resumo se houver um motivo real; quando não há trabalho relevante, grava uma revisão suprimida para não repetir consultas e não enviar mensagens artificiais. A data da chave de deduplicação é calculada no fuso configurado.

## Solicitação de revisão humana

Quando a avaliação de um evento indicar que é necessária intervenção humana, o Runtime envia ao administrador um aviso com o tipo do evento e um motivo conciso. O payload completo do evento não é incluído. Eventos de compromisso preservam a notificação específica que já existia.

O destinatário `owner:*` é roteado para o telefone humano configurado. As mensagens proativas passam por `filterReply` antes do envio. Uma notificação proativa da revisão diária é dirigida ao responsável, não ao cliente; isso não concede autorização nova para mensagens externas.

## Persistência e idempotência

A Lia grava uma reserva em `lia_proactive_notifications` **antes** de enviar. A chave `deduplication_key` única permite que apenas uma réplica Supabase reivindique cada notificação; status finais registram `sent`, `failed` ou `suppressed`. Uma reserva existente impede duplicatas após restart ou em execuções concorrentes. O armazenamento local persiste a reserva para uma instância única; não deve ser tratado como coordenação multi-réplica.

Não há migration nova nesta versão. O fluxo reutiliza `lia_proactive_notifications` da migration `supabase/migrations/20261121150000_lia_autonomy.sql`. Se Supabase estiver configurado e a camada de autonomia não estiver disponível, a operação falha fechado em vez de enviar sem deduplicação persistente.

## Escopo e salvaguardas

- O ciclo autônomo 3.3.0 não lê nem altera CRM. CRM Ports e funções existentes no produto continuam fora deste escopo.
- Follow-ups já previstos no sistema permanecem sujeitos à política organizacional, opt-out/suppression, horário de atendimento, limites diários e orçamento.
- Pagamentos, ações irreversíveis, efeitos externos incertos, alterações de segurança/permissões e deploy continuam exigindo confirmação humana ou bloqueados.
- A rotina diária observa e informa; ela não transforma alertas em autorização para executar ações.

## Arquivos e versão

A versão 3.3.0 é refletida no `package.json`, `package-lock.json`, `metadata.json`, etiqueta do painel, identidade Runtime padrão, README, CHANGELOG, arquitetura, guias técnicos e base exclusiva de autoconhecimento do Copiloto. Identidades já persistidas com versão explícita são preservadas, sem sobrescrita automática. Nenhuma migration é necessária para ambientes que já aplicaram a migration do Autonomy Engine.

## Validação

A suíte de testes, lint, build e verificações de contrato foram executados localmente nesta branch. CI do GitHub Actions e publicação da imagem no GHCR não foram executados nesta branch; dependem de eventual merge em `main`. Publicar a imagem não representa, por si só, deploy da aplicação.
