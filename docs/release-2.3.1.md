# Release 2.3.1 — expediente central no painel e setores fora da configuração publicada

## Resumo
O horário de atendimento da Lia passou a ser administrado no painel do Lia Sync, com validação
fail-closed, e é lido pelo Chatwoot Lia somente leitura pela ponte versionada. Setores e triagem
continuam pertencendo ao Chatwoot e não entram mais na configuração publicada do motor.

## Por que essa release era necessária
A centralização anterior (2.3.0 + trabalho não publicado) deixou três lacunas:

1. `business.hoursConfig` era consumido pelo motor, mas não tinha campo no painel nem validação:
   a única forma de alterar o expediente era um fluxo do Chatwoot.
2. Esse fluxo gravava `business.hoursConfig` e `business.sectors` no **rascunho** do Lia Sync e em
   seguida chamava `POST /api/admin/config/publish`. Consequência: publicar o expediente também
   publicava qualquer rascunho administrativo pendente de outra pessoa, e os setores do Chatwoot
   passavam a existir em dois lugares.
3. A projeção da ponte não expunha o expediente, então o console não tinha como exibir o valor
   efetivo sem duplicar a regra.

## O que mudou

### Janela de atendimento no painel
Novo card **Janela de Atendimento** na administração (`business.hoursConfig`): ativação, dias da
semana, início, fim, fuso, retomada automática de conversas pendentes e aviso de fora do expediente.
O formulário exibe duas prévias calculadas no servidor — a publicada (`hoursPreview`) e a do
rascunho (`hoursDraftPreview`) — porque a regra pertence ao motor, não à interface.

### Validação fail-closed
`validateHoursConfig` rejeita o rascunho antes de publicar quando:

- `enabled`/`autoResumeOnOpen` não são booleanos;
- início ou fim não estão na forma `HH:MM` de 24 horas, ou o fim não é depois do início;
- o fuso é ausente ou não é um fuso IANA aceito por `Intl.DateTimeFormat`;
- `weekdays` não é lista de inteiros únicos entre 0 (domingo) e 6 (sábado), ou está vazia com a
  janela ativada;
- o aviso ultrapassa 2000 caracteres ou a configuração inteira não é um objeto.

Em tempo de execução o motor continua **fail-open**: uma janela corrompida nunca silencia o
atendimento. A mudança de comportamento é apenas na porta de entrada (painel/publicação).

### Projeção da ponte (aditiva, contrato v1)
`GET /api/bridge/v1/config` passa a devolver, além de `ai`, `webSearch`, `automation` e `voice`:

```json
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
```

O campo é aditivo e a `contractVersion` permanece **1**, para não invalidar consumidores já
implantados. `isOpenNow`, `nextOpenAt` e `summary` são derivados pela mesma função que o atendimento
usa (`resumoJanelaDeAtendimento`). O texto do aviso ao cliente (`outOfHoursNotice`) **não** é
exposto: é conteúdo do atendimento da Lia, não configuração operacional do console.

### Setores como projeção de runtime
Nova rota de máquina `PUT`/`GET /api/bridge/v1/sectors` alimentando `src/sectors.mjs`:

- grava apenas `id`, `name`, `description`, `isActive`, com no máximo 100 setores;
- telefones, chaves de roteamento e campos administrativos são descartados;
- persiste em `data/sectors-projection.json` (escrita atômica, sem migração de banco);
- rejeição mantém a projeção anterior intacta e nada é gravado;
- **nunca** toca rascunho, validação, publicação ou revisão — um teste cobre exatamente isso.

O motor consome a projeção e mantém compatibilidade com publicações antigas que ainda traziam
`business.sectors`.

### Tela de Integrações
Acrescenta dois cartões: **Expediente da Lia** (resumo publicado, aberto/fechado e reabertura) e
**Setores do Chatwoot** (quantidade e data da última projeção), sem expor credenciais.

## Banco de dados
Nenhuma migration foi criada ou aplicada. O expediente continua dentro do JSON de configuração já
versionado; a projeção de setores é um arquivo de runtime local.

## Compatibilidade e implantação
1. Implantar o Lia Sync primeiro. Clientes antigos do Chatwoot simplesmente ignoram o novo campo.
2. Depois implantar o Chatwoot Lia 2.3.3, que passa a enviar setores pela nova rota e a ler o
   expediente pela ponte.
3. Se um ambiente já tenha `business.sectors` na configuração publicada, o valor continua valendo
   como fallback até a primeira projeção recebida; não há perda de triagem durante a transição.
4. Nenhum segredo, chave de provedor ou telefone de cliente é exposto por essas rotas.

## Validação
- `npm test`: 190 testes aprovados (antes, 182), incluindo validação do expediente, projeção de
  setores, allowlist da ponte e ausência de segredos.
- `npm run test:contract`: 26 verificações de arquitetura aprovadas (antes, 21).
- `npm run build`: 98 módulos verificados.
