const SENSITIVE_RE = /(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|Bearer\s+[^\s,;]+|(?:key|token|secret)=[^\s&]+)/gi;

function sanitizeRaw(value = '') {
  return String(value || '')
    .replace(SENSITIVE_RE, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b\d{8,15}\b/g, '[NUMERO]')
    .trim()
    .slice(0, 200);
}

/**
 * Converte erros técnicos/HTTP de provedores de IA em diagnósticos claros
 * em português, com código estruturado e janela inteligente de quarentena.
 */
export function describeAIError(provider = 'ia', error = null, model = '') {
  const raw = sanitizeRaw(error?.message || error || 'Erro desconhecido');
  const pLabel = String(provider || 'provedor').trim();
  const mLabel = model ? ` (${model})` : '';

  if (/\b402\b|payment required|insufficient (?:funds|credit|balance)|no credits? remaining|credit balance|billing (?:issue|disabled)/i.test(raw)) {
    return {
      code: 'SALDO_ESGOTADO',
      message: `Saldo ou créditos esgotados em ${pLabel}${mLabel}. Recarregue a conta ou configure um provedor de contingência.`,
      quarantineMs: 10 * 60_000,
      retryable: false,
      isCreditExhausted: true
    };
  }
  if (/\b(401|403)\b|unauthorized|invalid api key|api key not valid|forbidden|permission denied/i.test(raw)) {
    return {
      code: 'CREDENCIAIS_INVALIDAS',
      message: `Chave de API inválida, expirada ou sem permissão em ${pLabel}${mLabel}. Atualize a credencial em Provedores de IA.`,
      quarantineMs: 5 * 60_000,
      retryable: false,
      isCreditExhausted: false
    };
  }
  if (/\b429\b|rate limit|too many requests|quota exceeded|resource_exhausted/i.test(raw)) {
    return {
      code: 'LIMITE_REQUISICOES',
      message: `Limite de requisições (rate limit/cota) atingido em ${pLabel}${mLabel}. Quarentena de 60s aplicada; contingência acionada.`,
      quarantineMs: 60_000,
      retryable: true,
      isCreditExhausted: /quota exceeded/i.test(raw)
    };
  }
  if (/\b404\b|not found|does not exist|model.*not.*found/i.test(raw)) {
    return {
      code: 'MODELO_INEXISTENTE',
      message: `Modelo${mLabel} não encontrado ou indisponível em ${pLabel}. Verifique o identificador do modelo.`,
      quarantineMs: 0,
      retryable: false,
      isCreditExhausted: false
    };
  }
  if (/\b413\b|context length|maximum context|payload too large|token limit/i.test(raw)) {
    return {
      code: 'CONTEXTO_EXCEDIDO',
      message: `O tamanho do contexto/prompt excedeu o limite suportado por ${pLabel}${mLabel}.`,
      quarantineMs: 0,
      retryable: true,
      isCreditExhausted: false
    };
  }
  if (/\b(500|502|503|504)\b|overloaded|service unavailable|bad gateway|internal server error/i.test(raw)) {
    return {
      code: 'SERVICO_INSTAVEL',
      message: `Instabilidade temporária nos servidores de ${pLabel}${mLabel} (HTTP 5xx). Contingência acionada.`,
      quarantineMs: 30_000,
      retryable: true,
      isCreditExhausted: false
    };
  }
  if (/AbortError|TimeoutError|timed? ?out|deadline/i.test(raw)) {
    return {
      code: 'TIMEOUT',
      message: `Tempo limite excedido aguardando resposta de ${pLabel}${mLabel}.`,
      quarantineMs: 15_000,
      retryable: true,
      isCreditExhausted: false
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|socket/i.test(raw)) {
    return {
      code: 'REDE_INDISPONIVEL',
      message: `Falha de rede/DNS ao conectar em ${pLabel}. Verifique a URL base e a conectividade.`,
      quarantineMs: 30_000,
      retryable: true,
      isCreditExhausted: false
    };
  }
  return {
    code: 'ERRO_PROVEDOR',
    message: `Falha em ${pLabel}${mLabel}: ${raw}`,
    quarantineMs: 15_000,
    retryable: true,
    isCreditExhausted: false
  };
}
