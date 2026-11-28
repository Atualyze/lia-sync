import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInboundAccess } from './access-control.mjs';
import { compressHistoryForProvider } from './ai/context-compressor.mjs';
import {
  recordFreeTierUsage,
  recordFreeTierRateLimit,
  isFreeTierInCooldown,
  getFreeTierQuotaSnapshot,
  clearFreeTierTracker
} from './ai/free-tier-tracker.mjs';
import { applyStageAutomations } from './crm/stage-automations.mjs';
import { toolGerenciarCampanha } from './tools/gerenciar_campanha.mjs';

test('evaluateInboundAccess aplica whitelist, blacklist e grupos corretamente sem bloquear o dono', () => {
  const cfg = {
    mode: 'whitelist',
    whitelist: ['5511999998888'],
    blacklist: ['5511777776666'],
    ignoreGroups: true,
    allowedGroups: ['1203630001@g.us']
  };
  assert.equal(evaluateInboundAccess({ phone: '5511777776666', isOwner: true, accessControl: cfg }).allowed, true);
  assert.equal(evaluateInboundAccess({ phone: '5511777776666', accessControl: cfg }).reason, 'blacklisted');
  assert.equal(evaluateInboundAccess({ phone: '5511999998888', accessControl: cfg }).allowed, true);
  assert.equal(evaluateInboundAccess({ phone: '5511000001111', accessControl: cfg }).reason, 'not_whitelisted');
  assert.equal(evaluateInboundAccess({ jid: '999999@g.us', accessControl: cfg }).reason, 'group_ignored');
  assert.equal(evaluateInboundAccess({ jid: '1203630001@g.us', accessControl: cfg }).allowed, true);
});

test('compressHistoryForProvider preserva turnos recentes intactos e compacta mensagens antigas longas', () => {
  const longOld = 'A'.repeat(400);
  const history = [
    { role: 'user', content: longOld },
    { role: 'assistant', content: 'Resposta recente 1' },
    { role: 'user', content: 'Pergunta recente 2' }
  ];
  const compressed = compressHistoryForProvider(history, { keepRecent: 2, olderTurnMaxChars: 120 });
  assert.equal(compressed.length, 3);
  assert.ok(compressed[0].content.includes('[...]'));
  assert.ok(compressed[0].content.length <= 125);
  assert.equal(compressed[1].content, 'Resposta recente 1');
  assert.equal(compressed[2].content, 'Pergunta recente 2');
});

test('free-tier-tracker registra uso, cooldown de 429 e snapshot', () => {
  clearFreeTierTracker();
  recordFreeTierUsage('groq', 'openai/gpt-oss-120b', 500);
  assert.equal(isFreeTierInCooldown('groq', 'openai/gpt-oss-120b'), false);
  recordFreeTierRateLimit('groq', 'openai/gpt-oss-120b', 10_000);
  assert.equal(isFreeTierInCooldown('groq', 'openai/gpt-oss-120b'), true);
  const snap = getFreeTierQuotaSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].tokens, 500);
  assert.equal(snap[0].rateLimits, 1);
});

test('applyStageAutomations adiciona tags, agenda follow-up e notifica admin', () => {
  const session = { phone: '5511999998888', contactName: 'Maria', tags: ['site'] };
  const alerts = [];
  const res = applyStageAutomations({
    session,
    newStage: 'agendado',
    botConfig: {
      crm: {
        stageAutomations: [
          { stage: 'agendado', addTags: ['vip', 'site'], followUpHours: 24, notifyAdmin: true }
        ]
      }
    },
    notifyAdmin: msg => alerts.push(msg),
    now: () => 1_700_000_000_000
  });
  assert.equal(res.matched, 1);
  assert.deepEqual(res.addedTags, ['vip']);
  assert.deepEqual(session.tags, ['site', 'vip']);
  assert.ok(session.nextFollowUpAt);
  assert.equal(alerts.length, 1);
});

test('toolGerenciarCampanha exige confirmação para criar/executar e bloqueia client', async () => {
  const clientRes = await toolGerenciarCampanha.execute({ acao: 'listar' }, { actor: 'client' });
  assert.equal(clientRes.success, false);
  assert.equal(clientRes.error, 'owner_only_tool');

  const previewRes = await toolGerenciarCampanha.execute(
    { acao: 'criar', title: 'Teste', message: 'Oi {{nome}}', recipients: [{ phone: '5511999998888' }] },
    { actor: 'owner', campaignStore: { enabled: true } }
  );
  assert.equal(previewRes.requiresConfirmation, true);
});
