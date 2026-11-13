import { config } from '../config.mjs';
import { recordAICall, getMetricsSummary, resetMetrics } from '../metrics.mjs';
import { decidirModeloPorContexto } from '../model-router.mjs';
import { failures, opened, PROVIDERS } from './state.mjs';
import { resolveAIConfig, providers, available, providerDefaultModel, getCircuitBreakers } from './config.mjs';
import { responseSchema, buildOpenRouterBody, normalizeHistory, safeErrorDetail, parseAIResponse } from './parsing.mjs';
import { shouldEnableGoogleSearch } from './search.mjs';
import { getEnabledTools, getGeminiToolDeclarations } from '../tools/index.mjs';

function openAIToolSchema(schema = {}) {
  const result = { ...schema };
  if (typeof result.type === 'string') result.type = result.type.toLowerCase();
  if (result.properties && typeof result.properties === 'object') {
    result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, openAIToolSchema(value)]));
  }
  if (result.items && typeof result.items === 'object') result.items = openAIToolSchema(result.items);
  return result;
}

function normalizeProviderToolCalls(calls = []) {
  return calls.map(call => {
    const fn = call?.function || call;
    let args = fn?.args ?? fn?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    return { name: fn?.name, args };
  }).filter(call => typeof call.name === 'string');
}

function rawWithToolCalls(text, calls) {
  let parsed = {};
  if (text) {
    try { parsed = parseAIResponse(text); } catch {}
  }
  return JSON.stringify({
    ...parsed,
    reply: parsed.reply || '',
    intent: parsed.intent || 'outro',
    red_flags: Boolean(parsed.red_flags),
    handoff: Boolean(parsed.handoff),
    tool_calls: calls
  });
}

async function reserveModelBudget(budgetGate, context, provider, model) {
  if (!budgetGate) return null;
  const permit = await budgetGate.acquire({ ...context, provider, model });
  if (!permit?.allowed) {
    const error = Object.assign(new Error(permit?.reason || 'monthly_budget_exceeded'), { budgetDenied: true });
    throw error;
  }
  return permit;
}

