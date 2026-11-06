import { sanitizeInput, isEmergency, filterReply, normalize, isGreeting } from './safety.mjs';
import { buildSystemPrompt, GREETING_MESSAGE, ATENDIMENTO_EM_PROGRESSO_MESSAGE, TALK_TO_TAIS_MESSAGE } from './knowledge.mjs';
import { findDynamicFaq, getPlansForPrompt, getAllowedPrices } from './faq.mjs';
import { triggerHandoff } from './handoff.mjs';
import { normalizePhone, isTauanContact } from './sessions.mjs';
import { executeToolCall } from './tools/index.mjs';

/**
 * Identifica se a pessoa quer falar diretamente com o Tauan ou com alguém humano
 */
export function isTalkToTauanRequest(text = '') {
  const n = normalize(text);
  return /(?:falar com|falar|passa|passar|transfere|transferir|chamar|chama|chame|quero|preciso|chamo|avisa|avisar|conectar|conversa|conversar)\s+(?:para\s+|pra\s+|pro\s+|ao\s+)?(?:com\s+)?(?:o\s+|a\s+|um[a]?\s+)?(?:tauan|humano|atendente|pessoa|voce mesmo|dono)\b/i.test(n) ||
    /^(?:tauan|falar com tauan|quero falar com o tauan|humano|atendente|pessoa|2|opcao 2|opção 2)$/i.test(n);
}

/**
 * Identifica se o usuário pediu especificamente a opção de "Atendimento"
 */
export function isAtendimentoOption(text = '') {
  const n = normalize(text);
  return /^(?:1|opcao 1|opção 1|atendimento|atendimento automatico|quero atendimento)$/i.test(n);
}

