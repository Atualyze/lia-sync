# Lia Autonomy Engine (`src/autonomy/`)

O **Autonomy Engine** conecta percepção, objetivos, atenção, aprendizado, permissões, presença, verificação e execução segura em um ciclo contínuo e auditável.

## Como a Lia decide agir

Toda iniciativa relevante produz um **Autonomy Decision Contract** auditável (`audit.recordDecision`) contendo:
`why`, `goal`, `event`, `context`, `proposed_action`, `expected_outcome`, `risk`, `authorization`, `confidence`, `verification_plan`, `verification`, `outcome` e `learning`.

### Como auditar uma decisão
Consulte `app.liaAutonomy.getAuditTrail({ tenantId, limit })` e `app.liaAutonomy.getMetrics()`. Cada registro preserva a cadeia completa desde o evento/objetivo até a autorização, verificação e experiência registrada.

## Presença e Comunicação Proativa
- **PresenceEngine** (`available`, `observing`, `working`, `waiting`, `blocked`, `needs_human`, `completed`, `recovering`) representa o estado real sem gerar mensagens vazias.
- **CommunicationGuard** aplica validação de motivo real, deduplicação por `deduplicationKey`, cooldown por destinatário e teto diário antes de qualquer comunicação proativa.
- **Daily Review (`runDailyReview`)** acorda periodicamente, prioriza objetivos com proteção anti-starvation e dorme silenciosamente se não houver motivo real.

## Ciclo operacional da versão 3.3.0

O scheduler do servidor chama `runDailyReview` depois do horário configurado em `owner_preferences.digestHour` (padrão 09:00), usando o fuso de atendimento e no máximo uma vez por data local. A revisão observa objetivos ativos, compromissos e saúde operacional; não executa uma ação externa só por encontrar uma pendência.

Comunicações proativas exigem motivo real, destinatário resolvido e passam pelo filtro de saída. Eventos que pedem intervenção humana notificam o responsável com tipo e motivo, nunca com o payload completo. `owner:*` é resolvido para o telefone do administrador.

Antes de enviar, o store reivindica a `deduplication_key` em `lia_proactive_notifications`. No Supabase, a restrição única coordena réplicas; em fallback local, a persistência cobre reinicializações de uma única instância. Reservas existentes (inclusive sem pendências) impedem que o ciclo seja repetido no mesmo dia. Se a deduplicação estiver indisponível, o envio falha fechado.

### Escopo explícito: sem CRM

CRM está fora do escopo desta fase de autonomia, embora existam CRM Ports e recursos comerciais legados no produto. O motor não deve ler ou alterar CRM como parte deste ciclo. Follow-ups já existentes só podem ocorrer quando as políticas organizacionais e guardas (opt-out/suppression, expediente, limites e autorização) permitirem. Pagamentos, efeitos incertos, ações irreversíveis, segurança/permissões e deploy continuam bloqueados ou exigem confirmação humana.

## Domínios e Integração CRM
- **CRM Ports (`createCrmPorts`)**: interfaces desacopladas (`LeadProvider`, `ContactProvider`, `CompanyProvider`, `OpportunityProvider`, `ActivityProvider`, `PipelineProvider`) compatíveis com Deskcomm, HubSpot, Pipedrive ou adaptadores locais.
- **SalesAutonomy**: estados comerciais (`new` → `won`/`lost`), scoring determinístico por fatores verificáveis, cadência adaptativa e personalização estritamente baseada em fatos reais.
- **SupportAutonomy**: diagnóstico, consulta à base, ação permitida e verificação real (distingue "mensagem enviada" de "problema confirmado resolvido").
