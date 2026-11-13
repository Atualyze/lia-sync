# Contrato de configuração e setores — Lia Sync ↔ Chatwoot Lia

O Lia Sync é a única autoridade sobre a configuração do motor da Lia. O Chatwoot Lia é console de
atendimento: **lê** a projeção publicada e **fornece** os próprios dados operacionais (setores), mas
nunca publica rascunho nem revisão.

## Autorização
As rotas `/api/bridge/v1/config` e `/api/bridge/v1/sectors` exigem `Authorization: Bearer $WEBHOOK_TOKEN`
(ou o autorizador de ponte configurado). O token fica somente no servidor do Chatwoot: não vai ao
navegador, não aparece em respostas e não é registrado em logs. Sem autorização válida, a leitura e a
escrita falham com `401` antes de qualquer dado ser revelado.

## `GET /api/bridge/v1/config` (somente leitura)
Responde `200` com a projeção **allowlist** da configuração já publicada, ou `304` quando o `If-None-Match`
coincide. Nunca expõe rascunho, histórico, credenciais, chaves de provedor, telefone humano ou o texto
do aviso de fora do expediente.

```json
{
  "ok": true,
  "contractVersion": 1,
  "configSchemaVersion": 1,
  "revision": 12,
  "publishedAt": "2026-11-13T15:59:00.000Z",
  "settings": {
    "ai": { "activeProvider": "gemini", "activeModel": "…", "fallbackModels": ["…"], "agentMode": "assistente", "enableToolCalling": false },
    "webSearch": { "enabled": true },
    "automation": { "enableMediaProcessing": true, "enableProactiveFollowUp": true, "businessHoursOnly": true, "autoHandoffOnHumanPresence": true, "maxDailyFollowUps": 30, "followUpMinHours": 24, "followUpMaxHours": 72, "followUpTemplate": "…" },
    "voice": { "voiceName": "Aoede", "tone": "…", "autoVoiceOnAudio": true },
    "business": {
      "hours": {
        "enabled": true,
        "timezone": "America/Sao_Paulo",
        "start": "08:00",
        "end": "18:00",
        "weekdays": [1, 2, 3, 4, 5],
        "autoResumeOnOpen": true,
        "isOpenNow": false,
        "nextOpenAt": "2026-11-14T11:00:00.000Z",
        "summary": "segunda a sexta, das 08:00 às 18:00 (America/Sao_Paulo)"
      }
    }
  }
}
```

Regras:

- `contractVersion` permanece **1**. Campos novos são tratados como aditivos; consumidores devem tolerar
  ausência (`settings.business?.hours` é opcional).
- `revision` é **estritamente crescente para sempre**: `publish` e `rollback` incrementam o contador, e
  um rollback cria uma revisão nova maior apontando para o snapshot antigo. Consumidores podem usar a
  monotonicidade para descartar respostas atrasadas sem perder rollbacks legítimos.
- `business.hours.isOpenNow`, `nextOpenAt` e `summary` são derivados pelo Lia Sync com a mesma função
  usada no atendimento. O Chatwoot **não** reimplementa a regra.
- `503` com `config_persistence_unavailable` quando a persistência não é Supabase, e
  `published_config_unavailable` quando não há revisão publicada. Em ambos os casos o consumidor deve
  manter o último valor conhecido e se marcar como desatualizado — nunca assumir padrão.
- Toda leitura bem-sucedida registra revisão e horário na tela **Integrações** (`Ponte Chatwoot Lia`).

## `PUT /api/bridge/v1/sectors` (projeção de runtime, sem publicar)
O Chatwoot envia seus setores para que a triagem leve do motor use a mesma lista vista no console.

```json
{ "sectors": [ { "id": "sec_comercial", "name": "Comercial & Orçamentos", "description": "Propostas", "isActive": true } ] }
```

- São aceitos no máximo **100** itens, cortados exatamente nos limites que o produtor usa (`id` 60, `name` 120, `description` 500 caracteres); apenas `id`, `name`, `description` e `isActive` são retidos.
  Telefones, chaves de roteamento e qualquer campo adicional são descartados.
- Erros: `invalid_sectors`, `duplicate_sector_id`, `too_many_sectors` (`400`),
  `sector_projection_unavailable` (`503`) e `sector_projection_persistence_unavailable` (`503`).
  Em falha, a projeção anterior permanece intacta.
- Efeitos: grava em memória e em `data/sectors-projection.json`. **Não** cria rascunho, não valida,
  não publica, não altera `revision` nem o histórico do painel — há teste cobrindo exatamente isso.
- `GET /api/bridge/v1/sectors` devolve a projeção atual com `{ synced, count, updatedAt }`.
- A tela **Integrações** mostra o cartão **Setores do Chatwoot** com quantidade e data da última
  projeção; enquanto não houver sincronização, o motor mantém o caminho legado
  `business.sectors` de publicações antigas.

## Publicação
Somente o painel administrativo do Lia Sync (`/api/admin/config/*`, papel `admin`) publica
configuração. Qualquer rota de máquina que tente publicar deve ser recusada. O expediente é editado
no card **Janela de Atendimento**, passa pela validação fail-closed do rascunho e só então entra em
uma revisão publicada.

## Validação
Contratos cobertos por `npm run test:contract` e pela suíte:

- expediente editado apenas no painel central, com validação antes de publicar;
- ponte projeta o expediente derivado sem revelar o aviso ao cliente e sem segredos;
- setores fora da configuração publicada, como projeção de runtime;
- motor consome a projeção com compatibilidade para publicações antigas;
- tela de Integrações exibe expediente efetivo e estado da projeção.
