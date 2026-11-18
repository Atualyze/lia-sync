# Plano — centralização das configurações da Lia

## Objetivo e fronteira aprovada

O Lia Sync será a autoridade única das configurações específicas do motor Lia que hoje também são editáveis no Chatwoot Lia. O Chatwoot continuará executando atendimento, chats, automações, agendamentos, uso de setores, detalhes e contextos de contatos. A mudança não transfere esses fluxos nem suas telas operacionais.

O escopo centralizado é: integração/status da Lia; provedor, modelo principal e até três fallbacks; modo de agente e uso de ferramentas; busca web e processamento de mídia; políticas de follow-up (ativação, janela, limite diário e texto); comportamento relacionado a horário e presença humana; e voz (nome, tom e resposta automática a áudio). Configurações de aparência do Chatwoot, setores/triagem, canais, etiquetas, operadores e perfil permanecem no Chatwoot.

## Abordagem de implementação

1. Reutilizar o `AdminConfigStore` e o estado ativo/rascunho já persistido em `bot_config_state` e versionado em `bot_config_revisions`. Formalizar os campos da Lia no schema/defaults/validação existentes; preservar valores legados já publicados, normalizando `automation.enableWebSearch` para o campo canônico `webSearch.enabled`. Não introduzir uma segunda tabela sem necessidade comprovada.
2. Completar a tela existente **Configurações da Lia** no dashboard do Lia Sync com os campos de operações hoje editáveis no Chatwoot. Reutilizar catálogo de modelos do backend, gravação em rascunho, validação, publicação e histórico já existentes. A tela **Integrações** deve incluir o estado de leitura da ponte Chatwoot Lia, sem exibir tokens ou segredos.
3. Expor uma API de ponte somente-leitura, versionada (`GET /api/bridge/v1/config`), autorizada server-to-server pelo mecanismo de bridge já configurado. Entregar somente projeção allowlist da configuração **publicada**, com versão do contrato, revisão, ETag e data de publicação. Não devolver rascunho, histórico, credenciais ou dados de clientes. Requisições com `If-None-Match` podem receber `304`.
4. Alterar o backend do Chatwoot para consultar a configuração publicada pela ponte e mantê-la apenas como cache de runtime em memória. Remover a edição e a persistência paralela das configurações da Lia no estado Chatwoot. Preferências do Chatwoot e demais recursos operacionais preservam seus contratos e donos atuais. Rotas legadas de escrita não podem continuar aceitando uma segunda fonte de configuração.
5. Manter a execução operacional no Chatwoot: centralizar políticas/valores não deve criar um segundo scheduler, mover conversas, alterar setores ou transferir edição de contexto individual. Não modificar o comportamento de automações fora do necessário para consumir a configuração central.

## Persistência, segurança e compatibilidade

A configuração ativa do Lia Sync permanece o valor canônico; o dashboard grava rascunho e publica pela infraestrutura existente. A ponte não aceita escrita de configuração. Escrita administrativa continua protegida pelo login/role admin do Lia Sync. O Chatwoot usa somente credencial server-to-server já provisionada; tokens, chaves de provedor e service-role nunca chegam ao browser, à resposta da ponte ou aos logs. A leitura deve falhar fechada sem autorização. Compatibilidade com valores anteriores será feita no carregamento/normalização do JSON de configuração, sem executar migração de produção como parte desta alteração.

## Estrutura do projeto

- `public/index.html`, `public/app.js`, `public/styles.css`: navegação e views administrativas existentes; expandir Configurações e Integrações sem criar outro dashboard.
- `src/admin-config.mjs`: defaults, normalização, validação, rascunho e publicação do schema canônico.
- `src/http/admin.mjs`, `src/http/bridge-routes.mjs`, `src/http/router.mjs`: edição administrativa autenticada e leitura server-to-server da projeção publicada.
- `src/supabase-runtime.mjs`, migrations existentes: persistência/versionamento atual da configuração e histórico; alterar schema SQL somente se o JSON existente não suportar o contrato.
- Repositório Chatwoot Lia (`server.ts`, `src/components/SettingsView.tsx`, `src/App.tsx`): retirar formulários Lia do console e ler a projeção publicada da ponte, preservando áreas operacionais e preferências próprias.

