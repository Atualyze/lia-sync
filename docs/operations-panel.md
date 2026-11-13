# Painel operacional central

A partir da versão **2.3.0**, o `lia-sync` é a fonte de verdade operacional da Lia. O Chatwoot Lia continua sendo o console de atendimento e a ponte autenticada; ele não deve duplicar ferramentas, regras de campanha, configurações de modelo ou políticas de opt-out.
A partir da **2.3.1**, o expediente da Lia também é administrado aqui. Setores e triagem continuam sendo dados do Chatwoot e chegam ao motor apenas como projeção de runtime.

## Áreas do painel

O painel em `/dashboard` exige autenticação Supabase/JWT e reúne Saúde & Operação, configurações administrativas, provedores e modelos, métricas, orçamento, campanhas, supressões e auditoria observacional. Rotas administrativas validam perfil ativo e papéis permitidos antes de ler ou alterar dados.

A lista de modelos é consultada pelo backend nas APIs dos provedores suportados quando suas credenciais estão configuradas. O usuário pode publicar um modelo principal e até três fallbacks. As credenciais permanecem no servidor e não são incluídas nas respostas do painel.

Custos são estimativas enquanto não houver tabela de preços confiável por provedor/modelo. Tarifas ausentes/nulas, uso de tokens desconhecido em chamadas com falha ou histórico truncado tornam o total incompleto; nunca assumir esses custos como zero. Limites mensais configurados por provedor/modelo usam reserva distribuída e não admitem chamada quando a reserva não pode ser confirmada. Tokens conhecidos, latência, falhas e circuit breakers são métricas operacionais. Telefones de supressão permanecem mascarados no browser.

## Janela de atendimento e setores

O card **Janela de Atendimento** edita `business.hoursConfig`: ativação, dias da semana, início, fim, fuso, retomada automática de conversas pendentes e aviso de fora do expediente. As alterações seguem rascunho → validação → publicação, como qualquer outra configuração; nada é salvo por caminho paralelo.

A validação é fail-closed antes de publicar (formato `HH:MM`, fim depois do início, fuso IANA válido, dias entre 0 e 6 sem repetição, aviso de até 2000 caracteres). Em tempo de execução a avaliação continua fail-open: se a janela publicada estiver corrompida, o atendimento **não** é silenciado.

A tela de Integrações mostra, além da ponte que informa qual revisão o Chatwoot já leu, dois cartões calculados no servidor: **Expediente da Lia** (resumo publicado, aberto/fechado e próxima reabertura) e **Setores do Chatwoot** (quantidade projetada e data da última sincronização). O painel nunca apresenta o texto do aviso ao cliente nem credenciais.

Setores são recebidos por `PUT /api/bridge/v1/sectors` e guardados em `data/sectors-projection.json`, com no máximo 100 itens e somente `id`, `name`, `description` e `isActive`; telefones e campos de roteamento são descartados. Essa rota **não** cria rascunho, não valida configuração e não aumenta a revisão publicada — ver [`config-bridge-contract.md`](config-bridge-contract.md).

## Follow-up e confiabilidade de entrega

O processo de manutenção só envia um follow-up depois de obter a claim atômica no Supabase. A confirmação é vinculada a um token de claim; se não houver acesso à claim distribuída, o envio fica bloqueado. Isso impede a emissão duplicada por instâncias concorrentes. Envios de áudio não são repetidos automaticamente quando a Evolution retorna um resultado ambíguo, reduzindo o risco de duplicidade.

## Teste seguro

O teste de integração padrão é simulado: não envia WhatsApp, não cria conversa real e não dispara handoff. Qualquer operação que execute envio deve passar pelos endpoints autenticados da ponte, com idempotência e verificação de supressão. Se a verificação de opt-out estiver ausente ou indisponível, o envio falha fechado.

## Publicação e rollback

Antes de publicar, usar Node.js 22 e executar:

```bash
npm ci
npm run lint
npm run build
npm test
npm run test:contract
git diff --check
```

Para implantação Docker, construir/recriar o serviço pelo Compose do projeto e conferir o estado do container e os endpoints locais:

```bash
docker compose up -d --build bot
docker compose ps bot
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
```

Em produção, validar também o dashboard por HTTPS e o webhook autenticado sem enviar mensagens a clientes. Manter a imagem anterior disponível para rollback; após rollback, repetir as verificações de `/health` e `/ready`. Não remover volumes de dados durante publicação ou rollback. Credenciais permanecem em `.env` no servidor e nunca devem ser copiadas para o GitHub.
