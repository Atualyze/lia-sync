import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlow, isTalkToOwnerRequest } from './flow.mjs';
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
  assert.match(repFormatado, /ficou sem resposta|no vácuo/i, 'Deve perguntar sobre a continuidade quando a última mensagem é do cliente');
  assert.equal(store.get('owner_self').pendingReactivation?.phone, clientPhone, 'Deve preservar a decisão pendente no chat interno');
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
  assert.match(repQuem, /Glória Vasconcelos/);
});

test('Conversa interna: interpreta pedidos naturais para retomar e assumir contato', async () => {
  const store = createMockStore();
  const client = store.get('5588993602644');
  client.clientName = 'Mikaelle Santos';
  client.human = true;
  client.handoffAt = new Date().toISOString();
  client.history = [{ role: 'user', content: 'Ainda tenho uma dúvida sobre o orçamento' }];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async ({ system, userText }) => system?.includes('Interprete apenas pedidos operacionais')
        ? { text: JSON.stringify({ intent: /devolver|retomar/i.test(userText) ? 'resume_bot' : 'activate_human', target: 'Mikaelle', confidence: 0.96 }) }
        : { reply: 'ok' }
    }
  });

  const resumed = await flow.process({ phone: '5588921694598', text: 'Pode devolver a conversa da Mikaelle para a Lia?' });
  assert.match(resumed, /Bot reativado com sucesso/i);
  assert.equal(client.human, false);
  assert.match(resumed, /ficou sem resposta|no vácuo/i);

  client.human = true;
  const human = await flow.process({ phone: '5588921694598', text: 'Assuma pessoalmente o atendimento da Mikaelle' });
  assert.match(human, /Atendimento humano ativado/i);
  assert.equal(client.human, true);
});

test('Conversa interna: frases comuns com "aguardando", "quem" ou "lista" não abrem a fila por engano', async () => {
  const store = createMockStore();
  const sClient = store.get('5511999998888');
  sClient.human = true;
  sClient.clientName = 'Glória Vasconcelos';
  sClient.history = [{ role: 'user', content: 'Oi' }];

  let aiCalls = 0;
  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async () => {
        aiCalls += 1;
        return { reply: 'Certo, continuo por aqui se precisar!' };
      }
    }
  });

  for (const phrase of ['Ok, aguardando', 'estou aguardando o documento', 'lista de preços', 'quem fez isso?']) {
    const rep = await flow.process({ phone: '5588921694598', text: phrase });
    assert.equal(/Contatos aguardando sua resposta/.test(rep), false, `não deveria abrir fila para "${phrase}"`);
  }
  assert.equal(aiCalls, 4);
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
  // Teste da regex isTalkToTauanRequest com a identidade configurada no painel
  const identity = { identity: { botName: 'Lia', responsible: 'Tauan', companyName: 'Atualyze' } };
  assert.equal(isTalkToOwnerRequest('O Tauan me indicou o trabalho de vocês', identity), false);
  assert.equal(isTalkToOwnerRequest('Conheci o Tauan na faculdade', identity), false);
  assert.equal(isTalkToOwnerRequest('Bom dia, tudo bem?', identity), false);

  // Casos que DEVEM disparar transferência expressa:
  assert.equal(isTalkToOwnerRequest('Quero falar com o Tauan', identity), true);
  assert.equal(isTalkToOwnerRequest('Pode me passar pro Tauan?', identity), true);
  assert.equal(isTalkToOwnerRequest('falar com humano'), true);
  assert.equal(isTalkToOwnerRequest('chamar atendente'), true);
  assert.equal(isTalkToOwnerRequest('opcao 2'), true);
  assert.equal(isTalkToOwnerRequest('2'), true);

  // Sem identidade configurada, o fallback é neutro: "Tauan" deixa de ser o responsável.
  assert.equal(isTalkToOwnerRequest('Quero falar com o Tauan'), false);
  assert.equal(isTalkToOwnerRequest('Quero falar com o responsável'), true);
});

