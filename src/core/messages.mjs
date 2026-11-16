import { NEUTRAL_IDENTITY, normalizeName, resolveIdentity } from './identity.mjs';

/**
 * Mensagens padrão geradas a partir da identidade configurada.
 *
 * Regra de compatibilidade: uma mensagem salva no painel só vale como override
 * quando NÃO for um dos textos padrão conhecidos (atual, neutro ou legado).
 * Assim, ao trocar o nome do responsável, as mensagens que ainda estavam no
 * padrão antigo são regeneradas automaticamente.
 */

const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const ownerLabel = (identity, fallback = 'nossa equipe') => identity.responsible || fallback;

/**
 * Mensagens padrão neutras e dinâmicas, sempre derivadas da identidade publicada no painel.
 */

export function buildGreetingMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  const intro = identity.companyName
    ? `Sou a *${identity.botName}*, assistente de atendimento da *${identity.companyName}*.`
    : `Sou a *${identity.botName}*, sua assistente de atendimento.`;
  return `Oi! Tudo bem? 😊\n\n${intro}\n\nPor aqui posso:\n• Esclarecer dúvidas rápidas e adiantar seu atendimento\n• Conectar você diretamente com *${owner}*\n\nComo prefere seguir?`;
}

export function buildAtendimentoMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  return `Nosso atendimento automatizado ainda está sendo preparado com muito carinho! ☕✨\n\nEnquanto isso, eu posso:\n• *Anotar o seu recado* com os detalhes da sua necessidade\n• *Te colocar direto em contato* com *${owner}* agora mesmo\n\nQuer falar direto com *${owner}*?`;
}

export function buildTalkToOwnerMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  return `Combinado! 👍\n\nJá passei o aviso para *${owner}* com o resumo do que conversamos até aqui. 📲\n\n*${owner}* já vai te responder diretamente por este chat. Só um instante! ⏳`;
}

export function buildServicesMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  return `Por aqui posso:\n• Esclarecer dúvidas gerais\n• Anotar recados e solicitações\n• Te transferir direto para *${owner}*\n\nComo posso te ajudar agora?`;
}

export function buildPoliciesMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  return `Nosso horário padrão de atendimento é:\n📅 *${identity.hours}*.\n\nCaso mande mensagem fora desse período, pode deixar seu recado que *${owner}* te responde assim que visualizar!`;
}

export function buildPaymentMessage(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const owner = ownerLabel(identity);
  return `Questões sobre *valores, propostas e formas de pagamento* são alinhadas diretamente com *${owner}*.\n\nQuer que eu já avise *${owner}* agora para vocês conversarem?`;
}

const BUILDERS = {
  greeting: buildGreetingMessage,
  atendimento: buildAtendimentoMessage,
  talkToOwner: buildTalkToOwnerMessage,
  services: buildServicesMessage,
  policies: buildPoliciesMessage,
  payment: buildPaymentMessage
};

const MESSAGE_KEYS = {
  greeting: ['greeting'],
  atendimento: ['atendimento', 'atendimentoEmProgresso', 'plans'],
  talkToOwner: ['talkToOwner'],
  services: ['services', 'recommendedServices'],
  policies: ['policies'],
  payment: ['payment']
};

function isKnownDefault(value, kind, identity) {
  const candidate = compact(value);
  if (!candidate) return false;
  return [identity, NEUTRAL_IDENTITY].some(reference =>
    compact(BUILDERS[kind](reference)) === candidate
  );
}

/**
 * Resolve todas as mensagens padrão com overrides do painel.
 */
export function resolveMessages(botConfig = {}) {
  const identity = resolveIdentity(botConfig);
  const configured = botConfig?.messages || {};
  const result = {};

  for (const [kind, keys] of Object.entries(MESSAGE_KEYS)) {
    const custom = keys.map(key => configured[key]).find(value => typeof value === 'string' && value.trim());
    result[kind] = custom && !isKnownDefault(custom, kind, identity)
      ? custom
      : BUILDERS[kind](identity);
  }

  result.plans = result.atendimento;
  result.services = result.services;
  return result;
}

export function buildFaqItems(identityInput = {}) {
  const identity = resolveIdentity(identityInput);
  const responsibleKey = normalizeName(identity.responsible);
  const talkKeys = ['responsavel', 'falar com o responsavel', 'opcao 2', 'falar com ele'];
  if (responsibleKey) talkKeys.unshift(`falar com ${responsibleKey}`, responsibleKey);

  return [
    {
      keys: ['quem e voce', 'sobre a lia', 'o que voce faz'],
      answer: `Sou a *${identity.botName}*, assistente${identity.responsible ? ` de *${identity.responsible}*` : ' da equipe'}! 👋\n\nFaço a recepção por aqui, tiro dúvidas rápidas e conecto você direto com a equipe quando precisar.`
    },
    {
      keys: ['atendimento', 'opcao 1', 'modulo de atendimento'],
      answer: buildAtendimentoMessage(identity)
    },
    {
      keys: talkKeys,
      answer: buildTalkToOwnerMessage(identity)
    },
    {
      keys: ['horario', 'horarios', 'funcionamento', 'dias'],
      answer: `Nosso atendimento acontece:\n📅 *${identity.hours}*.\n\nFique à vontade para mandar sua mensagem!`
    }
  ];
}

/** Usado pelo painel para saber se o texto ainda é o padrão gerado. */
export function isGeneratedMessage(value, kind, identityInput = {}) {
  if (!BUILDERS[kind]) return false;
  return isKnownDefault(value, kind, resolveIdentity(identityInput));
}


