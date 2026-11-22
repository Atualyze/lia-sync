import { config } from '../config.mjs';
import { recordAICall, getMetricsSummary, resetMetrics } from '../metrics.mjs';
import { decidirModeloPorContexto } from '../model-router.mjs';
import { failures, opened, lastErrors, PROVIDERS, parseRetryAfterMs } from './state.mjs';
import { resolveAIConfig, providers, available, providerDefaultModel, fallbackModelsForProvider, getCircuitBreakers } from './config.mjs';
import { getCustomProvider } from './custom-providers.mjs';
import { describeAIError } from './errors.mjs';
import { responseSchema, buildOpenRouterBody, normalizeHistory, safeErrorDetail, parseAIResponse } from './parsing.mjs';
import { shouldEnableGoogleSearch } from './search.mjs';
import { getEnabledTools, getGeminiToolDeclarations, getToolExecutionPolicy } from '../tools/index.mjs';
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

function buildCompactToolPrompt(nativeTools = []) {
  if (!Array.isArray(nativeTools) || !nativeTools.length) return '';
  const list = nativeTools.map(tool => {
    const props = Object.keys(tool?.parameters?.properties || {}).slice(0, 4).join(',');
    return `${tool.name}(${props})`;
  }).join(', ');
  return `\n\n[FERRAMENTAS_ATIVAS_COMPACTAS]\nVocê TEM acesso real ao WhatsApp, banco de dados Supabase/CRM, Google Workspace (Agenda, Gmail, Planilhas, Drive), Infraestrutura, Pix, PDF e Web via ferramentas do sistema. NUNCA diga que "não tem acesso ao WhatsApp", "não tem acesso ao banco de dados" ou que "só conversa aqui".\nPara executar uma ação, responda em JSON válido: {"reply":"","tool_calls":[{"name":"NOME_DA_FERRAMENTA","args":{...}}]}.\nFerramentas ativas: ${list}\n[/FERRAMENTAS_ATIVAS_COMPACTAS]`;
}