test('Áudio personalizado: Lia NUNCA envia o comando literal, gera prévia amigável e pede confirmação antes de enviar', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';

  const sentAudios = [];
  const sentTexts = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); },
      sendWhatsAppAudio: async (phone, base64) => { sentAudios.push({ phone, base64 }); }
    },
    ai: {
      askAI: async () => ({
        reply: 'Claro, Tauan! Vou enviar o áudio para o Lima.',
        intent: 'envio_mensagem',
        tool_calls: []
      }),
      synthesizeVoice: async (text) => ({ base64: `AUDIO_B64:${text}`, mimeType: 'audio/ogg' })
    }
  });

  // 1. Tauan pede: "Vou precisar que envie um áudio pro lima" (sem assunto)
  const askSubject = await flow.process({
    phone: '5588921694598',
    text: 'Vou precisar que envie um áudio pro lima'
  });
  assert.equal(sentAudios.length, 0, 'Não deve enviar áudio quando ainda não há assunto');
  assert.match(askSubject, /O que você gostaria que eu falasse no áudio para o \*Lima\*/i);

  // 2. Tauan envia comando completo: "Lia, envie um áudio pro Lima sobre o pagamento dos boletos de R$ 2500"
  const preview = await flow.process({
    phone: '5588921694598',
    text: 'Lia, envie um áudio pro Lima sobre o pagamento dos boletos de R$ 2500'
  });

  // NÃO deve ter enviado o áudio ainda - deve ter pedido confirmação!
  assert.equal(sentAudios.length, 0, 'Não deve disparar o áudio antes da confirmação do Tauan');
  assert.match(preview, /Prévia do áudio personalizado para Lima/i);
  assert.match(preview, /Oi, Lima!/i);
  assert.doesNotMatch(preview, /Aqui é a Lia, assistente do Tauan/i, 'Não deve repetir autoapresentação robótica');
  assert.doesNotMatch(preview, /a pedido dele/i, 'Não deve dizer que foi a pedido do Tauan');
  assert.match(preview, /sobre o pagamento dos boletos de R\$ 2500/i);
  assert.doesNotMatch(preview, /"envie um áudio pro Lima/i, 'Jamais deve usar a frase literal de comando como roteiro');
  assert.match(preview, /Deseja que eu grave e envie este áudio agora/i);

  // 3. Tauan confirma: "sim, pode enviar"
  const confirmed = await flow.process({
    phone: '5588921694598',
    text: 'sim, pode enviar'
  });

  assert.equal(sentAudios.length, 1, 'Após confirmação, o áudio deve ser sintetizado e enviado');
  assert.equal(sentAudios[0].phone, '5585991099483');
  assert.match(sentAudios[0].base64, /Oi, Lima!/);
  assert.doesNotMatch(sentAudios[0].base64, /Aqui é a Lia, assistente do Tauan/);
  assert.match(confirmed, /Áudio gravado e enviado com sucesso/i);
});

test('Notificação ao Tauan: sempre notifica quando assunto é direcionado ao Tauan (mesmo com *Tauan* ou handoff anterior)', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';
  sLima.human = false;
  sLima.handoffNotified = true; // Simulando sessão que já teve handoff no passado e voltou para o bot

  const notifications = [];
  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    getBotConfig: () => ({ identity: { botName: 'Lia', responsible: 'Tauan', companyName: 'Atualyze' } }),
    whatsapp: {
      sendText: async (phone, text) => { notifications.push({ phone, text }); }
    },
    ai: {
      askAI: async () => ({
        reply: 'Perfeito, Lima! Já acionei o *Tauan* para pegarmos o link atualizado do rastreio do site para você. 📲',
        intent: 'duvida',
        handoff: false
      })
    }
  });

  const reply = await flow.process({
    phone: '5585991099483',
    text: 'Preciso que mande o rastreio do site'
  });

  assert.match(reply, /acionei o \*Tauan\*/);
  assert.equal(sLima.human, true, 'Sessão deve entrar em modo humano');
  assert.equal(notifications.length, 1, 'Tauan DEVE receber notificação no WhatsApp mesmo se handoffNotified antigo era true');
  assert.equal(notifications[0].phone, '5588921694598');
  assert.match(notifications[0].text, /Novo contato para você, Tauan/);
  assert.match(notifications[0].text, /Lima/);
});

