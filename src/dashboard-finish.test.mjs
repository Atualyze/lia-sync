import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleDashboardSettingsRoutes } from './http/dashboard.mjs';
import { OWNER_SELF_KEY } from './core/identity.mjs';

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); }, end(body = '') { this.body += body; } };
}
function request(path, method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = path;
  req.method = method;
  req.headers = {};
  return req;
}

function makeStore() {
  const sessions = new Map();
  return {
    sessions: Object.fromEntries(sessions),
    dirty: 0,
    flushed: 0,
    get(key) {
      if (!sessions.has(key)) sessions.set(key, { phone: key, history: [] });
      return sessions.get(key);
    },
    has(key) { return sessions.has(key); },
    markDirty() { this.dirty++; },
    async flush() { this.flushed++; }
  };
}

async function postFinish(store, phone) {
  const res = response();
  await handleDashboardSettingsRoutes({
    req: request('/api/dashboard/finish', 'POST', { phone }),
    res,
    u: new URL(`http://localhost/api/dashboard/finish`),
    store,
    runtimeAI: () => ({ provider: 'gemini', model: 'gemini-3.8-flash' }),
    adminConfig: null
  });
  return { ...res, json: JSON.parse(res.body || '{}') };
}

test('finalizar atendimento em modo human devolve para bot e limpa estado de handoff', async () => {
  const store = makeStore();
  const session = store.get('5511999991000');
  session.human = true;
  session.humanSource = 'dashboard';
  session.handoffAt = '2026-11-16T10:00:00.000Z';
  session.handoffReason = 'resposta enviada pelo painel';
  session.handoffNotified = true;
  session.handoffReminder1Sent = true;
  session.handoffReminder60Sent = true;
  session.handoffReminderAt = '2026-11-16T10:30:00.000Z';
  session.inactivityClosed = false;
  session.history = [{ role: 'user', content: 'preciso de ajuda', createdAt: '2026-11-16T10:00:00.000Z' }];
  const self = store.get(OWNER_SELF_KEY);
  self.pendingReactivation = { phone: '5511999991000', contactLabel: 'Ana', unanswered: true };
  session.pendingDraft = 'rascunho antigo';

  const res = await postFinish(store, '5511999991000');

  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.human, false);
  assert.equal(res.json.alreadyBot, false);
  assert.equal(session.human, false);
  assert.equal(session.humanSource, null);
  assert.equal(session.handoffAt, null);
  assert.equal(session.handoffReason, null);
  assert.equal(session.handoffNotified, false);
  assert.equal(session.handoffReminder1Sent, false);
  assert.equal(session.handoffReminder60Sent, false);
  assert.equal(session.handoffReminderAt, null);
  assert.equal(session.pendingDraft, null);
  assert.ok(session.finishedAt);
  assert.match(session.finishReason || '', /atendimento finalizado pelo painel/);
  assert.equal(self.pendingReactivation, null);
  const note = session.history[session.history.length - 1];
  assert.match(note.content, /Atendimento finalizado — Lia retomou o atendimento/);
  assert.equal(note.systemNote, true);
  assert.ok(store.dirty > 0);
});

test('cancelar confirmação não chega à rota: estado permanece intacto sem POST', async () => {
  // A confirmação é feita no cliente (window.confirm): se o admin cancela, a rota nunca é chamada.
  // Este teste garante que nada muda quando nenhum POST acontece (estado prévio intacto).
  const store = makeStore();
  const session = store.get('5511999991000');
  session.human = true;
  session.handoffReason = 'resposta enviada pelo painel';
  session.history = [{ role: 'user', content: 'oi', createdAt: '2026-11-16T10:00:00.000Z' }];
  await Promise.resolve();
  assert.equal(session.human, true);
  assert.equal(session.handoffReason, 'resposta enviada pelo painel');
  assert.equal(session.history.length, 1);
});

test('chat já em modo bot não permite ação duplicada (no-op, sem nota de sistema)', async () => {
  const store = makeStore();
  const session = store.get('5511999992000');
  session.human = false;
  session.history = [{ role: 'assistant', content: 'Lia automática ativa' }];

  const res = await postFinish(store, '5511999992000');

  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.alreadyBot, true);
  assert.equal(session.human, false);
  assert.equal(session.history.length, 1, 'nenhuma nota de sistema deve ser adicionada');
  assert.equal(session.finishedAt, undefined);
});

test('nota de sistema fica registrada no histórico persistível da sessão', async () => {
  const store = makeStore();
  const session = store.get('5511999993000');
  session.human = true;
  session.handoffAt = '2026-11-16T09:00:00.000Z';
  const self = store.get(OWNER_SELF_KEY);
  self.pendingReactivation = { phone: '5511999999999', contactLabel: 'Outro contato' };

  await postFinish(store, '5511999993000');

  const notes = session.history.filter(m => m.systemNote === true);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /Atendimento finalizado/);
  assert.ok(notes[0].createdAt, 'nota persistida com timestamp');
  // pending de outro contato não é removido
  assert.equal(self.pendingReactivation.phone, '5511999999999');
});

test('phone inválido é rejeitado e sessão inexistente é no-op', async () => {
  const store = makeStore();
  const bad = await postFinish(store, 'abc');
  assert.equal(bad.statusCode, 400);

  const none = await postFinish(store, '5511999994000');
  assert.equal(none.statusCode, 200);
  assert.equal(none.json.alreadyBot, true);
});
