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

## Domínios e Integração CRM
- **CRM Ports (`createCrmPorts`)**: interfaces desacopladas (`LeadProvider`, `ContactProvider`, `CompanyProvider`, `OpportunityProvider`, `ActivityProvider`, `PipelineProvider`) compatíveis com Deskcomm, HubSpot, Pipedrive ou adaptadores locais.
- **SalesAutonomy**: estados comerciais (`new` → `won`/`lost`), scoring determinístico por fatores verificáveis, cadência adaptativa e personalização estritamente baseada em fatos reais.
- **SupportAutonomy**: diagnóstico, consulta à base, ação permitida e verificação real (distingue "mensagem enviada" de "problema confirmado resolvido").
