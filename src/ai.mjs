// Fachada pública do subsistema de IA. A implementação vive em ./ai/*.mjs.

export { resolveAIConfig, providers, available, OPENROUTER_FREE_MODELS, getCircuitBreakers, getRecentAIErrorSummary } from './ai/config.mjs';
export { responseSchema, buildOpenRouterBody, normalizeHistory, extractTruncatedReply, parseAIResponse } from './ai/parsing.mjs';
export { shouldEnableGoogleSearch, searchWebWithGemini } from './ai/search.mjs';
export { analyzeDocument } from './ai/documents.mjs';
export { transcribeAudio, synthesizeVoice, getVoiceRuntimeStatus } from './ai/voice.mjs';
export { call, askAI, pingAI, getAIMetrics, resetMetrics } from './ai/call.mjs';
