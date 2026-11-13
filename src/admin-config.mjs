import fs from 'node:fs/promises';
import path from 'node:path';
import { BUSINESS } from './config.mjs';
import { FAQ, GREETING_MESSAGE, PLANS_DETAIL, RECOMMENDED_SERVICES_MESSAGE, POLICIES_MESSAGE, PAYMENT_MESSAGE } from './knowledge.mjs';
import { resumoJanelaDeAtendimento } from './business-hours.mjs';
export const clone = value => JSON.parse(JSON.stringify(value));
export const merge = (base, extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? clone(base) : clone(extra);
  const result = clone(base || {});
  for (const [key, value] of Object.entries(extra)) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(result[key] || {}, value) : clone(value);
  return result;
};

export function normalizeBotConfig(raw = {}) {
  const source = clone(raw && typeof raw === 'object' ? raw : {});
  if (typeof source.automation?.enableWebSearch === 'boolean') {
    source.webSearch = { ...(source.webSearch || {}), enabled: source.automation.enableWebSearch };
    delete source.automation.enableWebSearch;
  }
  return merge(DEFAULT_BOT_CONFIG, source);
}

export const DEFAULT_BOT_CONFIG = {
  schemaVersion: 1,
  identity: {
    botName: 'Lia',
    responsible: BUSINESS.responsible,
    companyName: BUSINESS.name,
    language: 'pt-BR',
    aliases: [],
    tone: 'Acolhedor, dinâmico e bem distribuído. Use parágrafos curtos, quebras de linha para arejar a leitura, destaques em *negrito* nos pontos-chave e marcadores ("• ") quando listar opções.'
  },
  business: {
    areas: BUSINESS.areas,
    hours: BUSINESS.hours,
    timezone: 'America/Sao_Paulo',
    hoursConfig: {
      enabled: false, // Por padrão desligado (24/7) até ser ativado pelo usuário no painel
      timezone: 'America/Sao_Paulo',
      start: '08:00',
      end: '18:00',
      weekdays: [1, 2, 3, 4, 5],
      outOfHoursNotice: 'Olá! Nosso horário de atendimento é de {dias}, das {inicio} às {fim}.\n\nJá registrei sua mensagem aqui e retornaremos com prioridade assim que o expediente iniciar! 🕒✨',
      autoResumeOnOpen: true
    }
  },
  messages: {
    greeting: GREETING_MESSAGE,
    plans: PLANS_DETAIL,
    services: RECOMMENDED_SERVICES_MESSAGE,
    policies: POLICIES_MESSAGE,
    payment: PAYMENT_MESSAGE
  },
  behavior: {
    allowClientResume: true,
    maxClinicalTurns: 3,
    handoffReminderMinutes: 15,
    inactivityStaleHours: 12,
    leadFollowUpEnabled: true,
    leadFollowUpMinHours: 24,
    leadFollowUpMaxHours: 72,
    fallbackMessage: 'Estou com uma pequena instabilidade no momento 🙏 Já avisei nossa equipe para dar continuidade ao seu atendimento.'
  },
  safety: {
    emergencyMessage: 'Entendido! Como se trata de algo urgente, vou transferir agora mesmo para nossa equipe humana te atender.',
    blockedMessage: 'Para esse tipo de solicitação, vou encaminhar diretamente para a nossa equipe te atender em detalhes.',
    protected: true
  },
  knowledge: {
    faq: FAQ.map(item => ({ keys: [...item.keys], answer: item.answer, enabled: true }))
  },
  ai: {
    systemInstruction: 'Seja prestativa e cordial. Distribua as respostas com parágrafos curtos, quebras de linha duplas e destaques pontuais em *negrito* para facilitar a leitura rápida no celular.',
    activeProvider: 'gemini',
    activeModel: 'gemini-3.8-flash',
    fallbackModels: ['nvidia/nemotron-3.5-lightning:free'],
    agentMode: 'super_agente',
    enableToolCalling: true,
    autoRouting: true,
    contextTurns: 24,
    maxStoredHistory: 100,
    maxOutputTokens: 2048,
    structuredOutputs: false,
    requireParameters: false,
    openrouterFreeOnly: true,
    pricingRates: [],
    monthlyBudgets: []
  },
  tools: { enabled: {} },
  webSearch: { enabled: true },
  automation: {
    enableMediaProcessing: true,
    enableProactiveFollowUp: true,
    businessHoursOnly: true,
    autoHandoffOnHumanPresence: true,
    maxDailyFollowUps: 30,
    followUpMinHours: 24,
    followUpMaxHours: 72,
    followUpTemplate: 'Oi! Tudo bem? Passando para saber se você conseguiu ver a proposta que conversamos.'
  },
  voice: {
    voiceName: 'Aoede', // 'Aoede' | 'Kore' | 'Leda' | 'Zephyr' | 'Puck' | 'Charon' | 'Fenrir'
    tone: 'Acolhedor, dinâmico e profissional',
    speed: 1.0,
    autoVoiceOnAudio: true,
    requestTimeoutMs: 45000
  },
  integrations: {
    googleCalendar: {
      enabled: true,
      timezone: 'America/Sao_Paulo',
      workdayStart: '08:00',
      workdayEnd: '18:00',
      slotDurationMinutes: 30,
      defaultEventDurationMinutes: 30,
      showMockSlotsWhenUnavailable: false
    }
  },
  human: {
    alertDestination: 'same_as_bot', // 'same_as_bot' | 'custom'
    phone: '',
    enabled: true
  }
};

