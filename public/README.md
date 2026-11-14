# Dashboard Lia Sync

Versão do backend: **2.4.0**. A divisão de responsabilidades do backend está descrita em [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Acesse em `/dashboard` enquanto o bot estiver rodando. O dashboard é servido pelo mesmo processo, usa endpoints autenticados e não expõe credenciais no navegador.

## Operação

- **Conversas:** sessões de simulação e conversas reais, com alternância bot/humano.
- **Administração:** contexto, identidade, mensagens-base, comportamento e itens da base de conhecimento.
- **Saúde & Operação:** readiness, dependências, latência, tokens, custos estimados, erros e circuit breakers.
- **Provedores e modelos:** consulta do catálogo disponível nas APIs configuradas, seleção do modelo principal e de até três modelos de fallback.
- **Orçamento:** limites mensais por provedor/modelo e visualização do consumo, falhas e uso conhecido/desconhecido.
- **Campanhas e supressões:** campanhas, fila, opt-out e auditoria, com telefones mascarados.
- **Integrações:** estado do ambiente, integrações e configurações operacionais.
- **Transferências:** sessões aguardando atendimento humano.

As chamadas para catálogo são feitas pelo backend usando as credenciais configuradas no servidor. Chaves de provedores não são enviadas ao browser. Custos são estimativas quando não há uma tarifa confiável por modelo; uso desconhecido não deve ser interpretado como custo zero.

## Rascunho e publicação

A área Administração salva alterações como rascunho. O runtime usa somente a versão publicada. Use **Publicar alterações** para ativar o contexto e **Descartar rascunho** para voltar à última versão publicada.

Em **Identidade**, configure nome da assistente, responsável, empresa, apelidos e tom. O responsável e o telefone humano usados pelo Copiloto e pelo handoff são lidos da configuração publicada; não há pessoa fixa no código operacional.

Na configuração de IA, selecione um provedor e modelo principal e configure até três modelos de fallback. O backend busca os modelos pela API do provedor quando a credencial correspondente está disponível. Limites mensais podem ser associados a um provedor e/ou modelo; chamadas sem tarifa necessária, histórico inválido ou reserva distribuída não confirmada falham de forma segura.

## Preview isolado

O bloco **Preview antes de publicar** permite testar uma mensagem com o rascunho atual. A execução usa uma sessão temporária e não:

- envia mensagem pela Evolution API;
- modifica conversas reais;
- grava sessão operacional;
- notifica a equipe ou cria handoff real.

Também é possível chamar diretamente:

```bash
curl -X POST http://127.0.0.1:3000/api/admin/config/preview \
  -H 'Content-Type: application/json' \
  -d '{"phone":"5586999962542","text":"Oi, quero conhecer os planos."}'
```

## Teste local sem Supabase

Somente para desenvolvimento local:

```bash
ALLOW_INSECURE_WEBHOOK=true \
HOST=127.0.0.1 \
EVOLUTION_INSTANCE=lia-sync \
npm start
```

Esse modo só permite o webhook sem token em desenvolvimento local, vinculado ao loopback. A autenticação do painel continua obrigatória; configure o Supabase para entrar em `http://127.0.0.1:3000/dashboard`.

Para acessar remotamente com segurança, mantenha a porta 3000 vinculada a `127.0.0.1` e use um túnel SSH:

```bash
ssh -i SUA_CHAVE.key -L 3000:127.0.0.1:3000 ubuntu@IP_DA_VM
```

Em produção, mantenha a autenticação do Supabase, `WEBHOOK_TOKEN` e as credenciais dos provedores fora do repositório e do frontend.

## Follow-up e mídia

Follow-ups usam claim distribuída no Supabase antes do envio, evitando que réplicas concorrentes enviem a mesma mensagem. Se a claim não puder ser confirmada, o follow-up não é enviado. O envio de áudio não é repetido automaticamente quando a Evolution deixa o resultado ambíguo; essa regra privilegia evitar duplicidade.
