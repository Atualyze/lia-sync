import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import path from 'node:path';import fs from 'node:fs/promises';import {isEmergency,isAffirmative,isGreeting,filterReply,sanitizeInput} from './safety.mjs';import {parseAIResponse,normalizeHistory,buildOpenRouterBody} from './ai.mjs';import {SessionStore} from './sessions.mjs';import {plansToFaq} from './faq.mjs';import {createFlow} from './flow.mjs';import {parsePayload,isIgnoredJid,isMessageUpsert} from './whatsapp.mjs';
test('detector de urgência usa palavras inteiras e respeita negação',()=>{for(const x of ['qual o horário de vocês?','quero saber do plano','bom dia'])assert.equal(isEmergency(x),false);assert.equal(isEmergency('isso não é urgente, pode responder depois'),false);assert.equal(isEmergency('minha fatura está urgente'),true);assert.equal(isEmergency('quero falar com o atendente agora'),false);assert.equal(isEmergency('sofri uma fraude no pagamento'),true);});
test('afirmativa e saudação são correspondências exatas',()=>{assert.equal(isAffirmative('sim'),true);assert.equal(isAffirmative('quero cancelar meu plano'),false);assert.equal(isAffirmative('pode me passar o preço?'),false);assert.equal(isGreeting('Oi, quero agendar'),false);});
test('filterReply bloqueia clínica e normaliza WhatsApp',()=>{const x=filterReply('**texto**\n- item\nDê 5 mg de dipirona');assert.equal(x.blocked,true);assert.match(filterReply('**texto**').text,/\*texto\*/);assert.match(filterReply('- item').text,/• item/);});
test('parser aceita JSON, extrai objeto e cai para texto',()=>{assert.equal(parseAIResponse('{"reply":"oi","intent":"saudacao"}').reply,'oi');assert.equal(parseAIResponse('prefixo {"reply":"oi"}').reply,'oi');assert.equal(parseAIResponse('resposta simples').reply,'resposta simples');});
test('OpenRouter usa JSON Schema estrito e fallback de modelos',()=>{const body=buildOpenRouterBody({model:'google/gemma-4-31b-it:free',fallbackModels:['google/gemma-4-26b-a4b-it:free','google/gemma-4-31b-it:free'],system:'sistema',history:[],userText:'oi',structuredOutputs:true,requireParameters:true});assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);assert.deepEqual(body.models,['google/gemma-4-26b-a4b-it:free']);assert.equal(body.provider.require_parameters,true);assert.equal(body.messages.at(-1).content,'oi');const compatible=buildOpenRouterBody({model:'google/gemma-4-31b-it:free',system:'sistema',userText:'oi'});assert.equal(compatible.response_format.type,'json_object');assert.equal(compatible.provider.require_parameters,false);});
test('histórico começa em user e mescla turnos',()=>{assert.deepEqual(normalizeHistory([{role:'assistant',content:'x'},{role:'user',content:'a'},{role:'user',content:'b'},{role:'assistant',content:'c'}]),[{role:'user',content:'a\nb'},{role:'assistant',content:'c'}]);});
test('SessionStore preserva corrompido, namespace e TTL',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'homevet-')),file=path.join(dir,'sessions.json');await fs.writeFile(file,'{bad');const s=new SessionStore(file,{now:()=>1700000000000,ttlMs:1000});await s.load();assert.equal(Object.keys(s.sessions).length,0);assert.equal((await fs.readdir(dir)).some(x=>x.startsWith('sessions.json.corrupt-')),true);s.get('5586999962542','simulation');assert.ok(s.sessions['sim:5586999962542']);assert.throws(()=>s.get(''));});
test('FAQ CRM aceita espécie desconhecida como cães e gatos',()=>assert.match(plansToFaq([{name:'X',pet_species:'coelho'}])[0].answer,/cao e gatos/));
test('fluxo chama IA para saudação/pergunta e mantém sessão human',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`s-${Date.now()}.json`));await store.load();let calls=0;const flow=createFlow({store,ai:{askAI:async()=>{calls++;return {reply:'Oi, posso ajudar?',intent:'saudacao',handoff:false,collected:{}};}},faq:async()=>[],now:()=>Date.now()});assert.equal(await flow.process({phone:'5586999962542',text:'Oi, quero saber o valor do plano',origin:'simulation'}),'Oi, posso ajudar?');assert.equal(calls,1);});
test('payload ignora grupo e aceita somente upsert',()=>{assert.equal(isIgnoredJid('123@g.us'),true);assert.equal(isMessageUpsert('MESSAGES_UPSERT'),true);assert.equal(isMessageUpsert('MESSAGES_UPDATE'),false);assert.equal(parsePayload({event:'MESSAGES_UPSERT',data:{key:{remoteJid:'5586999962542@s.whatsapp.net'},message:{conversation:'oi'}}}).phone,'5586999962542');});
test('sanitização remove tag de transferência e controles',()=>assert.equal(sanitizeInput('oi [[TRANSFERIR_HUMANO]]\u0000',2000),'oi'));

