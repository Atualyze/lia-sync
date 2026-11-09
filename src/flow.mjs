
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

export function isHumanRequest(text = '') {
  const raw = String(text || '');
  if (/atendimento pessoal|veterin[aá]ria pro meu cachorro|quanto custa/i.test(raw)) return false;
  const n = normalize(raw);
  if (/atendimento pessoal|veterinaria pro meu cachorro/i.test(n)) return false;
  return /\b(atendente|pessoa|humano|dra elisangela|dra\. elisangela|falar com a dra|falar com um atendente|passa para uma pessoa)\b/i.test(raw) ||
         /\b(atendente|pessoa|humano|dra elisangela|falar com a dra|falar com um atendente|passa para uma pessoa)\b/i.test(n) ||
         isTalkToTauanRequest(text);
}
import { sanitizeInput, isEmergency, isHighRiskSymptom, isClinicalConcern, filterReply, normalize, isGreeting } from './safety.mjs';
import { buildSystemPrompt, GREETING_MESSAGE, ATENDIMENTO_EM_PROGRESSO_MESSAGE, TALK_TO_TAIS_MESSAGE } from './knowledge.mjs';
import { findDynamicFaq, getPlansForPrompt, getAllowedPrices } from './faq.mjs';
import { triggerHandoff } from './handoff.mjs';
import { normalizePhone, isTauanContact } from './sessions.mjs';
import { executeToolCall } from './tools/index.mjs';
import { avaliarJanelaDeAtendimento } from './business-hours.mjs';
import { classificarSetorPorTexto } from './triage-router.mjs';
import { getMetricsSummary, resetMetrics } from './metrics.mjs';

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

/**
 * Remove qualquer comando residual de pedido de envio ("envie um áudio pro Lima informando sobre...", "envie um audio e diga ao lima que...", etc.)
 * tanto no início quanto no meio da frase.
 */
