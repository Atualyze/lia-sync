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

test('Google Calendar permite horários simulados em teste, mas nunca simula a criação de eventos', async () => {
  const botConfig = { integrations: { googleCalendar: { enabled: true, showMockSlotsWhenUnavailable: true } }, tools: { settings: { gerenciar_agenda_google: { calendarId: 'test-calendar' } } } };
  const livres = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-26' }, { botConfig });
  assert.equal(livres.success, true);
  assert.equal(livres.mocked, true);
  assert.ok(Array.isArray(livres.availableSlots));
  assert.ok(livres.availableSlots.length > 0);

  const semHorario = await toolGerenciarAgendaGoogle.execute({
    action: 'criar_evento', date: '2026-11-26', summary: 'Alinhamento de Proposta'
  }, { botConfig });
  assert.equal(semHorario.success, false);
  assert.equal(semHorario.error, 'event_time_required');

  const agendamento = await toolGerenciarAgendaGoogle.execute({
    action: 'criar_evento', date: '2026-11-26', startTime: '14:30', summary: 'Alinhamento de Proposta com Cliente'
  }, { clientName: 'Lucas', botConfig });
  assert.equal(agendamento.success, false);
  assert.equal(agendamento.error, 'mock_calendar_write_disabled');
  assert.match(agendamento.message, /Nenhum evento foi criado/i);
});

test('Google Calendar usa agenda nativa como fallback sem integração externa ou mock', async () => {
  delete process.env.GOOGLE_CALENDAR_API_KEY;
  delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  const result = await toolGerenciarAgendaGoogle.execute({ action: 'consultar_livres', date: '2026-11-12' }, {});
  assert.equal(result.success, true);
  assert.equal(result.provider, 'agenda_nativa');
});
