import { config } from '../config.mjs';
import { recordAICall, getMetricsSummary, resetMetrics } from '../metrics.mjs';
import { decidirModeloPorContexto } from '../model-router.mjs';
import { failures, opened, PROVIDERS } from './state.mjs';
import { resolveAIConfig, providers, available, providerDefaultModel, getCircuitBreakers } from './config.mjs';
import { responseSchema, buildOpenRouterBody, normalizeHistory, safeErrorDetail, parseAIResponse } from './parsing.mjs';
import { shouldEnableGoogleSearch } from './search.mjs';

export async function call(provider, {
  system,
  history = [],
  userText,
  deadline,
  fixedModel,
  preferredModel,
  model: legacyModel,
  aiConfig = {},
  enableSearch
}) {
  if (!available(provider) || opened.get(provider) > Date.now()) return null;
  const runtime = resolveAIConfig({ ai: aiConfig });
  const timeoutMs = Math.max(1, Math.min(config.aiTimeoutMs, (deadline ? deadline - Date.now() : config.aiTimeoutMs)));

  if (provider === 'gemini') {
    // Modelo fixo: tenta só ele, sem cadeia
    // Modelo preferido: tenta o roteado e depois a cadeia padrão
    const candidateModels = (fixedModel
      ? [fixedModel]
      : [
          preferredModel || legacyModel,
          (runtime.model && runtime.model.startsWith('gemini-') && runtime.model !== 'gemini-1.5-flash') ? runtime.model : null,
          ...runtime.fallbackModels.filter(m => typeof m === 'string' && m.startsWith('gemini-')),
          'gemini-3.8-flash',
          'gemini-3.5-flash-lite',
          'gemini-flash-latest',
          'gemini-pro-latest'
        ]
    )
      .filter(Boolean)
      .filter(m => typeof m === 'string' && m.startsWith('gemini-'))
      .filter((m, i, arr) => arr.indexOf(m) === i);

    let primaryErr = null;
    let lastErr = null;
    const webSearchEnabled = aiConfig?.webSearch?.enabled !== false;
    const needsSearch = webSearchEnabled && Boolean(enableSearch || shouldEnableGoogleSearch(userText));

    for (const model of candidateModels) {
      try {
        const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
        if (remainingMs <= 100) break;
        const perModelTimeout = Math.max(1000, Math.min(config.aiTimeoutMs, remainingMs));
        const modelSignal = AbortSignal.timeout(perModelTimeout);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const genConfig = {
          temperature: 0.2,
          maxOutputTokens: runtime.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema
        };
        if (model.includes('2.5') && config.geminiThinkingBudget !== undefined) {
          genConfig.thinkingConfig = { thinkingBudget: config.geminiThinkingBudget };
        }
        const body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [...normalizeHistory(history), { role: 'user', content: userText }].map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig: genConfig,
          ...(needsSearch ? { tools: [{ google_search: {} }] } : {})
        };
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
          signal: modelSignal,
          body: JSON.stringify(body)
        });
        if (!response.ok) throw Error(`Gemini ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw Error(`Gemini ${candidate.finishReason}`);
        const raw = candidate?.content?.parts?.map(part => part.text || '').join('') || null;
        const usage = data.usageMetadata;
        const promptTokens = usage?.promptTokenCount || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
        const completionTokens = usage?.candidatesTokenCount || Math.ceil((raw?.length || 0) / 4);
        const totalTokens = usage?.totalTokenCount || (promptTokens + completionTokens);
        return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model };
      } catch (err) {
        if (!primaryErr) primaryErr = err;
        lastErr = err;
        // Só cai para o próximo modelo em erros transitórios ou modelo inválido/descontinuado, e nunca no modo fixo
        if (fixedModel || !/\b(400|404|429|5\d\d)\b/.test(err.message)) break;
      }
    }
    throw primaryErr || lastErr || Error('Gemini failed');
  }

  // Provedores não-Gemini usam o modelo que lhes foi atribuído
  const model = fixedModel || preferredModel || legacyModel || (provider === 'openrouter' ? 'nvidia/nemotron-3.5-lightning:free' : '');
  const signal = AbortSignal.timeout(timeoutMs);
  const base = provider === 'openrouter' ? config.openrouterBaseUrl : provider === 'qwen' ? config.qwenBaseUrl : 'https://api.openai.com/v1';
  const key = provider === 'openrouter' ? config.openrouterKey : provider === 'qwen' ? config.qwenKey : config.openaiKey;
  const headers = { 'content-type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    if (config.openrouterSiteUrl) headers['HTTP-Referer'] = config.openrouterSiteUrl;
    if (config.openrouterAppName) headers['X-Title'] = config.openrouterAppName;
  }
  const body = provider === 'openrouter'
    ? buildOpenRouterBody({ model, fallbackModels: runtime.fallbackModels, system, history, userText, structuredOutputs: runtime.structuredOutputs, requireParameters: runtime.requireParameters })
    : { model, temperature: 0.2, max_tokens: config.aiMaxOutputTokens, messages: [{ role: 'system', content: system }, ...normalizeHistory(history), { role: 'user', content: userText }], response_format: { type: 'json_object' } };
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(body) });
  if (!response.ok) { const detail = safeErrorDetail(await response.text()); throw Error(`${provider} ${response.status}${detail ? ` — ${detail}` : ''}`); }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || null;
  const usage = data.usage;
  const promptTokens = usage?.prompt_tokens || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
  const completionTokens = usage?.completion_tokens || Math.ceil((raw?.length || 0) / 4);
  const totalTokens = usage?.total_tokens || (promptTokens + completionTokens);
  return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model: data.model || model };
}

export async function askAI(args) {
  const aiConfig = resolveAIConfig(args?.botConfig);
  if (!PROVIDERS.includes(aiConfig.provider) || !aiConfig.model) {
    console.warn('[ai] Nenhum provedor/modelo foi publicado no dashboard.');
    return null;
  }

  // Roteamento Dinâmico de Complexidade (MoA / Mixture of Agents)
  const isAutoRouting = args?.botConfig?.ai?.autoRouting !== false;
  const decision = decidirModeloPorContexto({
    userText: args?.userText,
    history: args?.history,
    isOwner: args?.isOwner === true || args?.isTauan === true,
    isSuperAgent: args?.botConfig?.ai?.agentMode === 'super_agente' || args?.botConfig?.ai?.enableToolCalling === true,
    configuredModel: aiConfig.model,
    autoRoutingEnabled: isAutoRouting
  });

  // Modo fixo (OpenRouter, qwen, gpt ou auto-roteamento desligado): sem cadeia de fallback
  const fixedModel = decision.tier === 'custom' ? decision.model : null;
  const preferredModel = decision.tier === 'custom' ? null : decision.model;

  const deadline = Date.now() + 35000;
  for (const provider of providers(args?.botConfig)) {
    const start = Date.now();
    // Cada provedor recebe o modelo que lhe pertence. Nunca o do Gemini.
    const providerModel = providerDefaultModel(provider, aiConfig, fixedModel);
    if (!providerModel && provider !== 'gemini') continue; // sem modelo, não tenta

    try {
      const res = await call(provider, {
        ...args,
        deadline,
        aiConfig,
        fixedModel: provider === 'gemini' ? fixedModel : providerModel,
        preferredModel: provider === 'gemini' ? preferredModel : null
      });
      if (res?.raw) {
        failures.set(provider, 0);
        opened.delete(provider);
        const parsed = parseAIResponse(res.raw);
        recordAICall({
          provider,
          model: res.model || providerModel || preferredModel || 'gemini-3.8-flash',
          latencyMs: Date.now() - start,
          promptTokens: res.tokens?.promptTokens,
          completionTokens: res.tokens?.completionTokens,
          totalTokens: res.tokens?.totalTokens,
          intent: parsed.intent,
          success: true,
          error: null
        });
        return parsed;
      }
    } catch (error) {
      const count = (failures.get(provider) || 0) + 1;
      failures.set(provider, count);
      if (count >= 3 || /\b(429|401|403)\b/.test(error.message)) opened.set(provider, Date.now() + 60000);
      recordAICall({
        provider,
        model: providerModel || preferredModel || 'unknown',
        latencyMs: Date.now() - start,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        intent: 'falha',
        success: false,
        error: error.message
      });
      console.error(`[ai:${provider}]`, error.message);
    }
  }
  return null;
}

export async function pingAI(targetProvider, targetModel) {
  const p = targetProvider || '';
  const start = Date.now();
  const model = targetModel || '';
  if (!available(p)) return { ok: false, provider: p, model, latencyMs: 0, error: `${p} não configurado. Informe a chave de API no .env e reinicie o serviço.` };
  const system = 'Você é o assistente técnico da equipe. Responda em JSON {"status":"ok","mensagem":"conectado"}.';
  const userText = 'teste de conexão';
  try {
    const res = await call(p, { system, history: [], userText, deadline: Date.now() + 15000, model });
    const latencyMs = Date.now() - start;
    if (!res?.raw) throw new Error('Resposta vazia');
    const executedModel = res.model || model;
    recordAICall({
      provider: p,
      model: executedModel,
      latencyMs,
      promptTokens: res.tokens?.promptTokens,
      completionTokens: res.tokens?.completionTokens,
      totalTokens: res.tokens?.totalTokens,
      intent: 'ping_teste',
      success: true,
      error: null
    });
    return {
      ok: true,
      provider: p,
      model: executedModel,
      latencyMs,
      tokens: res.tokens,
      status: 'conectado'
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    recordAICall({
      provider: p,
      model,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      intent: 'ping_falha',
      success: false,
      error: err.message
    });
    return {
      ok: false,
      provider: p,
      model,
      latencyMs,
      error: err.message
    };
  }
}

export function getAIMetrics() {
  return getMetricsSummary(getCircuitBreakers());
}

export { resetMetrics };