test('Ajuste na prévia do áudio: converte 3ª pessoa ("ele") para 2ª pessoa ("você") e NUNCA dispara o feedback do Tauan pro cliente', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';

  const sentAudios = [];
  const sentTexts = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); },
      sendWhatsAppAudio: async (phone, base64) => { sentAudios.push({ phone, base64 }); }
    },
    ai: {
      askAI: async () => ({
        reply: 'Ok!',
        intent: 'envio_mensagem',
        tool_calls: []
      }),
      synthesizeVoice: async (text) => ({ base64: `AUDIO_B64:${text}`, mimeType: 'audio/ogg' })
    }
  });

  // 1. Tauan pede áudio
  await flow.process({
    phone: '5588921694598',
    text: 'Preciso que envie um áudio pro lima'
  });

  // 2. Tauan diz em 3ª pessoa: "Diga que ele vai precisar criar o código de rastreio pixel da meta e cadastrar no CRM"
  const preview1 = await flow.process({
    phone: '5588921694598',
    text: 'Diga que ele vai precisar criar o código de rastreio pixel da meta e cadastrar no CRM'
  });

  // Já deve ter convertido "ele vai precisar" para "você vai precisar"!
  assert.match(preview1, /você vai precisar criar o código de rastreio pixel da meta/i);
  assert.doesNotMatch(preview1, /Aqui é a Lia, assistente do Tauan/i);
  assert.doesNotMatch(preview1, /Estou passando para te avisar que/i);
  assert.equal(sentTexts.length, 0, 'Não deve enviar texto para o Lima');
  assert.equal(sentAudios.length, 0, 'Não deve enviar áudio antes da confirmação');

  // 3. Mesmo que o Tauan mande uma observação/correção como "No caso estou me referindo ao lima e não a mim", JAMAIS dispara isso pro Lima!
  const preview2 = await flow.process({
    phone: '5588921694598',
    text: 'No caso estou me referindo ao lima e não a mim'
  });

  assert.equal(sentTexts.length, 0, 'JAMAIS deve enviar a observação do Tauan para o Lima');
  assert.equal(sentAudios.length, 0, 'Ainda aguarda o "sim" final do Tauan');
  assert.match(preview2, /Prévia atualizada do áudio para lima/i);
  assert.match(preview2, /Ficou como você queria\?/i);

  // 4. Tauan confirma: "sim"
  const finalConfirm = await flow.process({
    phone: '5588921694598',
    text: 'sim'
  });

  assert.equal(sentAudios.length, 1, 'Agora sim envia o áudio sintetizado para o Lima');
  assert.match(finalConfirm, /Áudio gravado e enviado com sucesso/i);
});

test('Cliente envia áudio: Lia responde apenas com áudio, sem legenda ou pergunta extra', async () => {
  const store = createMockStore();
  const clientPhone = '5585991099483';
  const sLima = store.get(clientPhone);
  sLima.clientName = 'Lima';
  sLima.human = false;

  const sentAudios = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    getBotConfig: () => ({ voice: { autoVoiceOnAudio: true, deliveryMode: 'audio_only', sendTranscriptionWithAudio: false } }),
    whatsapp: {
      getMediaBase64: async () => ({ base64: 'FAKE_AUDIO_IN', mimetype: 'audio/ogg' }),
      sendWhatsAppAudio: async (phone, base64) => { sentAudios.push({ phone, base64 }); }
    },
    ai: {
      transcribeAudio: async () => 'Qual o horário de atendimento de vocês?',
      askAI: async () => ({
        reply: 'Oi, Lima! Nosso atendimento funciona de segunda a sexta, das 8h às 18h.',
        intent: 'duvida',
        handoff: false
      }),
      synthesizeVoice: async (text) => ({ base64: `VOICE_OUT:${text}`, mimeType: 'audio/ogg' })
    }
  });

  const textFollowUp = await flow.process({
    phone: clientPhone,
    mediaType: 'audio',
    nonText: true,
    rawItem: { jid: `${clientPhone}@s.whatsapp.net`, key: { id: 'msg1' }, message: { audioMessage: {} } }
  });

  assert.equal(sentAudios.length, 1, 'Deve ter enviado a resposta sintetizada em áudio para o cliente');
  assert.match(sentAudios[0].base64, /Oi, Lima! Nosso atendimento funciona de segunda a sexta/);
  assert.equal(textFollowUp, null, 'Áudio não deve levar legenda em texto quando configurado como audio_only');
});

test('Cliente envia áudio: Lia responde com áudio E transcrição em texto quando deliveryMode é audio_and_text', async () => {
  const store = createMockStore();
  const clientPhone = '5585991099483';
  const sLima = store.get(clientPhone);
  sLima.clientName = 'Lima';
  sLima.human = false;

  const sentAudios = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    getBotConfig: () => ({ voice: { autoVoiceOnAudio: true, deliveryMode: 'audio_and_text', sendTranscriptionWithAudio: true } }),
    whatsapp: {
      getMediaBase64: async () => ({ base64: 'FAKE_AUDIO_IN', mimetype: 'audio/ogg' }),
      sendWhatsAppAudio: async (phone, base64) => { sentAudios.push({ phone, base64 }); }
    },
    ai: {
      transcribeAudio: async () => 'Qual o horário de atendimento de vocês?',
      askAI: async () => ({
        reply: 'Oi, Lima! Nosso atendimento funciona de segunda a sexta, das 8h às 18h.',
        intent: 'duvida',
        handoff: false
      }),
      synthesizeVoice: async (text) => ({ base64: `VOICE_OUT:${text}`, mimeType: 'audio/ogg' })
    }
  });

  const textFollowUp = await flow.process({
    phone: clientPhone,
    mediaType: 'audio',
    nonText: true,
    rawItem: { jid: `${clientPhone}@s.whatsapp.net`, key: { id: 'msg1' }, message: { audioMessage: {} } }
  });

  assert.equal(sentAudios.length, 1, 'Deve ter enviado a resposta sintetizada em áudio para o cliente');
  assert.match(sentAudios[0].base64, /Oi, Lima! Nosso atendimento funciona de segunda a sexta/);
  assert.equal(textFollowUp, 'Oi, Lima! Nosso atendimento funciona de segunda a sexta, das 8h às 18h.', 'Deve retornar o texto da resposta para envio junto com o áudio');
});

