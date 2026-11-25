import { filterReply, normalize } from '../safety.mjs';
import { OWNER_SELF_KEY } from '../core/identity.mjs';
import { avaliarJanelaDeAtendimento } from '../business-hours.mjs';
import { getMetricsSummary } from '../metrics.mjs';
import { notifyReactivationToInternalChat } from '../http/reactivation-notice.mjs';
import { isHumanHandoffActive, enterHumanHandoff, resumeHumanHandoff } from './human-handoff-state.mjs';

function todayInTimezone(nowMs, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatCalendarEvent(event, timezone) {
  const start = event?.start?.dateTime || event?.start?.date;
  if (!start) return `${event?.summary || 'Compromisso'} — data não informada`;
  if (event?.start?.date && !event?.start?.dateTime) {
    const [year, month, day] = String(event.start.date).split('-');
    return `${event?.summary || 'Compromisso'} — dia todo em ${day}/${month}/${year}`;
  }
  const date = new Date(start);
  if (!Number.isFinite(date.getTime())) return `${event?.summary || 'Compromisso'} — ${start}`;
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone, dateStyle: 'short', timeStyle: 'short'
  }).format(date);
  return `${event?.summary || 'Compromisso'} — ${formatted}`;
}

function findRecentOwnerReminderConfirmation(history = [], currentText = '') {
  const entries = Array.isArray(history) ? history : [];
  const current = normalize(currentText);
  let currentIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.role !== 'user') continue;
    if (normalize(entries[i]?.content || '') === current) currentIndex = i;
    break;
  }
  const asksConfirmation = /\b(?:poderia|pode|consegue|me ajuda a|quero|preciso)?\s*(?:me\s+)?confirmar\b|\bconfirma\s+(?:pra|para)\s+mim\b/.test(current);
  if (!asksConfirmation) return null;

  let assistantIndex = -1;
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    if (entries[i]?.role === 'assistant') { assistantIndex = i; break; }
  }
  if (assistantIndex < 0) return null;
  const assistantText = String(entries[assistantIndex]?.content || '');
  const claimedSuccess = /\b(?:lembrete|retorno|agendamento|compromisso)\b.{0,180}\b(?:agendad[oa]|registrad[oa]|criad[oa]|marcad[oa])\b|\b(?:agendad[oa]|registrad[oa]|criad[oa]|marcad[oa])\b.{0,180}\b(?:lembrete|retorno|agendamento|compromisso)\b/i.test(normalize(assistantText));
  if (!claimedSuccess) return null;

  let priorUserText = '';
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (entries[i]?.role === 'user') {
      priorUserText = String(entries[i]?.content || '');
      break;
    }
  }
  const subjectMatch = assistantText.match(/(?:assunto|foco em)\s*:\s*["“]?(.+?)["”]?\s*(?:\n|$)/i);
  let subject = String(subjectMatch?.[1] || priorUserText).trim();
  subject = subject
    .replace(/^(?:me\s+)?(?:lembrar|lembre|lembra|agendar|agende|marcar|marque|criar|crie|anotar|anote)\s+/i, '')
    .replace(/[,.]?\s*(?:para\s+)?(?:hoje|amanh[aã]|depois\s+de\s+amanh[aã]|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|dia\s+\d{1,2}|daqui\s+a?\s+\d+\s+dias?)[\s\S]*$/i, '')
    .replace(/[,.]?\s+as?\s+\d{1,2}(?::\d{2}|h(?:\d{2})?)?[\s\S]*$/i, '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  if (!subject) return null;
  return { subject, sourceText: priorUserText, assistantText };
}

/**
 * Executa comandos determinísticos rápidos do Copiloto (1.0.5 a 1.7).
 * Retorna a resposta final gravada ou `null` quando a mensagem deve seguir
 * para os fluxos de confirmação, despacho ou IA conversacional.
 */