const validate = (value, { requirePublishedAI = true } = {}) => {
  const errors = [];
  if (!value || typeof value !== 'object') return ['Configuração inválida.'];
  if (!value.identity?.botName?.trim()) errors.push('O nome do bot é obrigatório.');
  if (!value.identity?.companyName?.trim()) errors.push('O nome da empresa é obrigatório.');
  if (!value.messages?.greeting?.trim()) errors.push('A mensagem de saudação é obrigatória.');
  if (!Array.isArray(value.knowledge?.faq)) errors.push('A base de conhecimento precisa ser uma lista.');
  if (value.behavior?.leadFollowUpEnabled !== undefined && typeof value.behavior.leadFollowUpEnabled !== 'boolean') errors.push('A ativação do follow-up deve ser verdadeiro/falso.');
  const followUpMin = Number(value.behavior?.leadFollowUpMinHours);
  const followUpMax = Number(value.behavior?.leadFollowUpMaxHours);
  if (!Number.isFinite(followUpMin) || followUpMin < 1 || followUpMin > 720 || !Number.isFinite(followUpMax) || followUpMax <= followUpMin || followUpMax > 720) errors.push('A janela do follow-up deve ter mínimo de 1 hora e máximo maior que o mínimo, até 720 horas.');
  const providers = new Set(['gemini', 'openrouter', 'qwen', 'openai']);
  const provider = value.ai?.activeProvider || '';
  if (requirePublishedAI && (!provider || !providers.has(provider))) errors.push('Publique um provedor de IA válido no dashboard.');
  if (requirePublishedAI && !value.ai?.activeModel?.trim()) errors.push('Publique um modelo de IA no dashboard.');
  if (!Array.isArray(value.ai?.fallbackModels)) errors.push('Os modelos de fallback precisam ser uma lista.');
  else {
    if (value.ai.fallbackModels.length > 3) errors.push('Configure no máximo três modelos de fallback.');
    if (value.ai.fallbackModels.some(model => typeof model !== 'string' || !model.trim() || model.trim().length > 200)) errors.push('Cada modelo de fallback precisa ser um identificador válido de até 200 caracteres.');
    const normalizedFallbacks = value.ai.fallbackModels.filter(model => typeof model === 'string').map(model => model.trim());
    if (new Set(normalizedFallbacks).size !== normalizedFallbacks.length) errors.push('Não repita o mesmo modelo de fallback.');
    if (typeof value.ai?.activeModel === 'string' && normalizedFallbacks.includes(value.ai.activeModel.trim())) errors.push('O modelo principal não pode também constar como fallback.');
  }
  if (value.webSearch && typeof value.webSearch.enabled !== 'boolean') errors.push('A configuração da busca web precisa ser verdadeiro/falso.');
  if (value.tools?.enabled && (typeof value.tools.enabled !== 'object' || Array.isArray(value.tools.enabled) || Object.values(value.tools.enabled).some(item => typeof item !== 'boolean'))) errors.push('O catálogo de ferramentas deve conter somente estados verdadeiro/falso.');
  if (!['assistente', 'super_agente'].includes(value.ai?.agentMode)) errors.push('O modo do agente precisa ser assistente ou super_agente.');
  if (typeof value.ai?.enableToolCalling !== 'boolean') errors.push('A ativação de chamadas de ferramentas deve ser verdadeiro/falso.');
  if (typeof value.ai?.autoRouting !== 'boolean') errors.push('O roteamento automático deve ser verdadeiro/falso.');
  if (typeof value.ai?.openrouterFreeOnly !== 'boolean') errors.push('O filtro de modelos gratuitos do OpenRouter deve ser verdadeiro/falso.');
  if (!Number.isInteger(value.ai?.contextTurns) || value.ai.contextTurns < 4 || value.ai.contextTurns > 100) errors.push('O contexto enviado à IA deve ter entre 4 e 100 turnos.');
  if (!Number.isInteger(value.ai?.maxStoredHistory) || value.ai.maxStoredHistory < 20 || value.ai.maxStoredHistory > 500) errors.push('O histórico armazenado deve ter entre 20 e 500 registros.');
  const automationBooleanFields = ['enableMediaProcessing', 'enableProactiveFollowUp', 'businessHoursOnly', 'autoHandoffOnHumanPresence'];
  if (automationBooleanFields.some(field => typeof value.automation?.[field] !== 'boolean')) errors.push('As opções operacionais da Lia devem ser verdadeiro/falso.');
  const operationMin = Number(value.automation?.followUpMinHours);
  const operationMax = Number(value.automation?.followUpMaxHours);
  if (!Number.isFinite(operationMin) || operationMin < 1 || operationMin > 719 || !Number.isFinite(operationMax) || operationMax <= operationMin || operationMax > 720) errors.push('A janela operacional do follow-up deve ter mínimo de 1 hora e máximo maior que o mínimo, até 720 horas.');
  if (!Number.isInteger(value.automation?.maxDailyFollowUps) || value.automation.maxDailyFollowUps < 0 || value.automation.maxDailyFollowUps > 10000) errors.push('O limite diário de follow-ups deve ser um inteiro entre 0 e 10000.');
  if (typeof value.automation?.followUpTemplate !== 'string' || value.automation.followUpTemplate.length > 2000) errors.push('O texto do follow-up deve ter até 2000 caracteres.');
  const supportedVoices = new Set(['Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir']);
  if (!supportedVoices.has(value.voice?.voiceName)) errors.push('Selecione uma voz suportada.');
  if (typeof value.voice?.tone !== 'string' || value.voice.tone.length > 500) errors.push('O tom da voz deve ter até 500 caracteres.');
  if (typeof value.voice?.autoVoiceOnAudio !== 'boolean') errors.push('A resposta automática em áudio deve ser verdadeiro/falso.');
  if (!Number.isInteger(value.voice?.requestTimeoutMs) || value.voice.requestTimeoutMs < 5000 || value.voice.requestTimeoutMs > 120000) errors.push('O timeout de áudio deve estar entre 5 e 120 segundos.');
  const calendar = value.integrations?.googleCalendar;
  if (!calendar || typeof calendar !== 'object' || Array.isArray(calendar)) errors.push('A configuração do Google Calendar é obrigatória.');
  else {
    if (typeof calendar.enabled !== 'boolean') errors.push('A integração do Google Calendar deve ser verdadeiro/falso.');
    if (typeof calendar.timezone !== 'string' || !calendar.timezone.trim()) errors.push('O fuso horário do Google Calendar é obrigatório.');
    if (!Number.isInteger(calendar.slotDurationMinutes) || calendar.slotDurationMinutes < 5 || calendar.slotDurationMinutes > 240) errors.push('A duração dos slots deve estar entre 5 e 240 minutos.');
    if (!Number.isInteger(calendar.defaultEventDurationMinutes) || calendar.defaultEventDurationMinutes < 5 || calendar.defaultEventDurationMinutes > 480) errors.push('A duração padrão de eventos deve estar entre 5 e 480 minutos.');
    if (typeof calendar.showMockSlotsWhenUnavailable !== 'boolean') errors.push('A exibição de horários simulados deve ser verdadeiro/falso.');
  }
  const allowedProviders = new Set(['gemini', 'openrouter', 'qwen', 'openai']);
  const validNonNegativeAmount = amount => (typeof amount === 'number' || typeof amount === 'string') && String(amount).trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0;
  if (value.ai?.pricingRates !== undefined && (!Array.isArray(value.ai.pricingRates) || value.ai.pricingRates.length > 100 || value.ai.pricingRates.some(rate => !allowedProviders.has(rate?.provider) || typeof rate?.model !== 'string' || !rate.model.trim() || !validNonNegativeAmount(rate.inputUsdPerMillion) || !validNonNegativeAmount(rate.outputUsdPerMillion)))) errors.push('Tarifas precisam ser uma lista válida por provedor/modelo e valores USD por milhão de tokens.');
  if (value.ai?.monthlyBudgets !== undefined && (!Array.isArray(value.ai.monthlyBudgets) || value.ai.monthlyBudgets.length > 100 || value.ai.monthlyBudgets.some(budget => !Number.isFinite(Number(budget?.amountUsd)) || Number(budget.amountUsd) <= 0 || (budget.provider && !allowedProviders.has(budget.provider)) || (budget.model !== undefined && typeof budget.model !== 'string')))) errors.push('Limites mensais precisam ser valores USD positivos com provedor/modelo opcionais.');
  const alertDest = value.human?.alertDestination || 'same_as_bot';
  if (value.human?.enabled && alertDest === 'custom') {
    const rawDigits = String(value.human?.phone || '').replace(/\D/g, '');
    if (!rawDigits || rawDigits.length < 8 || rawDigits.length > 15) {
      errors.push('O telefone humano personalizado deve conter entre 8 e 15 dígitos.');
    }
  }
  const hoursErrors = validateHoursConfig(value.business?.hoursConfig);
  errors.push(...hoursErrors);
  return errors;
};

