import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlow, isTalkToTauanRequest } from './flow.mjs';
import { SessionStore } from './sessions.mjs';

function createMockStore() {
  const sessions = {};
  return {
    sessions,
    get(phone, origin = 'real') {
      const key = origin === 'simulation' ? `sim:${phone}` : phone;
      if (!sessions[key]) {
        sessions[key] = {
          phone,
          history: [],
          human: false,
          handoffAt: null,
          origin
        };
      }
      return sessions[key];
    },
    touch() {},
    markDirty() {}
  };
}

test('Conversa interna: número legado NÃO ativa mais o copiloto do Tauan', async () => {
  const store = createMockStore();
  let aiCalledWithTauan = false;

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async ({ isTauan, system }) => {
        if (isTauan || system?.includes('copiloto executiva')) {
          aiCalledWithTauan = true;
        }
        return { reply: 'Olá!', intent: 'saudacao' };
      }
    }
  });

  // Mensagem vinda do número antigo 558898340085
  await flow.process({
    phone: '558898340085',
    text: 'status'
  });

  // Não deve ter ativado a persona de copiloto interno
  assert.equal(aiCalledWithTauan, false, 'Número antigo não deve ativar o copiloto interno');
});

test('Conversa interna: comandos operacionais (ajuda, status, fila)', async () => {
  const store = createMockStore();
  
  // Cliente 1 em espera
  const sClient = store.get('5511999998888');
  sClient.clientName = 'Carlos Silva';
  sClient.human = true;
  sClient.handoffAt = new Date(Date.now() - 10 * 60000).toISOString();
  sClient.history.push({ role: 'user', content: 'Gostaria de um orçamento para o app' });

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    getTelemetry: async () => ({
      activeProvider: 'gemini',
      activeModel: 'gemini-3.8-flash',
      evolution: { status: 'connected' }
    }),
    ai: { askAI: async () => ({ reply: 'ok' }) }
  });

  // Comando ajuda
  const help = await flow.process({ phone: '5588921694598', text: 'ajuda' });
  assert.match(help, /\*status\*/);
  assert.match(help, /\*fila\*/);
  assert.match(help, /\*bot \[número\]\*/);

  // Comando status
  const status = await flow.process({ phone: '5588921694598', text: 'status' });
  assert.match(status, /Raio-X Operacional/);
  assert.match(status, /gemini-3\.8-flash/);
  assert.match(status, /🟢 Conectado/);
  assert.match(status, /Em espera humana/);

  // Comando fila
  const fila = await flow.process({ phone: '5588921694598', text: 'fila' });
  assert.match(fila, /Carlos Silva/);
  assert.match(fila, /wa\.me\/5511999998888/);
  assert.match(fila, /orçamento para o app/);
});

test('Conversa interna: comandos de gestão de contatos (bot, humano, limpar)', async () => {
  const store = createMockStore();
  let flushCalled = false;
  store.flush = async () => { flushCalled = true; };

  const clientPhone = '5588993602644';
  const sClient = store.get(clientPhone);
  sClient.clientName = 'Mikaelle Santos';
  sClient.human = true;
  sClient.handoffAt = new Date().toISOString();
  sClient.history.push({ role: 'user', content: 'Oi' });

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: { askAI: async () => ({ reply: 'ok' }) }
  });

  // 1. Comando bot com telefone formatado (+55 88 99360-2644)
  const repFormatado = await flow.process({ phone: '5588921694598', text: 'bot +55 88 99360-2644' });
  assert.match(repFormatado, /Bot reativado com sucesso/);
  assert.match(repFormatado, /Mikaelle Santos/);
  assert.equal(sClient.human, false, 'Sessão do cliente deve voltar para bot (human=false)');
  assert.equal(typeof sClient.updatedAt, 'string', 'updatedAt deve ser preenchido');
  assert.equal(flushCalled, true, 'flush deve ter sido chamado para persistir no banco');

  // 2. Coloca em humano pelo nome
  sClient.human = false;
  const repHumanoNome = await flow.process({ phone: '5588921694598', text: 'humano mikaelle' });
  assert.match(repHumanoNome, /Atendimento humano ativado/);
  assert.equal(sClient.human, true, 'Sessão do cliente deve ficar em modo humano');

  // 3. Reativa bot pelo índice 1 da fila (bot 1)
  const repBotIdx = await flow.process({ phone: '5588921694598', text: 'bot 1' });
  assert.match(repBotIdx, /Bot reativado com sucesso/);
  assert.match(repBotIdx, /Mikaelle Santos/);
  assert.equal(sClient.human, false, 'Sessão reativada pelo índice');

  // 4. Comando limpar
  sClient.history = [{ role: 'user', content: 'teste' }];
  const repLimpar = await flow.process({ phone: '5588921694598', text: `limpar ${clientPhone}` });
  assert.match(repLimpar, /Sessão resetada com sucesso/);
  assert.equal(sClient.history.length, 0, 'Histórico do cliente deve ser esvaziado');
  assert.equal(sClient.human, false, 'Cliente resetado volta para bot');

  // 5. Variantes de pergunta de fila
  sClient.human = true;
  sClient.clientName = 'Glória Vasconcelos';
  sClient.handoffAt = new Date(Date.now() - 15 * 60000).toISOString();
  sClient.history = [{ role: 'user', content: 'Dúvida sobre a entrega' }];

  const repQuem = await flow.process({ phone: '5588921694598', text: 'quem tá esperando?' });
  assert.match(repQuem, /Glória Vasconcelos/);
  assert.match(repQuem, /15 min/);

  const repLista = await flow.process({ phone: '5588921694598', text: 'lista completa' });
  assert.match(repLista, /Glória Vasconcelos/);

  const repAlguem = await flow.process({ phone: '5588921694598', text: 'tem alguém esperando?' });
  assert.match(repAlguem, /Glória Vasconcelos/);
});

test('Conversa interna: respostas de IA passam por filterReply', async () => {
  const store = createMockStore();
  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async () => ({
        reply: '**Relatório executivo:**\n- Ponto 1\n- Ponto 2'
      })
    }
  });

  const rep = await flow.process({ phone: '5588921694598', text: 'Me faz um resumo das tarefas' });
  // Deve ter convertido ** em * do WhatsApp e - em •
  assert.match(rep, /\*Relatório executivo:\*/);
  assert.match(rep, /• Ponto 1/);
  assert.doesNotMatch(rep, /\*\*/);
});

test('Cliente: menção casual ao Tauan não dispara handoff robótico prematuro', async () => {
  // Teste da regex isTalkToTauanRequest
  assert.equal(isTalkToTauanRequest('O Tauan me indicou o trabalho de vocês'), false);
  assert.equal(isTalkToTauanRequest('Conheci o Tauan na faculdade'), false);
  assert.equal(isTalkToTauanRequest('Bom dia, tudo bem?'), false);

  // Casos que DEVEM disparar transferência expressa:
  assert.equal(isTalkToTauanRequest('Quero falar com o Tauan'), true);
  assert.equal(isTalkToTauanRequest('Pode me passar pro Tauan?'), true);
  assert.equal(isTalkToTauanRequest('falar com humano'), true);
  assert.equal(isTalkToTauanRequest('chamar atendente'), true);
  assert.equal(isTalkToTauanRequest('opcao 2'), true);
  assert.equal(isTalkToTauanRequest('2'), true);
});
