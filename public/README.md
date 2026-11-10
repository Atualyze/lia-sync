# Dashboard Lia Sync

Acesse em `/dashboard` enquanto o bot estiver rodando. O dashboard é servido pelo mesmo processo, usa os endpoints locais `/api/dashboard/*` e `/api/admin/*` e não expõe segredos no navegador.

## Operação

- **Conversas:** sessões de simulação e conversas reais, com alternância bot/humano.
- **Administração:** contexto, identidade, mensagens-base, comportamento e base de conhecimento.
- **Monitoramento:** latência, tokens, erros e circuit breakers.
- **Configuração:** estado do ambiente, modelos e integrações.
- **Transferências:** sessões aguardando atendimento humano.

## Rascunho e publicação

A área Administração salva alterações como rascunho. O runtime usa somente a versão publicada. Use **Publicar alterações** para ativar o contexto e **Descartar rascunho** para voltar à última versão publicada.

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
ALLOW_UNAUTHENTICATED_DASHBOARD=true \
EVOLUTION_INSTANCE=lia-sync \
npm start
```

Depois abra `http://127.0.0.1:3000/dashboard`.

Para acessar remotamente com segurança, mantenha a porta 3000 vinculada a `127.0.0.1` e use um túnel SSH:

```bash
ssh -i SUA_CHAVE.key -L 3000:127.0.0.1:3000 ubuntu@IP_DA_VM
```

Em produção, mantenha a autenticação do Supabase, `WEBHOOK_TOKEN` e as credenciais fora do repositório.
