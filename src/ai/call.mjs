import { config } from '../config.mjs';
import { recordAICall, getMetricsSummary, resetMetrics } from '../metrics.mjs';
import { decidirModeloPorContexto } from '../model-router.mjs';
import { failures, opened, PROVIDERS } from './state.mjs';
import { resolveAIConfig, providers, available, providerDefaultModel, fallbackModelsForProvider, getCircuitBreakers } from './config.mjs';
import { responseSchema, buildOpenRouterBody, normalizeHistory, safeErrorDetail, parseAIResponse } from './parsing.mjs';
import { shouldEnableGoogleSearch } from './search.mjs';
import { getEnabledTools, getGeminiToolDeclarations } from '../tools/index.mjs';
import { resolveAdaptiveTemperature } from '../core/personality.mjs';

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

function compactText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.max(0, maxChars - headChars);
  return `${text.slice(0, headChars)}\n[contexto reduzido por limite do provedor]\n${tailChars ? text.slice(-tailChars) : ''}`;
}

function compactCloudflareHistory(history = []) {
  const normalized = normalizeHistory(history);
  const recent = normalized.slice(-8).map(item => ({
    role: item.role,
    content: compactText(item.content, 1400)
  }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

function buildCloudflareBody({ system, history, userText, nativeTools, runtime, temperature, compact = false }) {
  const messages = [
    { role: 'system', content: compact ? compactText(system, 8000) : system },
    ...(compact ? compactCloudflareHistory(history) : normalizeHistory(history)),
    { role: 'user', content: compact ? compactText(userText, 3000) : userText }
  ];
  return {
    messages,
    max_tokens: runtime.maxOutputTokens || config.aiMaxOutputTokens,
    temperature,
    // Ferramentas também podem ser a maior parte de um payload. Na tentativa
    // compacta o catálogo já está no system prompt, então não o repetimos.
    ...(!compact && nativeTools.length ? {
      tools: nativeTools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: openAIToolSchema(tool.parameters) } }))
    } : {})
  };
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
  toolDeclarations = [],
  routingDecision = null,
  temperature,
  isOwner
}) {
  if (!available(provider) || opened.get(provider) > Date.now()) return null;
  const runtime = resolveAIConfig({ ai: aiConfig });
  const nativeTools = Array.isArray(toolDeclarations) ? toolDeclarations : [];
  const resolvedIsOwner = typeof isOwner === 'boolean'
    ? isOwner
    : (routingDecision?.tier === 'pro');
  const adaptiveTemperature = resolveAdaptiveTemperature({
    explicitTemperature: temperature,
    hasTools: nativeTools.length > 0,
    isJsonResponse: true,
    isOwner: resolvedIsOwner
  });
  const toolCatalogPrompt = nativeTools.length
    ? `\n\n[CATÁLOGO DE FERRAMENTAS ATIVAS (PREENCHA "tool_calls" NO JSON QUANDO NECESSÁRIO)]\n` +
      nativeTools.map(t => {
        const props = t.parameters?.properties ? Object.keys(t.parameters.properties).join(', ') : '';
        return `• "${t.name}": ${t.description || ''} (args: {${props}})`;
      }).join('\n')
    : '';
  const effectiveSystem = toolCatalogPrompt && !String(system || '').includes('[CATÁLOGO DE FERRAMENTAS ATIVAS')
    ? `${system || ''}${toolCatalogPrompt}`
    : (system || '');

  if (provider === 'gemini') {
    // Modelo fixo: tenta ele e, apenas se for alias legado inexistente (404), permite equivalente 2.5
    // Modelo preferido: tenta o roteado e depois a cadeia padrão
    const LEGACY_GEMINI_EQUIVALENT = {
      'gemini-3.8-flash': 'gemini-2.5-flash',
      'gemini-3.5-flash-lite': 'gemini-2.5-flash-lite'
    };
    const geminiFixed = fixedModel && String(fixedModel).startsWith('gemini-') ? fixedModel : null;
    const candidateModels = (geminiFixed
      ? [geminiFixed, LEGACY_GEMINI_EQUIVALENT[geminiFixed]].filter(Boolean)
      : [
          preferredModel || legacyModel,
          LEGACY_GEMINI_EQUIVALENT[preferredModel || legacyModel],
          (runtime.model && runtime.model.startsWith('gemini-') && runtime.model !== 'gemini-1.5-flash') ? runtime.model : null,
          LEGACY_GEMINI_EQUIVALENT[runtime.model],
          ...(runtime.fallbackModels.length
            ? runtime.fallbackModels.filter(m => typeof m === 'string' && m.startsWith('gemini-')).slice(0, 3)
            : []),
          'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'
        ]
    )
      .filter(Boolean)
      .filter(m => typeof m === 'string' && m.startsWith('gemini-'))
      .filter((m, i, arr) => arr.indexOf(m) === i);

    let primaryErr = null;
    let lastErr = null;

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
          temperature: adaptiveTemperature,
          maxOutputTokens: runtime.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema
        };
        const effectiveThinkingBudget = Number.isInteger(routingDecision?.thinkingBudget)
          ? routingDecision.thinkingBudget
          : config.geminiThinkingBudget;
        const supportsThinking = (model.includes('2.5') || model.includes('flash-latest') || model.includes('pro-latest') || model.includes('gemini-3')) && !model.includes('2.0');
        if (supportsThinking && effectiveThinkingBudget !== undefined) {
          genConfig.thinkingConfig = { thinkingBudget: effectiveThinkingBudget };
        }
        const body = {
          systemInstruction: { parts: [{ text: effectiveSystem }] },
          contents: [...normalizeHistory(history), { role: 'user', content: userText }].map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig: genConfig
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
        // No modo fixo, só cai para o equivalente 2.5 se o alias retornar 404
        if (fixedModel && !/\b404\b/.test(err.message)) break;
        if (!/\b(400|404|429|5\d\d)\b/.test(err.message)) break;
      }
    }
    throw primaryErr || lastErr || Error('Gemini failed');
  }

  if (provider === 'cloudflare') {
    const cfDefault = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const model = fixedModel || preferredModel || legacyModel || cfDefault;
    const sameProviderFallbacks = provider === runtime.provider ? fallbackModelsForProvider(runtime, provider) : [];
    const candidateModels = [...new Set([model, ...sameProviderFallbacks, cfDefault].filter(c => typeof c === 'string' && c.trim()))].slice(0, 4);
    const headers = { 'content-type': 'application/json', Authorization: `Bearer ${config.cloudflareApiToken}` };
    let lastError = null;
    for (const candidateModel of candidateModels) {
      let permit = null;
      const attemptStartedAt = Date.now();
      const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
      if (remainingMs <= 100) break;
      const signal = AbortSignal.timeout(Math.max(1, Math.min(config.aiTimeoutMs, remainingMs)));
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/run/${candidateModel}`;
      const body = buildCloudflareBody({ system: effectiveSystem, history, userText, nativeTools, runtime, temperature: adaptiveTemperature });
      try {
        permit = await reserveModelBudget(budgetGate, budgetContext, provider, candidateModel);
        let response = await fetch(cfUrl, { method: 'POST', headers, signal, body: JSON.stringify(body) });
        // Cloudflare responds 413 when the combined system prompt, history or
        // tool catalog is too large. Retry the same model once with a compact
        // context before consuming another model/provider fallback.
        if (response.status === 413) {
          const compactBody = buildCloudflareBody({ system: effectiveSystem, history, userText, nativeTools, runtime, temperature: adaptiveTemperature, compact: true });
          response = await fetch(cfUrl, { method: 'POST', headers, signal, body: JSON.stringify(compactBody) });
        }
        if (!response.ok && (response.status === 400 || response.status === 404) && nativeTools.length > 0 && body.tools) {
          const fallbackBody = { ...body };
          delete fallbackBody.tools;
          response = await fetch(cfUrl, { method: 'POST', headers, signal, body: JSON.stringify(fallbackBody) });
        }
        if (!response.ok) {
          const detail = safeErrorDetail(await response.text());
          throw Error(`cloudflare ${response.status}${detail ? ` - ${detail}` : ''}`);
        }
        const data = await response.json();
        if (data?.success === false) {
          const detail = safeErrorDetail(JSON.stringify(data.errors || []));
          throw Error(`cloudflare error${detail ? ` - ${detail}` : ''}`);
        }
        const resultObj = data?.result || {};
        const functionCalls = normalizeProviderToolCalls(resultObj.tool_calls || []);
        const rawText = typeof resultObj.response === 'string'
          ? resultObj.response
          : (resultObj.response && typeof resultObj.response === 'object' ? JSON.stringify(resultObj.response) : '');
        const raw = functionCalls.length ? rawWithToolCalls(rawText, functionCalls) : (rawText || null);
        const usage = resultObj.usage || {};
        const promptTokens = usage.prompt_tokens || Math.ceil(((system?.length || 0) + (userText?.length || 0)) / 4);
        const completionTokens = usage.completion_tokens || Math.ceil((raw?.length || 0) / 4);
        const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
        return { raw, tokens: { promptTokens, completionTokens, totalTokens }, model: candidateModel, budgetPermit: permit };
      } catch (error) {
        if (!error.budgetDenied && budgetGate) {
          await permit?.markUnknown?.({ provider, model: candidateModel });
          await recordAICall({ requestId: permit?.requestId || null, provider, model: candidateModel, latencyMs: Date.now() - attemptStartedAt, promptTokens: 0, completionTokens: 0, totalTokens: 0, intent: 'falha', success: false, error: error.message });
          error.budgetAttemptsLogged = true;
        }
        lastError = error;
        if (error.budgetDenied) continue;
        if (!/\b(400|404|408|409|413|425|429|5\d\d)\b/.test(error.message)) throw error;
      }
    }
    throw lastError || Error('cloudflare deadline_exceeded');
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
  const sameProviderFallbacks = provider === runtime.provider ? fallbackModelsForProvider(runtime, provider) : [];
  const safeFallbacks = provider === 'openrouter' && runtime.openrouterFreeOnly
    ? sameProviderFallbacks.filter(candidate => candidate === 'openrouter/free' || candidate.endsWith(':free'))
    : sameProviderFallbacks;
  const candidateModels = [...new Set([model, ...safeFallbacks].filter(candidate => typeof candidate === 'string' && candidate.trim()))].slice(0, 4);
  let lastError = null;
  for (const candidateModel of candidateModels) {
    let permit = null;
    const attemptStartedAt = Date.now();
    const remainingMs = deadline ? deadline - Date.now() : config.aiTimeoutMs;
    if (remainingMs <= 100) break;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(config.aiTimeoutMs, remainingMs)));
    const body = provider === 'openrouter'
      ? buildOpenRouterBody({ model: candidateModel, fallbackModels: [], system: effectiveSystem, history, userText, structuredOutputs: runtime.structuredOutputs, requireParameters: runtime.requireParameters, tools: nativeTools.map(tool => ({ ...tool, parameters: openAIToolSchema(tool.parameters) })) })
      : { model: candidateModel, temperature: adaptiveTemperature, max_tokens: config.aiMaxOutputTokens, messages: [{ role: 'system', content: effectiveSystem }, ...normalizeHistory(history), { role: 'user', content: userText }], response_format: { type: 'json_object' }, ...(nativeTools.length ? { tools: nativeTools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: openAIToolSchema(tool.parameters) } })), tool_choice: 'auto' } : {}) };
    try {
      permit = await reserveModelBudget(budgetGate, budgetContext, provider, candidateModel);
      let response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(body) });
      // Se um modelo gratuito/customizado no OpenRouter ou Qwen recusar 'tools' nativo com 400/404, re-tenta sem 'tools' usando o catálogo no system prompt
      if (!response.ok && (response.status === 400 || response.status === 404) && nativeTools.length > 0 && body.tools) {
        const fallbackBody = { ...body };
        delete fallbackBody.tools;
        delete fallbackBody.tool_choice;
        response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(fallbackBody) });
      }
      if (!response.ok) {
        const detail = safeErrorDetail(await response.text());
        throw Error(`${provider} ${response.status}${detail ? ` - ${detail}` : ''}`);
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
      if (!/\b(400|404|408|409|425|429|5\d\d)\b/.test(error.message)) throw error;
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

  // Roteamento Dinâmico de Complexidade e Capacidades (MoA / Mixture of Agents)
  const isAutoRouting = args?.botConfig?.ai?.autoRouting !== false;
  const decision = decidirModeloPorContexto({
    userText: args?.userText,
    system: args?.system,
    history: args?.history,
    isOwner: args?.isOwner === true,
    isSuperAgent: args?.botConfig?.ai?.agentMode === 'super_agente' || args?.botConfig?.ai?.enableToolCalling === true,
    configuredModel: aiConfig.model,
    autoRoutingEnabled: isAutoRouting
  });

  // Modo fixo (OpenRouter, qwen, gpt ou auto-roteamento desligado): sem cadeia de fallback
  const fixedModel = decision.tier === 'custom' ? decision.model : null;
  const preferredModel = decision.tier === 'custom' ? null : decision.model;

  const deadline = Number.isFinite(args?.deadline) ? args.deadline : Date.now() + 35000;
  const actor = args?.isOwner === true ? 'owner' : 'client';
  const isSynthesisTurn = /\[(?:UNTRUSTED_(?:WEB_SEARCH|KNOWLEDGE_BASE)|TOOL_RESULTS)_JSON\]/.test(String(args?.system || ''));
  const explicitDisableTools = args?.botConfig?.ai?.enableToolCalling === false || (args?.botConfig?.ai?.agentMode === 'assistente' && args?.botConfig?.ai?.enableToolCalling !== true);
  const toolMode = !isSynthesisTurn && (actor === 'owner' || !explicitDisableTools);
  const webOnlyFallback = !isSynthesisTurn && !toolMode && args?.botConfig?.webSearch?.enabled !== false && shouldEnableGoogleSearch(args?.userText);
  const toolDeclarations = toolMode
    ? getEnabledTools(args?.botConfig, { actor })
    : (webOnlyFallback ? getEnabledTools(args?.botConfig, { actor }).filter(t => t.name === 'consultar_web') : []);
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
        routingDecision: decision,
        aiConfig,
        budgetGate: args?.budgetGate,
        budgetContext: {
          aiConfig: args?.botConfig?.ai || {},
          system: args?.system || '',
          history: args?.history || [],
          userText: args?.userText || '',
          maxOutputTokens: aiConfig.maxOutputTokens
        },
        fixedModel: provider === 'gemini' ? (fixedModel?.startsWith('gemini-') ? fixedModel : null) : providerModel,
        preferredModel: provider === 'gemini' ? (preferredModel?.startsWith('gemini-') ? preferredModel : (providerDefaultModel('gemini', aiConfig, null) || 'gemini-3.8-flash')) : null
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