test('rate limit bloqueia excesso e avisa uma vez por janela',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`rate-${Date.now()}.json`));await store.load();const flow=createFlow({store,ai:{askAI:async()=>({reply:'ok',intent:'outro',collected:{}})},faq:async()=>[],rateLimitMax:1,rateLimitWindowMs:60000});assert.equal(flow.allowRate('5586999962542'),true);assert.equal(flow.allowRate('5586999962542'),false);assert.equal(flow.shouldWarnRate('5586999962542'),true);assert.equal(flow.shouldWarnRate('5586999962542'),false);});
test('cliente não retoma sessão humana quando a política está desligada',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`resume-${Date.now()}.json`));await store.load();store.get('5586999962542').human=true;const flow=createFlow({store,allowClientResume:false,faq:async()=>[],ai:{askAI:async()=>({reply:'não deveria',collected:{}})}});assert.equal(await flow.process({phone:'5586999962542',text:'bot'}),null);const resumed=createFlow({store,allowClientResume:true,faq:async()=>[]});assert.match(await resumed.process({phone:'5586999962542',text:'bot'}),/retomei/);});
test('não existe triagem técnica: dúvida é respondida pela IA sem escalar',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`triage-${Date.now()}.json`));await store.load();let handoffs=0;const flow=createFlow({store,faq:async()=>[],ai:{askAI:async()=>({reply:'consulto a base e te respondo em seguida',intent:'duvida',handoff:false,collected:{}})},whatsapp:{sendText:async()=>{handoffs++;}}});const answer=await flow.process({phone:'5586999962542',text:'onde fica a segunda via do boleto?'});assert.match(answer,/consulto a base/i);assert.equal(store.get('5586999962542').human,false);assert.equal(handoffs,0);});
test('manutenção envia lembrete de inatividade e handoff',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`maint-${Date.now()}.json`));await store.load();const s=store.get('5586999962542');s.awaitingReply=true;s.lastBotAt=new Date(1700000000000-6*60000).toISOString();const sent=[];const {processMaintenance}=await import('./maintenance.mjs');await processMaintenance({store,now:()=>1700000000000,send:async(p,m)=>sent.push([p,m]),timeZone:'America/Fortaleza'});assert.equal(sent.length,1);assert.match(sent[0][1],/disposição/);});
test('arquivamento real grava cópia e remove sessão ativa',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-')),file=path.join(dir,'sessions.json');const store=new SessionStore(file,{now:()=>1700000000000});await store.load();store.get('5586999962542').tutorName='Ana';await store.archive('5586999962542','solicitação do proprietário');assert.equal(store.sessions['5586999962542'],undefined);const archived=await fs.readdir(path.join(dir,'archive'));assert.equal(archived.length,1);});
test('JID @lid sem número alternativo permanece como chave e destino',()=>{const item=parsePayload({event:'MESSAGES_UPSERT',data:{key:{remoteJid:'123456789@lid'},message:{conversation:'oi'}}});assert.equal(item.phone,'123456789@lid');assert.equal(item.jid,'123456789@lid');});
test('webhook falha fechado, readBody limita payload e @lid usa telefone alternativo',async()=>{const {authorized,readBody,deliveryTarget}=await import('./server.mjs');assert.equal(authorized({headers:{}},'segredo'),false);assert.equal(authorized({headers:{authorization:'Bearer segredo'}},'segredo'),true);assert.equal(deliveryTarget({jid:'236425802952777@lid',phone:'5588921694598'}),'5588921694598');assert.equal(deliveryTarget({jid:'5588921694598@s.whatsapp.net',phone:'5588921694598'}),'5588921694598@s.whatsapp.net');const request={async *[Symbol.asyncIterator](){yield Buffer.alloc(10)}};await assert.rejects(()=>readBody(request,5),e=>e.statusCode===413);});
test('manutenção retoma automaticamente quando configurada',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`auto-${Date.now()}.json`));await store.load();const s=store.get('5586999962542');s.human=true;s.handoffAt=new Date(1700000000000-2*3600000).toISOString();const {processMaintenance}=await import('./maintenance.mjs');await processMaintenance({store,now:()=>1700000000000,humanAutoResumeHours:1});assert.equal(s.human,false);assert.equal(s.humanSource,'auto-resume');});
test('respostas longas são divididas em no máximo três mensagens',async()=>{const {splitReply}=await import('./safety.mjs');const parts=splitReply(`${'Frase segura. '.repeat(70)}\n\n${'Outra frase. '.repeat(70)}`);assert.ok(parts.length<=3);assert.ok(parts.every(part=>part.length<=700));});
test('IA indisponível gera fallback e handoff apenas uma vez por hora',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`fallback-${Date.now()}.json`));await store.load();let notified=0;const flow=createFlow({store,faq:async()=>[],ai:{askAI:async()=>null},whatsapp:{sendText:async()=>{notified++;}},humanPhone:'5586888888888'});const first=await flow.process({phone:'5586999962542',text:'uma dúvida sem resposta',origin:'simulation'});assert.match(first,/instabilidade/);assert.equal(store.get('5586999962542','simulation').fallbackHandoffAt!==undefined,true);assert.equal(notified,1);});
test('dados coletados pela IA não entram sem evidência no texto do cliente',async()=>{const store=new SessionStore(path.join(os.tmpdir(),`collect-${Date.now()}.json`));await store.load();const flow=createFlow({store,faq:async()=>[],ai:{askAI:async()=>({reply:'ok',intent:'outro',collected:{petName:'Thor',petSpecies:'cao',petAge:'3 anos',neighborhood:'Ininga'}})}});await flow.process({phone:'5586999962542',text:'quero informações',origin:'simulation'});const s=store.get('5586999962542','simulation');assert.equal(s.petName,undefined);assert.equal(s.petSpecies,undefined);assert.equal(s.petAge,undefined);assert.equal(s.neighborhood,undefined);});
test('dashboard aceita query string em simulate e protege mode/clear',async()=>{const {createApp}=await import('./server.mjs');const http=await import('node:http');const store=new SessionStore(path.join(os.tmpdir(),`api-${Date.now()}.json`));const flow={process:async({phone,text,origin})=>{store.get(phone,origin).history.push({role:'assistant',content:text});return 'ok';},isDuplicate:()=>false,allowRate:()=>true,shouldWarnRate:()=>true};const app=await createApp({store,flow,dashboardAuth:async()=>true});const server=http.createServer((req,res)=>app(req,res));await new Promise(resolve=>server.listen(0,resolve));const port=server.address().port;const post=async(url,body)=>fetch(`http://127.0.0.1:${port}${url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const simulate=await post('/api/dashboard/simulate?x=1',{phone:'5586999962542',text:'oi'});assert.equal(simulate.status,200);const mode=await post('/api/dashboard/mode',{});assert.equal(mode.status,400);store.get('5586999962542');const clear=await post('/api/dashboard/clear',{phone:'5586999962542'});assert.equal(clear.status,400);await new Promise(resolve=>server.close(resolve));});
test('config e providers suportam openrouter para modelos gratuitos e fallback',async()=>{const {config}=await import('./config.mjs');assert.equal(typeof config.openrouterBaseUrl,'string');assert.equal(config.openrouterModel, undefined);});
test('telemetria e monitoramento calculam latencia, consumo de tokens e protegem dados', async () => {
  const { recordAICall, getMetricsSummary, resetMetrics } = await import('./metrics.mjs');
  resetMetrics();
  recordAICall({
    provider: 'openrouter',
    model: 'google/gemma-4-31b:free',
    latencyMs: 450,
    promptTokens: 120,
    completionTokens: 35,
    intent: 'agendar',
    success: true
  });
  recordAICall({
    provider: 'openrouter',
    model: 'google/gemma-4-31b:free',
    latencyMs: 650,
    promptTokens: 150,
    completionTokens: 40,
    intent: 'planos',
    success: true
  });
  recordAICall({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    latencyMs: 1200,
    promptTokens: 0,
    completionTokens: 0,
    intent: 'falha',
    success: false,
    error: 'Gemini 429 rate limit para 5586999962542 com bearer abcd1234efgh'
  });
  const summary = getMetricsSummary({ gemini: { status: 'degradado' }, openrouter: { status: 'operacional' } });
  assert.equal(summary.overview.totalRequests, 3);
  assert.equal(summary.overview.successfulRequests, 2);
  assert.equal(summary.overview.failedRequests, 1);
  assert.equal(summary.overview.avgLatencyMs, 767);
  assert.equal(summary.overview.totalPromptTokens, 270);
  assert.equal(summary.overview.totalCompletionTokens, 75);
  assert.equal(summary.overview.totalTokens, 345);
  assert.equal(summary.recentCalls.length, 3);
  assert.equal(summary.recentErrors.length, 1);
  // Regra do projeto: Logs não devem conter texto do cliente nem telefone completo
  assert.ok(!summary.recentErrors[0].message.includes('5586999962542'));
  assert.ok(!summary.recentErrors[0].message.includes('abcd1234efgh'));
  resetMetrics();
  assert.equal(getMetricsSummary().overview.totalRequests, 0);
});
test('endpoints /api/dashboard/metrics e /api/dashboard/metrics/reset respondem corretamente', async () => {
  const { createApp } = await import('./server.mjs');
  const http = await import('node:http');
  const store = new SessionStore(path.join(os.tmpdir(), `api-metrics-${Date.now()}.json`));
  const app = await createApp({ store, dashboardAuth: async () => true });
  const server = http.createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/metrics`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.overview);
  assert.ok(data.system);
  assert.equal(typeof data.system.uptime, 'number');
  assert.ok(data.circuitBreakers);

  const reset = await fetch(`http://127.0.0.1:${port}/api/dashboard/metrics/reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const resetData = await reset.json();
  assert.equal(resetData.ok, true);

  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
});
test('catalogo de modelos OpenRouter e endpoint /api/dashboard/models atendem requisitos', async () => {
  const { OPENROUTER_FREE_MODELS } = await import('./ai.mjs');
  const { createApp } = await import('./server.mjs');
  const http = await import('node:http');

  assert.ok(Array.isArray(OPENROUTER_FREE_MODELS));
  assert.ok(OPENROUTER_FREE_MODELS.length >= 8);

  const ids = OPENROUTER_FREE_MODELS.map(m => m.id);
  assert.ok(ids.includes('google/gemma-4-31b:free'));
  assert.ok(ids.includes('google/gemma-4-26b-a4b:free'));
  assert.ok(ids.includes('nvidia/nemotron-3-ultra:free'));
  assert.ok(ids.includes('nvidia/nemotron-3-super:free'));
  assert.ok(ids.includes('nvidia/nemotron-3.5-content-safety:free'));
  assert.ok(ids.includes('nvidia/nemotron-3-embed-1b:free'));

  const chatModels = OPENROUTER_FREE_MODELS.filter(m => m.category === 'chat');
  const nonChatModels = OPENROUTER_FREE_MODELS.filter(m => m.category !== 'chat');
  assert.ok(chatModels.length >= 4);
  assert.ok(nonChatModels.length >= 2);

  const store = new SessionStore(path.join(os.tmpdir(), `api-models-${Date.now()}.json`));
  const app = await createApp({ store, dashboardAuth: async () => true });
  const server = http.createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.openrouterModels));
  assert.equal(typeof data.activeProvider, 'string');

  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
});

test('normalizacao do 9o digito brasileiro preserva namespaces e unifica telefones', async () => {
  const { normalizePhone } = await import('./sessions.mjs');
  assert.equal(normalizePhone('558699962542'), '5586999962542');
  assert.equal(normalizePhone('5586999962542'), '5586999962542');
  assert.equal(normalizePhone('sim:558699962542'), 'sim:5586999962542');
  assert.equal(normalizePhone('8699962542'), '5586999962542');
  assert.equal(normalizePhone('86999962542'), '5586999962542');
  assert.equal(normalizePhone('123456789@lid'), '123456789@lid');
  assert.equal(normalizePhone('sim:123456789@lid'), 'sim:123456789@lid');
});

test('filterReply suporta precos curtos, evita falso positivo em pode ser e barra bypass por acento', async () => {
  const { filterReply } = await import('./safety.mjs');
  const allowed = new Set(['R$ 150,00', 'R$ 290,00']);
  assert.equal(filterReply('O valor da consulta é R$ 150', { allowedPrices: allowed }).blocked, false);
  assert.equal(filterReply('O valor é 150 reais', { allowedPrices: allowed }).blocked, false);
  assert.equal(filterReply('O valor é R$ 150,00', { allowedPrices: allowed }).blocked, false);
  assert.equal(filterReply('O valor é R$ 80', { allowedPrices: allowed }).blocked, true);

  assert.equal(filterReply('O agendamento pode ser feito de segunda a sábado').blocked, false);
  assert.equal(filterReply('O pagamento deve ser realizado após a consulta').blocked, false);
  assert.equal(filterReply('Trabalhamos de manhã com chá e café').blocked, false);
  assert.equal(filterReply('Você não precisa levar o pet até a clínica, nós vamos até você').blocked, false);

  assert.equal(filterReply('Você pode usar um remédio caseiro').blocked, true);
  assert.equal(filterReply('Você pode usar um remedio caseiro').blocked, true);
  assert.equal(filterReply('Dê 5 mg de dipirona').blocked, true);
});

test('tutorName aceita nomes reais e isHumanRequest encaminha para atendente', async () => {
  const { collectedValid, isHumanRequest } = await import('./flow.mjs');
  assert.equal(collectedValid({ tutorName: 'Ana Paula' }).tutorName, 'Ana Paula');
  assert.equal(collectedValid({ tutorName: 'Carlos' }).tutorName, 'Carlos');
  assert.equal(collectedValid({ tutorName: 'Tauan' }).tutorName, 'Tauan');
  assert.equal(collectedValid({ tutorName: 'Nicolas' }).tutorName, 'Nicolas');
  assert.equal(collectedValid({ tutorName: 'Paola' }).tutorName, 'Paola');
  assert.equal(collectedValid({ tutorName: 'Lola' }).tutorName, 'Lola');
  assert.equal(collectedValid({ tutorName: 'Rolando' }).tutorName, 'Rolando');
  assert.equal(collectedValid({ tutorName: 'dono' }).tutorName, undefined);
  assert.equal(collectedValid({ tutorName: 'ola' }).tutorName, undefined);

  assert.equal(isHumanRequest('quero falar com um atendente'), true);
  assert.equal(isHumanRequest('passa para uma pessoa'), true);
  assert.equal(isHumanRequest('falar com a Dra. Elisângela'), true);
  assert.equal(isHumanRequest('humano'), true);
  assert.equal(isHumanRequest('quanto custa o plano?'), false);
  assert.equal(isHumanRequest('atendimento pessoal'), false);
  assert.equal(isHumanRequest('meu boleto venceu'), false);
});

test('endpoint /health retorna status minimo sem expor versao ou providers', async () => {
  const { createApp } = await import('./server.mjs');
  const http = await import('node:http');
  const store = new SessionStore(path.join(os.tmpdir(), `api-health-${Date.now()}.json`));
  const app = await createApp({ store, dashboardAuth: async () => true });
  const server = http.createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true });

  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
});

test('C2: parser recupera reply de JSON truncado e nunca retorna string vazia para o cliente', async () => {
  const { parseAIResponse, extractTruncatedReply } = await import('./ai.mjs');
  assert.equal(extractTruncatedReply('{"reply":"Olá, como posso ajudar?'), 'Olá, como posso ajudar?');
  const p1 = parseAIResponse('{"reply":"Olá! Seja bem-vindo');
  assert.equal(p1.reply, 'Olá! Seja bem-vindo');

  const p2 = parseAIResponse('{"intent":"outro"}'); // sem reply
  assert.equal(p2.reply, '');

  const store = new SessionStore(path.join(os.tmpdir(), `c2-${Date.now()}.json`));
  await store.load();
  const flow = createFlow({
    store,
    ai: { askAI: async () => ({ reply: '', intent: 'outro', collected: {} }) },
    faq: async () => []
  });
  const reply = await flow.process({ phone: '5586999962542', text: 'quero saber mais' });
  assert.ok(reply && reply.length > 0);
  assert.notEqual(reply, '');
  assert.match(reply, /instabilidade|ajudar|Dra/i);
});

test('C3: comando bot retoma atendimento e duvida comum nao reativa emergencia', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `c3-${Date.now()}.json`));
  await store.load();
  const session = store.get('5586999962542');
  session.human = true;

  const flow = createFlow({
    store,
    allowClientResume: true,
    ai: { askAI: async () => ({ reply: 'Nossos planos incluem preventivo anual.', intent: 'planos', collected: {} }) },
    faq: async () => []
  });

  const res1 = await flow.process({ phone: '5586999962542', text: 'bot' });
  assert.match(res1, /retomei/i);

  const res2 = await flow.process({ phone: '5586999962542', text: 'oi, queria saber dos planos' });
  assert.doesNotMatch(res2, /urg[êe]ncia|socorro/i);
  assert.match(res2, /planos/i);
});

test('C4: triggerHandoff re-notifica em emergencia e modo humano responde emergencia', async () => {
  const { triggerHandoff } = await import('./handoff.mjs');
  let notifies = 0;
  const session = { phone: '5586999962542', history: [] };
  await triggerHandoff(session, { notify: async () => { notifies++; }, urgency: 'normal' });
  assert.equal(notifies, 1);
  assert.equal(session.handoffNotified, true);

  // Segunda chamada sem ser emergência não duplica notificação
  await triggerHandoff(session, { notify: async () => { notifies++; }, urgency: 'normal' });
  assert.equal(notifies, 1);

  // Chamada de emergência NOTIFICA novamente
  await triggerHandoff(session, { notify: async () => { notifies++; }, urgency: 'emergencia' });
  assert.equal(notifies, 2);

  // Em modo humano, fluxo responde emergência determinística
  const store = new SessionStore(path.join(os.tmpdir(), `c4-${Date.now()}.json`));
  await store.load();
  const s = store.get('5586999962542');
  s.human = true;
  let flowNotified = 0;
  const flow = createFlow({
    store,
    humanPhone: '5586988887777',
    whatsapp: { sendText: async () => { flowNotified++; } }
  });
  const emergencyReply = await flow.process({ phone: '5586999962542', text: 'isso é urgente, preciso de socorro agora' });
  assert.ok(emergencyReply !== null);
  assert.match(emergencyReply, /urg[êe]ncia|urg[êe]nte|socorro/i);
  assert.equal(flowNotified >= 1, true);
});

test('C5: wasSentByBot e recordBotSend evitam corrida do fromMe', async () => {
  const { wasSentByBot, recordBotSend } = await import('./whatsapp.mjs');
  recordBotSend('5586999962542', 'Olá, tudo bem?');
  assert.equal(wasSentByBot('id-desconhecido', '5586999962542', 'Olá, tudo bem?'), true);
  assert.equal(wasSentByBot('id-desconhecido', '5586999962542', 'Mensagem do humano'), false);
});

test('A1: IA fora gera fallback de instabilidade e alerta, sem triagem técnica', async () => {
  const store = new SessionStore(path.join(os.tmpdir(), `a1-${Date.now()}.json`));
  await store.load();
  let handoffs = 0;
  const flow = createFlow({
    store,
    ai: { askAI: async () => null }, // IA fora
    faq: async () => [],
    humanPhone: '5586988887777',
    whatsapp: { sendText: async () => { handoffs++; } }
  });

  const r1 = await flow.process({ phone: '5586999962542', text: 'onde vejo minha segunda via?' });
  assert.match(r1, /instabilidade/i);
  assert.doesNotMatch(r1, /pronto-socorro|Dra\./i);

  const r2 = await flow.process({ phone: '5586999962542', text: 'e o prazo de entrega?' });
  assert.match(r2, /instabilidade/i);
  assert.equal(store.get('5586999962542').human, false);
  assert.ok(handoffs >= 1);
});

test('A2: CONFIRMAR COM A DRA. nunca vaza no filterReply nem no knowledge FAQ', async () => {
  const { FAQ } = await import('./knowledge.mjs');
  for (const item of FAQ) {
    assert.doesNotMatch(item.answer, /CONFIRMAR/i);
  }
  const filtered = filterReply('As vacinas ficam em caixa térmica. // CONFIRMAR COM A DRA.');
  assert.doesNotMatch(filtered.text, /CONFIRMAR/i);
  assert.equal(filtered.text.includes('//'), false);
});

test('A3 e A4: providers priorizam configurados saudáveis e breaker abre com 429', async () => {
  const { providers, getCircuitBreakers, call } = await import('./ai.mjs');
  const list = providers();
  const breakers = getCircuitBreakers();
  const configured = Object.entries(breakers).filter(([, value]) => value.configured).map(([name]) => name).sort();
  assert.deepEqual([...list].sort(), configured);
  assert.ok(breakers.gemini);
  assert.ok(breakers.openrouter);
  assert.equal(breakers.openrouter.configured, breakers.openrouter.status !== 'nao_configurado');
  assert.ok(['operacional', 'degradado', 'aberto', 'nao_configurado'].includes(breakers.gemini.status));
});

test('M4: script migrate-phones migra chaves sem 9o digito preservando mais recente', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mig-'));
  const file = path.join(dir, 'sessions.json');
  const initial = {
    '558699962542': { phone: '558699962542', tutorName: 'Antigo', updatedAt: '2026-01-01T00:00:00Z', human: true },
    '5586999962542': { phone: '5586999962542', tutorName: 'Novo', updatedAt: '2026-02-01T00:00:00Z', human: true }
  };
  await fs.writeFile(file, JSON.stringify(initial));

  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('node', ['scripts/migrate-phones.mjs', file], { encoding: 'utf8' });
  assert.equal(res.status, 0);

  const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(migrated).length, 1);
  assert.ok(migrated['5586999962542']);
  assert.equal(migrated['5586999962542'].tutorName, 'Novo');
});
