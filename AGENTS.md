# Regras do projeto
- Não versionar `.env`, tokens, credenciais ou dados de clientes.
- A landing page não faz parte deste projeto e não deve ser alterada.
- Toda resposta passa por `filterReply`; nunca diagnosticar, prescrever medicamento/dose/remédio caseiro ou dar prognóstico.
- Emergência e transferência usam exclusivamente `triggerHandoff`; não usar tags de transferência no histórico.
- Sessões reais usam telefone e simulações usam `sim:<telefone>`; nunca misturar namespaces.
- Valores só podem vir do CRM/Supabase e devem passar pelo filtro de preços.
- Webhook sem token falha fechado; mudanças exigem health check e rollback documentado.
- Logs não devem conter texto do cliente nem telefone completo.
