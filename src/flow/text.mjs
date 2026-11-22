import { normalize } from '../safety.mjs';
import { resolveIdentity, escapeRegExp, isTalkToOwnerRequest } from '../core/identity.mjs';
export { isTalkToOwnerRequest };


export function collectedValid(collected = {}) {
  const result = { ...collected };
  if (result.tutorName) {
    const raw = String(result.tutorName).trim();
    const normalized = normalize(raw);
    const invalidNames = new Set(['dono', 'ola', 'oi', 'tutor', 'proprietario', 'cliente', 'atendente', 'humano', 'nao', 'sim']);
    if (invalidNames.has(normalized) || raw.length < 2) {
      delete result.tutorName;
    }
  }
  return result;
}

export function isHumanRequest(text = '', identity = {}) {
  const raw = String(text || '');
  const n = normalize(raw);
  if (!n) return false;

  if (/^(?:humano|atendente|pessoa)$/.test(n)) return true;
  if (/\b(?:quero|preciso|gostaria|pode|poderia|falar|chamar|conversar)\b.{0,40}\b(?:pessoalmente|presencialmente)\b/.test(n)) return true;

  // Dúvida de preço continua sendo dúvida, não pedido de transferência.
  if (/\bquanto\s+custa\b/.test(n)) return false;

  // Exige verbo de pedido + alvo: substantivo isolado ("o atendente já me respondeu")
  // não pode disparar handoff.
  const verbs = '(?:falar|chamar|chame|chama|quero|queria|preciso|gostaria|pode|poderia|conversar|conversa|passa|passar|transfere|transferir|encaminha|encaminhar|conecta|conectar|avisa|avisar)';
  const connectors = '(?:para\\s+|pra\\s+|pro\\s+|ao\\s+)?(?:com\\s+)?(?:o\\s+|a\\s+|um[a]?\\s+)?';
  const targets = '(?:atendentes?|humanos?|pessoas?|atendimento|responsaveis?|equipe|suporte|dono|diretoria|diretor)';
  if (new RegExp(`${verbs}\\s+${connectors}${targets}\\b`, 'i').test(n)) return true;
  if (new RegExp(`\\b(?:falar|chamar|quero|preciso|gostaria)\\s+(?:com\\s+)?(?:a\\s+|o\\s+)?(?:dra|dr|doutora|doutor)\\.?\\s+\\w+`, 'i').test(n)) return true;

  return isTalkToOwnerRequest(raw, identity);
}

/**
 * Identifica se o usuário pediu especificamente a opção de "Atendimento"
 */
export function isAtendimentoOption(text = '') {
  const n = normalize(text);
  return /^(?:1|opcao 1|opção 1|atendimento|atendimento automatico|quero atendimento)$/i.test(n);
}

/**
 * Limpa texto para leitura de voz natural (sem markdown, links brutos, aspas soltas ou emojis excessivos)
 */