export async function call(provider, {
  system,
  history = [],
  userText,
  deadline,
  fixedModel,
  preferredModel,
  model: legacyModel,
  aiConfig = {},
  budgetGate,
  budgetContext = {},
  enableSearch,
  toolDeclarations = []
}) {
  if (!available(provider) || opened.get(provider) > Date.now()) return null;
  const runtime = resolveAIConfig({ ai: aiConfig });
  const nativeTools = Array.isArray(toolDeclarations) ? toolDeclarations : [];

  if (provider === 'gemini') {
    // Modelo fixo: tenta só ele, sem cadeia
    // Modelo preferido: tenta o roteado e depois a cadeia padrão
    const candidateModels = (fixedModel
      ? [fixedModel]
      : [
          preferredModel || legacyModel,
          (runtime.model && runtime.model.startsWith('gemini-') && runtime.model !== 'gemini-1.5-flash') ? runtime.model : null,
          ...(runtime.fallbackModels.length
            ? runtime.fallbackModels.filter(m => typeof m === 'string' && m.startsWith('gemini-')).slice(0, 3)
            : ['gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-pro-latest'])
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
      let permit = null;
      const attemptStartedAt = Date.now();
      try {
        const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
        if (remainingMs <= 100) break;
        permit = await reserveModelBudget(budgetGate, budgetContext, provider, model);
        const perModelTimeout = Math.max(1, Math.min(config.aiTimeoutMs, remainingMs));
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
          ...((needsSearch || nativeTools.length) ? { tools: [
            ...(needsSearch ? [{ google_search: {} }] : []),
            ...(nativeTools.length ? getGeminiToolDeclarations(nativeTools) : [])
          ] } : {})
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
        const parts = candidate?.content?.parts || [];
        const text = parts.map(part => part.text || '').join('');
        const functionCalls = normalizeProviderToolCalls(parts.filter(part => part.functionCall).map(part => part.functionCall));
        const raw = functionCalls.length ? rawWithToolCalls(text, functionCalls) : (text || null);
        const usage = data.usageMetadata;
        const promptTokens = usage?.promptTokenCount || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
        const completionTokens = usage?.candidatesTokenCount || Math.ceil((raw?.length || 0) / 4);
        const totalTokens = usage?.totalTokenCount || (promptTokens + completionTokens);
        return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model, budgetPermit: permit };
      } catch (err) {
        if (!err.budgetDenied && budgetGate) {
          await permit?.markUnknown?.({ provider, model });
          await recordAICall({ requestId: permit?.requestId || null, provider, model, latencyMs: Date.now() - attemptStartedAt, promptTokens: 0, completionTokens: 0, totalTokens: 0, intent: 'falha', success: false, error: err.message });
          err.budgetAttemptsLogged = true;
        }
        if (!primaryErr) primaryErr = err;
        lastErr = err;
        if (err.budgetDenied) continue;
        // Só cai para o próximo modelo em erros transitórios ou modelo inválido/descontinuado, e nunca no modo fixo
        if (fixedModel || !/\b(400|404|429|5\d\d)\b/.test(err.message)) break;
      }
    }
    throw primaryErr || lastErr || Error('Gemini failed');
  }

  // Provedores não-Gemini usam o modelo que lhes foi atribuído
  const model = fixedModel || preferredModel || legacyModel || (provider === 'openrouter' ? 'nvidia/nemotron-3.5-lightning:free' : '');
  const base = provider === 'openrouter' ? config.openrouterBaseUrl : provider === 'qwen' ? config.qwenBaseUrl : 'https://api.openai.com/v1';
  const key = provider === 'openrouter' ? config.openrouterKey : provider === 'qwen' ? config.qwenKey : config.openaiKey;
  const headers = { 'content-type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    if (config.openrouterSiteUrl) headers['HTTP-Referer'] = config.openrouterSiteUrl;
    if (config.openrouterAppName) headers['X-Title'] = config.openrouterAppName;
  }
  const sameProviderFallbacks = provider === runtime.provider ? runtime.fallbackModels : [];
  const candidateModels = [...new Set([model, ...sameProviderFallbacks].filter(candidate => typeof candidate === 'string' && candidate.trim()))].slice(0, 4);
  let lastError = null;
  for (const candidateModel of candidateModels) {
    let permit = null;
    const attemptStartedAt = Date.now();
    const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
    if (remainingMs <= 100) break;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(config.aiTimeoutMs, remainingMs)));
    const body = provider === 'openrouter'
      ? buildOpenRouterBody({ model: candidateModel, fallbackModels: [], system, history, userText, structuredOutputs: runtime.structuredOutputs, requireParameters: runtime.requireParameters, tools: nativeTools.map(tool => ({ ...tool, parameters: openAIToolSchema(tool.parameters) })) })
      : { model: candidateModel, temperature: 0.2, max_tokens: config.aiMaxOutputTokens, messages: [{ role: 'system', content: system }, ...normalizeHistory(history), { role: 'user', content: userText }], response_format: { type: 'json_object' }, ...(nativeTools.length ? { tools: nativeTools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: openAIToolSchema(tool.parameters) } })), tool_choice: 'auto' } : {}) };
    try {
      permit = await reserveModelBudget(budgetGate, budgetContext, provider, candidateModel);
      const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(body) });
      if (!response.ok) {
        const detail = safeErrorDetail(await response.text());
        throw Error(`${provider} ${response.status}${detail ? ` — ${detail}` : ''}`);
      }
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      const functionCalls = normalizeProviderToolCalls(message.tool_calls || (message.function_call ? [message.function_call] : []));
      const raw = functionCalls.length ? rawWithToolCalls(message.content, functionCalls) : (message.content || null);
      const usage = data.usage;
      const promptTokens = usage?.prompt_tokens || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
      const completionTokens = usage?.completion_tokens || Math.ceil((raw?.length || 0) / 4);
      const totalTokens = usage?.total_tokens || (promptTokens + completionTokens);
      return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model: data.model || candidateModel, budgetPermit: permit };
    } catch (error) {
      if (!error.budgetDenied && budgetGate) {
        await permit?.markUnknown?.({ provider, model: candidateModel });
        await recordAICall({ requestId: permit?.requestId || null, provider, model: candidateModel, latencyMs: Date.now() - attemptStartedAt, promptTokens: 0, completionTokens: 0, totalTokens: 0, intent: 'falha', success: false, error: error.message });
        error.budgetAttemptsLogged = true;
      }
      lastError = error;
      if (error.budgetDenied) continue;
      if (provider === 'openrouter' || !/\b(400|404|408|409|425|429|5\d\d)\b/.test(error.message)) throw error;
    }
  }
  throw lastError || Error(`${provider} deadline_exceeded`);
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

  const deadline = Number.isFinite(args?.deadline) ? args.deadline : Date.now() + 35000;
  const toolMode = args?.botConfig?.ai?.agentMode === 'super_agente' || args?.botConfig?.ai?.enableToolCalling === true;
  const actor = args?.isOwner === true || args?.isTauan === true ? 'owner' : 'client';
  const toolDeclarations = toolMode ? getEnabledTools(args?.botConfig, { actor }) : [];
  for (const provider of providers(args?.botConfig)) {
    const start = Date.now();
    // Cada provedor recebe o modelo que lhe pertence. Nunca o do Gemini.
    const providerModel = providerDefaultModel(provider, aiConfig, fixedModel);
    if (!providerModel && provider !== 'gemini') continue; // sem modelo, não tenta

    try {
      const res = await call(provider, {
        ...args,
        deadline,
        toolDeclarations,
        aiConfig,
        budgetGate: args?.budgetGate,
        budgetContext: {
          aiConfig: args?.botConfig?.ai || {},
          system: args?.system || '',
          history: args?.history || [],
          userText: args?.userText || '',
          maxOutputTokens: aiConfig.maxOutputTokens
        },
        fixedModel: provider === 'gemini' ? fixedModel : providerModel,
        preferredModel: provider === 'gemini' ? preferredModel : null
      });
      if (res?.raw) {
        failures.set(provider, 0);
        opened.delete(provider);
        const parsed = parseAIResponse(res.raw);
        const executedModel = res.model || providerModel || preferredModel;
        const settlementConfirmed = await res.budgetPermit?.commit?.(res.tokens, { provider, model: executedModel });
        if (res.budgetPermit?.requestId && settlementConfirmed !== true) {
          await recordAICall({ requestId: res.budgetPermit.requestId, provider, model: executedModel || 'unknown', latencyMs: Date.now() - start, promptTokens: res.tokens?.promptTokens, completionTokens: res.tokens?.completionTokens, totalTokens: res.tokens?.totalTokens, intent: 'falha', success: false, error: 'Liquidação de orçamento não confirmada' });
          return null;
        }
        await recordAICall({
          requestId: res.budgetPermit?.requestId || null,
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
      } else if (res?.budgetPermit?.requestId) {
        await res.budgetPermit.markUnknown?.({ provider, model: res.model || providerModel });
        await recordAICall({ requestId: res.budgetPermit.requestId, provider, model: res.model || providerModel, latencyMs: Date.now() - start, promptTokens: 0, completionTokens: 0, totalTokens: 0, intent: 'falha', success: false, error: 'Resposta vazia do provedor' });
      }
    } catch (error) {
      if (error?.budgetDenied) continue;
      const count = (failures.get(provider) || 0) + 1;
      failures.set(provider, count);
      if (count >= 3 || /\b(429|401|403)\b/.test(error.message)) opened.set(provider, Date.now() + 60000);
      if (!error?.budgetAttemptsLogged) await recordAICall({
          provider,
          model: error?.attemptedModel || providerModel || preferredModel || 'unknown',
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

export async function pingAI(targetProvider, targetModel, { budgetGate, aiConfig = {} } = {}) {
  const p = targetProvider || '';
  const start = Date.now();
  const model = targetModel || '';
  let budgetPermit = null;
  if (!available(p)) return { ok: false, provider: p, model, latencyMs: 0, error: `${p} não configurado. Informe a chave de API no .env e reinicie o serviço.` };
  const system = 'Você é o assistente técnico da equipe. Responda em JSON {"status":"ok","mensagem":"conectado"}.';
  const userText = 'teste de conexão';
  try {
    const res = await call(p, {
      system,
      history: [],
      userText,
      deadline: Date.now() + 15000,
      model,
      aiConfig,
      budgetGate,
      budgetContext: { aiConfig, system, history: [], userText, maxOutputTokens: 2048 }
    });
    budgetPermit = res?.budgetPermit || null;
    const latencyMs = Date.now() - start;
    if (!res?.raw) {
      budgetPermit?.markUnknown?.();
      throw new Error('Resposta vazia');
    }
    const executedModel = res.model || model;
    const settlementConfirmed = await res.budgetPermit?.commit?.(res.tokens, { provider: p, model: executedModel });
    if (res.budgetPermit?.requestId && settlementConfirmed !== true) {
      await recordAICall({ requestId: res.budgetPermit.requestId, provider: p, model: executedModel, latencyMs, promptTokens: res.tokens?.promptTokens, completionTokens: res.tokens?.completionTokens, totalTokens: res.tokens?.totalTokens, intent: 'ping_falha', success: false, error: 'Liquidação de orçamento não confirmada' });
      return { ok: false, provider: p, model: executedModel, latencyMs, error: 'Liquidação de orçamento não confirmada.' };
    }
    await recordAICall({
      requestId: res.budgetPermit?.requestId || null,
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
    if (err?.budgetDenied) return { ok: false, provider: p, model, latencyMs, error: 'Orçamento mensal indisponível ou atingido.', code: err.message };
    await budgetPermit?.markUnknown?.({ provider: p, model });
    if (!err?.budgetAttemptsLogged) await recordAICall({
      requestId: budgetPermit?.requestId || null,
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