test('Copiloto: gerar PDF pergunta as informações antes e gera após a resposta', async () => {
  const store = createMockStore();
  const sentDocs = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendDocument: async (phone, doc) => { sentDocs.push({ phone, doc }); }
    }
  });

  const ask = await flow.process({ phone: 'owner_self', text: 'Lia, gerar pdf' });

  assert.equal(sentDocs.length, 0, 'Não deve gerar PDF antes de perguntar');
  assert.match(ask, /quais informa/i, 'Deve perguntar quais informações usar');

  const reply = await flow.process({ phone: 'owner_self', text: 'dados do sistema' });

  assert.equal(sentDocs.length, 1, 'O PDF deve ser enviado como documento');
  assert.equal(sentDocs[0].phone, '5588921694598');
  assert.match(sentDocs[0].doc.dataUrl, /^data:application\/pdf;base64,/, 'Deve enviar o dataUrl do PDF');
  assert.match(sentDocs[0].doc.fileName, /\.pdf$/);
  assert.match(reply, /gerado e enviado/i);
});

test('Copiloto: orçamento sem detalhes pergunta; com detalhes gera direto', async () => {
  const store = createMockStore();
  const sentDocs = [];

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendDocument: async (phone, doc) => { sentDocs.push({ phone, doc }); }
    }
  });

  const ask = await flow.process({ phone: 'owner_self', text: 'gerar orçamento' });
  assert.equal(sentDocs.length, 0, 'Orçamento sem detalhes não gera direto');
  assert.match(ask, /orçamento/i);
  assert.match(ask, /valores/i);

  const content = await flow.process({ phone: 'owner_self', text: 'Implantação de chatbot com IA, 2 atendentes, prazo de 30 dias, valor R$ 4.500,00' });
  assert.equal(sentDocs.length, 1, 'Resposta com os detalhes deve gerar o PDF');
  assert.match(content, /gerado e enviado/i);

  const direct = await flow.process({ phone: 'owner_self', text: 'gerar orçamento: manutenção mensal do sistema, 10 horas, R$ 2.000,00, prazo 5 dias' });
  assert.equal(sentDocs.length, 2, 'Pedido já com valores gera direto');
  assert.match(direct, /gerado e enviado/i);
});

test('Sanitização de roteiro: remove completamente "o áudio pro lima informando sobre" mesmo com artigo definido ("o áudio")', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async () => ({
        reply: 'Ok',
        intent: 'envio_mensagem',
        tool_calls: []
      })
    }
  });

  const preview = await flow.process({
    phone: '5588921694598',
    text: 'Envie o audio pro lima informando sobre o código de rastreio do site'
  });

  assert.doesNotMatch(preview, /o audio pro lima/i, 'Jamais deve vazar "o audio pro lima" no roteiro');
  assert.doesNotMatch(preview, /informando sobre/i, 'Jamais deve vazar "informando sobre" no roteiro');
  assert.doesNotMatch(preview, /Aqui é a Lia, assistente do Tauan/i, 'Não deve repetir apresentação robótica');
  assert.doesNotMatch(preview, /a pedido dele/i, 'Não deve dizer que foi a pedido do Tauan');
  assert.doesNotMatch(preview, /Estou passando para te avisar que/i, 'Não deve usar clichê robótico');
  assert.match(preview, /Oi, Lima! Tudo bem\? Estou entrando em contato para alinharmos sobre o código de rastreio do site/i);

  // Teste exato do print: Lia, envie um audio e diga ao lima que "ele vai precisar testar os eventos no crm também no menu de aquisição
  const previewPrint = await flow.process({
    phone: '5588921694598',
    text: 'cancelar' // limpa o anterior
  }).then(() => flow.process({
    phone: '5588921694598',
    text: 'Lia, envie um audio e diga ao lima que "ele vai precisar testar os eventos no crm também no menu de aquisição'
  }));

  assert.doesNotMatch(previewPrint, /Oi, lima! E diga/i, 'Jamais deve vazar "E diga" no roteiro');
  assert.doesNotMatch(previewPrint, /ele vai precisar/i, 'Deve converter "ele vai precisar" para 2ª pessoa');
  assert.match(previewPrint, /Oi, lima! Tudo bem\? Só para alinharmos os próximos passos, você vai precisar testar os eventos no crm também no menu de aquisição, combinado\?/i);
});