export function cleanForSpeech(text = '') {
  let s = String(text || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^>\s*/gm, '')
    .replace(/["“”«»]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/^[•\-\+]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/:\s*,\s*/g, ': ')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (s.length > 1200) {
    s = s.slice(0, 1150).replace(/\.[^.]*$/, '') + '.';
  }
  return s;
}

/** Escapa um nome para uso seguro dentro de RegExp. */
export function escapeText(value = '') {
  return escapeRegExp(value);
}

/** Remove a menção ao nome da assistente no início da frase. */
export function stripBotMention(text = '', botName = 'Lia') {
  const name = escapeText(botName);
  return String(text || '').replace(new RegExp(`^[@/]?${name}[\\s,:-]*`, 'i'), '').trim();
}

/**
 * Remove qualquer comando residual de pedido de envio ("envie um áudio pro Lima informando sobre...", "envie um audio e diga ao lima que...", etc.)
 * tanto no início quanto no meio da frase.
 */
export function stripCommandPrefix(rawText = '', recipient = '', { botName = 'Lia' } = {}) {
  let s = String(rawText || '').replace(/["“”«»]/g, ' ').trim();
  const recEscaped = recipient ? escapeText(recipient) : '';
  const botPrefix = `^[@/]?${escapeText(botName)}[\\s,:-]*`;

  // 0. Remove menção à assistente e cumprimentos/prefixos conversacionais no início
  s = s
    .replace(new RegExp(botPrefix, 'i'), '')
    .replace(/^(?:perfeito|certo|ótimo|otimo|combinado|beleza|ok|show|maravilha|olha|então|entao|seguinte)[\s,!.-]+/i, '')
    .trim();

  // 1. Componentes de comandos
  const sendVerbs = '(?:envie|enviar|envia|mande|mandar|manda|dispare|disparar|dispara|grave|gravar|grava|solte|soltar|solta|passe|passar|passa)';
  const speechVerbs = '(?:diga|diz|fale|fala|avise|avisa|informe|informa|explique|explica|pe[cç]a|pede|lembre|lembra|pergunte|pergunta|cobre|cobra|notifique|notifica)';
  const modals = '(?:vou\\s+precisar\\s+que|preciso\\s+que|quero\\s+que|gostaria\\s+que|pode|poderia|favor|que)';
  const pronouns = '(?:voc[êe]|vc|c[êe])';
  const recPrep = '(?:para\\s+o|para\\s+a|para|pro|pra|ao|à)\\s+|o\\s+|a\\s+';
  const recTarget = recEscaped ? `(?:(?:${recPrep})?${recEscaped}\\b)` : `(?:${recPrep}[a-zA-ZÀ-ÿ0-9+]+\\b)`;
  const media = '(?:(?:(?:um|uma|o|a)\\s+)?(?:mensagem(?:\\s+de\\s+[aá]udio|\\s+de\\s+voz)?|msg|zap|[aá]udio|audio|voz|recado|texto)|(?:em|por)\\s+(?:[aá]udio|voz|texto))';
  const chatContext = '(?:\\s+(?:no\\s+chat\\s+interno|comigo|pra\\s+mim|para\\s+mim))?';
  const gerunds = '(?:informando|avisando|dizendo|falando|explicando|lembrando|pedindo|cobrando|confirmando|perguntando)';

  // Padrão 1: "vou precisar que vc mande um áudio e lembre o Lima sobre..." ou "envie um áudio pro Lima sobre..."
  const fullCmdPattern = new RegExp(`^${modals}?\\s*${pronouns}?\\s*(?:me\\s+)?${sendVerbs}\\s+${media}${chatContext}(?:\\s+e\\s+|\\s*,?\\s*)?${speechVerbs}?(?:\\s*${recTarget})?(?:\\s*${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|sobre\\b|de\\b|a\\s+respeito\\s+de\\b)?\\s*`, 'i');
  s = s.replace(fullCmdPattern, '').trim();

  // Padrão 2: "lembre o Lima sobre..." ou "avise o Lima que..." ou "mande um áudio pro Lima dizendo que..."
  const directCmdPattern = new RegExp(`^${speechVerbs}\\s*${recTarget}\\s*(?:${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|sobre\\b|de\\b|a\\s+respeito\\s+de\\b)?\\s*`, 'i');
  s = s.replace(directCmdPattern, '').trim();

  if (recEscaped) {
    const midRecCmdRe = new RegExp(`\\b(?:e\\s+)?${speechVerbs}?\\s*${media}\\s*(?:${recPrep})?${recEscaped}\\b\\s*(?:${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|sobre\\b|de\\b)?\\s*`, 'gi');
    s = s.replace(midRecCmdRe, '').trim();
  }

  // 2. Limpeza iterativa de prefixos no início
  for (let i = 0; i < 6; i++) {
    const prev = s;
    s = s
      .replace(new RegExp(botPrefix, 'i'), '')
      .replace(/^(?:perfeito|certo|ótimo|otimo|combinado|beleza|ok|show|maravilha|olha|então|entao|seguinte)[\s,!.-]+/i, '')
      .replace(/^(?:sim|ok|beleza|confirmo|pode mandar|pode enviar|manda|dispara|por favor|pfv)[\s,!.-]*/i, '')
      .replace(/^(?:e\s+|ent[ãa]o\s+|ai\s+|a[íi]\s+|depois\s+)/i, '')
      .replace(/^(?:no\s+chat\s+interno|comigo|pra\s+mim|para\s+mim)\b[\s,:-]*/i, '')
      .replace(new RegExp(`^(?:${modals})?\\s*(?:${pronouns})?\\s*(?:me\\s+)?(?:${sendVerbs}|fale com|falar com|${speechVerbs})\\b[\\s,:-]*`, 'i'), '')
      .replace(new RegExp(`^${media}\\b[\\s,:-]*`, 'i'), '')
      .replace(/^(?:em\s+[aá]udio|por\s+[aá]udio|como\s+[aá]udio|em\s+voz|por\s+voz|em\s+texto|por\s+texto)\b[\s,:-]*/i, '')
      .replace(new RegExp(`^(?:e\\s+)?(?:${gerunds}|${speechVerbs})\\b[\\s,:-]*`, 'i'), '')
      .replace(new RegExp(`^(?:para\\s+o|para\\s+a|para|pro|pra|ao|para\\s+ele|pra\\s+ele|para\\s+ela|pra\\s+ela)\\s+[a-zA-ZÀ-ÿ0-9+]+\\b[\\s,!.-]*`, 'i'), '')
      .replace(/^(?:para\s+ele|pra\s+ele|para\s+ela|pra\s+ela|a\s+ele|a\s+ela)\b[\s,!.-]*/i, '')
      .replace(/^(?:a\s+mensagem\s+[ée]|o\s+recado\s+[ée]|o\s+[aá]udio\s+[ée]|o\s+texto\s+[ée]|que\s+[ée])\s*/i, '')
      .replace(/^(?:apenas\s+que\s+[ée]|s[óo]\s+que\s+[ée]|apenas\s+que|s[óo]\s+que|apenas\s+|s[óo]\s+|que\s+|para\s+|pra\s+)\s*/i, '')
      .trim();

    if (recEscaped) {
      const recPrefixRe = new RegExp(`^(?:para\\s+o|para\\s+a|para|pro|pra|ao)?\\s*${recEscaped}\\b[\\s,:-]*`, 'i');
      s = s.replace(recPrefixRe, '').trim();
    }
    if (s === prev) break;
  }

  // Se o que restou for apenas uma indicação isolada de formato, comando ou modalidade, zera
  if (/^(?:um\s+|uma\s+)?(?:texto|áudio|audio|mensagem|recado|msg|voz)$/i.test(s) ||
      /^(?:em\s+|por\s+)?(?:texto|áudio|audio|voz)$/i.test(s) ||
      /^(?:quero\s+)?(?:em\s+|por\s+)?(?:texto|áudio|audio|voz)$/i.test(s) ||
      /^(?:enviar|envie|mandar|mande)\s+(?:um\s+|uma\s+)?(?:texto|áudio|audio|mensagem)$/i.test(s)) {
    return '';
  }

  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Transforma instruções ou comandos brutos em um roteiro ou mensagem natural, acolhedora e 100% humanizada como assistente.
 * NUNCA joga o pedido cru e NUNCA usa frases clichês robóticas como "Queria aproveitar para alinhar com você que".
 */
export function buildFriendlyAudioScript(recipient, rawMessage, { identity = {}, botName = '' } = {}) {
  const resolved = resolveIdentity(identity);
  const assistant = botName || resolved.botName;
  const rawRec = recipient && !/^\d+$/.test(String(recipient).replace(/\D/g, '')) && !/^você mesmo/i.test(String(recipient))
    ? String(recipient).trim()
    : '';
  const isPhoneRec = /^\d+$/.test(String(recipient || '').replace(/\D/g, ''));
  const recName = !isPhoneRec && rawRec && !/^(?:n[úu]mero|numero|telefone|contato|cliente)$/i.test(rawRec)
    ? rawRec.charAt(0).toUpperCase() + rawRec.slice(1)
    : '';
  let text = cleanForSpeech(rawMessage);

  // Remove qualquer autoapresentação repetitiva ou clichê robótico
  const assistantMention = escapeText(assistant);
  let rawCore = text
    .replace(new RegExp(`^oi(?:,\\s*[a-zA-ZÀ-ÿ0-9]+)?!\\s*(?:tudo bem\\?\\s*)?(?:aqui [ée] a ${assistantMention}(?:,\\s*assistente d[eo] [^.,!]+)?[.,!\\s]*)?`, 'i'), '')
    .replace(new RegExp(`^(?:ol[áa](?:,\\s*[a-zA-ZÀ-ÿ0-9]+)?!\\s*)?(?:aqui [ée] a ${assistantMention}(?:,\\s*assistente d[eo] [^.,!]+)?[.,!\\s]*)`, 'i'), '')
    .replace(new RegExp(`\\baqui [ée] a ${assistantMention}(?:,\\s*assistente d[eo] [^.,!]+)?[.,!\\s]*`, 'gi'), '')
    .replace(/^(?:estou\s+)?passando(?:\s+por\s+aqui)?(?:\s+a\s+pedido\s+(?:dele|dela|d[oa]\s+[a-zà-ÿ]+))?\s+para\s+(?:te\s+avisar\s+que|avisar\s+que|te\s+lembrar\s+que|te\s+informar\s+que|falarmos\s+sobre|alinharmos\s+sobre)\s*/i, '')
    .replace(/^queria\s+(?:aproveitar\s+para\s+)?alinhar\s+com\s+voc[êe]\s+que\s+(?:eu\s+)?/i, '')
    .replace(/^(?:quero\s+aproveitar\s+para\s+)?alinhar\s+com\s+voc[êe]\s+que\s+/i, '')
    .replace(/^(?:dar\s+um\s+toque|te\s+dar\s+um\s+toque|avisar|lembrar)\s+(?:que\b|sobre\b)?\s*/i, '')
    .trim();

  // Limpa comandos vazados na raiz do roteiro
  let body = stripCommandPrefix(rawCore, recName, { botName: assistant });

  // Se o texto é uma pergunta (ex: "se vai querer a proposta", "perguntando se vai comparecer")
  const isQuestion = /(?:pergunt|saber\s+se|se\s+vai|se\s+quer|se\s+ele|se\s+ela|quando\b|como\b|qual\b|onde\b|que\s+horas|quanto\b)/i.test(rawMessage) || /\?$/.test(body);

  // Se é pedido de envio de documento / ação do cliente
  const isActionRequest = /^(?:para\s+voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|(?:enviar|mandar|passar)\s+(?:o|a|os|as|seu|sua)?\s*(?:comprovante|documento|contrato|dados|chave|pix|nota|foto|arquivo|relat[óo]rio))/i.test(body);

  // Se é lembrete
  const isReminder = /(?:lembr(?:e|ar|ando)?|toque|aviso)\b/i.test(rawMessage);

  // Transforma pronomes de 3ª pessoa ("ele/ela") para 2ª pessoa ("você")
  body = body
    .replace(/\bse\s+ele\b/gi, 'se você')
    .replace(/\bse\s+ela\b/gi, 'se você')
    .replace(/\bque\s+ele\b/gi, 'que você')
    .replace(/\bque\s+ela\b/gi, 'que você')
    .replace(/\bele\s+vai\b/gi, 'você vai')
    .replace(/\bela\s+vai\b/gi, 'você vai')
    .replace(/\bele\s+quer\b/gi, 'você quer')
    .replace(/\bela\s+quer\b/gi, 'você quer')
    .replace(/\bele\s+precisa\b/gi, 'você precisa')
    .replace(/\bela\s+precisa\b/gi, 'você precisa')
    .replace(/\bele\s+deve\b/gi, 'você deve')
    .replace(/\bela\s+deve\b/gi, 'você deve')
    .replace(/\bele\s+pode\b/gi, 'você pode')
    .replace(/\bela\s+pode\b/gi, 'você pode')
    .replace(/\bele\s+est[áa]\b/gi, 'você está')
    .replace(/\bela\s+est[áa]\b/gi, 'você está')
    .replace(/\bpara\s+ele\b/gi, 'para você')
    .replace(/\bpra\s+ele\b/gi, 'pra você')
    .replace(/\bme\s+mandar\b/gi, 'nos enviar')
    .replace(/\bme\s+enviar\b/gi, 'nos enviar')
    .replace(/\bme\s+passar\b/gi, 'nos passar')
    .replace(/\bdele\b/gi, 'seu')
    .replace(/\bdela\b/gi, 'sua')
    .replace(/["“”«»]/g, '')
    .trim();

  const greeting = recName ? `Oi, ${recName}! Tudo bem?` : `Oi! Tudo bem?`;

  // Caso 1: Começa com "sobre <tópico>" ou "a respeito de <tópico>"
  if (/^(?:sobre|a respeito d[eo])\s+/i.test(body)) {
    const topic = body.replace(/^(?:sobre|a respeito d[eo])\s+/i, '').replace(/[.!?]+$/, '').trim();
    return `${greeting} Estou entrando em contato para alinharmos sobre ${topic}. Assim que puder, me dá um retorno por aqui, tá bom?`;
  }

  body = body.replace(/[.!?]+$/, '').trim();

  // Caso 2: Substantivo de tópico puro (ex: "o pagamento dos boletos", "o status operacional do sistema", "o código de rastreio")
  const looksLikeNounTopic = /^(?:o\s+|a\s+|os\s+|as\s+|um\s+|uma\s+)?(?:pagamento|boleto|boletos|fatura|nota|contrato|c[óo]digo|rastreio|site|sistema|projeto|proposta|or[cç]amento|reuni[ãa]o|entrega|cadastro|acesso|pix|valor|status|monitoramento|pixel|campanha|servi[cç]o)\b/i.test(body) &&
    !/\b(?:vai|foi|est[áa]|est[ãa]o|precisa|pode|deve|tem|ficou|chegou|saiu|vence|venceu|sera|ser[áa]|[ée])\b/i.test(body);

  if (looksLikeNounTopic) {
    let lowerTopic = body.charAt(0).toLowerCase() + body.slice(1);
    if (!/^(?:o|a|os|as|um|uma)\s+/i.test(lowerTopic)) {
      lowerTopic = 'o ' + lowerTopic;
    }
    return `${greeting} Estou entrando em contato para alinharmos sobre ${lowerTopic}. Assim que puder, me dá um retorno por aqui, tá bom?`;
  }

  // Caso 3: Lembrete / Toque sobre monitoramento, campanha, etc.
  if (isReminder) {
    let remTopic = body.replace(/^(?:o\s+|a\s+|os\s+|as\s+|sobre\s+o\s+|sobre\s+a\s+|sobre\s+|de\s+)/i, '').trim();
    remTopic = remTopic.charAt(0).toLowerCase() + remTopic.slice(1);
    return `${greeting} Passando para te dar um toque sobre ${remTopic}. Qualquer dúvida que tiver, estou por aqui!`;
  }

  // Caso 4: Humanização natural de instruções técnicas/tarefas
  if (/^voc[êe]\s+(?:vai\s+precisar|precisa|tem\s+que|deve)\s+/i.test(body)) {
    const action = body.replace(/^voc[êe]\s+(?:vai\s+precisar|precisa|tem\s+que|deve)\s+/i, '').trim();
    return `${greeting} Só para alinharmos os próximos passos, você vai precisar ${action}, combinado? Assim que concluir ou se tiver qualquer dúvida, é só me chamar por aqui!`;
  }

  if (/^(?:precisa|tem\s+que|deve|vai\s+precisar)\s+/i.test(body)) {
    const action = body.replace(/^(?:precisa|tem\s+que|deve|vai\s+precisar)\s+/i, '').trim();
    return `${greeting} Só para alinharmos os próximos passos, você vai precisar ${action}, combinado? Assim que concluir ou se tiver qualquer dúvida, é só me chamar por aqui!`;
  }

  // Caso 5: Pergunta / Sondagem de interesse
  if (isQuestion) {
    let qBody = body.replace(/^(?:se\s+|para\s+perguntar\s+se\s+|para\s+saber\s+se\s+|perguntando\s+se\s+)/i, '').trim();
    const lowerQ = qBody.charAt(0).toLowerCase() + qBody.slice(1);
    if (/^(?:quando|como|qual|quais|onde|que\s+horas|quanto)\b/i.test(lowerQ)) {
      return `${greeting} Passando para saber ${lowerQ}. Assim que puder, me avisa por aqui, tá bom?`;
    }
    return `${greeting} Passando para saber se ${lowerQ}. Se tiver alguma dúvida ou precisar de qualquer ajuste, estou por aqui, tá bom?`;
  }

  // Caso 6: Pedido de ação / envio de documento
  if (isActionRequest) {
    let aBody = body.replace(/^(?:para\s+voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|(?:enviar|mandar|passar)\s+)/i, '').trim();
    return `${greeting} Você conseguiria nos enviar ${aBody}? Assim que puder, me dá um retorno por aqui, tá bom!`;
  }

  // Caso 7: Notificação / Atualização de Status
  let lowerBody = body.replace(/^(?:que\s+|para\s+avisar\s+que\s+|para\s+informar\s+que\s+|avisando\s+que\s+)/i, '').trim();
  lowerBody = lowerBody.charAt(0).toLowerCase() + lowerBody.slice(1);
  return `${greeting} Passando para te avisar que ${lowerBody}. Qualquer dúvida que surgir, é só me chamar por aqui, tá bom?`;
}

/**
 * Normaliza e humaniza mensagens tanto para texto quanto para áudio
 */
export function buildFriendlyMessage(recipient, rawMessage, { asAudio = false, identity = {} } = {}) {
  const script = buildFriendlyAudioScript(recipient, rawMessage, { identity });
  return asAudio ? cleanForSpeech(script) : script;
}

/**
 * Humanização com IA: formula mensagens amigáveis e acolhedoras para clientes/contatos,
 * eliminando o pedido cru e qualquer clichê robótico.
 */
export async function humanizeContactMessage(recipient, rawMessage, { asAudio = false, ai, botConfig = {}, identity } = {}) {
  const resolved = resolveIdentity(identity || botConfig);
  const owner = resolved.responsible || 'nossa equipe';
  const isPhone = /^\d+$/.test(String(recipient).replace(/\D/g, ''));
  const recName = recipient && !isPhone && !/^você mesmo/i.test(String(recipient)) && !/^(?:n[úu]mero|numero|telefone|contato|cliente)$/i.test(String(recipient))
    ? String(recipient).trim()
    : 'cliente';

  if (ai?.askAI) {
    try {
      const prompt = `Você é a ${resolved.botName}, assistente e especialista de atendimento${resolved.companyName ? ` da equipe da ${resolved.companyName}` : ' da equipe'}.
${owner} (responsável pela operação) deu a seguinte instrução para enviar ao contato "${recName}": "${rawMessage}".

Sua tarefa: Gerar a mensagem final pronta e humanizada que você (${resolved.botName}) vai ${asAudio ? 'falar no áudio' : 'enviar no WhatsApp'} diretamente para "${recName}".

DIRETRIZES:
1. Fale DIRETAMENTE com o contato em 2ª pessoa ("você"), com simpatia, naturalidade, tom consultivo e acolhedor.
2. NUNCA diga que está falando "a pedido de ${owner}", "a mando dele" ou "${owner} pediu para avisar". Fale com autonomia como parte da equipe.
3. NUNCA repita ou transcreva comandos operacionais do responsável (ex: "vou precisar que vc mande um áudio", "lembre o Lima", etc.). Formule a mensagem executando o objetivo de forma fluida.
4. NUNCA use frases clichês robóticas como "Queria aproveitar para alinhar com você que eu..." ou "Passando para te avisar que...". Varie o tom com naturalidade.
5. ${asAudio || botConfig?.style?.emoji === 'off' ? 'Para áudio ou modo sem emojis: NÃO use emojis nem asteriscos (*) de formatação (para que a síntese de voz soe 100% natural).' : botConfig?.style?.emoji === 'normal' ? 'Para texto: use emojis amigáveis com moderação (até 2 a 3) e formatação leve; evite em assuntos sensíveis.' : 'Para texto: use no máximo 0 a 2 emojis naturais e formatação leve; PROIBIDO em reclamações, cobranças ou assuntos sensíveis.'}`;

      const aiRes = await ai.askAI({
        system: prompt,
        history: [],
        userText: `Gere a mensagem humanizada para ${recName}:`,
        botConfig
      });

      let candidate = '';
      if (aiRes?.message && typeof aiRes.message === 'string') {
        candidate = aiRes.message.trim();
      } else if (aiRes?.reply && typeof aiRes.reply === 'string') {
        const text = aiRes.reply.trim();
        const jsonMatch = text.match(/\{[\s\S]*?"(?:message|reply)"\s*:\s*"([^"]+)"[\s\S]*?\}/i);
        if (jsonMatch) {
          candidate = jsonMatch[1].trim();
        } else {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.message === 'string') candidate = parsed.message.trim();
            else if (parsed && typeof parsed.reply === 'string') candidate = parsed.reply.trim();
            else candidate = text;
          } catch {
            candidate = text;
          }
        }
      }

      // Validação: descarta respostas que sejam apenas confirmações direcionadas ao responsável
      const isMetaAck = !candidate ||
        new RegExp(`(?:claro|com certeza|perfeito|deixa comigo|beleza|vou enviar|vou gravar|posso enviar|anotado)[,\\s!]+(?:${escapeText(owner)})?`, 'i').test(candidate) ||
        /\b(?:vou enviar o [aá]udio|enviando mensagem|disparando|a pedido d[eo])\b/i.test(candidate) ||
        candidate.includes('{"');

      if (candidate && candidate.length > 10 && !isMetaAck) {
        return asAudio ? cleanForSpeech(candidate) : candidate;
      }
    } catch (e) {
      console.warn('[flow] humanizeContactMessage via IA falhou, usando fallback:', e.message);
    }
  }

  return buildFriendlyAudioScript(recipient, rawMessage, { identity: resolved });
}
export function applyAudioCorrection(previousScript = '', feedbackText = '', recipient = '', { identity = {} } = {}) {
  const normFb = normalize(feedbackText);
  let updated = String(previousScript || '');

  // Se o responsável apontou confusão de pronome ("estou me referindo ao lima e não a mim", "troca ele por você", "fale direto com ele", etc.)
  if (/(?:referindo|refiro|nao a mim|troca|muda|substitui|voce|direto com ele|direto pra ele)/i.test(normFb) || /\bele\b/i.test(updated)) {
    updated = updated
      .replace(/\bque ele vai\b/gi, 'que você vai')
      .replace(/\bque ela vai\b/gi, 'que você vai')
      .replace(/\bele vai\b/gi, 'você vai')
      .replace(/\bele precisa\b/gi, 'você precisa')
      .replace(/\bele tem que\b/gi, 'você tem que')
      .replace(/\bele deve\b/gi, 'você deve')
      .replace(/\bele pode\b/gi, 'você pode')
      .replace(/\bpara ele\b/gi, 'para você')
      .replace(/\bpra ele\b/gi, 'pra você')
      .replace(/\bdele\b/gi, 'seu');
  }

  // Se o responsável deu uma nova instrução explícita ("diga que...", "fala que...", "muda para...")
  const explicitNew = feedbackText.match(/(?:diga que|diz que|fala que|fale que|muda para|mude para|troca para|troque para|coloca que|coloque que)\s+(.+)/i);
  if (explicitNew) {
    return buildFriendlyAudioScript(recipient, explicitNew[1].trim(), { identity });
  }

  return updated;
}

/**
 * Extrai destinatário e mensagem de comandos ou respostas do responsável (Copiloto).
 */
export function extractDispatchIntent(cleanCommand, { pendingRecipient, pendingAsAudio, lastAssistantMsg, knownNames = [], botName = 'Lia' } = {}) {
  const strippedCmd = stripBotMention(cleanCommand, botName);

  // Se for comando de cancelamento explícito, JAMAIS extrai destinatário nem intenção de envio
  const isCancel = /^(?:n[ãa]o(?:\s+(?:envia|manda|precisa|quero))?|cancela|cancelar|cancelado|abortar|esquece|deixa(?:\s+(?:quieto|pra\s+l[áa]))?|para|parar|n[ãa]o\s+envia|n[ãa]o\s+manda|n[ãa]o\s+precisa)\b/i.test(strippedCmd);
  if (isCancel) {
    return { recipient: null, message: null, asAudio: false, isCancel: true };
  }

  // Se for pedido explícito de áudio, aviso ou explicação para o PRÓPRIO responsável (chat interno)
  const isForSelf = /(?:para\s+mim|pra\s+mim|no\s+chat\s+interno|comigo|me\s+(?:mande|envie|manda|grava|grave|fala|fale|explique|explica|avisa|avise|notifica|notifique|retorna|retorne|responde|responda|lembra|lembre))\b/i.test(cleanCommand);

  const IGNORED_RECIPIENTS = new Set([
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'o contato', 'contato',
    'qualquer', 'mim', 'ele', 'ela', 'todos', 'todas', 'nós', 'você', 'voce',
    'gente', 'ajuda', 'status', 'ver', 'hoje', 'amanhã', 'amanha', 'ontem', 'daqui',
    'agora', 'depois', 'logo', 'minuto', 'minutos', 'hora', 'horas', 'segundo', 'segundos',
    'dia', 'dias', 'semana', 'mes', 'mês', 'verificar', 'verificacao', 'verificação',
    'consulta', 'consultar', 'checar', 'saude', 'saúde', 'api', 'apis', 'sistema', 'resultado',
    'saber', 'recado', 'mensagem',
    'número', 'numero', 'telefone', 'celular', 'cliente', 'ptbr', 'pt-br', 'pt_br', 'br'
  ]);

  const lastAssistantAsked = Boolean(
    lastAssistantMsg &&
    /(?:o que (?:voc[êe] )?gostaria (?:que eu enviasse|de dizer|que eu falasse)|me diga o recado|qual recado|qual o assunto|confirme o destinat[áa]rio e a mensagem|deseja enviar para|o que quer que eu diga)/i.test(lastAssistantMsg)
  );

  const isSendIntent = /(?:envie|mande|dispare|manda|envia|grave|grava|fale com|avisa|avise|notifique|notifica|zap|mensagem|áudio|audio)\b/i.test(cleanCommand);

  // Se for para o próprio responsável, não extrai destinatário externo
  if (isForSelf) {
    const asAudio = /(?:[aá]udio|voz)\b/i.test(cleanCommand);
    return { recipient: null, message: cleanCommand, asAudio, forSelf: true };
  }

  // Se não é comando de envio E não estamos aguardando resposta de pergunta anterior, ignora
  if (!isSendIntent && !pendingRecipient && !lastAssistantAsked) {
    return { recipient: null, message: null, asAudio: false };
  }

  let recipient = null;
  const recMatch = cleanCommand.match(/(?:para\s+o|para\s+a|para|pro|pra|ao)\s+([a-zA-ZÀ-ÿ0-9+]+)/i) ||
    cleanCommand.match(/(?:lembre|lembra|avise|avisa|notifique|notifica|fale\s+com|falar\s+com)\s+(?:o|a)?\s*([a-zA-ZÀ-ÿ0-9+]+)/i);
  if (recMatch && !IGNORED_RECIPIENTS.has(recMatch[1].toLowerCase())) {
    recipient = recMatch[1].trim();
  }
  if (!recipient) {
    // Procura qualquer nome de contato conhecido da agenda/sessões citado na frase
    for (const name of knownNames) {
      if (!name || name.length < 2 || IGNORED_RECIPIENTS.has(name.toLowerCase())) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(cleanCommand)) {
        recipient = name;
        break;
      }
    }
    if (!recipient) {
      const pMatch = cleanCommand.match(/55\d{10,11}|\b\d{10,11}\b/);
      if (pMatch) recipient = pMatch[0];
    }
  }
  if (!recipient && pendingRecipient && !IGNORED_RECIPIENTS.has(String(pendingRecipient).toLowerCase())) {
    recipient = pendingRecipient;
  }
  if (!recipient && lastAssistantAsked) {
    const astRecMatch = lastAssistantMsg.match(/\*([a-zA-ZÀ-ÿ0-9+]+)\*/);
    if (astRecMatch && !IGNORED_RECIPIENTS.has(astRecMatch[1].toLowerCase())) {
      recipient = astRecMatch[1].trim();
    } else {
      for (const name of knownNames) {
        if (!name || name.length < 2 || IGNORED_RECIPIENTS.has(name.toLowerCase())) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(lastAssistantMsg)) {
          recipient = name;
          break;
        }
      }
      if (!recipient) {
        const pMatch = lastAssistantMsg.match(/55\d{10,11}|\b\d{10,11}\b/);
        if (pMatch) recipient = pMatch[0];
      }
    }
  }

  let message = null;
  const explicitMsgMatch = cleanCommand.match(/(?:mensagem [ée]|recado [ée]|dizendo que|avisando que|falando que|informando que|dizendo|diga que|diz que)\s*(.+)/i);
  if (explicitMsgMatch) {
    message = explicitMsgMatch[1].trim();
  } else {
    const isOnlySendCmd = /^(?:vou precisar que|preciso que|quero que|gostaria que|por favor|pode)?\s*(?:voc[êe]\s+)?(?:envie|enviar|mande|mandar|dispare|disparar|manda|envia|grave|gravar|fale com|falar com)\s+(?:(?:um|uma|o|a)\s+)?(?:mensagem(?:\s+de\s+[aá]udio|\s+de\s+voz)?|msg|zap|[aá]udio|audio|voz|recado|texto)?\s*(?:para\s+o|para\s+a|para|pro|pra|ao)?\s*(?:[a-zA-ZÀ-ÿ0-9+]+\s*)?[.!?]*$/i.test(strippedCmd.trim());
    const isModalityOnly = /^(?:que\s+)?(?:envie|enviar|mande|mandar|grave|gravar|dispare|disparar)?\s*(?:um\s+|uma\s+)?(?:texto|áudio|audio|mensagem|recado|msg|zap)(?:\s+(?:em|por)\s+(?:texto|áudio|audio))?[.!?]*$/i.test(strippedCmd.trim());
    if (!isOnlySendCmd && !isModalityOnly) {
      const stripped = stripCommandPrefix(strippedCmd, recipient, { botName });
      const isFormatWord = /^(?:um\s+|uma\s+)?(?:texto|áudio|audio|mensagem|recado|msg|voz)$/i.test(stripped) ||
                           /^(?:em\s+|por\s+)?(?:texto|áudio|audio|voz)$/i.test(stripped);
      if (stripped.length >= 3 && !isFormatWord && !/^(?:ajuda|status|resumo|fila|espera|lembretes|bot|humano|limpar)\b/i.test(stripped)) {
        message = stripped;
      }
    }
  }

  const wantsText = /(?:em\s+|por\s+|um\s+|uma\s+mensagem\s+de\s+)?(?:texto|escrito)\b/i.test(cleanCommand);
  let asAudio = false;
  if (wantsText) {
    asAudio = false;
  } else {
    asAudio = Boolean(pendingAsAudio) || /(?:em\s+|como\s+|por\s+|um\s+|uma\s+mensagem\s+de\s+)?(?:[aá]udio|voz)\b/i.test(cleanCommand) || /(?:o que voc[êe] gostaria que eu falasse no [aá]udio)/i.test(lastAssistantMsg || '');
  }
  return { recipient, message, asAudio };
}