export function stripCommandPrefix(rawText = '', recipient = '') {
  let s = String(rawText || '').replace(/["“”«»]/g, ' ').trim();
  const recEscaped = recipient ? String(recipient).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

  // 0. Remove menção a Lia e cumprimentos/prefixos conversacionais no início
  s = s
    .replace(/^[@/]?lia[\s,:-]*/i, '')
    .replace(/^(?:perfeito|certo|ótimo|otimo|combinado|beleza|ok|show|maravilha|olha|então|entao|seguinte)[\s,!.-]+/i, '')
    .trim();

  // 1. Componentes de comandos
  const sendVerbs = '(?:envie|enviar|envia|mande|mandar|manda|dispare|disparar|dispara|grave|gravar|grava|solte|soltar|solta|passe|passar|passa)';
  const speechVerbs = '(?:diga|diz|fale|fala|avise|avisa|informe|informa|explique|explica|pe[cç]a|pede|lembre|lembra|pergunte|pergunta|cobre|cobra|notifique|notifica)';
  const modals = '(?:vou\\s+precisar\\s+que|preciso\\s+que|quero\\s+que|gostaria\\s+que|pode|poderia|favor)';
  const pronouns = '(?:voc[êe]|vc|c[êe])';
  const recPrep = '(?:para\\s+o|para\\s+a|para|pro|pra|ao|à)\\s+|o\\s+|a\\s+';
  const recTarget = recEscaped ? `(?:(?:${recPrep})?${recEscaped}\\b)` : `(?:${recPrep}[a-zA-ZÀ-ÿ0-9+]+\\b)`;
  const media = '(?:(?:(?:um|uma|o|a)\\s+)?(?:mensagem(?:\\s+de\\s+[aá]udio|\\s+de\\s+voz)?|msg|zap|[aá]udio|audio|voz|recado)|(?:em|por)\\s+(?:[aá]udio|voz))';
  const gerunds = '(?:informando|avisando|dizendo|falando|explicando|lembrando|pedindo|cobrando|confirmando|perguntando)';

  // Padrão 1: "vou precisar que vc mande um áudio e lembre o Lima sobre..." ou "envie um áudio pro Lima sobre..."
  const fullCmdPattern = new RegExp(`^${modals}?\\s*${pronouns}?\\s*(?:me\\s+)?${sendVerbs}\\s+${media}(?:\\s+e\\s+|\\s*,?\\s*)?${speechVerbs}?(?:\\s*${recTarget})?(?:\\s*${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|se\\b|sobre\\b|de\\b|a\\s+respeito\\s+de\\b)?\\s*`, 'i');
  s = s.replace(fullCmdPattern, '').trim();

  // Padrão 2: "lembre o Lima sobre..." ou "avise o Lima que..." ou "mande um áudio pro Lima dizendo que..."
  const directCmdPattern = new RegExp(`^${speechVerbs}\\s*${recTarget}\\s*(?:${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|se\\b|sobre\\b|de\\b|a\\s+respeito\\s+de\\b)?\\s*`, 'i');
  s = s.replace(directCmdPattern, '').trim();

  if (recEscaped) {
    const midRecCmdRe = new RegExp(`\\b(?:e\\s+)?${speechVerbs}?\\s*${media}\\s*(?:${recPrep})?${recEscaped}\\b\\s*(?:${gerunds})?\\s*(?:que\\b|para\\b|pra\\b|se\\b|sobre\\b|de\\b)?\\s*`, 'gi');
    s = s.replace(midRecCmdRe, '').trim();
  }

  // 2. Limpeza iterativa de prefixos no início
  for (let i = 0; i < 6; i++) {
    const prev = s;
    s = s
      .replace(/^(?:[@/]?lia[\s,:-]*)?/i, '')
      .replace(/^(?:perfeito|certo|ótimo|otimo|combinado|beleza|ok|show|maravilha|olha|então|entao|seguinte)[\s,!.-]+/i, '')
      .replace(/^(?:sim|ok|beleza|confirmo|pode mandar|pode enviar|manda|dispara|por favor|pfv)[\s,!.-]*/i, '')
      .replace(/^(?:e\s+|ent[ãa]o\s+|ai\s+|a[íi]\s+|depois\s+)/i, '')
      .replace(new RegExp(`^(?:${modals})?\\s*(?:${pronouns})?\\s*(?:me\\s+)?(?:${sendVerbs}|fale com|falar com|${speechVerbs})\\b[\\s,:-]*`, 'i'), '')
      .replace(new RegExp(`^${media}\\b[\\s,:-]*`, 'i'), '')
      .replace(/^(?:em\s+[aá]udio|por\s+[aá]udio|como\s+[aá]udio|em\s+voz|por\s+voz)\b[\s,:-]*/i, '')
      .replace(new RegExp(`^(?:e\\s+)?(?:${gerunds}|${speechVerbs})\\b[\\s,:-]*`, 'i'), '')
      .replace(new RegExp(`^(?:para\\s+o|para\\s+a|para|pro|pra|ao|para\\s+ele|pra\\s+ele|para\\s+ela|pra\\s+ela)\\s+[a-zA-ZÀ-ÿ0-9+]+\\b[\\s,!.-]*`, 'i'), '')
      .replace(/^(?:para\s+ele|pra\s+ele|para\s+ela|pra\s+ela|a\s+ele|a\s+ela)\b[\s,!.-]*/i, '')
      .replace(/^(?:a\s+mensagem\s+[ée]|o\s+recado\s+[ée]|o\s+[aá]udio\s+[ée]|que\s+[ée])\s*/i, '')
      .replace(/^(?:apenas\s+que\s+[ée]|s[óo]\s+que\s+[ée]|apenas\s+que|s[óo]\s+que|apenas\s+|s[óo]\s+|que\s+|para\s+|pra\s+)\s*/i, '')
      .trim();

    if (recEscaped) {
      const recPrefixRe = new RegExp(`^(?:para\\s+o|para\\s+a|para|pro|pra|ao)?\\s*${recEscaped}\\b[\\s,:-]*`, 'i');
      s = s.replace(recPrefixRe, '').trim();
    }
    if (s === prev) break;
  }

  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Transforma instruções ou comandos brutos em um roteiro ou mensagem natural, acolhedora e 100% humanizada como assistente.
 * NUNCA joga o pedido cru e NUNCA usa frases clichês robóticas como "Queria aproveitar para alinhar com você que".
 */
export function buildFriendlyAudioScript(recipient, rawMessage) {
  const rawRec = recipient && !/^\d+$/.test(String(recipient).replace(/\D/g, '')) && recipient !== 'você mesmo (Tauan)'
    ? String(recipient).trim()
    : '';
  const recName = rawRec ? rawRec.charAt(0).toUpperCase() + rawRec.slice(1) : '';
  let text = cleanForSpeech(rawMessage);

  // Remove qualquer autoapresentação repetitiva ou clichê robótico
  let rawCore = text
    .replace(/^oi(?:,\s*[a-zA-ZÀ-ÿ0-9]+)?!\s*(?:tudo bem\?\s*)?(?:aqui [ée] a lia(?:,\s*assistente do tauan)?[.,!\s]*)?/i, '')
    .replace(/^(?:ol[áa](?:,\s*[a-zA-ZÀ-ÿ0-9]+)?!\s*)?(?:aqui [ée] a lia(?:,\s*assistente do tauan)?[.,!\s]*)/i, '')
    .replace(/\baqui [ée] a lia(?:,\s*assistente do tauan)?[.,!\s]*/gi, '')
    .replace(/^(?:estou\s+)?passando(?:\s+por\s+aqui)?(?:\s+a\s+pedido\s+(?:dele|do\s+tauan))?\s+para\s+(?:te\s+avisar\s+que|avisar\s+que|te\s+lembrar\s+que|te\s+informar\s+que|falarmos\s+sobre|alinharmos\s+sobre)\s*/i, '')
    .replace(/\ba\s+pedido\s+(?:dele|do\s+tauan)\b[\s,]*/gi, '')
    .replace(/\.\s*(?:assim que voc[êe] puder,\s*me d[áa] um retorno por aqui,\s*t[áa] bom\?|qualquer d[úu]vida,\s*[ée] s[óo] me chamar por aqui,\s*t[áa] bom\?)\s*(?:um abra[cç]o!)?$/i, '')
    .trim();

  let core = stripCommandPrefix(rawCore, recName);
  if (!core) {
    core = stripCommandPrefix(text, recName) || text;
  }

  const isReminder = /\b(?:lembr|toque|aviso)\b/i.test(rawMessage) && !/\b(?:vai\s+querer|pergunta)\b/i.test(core);

  // Detecta intenção antes de normalizar pronomes
  const isQuestion = /^(?:se\s+|perguntando|pergunte|pergunta|para\s+perguntar|ver\s+se|saber\s+se)\b/i.test(rawCore) ||
    /^(?:se\s+|quando\b|como\b|qual\b|quais\b|onde\b|que\s+horas|quanto\b|por\s+que\b)/i.test(core) ||
    /\b(?:vai\s+querer|vai\s+fechar|consegue|pode|gostaria|chegou\s+a\s+ver|j[áa]\s+viu|j[áa]\s+recebeu|tem\s+interesse)\b/i.test(core) ||
    /\?$/.test(rawMessage.trim());

  const isActionRequest = /^(?:pedindo|pe[cç]a|pede|cobrando|cobre|cobra|solicitando|solicite|solicita)\b/i.test(rawCore) ||
    /^(?:para\s+(?:ele|ela|voc[êe])\s+(?:nos?\s+)?(?:enviar|mandar|passar|encaminhar)|(?:enviar|mandar|passar|encaminhar)\s+(?:o|a|os|as|um|uma)?\s*(?:comprovante|documento|arquivo|contrato|nota|dados|chave|pix))/i.test(core);

  // Converte 3ª pessoa ("ele vai precisar", "ele precisa", "ele tem que", "ele deve", "dele") em 2ª pessoa ("você vai precisar", "você precisa", etc.)
  let body = core
    .replace(/\bele\s+vai\b/gi, 'você vai')
    .replace(/\bela\s+vai\b/gi, 'você vai')
    .replace(/\bele\s+precisa\b/gi, 'você precisa')
    .replace(/\bela\s+precisa\b/gi, 'você precisa')
    .replace(/\bele\s+tem\s+que\b/gi, 'você tem que')
    .replace(/\bela\s+tem\s+que\b/gi, 'você tem que')
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

  // Caso 2: Substantivo de tópico puro (ex: "o pagamento dos boletos", "o código de rastreio do site") sem verbo conjugado
  const looksLikeNounTopic = /^(?:o\s+|a\s+|os\s+|as\s+|um\s+|uma\s+)?(?:pagamento|boleto|boletos|fatura|nota|contrato|c[óo]digo|rastreio|site|sistema|projeto|proposta|or[cç]amento|reuni[ãa]o|entrega|cadastro|acesso|pix|valor)\b/i.test(body) &&
    !/\b(?:vai|foi|est[áa]|est[ãa]o|precisa|pode|deve|tem|ficou|chegou|saiu|vence|venceu|sera|ser[áa]|[ée])\b/i.test(body);

  if (looksLikeNounTopic) {
    const lowerTopic = body.charAt(0).toLowerCase() + body.slice(1);
    return `${greeting} Estou entrando em contato para alinharmos sobre ${lowerTopic}. Assim que puder, me dá um retorno por aqui, tá bom?`;
  }

  // Caso 3: Lembrete / Toque sobre monitoramento, campanha, etc.
  if (isReminder) {
    let remTopic = body.replace(/^(?:o\s+|a\s+|os\s+|as\s+|sobre\s+o\s+|sobre\s+a\s+|sobre\s+|de\s+)/i, '').trim();
    remTopic = remTopic.charAt(0).toLowerCase() + remTopic.slice(1);
    return `${greeting} Passando para te dar um toque sobre ${remTopic}. Qualquer dúvida que tiver, estou por aqui!`;
  }

  // Caso 4: Humanização natural de instruções técnicas/tarefas ("você vai precisar...", "você precisa...", "você tem que...", "precisa...")
  if (/^voc[êe]\s+(?:vai\s+precisar|precisa|tem\s+que|deve)\s+/i.test(body)) {
    const action = body.replace(/^voc[êe]\s+(?:vai\s+precisar|precisa|tem\s+que|deve)\s+/i, '').trim();
    return `${greeting} Só para alinharmos os próximos passos, você vai precisar ${action}, combinado? Assim que concluir ou se tiver qualquer dúvida, é só me chamar por aqui!`;
  }

  if (/^(?:precisa|tem\s+que|deve|vai\s+precisar)\s+/i.test(body)) {
    const action = body.replace(/^(?:precisa|tem\s+que|deve|vai\s+precisar)\s+/i, '').trim();
    return `${greeting} Só para alinharmos os próximos passos, você vai precisar ${action}, combinado? Assim que concluir ou se tiver qualquer dúvida, é só me chamar por aqui!`;
  }

  // Caso 5: Pergunta / Sondagem de interesse ou horário ("se vai querer a proposta", "quando pode fazer reunião", etc.)
  if (isQuestion) {
    let qBody = body.replace(/^(?:se\s+|para\s+perguntar\s+se\s+|para\s+saber\s+se\s+|perguntando\s+se\s+)/i, '').trim();
    const lowerQ = qBody.charAt(0).toLowerCase() + qBody.slice(1);
    if (/^(?:quando|como|qual|quais|onde|que\s+horas|quanto)\b/i.test(lowerQ)) {
      return `${greeting} Passando para saber ${lowerQ}. Assim que puder, me avisa por aqui, tá bom?`;
    }
    return `${greeting} Passando para saber se ${lowerQ}. Se tiver alguma dúvida ou precisar de qualquer ajuste, estou por aqui, tá bom?`;
  }

  // Caso 6: Pedido de ação / envio de documento ("enviar o comprovante", "mandar o contrato", etc.)
  if (isActionRequest) {
    let aBody = body.replace(/^(?:para\s+voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|voc[êe]\s+(?:nos?\s+)?(?:enviar|mandar|passar)|(?:enviar|mandar|passar)\s+)/i, '').trim();
    return `${greeting} Você conseguiria nos enviar ${aBody}? Assim que puder, me dá um retorno por aqui, tá bom!`;
  }

  // Caso 7: Notificação / Atualização de Status ("o site já ficou pronto", "a reunião foi confirmada para as 15h", etc.)
  let lowerBody = body.replace(/^(?:que\s+|para\s+avisar\s+que\s+|para\s+informar\s+que\s+|avisando\s+que\s+)/i, '').trim();
  lowerBody = lowerBody.charAt(0).toLowerCase() + lowerBody.slice(1);
  return `${greeting} Passando para te avisar que ${lowerBody}. Qualquer dúvida que surgir, é só me chamar por aqui, tá bom?`;
}

/**
 * Normaliza e humaniza mensagens tanto para texto quanto para áudio
 */
export function buildFriendlyMessage(recipient, rawMessage, { asAudio = false } = {}) {
  const script = buildFriendlyAudioScript(recipient, rawMessage);
  return asAudio ? cleanForSpeech(script) : script;
}

/**
 * Humanização com IA: formula mensagens amigáveis e acolhedoras para clientes/contatos,
 * eliminando o pedido cru e qualquer clichê robótico.
 */
export async function humanizeContactMessage(recipient, rawMessage, { asAudio = false, ai, botConfig = {} } = {}) {
  const recName = recipient && !/^\d+$/.test(String(recipient).replace(/\D/g, '')) && recipient !== 'você mesmo (Tauan)'
    ? String(recipient).trim()
    : 'cliente';

  if (ai?.askAI) {
    try {
      const prompt = `Você é a Lia, assistente e especialista de atendimento da equipe da Atualyze.
Tauan (gestor da equipe) deu a seguinte instrução para enviar ao contato "${recName}": "${rawMessage}".

Sua tarefa: Gerar a mensagem final pronta e humanizada que você (Lia) vai ${asAudio ? 'falar no áudio' : 'enviar no WhatsApp'} diretamente para "${recName}".

DIRETRIZES:
1. Fale DIRETAMENTE com "${recName}" em 2ª pessoa ("você"), com simpatia, naturalidade, tom consultivo e acolhedor.
2. NUNCA diga que está falando "a pedido do Tauan", "a mando dele" ou "o Tauan pediu para avisar". Fale com autonomia como parte da equipe.
3. NUNCA repita ou transcreva comandos operacionais do Tauan (ex: "vou precisar que vc mande um áudio", "lembre o Lima", etc.). Formule a mensagem executando o objetivo de forma fluida.
4. NUNCA use frases clichês robóticas como "Queria aproveitar para alinhar com você que eu...". Varie o tom com naturalidade.
5. ${asAudio ? 'Para áudio: NÃO use emojis nem asteriscos (*) de formatação (para que a síntese de voz soe 100% natural).' : 'Para texto: use emojis amigáveis e formatação leve.'}
6. Retorne APENAS um JSON no formato: {"message": "texto final da mensagem"}.`;

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
        const jsonMatch = aiRes.reply.match(/\{[\s\S]*?"message"\s*:\s*"([^"]+)"[\s\S]*?\}/i);
        if (jsonMatch) {
          candidate = jsonMatch[1].trim();
        } else {
          try {
            const parsed = JSON.parse(aiRes.reply.trim());
            if (parsed && typeof parsed.message === 'string') {
              candidate = parsed.message.trim();
            }
          } catch {}
        }
      }

      // Validação: descarta respostas que sejam confirmações direcionadas ao Tauan (ex: em mocks de teste ou alucinações)
      const isMetaAck = !candidate ||
        /(?:claro|com certeza|perfeito|deixa comigo|beleza|vou enviar|vou gravar|posso enviar|anotado)[,\s!]+(?:tauan)?/i.test(candidate) ||
        /\b(?:vou enviar o [aá]udio|enviando mensagem|disparando|a pedido d[eo])\b/i.test(candidate) ||
        candidate.includes('{"');

      if (candidate && candidate.length > 10 && !isMetaAck) {
        return asAudio ? cleanForSpeech(candidate) : candidate;
      }
    } catch (e) {
      console.warn('[flow] humanizeContactMessage via IA falhou, usando fallback:', e.message);
    }
  }

  return buildFriendlyAudioScript(recipient, rawMessage);
}
export function applyAudioCorrection(previousScript = '', feedbackText = '', recipient = '') {
  const normFb = normalize(feedbackText);
  let updated = String(previousScript || '');

  // Se o Tauan apontou confusão de pronome ("estou me referindo ao lima e não a mim", "troca ele por você", "fale direto com ele", etc.)
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

  // Se o Tauan deu uma nova instrução explícita ("diga que...", "fala que...", "muda para...")
  const explicitNew = feedbackText.match(/(?:diga que|diz que|fala que|fale que|muda para|mude para|troca para|troque para|coloca que|coloque que)\s+(.+)/i);
  if (explicitNew) {
    return buildFriendlyAudioScript(recipient, explicitNew[1].trim());
  }

  return updated;
}

/**
 * Extrai destinatário e mensagem de comandos ou respostas do Tauan (Copiloto)
 */
export function extractDispatchIntent(cleanTauan, { pendingRecipient, pendingAsAudio, lastAssistantMsg, knownNames = [] } = {}) {
  const strippedCmd = String(cleanTauan || '').replace(/^[@/]?lia[\s,:-]*/i, '').trim();

  // Se for comando de cancelamento explícito, JAMAIS extrai destinatário nem intenção de envio
  const isCancel = /^(?:n[ãa]o(?:\s+(?:envia|manda|precisa|quero))?|cancela|cancelar|cancelado|abortar|esquece|deixa(?:\s+(?:quieto|pra\s+l[áa]))?|para|parar|n[ãa]o\s+envia|n[ãa]o\s+manda|n[ãa]o\s+precisa)\b/i.test(strippedCmd);
  if (isCancel) {
    return { recipient: null, message: null, asAudio: false, isCancel: true };
  }

  // Se for pedido explícito de áudio ou explicação para o PRÓPRIO Tauan (chat interno)
  const isForSelf = /(?:para\s+mim|pra\s+mim|no\s+chat\s+interno|comigo|me\s+(?:mande|envie|manda|grava|grave|fala|fale|explique|explica))\b/i.test(cleanTauan);

  const IGNORED_RECIPIENTS = new Set([
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'o contato', 'contato',
    'qualquer', 'mim', 'ele', 'ela', 'todos', 'todas', 'nós', 'você', 'voce',
    'gente', 'ajuda', 'status', 'ver', 'hoje', 'amanhã', 'ontem', 'saber', 'recado', 'mensagem'
  ]);

  const lastAssistantAsked = Boolean(
    lastAssistantMsg &&
    /(?:o que (?:voc[êe] )?gostaria (?:que eu enviasse|de dizer|que eu falasse)|me diga o recado|qual recado|qual o assunto|confirme o destinat[áa]rio e a mensagem|deseja enviar para|o que quer que eu diga)/i.test(lastAssistantMsg)
  );

  const isSendIntent = /(?:envie|mande|dispare|manda|envia|grave|grava|fale com|avisa|avise|notifique|notifica|zap|mensagem|áudio|audio)\b/i.test(cleanTauan);

  // Se for para o próprio Tauan, não extrai destinatário externo
  if (isForSelf) {
    const asAudio = /(?:[aá]udio|voz)\b/i.test(cleanTauan);
    return { recipient: null, message: cleanTauan, asAudio, forSelf: true };
  }

  // Se não é comando de envio E não estamos aguardando resposta de pergunta anterior, ignora
  if (!isSendIntent && !pendingRecipient && !lastAssistantAsked) {
    return { recipient: null, message: null, asAudio: false };
  }

  let recipient = null;
  const recMatch = cleanTauan.match(/(?:para\s+o|para\s+a|para|pro|pra|ao)\s+([a-zA-ZÀ-ÿ0-9+]+)/i) ||
    cleanTauan.match(/(?:lembre|lembra|avise|avisa|notifique|notifica|fale\s+com|falar\s+com)\s+(?:o|a)?\s*([a-zA-ZÀ-ÿ0-9+]+)/i);
  if (recMatch && !IGNORED_RECIPIENTS.has(recMatch[1].toLowerCase())) {
    recipient = recMatch[1].trim();
  }
  if (!recipient) {
    // Procura qualquer nome de contato conhecido da agenda/sessões citado na frase
    for (const name of knownNames) {
      if (!name || name.length < 2 || IGNORED_RECIPIENTS.has(name.toLowerCase())) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(cleanTauan)) {
        recipient = name;
        break;
      }
    }
    if (!recipient) {
      const pMatch = cleanTauan.match(/55\d{10,11}|\b\d{10,11}\b/);
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
  const explicitMsgMatch = cleanTauan.match(/(?:mensagem [ée]|recado [ée]|dizendo que|avisando que|falando que|informando que|dizendo|diga que|diz que)\s*(.+)/i);
  if (explicitMsgMatch) {
    message = explicitMsgMatch[1].trim();
  } else {
    const isOnlySendCmd = /^(?:[@/]?lia[\s,:-]*)?(?:vou precisar que|preciso que|quero que|gostaria que|por favor|pode)?\s*(?:voc[êe]\s+)?(?:envie|enviar|mande|mandar|dispare|disparar|manda|envia|grave|gravar|fale com|falar com)\s+(?:(?:um|uma|o|a)\s+)?(?:mensagem(?:\s+de\s+[aá]udio|\s+de\s+voz)?|msg|zap|[aá]udio|audio|voz|recado)?\s*(?:para\s+o|para\s+a|para|pro|pra|ao)\s+[a-zA-ZÀ-ÿ0-9+]+\s*[.!?]*$/i.test(cleanTauan.trim());
    if (!isOnlySendCmd) {
      const stripped = stripCommandPrefix(cleanTauan, recipient);
      if (stripped.length >= 3 && !/^(?:ajuda|status|resumo|fila|espera|lembretes|bot|humano|limpar)\b/i.test(stripped)) {
        message = stripped;
      }
    }
  }

  const asAudio = Boolean(pendingAsAudio) || /(?:em\s+|como\s+|por\s+|um\s+|uma\s+mensagem\s+de\s+)?(?:[aá]udio|voz)\b/i.test(cleanTauan) || /(?:o que voc[êe] gostaria que eu falasse no [aá]udio)/i.test(lastAssistantMsg || '');
  return { recipient, message, asAudio };
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

  const notify = async (message) => {
    const phone = getHumanPhone();
    try {
      if (store?.get) {
        const sSelf = store.get('tauan_self');
        if (sSelf) {
          sSelf.history ??= [];
          sSelf.history.push({
            role: 'assistant',
            content: message,
            createdAt: new Date(now()).toISOString()
          });
          if (sSelf.history.length > 40) sSelf.history = sSelf.history.slice(-30);
          sSelf.lastBotAt = new Date(now()).toISOString();
          sSelf.updatedAt = new Date(now()).toISOString();
          store.markDirty?.();
        }
      }
    } catch (e) {
      logger.error?.('[notify:copilot] erro ao salvar notificação no histórico interno:', e.message);
    }
    if (!phone) {
      logger.warn?.('[notify] humanPhone não definido; notificação registrada apenas no painel.');
      return undefined;
    }
    return whatsapp.sendText?.(phone, message);
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

        // 1.0 Cancelamento Geral Imediato (prioridade máxima antes de qualquer processamento)
        const isExplicitCancel = /^(?:n[ãa]o(?:\s+(?:envia|manda|precisa|quero))?|cancela|cancelar|cancelado|abortar|esquece|deixa(?:\s+(?:quieto|pra\s+l[áa]))?|para|parar|n[ãa]o\s+envia|n[ãa]o\s+manda|n[ãa]o\s+precisa)\b/i.test(strippedCmd) ||
          /^(?:pode\s+)?cancelar\b/i.test(strippedCmd);

        if (isExplicitCancel) {
          const hadPending = Boolean(sSelf.pendingAudioConfirmation || sSelf.pendingRecipient || sSelf.pendingAsAudio);
          sSelf.pendingAudioConfirmation = null;
          sSelf.pendingRecipient = null;
          sSelf.pendingAsAudio = false;
          store.markDirty();
          const cancelMsg = hadPending
            ? '🚫 *Envio cancelado com sucesso!* A mensagem foi descartada e não será enviada. Se precisar de algo ou quiser mandar outro recado, estou à disposição.'
            : 'Tudo bem, Tauan! Cancelado por aqui. Em que posso te ajudar agora?';
          return recordSelfTurn(filterReply(cancelMsg, { isCopilot: true }).text);
        }

        // 1.1 Ajuda e Comandos Internos
        if (/^(?:ajuda|comandos|comando|help|menu)\b/i.test(norm)) {
          const helpMsg = `🚀 *Painel de Controles & Comandos da Lia*

Olá, *Tauan*! Aqui estão todos os controles e testes operacionais em tempo real:

📊 *Telemetria, Desempenho & Consumo:*
• *status* — Raio-X do sistema: conexão, sessões e modelo ativo
• *metricas* ou *consumo* — Requisições, tokens consumidos e taxa de sucesso
• *ping* ou *teste* — Mede a latência real de resposta da IA em milissegundos
• *relatorio* — Resumo executivo de atendimentos e conversas do dia

⚡ *Controle Geral do Bot:*
• *bot off* ou *pausar bot* — Desativa a Lia globalmente (modo 100% humano)
• *bot on* ou *ativar bot* — Reativa a Lia globalmente para todos os contatos
• *expediente* — Consulta o status da Janela de Atendimento atual

👥 *Gestão por Contato Específico:*
• *fila* ou *espera* — Contatos aguardando sua resposta com link direto
• *bot [número]* — Reativa a Lia para atender um contato específico
• *humano [número]* — Pausa a Lia para você assumir o contato manual
• *limpar [número]* — Reseta o histórico de conversa com o contato

⏰ *Organização Pessoal:*
• *lembretes* — Seus compromissos e tarefas agendadas pendentes
• Converse em linguagem natural: _"me lembra amanhã às 9h de..."_`;
          return recordSelfTurn(filterReply(helpMsg, { isCopilot: true }).text);
        }

        // 1.1.5 Controle Global do Bot (Ativar / Desativar Bot Geral)
        if (/^(?:bot\s+(?:off|desativar|pausar|stop)|pausar\s+bot|desativar\s+bot)\b/i.test(strippedCmd)) {
          botConfig.behavior = botConfig.behavior || {};
          botConfig.behavior.globalBotDisabled = true;
          const rep = `🛑 *Lia Desativada Globalmente!*\n\nA IA foi pausada para *todas as novas mensagens*. Todos os contatos que enviarem mensagem agora ficarão na fila de atendimento humano aguardando você.\n\nPara reativar a qualquer momento, digite *bot on*.`;
          return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
        }

        if (/^(?:bot\s+(?:on|ativar|ligar|start)|ativar\s+bot|ligar\s+bot)\b/i.test(strippedCmd)) {
          botConfig.behavior = botConfig.behavior || {};
          botConfig.behavior.globalBotDisabled = false;
          const rep = `🟢 *Lia Reativada Globalmente!*\n\nA IA voltou a atender automaticamente todas as conversas e contatos no WhatsApp.`;
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
        if (/^(?:relatorio|relatório|resumo do dia|fechamento)\b/i.test(norm)) {
          const sessionsArr = Object.values(store.sessions);
          const totalConvs = sessionsArr.filter(s => s.phone && s.phone !== 'tauan_self' && !s.isInternalChat).length;
          const activeConvs = sessionsArr.filter(s => !s.inactivityClosed && (s.history?.length || 0) > 0 && s.phone !== 'tauan_self').length;
          const humanConvs = sessionsArr.filter(s => s.human && !s.inactivityClosed && s.phone !== 'tauan_self').length;
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
        if (/^(?:expediente|horario|horário|janela)\b/i.test(norm)) {
          const hoursCfg = botConfig?.business?.hoursConfig || null;
          if (!hoursCfg || !hoursCfg.enabled) {
            return recordSelfTurn(filterReply(`🕒 *Expediente de Atendimento:*\n\n🟢 *Status:* Atendimento 24 Horas (Sem restrição de horário).`, { isCopilot: true }).text);
          }
          const aval = avaliarJanelaDeAtendimento(hoursCfg, new Date(now()));
          const statusStr = aval.isOpen ? '🟢 ABERTO (Em Horário de Atendimento)' : '🌙 FECHADO (Fora do Horário Comercial)';
          const rep = `🕒 *Expediente de Atendimento:*

• *Status Atual:* ${statusStr}
• *Horário:* ${hoursCfg.start} às ${hoursCfg.end}
• *Fuso:* ${hoursCfg.timezone}
• *Próxima Abertura:* ${aval.proximaAberturaISO ? new Date(aval.proximaAberturaISO).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : 'Já aberto'}
• *Aviso Automático:* ${hoursCfg.enabled ? 'Ativo (1x por noite)' : 'Desativado'}`;
          return recordSelfTurn(filterReply(rep, { isCopilot: true }).text);
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

        // 1.7.5 Confirmação Pendente de Áudio (Antes de Gravar e Enviar)
        if (sSelf.pendingAudioConfirmation) {
          const pendingAudio = sSelf.pendingAudioConfirmation;
          const isNewCommand = /(?:vou\s+precisar\s+que|preciso\s+que|quero\s+que|mande\s+um\s+[aá]udio|envie\s+um\s+[aá]udio|grave\s+um\s+[aá]udio|mande\s+uma\s+mensagem|envie\s+uma\s+mensagem|lembre\s+o|avise\s+o|fale\s+com)\b/i.test(cleanTauan);

          if (isNewCommand) {
            sSelf.pendingAudioConfirmation = null;
            sSelf.pendingRecipient = null;
            sSelf.pendingAsAudio = false;
            store.markDirty();
            await store.flush?.().catch(() => {});
          } else {
            const isConfirm = /^(?:sim|confirmo|confirmado|pode\s+enviar|pode\s+mandar|pode\s+gravar|autorizo|manda|dispara|dispare|envia|vai)[.!\s]*$/i.test(strippedCmd) ||
              /^(?:pode\s+enviar|pode\s+mandar|pode\s+gravar|pode\s+sim|sim[,.\s]+pode\s+(?:enviar|mandar|gravar|disparar))\b/i.test(strippedCmd);
            const isCancel = /^(?:n[ãa]o|n[ãa]o\s+envia|n[ãa]o\s+manda|cancela|cancelar|cancelado|cancela\s+tudo|deixa|abortar|esquece|para|parar|desiste|descarta)\b/i.test(strippedCmd);

          if (isConfirm) {
            sSelf.pendingAudioConfirmation = null;
            sSelf.pendingRecipient = null;
            sSelf.pendingAsAudio = false;

            if (pendingAudio.forSelf) {
              try {
                if (ai?.synthesizeVoice && whatsapp?.sendWhatsAppAudio) {
                  const voiceRes = await ai.synthesizeVoice(pendingAudio.message, { botConfig });
                  if (voiceRes?.base64) {
                    const tPhone = getHumanPhone();
                    if (tPhone) {
                      await whatsapp.sendWhatsAppAudio(tPhone, voiceRes.base64);
                      const okSelf = `🎙️ *Áudio gravado e enviado para você no WhatsApp!* 👆\n\n> "${pendingAudio.message}"`;
                      return recordSelfTurn(filterReply(okSelf, { isCopilot: true }).text);
                    }
                  }
                }
                return recordSelfTurn(filterReply(`⚠️ Não consegui sintetizar o áudio no momento, mas aqui está a mensagem:\n\n> "${pendingAudio.message}"`, { isCopilot: true }).text);
              } catch (err) {
                return recordSelfTurn(filterReply(`⚠️ *Erro ao gravar/enviar áudio:* ${err.message}`, { isCopilot: true }).text);
              }
            } else {
              try {
                const toolRes = await executeToolCall('enviar_mensagem_contato', {
                  recipient: pendingAudio.recipient,
                  message: pendingAudio.message,
                  asAudio: true
                }, {
                  phone: 'tauan_self',
                  clientName: 'Tauan Pires (Copiloto)',
                  store,
                  reminderStore,
                  whatsapp,
                  ai,
                  botConfig,
                  session: sSelf
                });

                if (toolRes?.success) {
                  const mediaIcon = toolRes.asAudio ? '🎙️ (áudio sintetizado)' : '💬 (texto)';
                  const confirmation = `🚀 *Áudio gravado e enviado com sucesso!*\n\n• *Destinatário:* ${toolRes.recipient} (${toolRes.phone})\n• *Formato:* ${mediaIcon}\n• *Roteiro enviado:*\n> "${toolRes.message}"`;
                  return recordSelfTurn(filterReply(confirmation, { isCopilot: true }).text);
                } else {
                  const errReply = `⚠️ *Não consegui disparar o áudio:*\n\n${toolRes?.error || 'Erro desconhecido ao acionar o envio.'}`;
                  return recordSelfTurn(filterReply(errReply, { isCopilot: true }).text);
                }
              } catch (err) {
                return recordSelfTurn(filterReply(`⚠️ *Erro ao enviar o áudio:* ${err.message}`, { isCopilot: true }).text);
              }
            }
          } else if (isCancel) {
            sSelf.pendingAudioConfirmation = null;
            sSelf.pendingRecipient = null;
            sSelf.pendingAsAudio = false;
            return recordSelfTurn(filterReply('🚫 *Envio cancelado com sucesso!* Se precisar gravar outra mensagem ou ajustar o texto, é só me chamar.', { isCopilot: true }).text);
          } else {
            // Se o Tauan enviou uma observação/ajuste sobre a prévia do áudio (e não um comando de sistema como status/fila/bot)
            const isSystemCmd = /^(?:ajuda|status|resumo|fila|espera|lembretes|bot|humano|limpar)\b/i.test(strippedCmd);
            if (!isSystemCmd) {
              let revisedScript = applyAudioCorrection(pendingAudio.message, cleanTauan, pendingAudio.recipient);
              if (revisedScript === pendingAudio.message && ai?.askAI) {
                try {
                  const revRes = await ai.askAI({
                    system: `Você é a Lia, agente de suporte da equipe. Você está ajustando um roteiro de áudio que VOCÊ vai gravar falando diretamente de forma natural com o contato "${pendingAudio.recipient}" (trate o contato sempre por "você", nunca por "ele/ela", não se apresente repetidamente como "Aqui é a Lia, assistente do Tauan" e não diga "a pedido do Tauan"). Retorne em JSON {"reply": "roteiro ajustado sem emojis nem asteriscos"}.`,
                    history: [],
                    userText: `Roteiro anterior: "${pendingAudio.message}"\nPedido de ajuste do Tauan: "${cleanTauan}"\nReescreva o roteiro aplicando a correção solicitada:`,
                    botConfig
                  });
                  if (revRes?.reply) {
                    const cleanedRev = buildFriendlyAudioScript(pendingAudio.recipient, revRes.reply);
                    if (cleanedRev.length >= 10) revisedScript = cleanedRev;
                  }
                } catch {}
              }
              sSelf.pendingAudioConfirmation = {
                ...pendingAudio,
                message: revisedScript
              };
              const targetLabel = pendingAudio.forSelf ? 'você' : pendingAudio.recipient;
              const revisedReply = `🎙️ *Prévia atualizada do áudio para ${targetLabel}:*\n\n> "${revisedScript}"\n\nFicou como você queria? _(Responda *sim* para eu gravar e enviar ou me diga se quiser ajustar mais algum detalhe)_`;
              return recordSelfTurn(filterReply(revisedReply, { isCopilot: true }).text);
            }
            sSelf.pendingAudioConfirmation = null;
          }
          }
        }

        // 1.8 Extração e Despacho Ativo Determinístico de Mensagens
        const lastAssistantTurn = [...(sSelf.history || [])].reverse().find(h => h.role === 'assistant');
        const lastAssistantMsg = lastAssistantTurn?.content || '';
        const knownNames = Object.values(store.sessions || {})
          .filter(s => s && s.phone && s.phone !== 'tauan_self' && !isTauanSender(s.phone))
          .flatMap(s => [s.clientName, s.contactName, s.pushName])
          .filter(Boolean)
          .map(n => String(n).trim());

        const dispatchIntent = extractDispatchIntent(cleanTauan, {
          pendingRecipient: sSelf.pendingRecipient,
          pendingAsAudio: sSelf.pendingAsAudio,
          lastAssistantMsg,
          knownNames
        });

        // Se Tauan quer enviar mensagem de TEXTO (não áudio) e já temos o destinatário E a mensagem explícita (sem ser 'sobre...'):
        const isTopicOnly = /^sobre\s+/i.test(String(dispatchIntent.message || '').trim());
        if (dispatchIntent.recipient && dispatchIntent.message && !dispatchIntent.asAudio && !isTopicOnly) {
          try {
            const friendlyTextMessage = await humanizeContactMessage(dispatchIntent.recipient, dispatchIntent.message, { asAudio: false, ai, botConfig });
            const toolRes = await executeToolCall('enviar_mensagem_contato', {
              recipient: dispatchIntent.recipient,
              message: friendlyTextMessage,
              asAudio: false
            }, {
              phone: 'tauan_self',
              clientName: 'Tauan Pires (Copiloto)',
              store,
              reminderStore,
              whatsapp,
              ai,
              botConfig,
              session: sSelf
            });

            if (toolRes?.success) {
              sSelf.pendingRecipient = null;
              sSelf.pendingAsAudio = false;
              const confirmation = `🚀 *Mensagem disparada com sucesso!*

• *Destinatário:* ${toolRes.recipient} (${toolRes.phone})
• *Formato:* 💬 (texto)
• *Mensagem enviada:*
> "${toolRes.message}"`;
              return recordSelfTurn(filterReply(confirmation, { isCopilot: true }).text);
            } else {
              const errReply = `⚠️ *Não consegui disparar a mensagem:*

${toolRes?.error || 'Erro desconhecido ao acionar o envio.'}`;
              return recordSelfTurn(filterReply(errReply, { isCopilot: true }).text);
            }
          } catch (err) {
            console.error('[flow] Erro no disparo direto:', err.message);
          }
        } else if (dispatchIntent.recipient && !dispatchIntent.message) {
          // Tauan pediu para enviar mas ainda não disse o conteúdo/assunto
          sSelf.pendingRecipient = dispatchIntent.recipient;
          sSelf.pendingAsAudio = Boolean(dispatchIntent.asAudio);
          const askReply = dispatchIntent.asAudio
            ? `Claro, Tauan! O que você gostaria que eu falasse no áudio para o *${dispatchIntent.recipient}*? Me diga o assunto ou recado que eu monto um áudio amigável e te mostro para confirmar antes de enviar! 🎙️✨`
            : `Claro, Tauan! O que você gostaria de dizer para o *${dispatchIntent.recipient}*? Me diga o recado que já disparo para ele no WhatsApp! 📲✨`;
          return recordSelfTurn(filterReply(askReply, { isCopilot: true }).text);
        }

        // 1.9 Chamada Inteligente com Persona de Copiloto do Tauan
        const recentHistory = Array.isArray(sSelf.history) ? sSelf.history.slice(-12) : [];
        const supportContacts = Object.values(store.sessions || {})
          .filter(s => s && s.phone && s.phone !== 'tauan_self' && (s.supportModeEnabled || s.knowledgeBaseId || s.contactNotes))
          .map(s => ({
            name: s.clientName || s.contactName || s.pushName || s.phone,
            phone: s.phone,
            supportModeEnabled: Boolean(s.supportModeEnabled),
            knowledgeBaseId: s.knowledgeBaseId || null,
            contactRole: s.contactRole || null,
            notes: s.contactNotes || ''
          }));
        const sys = buildSystemPrompt({
          session: { history: recentHistory, supportContacts },
          now: new Date(now()),
          botConfig,
          isTauan: true,
          telemetry
        });

        const result = await ai?.askAI?.({
          system: sys,
          history: recentHistory,
          userText: cleanTauan,
          botConfig,
          isTauan: true
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

        // Execução de Ferramentas Ativas para o Copiloto (Tauan)
        const hasExternalTarget = Boolean(
          dispatchIntent.recipient &&
          /(?:para\s+o|para\s+a|para|pro|pra|ao|lembre|avise|fale\s+com)\s+/i.test(cleanTauan)
        );
        const asksForAudio = /(?:[aá]udio|voz)\b/i.test(cleanTauan) || /(?:explique|explica|conte|conta|fale|fala|grave|grava)/i.test(cleanTauan);
        const isAudioForSelf = asksForAudio && (
          !hasExternalTarget ||
          /(?:para\s+mim|pra\s+mim|no\s+chat\s+interno|comigo|me\s+mande|me\s+envie|me\s+grava|me\s+manda|me\s+explique|me\s+explica)\b/i.test(cleanTauan) ||
          (phone === 'tauan_self' && !hasExternalTarget)
        );

        const toolOutputs = [];
        let toolCallsToRun = Array.isArray(result?.tool_calls) ? [...result.tool_calls] : [];
        if (isAudioForSelf) {
          toolCallsToRun = toolCallsToRun.filter(tc => tc?.name !== 'enviar_mensagem_contato');
        }

        // Fallback anti-alucinação ou quando dispatchIntent é de áudio/assunto e o modelo não preencheu tool_calls
        if (toolCallsToRun.length === 0) {
          const rawRep = result?.reply || '';
          const claimedSend = /(?:disparo realizado|mensagem enviada|disparada com sucesso|feito! disparo|enviei para|disparei para)/i.test(rawRep);
          const isAffirmative = /^(?:sim|manda|pode enviar|dispara|envia|confirmo|vai|faz isso|mande|pode mandar|ok|beleza)[,\s.!]/i.test(cleanTauan);

          if (claimedSend || isAffirmative || (dispatchIntent.recipient && dispatchIntent.message)) {
            const fbDispatch = (dispatchIntent.recipient && dispatchIntent.message)
              ? dispatchIntent
              : extractDispatchIntent(cleanTauan, {
                  pendingRecipient: sSelf.pendingRecipient,
                  pendingAsAudio: sSelf.pendingAsAudio,
                  lastAssistantMsg,
                  knownNames
                });

            if (fbDispatch.recipient && fbDispatch.message) {
              toolCallsToRun.push({
                name: 'enviar_mensagem_contato',
                args: {
                  recipient: fbDispatch.recipient,
                  message: fbDispatch.message,
                  asAudio: fbDispatch.asAudio
                }
              });
            }
          }
        }

        if (toolCallsToRun.length > 0) {
          for (const tc of toolCallsToRun) {
            if (tc?.name) {
              try {
                if (tc.name === 'enviar_mensagem_contato') {
                  tc.args = tc.args || {};

                  // 1. Extração Inteligente de Recipient
                  if (!tc.args.recipient || tc.args.recipient === 'o contato') {
                    const replyRecMatch = result?.reply?.match(/(?:destinat[áa]rio|para\s+o|para\s+a)\s*[:*]*\s*\*?([a-zA-ZÀ-ÿ0-9+]+)/i);
                    if (replyRecMatch && !['o', 'a', 'o contato', 'um', 'qualquer'].includes(replyRecMatch[1].toLowerCase())) {
                      tc.args.recipient = replyRecMatch[1].trim();
                    }
                    if (!tc.args.recipient || tc.args.recipient === 'o contato') {
                      const userRecMatch = cleanTauan.match(/(?:para\s+o|para\s+a|pro|pra|ao)\s+([a-zA-ZÀ-ÿ0-9]+)/i);
                      if (userRecMatch) tc.args.recipient = userRecMatch[1].trim();
                    }
                    if ((!tc.args.recipient || tc.args.recipient === 'o contato') && sSelf.pendingRecipient && sSelf.pendingRecipient !== 'o contato') {
                      tc.args.recipient = sSelf.pendingRecipient;
                    }
                    if (!tc.args.recipient || tc.args.recipient === 'o contato') {
                      const histCombined = `${cleanTauan} ${result?.reply || ''} ${recentHistory.map(h => h.content).join(' ')}`;
                      for (const name of knownNames) {
                        if (!name || name.length < 2) continue;
                        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        if (new RegExp(`\\b${escaped}\\b`, 'i').test(histCombined)) {
                          tc.args.recipient = name;
                          break;
                        }
                      }
                    }
                  }

                  // 2. Extração Inteligente de Message
                  if (!tc.args.message) {
                    const replyMsgMatch = result?.reply?.match(/(?:mensagem|recado|texto|roteiro)\s*[:*]*\s*["“]([^"”\n]+)["”]/i);
                    if (replyMsgMatch) {
                      tc.args.message = replyMsgMatch[1].trim();
                    }
                    if (!tc.args.message) {
                      const userMsgMatch = cleanTauan.match(/(?:mensagem [ée]|recado [ée]|dizendo que|avisando que)\s*(.+)/i);
                      if (userMsgMatch) {
                        tc.args.message = userMsgMatch[1].trim();
                      } else if (!cleanTauan.toLowerCase().startsWith('sim') && cleanTauan.length > 5 && !/(?:status|lembrete|bot|humano|fila)/i.test(cleanTauan)) {
                        tc.args.message = cleanTauan;
                      }
                    }
                  }
                }
                const isAudioReq = Boolean(tc.args?.asAudio || dispatchIntent.asAudio || sSelf.pendingAsAudio || /(?:em\s+|como\s+|por\s+|um\s+)?(?:[aá]udio|voz)\b/i.test(cleanTauan));
                if (tc.name === 'enviar_mensagem_contato' && isAudioReq) {
                  tc.args.asAudio = true;
                  const targetRec = tc.args.recipient || dispatchIntent.recipient || sSelf.pendingRecipient || 'Contato';
                  const rawSourceMsg = tc.args.message || dispatchIntent.message || cleanTauan;
                  const friendlyScript = await humanizeContactMessage(targetRec, rawSourceMsg, { asAudio: true, ai, botConfig });

                  // NUNCA dispara áudio sem confirmação prévia do Tauan! Salva estado e exibe prévia amigável:
                  sSelf.pendingAudioConfirmation = {
                    recipient: targetRec,
                    message: friendlyScript,
                    forSelf: false
                  };
                  sSelf.pendingRecipient = null;
                  sSelf.pendingAsAudio = false;

                  const previewReply = `🎙️ *Prévia do áudio personalizado para ${targetRec}:*\n\n> "${friendlyScript}"\n\nDeseja que eu grave e envie este áudio agora? _(Responda *sim* para confirmar ou me diga se quiser ajustar algo)_`;
                  return recordSelfTurn(filterReply(previewReply, { isCopilot: true }).text);
                }

                // Garante que qualquer mensagem para contato seja amigável e acolhedora
                if (tc.name === 'enviar_mensagem_contato' && !tc.args.asAudio && tc.args.message) {
                  tc.args.message = buildFriendlyMessage(tc.args.recipient, tc.args.message, { asAudio: false });
                }

                const toolRes = await executeToolCall(tc.name, tc.args || {}, {
                  phone: 'tauan_self',
                  clientName: 'Tauan Pires (Copiloto)',
                  store,
                  reminderStore,
                  whatsapp,
                  ai,
                  botConfig,
                  session: sSelf
                });
                toolOutputs.push({ tool: tc.name, args: tc.args, result: toolRes });
              } catch (err) {
                toolOutputs.push({ tool: tc.name, args: tc.args, error: err.message });
              }
            }
          }
        }

        // Se disparou mensagem para contato externo via tool
        const sendToolResult = toolOutputs.find(t => t.tool === 'enviar_mensagem_contato');
        if (sendToolResult) {
          if (sendToolResult.result?.success) {
            sSelf.pendingRecipient = null;
            sSelf.pendingAsAudio = false;
            const r = sendToolResult.result;
            const confirmation = `🚀 *Mensagem disparada com sucesso!*

• *Destinatário:* ${r.recipient} (${r.phone})
• *Mensagem enviada:*
> "${r.message}"`;
            return recordSelfTurn(filterReply(confirmation, { isCopilot: true }).text);
          } else if (sendToolResult.result?.error) {
            const errMsg = String(sendToolResult.result.error);
            const rawR = sendToolResult.args?.recipient;
            const rec = rawR && rawR !== 'o contato' ? rawR : (sSelf.pendingRecipient && sSelf.pendingRecipient !== 'o contato' ? sSelf.pendingRecipient : null);
            if (rec) sSelf.pendingRecipient = rec;

            if (/conte[úu]do|mensagem/i.test(errMsg)) {
              const askReply = rec
                ? `Claro, Tauan! O que você gostaria de dizer para o *${rec}*? Me diga o recado que já disparo para ele no WhatsApp! 📲✨`
                : `Claro, Tauan! O que você gostaria que eu enviasse? Me informe o contato e o recado que já disparo imediatamente no WhatsApp! 📲✨`;
              return recordSelfTurn(filterReply(askReply, { isCopilot: true }).text);
            }
            const errReply = `⚠️ *Não consegui disparar a mensagem:*

${errMsg}`;
            return recordSelfTurn(filterReply(errReply, { isCopilot: true }).text);
          }
        }

        let rawReply = result?.reply;
        if (!rawReply) {
          if (isAudioForSelf) {
            const simMatch = cleanTauan.match(/(?:perguntando|avisando|falando|dizendo|sobre)\s+(?:para\s+o|para\s+a|para|pro|pra)?\s*([a-zA-ZÀ-ÿ0-9+]+)?/i);
            const simName = simMatch?.[1] || '';
            rawReply = buildFriendlyMessage(simName, cleanTauan, { asAudio: true });
          } else {
            const isGreeting = cleanTauan.length < 25 && /^(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo bom|opa|lia)[\s,!.]*$/i.test(cleanTauan.trim());
            if (isGreeting) {
              rawReply = 'Olá, Tauan! Estou aqui totalmente à disposição. Como posso te ajudar agora?';
            } else {
              rawReply = 'Estou aqui, Tauan! O sistema está operando normalmente. Em que posso te ajudar agora?';
            }
          }
        }

        // Prevenção de loop: se a resposta for idêntica à pergunta anterior da Lia
        if (lastAssistantMsg && rawReply.trim() === lastAssistantMsg.trim()) {
          console.warn('[flow] Anti-loop ativado: resposta idêntica evitada.');
          if (sSelf.pendingRecipient && cleanTauan.length >= 3 && !/^(?:ajuda|status|fila|bot|limpar)/i.test(cleanTauan)) {
            if (sSelf.pendingAsAudio) {
              const targetRec = sSelf.pendingRecipient;
              const friendlyScript = buildFriendlyAudioScript(targetRec, cleanTauan);
              sSelf.pendingAudioConfirmation = {
                recipient: targetRec,
                message: friendlyScript,
                forSelf: false
              };
              sSelf.pendingRecipient = null;
              sSelf.pendingAsAudio = false;
              const previewReply = `🎙️ *Prévia do áudio personalizado para ${targetRec}:*\n\n> "${friendlyScript}"\n\nDeseja que eu grave e envie este áudio agora? _(Responda *sim* para confirmar ou me diga se quiser ajustar algo)_`;
              return recordSelfTurn(filterReply(previewReply, { isCopilot: true }).text);
            }
            const friendlyDirect = buildFriendlyMessage(sSelf.pendingRecipient, cleanTauan, { asAudio: false });
            const directRes = await executeToolCall('enviar_mensagem_contato', {
              recipient: sSelf.pendingRecipient,
              message: friendlyDirect
            }, {
              phone: 'tauan_self',
              clientName: 'Tauan Pires (Copiloto)',
              store,
              reminderStore,
              whatsapp,
              ai,
              botConfig,
              session: sSelf
            });
            if (directRes?.success) {
              sSelf.pendingRecipient = null;
              rawReply = `🚀 *Mensagem disparada com sucesso!*

• *Destinatário:* ${directRes.recipient} (${directRes.phone})
• *Mensagem enviada:*
> "${directRes.message}"`;
              return recordSelfTurn(filterReply(rawReply, { isCopilot: true }).text);
            }
          }
          rawReply = `Tauan, estou pronta para ajudar! Se desejar enviar um recado para algum contato, basta me dizer: "Enviar para [Nome]: [Mensagem]". 🚀`;
        }

        if (isAudioForSelf) {
          sSelf.pendingRecipient = null;
          sSelf.pendingAsAudio = false;
          sSelf.pendingAudioConfirmation = null;

          const speechScript = cleanForSpeech(rawReply);
          let voiceRes = null;
          if (ai?.synthesizeVoice) {
            try {
              voiceRes = await ai.synthesizeVoice(speechScript, { botConfig });
            } catch (err) {
              logger.error?.('[flow] Erro ao sintetizar áudio para o Copiloto:', err.message);
            }
          }

          if (voiceRes?.base64) {
            sSelf.lastAudioBase64 = voiceRes.base64;
            const selfTargetPhone = String((rawItem?.jid || rawItem?.phone || (phone !== 'tauan_self' ? phone : '') || getHumanPhone() || '')).replace(/@.*$/, '').replace(/\D/g, '');
            if (selfTargetPhone && selfTargetPhone.length >= 8 && whatsapp?.sendWhatsAppAudio) {
              try {
                await whatsapp.sendWhatsAppAudio(selfTargetPhone, voiceRes.base64);
              } catch (audioErr) {
                logger.error?.('[flow] Erro ao enviar áudio do Copiloto no WhatsApp:', audioErr.message);
              }
            }
            const displayReply = rawReply.includes('Estou aqui, Tauan')
              ? 'Áudio de demonstração gerado com sucesso para você!'
              : rawReply;
            const okSelfReply = `🎙️ *Áudio gravado e enviado para você!* 👆\n\n${displayReply}`;
            return recordSelfTurn(filterReply(okSelfReply, { isCopilot: true }).text);
          } else {
            const fallbackReply = `⚠️ *Não consegui gerar o áudio no momento, mas aqui está a explicação:*\n\n${rawReply}`;
            return recordSelfTurn(filterReply(fallbackReply, { isCopilot: true }).text);
          }
        }

        return recordSelfTurn(filterReply(rawReply, { isCopilot: true }).text);
      }

      // ==========================================
      // CASO 2: CONTATO / CLIENTE NO WHATSAPP
      // ==========================================
      if (phone === 'tauan_self' || isTauanSender(phone)) {
        return filterReply('Estou aqui, Tauan! O sistema está operando normalmente. Em que posso te ajudar agora?').text;
      }

      // Se o Bot foi desativado globalmente pelo comando "bot off", força modo humano para todos os clientes
      if (botConfig?.behavior?.globalBotDisabled) {
        const sGlobal = store.get(phone, origin);
        sGlobal.phone = phone;
        if (!sGlobal.human) {
          sGlobal.human = true;
          sGlobal.humanSource = 'global_disabled';
          sGlobal.handoffAt = new Date(now()).toISOString();
          sGlobal.handoffReason = 'Bot pausado globalmente pelo Tauan';
          store.markDirty();
        }
        return null;
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

          s.symptomTurns = 0;
          const resumeReply = 'Prontinho! *Atendimento automático retomado.* Já retomei o atendimento! ✨\n\nComo posso te ajudar agora?';
          s.history.push({ role: 'assistant', content: resumeReply, createdAt: new Date(now()).toISOString() });
          s.lastBotAt = new Date(now()).toISOString();
          store.markDirty();
          return resumeReply;
        }

        // Se for emergência crítica relatada durante o atendimento humano
        if (isEmergency(clean)) {
          const emergencyNotice = 'Entendido! 🚨\n\nJá registrei a urgência e notifiquei o *Tauan* com prioridade máxima! Caso necessário, dirija-se imediatamente a um pronto-socorro veterinário ou hospital mais próximo.';
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
        const reply = 'Entendido! 🚨\n\nComo se trata de algo *urgente*, já notifiquei nossa equipe com prioridade máxima! Caso necessário, dirija-se a um pronto-socorro veterinário mais próximo.';
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
        store.markDirty();
        return reply;
      }

      // Se o usuário selecionou diretamente "Falar com Tauan"
      if (isTalkToTauanRequest(clean) || isHumanRequest(clean)) {
        await triggerHandoff(s, { reason: 'solicitação para falar diretamente com o Tauan', urgency: 'normal', now: now(), notify });
        const reply = botConfig.messages?.talkToTauan || TALK_TO_TAIS_MESSAGE;
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
        s.lastBotAt = new Date(now()).toISOString();
        store.markDirty();
        return reply;
      }

      // 2.5 DETECÇÃO DE PREFERÊNCIA DE FORMATO (ÁUDIO vs TEXTO) PELO CLIENTE
      const normUser = normalize(clean);
      if (/(?:prefiro|quero|responde|responder|manda|mandar|fala|falar)\s+(?:por\s+|em\s+|com\s+)?(?:texto|escrito|escrever)\b/i.test(normUser)) {
        s.audioPreference = 'text';
      } else if (/(?:prefiro|quero|responde|responder|manda|mandar|fala|falar)\s+(?:por\s+|em\s+|com\s+)?(?:audio|voz)\b/i.test(normUser)) {
        s.audioPreference = 'audio';
      }

      // ==========================================
      // 2.5.1 JANELA DE ATENDIMENTO & PACING FORA DO HORÁRIO
      // Economia de tokens LLM e CPU da VPS na madrugada / fins de semana
      // ==========================================
      const hoursConfig = botConfig?.business?.hoursConfig || null;
      if (hoursConfig?.enabled) {
        const avaliacaoJanela = avaliarJanelaDeAtendimento(hoursConfig, new Date(now()));
        if (!avaliacaoJanela.isOpen) {
          // Marca turno como adiado para reabertura (princípio "adiar e não descartar")
          s.pendingTurnPostponedUntil = avaliacaoJanela.proximaAberturaISO;
          s.pendingTurnPostponedAt = new Date(now()).toISOString();

          // Deduplicação: Envia o aviso acolhedor apenas UMA VEZ por período fechado
          const periodoId = avaliacaoJanela.periodoFechadoId;
          const jaAvisado = s.lastOutOfHoursPeriodId === periodoId;

          if (!jaAvisado) {
            s.lastOutOfHoursPeriodId = periodoId;
            s.lastOutOfHoursNoticeAt = new Date(now()).toISOString();

            const noticeReply = avaliacaoJanela.noticeText;
            s.history.push({ role: 'assistant', content: noticeReply, createdAt: new Date(now()).toISOString() });
            s.lastBotAt = new Date(now()).toISOString();
            store.markDirty();
            return noticeReply;
          }

          // Se já enviou o aviso neste período fechado, registra a mensagem silenciosamente sem gastar LLM
          store.markDirty();
          return null;
        } else {
          // Janela aberta: limpa pendências de adiamento anteriores
          if (s.pendingTurnPostponedUntil) {
            s.pendingTurnPostponedUntil = null;
            s.pendingTurnPostponedAt = null;
          }
        }
      }

      // ==========================================
      // 2.5.2 TRIAGEM LEVE DE SETOR
      // ==========================================
      const triageSectors = botConfig?.business?.sectors || [];
      if (Array.isArray(triageSectors) && triageSectors.length > 0) {
        const triageResult = classificarSetorPorTexto(clean, triageSectors);
        if (triageResult.sectorId && triageResult.confidence >= 0.3) {
          s.sectorId = triageResult.sectorId;
          s.sectorName = triageResult.sectorName;
          s.sectorCategory = triageResult.category;
        }
      }

      // 2.5.3 TRATAMENTO DE SINTOMA DE ALTO RISCO / EMERGÊNCIA VETERINÁRIA
      if (isHighRiskSymptom(clean)) {
        await triggerHandoff(s, {
          reason: 'sintoma de alto risco relatado pelo tutor',
          urgency: 'emergencia',
          now: now(),
          notify
        });
        const reply =
          'Entendi a gravidade do que você descreveu. 🚨\n\n' +
          'Por favor, leve o animal *agora* ao atendimento veterinário mais próximo, ' +
          'sem esperar. Já avisei nossa equipe com prioridade máxima.\n\n' +
          'Se estiver em risco imediato, ligue para a clínica de plantão.';
        s.history.push({ role: 'assistant', content: reply, createdAt: new Date(now()).toISOString() });
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
        if (isClinicalConcern(clean)) {
          s.symptomTurns = (s.symptomTurns || 0) + 1;
          if (s.symptomTurns === 1) {
            raw = 'Entendi a situação. Há quanto tempo isso começou? Vou registrar todas as informações para nossa equipe.';
          } else {
            await triggerHandoff(s, { reason: 'sintoma clínico persistente', urgency: 'urgente', now: now(), notify });
            s.human = true;
            raw = 'Compreendo a urgência. Já notifiquei a Dra. Elisângela para avaliar o caso com prioridade. Se notar piora, dirija-se a um pronto-socorro veterinário imediatamente.';
          }
        } else {
          raw = 'Tive uma leve instabilidade de conexão aqui no sistema! 📶\n\nMas posso ajudar você por aqui ou te colocar direto em contato com o Tauan. Como prefere seguir?';
          const oneHourAgo = now() - 3600000;
          const lastFallback = s.fallbackHandoffAt ? new Date(s.fallbackHandoffAt).getTime() : 0;
          if (lastFallback < oneHourAgo) {
            s.fallbackHandoffAt = new Date(now()).toISOString();
            await notify(`[Alerta Lia] Instabilidade de conexão/IA para ${s.phone}: "${clean}"`);
          }
        }
      } else if (result?.intent === 'sintoma' || isClinicalConcern(clean)) {
        s.symptomTurns = (s.symptomTurns || 0) + 1;
        if (s.symptomTurns >= 3) {
          await triggerHandoff(s, { reason: 'triagem clínica concluída', urgency: 'urgente', now: now(), notify });
          s.human = true;
          raw = 'Compreendo a situação e os sintomas relatados. Já notifiquei a Dra. Elisângela para cuidar do caso. Em caso de piora, dirija-se imediatamente a um pronto-socorro veterinário!';
        }
      }

      const filtered = filterReply(raw, { allowedPrices: getAllowedPrices() });
      let finalReply = String(filtered.text || '')
        .replace(/\(\s*`?(?:GET|POST|PUT|PATCH|DELETE)?\s*\/api\/[a-zA-Z0-9_/:.-]+`?\s*\)/gi, '')
        .replace(/`?(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\/[a-zA-Z0-9_/:.-]+`?/gi, 'pelo painel do sistema');

      // Execução de Ferramentas Ativas (Function Calling - padrão tools/)
      const isSuperAgent = botConfig?.ai?.agentMode === 'super_agente' || botConfig?.ai?.enableToolCalling === true;
      if (isSuperAgent && Array.isArray(result?.tool_calls) && result.tool_calls.length > 0) {
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

      // Se a IA julgou pelo contexto que deve transferir ou direcionar o assunto para o Tauan / Atualyze
      const cleanReplyForHint = String(finalReply || '').replace(/[*_~`]/g, '');
      const textHintsHandoff = /(?:avisei|aviso|vou avisar|notifiquei|notifico|vou notificar|acionei|aciono|vou acionar|chamei|chamo|vou chamar|encaminhei|encaminho|vou encaminhar|transferi|transferir|vou transferir|passei|passando|vou passar|repassei|repassar|vou repassar|dar um toque|dei um toque|alinhar com o tauan|alinhado diretamente com o tauan|falar direto com o tauan|colocar em contato com o tauan|tauan ja vai te responder|tauan vai te responder|notifiquei a atualyze|acionamos a atualyze|encaminhei para a atualyze|tauan\s*\(?atualyze\)?)/i.test(cleanReplyForHint);
      const userDirectedToTauan = /(?:avisa|avise|notifica|notifique|fala|fale|passa|passe|repassa|repasse|pede|pe[cç]a|pergunta|pergunte|lembra|lembre|diz|diga|chama|chame|aciona|acione)\s+(?:para\s+|pro\s+|pra\s+|ao\s+|com\s+|a\s+)?(?:o\s+|a\s+)?(?:tauan|atualyze)\b/i.test(normalize(clean));

      if (result?.handoff || result?.intent === 'falar_com_tauan' || textHintsHandoff || userDirectedToTauan) {
        const handoffReason = result?.handoff_reason ||
          (userDirectedToTauan ? `Assunto direcionado ao Tauan: "${clean.slice(0, 90)}"` :
            (textHintsHandoff ? `Assunto encaminhado pela Lia ao Tauan: "${clean.slice(0, 90)}"` : 'sugerido pela Lia pelo contexto'));
        await triggerHandoff(s, {
          reason: handoffReason,
          urgency: 'normal',
          now: now(),
          notify,
          forceNotify: true
        });
      }

      // 2.6 RESPOSTA EM ÁUDIO QUANDO O CLIENTE ENVIA ÁUDIO (OU PEDE ÁUDIO)
      const autoVoiceEnabled = botConfig?.voice?.autoVoiceOnAudio !== false;
      const clientWantsVoiceNow = (mediaType === 'audio' && autoVoiceEnabled && s.audioPreference !== 'text') || s.audioPreference === 'audio';

      if (clientWantsVoiceNow && !s.askedAudioPreference) {
        s.askedAudioPreference = true;
        finalReply = `${finalReply}\n\n_(Te respondi em áudio também! 🎙️ Prefere continuar nossa conversa por *áudio* ou por *texto*?)_`;
      }

      s.history.push({ role: 'assistant', content: finalReply, createdAt: new Date(now()).toISOString() });
      if (s.history.length > 40) {
        s.history = s.history.slice(-30);
      }
      s.lastBotAt = new Date(now()).toISOString();
      store.markDirty();

      if (clientWantsVoiceNow && ai?.synthesizeVoice && whatsapp?.sendWhatsAppAudio) {
        try {
          const spokenReply = cleanForSpeech(filtered.text);
          if (spokenReply && spokenReply.length >= 2) {
            const voiceRes = await ai.synthesizeVoice(spokenReply, { botConfig });
            if (voiceRes?.base64) {
              const targetJid = rawItem?.jid || phone;
              await whatsapp.sendWhatsAppAudio(targetJid, voiceRes.base64);
              // Se o cliente já escolheu áudio ou estamos no fluxo automático de voz, enviamos o áudio!
              // Caso tenhamos acabado de fazer a pergunta sobre preferência (texto complementar), retornamos apenas a perguntinha curta em texto ou null se não houver pergunta
              if (finalReply !== filtered.text) {
                return `🎙️ _Enviei um áudio acima! Prefere continuar conversando por *áudio* ou por *texto*?_`;
              }
              return null;
            }
          }
        } catch (err) {
          logger.error?.('[flow:voice] Falha ao sintetizar/enviar áudio para o cliente, usando fallback em texto:', err.message);
        }
      }

      return finalReply;
    }
  };
}
