import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeHistory } from './ai/parsing.mjs';
import { SessionStore } from './sessions.mjs';
import { SupabaseSessionStore } from './supabase-runtime.mjs';
import { processMaintenance } from './maintenance.mjs';
import { executeToolCall, toolAtualizarDadosCRM, toolConsultarContato } from './tools/index.mjs';

const quietLogger = { warn() {}, error() {}, log() {} };

test('histórico enviado à IA tem no máximo 24 turnos e 12 mil caracteres', () => {
  const history = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'user', content: `mensagem-${i}-` + 'u'.repeat(900) });
    history.push({ role: 'assistant', content: `resposta-${i}-` + 'a'.repeat(900) });
  }
  const normalized = normalizeHistory(history);
  assert.ok(normalized.length <= 24);
  assert.ok(normalized.reduce((sum, item) => sum + item.content.length, 0) <= 12000);
  assert.equal(normalized[0].role, 'user');
  assert.match(normalized.at(-1).content, /resposta-39/);
});

test('atualização CRM grava no contato da sessão e rejeita etapa fora do enum', async () => {
  const session = { phone: '5588999990000' };
  let dirty = 0;
  const valid = await toolAtualizarDadosCRM.execute({ interesse: 'Plano A', observacoes: 'Quer retorno na sexta', estagio: 'proposta' }, {
    session, store: { markDirty() { dirty++; } }
  });
  assert.equal(valid.success, true);
  assert.equal(session.productInterest, 'Plano A');
  assert.equal(session.contactNotes, 'Quer retorno na sexta');
  assert.equal(session.crmNotes, 'Quer retorno na sexta');
  assert.equal(session.dealStage, 'proposta');
  assert.equal(dirty, 1);
  const invalid = await executeToolCall('atualizar_dados_crm', { estagio: 'inventado' }, { actor: 'owner', session });
  assert.equal(invalid.success, false);
  assert.equal(invalid.code, 'invalid_tool_arguments');
});

test('consulta CRM não cria falso contato e retorna notas da sessão existente', async () => {
  const emptyStore = { sessions: {} };
  const missing = await toolConsultarContato.execute({ phone: '5588999990000' }, { store: emptyStore });
  assert.equal(missing.found, false);
  assert.deepEqual(emptyStore.sessions, {});

  const store = { sessions: { '5588999990000': { phone: '5588999990000', clientName: 'Ana', contactNotes: 'Retornar sexta', dealStage: 'proposta' } } };
  const found = await toolConsultarContato.execute({ phone: '5588999990000' }, { store });
  assert.equal(found.found, true);
  assert.equal(found.name, 'Ana');
  assert.equal(found.notes, 'Retornar sexta');
  assert.equal(found.type, 'proposta');
});

test('metadata de CRM permanece vinculada ao mesmo contact_id no Supabase', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-contact-'));
  const writes = [];
  const client = {
    enabled: true,
    async upsert(table, rows) {
      writes.push({ table, rows });
      return table === 'contacts' ? [{ id: 'contact-abc' }] : [{ id: 'conversation-abc' }];
    }
  };
  const store = new SupabaseSessionStore(path.join(dir, 'sessions.json'), { client, logger: quietLogger });
  store.sessions['5588999990000'] = {
    phone: '5588999990000', origin: 'real', history: [], contactNotes: 'Notas CRM', productInterest: 'Plano B', dealStage: 'qualificacao'
  };
  await store.flush();
  const conversation = writes.find(item => item.table === 'conversations').rows[0];
  assert.equal(conversation.contact_id, 'contact-abc');
  assert.equal(conversation.metadata.contactNotes, 'Notas CRM');
  assert.equal(conversation.metadata.productInterest, 'Plano B');
  assert.equal(conversation.metadata.dealStage, 'qualificacao');
});

test('duas rodadas de manutenção simultâneas não disparam follow-up duplicado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'followup-race-'));
  const store = new SessionStore(path.join(dir, 'sessions.json'), { logger: quietLogger });
  await store.load();
  let claimed = false;
  store.client = { enabled: true };
  store.claimFollowUp = async () => {
    if (claimed) return null;
    claimed = true;
    return 'a247c4f2-e1df-4f50-a2fa-a57f28aa8ea3';
  };
  store.completeFollowUp = async () => true;
  store.releaseFollowUpClaim = async () => true;
  const phone = '5588998765432';
  const session = store.get(phone);
  const current = Date.parse('2026-11-06T14:00:00.000Z');
  session.lastUserAt = new Date(current - 31 * 3600000).toISOString();
  session.lastBotAt = new Date(current - 30 * 3600000).toISOString();
  session.history = [
    { role: 'user', content: 'Quero receber uma proposta comercial.' },
    { role: 'assistant', content: 'Vou preparar para você.' }
  ];
  let sends = 0;
  let previews = 0;
  const run = () => processMaintenance({
    store,
    send: async () => { sends++; await new Promise(resolve => setTimeout(resolve, 15)); },
    stageOutboundDispatch: async () => { previews++; return { id: 'B2C3D4E5' }; },
    now: () => current,
    timeZone: 'America/Fortaleza',
    enableLeadFollowUp: true
  });
  await Promise.all([run(), run()]);
  assert.equal(sends, 0, 'follow-up não deve ser enviado antes da aprovação');
  assert.equal(previews, 1, 'duas execuções concorrentes devem criar uma única prévia local');
  assert.equal(session.followUpSentAt, undefined);
  assert.equal(session.followUpPendingId, 'B2C3D4E5');
});
