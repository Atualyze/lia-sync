import fs from 'node:fs/promises';
import path from 'node:path';
import { BUSINESS } from './config.mjs';
import { FAQ, GREETING_MESSAGE, PLANS_DETAIL, RECOMMENDED_SERVICES_MESSAGE, POLICIES_MESSAGE, PAYMENT_MESSAGE } from './knowledge.mjs';

export const clone = value => JSON.parse(JSON.stringify(value));
export const merge = (base, extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? clone(base) : clone(extra);
  const result = clone(base || {});
  for (const [key, value] of Object.entries(extra)) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(result[key] || {}, value) : clone(value);
  return result;
};

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
    maxOutputTokens: 2048,
    structuredOutputs: false,
    requireParameters: false,
    pricingRates: [],
    monthlyBudgets: []
  },
  tools: { enabled: {} },
  webSearch: { enabled: true },
  voice: {
    voiceName: 'Aoede', // 'Aoede' | 'Kore' | 'Leda' | 'Zephyr' | 'Puck' | 'Charon' | 'Fenrir'
    tone: 'Acolhedor, dinâmico e profissional',
    speed: 1.0,
    autoVoiceOnAudio: true
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
  const providers = new Set(['gemini', 'openrouter', 'qwen', 'openai']);
  const provider = value.ai?.activeProvider || '';
  if (requirePublishedAI && (!provider || !providers.has(provider))) errors.push('Publique um provedor de IA válido no dashboard.');
  if (requirePublishedAI && !value.ai?.activeModel?.trim()) errors.push('Publique um modelo de IA no dashboard.');
  if (!Array.isArray(value.ai?.fallbackModels)) errors.push('Os modelos de fallback precisam ser uma lista.');
  if (value.webSearch && typeof value.webSearch.enabled !== 'boolean') errors.push('A configuração da busca web precisa ser verdadeiro/falso.');
  if (value.tools?.enabled && (typeof value.tools.enabled !== 'object' || Array.isArray(value.tools.enabled) || Object.values(value.tools.enabled).some(item => typeof item !== 'boolean'))) errors.push('O catálogo de ferramentas deve conter somente estados verdadeiro/falso.');
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
  return errors;
};

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
      this.active = merge(DEFAULT_BOT_CONFIG, raw.active || {});
      this.draft = merge(this.active, raw.draft || {});
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
    return { schemaVersion: 1, revision: this.revision, updatedAt: this.updatedAt, active: clone(this.active), draft: clone(this.draft), history: clone(this.history.slice(-10)) };
  }

  updateDraft(patch = {}, actor = 'dashboard') {
    const next = merge(this.draft, patch);
    const errors = validate(next, { requirePublishedAI: false });
    if (errors.length) return { ok: false, errors };
    this.draft = next;
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'draft_updated', actor, at: this.updatedAt });
    this.history = this.history.slice(-30);
    this.flush().catch(error => this.logger.error?.(`[admin-config] ${error.message}`));
    return { ok: true, snapshot: this.snapshot() };
  }

  async publish(actor = 'dashboard') {
    const errors = validate(this.draft);
    if (errors.length) return { ok: false, errors };
    this.revision += 1;
    this.active = clone(this.draft);
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'published', actor, at: this.updatedAt, snapshot: clone(this.active) });
    this.history = this.history.slice(-30);
    await this.flush();
    return { ok: true, snapshot: this.snapshot() };
  }

  async rollback(revision, actor = 'dashboard') {
    const target = this.history.find(item => Number(item.revision) === Number(revision) && item.snapshot);
    if (!target) return { ok: false, errors: ['Versão não encontrada para rollback.'] };
    this.active = clone(target.snapshot);
    this.draft = clone(target.snapshot);
    this.revision += 1;
    this.updatedAt = new Date(this.now()).toISOString();
    this.history.push({ revision: this.revision, action: 'rollback', actor, at: this.updatedAt, sourceRevision: revision });
    await this.flush();
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
