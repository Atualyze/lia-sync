import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClientReminderRequest } from './client-reminder-guard.mjs';

const now = Date.parse('2026-11-25T16:38:00.000Z');

test('pedido genérico para guardar um recado pede o conteúdo e não autoriza agendamento', () => {
  const result = validateClientReminderRequest({
    message: 'poderia guardar um recado?',
    reason: 'Recado de Nauat',
    when: '2026-11-25T14:00:00-03:00',
    now
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'schedule_not_explicit');
  assert.match(result.reply, /Qual recado você gostaria que eu guardasse/i);
});

test('agendamento exige assunto que apareça na mensagem do cliente', () => {
  const result = validateClientReminderRequest({
    message: 'Me lembre amanhã às 14h, por favor.',
    reason: 'Recado de Nauat',
    when: '2026-11-26T14:00:00-03:00',
    now
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'reminder_subject_missing');
});

test('agendamento sem dia ou horário explícito pede o dado ausente', () => {
  const result = validateClientReminderRequest({
    message: 'Me lembre amanhã de enviar o orçamento.',
    reason: 'enviar o orçamento',
    when: '2026-11-26T14:00:00-03:00',
    now
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'reminder_datetime_missing');
  assert.match(result.reply, /horário/i);
});

test('pedido completo e fundamentado pode agendar o retorno', () => {
  const result = validateClientReminderRequest({
    message: 'Me lembre amanhã às 14h de enviar o orçamento.',
    reason: 'enviar o orçamento',
    when: '2026-11-26T14:00:00-03:00',
    now
  });
  assert.equal(result.allowed, true);
});

test('não agenda data calculada no passado', () => {
  const result = validateClientReminderRequest({
    message: 'Me lembre hoje às 10h de enviar o orçamento.',
    reason: 'enviar o orçamento',
    when: '2026-11-25T10:00:00-03:00',
    now
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'reminder_datetime_invalid');
});
