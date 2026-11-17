import crypto from 'node:crypto';
import { json, readBody, NOT_HANDLED } from './utils.mjs';
import { config } from '../config.mjs';
import { validPhone } from '../dashboard.mjs';
import { sendText } from '../whatsapp.mjs';
import { filterReply } from '../safety.mjs';
import { getAllowedPrices } from '../faq.mjs';

const VALID_DEAL_STAGES = new Set(['lead', 'qualificado', 'agendado', 'proposta', 'ganho', 'perdido']);

// O `system` prompt publicado é a fonte canônica; sobrescrita pelo chamador é
// exceção explícita de operação, nunca o padrão.
const allowCustomSystem = () => process.env.LIA_API_ALLOW_CUSTOM_SYSTEM === 'true';

const nowIso = () => new Date().toISOString();

function extractApiKey(req) {
  const headerKey = String(req.headers['x-api-key'] || '').trim();
  if (headerKey) return headerKey;
  const authHeader = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) return authHeader.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function timingSafeMatch(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyApiKey(provided, configuredKeys) {
  if (!provided || !Array.isArray(configuredKeys) || configuredKeys.length === 0) return false;
  let matched = false;
  for (const key of configuredKeys) {
    if (timingSafeMatch(provided, key)) matched = true;
  }
  return matched;
}

function createApiRateLimiter(limitPerMin) {
  const buckets = new Map();
  return (identity) => {
    const now = Date.now();
    for (const [k, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(k);
    }
    const existing = buckets.get(identity);
    if (!existing) {
      buckets.set(identity, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, remaining: Math.max(0, limitPerMin - 1) };
    }
    if (existing.count >= limitPerMin) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }
    existing.count += 1;
    return { allowed: true, remaining: Math.max(0, limitPerMin - existing.count) };
  };
}

function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Lia Sync External API',
      version: '1.0.0',
      description: 'API REST autenticada por API Key para integrações externas (n8n, Make, sites, CRMs e ERPs).'
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        BearerAuth: { type: 'http', scheme: 'bearer' }
      }
    },
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    paths: {
      '/health': { get: { summary: 'Status de saúde da API e serviços' } },
      '/openapi.json': { get: { summary: 'Especificação OpenAPI 3.0' } },
      '/contacts/{phone}': {
        get: { summary: 'Consulta dados CRM e últimas mensagens de um contato' },
        patch: { summary: 'Atualiza nome, etapa do funil, interesse, notas ou modo humano' }
      },
      '/messages/send': { post: { summary: 'Envia mensagem WhatsApp respeitando supressão' } },
      '/leads': { post: { summary: 'Registra lead no CRM e opcionalmente envia saudação no WhatsApp' } },
      '/ai/ask': {
        post: {
          summary: 'Consulta direta ao motor de IA da Lia',
          description: [
            'A resposta é higienizada por `filterReply` antes de ser devolvida.',
            'Quando o filtro bloqueia o conteúdo (ex.: preço não autorizado), a resposta é `200` com `reply` vazio,',
            '`blocked: true` e a lista de `violations`; o texto bloqueado nunca é devolvido.',
            'O `system` prompt publicado no painel é a fonte canônica: o campo `system` do corpo é ignorado,',
            'salvo quando a instância habilita `LIA_API_ALLOW_CUSTOM_SYSTEM=true`.'
          ].join(' ')
        }
      }
    }
  };
}

function parsePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return validPhone(digits) ? digits : '';
}

function sanitizeContact(phone, session) {
  return {
    phone,
    name: session.clientName || session.contactName || session.pushName || null,
    dealStage: session.dealStage || null,
    productInterest: session.productInterest || null,
    notes: session.contactNotes || null,
    humanMode: Boolean(session.human),
    updatedAt: session.updatedAt || null,
    lastMessages: Array.isArray(session.history)
      ? session.history.slice(-20).map(m => ({
          role: m.role,
          text: String(m.content ?? ''),
          timestamp: m.createdAt ?? null
        }))
      : []
  };
}

/**
 * Roteador da API REST v1 (`/api/v1/*`) autenticada por `LIA_API_KEY` / `LIA_API_KEYS`.
 */
