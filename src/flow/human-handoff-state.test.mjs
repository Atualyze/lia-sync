import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getHumanHandoffState,
  isHumanHandoffActive,
  enterHumanHandoff,
  resumeHumanHandoff,
  captureHumanHandoffSnapshot,
  restoreHumanHandoffSnapshot,
  canSendAutomatedClientMessage
} from './human-handoff-state.mjs';

test('human handoff state: interpreta sessões legadas sem exigir migração', () => {
  assert.equal(getHumanHandoffState({ human: true, humanSource: 'admin' }), 'human');
  assert.equal(getHumanHandoffState({ human: false }), 'bot');
  assert.equal(getHumanHandoffState({}), 'bot');
  assert.equal(isHumanHandoffActive({ human: 1 }), true);
});

test('human handoff state: ativa o modo humano e serializa timestamp numérico', () => {
  const session = { human: false, humanSource: 'client' };
  const result = enterHumanHandoff(session, {
    source: 'admin',
    at: Date.UTC(2026, 10, 23, 12, 30),
    reason: 'validação administrativa',
    urgency: 'normal'
  });

  assert.deepEqual(result, { changed: true, wasAlreadyHuman: false });
  assert.equal(session.human, true);
  assert.equal(session.humanSource, 'admin');
  assert.equal(session.handoffAt, '2026-11-23T12:30:00.000Z');
  assert.equal(session.handoffReason, 'validação administrativa');
  assert.equal(session.handoffUrgency, 'normal');
});

test('human handoff state: preserva origem existente e evita sobrescrita em sessão já humana', () => {
  const session = {
    human: true,
    humanSource: 'handoff',
    handoffAt: '2026-11-20T10:00:00.000Z',
    handoffReason: 'primeiro motivo'
  };

  const result = enterHumanHandoff(session, {
    source: 'admin',
    at: '2026-11-23T12:30:00.000Z',
    reason: 'segundo motivo',
    preserveSource: true,
    onlyIfInactive: true
  });

  assert.deepEqual(result, { changed: false, wasAlreadyHuman: true });
  assert.equal(session.humanSource, 'handoff');
  assert.equal(session.handoffAt, '2026-11-20T10:00:00.000Z');
  assert.equal(session.handoffReason, 'primeiro motivo');
});

test('human handoff state: retomada padrão muda apenas o booleano legado', () => {
  const session = {
    human: true,
    humanSource: 'admin',
    handoffAt: '2026-11-23T12:30:00.000Z',
    handoffReason: 'aguardando equipe',
    handoffUrgency: 'normal',
    handoffNotified: true,
    handoffNotifyFailed: true
  };

  resumeHumanHandoff(session);

  assert.equal(session.human, false);
  assert.equal(session.humanSource, 'admin');
  assert.equal(session.handoffAt, '2026-11-23T12:30:00.000Z');
  assert.equal(session.handoffReason, 'aguardando equipe');
  assert.equal(session.handoffNotified, true);
  assert.equal(session.handoffNotifyFailed, true);
});

test('human handoff state: retomada explícita limpa somente os campos selecionados', () => {
  const session = {
    human: true,
    humanSource: 'admin',
    handoffAt: '2026-11-23T12:30:00.000Z',
    handoffReason: 'motivo preservado pela regra antiga',
    handoffUrgency: 'emergencia',
    handoffReminderAt: 123,
    handoffNotified: true,
    handoffNotifyFailed: true,
    handoffReminder1Sent: true,
    handoffReminder60Sent: true
  };

  resumeHumanHandoff(session, {
    source: 'resume',
    clearHandoffAt: true,
    clearReminderAt: true,
    clearNotifications: true,
    clearReminderFlags: true
  });

  assert.equal(session.human, false);
  assert.equal(session.humanSource, 'resume');
  assert.equal(session.handoffAt, null);
  assert.equal(session.handoffReason, 'motivo preservado pela regra antiga');
  assert.equal(session.handoffUrgency, 'emergencia');
  assert.equal(session.handoffReminderAt, null);
  assert.equal(session.handoffNotified, false);
  assert.equal(session.handoffNotifyFailed, true);
  assert.equal(session.handoffReminder1Sent, false);
  assert.equal(session.handoffReminder60Sent, false);
});

test('human handoff state: snapshots restauram os campos originais após falha de persistência', () => {
  const session = {
    human: false,
    humanSource: null,
    handoffAt: null,
    handoffReason: 'motivo anterior',
    updatedAt: '2026-11-22T10:00:00.000Z',
    unrelated: 'keep'
  };
  const snapshot = captureHumanHandoffSnapshot(session, [
    'human', 'humanSource', 'handoffAt', 'handoffReason', 'updatedAt'
  ]);

  enterHumanHandoff(session, {
    source: 'admin',
    at: Date.UTC(2026, 10, 23),
    reason: 'novo motivo'
  });
  session.updatedAt = '2026-11-23T00:00:00.000Z';
  restoreHumanHandoffSnapshot(session, snapshot);

  assert.equal(session.human, false);
  assert.equal(session.humanSource, null);
  assert.equal(session.handoffAt, null);
  assert.equal(session.handoffReason, 'motivo anterior');
  assert.equal(session.updatedAt, '2026-11-22T10:00:00.000Z');
  assert.equal(session.unrelated, 'keep');
});


test('human handoff state: bloqueia mensagens automáticas e só permite consulta administrativa correspondente', () => {
  assert.equal(canSendAutomatedClientMessage({ human: false }), true);
  assert.equal(canSendAutomatedClientMessage({ human: true, humanSource: 'admin' }), false);
  assert.equal(canSendAutomatedClientMessage({ human: true }, {
    allowMatchingAdminConsult: true,
    hasMatchingAdminConsult: false
  }), false);
  assert.equal(canSendAutomatedClientMessage({ human: true }, {
    allowMatchingAdminConsult: true,
    hasMatchingAdminConsult: true
  }), true);
  assert.equal(canSendAutomatedClientMessage({ human: true }, {
    allowMatchingAdminConsult: false,
    hasMatchingAdminConsult: true
  }), false);
  assert.equal(canSendAutomatedClientMessage({ human: false, archivedAt: '2026-11-23T10:00:00.000Z' }), false);
  assert.equal(canSendAutomatedClientMessage({ human: false, inactivityClosed: true }), false);
  assert.equal(canSendAutomatedClientMessage(null), false);
});