test('Contexto selecionável do Contato: injeta suporte ativo, observações e Base de Conhecimento (Clubinho HomeVet) somente quando ativado no contato', async () => {
  const store = createMockStore();

  // Contato 1: Sem suporte ativo nem base (comportamento padrão preservado)
  const sNormal = store.get('5511988887777');
  sNormal.clientName = 'Visitante Comum';

  // Contato 2: Com suporte ativo + Base Clubinho HomeVet + Observações
  const sClubinho = store.get('5586999962542');
  sClubinho.clientName = 'Dra. Elisângela';
  sClubinho.supportModeEnabled = true;
  sClubinho.knowledgeBaseId = 'clubinho-homevet';
  sClubinho.contactRole = 'project_owner';
  sClubinho.contactNotes = 'Fundadora do Clubinho HomeVet em Teresina. Sempre que pedir ajuste no checkout Asaas ou falar com o Tauan, priorizar.';

  const promptsByPhone = {};

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async ({ system }) => {
        if (system.includes('Visitante Comum')) promptsByPhone.normal = system;
        if (system.includes('Dra. Elisângela')) promptsByPhone.clubinho = system;
        return { reply: 'Tudo certo!', intent: 'duvida', handoff: false };
      }
    }
  });

  await flow.process({ phone: '5511988887777', text: 'Olá, quero saber como funciona' });
  await flow.process({ phone: '5586999962542', text: 'Oi Lia, qual o valor configurado no plano filhote cão e como sincronizo o Asaas?' });

  // 1. Contato comum NÃO recebe o bloco especial nem o manual do Clubinho HomeVet
  assert.doesNotMatch(promptsByPhone.normal, /CONTEXTO ESPECIAL DESTE CONTATO/);
  assert.doesNotMatch(promptsByPhone.normal, /CLUBINHO HOMEVET/);

  // 2. Contato configurado RECEBE suporte ativo, observações e somente o trecho relevante
  assert.match(promptsByPhone.clubinho, /CONTEXTO ESPECIAL DESTE CONTATO/);
  assert.match(promptsByPhone.clubinho, /FAZ PARTE DO ATENDIMENTO\/SUPORTE ATIVO/);
  assert.match(promptsByPhone.clubinho, /Fundadora do Clubinho HomeVet em Teresina/);
  assert.match(promptsByPhone.clubinho, /CLUBINHO HOMEVET/i);
  assert.match(promptsByPhone.clubinho, /Seletor de Planos Interativo/i);
  assert.match(promptsByPhone.clubinho, /integrado ao Asaas/i);
  assert.doesNotMatch(promptsByPhone.clubinho, /Relatório Completo Web \(`\.HTML`\)/i);
  assert.match(promptsByPhone.clubinho, /FOCO PRÁTICO NO CRM \(\/admin\) \+ LANDING PAGE/i);
  assert.match(promptsByPhone.clubinho, /USE O CONHECIMENTO PARA COMPREENDER E CONDUZIR/i);
  assert.doesNotMatch(promptsByPhone.clubinho, /POST \/api\/payments\/checkout/i);
});

test('Copiloto do Tauan (isTauan=true): tem acesso completo aos dossiês das bases de conhecimento (ex: Clubinho HomeVet)', async () => {
  const store = createMockStore();
  let capturedCopilotSystem = '';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    ai: {
      askAI: async ({ system }) => {
        capturedCopilotSystem = system;
        return {
          reply: 'Conheço todos os detalhes do *Clubinho HomeVet*! É o clube de saúde preventiva veterinária domiciliar da Dra. Elisângela em Teresina-PI.',
          intent: 'chat',
          handoff: false,
          tool_calls: []
        };
      }
    }
  });

  const reply = await flow.process({
    phone: 'owner_self',
    text: 'O que vc sabe sobre o clubinho homevet?'
  });

  assert.match(capturedCopilotSystem, /BASES DE CONHECIMENTO E SUPORTE PRÁTICO DE PROJETOS CADASTRADOS/);
  assert.match(capturedCopilotSystem, /CLUBINHO HOMEVET/i);
  assert.match(capturedCopilotSystem, /Dra\. Elisângela/i);
  assert.match(capturedCopilotSystem, /Relatório Completo Web \(`\.HTML`\)/i);
  assert.doesNotMatch(capturedCopilotSystem, /POST \/api\/payments\/checkout/i);
  assert.match(reply, /Clubinho HomeVet/i);
});

