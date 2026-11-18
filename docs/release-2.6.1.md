# Release 2.6.1 — Agenda e retornos com resposta garantida

A release 2.6.1 documenta e consolida a correção do fluxo de agendamentos e retornos. A Lia agora entrega uma resposta final baseada no resultado real da ferramenta, em vez de deixar o cliente apenas com uma promessa de consulta.

## Agenda no atendimento ao cliente

- `gerenciar_agenda_google` passou a fazer parte das ferramentas permitidas no fluxo de cliente, desde que a integração esteja habilitada na configuração publicada.
- Consultas de horários livres, listagem de compromissos e criação de eventos continuam sujeitas à validação de data, credenciais, configuração e permissões do Google Calendar.
- O fluxo apresenta os horários retornados, os compromissos encontrados ou a ausência de disponibilidade de forma explícita.

## Retornos e falhas

- `agendar_retorno_ou_followup` só confirma o lembrete depois que a persistência é concluída.
- Falhas de agenda ou persistência geram mensagem clara e podem acionar `triggerHandoff`.
- Respostas preliminares como “vou consultar” não são mantidas quando a ferramenta já retornou erro ou sucesso.
- A Lia não inventa horários, compromissos, lembretes ou confirmações.

## Documentação e base de autoconhecimento

- README, CHANGELOG, ARCHITECTURE, metadados e manual exclusivo do Copiloto foram sincronizados para a versão 2.6.1.
- O manual de autoconhecimento registra a diferença entre agenda Google e retornos persistentes, além do comportamento obrigatório em caso de falha.

## Validação

Foram executados testes de agenda, consultas web, integrações, lembretes, regressões de fluxo e lint. Os testes específicos da correção cobrem:

1. permissão da agenda no atendimento ao cliente;
2. retorno de horários reais/mockados em vez de promessa pendente;
3. resposta explícita quando a integração está desativada ou indisponível.

## Deploy

Na VPS, o diretório ativo é `/home/ubuntu/lia-assistente`. O serviço Compose é `bot` e o contêiner criado é `lia-bot`; não se deve usar `lia-bot` como nome do serviço no comando Compose.

```bash
cd /home/ubuntu/lia-assistente
sudo docker compose build bot
sudo docker compose up -d bot
sudo docker compose ps
curl --fail http://127.0.0.1:3000/ready
```

O volume `data/` é persistente e deve ser gravável pelo usuário `node` do contêiner, normalmente com `UID:GID 1000:1000`. Nunca sobrescreva `.env`, `data/` ou backups durante a sincronização do código.