export function createApiV1Handler({
  apiKeys = config.apiV1Keys,
  rateLimitPerMin = config.apiV1RateLimitPerMin,
  sendMessage = sendText,
  askAIImpl = null,
  integrationsStore = null
} = {}) {
  const checkRate = createApiRateLimiter(rateLimitPerMin);

  return async function handleApiV1Routes({ req, res, u, store, adminConfig, runtimeAI, readinessCheck, askAI }) {
    if (!u.pathname.startsWith('/api/v1/')) return NOT_HANDLED;

    const envKeys = Array.isArray(apiKeys) ? apiKeys : [];
    const providedKey = extractApiKey(req);
    let keyMeta = null;
    if (verifyApiKey(providedKey, envKeys)) {
      keyMeta = { id: 'env', name: 'env', scopes: ['read', 'write', 'ai'] };
    } else if (integrationsStore && providedKey) {
      keyMeta = await integrationsStore.verifyKey(providedKey);
    }

    if (!keyMeta) {
      if (envKeys.length === 0 && !integrationsStore) {
        return json(res, 503, { ok: false, error: 'api_v1_not_configured', message: 'Configure LIA_API_KEY ou gere uma chave no painel.' });
      }
      return json(res, 401, { ok: false, error: 'unauthorized', message: 'API key ausente ou inválida.' });
    }

    const scopes = new Set(keyMeta.scopes || ['read', 'write', 'ai']);
    const rateKey = crypto.createHash('sha256').update(providedKey).digest('hex').slice(0, 16);
    const rate = checkRate(rateKey);
    if (!rate.allowed) {
      return json(res, 429, { ok: false, error: 'rate_limit_exceeded', retryAfterSeconds: rate.retryAfterSec });
    }

    const subPath = u.pathname.slice('/api/v1'.length);
    const requiredScope = subPath === '/ai/ask' ? 'ai' : (req.method === 'GET' ? 'read' : 'write');
    if (!scopes.has(requiredScope)) {
      return json(res, 403, { ok: false, error: 'insufficient_scope', requiredScope });
    }

    if (req.method === 'GET' && subPath === '/health') {
      const readiness = readinessCheck ? await readinessCheck() : { ok: true, checks: [] };
      return json(res, 200, {
        ok: true,
        api: 'v1',
        ready: Boolean(readiness?.ok),
        instance: config.evolutionInstance || null,
        checks: readiness?.checks || []
      });
    }

    if (req.method === 'GET' && subPath === '/openapi.json') {
      return json(res, 200, buildOpenApiSpec());
    }

    const contactMatch = subPath.match(/^\/contacts\/([^/]+)$/);
    if (contactMatch) {
      let rawPhone;
      try { rawPhone = decodeURIComponent(contactMatch[1]); } catch { return json(res, 400, { ok: false, error: 'invalid_phone' }); }
      const phone = parsePhone(rawPhone);
      if (!phone) return json(res, 400, { ok: false, error: 'invalid_phone' });

      if (req.method === 'GET') {
        await store.refresh?.();
        if (!store.has(phone)) return json(res, 404, { ok: false, error: 'contact_not_found' });
        const session = store.get(phone);
        if (!session) return json(res, 404, { ok: false, error: 'contact_not_found' });
        return json(res, 200, { ok: true, contact: sanitizeContact(phone, session) });
      }

      if (req.method === 'PATCH') {
        let body;
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'invalid_payload' });
        if (body.dealStage !== undefined && body.dealStage !== null && !VALID_DEAL_STAGES.has(String(body.dealStage))) {
          return json(res, 400, { ok: false, error: 'invalid_deal_stage', allowed: [...VALID_DEAL_STAGES] });
        }
        const session = store.ensure(phone);
        if (typeof body.name === 'string' && body.name.trim()) session.clientName = body.name.trim().slice(0, 120);
        if (typeof body.clientName === 'string' && body.clientName.trim()) session.clientName = body.clientName.trim().slice(0, 120);
        if (body.dealStage !== undefined) session.dealStage = body.dealStage ? String(body.dealStage) : null;
        if (typeof body.productInterest === 'string') session.productInterest = body.productInterest.trim().slice(0, 200);
        if (typeof body.notes === 'string') session.contactNotes = body.notes.trim().slice(0, 1000);
        if (typeof body.contactNotes === 'string') session.contactNotes = body.contactNotes.trim().slice(0, 1000);
        if (typeof body.humanMode === 'boolean') session.human = body.humanMode;
        session.updatedAt = nowIso();
        store.markDirty?.();
        await store.flush?.();
        const contact = sanitizeContact(phone, session);
        void integrationsStore?.dispatchEvent('lead.updated', { phone, contact }).catch(() => {});
        return json(res, 200, { ok: true, contact });
      }
    }

    if (req.method === 'POST' && subPath === '/messages/send') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      const phone = parsePhone(body?.phone);
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!phone) return json(res, 400, { ok: false, error: 'invalid_phone' });
      if (!message || message.length > 4000) return json(res, 400, { ok: false, error: 'invalid_message' });
      try {
        const result = await sendMessage(phone, message);
        store.append(phone, { role: 'assistant', content: message });
        await store.flush?.();
        return json(res, 200, { ok: true, phone, result: result || { sent: true } });
      } catch (err) {
        const msg = err?.message || 'send_failed';
        const status = /suppressed|opt-?out/i.test(msg) ? 409 : 502;
        return json(res, status, { ok: false, error: status === 409 ? 'contact_suppressed' : 'whatsapp_send_failed', message: msg });
      }
    }

    if (req.method === 'POST' && subPath === '/leads') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      const phone = parsePhone(body?.phone);
      if (!phone) return json(res, 400, { ok: false, error: 'invalid_phone' });

      const session = store.ensure(phone);

      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
      const interest = typeof body?.interest === 'string' ? body.interest.trim().slice(0, 200) : '';
      const source = typeof body?.source === 'string' ? body.source.trim().slice(0, 80) : '';
      const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 1000) : '';

      if (name) session.clientName = name;
      if (interest) session.productInterest = interest;
      if (!session.dealStage) session.dealStage = 'lead';
      const noteParts = [source ? `Origem: ${source}` : '', notes].filter(Boolean);
      if (noteParts.length) {
        session.contactNotes = [session.contactNotes, noteParts.join(' · ')].filter(Boolean).join('\n').slice(0, 1000);
      }
      session.updatedAt = nowIso();
      store.markDirty?.();

      let delivery = null;
      if (body?.sendGreeting === true) {
        const customText = typeof body?.message === 'string' ? body.message.trim() : '';
        const greeting = customText || `Olá${name ? `, ${name}` : ''}! Recebemos seu contato${interest ? ` sobre ${interest}` : ''}. Como posso te ajudar agora?`;
        try {
          delivery = await sendMessage(phone, greeting);
          store.append(phone, { role: 'assistant', content: greeting });
        } catch (err) {
          await store.flush?.();
          const msg = err?.message || 'send_failed';
          const status = /suppressed|opt-?out/i.test(msg) ? 409 : 502;
          return json(res, status, { ok: false, error: status === 409 ? 'contact_suppressed' : 'whatsapp_send_failed', message: msg, contact: sanitizeContact(phone, session) });
        }
      }

      await store.flush?.();
      const contact = sanitizeContact(phone, session);
      void integrationsStore?.dispatchEvent('lead.updated', { phone, contact, source: source || 'api_v1' }).catch(() => {});
      return json(res, 201, { ok: true, contact, sent: Boolean(delivery) });
    }

    if (req.method === 'POST' && subPath === '/ai/ask') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > 8000) return json(res, 400, { ok: false, error: 'invalid_prompt' });

      const aiFn = askAIImpl || askAI;
      if (typeof aiFn !== 'function') return json(res, 503, { ok: false, error: 'ai_unavailable' });

      const aiCfg = runtimeAI ? runtimeAI() : {};
      // O `system` publicado no painel é a fonte canônica. Sobrescrita pelo chamador
      // só existe com habilitação explícita da instância.
      const publishedSystem = adminConfig?.active?.identity?.systemPrompt || 'Você é a Lia, assistente virtual. Responda em português de forma clara e objetiva.';
      const system = allowCustomSystem() && typeof body?.system === 'string' && body.system.trim()
        ? body.system.trim().slice(0, 4000)
        : publishedSystem;
      const history = Array.isArray(body?.history) ? body.history.slice(-12) : [];

      try {
        const result = await aiFn({
          provider: aiCfg.provider,
          model: aiCfg.model,
          fallbackModels: aiCfg.fallbackModels,
          system,
          history,
          userText: prompt,
          maxTokens: Number.isFinite(Number(body?.maxTokens)) ? Math.min(2048, Math.max(64, Number(body.maxTokens))) : undefined
        });
        const filtered = filterReply(result?.text || '', { allowedPrices: getAllowedPrices(), strictPrices: true });
        if (filtered.blocked) {
          return json(res, 200, {
            ok: true,
            reply: '',
            blocked: true,
            violations: filtered.violations,
            provider: result?.provider || aiCfg.provider || null,
            model: result?.model || aiCfg.model || null
          });
        }
        return json(res, 200, {
          ok: true,
          reply: filtered.text || '',
          blocked: false,
          provider: result?.provider || aiCfg.provider || null,
          model: result?.model || aiCfg.model || null
        });
      } catch (err) {
        return json(res, 502, { ok: false, error: 'ai_call_failed', message: err?.message || 'Falha ao consultar IA.' });
      }
    }

    return json(res, 404, { ok: false, error: 'api_v1_endpoint_not_found' });
  };
}