function compactCloudflareHistory(history = []) {
  const normalized = normalizeHistory(history);
  const recent = normalized.slice(-8).map(item => ({
    role: item.role,
    content: compactText(item.content, 1400)
  }));
  if (recent.length && recent[0].role !== 'user') {
    const prevIdx = normalized.length - recent.length - 1;
    if (prevIdx >= 0 && normalized[prevIdx]?.role === 'user') {
      recent.unshift({
        role: 'user',
        content: compactText(normalized[prevIdx].content, 800)
      });
    } else {
      recent.unshift({ role: 'user', content: '[Retomada da conversa em andamento]' });
    }
  }
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

function isProviderCreditExhaustion(error) {
  const message = String(error?.message || error || '');
  return /\b402\b|payment required|insufficient (?:funds|credit|balance)|no credits? remaining|credit balance|billing (?:issue|disabled)|quota exceeded/i.test(message);
}

function providerCreditExhaustionReply(provider) {
  const label = provider === 'gemini' ? 'Gemini' : provider;
  return {
    reply: `Não consegui processar sua mensagem porque o serviço de IA (${label}) está sem saldo/créditos ou precisa de uma regularização de pagamento. O responsável pela conta precisa verificar o faturamento e os créditos do provedor. Assim que o acesso for restabelecido, posso continuar.`,
    intent: 'outro',
    red_flags: false,
    handoff: false,
    handoff_reason: null,
    collected: {},
    provider_error: 'AI_PROVIDER_CREDITS_EXHAUSTED'
  };
}

function providerFailureDiagnosticReply(attemptDiagnostics = []) {
  const lines = attemptDiagnostics.map(d => `• *${d.provider}* (${d.model}): [${d.code}] ${d.message}`).join('\n');
  return {
    reply: `⚠️ *Falha na comunicação com os provedores de IA:*\n\n${lines}\n\n_Verifique a chave, o modelo ou a conectividade em Provedores de IA no painel._`,
    intent: 'outro',
    red_flags: false,
    handoff: false,
    handoff_reason: null,
    collected: {},
    tool_calls: [],
    provider_error: attemptDiagnostics[0]?.code || 'AI_PROVIDER_FAILURE',
    provider_errors: attemptDiagnostics
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
        const policy = getToolExecutionPolicy(t.name);
        return `• "${t.name}": ${t.description || ''} (args: {${props}}; modo: ${policy.mode}; autorização: ${policy.approval}; repetição: ${policy.retry})`;
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
      'gemini-3.5-flash-lite': 'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite'
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
          'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.5-flash'
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

  // Provedores não-Gemini (built-ins OpenAI-compatible e provedores customizados)
  const customProv = getCustomProvider(provider);
  const model = fixedModel || preferredModel || legacyModel || customProv?.defaultModel || (provider === 'openrouter' ? 'nvidia/nemotron-3.5-lightning:free' : provider === 'groq' ? 'llama-3.3-70b-versatile' : provider === 'nvidia' ? 'meta/llama-3.3-70b-instruct' : '');
  const base = customProv ? customProv.baseUrl : (provider === 'groq' ? config.groqBaseUrl : provider === 'nvidia' ? config.nvidiaBaseUrl : provider === 'openrouter' ? config.openrouterBaseUrl : provider === 'qwen' ? config.qwenBaseUrl : 'https://api.openai.com/v1');
  const key = customProv ? customProv.apiKey : (provider === 'groq' ? config.groqKey : provider === 'nvidia' ? config.nvidiaKey : provider === 'openrouter' ? config.openrouterKey : provider === 'qwen' ? config.qwenKey : config.openaiKey);
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
    const isReasoningModel = /(?:gpt-oss|qwen3|deepseek|r1|nemotron|gemma-4|thinking)/i.test(candidateModel) || candidateModel === 'openrouter/free';
    const isReasoningJsonFragile = provider === 'groq' && /(?:gpt-oss|qwen|deepseek|r1)/i.test(candidateModel);
    const isGroqGptOss = provider === 'groq' && /gpt-oss/i.test(candidateModel);
    const effectiveMaxTokens = isReasoningModel ? Math.max(2048, config.aiMaxOutputTokens) : config.aiMaxOutputTokens;
    const body = provider === 'openrouter'
      ? buildOpenRouterBody({ model: candidateModel, fallbackModels: [], system: effectiveSystem, history, userText, structuredOutputs: runtime.structuredOutputs, requireParameters: runtime.requireParameters, tools: nativeTools.map(tool => ({ ...tool, parameters: openAIToolSchema(tool.parameters) })) })
      : {
          model: candidateModel,
          temperature: adaptiveTemperature,
          max_tokens: effectiveMaxTokens,
          ...(isGroqGptOss ? { reasoning_effort: 'low' } : {}),
          messages: [{ role: 'system', content: effectiveSystem }, ...normalizeHistory(history), { role: 'user', content: userText }],
          ...(!isReasoningJsonFragile ? { response_format: { type: 'json_object' } } : {}),
          ...(nativeTools.length ? { tools: nativeTools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: openAIToolSchema(tool.parameters) } })), tool_choice: 'auto' } : {})
        };
    try {
      permit = await reserveModelBudget(budgetGate, budgetContext, provider, candidateModel);
      let usedPlainBody = !body.tools && !body.response_format;
      let response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(body) });
      // Se um modelo gratuito/customizado no OpenRouter, Groq, NVIDIA NIM ou Qwen recusar 'tools' nativo com 400/404/422, re-tenta sem 'tools' usando o catálogo no system prompt
      if (!response.ok && (response.status === 400 || response.status === 404 || response.status === 422) && nativeTools.length > 0 && body.tools) {
        const fallbackBody = { ...body };
        delete fallbackBody.tools;
        delete fallbackBody.tool_choice;
        response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(fallbackBody) });
      }
      // Alguns modelos Groq (gpt-oss), NIM ou OpenAI-compatible rejeitam response_format json_object ou reasoning_effort (400); degrada graciosamente mantendo o contrato JSON via system prompt
      if (!response.ok && (response.status === 400 || response.status === 422) && (body.response_format || body.tools || body.reasoning_effort || body.reasoning)) {
        const plainBody = { ...body };
        delete plainBody.tools;
        delete plainBody.tool_choice;
        delete plainBody.response_format;
        delete plainBody.reasoning_effort;
        delete plainBody.reasoning;
        usedPlainBody = true;
        response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(plainBody) });
      }
      // Groq (tier free 6k TPM) e provedores OpenAI-compatible podem retornar 413/429 "Request too large".
      // Compacta o system prompt + histórico (sem response_format estrito para evitar 400 json_validate_failed em modelos de raciocínio) e tenta uma vez antes de cair para outro provedor.
      if (!response.ok && (response.status === 413 || response.status === 429)) {
        const errBodyText = await response.clone().text().catch(() => '');
        if (response.status === 413 || /request too large|tokens per minute|tpm|context_length_exceeded|maximum context length/i.test(errBodyText)) {
          const compactToolsSuffix = buildCompactToolPrompt(nativeTools);
          const compactBody = {
            model: candidateModel,
            temperature: adaptiveTemperature,
            max_tokens: effectiveMaxTokens,
            ...(isGroqGptOss ? { reasoning_effort: 'low' } : {}),
            ...(provider === 'openrouter' && isReasoningModel ? { reasoning: { effort: 'low' } } : {}),
            messages: [
              { role: 'system', content: compactText(effectiveSystem, 6200) + compactToolsSuffix },
              ...compactCloudflareHistory(history),
              { role: 'user', content: compactText(userText, 2500) }
            ]
          };
          usedPlainBody = true;
          response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(compactBody) });
        }
      }
      if (!response.ok) {
        const rawErrText = await response.text();
        const detail = safeErrorDetail(rawErrText);
        const err = Error(`${provider} ${response.status}${detail ? ` - ${detail}` : ''}`);
        if (response.status === 429) {
          const retryMs = parseRetryAfterMs(response.headers, rawErrText);
          if (retryMs) err.retryAfterMs = retryMs;
        }
        throw err;
      }
      let data = await response.json();
      let message = data.choices?.[0]?.message || {};
      let functionCalls = normalizeProviderToolCalls(message.tool_calls || (message.function_call ? [message.function_call] : []));
      let contentText = typeof message.content === 'string' ? message.content.trim() : '';
      // Alguns modelos de raciocínio (OpenRouter :free / Groq gpt-oss) retornam content vazio com tools/response_format ou finish_reason=length.
      // Tenta recuperar JSON válido do campo reasoning ou refaz 1 chamada limpa com reasoning mínimo e max_tokens ampliado.
      if (!contentText && !functionCalls.length) {
        const reasoningText = String(message.reasoning || message.reasoning_content || '').trim();
        const jsonMatch = reasoningText.match(/\{[\s\S]*"reply"\s*:[\s\S]*\}/);
        if (jsonMatch) {
          contentText = jsonMatch[0];
        } else if (!deadline || deadline - Date.now() > 2500) {
          const compactToolsSuffix = buildCompactToolPrompt(nativeTools);
          const plainRetryBody = {
            model: candidateModel,
            temperature: adaptiveTemperature,
            max_tokens: Math.max(3072, effectiveMaxTokens),
            ...(isGroqGptOss ? { reasoning_effort: 'low' } : {}),
            ...(provider === 'openrouter' ? { reasoning: { effort: 'low' } } : {}),
            messages: [
              { role: 'system', content: compactText(effectiveSystem, 7000) + compactToolsSuffix },
              ...compactCloudflareHistory(history),
              { role: 'user', content: compactText(userText, 2500) }
            ]
          };
          const retryRes = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal, body: JSON.stringify(plainRetryBody) });
          if (retryRes.ok) {
            const retryData = await retryRes.json().catch(() => ({}));
            const retryMsg = retryData.choices?.[0]?.message || {};
            const retryCalls = normalizeProviderToolCalls(retryMsg.tool_calls || (retryMsg.function_call ? [retryMsg.function_call] : []));
            const retryContent = typeof retryMsg.content === 'string' ? retryMsg.content.trim() : '';
            if (retryContent || retryCalls.length) {
              data = retryData;
              message = retryMsg;
              functionCalls = retryCalls;
              contentText = retryContent;
            }
          }
        }
      }
      const raw = functionCalls.length ? rawWithToolCalls(contentText || message.content, functionCalls) : (contentText || null);
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
  if ((!PROVIDERS.includes(aiConfig.provider) && !getCustomProvider(aiConfig.provider)) || !aiConfig.model) {
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
  const disableToolCalling = args?.disableToolCalling === true;
  const explicitDisableTools = disableToolCalling || args?.botConfig?.ai?.enableToolCalling === false || (args?.botConfig?.ai?.agentMode === 'assistente' && args?.botConfig?.ai?.enableToolCalling !== true);
  const toolMode = !isSynthesisTurn && !disableToolCalling && (actor === 'owner' || !explicitDisableTools);
  const webOnlyFallback = !isSynthesisTurn && !disableToolCalling && !toolMode && args?.botConfig?.webSearch?.enabled !== false && shouldEnableGoogleSearch(args?.userText);
  const toolDeclarations = toolMode
    ? getEnabledTools(args?.botConfig, { actor })
    : (webOnlyFallback ? getEnabledTools(args?.botConfig, { actor }).filter(t => t.name === 'consultar_web') : []);
  const providerList = providers(args?.botConfig);
  let creditExhaustionProvider = null;
  const attemptDiagnostics = [];
  for (let pIdx = 0; pIdx < providerList.length; pIdx++) {
    const provider = providerList[pIdx];
    const start = Date.now();
    const remainingTotalMs = deadline - start;
    if (remainingTotalMs <= 100) {
      const skippedModel = providerDefaultModel(provider, aiConfig, fixedModel) || 'unknown';
      const diag = describeAIError(provider, new Error('deadline_exceeded'), skippedModel);
      attemptDiagnostics.push({ provider, model: skippedModel, code: diag.code, message: diag.message });
      break;
    }
    // Se ainda há provedores de contingência na fila, reserva janela para eles
    // para que um único provedor lento não esgote 100% do deadline de 35s.
    const hasBackupProviders = pIdx < providerList.length - 1;
    const providerDeadline = hasBackupProviders
      ? start + Math.max(4000, Math.min(15000, Math.floor(remainingTotalMs * 0.6)))
      : deadline;
    // Cada provedor recebe o modelo que lhe pertence. Nunca o do Gemini.
    const providerModel = providerDefaultModel(provider, aiConfig, fixedModel);
    if (!providerModel && provider !== 'gemini') continue; // sem modelo, não tenta

    try {
      const res = await call(provider, {
        ...args,
        deadline: providerDeadline,
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
        const parsed = parseAIResponse(res.raw);
        const hasUsableReply = Boolean(String(parsed?.reply || '').trim());
        const hasToolCalls = Array.isArray(parsed?.tool_calls) && parsed.tool_calls.length > 0;
        if (!hasUsableReply && !hasToolCalls) {
          throw new Error(`${provider} empty_reply`);
        }
        failures.set(provider, 0);
        opened.delete(provider);
        lastErrors.delete(provider);
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
      const attemptedModel = error?.attemptedModel || providerModel || preferredModel || 'unknown';
      const diag = describeAIError(provider, error, attemptedModel);
      attemptDiagnostics.push({ provider, model: attemptedModel, code: diag.code, message: diag.message });
      if ((isProviderCreditExhaustion(error) || diag.isCreditExhausted) && !creditExhaustionProvider) creditExhaustionProvider = provider;
      const count = (failures.get(provider) || 0) + 1;
      failures.set(provider, count);
      lastErrors.set(provider, { code: diag.code, message: diag.message, model: attemptedModel, at: new Date().toISOString() });
      if (count >= 3 || /\b(429|401|403)\b/.test(error.message)) {
        const waitMs = Number.isFinite(error?.retryAfterMs)
          ? error.retryAfterMs
          : Math.max(60_000, diag.quarantineMs || 60_000);
        opened.set(provider, Date.now() + waitMs);
      }
      if (!error?.budgetAttemptsLogged) await recordAICall({
          provider,
          model: attemptedModel,
          latencyMs: Date.now() - start,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          intent: 'falha',
          success: false,
          error: `[${diag.code}] ${diag.message}`
        });
      console.error(`[ai:${provider}] [${diag.code}] ${diag.message}`);
    }
  }
  if (creditExhaustionProvider && !(args?.isOwner === true && attemptDiagnostics.length > 1)) {
    return providerCreditExhaustionReply(creditExhaustionProvider);
  }
  if (args?.isOwner === true && !args?.disableToolCalling && attemptDiagnostics.length > 0) {
    return providerFailureDiagnosticReply(attemptDiagnostics);
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
    const diag = describeAIError(p, err, model);
    lastErrors.set(p, { code: diag.code, message: diag.message, model, at: new Date().toISOString() });
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
      error: `[${diag.code}] ${diag.message}`
    });
    return {
      ok: false,
      provider: p,
      model,
      latencyMs,
      code: diag.code,
      error: diag.message
    };
  }
}

export function getAIMetrics() {
  return getMetricsSummary(getCircuitBreakers());
}

export { resetMetrics };