export function createFlow({
  store,
  ai,
  whatsapp = {},
  faq = async () => [],
  getBotConfig = () => ({}),
  now = () => Date.now(),
  humanPhone = '',
  getHumanPhone = () => humanPhone,
  reminderStore = null,
  getTelemetry = async () => ({}),
  allowClientResume = false,
  maxInputChars = 2000,
  rateLimitMax = 20,
  rateLimitWindowMs = 600000,
  logger = console
}) {
  const dedupe = new Map();
  const rate = new Map();
  const rateWarned = new Map();
  const nonTextNotice = new Map();

  const notify = (message) => {
    const phone = getHumanPhone();
    return phone ? whatsapp.sendText?.(phone, message) : undefined;
  };

  const isTauanSender = (p = '') => {
    return isTauanContact(p, getHumanPhone());
  };

  const getWaitingList = () => {
    return Object.values(store.sessions || {}).filter(s =>
      s && s.human && !s.archivedAt && s.phone && s.phone !== 'tauan_self' && !isTauanSender(s.phone)
    ).sort((a, b) => {
      const tA = a.handoffAt ? new Date(a.handoffAt).getTime() : 0;
      const tB = b.handoffAt ? new Date(b.handoffAt).getTime() : 0;
      return tA - tB;
    });
  };

  const findSessionByTarget = (targetStr = '') => {
    const raw = String(targetStr || '').trim();
    if (!raw) return null;

    const waiting = getWaitingList();

    // 1. Índice numérico da fila (ex: "1", "2")
    if (/^\d{1,2}$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      if (waiting[idx]) return waiting[idx];
    }

    const all = Object.values(store.sessions || {}).filter(s =>
      s && s.phone && s.phone !== 'tauan_self' && !isTauanSender(s.phone)
    );

    // 2. Por dígitos (telefone)
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8) {
      for (const s of all) {
        const sDigits = String(s.phone || '').replace(/\D/g, '');
        if (sDigits === digits || sDigits.endsWith(digits) || digits.endsWith(sDigits)) {
          return s;
        }
      }
      if (store.sessions[digits]) return store.sessions[digits];
      if (store.sessions[`sim:${digits}`]) return store.sessions[`sim:${digits}`];
    }

    // 3. Por nome do contato (busca por substring insensível a maiúsculas e acentos)
    const normName = normalize(raw);
    if (normName.length >= 2) {
      for (const s of all) {
        const cName = normalize(s.clientName || s.contactName || s.pushName || '');
        if (cName && (cName.includes(normName) || normName.includes(cName))) {
          return s;
        }
      }
    }

    // 4. Fallback pelo store.get se for número de telefone completo
    if (digits.length >= 8) {
      return store.get(digits);
    }

    return null;
  };

  return {
    isDuplicate(id) {
      if (!id) return false;
      const t = now();
      for (const [key, value] of dedupe) if (t - value > 600000) dedupe.delete(key);
      if (dedupe.has(id)) return true;
      dedupe.set(id, t);
      if (dedupe.size > 1000) dedupe.delete(dedupe.keys().next().value);
      return false;
    },
    allowRate(phone) {
      if (isTauanSender(phone) || phone === 'tauan_self') return true;
      const fresh = (rate.get(phone) || []).filter(t => now() - t < rateLimitWindowMs);
      if (fresh.length >= rateLimitMax) { rate.set(phone, fresh); return false; }
      fresh.push(now());
      rate.set(phone, fresh);
      return true;
    },
    shouldWarnRate(phone) {
      if (rateWarned.has(phone) && now() - rateWarned.get(phone) < rateLimitWindowMs) return false;
      rateWarned.set(phone, now());
      return true;
    },
    async process({
      phone,
      text,
      origin = 'real',
      nonText = false,
      mediaType = null,
      rawItem = null,
      pushName = '',
      authorizedResume = false
    }) {
      const botConfig = getBotConfig() || {};
      const isSelfTauan = phone === 'tauan_self' || isTauanSender(phone);

      // ==========================================
      // CASO 1: TAUAN INTERAGINDO COM A LIA (COPILOTO)
      // ==========================================
      if (isSelfTauan) {
        const sSelf = store.get(phone === 'tauan_self' ? 'tauan_self' : phone);
        sSelf.human = false;
        sSelf.isInternalChat = true;
        sSelf.clientName = 'Tauan Pires (Copiloto)';
        sSelf.handoffAt = null;
        sSelf.awaitingReply = false;
        sSelf.history ??= [];
        store.touch(sSelf);

        let cleanTauan = String(text || '').trim();
        if (mediaType === 'audio' && rawItem) {
          try {
            const media = await whatsapp.getMediaBase64?.(rawItem);
            if (media?.base64) {
              const transcribed = await ai.transcribeAudio?.(media.base64, media.mimetype);
              if (transcribed && transcribed.trim()) {
                cleanTauan = transcribed.trim();
              }
            }
          } catch (e) {
            console.error('[flow] Erro na transcrição de áudio do Copiloto:', e.message);
          }
        }
        if (!cleanTauan) {
          return filterReply('Estou aqui, Tauan! Pode digitar ou mandar um áudio com o que precisar.', { isCopilot: true }).text;
        }
        // Strip leading "Lia," or "Lia " if present so commands like "Lia fila" or "Lia status" match cleanly
        const strippedCmd = cleanTauan.replace(/^[@/]?lia[\s,:-]*/i, '').trim() || cleanTauan;
        const norm = normalize(strippedCmd);
        const telemetry = await getTelemetry?.();

        const recordSelfTurn = (replyText) => {
          sSelf.history.push({ role: 'user', content: cleanTauan, createdAt: new Date(now()).toISOString() });
          sSelf.history.push({ role: 'assistant', content: replyText, createdAt: new Date(now()).toISOString() });
          if (sSelf.history.length > 40) sSelf.history = sSelf.history.slice(-30);
          sSelf.lastUserAt = new Date(now()).toISOString();
          sSelf.lastBotAt = new Date(now()).toISOString();
          sSelf.updatedAt = new Date(now()).toISOString();
          store.markDirty();
          return replyText;
        };

        // 1.1 Ajuda e Comandos Internos
        if (/^(?:ajuda|comandos|comando|help|menu)\b/i.test(norm)) {
          const helpMsg = `🚀 *Painel de Controles e Comandos da Lia*

Olá, *Tauan*! Aqui estão os comandos que você pode usar diretamente por este canal:

📊 *Operação & Monitoramento:*
• *status* ou *resumo* — Diagnóstico completo: IA, WhatsApp e filas
• *fila* ou *espera* — Contatos aguardando sua resposta com link direto
• *lembretes* — Seus compromissos e anotações pendentes

⚙️ *Gestão de Contatos:*
• *bot [número]* — Reativa a Lia para atender o cliente automaticamente
• *humano [número]* — Pausa a Lia para você assumir o atendimento manual
• *limpar [número]* — Reseta o histórico de conversa com o contato

💡 *Copiloto Inteligente:*
• Converse normalmente comigo para tirar dúvidas, rascunhar mensagens ou criar lembretes (ex: _"me lembra amanhã às 9h de..."_).`;
          return recordSelfTurn(filterReply(helpMsg, { isCopilot: true }).text);
        }

        // 1.2 Status e Diagnóstico Operacional
        if (/^(?:status|resumo|painel|diagnostico|como estamos\??|como estao as coisas\??)\b/i.test(norm)) {
          const sessionsArr = Object.values(store.sessions);
          const activeCount = sessionsArr.filter(s => !s.inactivityClosed && (s.history?.length || 0) > 0).length;
          const humanWaiting = sessionsArr.filter(s => s.human && !s.inactivityClosed && s.phone);
          const remList = reminderStore ? reminderStore.listActive() : [];

          const provider = telemetry?.activeProvider || botConfig.ai?.activeProvider || 'gemini';
          const model = telemetry?.activeModel || botConfig.ai?.activeModel || 'gemini-3.8-flash';
          const evoState = telemetry?.evolution?.status || 'conectado';
          const evoBadge = (evoState === 'connected' || evoState === 'conectado') ? '🟢 Conectado' : `🟡 ${evoState}`;

          const statusMsg = `📊 *Raio-X Operacional do Sistema*

🟢 *Status Geral:* Operacional e Ativo

🤖 *Inteligência Artificial:*
• *Provedor:* ${provider}
• *Modelo Ativo:* ${model}

📱 *Conexão WhatsApp:*
• *Evolution API:* ${evoBadge}

👥 *Atendimentos:*
• *Conversas em andamento:* ${activeCount}
• *Em espera humana:* ${humanWaiting.length} ${humanWaiting.length > 0 ? '⚠️ (digite *fila* para ver)' : '✨'}

⏰ *Lembretes:*
• *Pendentes:* ${remList.length} ${remList.length > 0 ? '(digite *lembretes* para ver)' : ''}

_Dica: digite *ajuda* para ver todos os comandos disponíveis._`;
          return recordSelfTurn(filterReply(statusMsg, { isCopilot: true }).text);
        }

        // 1.3 Consulta de Contatos Aguardando (Fila)
        if (/(?:quem|quais|lista|contatos?|aguardando|esperando|espera|fila|pendentes?|transbordos?|alguem)\b/i.test(norm)) {
          const waiting = getWaitingList();
          if (!waiting.length) {
            const emptyMsg = `✨ *Fila de Atendimento Zerada!*

Tauan, não há nenhum contato aguardando retorno no momento! Todos os atendimentos estão em dia. 👍`;
            return recordSelfTurn(filterReply(emptyMsg, { isCopilot: true }).text);
          }
          const lines = waiting.map((w, i) => {
            const name = w.clientName || w.contactName || w.pushName || 'Contato';
            const num = String(w.phone).replace(/@.*$/, '').replace(/\D/g, '');
            const lastMsg = (w.history?.at(-1)?.content || '').slice(0, 80);
            const waitMin = w.handoffAt ? Math.max(1, Math.round((now() - new Date(w.handoffAt).getTime()) / 60000)) : null;
            const waitStr = waitMin ? ` _(aguardando há ~${waitMin} min)_` : '';
            return `${i + 1}. *${name}*${waitStr}\n   📱 https://wa.me/${num}\n   💬 _"${lastMsg || '(Sem mensagem recente)'}"_`;
          }).join('\n\n');

          const filaMsg = `👥 *Contatos aguardando sua resposta (${waiting.length}):*\n\n${lines}\n\n💡 *Para devolver o atendimento para a Lia:*\nResponda *bot [número da lista]* (ex: *bot 1*), *bot [telefone]* ou *bot [nome]*.`;
          return recordSelfTurn(filterReply(filaMsg, { isCopilot: true }).text);
        }

        // 1.4 Comando: Reativar Bot para um número, índice ou nome
        const botMatch = strippedCmd.match(/^(?:bot|reativar|ativar)\b\s*(.*)$/i);
        if (botMatch) {
          const targetArg = botMatch[1].trim();
          if (!targetArg) {
            return recordSelfTurn(filterReply(`🤖 *Como reativar o bot:*\n\nInforme qual contato deseja devolver para a Lia. Exemplos:\n• *bot 1* (reativa o 1º da fila de espera)\n• *bot 5588993602644* (reativa pelo telefone)\n• *bot Mikaelle* (reativa pelo nome do contato)\n\nDigite *fila* para ver os contatos em espera.`, { isCopilot: true }).text);
          }
          const sTarget = findSessionByTarget(targetArg);
          if (!sTarget) {
            return recordSelfTurn(filterReply(`⚠️ *Contato não localizado!*\n\nNão encontrei nenhuma conversa correspondente a *"${targetArg}"*. Digite *fila* para ver quem está aguardando ou confira o número informado.`, { isCopilot: true }).text);
          }
          sTarget.human = false;
          sTarget.humanSource = null;
          sTarget.handoffAt = null;
          sTarget.handoffReminderAt = null;
          sTarget.handoffReminder1Sent = false;
          sTarget.handoffReminder60Sent = false;
          sTarget.handoffNotified = false;
          sTarget.inactivityClosed = false;
          sTarget.updatedAt = new Date(now()).toISOString();
          store.markDirty();
          await store.flush?.();
          const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
          const targetPhone = String(sTarget.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
          const rep = `🤖 *Bot reativado com sucesso!*\n\nA Lia voltou a atender *${targetName}* (${targetPhone}) automaticamente.`;
          return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
        }

        // 1.5 Comando: Pausar Bot / Atendimento Humano para um número, índice ou nome
        const humanMatch = strippedCmd.match(/^(?:humano|pausar|assumir)\b\s*(.*)$/i);
        if (humanMatch) {
          const targetArg = humanMatch[1].trim();
          if (!targetArg) {
            return recordSelfTurn(filterReply(`👤 *Como assumir atendimento:*\n\nInforme qual contato deseja pausar o bot. Exemplos:\n• *humano 1* (primeiro da lista)\n• *humano 5588993602644* (pelo telefone)\n• *humano Mikaelle* (pelo nome)`, { isCopilot: true }).text);
          }
          const sTarget = findSessionByTarget(targetArg);
          if (!sTarget) {
            return recordSelfTurn(filterReply(`⚠️ *Contato não localizado!*\n\nNão encontrei nenhuma conversa correspondente a *"${targetArg}"*.`, { isCopilot: true }).text);
          }
          sTarget.human = true;
          sTarget.humanSource = 'admin';
          sTarget.handoffAt = new Date(now()).toISOString();
          sTarget.takeoverAt = new Date(now()).toISOString();
          sTarget.handoffReason = 'pausado via comando do Tauan';
          sTarget.handoffReminderAt = null;
          sTarget.inactivityClosed = false;
          sTarget.updatedAt = new Date(now()).toISOString();
          store.markDirty();
          await store.flush?.();
          const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
          const targetPhone = String(sTarget.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
          const rep = `👤 *Atendimento humano ativado!*\n\nA Lia foi pausada para *${targetName}* (${targetPhone}). O contato agora aguarda sua resposta manual.`;
          return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
        }

        // 1.6 Comando: Limpar / Resetar Sessão de um número, índice ou nome
        const resetMatch = strippedCmd.match(/^(?:limpar|reset|resetar)\b\s*(.*)$/i);
        if (resetMatch) {
          const targetArg = resetMatch[1].trim();
          if (!targetArg) {
            return recordSelfTurn(filterReply(`🧹 *Como resetar sessão:*\n\nInforme o contato para limpar o histórico. Ex: *limpar 1* ou *limpar 5588993602644*.`, { isCopilot: true }).text);
          }
          const sTarget = findSessionByTarget(targetArg);
          if (!sTarget) {
            return recordSelfTurn(filterReply(`⚠️ *Contato não localizado!*\n\nNão encontrei nenhuma conversa correspondente a *"${targetArg}"*.`, { isCopilot: true }).text);
          }
          sTarget.history = [];
          sTarget.human = false;
          sTarget.humanSource = null;
          sTarget.handoffAt = null;
          sTarget.handoffReminderAt = null;
          sTarget.handoffNotified = false;
          sTarget.inactivityClosed = false;
          sTarget.updatedAt = new Date(now()).toISOString();
          store.markDirty();
          await store.flush?.();
          const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
          const targetPhone = String(sTarget.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
          const rep = `🧹 *Sessão resetada com sucesso!*\n\nO histórico e o estado de *${targetName}* (${targetPhone}) foram limpos para um novo início.`;
          return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
        }

        // 1.7 Consulta de Lembretes do Tauan
        if (/(?:quais|ver|listar|lista|meus)?\s*(?:lembretes|agendamentos)\b/i.test(norm)) {
          if (!reminderStore) return recordSelfTurn(filterReply('Módulo de lembretes não inicializado no momento.', { isCopilot: true }).text);
          const list = reminderStore.listActive();
          if (!list.length) return recordSelfTurn(filterReply('Tauan, você não tem nenhum lembrete pendente no momento! Tudo em dia por aqui. ✨', { isCopilot: true }).text);
          const lines = list.map((r, i) => {
            const dataStr = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(r.dueAt));
            return `${i + 1}. *${r.text}*\n   📅 *Data/Hora:* ${dataStr}${r.clientName ? `\n   👤 *Contato:* ${r.clientName}` : ''}`;
          }).join('\n\n');
          return recordSelfTurn(filterReply(`📋 *Seus lembretes pendentes:*\n\n${lines}`, { isCopilot: true }).text);
        }

        // 1.8 Chamada Inteligente com Persona de Copiloto do Tauan
        const recentHistory = Array.isArray(sSelf.history) ? sSelf.history.slice(-12) : [];
        const sys = buildSystemPrompt({
          session: { history: recentHistory },
          now: new Date(now()),
          botConfig,
          isTauan: true,
          telemetry
        });

        const result = await ai?.askAI?.({
          system: sys,
          history: recentHistory,
          userText: cleanTauan,
          botConfig
        });

        // Se pediu para agendar um lembrete
        if (result?.reminder && reminderStore) {
          const remText = String(result.reminder.text || '').trim();
          const isPlaceholder = remText.length < 5 || /^(?:recado|lembrete|descri[cç][aã]o|anota[cç][aã]o|exemplo|\.\.\.)/i.test(remText);
          const askedReminder = /(?:lembr|agend|compromisso|anot|tarefa|marcar)\b/i.test(cleanTauan) || result.intent === 'lembrete';
          if (!isPlaceholder && askedReminder) {
            reminderStore.add({
              text: remText,
              dueAt: result.reminder.dueAt,
              phone: 'tauan',
              clientName: 'Tauan Pires',
              createdBy: 'tauan'
            });
          }
        }

        const rawReply = result?.reply || 'Estou aqui, Tauan! O sistema está operando normalmente. Em que posso te ajudar agora?';
        return recordSelfTurn(filterReply(rawReply, { isCopilot: true }).text);
      }

      // ==========================================
      // CASO 2: CONTATO / CLIENTE NO WHATSAPP
      // ==========================================
      if (phone === 'tauan_self' || isTauanSender(phone)) {
        return filterReply('Estou aqui, Tauan! O sistema está operando normalmente. Em que posso te ajudar agora?').text;
      }

      let clean = sanitizeInput(text, maxInputChars);
      const s = store.get(phone, origin);
      s.phone = phone;

      if (pushName && !s.clientName) s.clientName = pushName;
      s.lastUserAt = new Date(now()).toISOString();
      store.touch(s);
      s.history ??= [];

      // 2.1 TRATAMENTO DE ÁUDIO
      if (mediaType === 'audio') {
        let transcribed = null;
        try {
          const media = await whatsapp.getMediaBase64?.(rawItem);
          if (media?.base64) {
            transcribed = await ai.transcribeAudio?.(media.base64, media.mimetype);
          }
        } catch (e) {
          console.error('[flow] Erro na transcrição de áudio:', e.message);
        }

        if (transcribed && transcribed.trim()) {
          clean = sanitizeInput(transcribed.trim(), maxInputChars);
          s.history.push({ role: 'user', content: `[Áudio]: ${clean}`, createdAt: new Date(now()).toISOString() });
        } else {
          s.history.push({ role: 'user', content: '[Áudio enviado]', createdAt: new Date(now()).toISOString() });
        }

        // Se já estiver em modo de atendimento humano, não interfere nem responde
        if (s.human) {
          store.markDirty();
          return null;
        }

        if (!transcribed || !transcribed.trim()) {
          const clientName = s.clientName || pushName || 'Contato';
          const cleanPhone = String(phone).replace(/@.*$/, '').replace(/\D/g, '');
          const alertMsg = `🎙️ *Novo áudio recebido de ${clientName}!*\n📱 *WhatsApp:* https://wa.me/${cleanPhone}\n\n_A Lia notificou o cliente e aguarda você ouvir._`;

          await triggerHandoff(s, {
            reason: 'Áudio recebido do cliente',
            urgency: 'normal',
            now: now(),
            notify: () => notify(alertMsg)
          });

          const reply = 'Recebi seu áudio por aqui! 🎙️\n\nJá notifiquei o *Tauan* para ele ouvir com atenção e te responder assim que puder, tá bom?';
          s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
          s.lastBotAt = new Date(now()).toISOString();
          store.markDirty();
          return reply;
        }
      }

      // 2.2 TRATAMENTO DE FOTO / VÍDEO
      if (mediaType === 'image' || mediaType === 'video') {
        const typeLabel = mediaType === 'image' ? 'foto' : 'vídeo';
        s.history.push({ role: 'user', content: `[${typeLabel} enviada]` + (clean ? `: ${clean}` : ''), createdAt: new Date(now()).toISOString() });

        // Se já estiver em modo de atendimento humano, não interfere nem responde
        if (s.human) {
          store.markDirty();
          return null;
        }

        const clientName = s.clientName || pushName || 'Contato';
        const cleanPhone = String(phone).replace(/@.*$/, '').replace(/\D/g, '');
        const alertMsg = `📸 *Novo(a) ${typeLabel} recebido(a) de ${clientName}!*\n📱 *WhatsApp:* https://wa.me/${cleanPhone}\n💬 *Legenda:* "${clean || '(Sem legenda)'}"\n\n_A Lia notificou o cliente e pausou o bot para você continuar._`;

        await triggerHandoff(s, {
          reason: `Envio de ${typeLabel} pelo cliente`,
          urgency: 'normal',
          now: now(),
          notify: () => notify(alertMsg)
        });

        const reply = `Recebi sua *${typeLabel}* por aqui! 📸\n\nJá dei um toque no *Tauan* para ele dar uma olhada e te responder com atenção assim que puder.`;
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
        s.lastBotAt = new Date(now()).toISOString();
        store.markDirty();
        return reply;
      }

      // 2.3 TRATAMENTO DE DOCUMENTOS (PDF, BRIEFINGS, CONTRATOS)
      if (mediaType === 'document') {
        let docAnalysis = null;
        try {
          const media = await whatsapp.getMediaBase64?.(rawItem);
          if (media?.base64) {
            docAnalysis = await ai.analyzeDocument?.({
              base64: media.base64,
              mimetype: media.mimetype || 'application/pdf',
              caption: clean
            });
          }
        } catch (e) {
          console.error('[flow] Erro na análise de documento:', e.message);
        }

        if (s.human) {
          store.markDirty();
          return null;
        }

        const clientName = s.clientName || pushName || 'Contato';
        const cleanPhone = String(phone).replace(/@.*$/, '').replace(/\D/g, '');

        if (docAnalysis && docAnalysis.summary) {
          const docTypeFormatted = String(docAnalysis.docType || 'PDF').toUpperCase();
          const keySummary = `[Documento ${docTypeFormatted} analisado]\nResumo: ${docAnalysis.summary}` +
            (Array.isArray(docAnalysis.keyPoints) && docAnalysis.keyPoints.length ? `\nPontos-chave: ${docAnalysis.keyPoints.join('; ')}` : '');
          s.history.push({ role: 'user', content: keySummary, createdAt: new Date(now()).toISOString() });

          const alertMsg = `📄 *Novo Documento (${docTypeFormatted}) recebido de ${clientName}!*\n📱 *WhatsApp:* https://wa.me/${cleanPhone}\n\n📋 *Resumo Executivo:*\n${docAnalysis.summary}\n\n📌 *Pontos Identificados:*\n${(docAnalysis.keyPoints || []).map(p => `• ${p}`).join('\n')}\n\n💡 *Ação Sugerida:* ${docAnalysis.actionNeeded || 'Revisar anexo'}`;

          await triggerHandoff(s, {
            reason: `Envio de documento (${docTypeFormatted}) analisado pela Lia`,
            urgency: 'normal',
            now: now(),
            notify: () => notify(alertMsg)
          });

          const reply = `Recebi seu documento por aqui! 📄\n\n${docAnalysis.summary}\n\nJá organizei os pontos principais e notifiquei o *Tauan* para ele dar uma olhada e te responder com atenção!`;
          s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
          s.lastBotAt = new Date(now()).toISOString();
          store.markDirty();
          return reply;
        }
      }

      // 2.4 DOCUMENTO OU STICKER NÃO-TEXTO (FALLBACK)
      if (nonText && !clean) {
        if (s.human) { store.markDirty(); return null; }
        const last = nonTextNotice.get(phone) || 0;
        if (now() - last < 3600000) return null;
        nonTextNotice.set(phone, now());
        s.history.push({ role: 'user', content: '[Arquivo/mídia enviada]', createdAt: new Date(now()).toISOString() });
        store.markDirty();
        return 'Recebi seu arquivo por aqui! 📄\n\nSe preferir escrever ou mandar um áudio com o que você precisa, fico à disposição por aqui.';
      }

      if (!clean) { store.markDirty(); return null; }
      if (mediaType !== 'audio') {
        s.history.push({ role: 'user', content: clean, createdAt: new Date(now()).toISOString() });
      }

      // ==========================================
      // CONTROLE E RESPEITO AO MODO HUMANO
      // ==========================================
      if (s.human) {
        const normClean = normalize(clean);
        const canClientResume = Boolean(allowClientResume || botConfig?.behavior?.allowClientResume);

        // Somente comandos deliberados e explícitos de retorno ao bot
        const isExplicitResumeCommand =
          /^(?:voltar bot|reativar bot|#bot|!bot|ativar bot|chamar o bot|quero o bot|retomar bot|falar com lia|chamar lia)$/i.test(normClean) ||
          (/^(?:bot|menu|voltar)$/i.test(normClean) && normClean.length <= 6);

        if (canClientResume && isExplicitResumeCommand) {
          s.human = false;
          s.humanSource = 'resume';
          s.handoffAt = null;
          s.handoffReminderAt = null;
          s.handoffNotified = false;
          s.handoffReminder1Sent = false;
          s.handoffReminder60Sent = false;

          const resumeReply = 'Prontinho! *Atendimento automático retomado.* ✨\n\nComo posso te ajudar agora?';
          s.history.push({ role: 'assistant', content: resumeReply, createdAt: new Date(now()).toISOString() });
          s.lastBotAt = new Date(now()).toISOString();
          store.markDirty();
          return resumeReply;
        }

        // Se for emergência crítica relatada durante o atendimento humano
        if (isEmergency(clean)) {
          const emergencyNotice = 'Entendido! 🚨\n\nJá registrei a urgência e notifiquei o *Tauan* com prioridade máxima!';
          await triggerHandoff(s, {
            reason: 'urgência relatada em atendimento com Tauan',
            urgency: 'emergencia',
            now: now(),
            notify
          });
          s.history.push({ role: 'assistant', content: emergencyNotice, createdAt: new Date(now()).toISOString() });
          store.markDirty();
          return emergencyNotice;
        }

        // No modo humano ativo, a Lia respeita o atendente e não envia resposta ao cliente
        store.markDirty();
        return null;
      }

      // Se for emergência geral
      if (isEmergency(clean)) {
        await triggerHandoff(s, { reason: 'urgência sinalizada pelo contato', urgency: 'emergencia', now: now(), notify });
        const reply = 'Entendido! 🚨\n\nComo se trata de algo *urgente*, já passei o aviso diretamente com prioridade máxima para o *Tauan* no WhatsApp dele e ele já vai te responder!';
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
        store.markDirty();
        return reply;
      }

      // Se o usuário selecionou diretamente "Falar com Tauan"
      if (isTalkToTauanRequest(clean)) {
        await triggerHandoff(s, { reason: 'solicitação para falar diretamente com o Tauan', urgency: 'normal', now: now(), notify });
        const reply = botConfig.messages?.talkToTauan || TALK_TO_TAIS_MESSAGE;
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
        s.lastBotAt = new Date(now()).toISOString();
        store.markDirty();
        return reply;
      }

      // Atendimento inteligente: a Lia usa a IA com memória do contexto
      const items = await faq();
      let result = await ai?.askAI?.({
        system: buildSystemPrompt({ session: s, faq: items, plans: getPlansForPrompt(), now: new Date(now()), botConfig, isTauan: false }),
        history: s.history.slice(0, -1),
        userText: `<mensagem_do_cliente>${clean}</mensagem_do_cliente>`,
        botConfig
      });

      let raw = (result?.reply || '').trim();
      if (/^\s*\{|"reply"\s*:/.test(raw)) {
        const m = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
        raw = m ? (m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()) : '';
      }

      if (!result || !raw) {
        if ((s.history || []).length > 2) {
          raw = 'Tive uma leve oscilação de conexão aqui! 📶\n\nMas posso:\n• *Anotar o seu recado* para passar pra ele\n• *Te colocar direto em contato* com o Tauan agora mesmo\n\nComo prefere seguir?';
        } else {
          raw = botConfig.messages?.greeting || GREETING_MESSAGE;
        }
      }

      const filtered = filterReply(raw, { allowedPrices: getAllowedPrices() });
      let finalReply = filtered.text;

      // Execução de Ferramentas Ativas (Function Calling - padrão tools/)
      if (Array.isArray(result?.tool_calls) && result.tool_calls.length > 0) {
        for (const tc of result.tool_calls) {
          if (tc?.name) {
            try {
              const toolRes = await executeToolCall(tc.name, tc.args || {}, {
                phone: s.phone,
                clientName: s.clientName || pushName || 'Cliente',
                store,
                reminderStore,
                session: s
              });
              logger.log?.(`[flow:tool] Executada ${tc.name}:`, JSON.stringify(toolRes));
              if (toolRes?.handoffRequested) {
                result.handoff = true;
                result.handoff_reason = toolRes.motivo || `Transferência via tool ${tc.name}`;
              }
            } catch (err) {
              logger.error?.(`[flow:tool] Falha em ${tc.name}:`, err.message);
            }
          }
        }
      }

      // Se o cliente pediu para agendar um lembrete/recado
      if (result?.reminder && reminderStore) {
        const remText = String(result.reminder.text || '').trim();
        const isPlaceholder = remText.length < 5 || /^(?:recado|lembrete|descri[cç][aã]o|anota[cç][aã]o|exemplo|\.\.\.)/i.test(remText);
        const askedReminder = /(?:lembr|agend|recado|anot|avis|hor[aá]rio)\b/i.test(clean) || result.intent === 'lembrete';
        if (!isPlaceholder && askedReminder) {
          reminderStore.add({
            text: remText,
            dueAt: result.reminder.dueAt,
            phone: s.phone,
            clientName: s.clientName || pushName || 'Contato',
            createdBy: 'cliente'
          });
        }
      }

      // Se a IA julgou pelo contexto que deve transferir para o Tauan
      const textHintsHandoff = /(?:avisei|aviso|avisei o tauan|transferir|passei o recado|dar um toque no tauan)\b/i.test(finalReply);
      if (result?.handoff || result?.intent === 'falar_com_tauan' || textHintsHandoff) {
        await triggerHandoff(s, {
          reason: result?.handoff_reason || (textHintsHandoff ? 'transferência informada pela Lia' : 'sugerido pela Lia pelo contexto'),
          urgency: 'normal',
          now: now(),
          notify
        });
      }

      s.history.push({ role: 'assistant', content: finalReply, createdAt: new Date(now()).toISOString() });
      if (s.history.length > 40) {
        s.history = s.history.slice(-30);
      }
      s.lastBotAt = new Date(now()).toISOString();
      store.markDirty();
      return finalReply;
    }
  };
}
