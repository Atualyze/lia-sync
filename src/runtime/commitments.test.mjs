import assert from 'node:assert/strict';
import test from 'node:test';
import { CommitmentStore } from './commitments.mjs';

function createMemoryStore() {
  const records = new Map();
  return {
    records,
    async upsertCommitment(row) {
      const copy = structuredClone(row);
      records.set(copy.id, copy);
      return structuredClone(copy);
    },
    async getCommitment(id) {
      const row = records.get(id);
      return row ? structuredClone(row) : null;
    },
    async getCommitmentByDeduplicationKey(key) {
      const row = [...records.values()].find(item => item.deduplication_key === key);
      return row ? structuredClone(row) : null;
    },
    async listCommitments() {
      return [...records.values()].map(row => structuredClone(row));
    }
  };
}

test('CommitmentStore persists recipient, conversation, owner, category and idempotency key', async () => {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const store = createMemoryStore();
  const commitments = new CommitmentStore({ store, now: () => clock });
  const input = {
    title: 'Retornar sobre o contrato',
    description: 'Confirmar a minuta solicitada',
    subject: 'Cliente de teste',
    dueAt: new Date(clock + 60 * 60_000).toISOString(),
    conversationId: '5599999999999',
    recipientType: 'client',
    recipientPhone: '55 99 99999-9999',
    ownerType: 'owner',
    category: 'reclamacao',
    metadata: { kind: 'admin_consult' },
    deduplicationKey: 'promise:test:message-1'
  };
  const first = await commitments.create(input);
  const duplicate = await commitments.create({ ...input, title: 'Título repetido' });

  assert.equal(first.id, duplicate.id);
  assert.equal(duplicate.title, 'Retornar sobre o contrato');
  assert.equal(first.status, 'pending');
  assert.equal(first.recipient_type, 'client');
  assert.equal(first.recipient_phone, '5599999999999');
  assert.equal(first.owner_type, 'owner');
  assert.equal(first.category, 'reclamacao');
  assert.equal(first.conversation_id, '5599999999999');
  assert.equal(first.deduplication_key, 'promise:test:message-1');
  assert.equal((await commitments.list({ status: 'pending' })).length, 1);
});

test('CommitmentStore validates recipients, category and realistic future deadlines', async () => {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const commitments = new CommitmentStore({ store: createMemoryStore(), now: () => clock });
  const dueAt = new Date(clock + 60 * 60_000).toISOString();
  await assert.rejects(() => commitments.create({ title: 'x', dueAt, recipientType: 'client' }), /commitment_client_phone_required/);
  await assert.rejects(() => commitments.create({ title: 'x', dueAt, recipientType: 'invalid' }), /invalid_commitment_recipient/);
  await assert.rejects(() => commitments.create({ title: 'x', dueAt, category: 'pix_automatico' }), /invalid_commitment_category/);
  await assert.rejects(() => commitments.create({ title: 'x', dueAt: new Date(clock - 1).toISOString() }), /commitment_due_at_out_of_range/);
  await assert.rejects(() => commitments.create({ title: 'x', dueAt: new Date(clock + 91 * 24 * 60 * 60_000).toISOString() }), /commitment_due_at_out_of_range/);
});

test('CommitmentStore tracks pending → in_progress → overdue → uncertain → fulfilled and blocks terminal replay', async () => {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const store = createMemoryStore();
  const commitments = new CommitmentStore({ store, now: () => clock });
  const item = await commitments.create({
    title: 'Conferir retorno',
    dueAt: new Date(clock + 60 * 60_000).toISOString(),
    recipientType: 'owner',
    ownerType: 'owner'
  });

  const started = await commitments.start(item.id, { metadata: { linkedTaskId: 'task-123' } });
  assert.equal(started.status, 'in_progress');
  assert.equal(started.metadata.linkedTaskId, 'task-123');

  clock += 2 * 60 * 60_000;
  const overdue = await commitments.markOverdue(item.id, 'deadline_elapsed');
  assert.equal(overdue.status, 'overdue');
  assert.ok(overdue.overdue_at);

  const uncertain = await commitments.markUncertain(item.id, 'delivery_uncertain');
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.failure_reason, 'delivery_uncertain');

  const fulfilled = await commitments.fulfill(item.id);
  assert.equal(fulfilled.status, 'fulfilled');
  assert.ok(fulfilled.fulfilled_at);
  await assert.rejects(() => commitments.cancel(item.id), /invalid_commitment_transition/);
});

test('CommitmentStore keeps cancelled commitments terminal and emits one due event marker', async () => {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const store = createMemoryStore();
  const commitments = new CommitmentStore({ store, now: () => clock });
  const cancelled = await commitments.create({
    title: 'Não executar',
    dueAt: new Date(clock + 60 * 60_000).toISOString()
  });
  await commitments.cancel(cancelled.id);
  clock += 2 * 60 * 60_000;
  assert.deepEqual(await commitments.findDue(clock), []);
  await assert.rejects(() => commitments.fulfill(cancelled.id), /invalid_commitment_transition/);

  const due = await commitments.create({
    title: 'Avisar cliente',
    dueAt: new Date(clock + 1000).toISOString(),
    recipientType: 'client',
    recipientPhone: '5588999999999'
  });
  clock += 2000;
  assert.equal((await commitments.findDue(clock)).length, 1);
  await commitments.markDueEventEmitted(due.id, 'event-1');
  assert.equal((await commitments.findDue(clock)).length, 0);
  assert.equal((await commitments.get(due.id)).notified_event_id, 'event-1');
});