export async function handleOwnerQuickCommands({
  norm,
  strippedCmd,
  sSelf,
  store,
  ai,
  reminderStore,
  logger,
  now,
  botConfig,
  identity,
  owner,
  assistant,
  ownerLabel,
  telemetry,
  getWaitingList,
  findSessionByTarget,
  executeToolCall,
  stageGeneratedPdf,
  PDF_TYPES,
  recordSelfTurn
}) {
  // 1.0.5 Auto-conhecimento e Capacidades da assistente
  if (/(?:quem [ée] voc[êe]|o que voc[êe] faz|habilidades?|capacidades?|fun[cç][õo]es|ferramentas?|o que voc[êe] pode fazer|apresente-se|se apresente|sobre voc[êe]|quem e vc|quem voce e|suas skills)\b/i.test(norm)) {
    const capMsg = `✨ *Olá, ${owner}! Eu sou a ${assistant}, sua Copiloto Executiva e Inteligência Artificial Operacional.*

Atuo como seu braço direito no dia a dia${identity.companyName ? ` da ${identity.companyName}` : ''} e nos atendimentos aos clientes. Aqui está tudo o que eu sou capaz de fazer diretamente:

🛠️ *Minhas Ferramentas Operacionais Ativas:*
• *Google Agenda:* Consulto horários livres, listo sua rotina e agendo reuniões com clientes diretamente pelo chat.
• *Emissão de Documentos em PDF (pdfme):* Crio propostas, orçamentos e relatórios executivos em PDF nativo sem consumir CPU da VPS.
• *Diagnóstico de Infraestrutura:* Monitoro a saúde da VPS, memória, containers, Evolution API e instâncias do Dokku em tempo real.
• *Disparo Ativo no WhatsApp:* Envio mensagens de texto ou gravo áudios com minha própria voz sintetizada para seus contatos.
• *Leitura de Documentos & PDFs:* Analiso comprovantes de pagamento (PIX/TED com valores e data), contratos, propostas e briefings.
• *Follow-up Inteligente:* Reengajo automaticamente leads parados ou orçamentos não respondidos em horário comercial.
• *Bases de Conhecimento:* Consulto os dossiês completos dos sistemas de cada cliente e parceiro cadastrado.

💬 *Comandos Rápidos do Chat Interno:*
• *agenda* ou *livres* - Consulta horários disponíveis no Google Agenda
• *infra* ou *servidores* - Diagnóstico completo de saúde das máquinas
• *status* ou *resumo* - Raio-X dos atendimentos e IA
• *fila* - Clientes que aguardam seu retorno manual
• *ping* - Teste de latência real em ms
• *bot off* / *bot on* - Pausa ou reativa o bot globalmente
• *ajuda* - Ver todos os comandos

_Sempre que precisar, é só me pedir em linguagem natural!_ 🚀`;
    return recordSelfTurn(filterReply(capMsg, { isCopilot: true }).text);
  }

  // 1.0.6 Atalho Direto: Diagnóstico de Infraestrutura
  if (/^(?:infra|infraestrutura|saude dos servidores|saúde dos servidores|dokku|servidores|saude da vps|saúde da vps)\b/i.test(norm)) {
    const infraRes = await executeToolCall('consultar_saude_infra', { target: 'geral' }, { store });
    const checks = infraRes?.checks || [];
    const statusIcon = infraRes?.health === 'healthy' ? '🟢' : '🟡';
    const checksList = checks.map(c => `• *${c.name}:* ${c.status}${c.details ? ` (${c.details})` : ''}`).join('\n');
    const infraMsg = `${statusIcon} *Diagnóstico de Infraestrutura & Servidores:*\n\n${checksList}\n\n_Checagem concluída com sucesso._`;
    return recordSelfTurn(filterReply(infraMsg, { isCopilot: true }).text);
  }

  // Consulta nominal de compromissos: consulta o Google Calendar e cruza,
  // separadamente, lembretes internos pendentes. Falha na agenda nunca vira
  // uma resposta falsa de "não há compromisso".
  const calendarLookupText = String(norm || '').trim().replace(/[?!.]+$/g, '');
  const calendarPersonMatch = calendarLookupText.match(/^(?:o\s+que|quais?|liste|listar|ver|consultar|consulta)\s+(?:(?:voce|vc)\s+)?(?:(?:ja\s+)?(?:agendou|marcou|reservou)|(?:tem|esta|ta)\s+(?:agendado|marcado|reservado))\s+(?:para|pro|pra)\s+(.+)$/i);
  if (calendarPersonMatch) {
    const targetName = calendarPersonMatch[1].trim();
    const timezone = botConfig?.integrations?.googleCalendar?.timezone
      || botConfig?.business?.hoursConfig?.timezone
      || botConfig?.business?.timezone
      || 'America/Sao_Paulo';
    const today = todayInTimezone(now(), timezone);
    const calendarRes = await executeToolCall('gerenciar_agenda_google', {
      action: 'listar_eventos',
      date: today,
      query: targetName
    }, { clientName: owner, botConfig });
    const targetNormalized = normalize(targetName);
    const internalMatches = (reminderStore?.listActive?.() || []).filter(item =>
      normalize([item.clientName, item.text].filter(Boolean).join(' ')).includes(targetNormalized)
    );

    const output = [`🔎 *Consulta de agendamentos para ${targetName}:*`];
    if (calendarRes?.success) {
      const events = Array.isArray(calendarRes.events) ? calendarRes.events : [];
      output.push('', '*Google Agenda:*');
      output.push(events.length
        ? events.slice(0, 12).map((event, index) => `${index + 1}. ${formatCalendarEvent(event, timezone)}`).join('\n')
        : 'Não encontrei eventos com esse nome a partir de hoje.');
    } else {
      output.push('', `*Google Agenda:* Não consegui consultar a agenda (${calendarRes?.message || calendarRes?.error || 'integração indisponível'}). Não posso afirmar que não há compromisso.`);
    }
    output.push('', '*Lembretes internos pendentes:*');
    output.push(internalMatches.length
      ? internalMatches.slice(0, 12).map((item, index) => {
          const due = new Date(item.dueAt);
          const when = Number.isFinite(due.getTime())
            ? new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(due)
            : 'data não informada';
          return `${index + 1}. ${item.text} — ${when}`;
        }).join('\n')
      : 'Nenhum lembrete interno pendente corresponde a esse nome.');
    return recordSelfTurn(filterReply(output.join('\n'), { isCopilot: true }).text);
  }

  // Confirmação curta após uma alegação de agendamento: valida as duas fontes reais
  // e nunca repete como fato uma confirmação apenas redigida pela IA.
  const reminderConfirmation = findRecentOwnerReminderConfirmation(sSelf?.history, norm);
  if (reminderConfirmation) {
    const timezone = botConfig?.integrations?.googleCalendar?.timezone
      || botConfig?.business?.hoursConfig?.timezone
      || botConfig?.business?.timezone
      || 'America/Sao_Paulo';
    const today = todayInTimezone(now(), timezone);
    const calendarRes = await executeToolCall('gerenciar_agenda_google', {
      action: 'listar_eventos',
      date: today,
      query: reminderConfirmation.subject
    }, { clientName: owner, botConfig });
    const subjectTokens = normalize(reminderConfirmation.subject)
      .split(' ')
      .filter(token => token.length >= 4 && !['lembrete', 'retorno', 'agendar', 'agendado', 'amanha', 'hoje'].includes(token));
    const internalMatches = (reminderStore?.listActive?.() || []).filter(item => {
      const text = normalize(item.text || '');
      const matches = subjectTokens.filter(token => text.includes(token)).length;
      return subjectTokens.length > 0 && matches >= Math.min(2, subjectTokens.length);
    });
    const output = ['🔎 *Confirmação do agendamento:*'];
    if (calendarRes?.success) {
      const events = Array.isArray(calendarRes.events) ? calendarRes.events : [];
      output.push('', '*Google Agenda:*');
      output.push(events.length
        ? events.slice(0, 8).map((event, index) => `${index + 1}. ${formatCalendarEvent(event, timezone)}`).join('\n')
        : 'Não encontrei esse assunto na Google Agenda a partir de hoje.');
    } else {
      output.push('', `*Google Agenda:* Não consegui verificar agora (${calendarRes?.message || calendarRes?.error || 'integração indisponível'}). Ainda não posso confirmar o evento.`);
    }
    output.push('', '*Lembretes internos:*');
    output.push(internalMatches.length
      ? internalMatches.slice(0, 8).map((item, index) => {
          const due = new Date(item.dueAt);
          const when = Number.isFinite(due.getTime())
            ? new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(due)
            : 'data não informada';
          return `${index + 1}. ${item.text} — ${when}`;
        }).join('\n')
      : 'Nenhum registro interno pendente corresponde ao assunto.');
    if ((!calendarRes?.success || !(calendarRes.events || []).length) && internalMatches.length) {
      output.push('', '_Encontrei um registro interno, mas isso não comprova que exista um evento na Google Agenda._');
    } else if (calendarRes?.success && !(calendarRes.events || []).length && !internalMatches.length) {
      output.push('', '_Não encontrei um registro nas fontes consultadas; portanto, não vou afirmar que o agendamento está confirmado._');
    }
    return recordSelfTurn(filterReply(output.join('\n'), { isCopilot: true }).text);
  }

  // 1.0.7 Atalho Direto: Teste e Consulta Rápida do Google Agenda (apenas se não for pedido de agendar/criar/cancelar evento)
  const isCalendarCreateOrEdit = /(?:marcar|marque|agendar|agende|criar|crie|adicionar|adicione|cancelar|cancele|remarcar|remarque)\b/i.test(norm);
  if (!isCalendarCreateOrEdit && /(?:google agenda|minha agenda|horarios livres|horários livres|test(?:e)? da agenda|teste.*agenda|comunica[cç][aã]o com.*agenda|^agenda$)\b/i.test(norm)) {
    const dateHintMatch = strippedCmd.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|amanh[aã]|hoje)\b/i);
    const calRes = await executeToolCall('gerenciar_agenda_google', {
      action: 'consultar_livres',
      ...(dateHintMatch ? { date: dateHintMatch[1] } : {})
    }, { clientName: owner, botConfig });
    const calStatus = calRes?.mocked
      ? '🟡 Simulação — agenda real não consultada'
      : calRes?.success ? '🟢 Integrada e consultada' : '🔴 Indisponível';
    const slots = calRes?.success && Array.isArray(calRes.availableSlots) ? calRes.availableSlots.join(', ') : 'Nenhum horário confirmado';
    const slotsLabel = calRes?.mocked ? 'Horários Simulados (não confirmados)' : 'Horários Livres Confirmados';
    const calMsg = `📅 *Google Agenda / Compromissos:*\n\n${calRes?.message || 'Não foi possível consultar o Google Calendar.'}\n• *Status:* ${calStatus}\n• *${slotsLabel}:* ${slots}`;
    return recordSelfTurn(filterReply(calMsg, { isCopilot: true }).text);
  }

  // 1.0.7.5 Atalho Direto: Consulta de Atendimento / Contato por Telefone
  const isCnpjOrCep = /\b(?:cnpj|cep|cpf)\b/i.test(norm);
  const isDispatchCmd = /\b(?:enviar|envie|mandar|mande|avisar|avise|disparar|dispare|mensagem\s+para)\b/i.test(norm);
  const hasPendingDispatchFlow = Boolean(sSelf?.pendingRecipient || sSelf?.pendingCopilotTask?.type === 'dispatch');
  const phoneLookupDigits = strippedCmd.match(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}\b/)?.[0]?.replace(/\D/g, '') || '';
  const hasLookupVerb = /\b(?:consulte|consultar|consulta|atendimento|historico|hist[oó]rico|conversa|cliente|contato|lead|detalhes?|resumo\s+d[eo]|sobre\s+o?\s*(?:numero|n[uú]mero|atendimento|cliente|contato))\b/i.test(norm);
  const isBarePhoneLookup = !hasPendingDispatchFlow && /^\s*(?:\+?55)?\d{8,13}\s*$/.test(strippedCmd);
  if (!isCnpjOrCep && !isDispatchCmd && phoneLookupDigits.length >= 8 && phoneLookupDigits.length <= 13 && (hasLookupVerb || isBarePhoneLookup)) {
    const contactRes = await executeToolCall('consultar_contato_ou_lead', { phone: phoneLookupDigits }, { store });
    if (!contactRes?.found) {
      return recordSelfTurn(filterReply(`🔎 Não encontrei nenhum atendimento ou cadastro registrado para *${phoneLookupDigits}*.`, { isCopilot: true }).text);
    }
    const fmtBr = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
    };
    const att = contactRes.attendance;
    const lines = [
      `📋 *Consulta de Atendimento — ${contactRes.name || 'Cliente'}*`,
      '',
      `• *Telefone:* \`${contactRes.phone}\``,
      `• *Estágio/Tipo:* ${contactRes.type || 'lead'}`,
      att ? `• *Status:* ${att.statusLabel}` : '• *Status:* Sem sessão ativa recente',
      att ? `• *Mensagens na sessão:* ${att.messageCount}` : '',
      att?.updatedAt ? `• *Última atividade:* ${fmtBr(att.updatedAt)} (BRT)` : '',
      contactRes.notes && contactRes.notes !== 'Sem observações adicionais.' ? `• *Notas:* ${contactRes.notes}` : ''
    ].filter(Boolean);

    if (att?.recentMessages?.length) {
      lines.push('', '*💬 Últimas mensagens do atendimento:*');
      for (const m of att.recentMessages.slice(-6)) {
        const who = m.role === 'lia' ? assistant : (m.role === 'humano' ? 'Humano' : 'Cliente');
        const ts = m.createdAt ? ` (${fmtBr(m.createdAt)})` : '';
        lines.push(`• *${who}${ts}:* ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 220)}`);
      }
    } else {
      lines.push('', '_Cadastro encontrado no CRM, sem mensagens registradas na sessão atual._');
    }
    return recordSelfTurn(filterReply(lines.join('\n'), { isCopilot: true }).text);
  }

  // 1.0.8 Documentos em PDF: SEMPRE pergunta quais informações usar antes de gerar
  const pdfDocMatch = norm.match(/(gerar|criar|emitir|fazer|montar|preparar)\s+(?:um\s+|uma\s+)?(relat[oó]rio|proposta|or[cç]amento|recibo|declara[cç][ãa]o|pdf)|((?:relat[oó]rio|proposta|or[cç]amento|recibo|declara[cç][ãa]o))\s+em\s+pdf/);
  if (pdfDocMatch) {
    const palavra = pdfDocMatch[2] || pdfDocMatch[3] || pdfDocMatch[1];
    const tipoInfo = PDF_TYPES.find(t => palavra && (t.label === palavra || t.key === palavra)) || PDF_TYPES.find(t => t.key === 'relatorio');
    const tipo = tipoInfo.key;
    const tipoTitulo = { relatorio: 'Relatório Executivo', orcamento: 'Orçamento', proposta: 'Proposta Comercial', recibo: 'Recibo', declaracao: 'Declaração' }[tipo];
    const titulo = `${tipoTitulo} • ${assistant}`;

    // Já veio conteúdo no pedido? (texto longo com números/valores além do comando)
    const bodyText = strippedCmd
      .replace(new RegExp(`^.*?(?:gerar|criar|emitir|fazer|montar|preparar)\\s+(?:um\\s+|uma\\s+)?(?:${palavra})\\b`, 'i'), '')
      .replace(/^\s*(?:em\s+pdf|agora|por favor|pra mim|para mim)\s*/i, '')
      .trim();
    const temConteudo = bodyText.length >= 40 && (/\d|R\$/i.test(bodyText));

    if (temConteudo) {
      const pdfRes = await executeToolCall('gerar_documento_pdf', {
        tipo, titulo, destinatario: ownerLabel, conteudo: bodyText
      }, { clientName: owner, botConfig, identity });
      const pdfPreview = await stageGeneratedPdf(pdfRes);
      return recordSelfTurn(filterReply(pdfPreview, { isCopilot: true }).text);
    }

    sSelf.pendingPdf = { tipo, titulo, destinatario: ownerLabel, label: tipoInfo.label, labelLabel: tipoTitulo };
    store.markDirty();
    const perguntas = {
      relatorio: `Claro, ${owner}! Antes de gerar o *relatório em PDF*, me diga quais informações ele deve ter.\n\n• Digite *dados do sistema* - eu monto com o raio-X em tempo real (IA, WhatsApp, atendimentos, lembretes)\n• Ou descreva o conteúdo: período, assunto, números e o que deve constar`,
      orcamento: `Perfeito, ${owner}! Para o *orçamento em PDF* ficar completo, me informe:\n\n• *Serviço/produto* e descrição dos itens\n• *Quantidades* e *valores* de cada item (ou valor total)\n• *Prazo* de entrega/vigência\n• *Cliente* e observações, se houver`,
      proposta: `Perfeito, ${owner}! Para a *proposta em PDF* ficar completa, me informe:\n\n• *Cliente* e escopo da proposta\n• *Itens/fases* com valores, se houver\n• *Prazo* e *condições* (pagamento, validade)\n• Alguma observação importante`,
      recibo: `Ok, ${owner}! Para o *recibo em PDF* me informe:\n\n• *Quem pagou* e o que foi pago\n• *Valor* e forma de pagamento\n• *Data* do pagamento`,
      declaracao: `Ok, ${owner}! Para a *declaração em PDF* me informe:\n\n• *Sobre o que* é a declaração\n• *Quem declara* e *quem recebe*\n• Fatos, datas e valores envolvidos`
    };
    return recordSelfTurn(filterReply(perguntas[tipo], { isCopilot: true }).text);
  }

  // 1.1 Ajuda e Comandos Internos
  if (/^(?:ajuda|comandos|comando|help|menu)\b/i.test(norm)) {
    const helpMsg = `🚀 *Painel de Controles & Comandos da ${assistant}*

Olá, *${owner}*! Aqui estão todos os controles e testes operacionais em tempo real:

📊 *Telemetria, Desempenho & Consumo:*
• *status* - Raio-X do sistema: conexão, sessões e modelo ativo
• *metricas* ou *consumo* - Requisições, tokens consumidos e taxa de sucesso
• *ping* ou *teste* - Mede a latência real de resposta da IA em milissegundos
• *relatorio* - Gera um relatório em PDF (digite *dados do sistema* para usar o raio-X atual)

⚡ *Controle Geral do Bot:*
• *bot off* ou *pausar bot* - Desativa a ${assistant} globalmente (modo 100% humano)
• *bot on* ou *ativar bot* - Reativa a ${assistant} globalmente para todos os contatos
• *expediente* - Consulta o status da Janela de Atendimento atual

👥 *Gestão por Contato Específico:*
• *fila* ou *espera* - Contatos aguardando sua resposta com link direto
• *bot [número]* - Reativa a ${assistant} para atender um contato específico
• *humano [número]* - Pausa a ${assistant} para você assumir o contato manual
• *limpar [número]* - Reseta o histórico de conversa com o contato

⏰ *Organização Pessoal:*
• *lembretes* - Seus compromissos e tarefas agendadas pendentes
• Converse em linguagem natural: _"me lembra amanhã às 9h de..."_

📅 *Google Agenda & Infraestrutura:*
• *agenda* ou *livres* - Consulta horários disponíveis no Google Agenda
• *infra* ou *servidores* - Diagnóstico completo de saúde das máquinas e instâncias
• *capacidades* ou *ferramentas* - Visão completa de tudo o que eu sou capaz de fazer
• *gerar pdf* - Testa e emite um documento oficial em PDF gerado pelo pdfme`;
    return recordSelfTurn(filterReply(helpMsg, { isCopilot: true }).text);
  }

  // 1.1.5 Controle Global do Bot (Ativar / Desativar Bot Geral)
  if (/^(?:bot\s+(?:off|desativar|pausar|stop)|pausar\s+bot|desativar\s+bot)\b/i.test(strippedCmd)) {
    botConfig.behavior = botConfig.behavior || {};
    botConfig.behavior.globalBotDisabled = true;
    const rep = `🛑 *${assistant} Desativada Globalmente!*\n\nA IA foi pausada para *todas as novas mensagens*. Todos os contatos que enviarem mensagem agora ficarão na fila de atendimento humano aguardando você.\n\nPara reativar a qualquer momento, digite *bot on*.`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  if (/^(?:bot\s+(?:on|ativar|ligar|start)|ativar\s+bot|ligar\s+bot)\b/i.test(strippedCmd)) {
    botConfig.behavior = botConfig.behavior || {};
    botConfig.behavior.globalBotDisabled = false;
    const rep = `🟢 *${assistant} Reativada Globalmente!*\n\nA IA voltou a atender automaticamente todas as conversas e contatos no WhatsApp.`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  // 1.1.6 Teste de Desempenho & Latência em Tempo Real (Ping)
  if (/^(?:ping|teste|latencia|latência|teste de conexao|teste de conexão)\b/i.test(norm)) {
    const t0 = Date.now();
    const testRes = await ai?.askAI?.({
      system: 'Responda apenas: PONG OPERACIONAL',
      history: [],
      userText: 'PING',
      botConfig
    });
    const lat = Date.now() - t0;
    const modelUsed = testRes?.model || botConfig?.ai?.activeModel || 'gemini-3.8-flash';
    const rep = `⚡ *Teste de Latência & Desempenho:*
• *Status:* 🟢 Operacional
• *Latência Real:* *${lat} ms*
• *Modelo Testado:* \`${modelUsed}\`
• *Provedor:* Google Gemini API (Online)`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  // 1.1.7 Relatório de Consumo & Tokens
  if (/^(?:metricas|métricas|consumo|tokens|uso de ia|gasto)\b/i.test(norm)) {
    const m = getMetricsSummary?.() || {};
    const ov = m.overview || {};
    const rep = `📊 *Relatório de Consumo & Performance de IA:*

📈 *Requisições:*
• *Total de Chamadas:* ${ov.totalRequests || 0}
• *Sucesso:* ${ov.successfulRequests || 0} (${ov.successRate || 100}%)
• *Falhas:* ${ov.failedRequests || 0}

⏱️ *Latência:*
• *Média:* ${ov.avgLatencyMs || 0} ms
• *Última:* ${ov.lastLatencyMs || 0} ms
• *P95:* ${ov.p95LatencyMs || 0} ms

🔢 *Consumo de Tokens:*
• *Prompt:* ${(ov.totalPromptTokens || 0).toLocaleString('pt-BR')} tokens
• *Resposta:* ${(ov.totalCompletionTokens || 0).toLocaleString('pt-BR')} tokens
• *Total Geral:* ${(ov.totalTokens || 0).toLocaleString('pt-BR')} tokens

_Tempo ativo: ${Math.round((m.uptimeSeconds || 0) / 3600)} horas_`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  // 1.1.8 Relatório Executivo do Dia
  if (norm.split(/\s+/).length <= 5 && /^(?:relatorio|relatório|resumo do dia|fechamento)\b/i.test(norm)) {
    const sessionsArr = Object.values(store.sessions);
    const totalConvs = sessionsArr.filter(s => s.phone && s.phone !== OWNER_SELF_KEY && !s.isInternalChat).length;
    const activeConvs = sessionsArr.filter(s => !s.inactivityClosed && (s.history?.length || 0) > 0 && s.phone !== OWNER_SELF_KEY).length;
    const humanConvs = sessionsArr.filter(s => isHumanHandoffActive(s) && !s.inactivityClosed && s.phone !== OWNER_SELF_KEY).length;
    const rep = `📋 *Relatório Executivo de Atendimentos:*

👥 *Volume de Contatos:*
• *Total de Contatos na Base:* ${totalConvs}
• *Atendimentos Ativos:* ${activeConvs}
• *Aguardando Atendimento Humano:* ${humanConvs}
• *Atendidos 100% por IA:* ${Math.max(0, activeConvs - humanConvs)}

🎯 *Setores Mais Procurados:*
• Comercial & Planos
• Suporte & Dúvidas

💡 _Digite *fila* para inspecionar os contatos que esperam resposta._`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  // 1.1.9 Consulta do Expediente / Janela de Atendimento
  if (norm.split(/\s+/).length <= 5 && /^(?:expediente|horario|horário|janela)\b/i.test(norm)) {
    const hoursCfg = botConfig?.business?.hoursConfig || null;
    if (!hoursCfg || !hoursCfg.enabled) {
      return recordSelfTurn(filterReply(`🕒 *Expediente de Atendimento:*\n\n🟢 *Status:* Atendimento 24 Horas (Sem restrição de horário).`, { isCopilot: true }).text);
    }
    const aval = avaliarJanelaDeAtendimento(hoursCfg, new Date(now()));
    const statusStr = aval.isOpen ? '🟢 ABERTO (Em Horário de Atendimento)' : '🌙 FECHADO (Fora do Horário Comercial)';
    const timeZone = hoursCfg.timezone || 'America/Sao_Paulo';
    const rep = `🕒 *Expediente de Atendimento:*

• *Status Atual:* ${statusStr}
• *Horário:* ${hoursCfg.start} às ${hoursCfg.end}
• *Fuso:* ${timeZone}
• *Próxima Abertura:* ${aval.proximaAberturaISO ? new Date(aval.proximaAberturaISO).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone }) : 'Já aberto'}
• *Aviso Automático:* ${hoursCfg.enabled ? 'Ativo (1x por noite)' : 'Desativado'}`;
    return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
  }

  // 1.2 Status e Diagnóstico Operacional
  if (norm.split(/\s+/).length <= 5 && /^(?:status|resumo|painel|diagnostico|como estamos\??|como estao as coisas\??)\b/i.test(norm)) {
    const sessionsArr = Object.values(store.sessions);
    const activeCount = sessionsArr.filter(s => !s.inactivityClosed && (s.history?.length || 0) > 0).length;
    const humanWaiting = sessionsArr.filter(s => isHumanHandoffActive(s) && !s.inactivityClosed && s.phone);
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
  const isFilaQuery = /(?:fila|\b(?:em|na)\s+espera\b|transbordos?)\b/i.test(norm) ||
    /^(?:espera|aguardando|esperando|pendentes?)$/i.test(norm) ||
    /(?:quem|quais|quantos|tem\s+algu[eé]m|h[aá]\s+algu[eé]m|algu[eé]m|contatos?|clientes?|atendimentos?)\b.*\b(?:espera|esperando|aguardando|fila|pendentes?)\b/i.test(norm) ||
    /^lista(?:\s+completa|\s+(?:da\s+fila|de\s+(?:espera|aguardando|pendentes?|contatos|clientes)))?$/i.test(norm);
  if (isFilaQuery && !/(?:habilidade|capacidade|ferramenta|agenda|infra|dokku|servidor|quem [ée] voc[êe]|quem e vc|o que voc[êe]|quem [ée] voc|quem e você)/i.test(norm)) {
    const waiting = getWaitingList();
    if (!waiting.length) {
      const emptyMsg = `✨ *Fila de Atendimento Zerada!*

${owner}, não há nenhum contato aguardando retorno no momento! Todos os atendimentos estão em dia. 👍`;
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

    const filaMsg = `👥 *Contatos aguardando sua resposta (${waiting.length}):*\n\n${lines}\n\n💡 *Para devolver o atendimento para a ${assistant}:*\nResponda *bot [número da lista]* (ex: *bot 1*), *bot [telefone]* ou *bot [nome]*.`;
    return recordSelfTurn(filterReply(filaMsg, { isCopilot: true }).text);
  }

  // 1.4 Comando: Reativar Bot para um número, índice ou nome
  const botMatch = strippedCmd.match(/^(?:bot|reativar|ativar)\b\s*(.*)$/i);
  if (botMatch) {
    const targetArg = botMatch[1].trim();
    if (!targetArg) {
      sSelf.pendingControlAction = { type: 'contact_target', intent: 'resume_bot', createdAt: new Date(now()).toISOString() };
      store.markDirty();
      return recordSelfTurn(filterReply(`🤖 *Como reativar o bot:*\n\nInforme qual contato deseja devolver para a ${assistant}. Exemplos:\n• *bot 1* (reativa o 1º da fila de espera)\n• *bot 5588993602644* (reativa pelo telefone)\n• *bot Mikaelle* (reativa pelo nome do contato)\n\nDigite *fila* para ver os contatos em espera.`, { isCopilot: true }).text);
    }
    const sTarget = findSessionByTarget(targetArg);
    if (!sTarget) {
      return recordSelfTurn(filterReply(`⚠️ *Contato não localizado!*\n\nNão encontrei nenhuma conversa correspondente a *"${targetArg}"*. Digite *fila* para ver quem está aguardando ou confira o número informado.`, { isCopilot: true }).text);
    }
    const wasHuman = isHumanHandoffActive(sTarget);
    resumeHumanHandoff(sTarget, {
      source: null,
      clearHandoffAt: true,
      clearReminderAt: true,
      clearNotifications: true,
      clearReminderFlags: true
    });
    sTarget.inactivityClosed = false;
    sTarget.updatedAt = new Date(now()).toISOString();
    store.markDirty();
    try {
      await store.flush?.();
    } catch (err) {
      logger.error?.('[flow] Falha ao persistir comando bot:', err.message);
      return recordSelfTurn(filterReply(`⚠️ *Não consegui confirmar a reativação de ${sTarget.clientName || sTarget.phone} no banco de dados.*\n\nA alteração foi aplicada localmente, mas precisa ser sincronizada novamente.`, { isCopilot: true }).text);
    }
    const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
    const targetPhone = String(sTarget.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    const rep = `🤖 *Bot reativado com sucesso!*\n\nA ${assistant} voltou a atender *${targetName}* (${targetPhone}) automaticamente.`;
    const continuityNotice = wasHuman
      ? notifyReactivationToInternalChat({ store, session: sTarget, phone: targetPhone })
      : null;
    const fullRep = continuityNotice?.message ? `${rep}\n\n${continuityNotice.message}` : rep;
    return recordSelfTurn(filterReply(fullRep, { isCopilot: true }).text);
  }

  // 1.5 Comando: Pausar Bot / Atendimento Humano para um número, índice ou nome
  const humanMatch = strippedCmd.match(/^(?:humano|pausar|assumir)\b\s*(.*)$/i);
  if (humanMatch) {
    const targetArg = humanMatch[1].trim();
    if (!targetArg) {
      sSelf.pendingControlAction = { type: 'contact_target', intent: 'activate_human', createdAt: new Date(now()).toISOString() };
      store.markDirty();
      return recordSelfTurn(filterReply(`👤 *Como assumir atendimento:*\n\nInforme qual contato deseja pausar o bot. Exemplos:\n• *humano 1* (primeiro da lista)\n• *humano 5588993602644* (pelo telefone)\n• *humano Mikaelle* (pelo nome)`, { isCopilot: true }).text);
    }
    const sTarget = findSessionByTarget(targetArg);
    if (!sTarget) {
      return recordSelfTurn(filterReply(`⚠️ *Contato não localizado!*\n\nNão encontrei nenhuma conversa correspondente a *"${targetArg}"*.`, { isCopilot: true }).text);
    }
    const takeoverAt = new Date(now()).toISOString();
    enterHumanHandoff(sTarget, {
      source: 'admin',
      at: takeoverAt,
      reason: `pausado via comando de ${owner}`
    });
    sTarget.takeoverAt = takeoverAt;
    sTarget.handoffReminderAt = null;
    sTarget.inactivityClosed = false;
    sTarget.updatedAt = new Date(now()).toISOString();
    store.markDirty();
    await store.flush?.();
    const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
    const targetPhone = String(sTarget.phone || '').replace(/@.*$/, '').replace(/\D/g, '');
    const rep = `👤 *Atendimento humano ativado!*\n\nA ${assistant} foi pausada para *${targetName}* (${targetPhone}). O contato agora aguarda sua resposta manual.`;
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
    const targetName = sTarget.clientName || sTarget.contactName || sTarget.pushName || 'Contato';
    sSelf.pendingControlAction = {
      type: 'clear_history',
      target: targetArg,
      label: targetName,
      createdAt: new Date(now()).toISOString()
    };
    store.markDirty();
    return recordSelfTurn(filterReply(`⚠️ *Confirmação necessária*\n\nVocê quer realmente limpar o histórico e o estado de *${targetName}*? Essa ação não pode ser desfeita.\n\nResponda *sim* para confirmar ou *não* para cancelar.`, { isCopilot: true }).text);
  }

  // Consulta geral determinística: reconhece contagem, lista e perguntas abertas
  // em linguagem natural, sem depender do LLM nem de uma frase exata.
  const reminderNoun = /\b(?:lembretes?|tarefas?|retornos?|agendamentos?|afendamentos?|compromissos?|eventos?)\b/i;
  const countReminderQuery = reminderNoun.test(norm)
    && /\b(?:quantos?|quantas?|quantidade|contagem|conte|qtd|numero de)\b/i.test(norm);
  const listReminderQuery = (
    reminderNoun.test(norm) && /\b(?:liste|listar|lista|listagem|mostre|mostrar|ver|veja|consultar|consulta|quais|meus|minhas|tem|ha|existe)\b/i.test(norm)
  ) || /\b(?:o que|que)\s+(?:eu\s+)?(?:tem|ha|esta|ta|ficou)\s+(?:agendad[oa]s?|marcad[oa]s?|reservad[oa]s?)\b/i.test(norm)
    || /\btem\s+(?:algo|algum|alguma|o que)\s+(?:agendad[oa]|marcad[oa]|reservad[oa])\b/i.test(norm);
  if (countReminderQuery || listReminderQuery) {
    const tz = botConfig?.integrations?.googleCalendar?.timezone
      || botConfig?.business?.hoursConfig?.timezone
      || botConfig?.business?.timezone
      || 'America/Sao_Paulo';
    const today = todayInTimezone(now(), tz);
    const calendarRes = await executeToolCall('gerenciar_agenda_google', {
      action: 'listar_eventos',
      date: today
    }, { clientName: owner, botConfig });
    const list = reminderStore?.listActive?.() || [];
    if (countReminderQuery) {
      const sections = ['🔢 *Contagem de compromissos e lembretes pendentes:*'];
      if (calendarRes?.success) {
        const events = Array.isArray(calendarRes.events) ? calendarRes.events : [];
        sections.push(`• *Google Agenda:* ${events.length} evento(s) a partir de hoje.`);
      } else {
        sections.push(`• *Google Agenda:* não foi possível consultar (${calendarRes?.message || calendarRes?.error || 'integração indisponível'}). Não vou estimar essa quantidade.`);
      }
      sections.push(`• *Lembretes internos:* ${list.length} pendente(s).`);
      return recordSelfTurn(filterReply(sections.join('\n'), { isCopilot: true }).text);
    }

    const sections = ['📋 *Agenda e lembretes pendentes:*', '', '*Google Agenda:*'];
    if (calendarRes?.success) {
      const events = Array.isArray(calendarRes.events) ? calendarRes.events : [];
      sections.push(events.length
        ? events.slice(0, 15).map((event, index) => `${index + 1}. ${formatCalendarEvent(event, tz)}`).join('\n')
        : 'Nenhum evento encontrado a partir de hoje.');
    } else {
      sections.push(`Não consegui consultar o Google Agenda: ${calendarRes?.message || calendarRes?.error || 'integração indisponível'}. Não posso confirmar que a agenda está vazia.`);
    }
    sections.push('', `*Lembretes internos pendentes (${list.length}):*`);
    if (list.length) {
      sections.push(list.slice(0, 15).map((item, index) => {
        const due = new Date(item.dueAt);
        const dueText = Number.isFinite(due.getTime())
          ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(due)
          : 'data não informada';
        return `${index + 1}. *${item.text}* — ${dueText}${item.clientName ? ` (Contato: ${item.clientName})` : ''}`;
      }).join('\n'));
    } else {
      sections.push('Nenhum lembrete interno pendente.');
    }
    return recordSelfTurn(filterReply(sections.join('\n'), { isCopilot: true }).text);
  }

  return null;
}
