# Regras do Projeto - Lia Sync

- Não versionar `.env`, tokens, chaves de API, credenciais ou dados pessoais de clientes.
- Toda resposta gerada deve passar por `filterReply` (higienização, limites de caracteres e formatação WhatsApp).
- Transferência para atendimento humano deve usar exclusivamente `triggerHandoff`.
- Sessões reais usam `<telefone>` e simulações/testes usam `sim:<telefone>`; nunca misturar namespaces.
- Valores monetários específicos só podem ser confirmados se constarem nas configurações ativas do bot ou base de conhecimento.
- O webhook sem token de autenticação deve falhar fechado (`401 Unauthorized`), exceto quando em modo de desenvolvimento explícito (`ALLOW_INSECURE_WEBHOOK=true`).
- Logs não devem conter texto sensível de clientes nem números de telefone completos.