test('Copiloto do Tauan: quando Tauan pede para explicar em áudio, sintetiza e envia áudio diretamente sem pedir confirmação', async () => {
  const store = createMockStore();
  const sentAudios = [];
  let speechTextPassed = '';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendWhatsAppAudio: async (phone, base64) => {
        sentAudios.push({ phone, base64 });
      }
    },
    ai: {
      askAI: async () => ({
        reply: 'Tauan, para exportar o relatório em HTML, acesse o menu Relatórios, clique na aba Exportar, escolha o período e clique em Relatório Completo Web.',
        intent: 'chat',
        handoff: false,
        tool_calls: []
      }),
      synthesizeVoice: async (text) => {
        speechTextPassed = text;
        return { base64: 'AUDIO_BASE64_SIMULADO', mimeType: 'audio/wav' };
      }
    }
  });

  const reply = await flow.process({
    phone: 'owner_self',
    text: 'Lia, me explique em áudio como exporto o relatório em html'
  });

  // 1. Deve ter sintetizado o áudio diretamente
  assert.match(speechTextPassed, /para exportar o relatório em HTML/i);

  // 2. Deve ter enviado o áudio para o Tauan no WhatsApp
  assert.equal(sentAudios.length, 1, 'Deve ter disparado o áudio para o WhatsApp do Tauan');
  assert.equal(sentAudios[0].phone, '5588921694598');
  assert.equal(sentAudios[0].base64, 'AUDIO_BASE64_SIMULADO');

  // 3. Resposta de texto deve conter o aviso e a transcrição, SEM pedir confirmação
  assert.match(reply, /Áudio gravado e enviado para você/i);
  assert.match(reply, /Relatórios/i);
  assert.doesNotMatch(reply, /Deseja que eu grave e envie este áudio agora/i, 'NÃO deve pedir confirmação quando é para o próprio Tauan');
  assert.doesNotMatch(reply, /Prévia do áudio personalizado para você/i);

  // 4. lastAudioBase64 deve ter sido salvo na sessão do Tauan para o Chatwoot
  const sTauan = store.get('owner_self');
  assert.equal(sTauan.lastAudioBase64, 'AUDIO_BASE64_SIMULADO');
});

test('Humanização e Eliminação de Clichês: Lia humaniza perguntas, avisos e pedidos sem usar frases robóticas', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {}
  });

  // 1. Pergunta / Acompanhamento: "Lia, envie um áudio pro Lima perguntando se ele vai querer a proposta"
  const previewPergunta = await flow.process({
    phone: '5588921694598',
    text: 'Lia, envie um áudio pro Lima perguntando se ele vai querer a proposta'
  });

  assert.doesNotMatch(previewPergunta, /Queria aproveitar para alinhar com você que/i, 'NUNCA deve ter o clichê "Queria aproveitar para alinhar..."');
  assert.doesNotMatch(previewPergunta, /se ele vai/i, 'Deve converter para 2ª pessoa');
  assert.match(previewPergunta, /Oi, Lima! Tudo bem\? Passando para saber se você vai querer a proposta/i);

  // 2. Cancelamento real: "cancela"
  const cancelRes = await flow.process({
    phone: '5588921694598',
    text: 'cancela'
  });
  assert.match(cancelRes, /Envio cancelado com sucesso/i);
  const sSelf = store.get('owner_self');
  assert.ok(!sSelf.pendingAudioConfirmation, 'pendingAudioConfirmation deve ser falsy após cancelar');
  assert.ok(!sSelf.pendingRecipient, 'pendingRecipient deve ser falsy após cancelar');
  assert.ok(!sSelf.pendingAsAudio, 'pendingAsAudio deve ser falsy após cancelar');

  // 3. Aviso / Atualização de Status: "Lia, manda uma mensagem pro Lima avisando que o site já ficou pronto"
  const sentTexts = [];
  const flowText = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {
      sendText: async (phone, text) => { sentTexts.push({ phone, text }); }
    }
  });

  const sendRes = await flowText.process({
    phone: '5588921694598',
    text: 'Lia, manda uma mensagem pro Lima avisando que o site já ficou pronto'
  });

  assert.match(sendRes, /Mensagem disparada com sucesso/i);
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].phone, '5585991099483');
  assert.doesNotMatch(sentTexts[0].text, /Queria aproveitar para alinhar com você que/i);
  assert.doesNotMatch(sentTexts[0].text, /avisando que o site/i);
  assert.match(sentTexts[0].text, /Oi, Lima! Tudo bem\? Passando para te avisar que o site já ficou pronto/i);
});

