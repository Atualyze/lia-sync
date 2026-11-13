import test from 'node:test';
import assert from 'node:assert/strict';
import { toolConsultarSaudeInfra } from './tools/consultar_saude_infra.mjs';
import { toolGerenciarAgendaGoogle } from './tools/gerenciar_agenda_google.mjs';

test('Habilidade 4: Diagnóstico Ativo de Infraestrutura reporta integridade e métricas', async () => {
  const res = await toolConsultarSaudeInfra.execute({ target: 'geral' }, {});
  assert.equal(res.success, true);
  assert.ok(Array.isArray(res.checks));
  assert.ok(res.checks.some(c => c.name.includes('Lia Bot Runtime')));
});

test('Habilidade 5: Integração Google Calendar consulta horários livres e confirma agendamento', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldMock = process.env.GOOGLE_CALENDAR_MOCK;
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_CALENDAR_MOCK = 'true';
  const livres = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-12' }, {});
  assert.equal(livres.success, true);
  assert.ok(Array.isArray(livres.availableSlots));
  assert.ok(livres.availableSlots.length > 0);

  const agendamento = await toolGerenciarAgendaGoogle.execute({
    action: 'criar_evento',
    date: '2026-11-12',
    startTime: '14:30',
    summary: 'Alinhamento de Proposta com Cliente'
  }, { clientName: 'Lucas' });
  assert.equal(agendamento.success, true);
  assert.equal(agendamento.event.status, 'confirmed');
  assert.match(agendamento.message, /14:30/);
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  if (oldMock === undefined) delete process.env.GOOGLE_CALENDAR_MOCK; else process.env.GOOGLE_CALENDAR_MOCK = oldMock;
});

test('Google Calendar não retorna sucesso sem integração real ou mock explícito', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldMock = process.env.GOOGLE_CALENDAR_MOCK;
  process.env.NODE_ENV = 'production';
  delete process.env.GOOGLE_CALENDAR_MOCK;
  delete process.env.GOOGLE_CALENDAR_API_KEY;
  delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  const result = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-12' }, {});
  assert.equal(result.success, false);
  assert.equal(result.error, 'google_calendar_unavailable');
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
  if (oldMock === undefined) delete process.env.GOOGLE_CALENDAR_MOCK; else process.env.GOOGLE_CALENDAR_MOCK = oldMock;
});
