import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGerenciarConfiguracao } from './tools/gerenciar_configuracao.mjs';
import { toolGerenciarCodigo } from './tools/gerenciar_codigo.mjs';

test('gerenciar_configuracao bloqueia credenciais e só opera no owner', async () => {
  const blocked = await toolGerenciarConfiguracao.execute({
    acao: 'alterar_rascunho',
    patch: { tools: { settings: { gerenciar_cobranca_pagamento: { apiKey: 'secret' } } } }
  }, { actor: 'owner', adminConfig: {} });
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, 'config_field_blocked');

  const denied = await toolGerenciarConfiguracao.execute({ acao: 'consultar' }, {
    actor: 'client',
    adminConfig: { active: {}, draft: {}, revision: 0 }
  });
  assert.equal(denied.success, false);
});

test('gerenciar_configuracao altera rascunho e exige confirmação para publicar', async () => {
  const calls = [];
  const adminConfig = {
    active: { ai: { activeModel: 'model-a' } },
    draft: { ai: { activeModel: 'model-a' } },
    revision: 3,
    persistence: 'supabase',
    async updateDraft(patch, actor, revision) {
      calls.push(['draft', patch, actor, revision]);
      return { ok: true, snapshot: { revision: 3, draft: { ai: { activeModel: 'model-b' } } } };
    },
    async publish(actor, revision) {
      calls.push(['publish', actor, revision]);
      return { ok: true, snapshot: { revision: 4, active: { ai: { activeModel: 'model-b' } } } };
    }
  };

  const draft = await toolGerenciarConfiguracao.execute({
    acao: 'alterar_rascunho',
    patch: { ai: { activeModel: 'model-b' } },
    baseRevision: 3
  }, { actor: 'owner', adminConfig });
  assert.equal(draft.success, true);
  assert.equal(calls[0][0], 'draft');

  const blockedPublish = await toolGerenciarConfiguracao.execute({
    acao: 'publicar',
    baseRevision: 3
  }, { actor: 'owner', adminConfig });
  assert.equal(blockedPublish.success, false);
  assert.equal(blockedPublish.code, 'confirmation_required');

  const published = await toolGerenciarConfiguracao.execute({
    acao: 'publicar',
    confirmar: true,
    baseRevision: 3
  }, { actor: 'owner', adminConfig });
  assert.equal(published.success, true);
  assert.equal(calls[1][0], 'publish');
});

test('gerenciar_codigo exige confirmação para criar PR', async () => {
  const result = await toolGerenciarCodigo.execute({
    acao: 'criar_pr',
    arquivos: [{ caminho: 'src/example.mjs', conteudo: 'export const ok = true;\n' }]
  }, { actor: 'owner', githubToken: 'test-token' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'confirmation_required');
});

test('gerenciar_codigo rejeita caminhos e atores inseguros antes de escrever', async () => {
  const deniedActor = await toolGerenciarCodigo.execute({
    acao: 'criar_pr',
    confirmar: true,
    arquivos: [{ caminho: 'src/example.mjs', conteudo: 'x' }]
  }, { actor: 'client', githubToken: 'test-token' });
  assert.equal(deniedActor.success, false);

  const invalidPath = await toolGerenciarCodigo.execute({
    acao: 'criar_pr',
    confirmar: true,
    arquivos: [{ caminho: '.env', conteudo: 'SECRET=x' }]
  }, { actor: 'owner', githubToken: 'test-token', githubRepository: 'Atualyze/lia-sync' });
  assert.equal(invalidPath.success, false);
  assert.match(invalidPath.error, /caminho não permitido/i);
});