test('Copiloto: Pedido de áudio no chat interno gera fala natural como assistente e salva áudio para o Tauan', async () => {
  const store = createMockStore();
  let synthesizedText = '';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {},
    ai: {
      synthesizeVoice: async (text) => {
        synthesizedText = text;
        return { base64: 'AUDIO_COPILOTO_BASE64', mimeType: 'audio/wav' };
      }
    }
  });

  const reply = await flow.process({
    phone: 'owner_self',
    text: 'Lia, me mande um áudio no chat interno perguntando se o cliente vai querer a proposta'
  });

  // Sem whatsapp.sendWhatsAppAudio configurado, o envio não acontece e a resposta
  // deve ser honesta sobre a falha, mantendo o conteúdo no texto.
  assert.match(reply, /Não consegui enviar o áudio no momento/i);
  assert.match(reply, /Passando para saber se/i);
  assert.doesNotMatch(synthesizedText, /Queria aproveitar para alinhar com você que/i);
  assert.match(synthesizedText, /Passando para saber se/i);

  const sSelf = store.get('owner_self');
  assert.equal(sSelf.lastAudioBase64, 'AUDIO_COPILOTO_BASE64');
  assert.equal(sSelf.pendingRecipient, null);
});

test('Caso do Usuário: "Perfeito, vou precisar que vc mande um áudio e lembre o Lima sobre o monitoramento do pixel..."', async () => {
  const store = createMockStore();
  const sLima = store.get('5585991099483');
  sLima.clientName = 'Lima';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    getHumanPhone: () => '5588921694598',
    whatsapp: {}
  });

  const preview = await flow.process({
    phone: '5588921694598',
    text: 'Perfeito, vou precisar que vc mande um áudio e lembre o Lima sobre o monitoramento do pixel da meta dentro do CRM após o início da campanha já que os dados inicias serão de teste.'
  });

  // 1. Prévia amigável gerada
  assert.match(preview, /Prévia do áudio personalizado para Lima/i);
  assert.match(preview, /Oi, Lima! Tudo bem\?/i);
  assert.match(preview, /monitoramento do pixel da meta dentro do CRM/i);
  // 2. NUNCA contém comandos crus ou prefixos vazados
  assert.doesNotMatch(preview, /vou precisar que/i);
  assert.doesNotMatch(preview, /mande um [aá]udio/i);
  assert.doesNotMatch(preview, /lembre o Lima/i);
  assert.doesNotMatch(preview, /passando para te avisar que perfeito/i);
  assert.doesNotMatch(preview, /Queria aproveitar para alinhar com você que/i);

  // 3. Cancela e garante que o cancelamento é definitivo
  const cancel = await flow.process({
    phone: '5588921694598',
    text: 'cancela'
  });
  assert.match(cancel, /Envio cancelado com sucesso/i);
  const sSelf = store.get('owner_self');
  assert.ok(!sSelf.pendingAudioConfirmation, 'pendingAudioConfirmation deve ser falsy');

  // 4. Nova mensagem com "Perfeito, ..." NÃO confirma nem reativa o cancelado
  const nextMsg = await flow.process({
    phone: '5588921694598',
    text: 'Perfeito, obrigado'
  });
  assert.doesNotMatch(nextMsg, /Áudio gravado e enviado com sucesso/i);
  assert.ok(!sSelf.pendingAudioConfirmation, 'pendingAudioConfirmation deve continuar falsy');
});