const HORA_RX = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
/**
 * Valida a janela de atendimento publicada pelo painel.
 * O motor continua fail-open em tempo de execução, mas o painel é fail-closed:
 * um horário inválido nunca chega a uma revisão publicada.
 */
function validateHoursConfig(hours) {
  const errors = [];
  if (hours === undefined || hours === null) return errors;
  if (typeof hours !== 'object' || Array.isArray(hours)) {
    return ['A janela de atendimento deve ser um objeto de configuração.'];
  }
  if (typeof hours.enabled !== 'boolean') errors.push('A ativação da janela de atendimento deve ser verdadeiro/falso.');
  if (hours.autoResumeOnOpen !== undefined && typeof hours.autoResumeOnOpen !== 'boolean') errors.push('A retomada automática na abertura deve ser verdadeiro/falso.');
  if (hours.outOfHoursNotice !== undefined && (typeof hours.outOfHoursNotice !== 'string' || hours.outOfHoursNotice.length > 2000)) errors.push('O aviso de fora do expediente deve ter até 2000 caracteres.');
  const timezone = typeof hours.timezone === 'string' ? hours.timezone.trim() : '';
  if (!timezone) errors.push('Informe o fuso horário da janela de atendimento.');
  if (hours.start !== undefined && !HORA_RX.test(String(hours.start))) errors.push('O início da janela deve estar no formato HH:MM (24 horas).');
  if (hours.end !== undefined && !HORA_RX.test(String(hours.end))) errors.push('O fim da janela deve estar no formato HH:MM (24 horas).');
  if (hours.weekdays !== undefined) {
    if (!Array.isArray(hours.weekdays)) errors.push('Os dias da janela devem ser uma lista.');
    else {
      const dias = hours.weekdays;
      if (dias.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Cada dia da janela deve ser um inteiro entre 0 (domingo) e 6 (sábado).');
      if (new Set(dias).size !== dias.length) errors.push('Não repita o mesmo dia da janela.');
    }
  }
  if (typeof hours.enabled === 'boolean' && hours.enabled) {
    if (!Array.isArray(hours.weekdays) || hours.weekdays.length === 0) errors.push('Selecione ao menos um dia de atendimento quando a janela estiver ativada.');
    const inicio = HORA_RX.test(String(hours.start ?? '')) ? Number(hours.start.slice(0, 2)) * 60 + Number(hours.start.slice(3)) : null;
    const fim = HORA_RX.test(String(hours.end ?? '')) ? Number(hours.end.slice(0, 2)) * 60 + Number(hours.end.slice(3)) : null;
    if (inicio !== null && fim !== null && fim <= inicio) errors.push('O fim da janela deve ser depois do início.');
    if (!timezone) errors.push('Informe um fuso horário válido para a janela ativada.');
    else {
      try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(new Date(0)); }
      catch { errors.push('O fuso horário da janela de atendimento não é válido.'); }
    }
    // Regra canônica do motor: se a própria janela considera a configuração corrompida, não publica.
    if (!errors.length && !resumoJanelaDeAtendimento(hours).enabled) errors.push('A janela de atendimento ativada precisa ter dias, início, fim e fuso consistentes.');
  }
  return errors;
}

