import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { LiaRuntimeStore, createLiaRuntime, evaluateAttention } from './index.mjs';
import { CopilotTaskStore } from '../copilot-tasks.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

// === 1. Identity ===
test('Runtime Identity: persiste de forma independente de sessão e sobrevive a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-id-'));
  const filePath = path.join(dir, 'lia-runtime.json');
  try {
    const store1 = new LiaRuntimeStore({ filePath, logger: silentLogger });
    const rt1 = createLiaRuntime({ store: store1, logger: silentLogger });
    await rt1.start();

    await rt1.identity.update({
      role: 'copiloto_operacional',
      operating_mode: 'proactive_safe',
      owner_preferences: { digestHour: 9 }
    });
    await rt1.identity.watchItem({ id: 'lead:5511999998888', kind: 'lead', label: 'Lead VIP' });

    // Simula restart em nova instância (sem SessionStore)
    const store2 = new LiaRuntimeStore({ filePath, logger: silentLogger });
    const rt2 = createLiaRuntime({ store: store2, logger: silentLogger });
    await rt2.start();
    const persisted = await rt2.identity.get();

    assert.equal(persisted.role, 'copiloto_operacional');
    assert.equal(persisted.operating_mode, 'proactive_safe');
    assert.equal(persisted.owner_preferences.digestHour, 9);
    assert.equal(persisted.watched_items.length, 1);
    assert.equal(persisted.watched_items[0].id, 'lead:5511999998888');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 2. Goals ===
test('Runtime Goals: criar, atualizar, pausar, concluir, cancelar e associar tarefas', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-goals-'));
  try {
    const store = new LiaRuntimeStore({ filePath: path.join(dir, 'lia-runtime.json'), logger: silentLogger });
    const rt = createLiaRuntime({ store, logger: silentLogger });
    await rt.start();

    const g1 = await rt.goals.create({
      title: 'Aumentar conversão comercial',
      indicator: 'qualified_leads',
      targetValue: 20,
      priority: 'high',
      status: 'active'
    });
    assert.equal(g1.status, 'active');
    assert.equal(g1.priority, 'high');

    const updated = await rt.goals.update(g1.id, { currentValue: 10 });
    assert.equal(updated.progress, 50);

    const linked = await rt.goals.linkTask(g1.id, 'task-uuid-1');
    assert.deepEqual(linked.task_ids, ['task-uuid-1']);

    const paused = await rt.goals.pause(g1.id);
    assert.equal(paused.status, 'paused');

    const completed = await rt.goals.complete(g1.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.ok(completed.completed_at);

    const g2 = await rt.goals.create({ title: 'Objetivo descartado', status: 'draft' });
    const cancelled = await rt.goals.cancel(g2.id, 'mudança de prioridade');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.metadata.cancel_reason, 'mudança de prioridade');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 3. Events ===
test('Runtime Events: persistência, deduplicação, processamento e restart recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-events-'));
  const filePath = path.join(dir, 'lia-runtime.json');
  try {
    let clock = 1_700_000_000_000;
    const store1 = new LiaRuntimeStore({ filePath, logger: silentLogger, now: () => clock });
    const rt1 = createLiaRuntime({ store: store1, logger: silentLogger, now: () => clock });
    await rt1.start();

    const first = await rt1.emitEvent({
      type: 'lead.created',
      source: 'crm',
      subject: 'lead-1',
      deduplicationKey: 'lead-created:1',
      payload: { score: 50, api_key: 'secret-must-not-persist' }
    });
    const duplicate = await rt1.emitEvent({
      type: 'lead.created',
      source: 'crm',
      subject: 'lead-1',
      deduplicationKey: 'lead-created:1',
      payload: { score: 50 }
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.event.payload.api_key, undefined);

    // Simula evento preso em `processing` antes de queda do processo
    await store1.updateEvent(first.event.id, { status: 'processing', attempts: 1 });
    clock += 10 * 60 * 1000;

    // Restart em nova instância deve recuperar evento preso e processá-lo
    const store2 = new LiaRuntimeStore({ filePath, logger: silentLogger, now: () => clock });
    const rt2 = createLiaRuntime({ store: store2, logger: silentLogger, now: () => clock });
    await rt2.start();
    const handled = [];
    rt2.events.on('lead.created', evt => handled.push(evt.id));

    const wakeResult = await rt2.wake({ reason: 'test_recovery' });
    assert.equal(wakeResult.ok, true);
    assert.equal(handled.length, 1);
    assert.equal(handled[0], first.event.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 4. Attention ===
test('Runtime Attention: ignora ruído irrelevante, avalia relevante e prioriza risco/impacto', () => {
  const irrelevant = evaluateAttention({
    type: 'message.received',
    priority: 'low',
    payload: { irrelevant: true }
  });
  assert.equal(irrelevant.recommended_action, 'ignore');
  assert.equal(irrelevant.requires_human, false);

  const relevantLead = evaluateAttention(
    {
      type: 'lead.updated',
      priority: 'high',
      subject: '5511999998888',
      payload: { phone: '5511999998888', score: 87, days_without_contact: 2 }
    },
    { activeGoals: [{ id: 'g1', title: 'Aumentar conversão comercial', indicator: 'qualified_leads', priority: 'high' }] }
  );
  assert.ok(relevantLead.attention_score >= 70);
  assert.equal(relevantLead.recommended_action, 'enqueue_read_task');
  assert.equal(relevantLead.requires_human, true);
  assert.deepEqual(relevantLead.suggested_plan, [{ name: 'consultar_contato_ou_lead', args: { termo: '5511999998888' } }]);

  const uncertain = evaluateAttention({ type: 'task.uncertain', priority: 'medium', payload: {} });
  assert.equal(uncertain.priority, 'critical');
  assert.equal(uncertain.risk, 'critical');
  assert.equal(uncertain.recommended_action, 'escalate_human');
  assert.equal(uncertain.suggested_plan, null);
});

// === 5. Runtime Lifecycle & Recovery ===
test('Runtime Lifecycle: inicia, acorda, avalia, dorme e recupera de estado working travado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-life-'));
  const filePath = path.join(dir, 'lia-runtime.json');
  try {
    let clock = 1_700_000_000_000;
    const store1 = new LiaRuntimeStore({ filePath, logger: silentLogger, now: () => clock });
    await store1.load();
    await store1.saveRuntimeState({
      id: 'primary',
      state: 'working',
      state_entered_at: new Date(clock).toISOString()
    });

    // Avança além do timeout de working (5 min)
    clock += 6 * 60 * 1000;
    const store2 = new LiaRuntimeStore({ filePath, logger: silentLogger, now: () => clock });
    const rt = createLiaRuntime({ store: store2, logger: silentLogger, now: () => clock });
    await rt.start();

    assert.equal(rt.state, 'idle');
    assert.ok(rt.recentLogs.some(l => l.event === 'runtime.recovered'));
    assert.ok(rt.recentLogs.some(l => l.event === 'runtime.started'));

    const res = await rt.wake({ reason: 'scheduler' });
    assert.equal(res.ok, true);
    assert.equal(rt.state, 'idle');
    assert.ok(rt.recentLogs.some(l => l.event === 'runtime.woke'));
    assert.ok(rt.recentLogs.some(l => l.event === 'runtime.sleep'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 6. Queue Integration (copilot_tasks) ===
test('Runtime Queue: encaminha investigação somente-leitura para copilot_tasks e vincula ao objetivo', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-queue-'));
  try {
    const runtimeStore = new LiaRuntimeStore({ filePath: path.join(dir, 'lia-runtime.json'), logger: silentLogger });
    const taskStore = new CopilotTaskStore({ filePath: path.join(dir, 'copilot-tasks.json'), logger: silentLogger });
    await taskStore.load();

    const rt = createLiaRuntime({
      store: runtimeStore,
      taskStore,
      getBotConfig: () => ({}),
      getHumanPhone: () => '5588999999999',
      logger: silentLogger
    });
    await rt.start();

    const goal = await rt.goals.create({
      title: 'Aumentar conversão comercial',
      indicator: 'qualified_leads',
      priority: 'high',
      status: 'active'
    });

    await rt.emitEvent({
      type: 'lead.updated',
      source: 'crm',
      subject: '5511988887777',
      priority: 'high',
      deduplicationKey: 'lead-high:5511988887777',
      payload: { phone: '5511988887777', score: 90, days_without_contact: 3 }
    });

    const summary = await rt.wake({ reason: 'event' });
    assert.equal(summary.tasksCreated, 1);

    const latestTask = await taskStore.getLatest('owner_self');
    assert.ok(latestTask);
    assert.equal(latestTask.status, 'queued');
    assert.equal(latestTask.retryPolicy, 'read_only');
    assert.equal(latestTask.steps[0].name, 'consultar_contato_ou_lead');

    const refreshedGoal = await rt.goals.get(goal.id);
    assert.ok(refreshedGoal.task_ids.includes(latestTask.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 7. Commitments ===
test('Runtime Commitments: persiste, gera commitment.due no prazo e compromisso concluído não gera novo trabalho', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-commit-'));
  try {
    let clock = Date.parse('2026-11-21T10:00:00Z');
    const store = new LiaRuntimeStore({ filePath: path.join(dir, 'lia-runtime.json'), logger: silentLogger, now: () => clock });
    const rt = createLiaRuntime({ store, logger: silentLogger, now: () => clock });
    await rt.start();

    const cDue = await rt.commitments.create({
      title: 'Retornar proposta ao cliente',
      subject: '5511977776666',
      dueAt: '2026-11-22T10:00:00Z'
    });
    const cFulfilled = await rt.commitments.create({
      title: 'Confirmar recebimento',
      subject: '5511966665555',
      dueAt: '2026-11-22T09:00:00Z'
    });
    await rt.commitments.fulfill(cFulfilled.id);

    // Antes do prazo: nada dispara
    const before = await rt.wake({ reason: 'scheduler' });
    assert.equal(before.dueCommitments, 0);

    // Após o prazo: apenas o pendente gera commitment.due
    clock = Date.parse('2026-11-22T10:05:00Z');
    const dueEvents = [];
    rt.events.on('commitment.due', evt => dueEvents.push(evt));

    const after = await rt.wake({ reason: 'scheduler' });
    assert.equal(after.dueCommitments, 1);
    assert.equal(dueEvents.length, 1);
    assert.equal(dueEvents[0].payload.commitment_id, cDue.id);

    // Novo wake não duplica o evento do mesmo compromisso
    const secondWake = await rt.wake({ reason: 'scheduler' });
    assert.equal(secondWake.dueCommitments, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Runtime Commitments: vencimento notifica cliente somente pelo gate fornecido e mantém alerta do responsável', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-commit-recipient-'));
  try {
    let clock = Date.parse('2026-11-22T12:00:00Z');
    const store = new LiaRuntimeStore({ filePath: path.join(dir, 'lia-runtime.json'), logger: silentLogger, now: () => clock });
    const clientNotifications = [];
    const ownerNotifications = [];
    const rt = createLiaRuntime({
      store,
      logger: silentLogger,
      now: () => clock,
      notifyCommitmentRecipient: async commitment => {
        clientNotifications.push(commitment.id);
        return { sent: commitment.title === 'Atualizar cliente', reason: 'outside_business_hours' };
      },
      notifyOwner: async message => ownerNotifications.push(message)
    });
    await rt.start();

    const blocked = await rt.commitments.create({
      title: 'Aguardar autorização',
      dueAt: new Date(clock + 1000).toISOString(),
      recipientType: 'client',
      recipientPhone: '5588999990001',
      ownerType: 'owner',
      conversationId: '5588999990001'
    });
    const sent = await rt.commitments.create({
      title: 'Atualizar cliente',
      dueAt: new Date(clock + 1000).toISOString(),
      recipientType: 'client',
      recipientPhone: '5588999990002',
      ownerType: 'bot',
      conversationId: '5588999990002'
    });

    clock += 2000;
    const first = await rt.wake({ reason: 'scheduler' });
    assert.equal(first.dueCommitments, 2);
    assert.deepEqual(new Set(clientNotifications), new Set([blocked.id, sent.id]));
    assert.equal(ownerNotifications.length, 1);
    assert.match(ownerNotifications[0], /Aguardar autorização/);
    assert.equal((await rt.commitments.get(blocked.id)).status, 'overdue');
    assert.equal((await rt.commitments.get(sent.id)).status, 'overdue');

    const second = await rt.wake({ reason: 'scheduler' });
    assert.equal(second.dueCommitments, 0);
    assert.equal(clientNotifications.length, 2);
    assert.equal(ownerNotifications.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// === 8. Security & Readiness ===
test('Runtime Security & Readiness: bloqueia Pix automático, outbound proibido, replay incerto e falha fechado em corrupção', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lia-rt-sec-'));
  try {
    const runtimeStore = new LiaRuntimeStore({ filePath: path.join(dir, 'lia-runtime.json'), logger: silentLogger });
    const taskStore = new CopilotTaskStore({ filePath: path.join(dir, 'copilot-tasks.json'), logger: silentLogger });
    await taskStore.load();

    const rt = createLiaRuntime({
      store: runtimeStore,
      taskStore,
      getBotConfig: () => ({}),
      logger: silentLogger
    });
    await rt.start();
    assert.equal(rt.readiness().status, 'ready');

    // 1. Tentativa de Pix automático
    await rt.emitEvent({
      type: 'followup.due',
      source: 'test',
      subject: '5511955554444',
      priority: 'high',
      deduplicationKey: 'sec:pix',
      payload: { requires_pix: true, requested_tool: 'gerar_cobranca_pix' }
    });
    // 2. Tentativa de outbound direto
    await rt.emitEvent({
      type: 'lead.updated',
      source: 'test',
      subject: '5511955553333',
      priority: 'high',
      deduplicationKey: 'sec:outbound',
      payload: { requires_outbound: true, requested_tool: 'enviar_mensagem_contato' }
    });
    // 3. Tarefa incerta nunca deve ser repetida
    await rt.emitEvent({
      type: 'task.uncertain',
      source: 'copilot_worker',
      subject: 'task-uncertain-1',
      priority: 'critical',
      deduplicationKey: 'sec:uncertain',
      payload: { task_id: 'task-uncertain-1' }
    });

    const summary = await rt.wake({ reason: 'security_check' });
    assert.equal(summary.tasksCreated, 0, 'nenhuma tarefa perigosa ou incerta pode ser enfileirada automaticamente');
    assert.equal(summary.needsHumanCount, 3);
    assert.equal(rt.state, 'needs_human');
    assert.equal(await taskStore.getLatest('owner_self'), null);

    // 4. Readiness falha fechado se arquivo local estiver corrompido
    const corruptPath = path.join(dir, 'corrupt.json');
    await writeFile(corruptPath, '{not-valid-json', 'utf8');
    const corruptStore = new LiaRuntimeStore({ filePath: corruptPath, logger: silentLogger });
    const corruptRt = createLiaRuntime({ store: corruptStore, logger: silentLogger });
    await corruptRt.start();
    const readiness = corruptRt.readiness();
    assert.equal(readiness.status, 'unavailable');
    assert.equal(readiness.reason, 'local_store_corrupt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
