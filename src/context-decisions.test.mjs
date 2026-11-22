import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAIResponse, responseSchema, buildOpenRouterBody } from './ai/parsing.mjs';
import { resolverSetorPorCategoria } from './triage-router.mjs';
import { getEnabledTools, isClientToolAllowed } from './tools/index.mjs';

const base = {
  reply: 'Resposta contextual.',
  intent: 'atendimento',
  red_flags: false,
  handoff: false,
  handoff_category: null,
  handoff_reason: null,
  needs_tool: false,
  sector: 'reclamacao',
  sentiment: 'neutro',
  context_summary: 'O cliente relata insatisfação.',
  conversation_state: { objective: 'Resolver reclamação', need: 'Produto com defeito', next_step: 'Coletar dados', confirmed: ['Compra'] },
  tool_calls: [],
  collected: {}
};

test('handoff só é aceito com boolean true e categoria permitida', () => {
  const accepted = parseAIResponse(JSON.stringify({
    ...base,
    handoff: true,
    handoff_category: 'reclamacao',
    handoff_reason: 'Insatisfação com o produto'
  }));
  assert.equal(accepted.handoff, true);
  assert.equal(accepted.handoff_category, 'reclamacao');

  const noBoolean = parseAIResponse(JSON.stringify({
    ...base,
    handoff: false,
    handoff_category: 'pedido_pessoa',
    handoff_reason: 'Campo incoerente'
  }));
  assert.equal(noBoolean.handoff, false);
  assert.equal(noBoolean.handoff_category, null);
  assert.equal(noBoolean.handoff_reason, null);

  const invalid = parseAIResponse(JSON.stringify({
    ...base,
    intent: 'humano',
    handoff: true,
    handoff_category: 'falha_tecnica',
    handoff_reason: 'Agenda indisponível',
    reply: 'Vou encaminhar para a equipe.'
  }));
  assert.equal(invalid.handoff, false);
  assert.equal(invalid.handoff_category, null);
  assert.equal(invalid.handoff_reason, null);
});

test('needs_tool só fica true quando há chamada válida e respeita needs_tool=false', () => {
  const suppressed = parseAIResponse(JSON.stringify({
    ...base,
    needs_tool: false,
    tool_calls: [{ name: 'consultar_web', args: { query: 'não executar' } }]
  }));
  assert.equal(suppressed.needs_tool, false);
  assert.deepEqual(suppressed.tool_calls, []);

  const enabled = parseAIResponse(JSON.stringify({
    ...base,
    needs_tool: true,
    tool_calls: [{ name: 'consultar_web', args: { query: 'cotação do dólar' } }]
  }));
  assert.equal(enabled.needs_tool, true);
  assert.equal(enabled.tool_calls.length, 1);

  const empty = parseAIResponse(JSON.stringify({
    ...base,
    needs_tool: true,
    tool_calls: []
  }));
  assert.equal(empty.needs_tool, false);
});

test('conversation_state é preservado e normalizado pelo parser', () => {
  const result = parseAIResponse(JSON.stringify(base));
  assert.deepEqual(result.conversation_state, {
    objective: 'Resolver reclamação',
    need: 'Produto com defeito',
    next_step: 'Coletar dados',
    confirmed: ['Compra']
  });
  assert.equal(result.sector, 'reclamacao');
});

test('schemas Gemini e OpenRouter exigem decisão de ferramenta e categoria de handoff', () => {
  assert.ok(responseSchema.required.includes('needs_tool'));
  assert.ok(responseSchema.required.includes('handoff_category'));
  assert.ok(responseSchema.required.includes('conversation_state'));
  const schema = buildOpenRouterBody({
    model: 'google/gemma-4-31b:free',
    system: 'sistema',
    userText: 'oi',
    structuredOutputs: true
  }).response_format.json_schema.schema;
  assert.ok(schema.required.includes('needs_tool'));
  assert.ok(schema.required.includes('handoff_category'));
  assert.ok(schema.required.includes('conversation_state'));
  assert.deepEqual(schema.properties.handoff_category.enum, ['financeiro', 'reclamacao', 'pedido_pessoa', 'emergencia', null]);
  assert.ok(schema.properties.intent.enum.includes('atendimento'));
});

test('triagem por categoria mapeia o setor de reclamações', () => {
  const result = resolverSetorPorCategoria('reclamacao', [
    { id: 'complaints', name: 'Reclamações', description: 'Ouvidoria e insatisfação', isActive: true }
  ]);
  assert.deepEqual(result, { sectorId: 'complaints', sectorName: 'Reclamações', category: 'reclamacao' });
});

test('catálogo de ferramentas de cliente nunca expõe ferramentas exclusivas do responsável', () => {
  const clientTools = getEnabledTools({ ai: { agentMode: 'super_agente', enableToolCalling: true } }, { actor: 'client' });
  const names = new Set(clientTools.map(tool => tool.name));
  for (const forbidden of ['gerenciar_configuracao', 'gerenciar_codigo', 'gerenciar_gmail_google', 'gerenciar_tarefas_autonomas', 'transferir_para_setor']) {
    assert.equal(names.has(forbidden), false, forbidden + ' não pode ser oferecida ao cliente');
    assert.equal(isClientToolAllowed(forbidden), false);
  }
});