export class AdminConfigStore {
  constructor(file = path.resolve('./data/bot-config.json'), { historyDir = path.resolve('./data/bot-config.history'), now = () => Date.now(), logger = console } = {}) {
    this.file = file;
    this.historyDir = historyDir;
    this.now = now;
    this.logger = logger;
    this.active = clone(DEFAULT_BOT_CONFIG);
    this.draft = clone(DEFAULT_BOT_CONFIG);
    this.revision = 0;
    this.updatedAt = null;
    this.history = [];
    this.saving = null;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.active = normalizeBotConfig(raw.active || {});
      this.draft = normalizeBotConfig(merge(this.active, raw.draft || {}));
      this.revision = Number(raw.revision) || 0;
      this.updatedAt = raw.updatedAt || null;
      this.history = Array.isArray(raw.history) ? raw.history.slice(-30) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.error?.(`[admin-config] arquivo inválido: ${error.message}`);
      await this.flush();
    }
    return this;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      revision: this.revision,
      updatedAt: this.updatedAt,
      active: clone(this.active),
      draft: clone(this.draft),
      history: clone(this.history.slice(-10)),
      // Prévia calculada no servidor: a tela não duplica a regra do expediente.
      // `hoursPreview` é o que está valendo; `hoursDraftPreview` é o que falta publicar.
      hoursPreview: resumoJanelaDeAtendimento(this.active.business?.hoursConfig, new Date(this.now())),
      hoursDraftPreview: resumoJanelaDeAtendimento(this.draft.business?.hoursConfig, new Date(this.now()))
    };
  }

  async updateDraft(patch = {}, actor = 'dashboard') {
    const previousDraft = clone(this.draft);
    const previousUpdatedAt = this.updatedAt;
    const previousHistory = clone(this.history);
    const next = normalizeBotConfig(merge(this.draft, patch));
    if (!String(next.ai?.activeModel || '').trim() && String(this.draft.ai?.activeModel || '').trim()) {
      next.ai.activeModel = this.draft.ai.activeModel;
    }
    const errors = validate(next, { requirePublishedAI: false });
    if (errors.length) return { ok: false, errors };
    this.draft = next;
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'draft_updated', actor, at: this.updatedAt });
    this.history = this.history.slice(-30);
    try {
      await this.flush();
      if (this.client?.enabled && this.persistence !== 'supabase') throw new Error(this.remoteError || 'Supabase não confirmou a gravação.');
    } catch (error) {
      this.draft = previousDraft;
      this.updatedAt = previousUpdatedAt;
      this.history = previousHistory;
      await this.flush().catch(() => {});
      return { ok: false, errors: [`Não foi possível confirmar a persistência do rascunho: ${error.message}`] };
    }
    return { ok: true, snapshot: this.snapshot(), persistence: this.persistence || 'fallback', persistenceError: this.remoteError || null };
  }

  async publish(actor = 'dashboard') {
    if (!String(this.draft.ai?.activeModel || '').trim() && String(this.active.ai?.activeModel || '').trim()) {
      this.draft.ai.activeModel = this.active.ai.activeModel;
    }
    const errors = validate(this.draft);
    if (errors.length) return { ok: false, errors };
    const previous = { active: clone(this.active), draft: clone(this.draft), revision: this.revision, updatedAt: this.updatedAt, history: clone(this.history) };
    this.revision += 1;
    this.active = clone(this.draft);
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'published', actor, at: this.updatedAt, snapshot: clone(this.active) });
    this.history = this.history.slice(-30);
    await this.flush();
    if (this.client?.enabled && this.persistence !== 'supabase') {
      Object.assign(this, previous);
      await this.flush().catch(() => {});
      return { ok: false, errors: [`Não foi possível confirmar a publicação no Supabase: ${this.remoteError || 'persistência indisponível'}`] };
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  async rollback(revision, actor = 'dashboard') {
    const target = this.history.find(item => Number(item.revision) === Number(revision) && item.snapshot);
    if (!target) return { ok: false, errors: ['Versão não encontrada para rollback.'] };
    const previous = { active: clone(this.active), draft: clone(this.draft), revision: this.revision, updatedAt: this.updatedAt, history: clone(this.history) };
    this.active = clone(target.snapshot);
    this.draft = clone(target.snapshot);
    this.revision += 1;
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'rollback', actor, at: this.updatedAt, sourceRevision: revision });
    await this.flush();
    if (this.client?.enabled && this.persistence !== 'supabase') {
      Object.assign(this, previous);
      await this.flush().catch(() => {});
      return { ok: false, errors: [`Não foi possível confirmar o rollback no Supabase: ${this.remoteError || 'persistência indisponível'}`] };
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  async flush() {
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const payload = { active: this.active, draft: this.draft, revision: this.revision, updatedAt: this.updatedAt, history: this.history };
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
      await fs.rename(tmp, this.file);
    };
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(write).finally(() => { this.saving = null; });
    return this.saving;
  }
}

export function validateBotConfig(value) { return validate(value); }