## Direção visual

Reutilizar integralmente o dashboard administrativo escuro existente no Lia Sync: cards, formulários compactos, estados de publicação, feedbacks, botões e tipografia já presentes. No Chatwoot, preservar a direção visual documentada, sem redesign; as abas operacionais que permanecem devem conservar o mesmo layout e comportamento.

## Continuação entregue na 2.3.1 — expediente central e setores no dono natural

O plano acima parou com três lacunas, resolvidas nesta continuação:

1. **Expediente sem dono visível.** `business.hoursConfig` já era consumido pelo motor, mas não tinha campo no painel nem validação. Entrou o card **Janela de Atendimento** (ativação, dias, início, fim, fuso, retomada automática e aviso), com validação fail-closed antes de publicar e prévias publicada/pendente calculadas no servidor (`hoursPreview`, `hoursDraftPreview`). A regra canônica continua em `src/business-hours.mjs`, agora com `diasSemanaTexto` e `resumoJanelaDeAtendimento` compartilhados pela ponte e pelo painel.
2. **Publicação indireta pelo Chatwoot.** O `PUT /api/triage` do Chatwoot gravava horário e setores no rascunho e chamava `/api/admin/config/publish`, publicando também edições pendentes de outra pessoa. O fluxo foi removido lá; aqui os setores passaram a existir apenas como projeção de runtime (`src/sectors.mjs` com `PUT/GET /api/bridge/v1/sectors` e `data/sectors-projection.json`), sem rascunho, validação ou revisão. O motor consome a projeção e mantém compatibilidade com `business.sectors` de publicações antigas.
3. **Contrato incompleto.** A projeção da ponte ganhou `settings.business.hours` com estado derivado no servidor (`isOpenNow`, `nextOpenAt`, `summary`), de forma aditiva dentro de `contractVersion: 1` e sem expor o texto do aviso ao cliente. A tela de Integrações agora mostra o expediente efetivo e o estado da projeção de setores.

Documentação: [`docs/release-2.3.1.md`](docs/release-2.3.1.md) e [`docs/config-bridge-contract.md`](docs/config-bridge-contract.md). Validação: 190 testes, 26 contratos de arquitetura e build de 98 módulos; nenhuma migration foi necessária, porque a projeção de setores é arquivo de runtime e o expediente vive no JSON de configuração já versionado.

## Portal Atualyze Pay — pagamento unificado

O endpoint público `/pix` passa a funcionar como o portal responsivo `pay.atualyze.com.br`: uma página única, otimizada para desktop e mobile, com QR Code, cópia da chave Pix, cópia do código Pix e Cola e botão de checkout InfinitePay quando houver checkout configurado. O payload Pix continua assinado pelo BR Code e a página não persiste dados sensíveis; os dados da cobrança vêm do link assinado/encodado.

### Direção visual aprovada

- **Movimentos considerados:** Neomorfismo editorial (0,07), fintech editorial premium (0,62), minimalismo institucional (0,09). Escolhido: **fintech editorial premium**.
- **Princípios:** confiança sem excesso de elementos, hierarquia forte para o valor, ações grandes para uso com uma mão e adaptação fluida entre telas.
- **Paleta:** azul petróleo profundo para segurança e contraste, verde água para a ação Pix e azul claro para InfinitePay.
- **Layout:** composição assimétrica em duas zonas no desktop, com narrativa curta à esquerda e cartão de pagamento à direita; empilhamento natural no mobile.
- **Assinaturas:** selo “Seguro”, marca Atualyze Pay e card com QR contrastante; botões revelam claramente a próxima ação.
- **Interação:** copiar com feedback toast, links externos abrem em nova aba e somente checkout InfinitePay validado é exibido.
- **Tipografia e voz:** sistema sans-serif com títulos compactos; microcopy direta, clara e acolhedora.

### Integração

`gerar_cobranca_pix` prioriza `paymentBaseUrl`/`PAYMENT_BASE_URL` e usa `https://pay.atualyze.com.br` como fallback. `checkout_infinitepay` monta também `paymentUrl` com o payload Pix e o checkout oficial, permitindo uma única página de pagamento sem expor chaves de API no navegador.