test('Fluxo completo: cancelamento de áudio, troca para texto e proteção contra envio de comando cru', async () => {
  const store = createMockStore();
  const sContact = store.get('5588998340085');
  sContact.pushName = 'ptbr';
  sContact.clientName = 'Tauan Pires';

  const sentMessages = [];
  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    whatsapp: {
      sendWhatsAppText: async (phone, msg) => {
        sentMessages.push({ phone, msg });
        return { success: true };
      }
    },
    ai: {
      askAI: async () => ({
        reply: 'Oi, Tauan! Tudo bem? 🚀\n\nPor aqui tudo 100% operacional. Em que posso te ajudar agora?',
        tool_calls: []
      })
    }
  });

  // Turno 1: Tauan pede áudio
  const p1 = await flow.process({
    phone: 'owner_self',
    text: 'preciso que envie um áudio para 88998340085 sobre o status operacional do sistema'
  });
  assert.match(p1, /Prévia do áudio personalizado/i);
  assert.match(p1, /Deseja que eu grave e envie este áudio agora/i);

  // Turno 2: Tauan cancela dizendo 'não'
  const p2 = await flow.process({
    phone: 'owner_self',
    text: 'não'
  });
  assert.match(p2, /Envio cancelado com sucesso/i);
  assert.equal(sentMessages.length, 0, 'Nenhuma mensagem deve ter sido enviada');

  // Turno 3: Tauan cumprimenta
  const p3 = await flow.process({
    phone: 'owner_self',
    text: 'oi'
  });
  assert.match(p3, /100% operacional/i);

  // Turno 4: Tauan diz 'que envie um texto'
  const p4 = await flow.process({
    phone: 'owner_self',
    text: 'que envie um texto'
  });

  // NÃO deve ter disparado mensagem alguma para o WhatsApp do contato
  assert.equal(sentMessages.length, 0, 'JAMAIS deve disparar mensagem sem recado real para o contato');
  assert.doesNotMatch(p4, /Mensagem disparada com sucesso/i);
  assert.doesNotMatch(p4, /nvie um texto/i);
  assert.doesNotMatch(p4, /Destinatário: ptbr/i);
});

test('pcm16ToWavBase64 empacota áudio PCM L16 cru do Gemini TTS em cabeçalho RIFF/WAV válido', async () => {
  const { pcm16ToWavBase64 } = await import('./ai/voice.mjs');
  const rawPcm = Buffer.alloc(480, 0x12).toString('base64');
  const wavB64 = pcm16ToWavBase64(rawPcm, 24000);
  const wavBuf = Buffer.from(wavB64, 'base64');

  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wavBuf.readUInt32LE(24), 24000);
  assert.equal(wavBuf.length, 44 + 480);
});

test('Copiloto analisa documento PDF/imagem e preserva contexto do documento em turnos seguintes', async () => {
  const store = createMockStore();
  let capturedSystem = '';

  const flow = createFlow({
    store,
    humanPhone: '5588921694598',
    ai: {
      analyzeDocument: async ({ mimetype }) => ({
        summary: `Planilha financeira (${mimetype}) com faturamento total de R$ 14.500,00.`,
        docType: 'planilha',
        keyPoints: ['Receita: R$ 14.500,00', 'Cliente: Empresa Alpha'],
        actionNeeded: 'Conferir lançamento contábil'
      }),
      askAI: async ({ system }) => {
        capturedSystem = system;
        return {
          reply: 'O valor total do documento Pasta1.pdf é R$ 14.500,00 para a Empresa Alpha.',
          tool_calls: []
        };
      }
    }
  });

  // Turno 1: Envio do arquivo Pasta1.pdf pelo painel
  const r1 = await flow.process({
    phone: 'owner_self',
    text: 'Arquivo enviado: Pasta1.pdf',
    attachments: [{
      fileName: 'Pasta1.pdf',
      mimeType: 'application/pdf',
      url: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 fake').toString('base64')}`
    }]
  });
  assert.match(r1, /Análise do Documento \(PLANILHA\) Concluída/i);
  assert.match(r1, /R\$ 14\.500,00/);

  // Turno 2: Pergunta de acompanhamento sobre o documento sem reenviar o anexo
  const r2 = await flow.process({
    phone: 'owner_self',
    text: 'Qual é o valor total e o cliente desse documento?'
  });
  assert.match(capturedSystem, /ULTIMO_DOCUMENTO_ANALISADO_NA_SESSAO/);
  assert.match(capturedSystem, /Pasta1\.pdf/);
  assert.match(r2, /R\$ 14\.500,00/);
});

test('enviar_mensagem_contato resolve contato via SupabaseRestClient.select(contacts)', async () => {
  const { executeToolCall } = await import('./tools/index.mjs');
  const store = createMockStore();
  store.client = {
    select: async (table) => {
      assert.equal(table, 'contacts');
      return [{ phone: '5588999112233', display_name: 'Carlos Mendes', push_name: 'Carlos' }];
    }
  };

  let sentTo = null;
  const res = await executeToolCall(
    'enviar_mensagem_contato',
    { recipient: 'Carlos Mendes', message: 'Oi Carlos, tudo bem?', asAudio: false },
    {
      store,
      whatsapp: {
        sendWhatsAppText: async (phone, msg) => {
          sentTo = { phone, msg };
          return { ok: true };
        }
      }
    }
  );

  assert.equal(res.success, true);
  assert.equal(sentTo?.phone, '5588999112233');
});
