const state = {
  sessions: [],
  selected: null,
  view: 'overview',
  mode: 'real',
  agent: null,
  metrics: null,
  refreshTimer: null,
  metricsTimer: null,
  adminConfig: null,
  adminSaveTimer: null,
  adminFormDirty: false,
  adminChangeVersion: 0,
  adminSaveInFlight: false,
  adminSaveQueued: false,
  role: 'viewer',
  tools: null,
  operations: null,
  modelCatalogProvider: null,
  modelCatalog: [],
  fallbackCatalogs: {},
  initialized: false
};

const $ = (selector) => document.querySelector(selector);
const esc = (value = '') =>
  String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

const API_BASE = '';
let supabase;
let accessToken = '';
let captcha = { token: '', reset: null, configured: false };

function readableAuthError(error) {
  if (!error) return 'Não foi possível entrar.';
  const raw = typeof error === 'string' ? error : error.message || error.error_description || error.msg || error.error || '';
  if (/^Conclua a validação CAPTCHA/i.test(raw)) return raw;
  if (/captcha protection|captcha_token|captcha/i.test(raw)) return 'O Supabase exige CAPTCHA para este login. Configure o widget CAPTCHA neste dashboard ou desative a proteção CAPTCHA em Authentication > Bot and Abuse Protection.';
  if (typeof error === 'string') return error;
  return raw || 'Não foi possível entrar.';
}

async function setupCaptcha(authConfig) {
  const container = $('#login-captcha');
  if (!container || !authConfig.captchaSiteKey) return;
  const provider = authConfig.captchaProvider === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
  const scriptId = `captcha-script-${provider}`;
  const scriptSrc = provider === 'hcaptcha' ? 'https://js.hcaptcha.com/1/api.js?render=explicit' : 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  container.classList.remove('hidden');
  container.dataset.provider = provider;
  if (!document.getElementById(scriptId)) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = scriptSrc;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar o widget CAPTCHA.'));
      document.head.appendChild(script);
    });
  }
  const api = provider === 'hcaptcha' ? window.hcaptcha : window.turnstile;
  if (!api?.render) throw new Error('Widget CAPTCHA indisponível.');
  // O script é carregado dinamicamente e o onload acima já garante que a API
  // está pronta. Não chamar turnstile.ready() aqui: o navegador pode marcar
  // scripts dinamicamente inseridos como async, o que gera o erro oficial
  // "Remove async/defer ... before using turnstile.ready()".
  const widgetId = api.render(container, { sitekey: authConfig.captchaSiteKey, action: 'login', callback: token => { captcha.token = token; }, 'expired-callback': () => { captcha.token = ''; }, 'error-callback': () => { captcha.token = ''; } });
  captcha = { token: '', reset: () => api.reset(widgetId), configured: true };
  captcha.getToken = () => provider === 'turnstile' && typeof api.getResponse === 'function' ? api.getResponse(widgetId) || '' : captcha.token;
}

async function initAuth() {
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/auth/config`);
    const config = await response.json().catch(() => ({}));
    if (!config.supabaseUrl || !config.publishableKey) {
      showLogin();
      $('#login-error').textContent = 'Autenticação indisponível: configure o provedor de login.';
      return;
    }
    const { createClient } = await import('/dashboard/vendor/supabase.js');
    supabase = createClient(config.supabaseUrl, config.publishableKey);
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      accessToken = data.session.access_token;
      showDashboard();
      return;
    }
    showLogin();
    // O Turnstile precisa ser renderizado depois que o formulário e todos os
    // seus ancestrais deixam de estar com display:none. Renderizá-lo antes de
    // showLogin() faz o widget ficar preso em "Verifying..." e não emitir token.
    if (config.captchaSiteKey) await setupCaptcha(config);
    $('#login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      $('#login-error').textContent = '';
      const submit = $('#login-form button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const captchaToken = captcha.getToken ? captcha.getToken() : captcha.token;
        if (captcha.configured && !captchaToken) {
          throw new Error('Conclua a validação CAPTCHA antes de entrar.');
        }
        const { data: result, error } = await supabase.auth.signInWithPassword({
          email: $('#login-email').value.trim(),
          password: $('#login-password').value,
          captchaToken: captchaToken || undefined
        });
        if (error) {
          if (captcha.reset) captcha.reset();
          captcha.token = '';
          $('#login-error').textContent = readableAuthError(error);
          return;
        }
        accessToken = result.session?.access_token || '';
        if (!accessToken) throw new Error('O Supabase não retornou um token de acesso.');
        showDashboard();
      } catch (error) {
        $('#login-error').textContent = readableAuthError(error);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      accessToken = session?.access_token || '';
      if (session) showDashboard();
      else showLogin();
    });
  } catch (error) {
    showLogin();
    $('#login-error').textContent = readableAuthError(error);
  }
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#dashboard-shell').classList.add('hidden');
}

function showDashboard() {
  $('#login-screen').classList.add('hidden');
  $('#dashboard-shell').classList.remove('hidden');
  if (!state.initialized) {
    state.initialized = true;
    startDashboard();
  }
}

async function syncSession({ forceRefresh = false } = {}) {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession({ forceRefresh });
  accessToken = data.session?.access_token || '';
  return Boolean(accessToken);
}

async function api(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    await syncSession({ forceRefresh: attempt === 1 });
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    response = await fetch(url, { ...options, headers });
    if (response.status !== 401 || attempt === 1) break;
  }
  if (response.status === 401) {
    await supabase?.auth.signOut();
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 403) throw new Error('Seu usuário autenticou, mas ainda não possui um perfil ativo/autorizado no Supabase. Ative o perfil em public.profiles.');
    if (response.status === 503) throw new Error('O serviço de autorização do Supabase está temporariamente indisponível.');
    throw new Error(detail);
  }
  return response.json();
}

function initials(name = '') {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '??'
  );
}

function selectedSession() {
  return state.sessions.find((item) => item.phone === state.selected);
}

function renderList() {
  const query = ($('#search').value || '').toLowerCase();
  const items = state.sessions.filter((item) => `${item.name || ''} ${item.displayName || ''} ${item.phone || ''} ${item.phoneFormatted || ''}`.toLowerCase().includes(query));
  $('#conversation-count').textContent = state.sessions.length;
  $('#handoff-count').textContent = state.sessions.filter((item) => item.human).length;
  $('#conversation-items').innerHTML = items.length
    ? items
        .map(
          (item) => {
            const titleName = esc(item.displayName || item.name || 'Contato');
            const phoneLabel = esc(item.phoneFormatted || item.phone || '');
            const timeLabel = esc(item.time || '');
            const previewText = esc(item.preview || 'Sem mensagens ainda');
            const isSelected = item.phone === state.selected ? 'selected' : '';
            const statusLabel = item.human ? 'aguarda atendimento' : 'bot ativo';
            const statusClass = item.human ? 'human' : 'bot';

            return `<div class="conversation ${isSelected}" data-phone="${esc(item.phone)}"><div class="contact-avatar">${esc(
              initials(titleName)
            )}</div><div class="conversation-body"><div class="conversation-top"><strong title="${titleName}">${titleName}</strong><time>${timeLabel}</time></div><div class="conversation-phone-tag" style="font-size:11px;opacity:0.75;margin-bottom:2px;font-family:monospace;">${phoneLabel}</div><p>${previewText}</p><span class="mode-mini ${statusClass}">${statusLabel}</span></div></div>`;
          }
        )
        .join('')
    : '<div class="detail-placeholder" style="padding:25px 18px">Nenhuma sessão encontrada. Use “+” para iniciar um teste.</div>';
  document.querySelectorAll('.conversation').forEach((el) =>
    el.addEventListener('click', () => {
      state.selected = el.dataset.phone;
      render();
    })
  );
}

function renderChat() {
  const session = selectedSession();
  if (!session) {
    $('#chat-empty').classList.remove('hidden');
    $('#chat-active').classList.add('hidden');
    $('#detail-content').innerHTML = '<div class="detail-placeholder">Nenhuma conversa selecionada.</div>';
    return;
  }
  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  const dName = session.displayName || session.name || 'Contato';
  const cleanNum = String(session.phone || '').replace(/\D/g, '');
  const fPhone = session.phoneFormatted || session.phone || '';

  $('#chat-avatar').textContent = initials(dName);
  $('#chat-name').textContent = dName;
  const phoneLink = $('#chat-phone-link');
  if (phoneLink) {
    phoneLink.href = cleanNum ? `https://wa.me/${cleanNum}` : '#';
  }
  $('#chat-phone').textContent = fPhone;
  const badge = $('#chat-mode');
  badge.textContent = session.human ? 'HUMANO' : 'BOT ATIVO';
  badge.className = `mode-badge ${session.human ? 'human' : 'bot'}`;
  $('#messages').innerHTML =
    (session.history || [])
      .map(
        (message) => {
          const time = message.createdAt ? new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';
          return `<div class="bubble ${message.role === 'user' ? 'in' : 'out'}">${esc(message.content)}<small>${
            message.role === 'user' ? 'contato' : 'lia'
          }${time ? ` · ${time}` : ''}</small></div>`;
        }
      )
      .join('') || '<div class="detail-placeholder" style="margin:auto">Envie uma mensagem de teste para começar.</div>';
  $('#messages').scrollTop = $('#messages').scrollHeight;
  $('#message-input').disabled = false;
  $('#composer button').disabled = false;
  $('#message-input').placeholder = state.mode === 'real'
    ? (session.human ? 'Responder cliente via WhatsApp (modo humano ativo)...' : 'Responder cliente via WhatsApp (assume atendimento)...')
    : 'Digite uma mensagem de teste para a simulação...';
  $('#detail-content').innerHTML = `<div class="detail-block"><h3>Contato</h3><div class="detail-profile"><div class="contact-avatar">${esc(
    initials(dName)
  )}</div><div><strong>${esc(dName)}</strong><span>${esc(fPhone)}</span>${cleanNum ? `<br><a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent,#4ade80);text-decoration:none;display:inline-block;margin-top:4px;">Abrir no WhatsApp ↗</a>` : ''}</div></div></div><div class="detail-block"><h3>Estado</h3><div class="detail-row"><span>Modo atual</span><b>${
    session.human ? 'Humano' : 'Bot'
  }</b></div><div class="detail-row"><span>Última atividade</span><b>${esc(session.time || 'agora')}</b></div></div><button class="detail-action primary" id="toggle-mode">${
    session.human ? 'Reativar bot' : 'Transferir para humano'
  }</button><button class="detail-action" id="clear-session">${
    state.mode === 'real' ? 'Arquivar conversa' : 'Limpar sessão de teste'
  }</button>`;
  $('#toggle-mode').addEventListener('click', () => setMode(session.human ? 'bot' : 'human'));
  $('#clear-session').addEventListener('click', clearSession);
}

function agentTopic(topic) {
  for (const group of ['knowledge', 'capabilities', 'controls']) if (state.agent?.[group]?.[topic]) return state.agent[group][topic];
  return null;
}

function formatAgentValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `<ul>${value.map((item) => `<li>${formatAgentValue(item)}</li>`).join('')}</ul>`;
  if (typeof value === 'object') return `<dl>${Object.entries(value).map(([key, item]) => `<dt>${esc(key)}</dt><dd>${formatAgentValue(item)}</dd>`).join('')}</dl>`;
  return `<span>${esc(value)}</span>`;
}

function renderAgentDrawer(topic) {
  const item = agentTopic(topic);
  if (!item) return;
  $('#agent-drawer-title').textContent = item.title || 'Detalhes do módulo';
  $('#agent-drawer-subtitle').textContent = item.description || 'Informações ativas';
  const details = Object.entries(item).filter(([key]) => !['title', 'description'].includes(key));
  $('#agent-drawer-content').innerHTML = details.length
    ? details.map(([key, value]) => `<section class="agent-detail-block"><strong>${esc(key)}</strong>${formatAgentValue(value)}</section>`).join('')
    : '<p>Este módulo está ativo conforme a configuração atual do bot.</p>';
  $('#agent-detail-drawer').classList.remove('hidden');
}

async function renderAgent() {
  if (!state.agent) {
    try {
      state.agent = await api('/api/dashboard/agent-structure');
    } catch (error) {
      $('#agent-drawer-content').innerHTML = `<p>Não foi possível carregar a estrutura do agente.<br>${esc(error.message)}</p>`;
      return;
    }
  }
  document.querySelectorAll('.agent-card-item[data-topic]').forEach((card) => {
    card.onclick = () => renderAgentDrawer(card.dataset.topic);
  });
}

function renderSettings() {
  api('/api/dashboard/config')
    .then((config) => {
      $('#cfg-provider').value = config.provider;
      $('#cfg-model').value = config.model;
      $('#cfg-instance').value = config.instance;
      $('#cfg-cache').value = `${config.faqCacheSeconds}s`;
      $('#faq-status').textContent = config.faqUrl ? 'remota + local' : 'local';
    })
    .catch(() => {});

  loadProviderModels();
}

async function renderMetrics() {
  try {
    const data = await api('/api/dashboard/metrics');
    state.metrics = data;
    const { overview, circuitBreakers, recentCalls, recentErrors, system, estimatedCost, byProviderModel, source, scope, truncated } = data || {};

    // 1. Latência
    const avg = overview?.avgLatencyMs || 0;
    const elAvg = $('#metric-avg-latency') || $('#kpi-latency');
    if (elAvg) elAvg.textContent = avg;
    const elLast = $('#metric-last-latency');
    if (elLast) elLast.textContent = overview?.lastLatencyMs ? `${overview.lastLatencyMs} ms` : '—';
    const elP95 = $('#metric-p95-latency');
    if (elP95) elP95.textContent = overview?.p95LatencyMs ? `${overview.p95LatencyMs} ms` : '—';
    const latBadge = $('#metric-latency-badge') || $('#kpi-latency-status');
    if (latBadge) {
      if (avg === 0) {
        latBadge.textContent = 'Sem dados';
        latBadge.className = 'pill mini pale';
        latBadge.removeAttribute('style');
      } else if (avg < 1200) {
        latBadge.textContent = '⚡ Rápido';
        latBadge.className = 'pill mini mint';
        latBadge.removeAttribute('style');
      } else if (avg < 3000) {
        latBadge.textContent = '✓ Normal';
        latBadge.className = 'pill mini mint';
        latBadge.removeAttribute('style');
      } else {
        latBadge.textContent = '⚠ Alto';
        latBadge.className = 'pill mini';
        latBadge.style.background = '#ffe6e2';
        latBadge.style.color = '#b85842';
      }
    }

    // 2. Consumo de Tokens
    const totalTok = overview?.totalTokens || 0;
    const elTok = $('#metric-total-tokens');
    if (elTok) elTok.textContent = totalTok >= 1000 ? `${(totalTok / 1000).toFixed(1)}k` : totalTok;
    const elPromptTok = $('#metric-prompt-tokens');
    if (elPromptTok) elPromptTok.textContent = overview?.totalPromptTokens || 0;
    const elCompTok = $('#metric-completion-tokens');
    if (elCompTok) elCompTok.textContent = overview?.totalCompletionTokens || 0;
    const elCost = $('#metric-cost-badge');
    if (elCost) {
      elCost.textContent = estimatedCost?.complete
        ? `US$ ${Number(estimatedCost.totalUsd || 0).toFixed(4)} / mês`
        : estimatedCost?.knownUsd > 0 ? `≥ US$ ${Number(estimatedCost.knownUsd).toFixed(4)}*` : 'Não calculado';
      elCost.className = `pill mini ${estimatedCost?.complete ? 'mint' : 'pale'}`;
      elCost.title = estimatedCost?.note || 'Custo monetário não calculado.';
    }

    const sourceEl = $('#metrics-data-source');
    if (sourceEl) sourceEl.textContent = `Origem: ${source === 'supabase' ? 'histórico persistido no Supabase' : 'memória desta instância'} · ${scope || 'escopo indisponível'}${truncated ? ' · histórico limitado a 5.000 chamadas' : ''}${estimatedCost?.complete === false ? ' · custo incompleto por tarifa ausente, uso desconhecido ou histórico limitado' : ''}${overview?.tokenUsageComplete === false ? ' · tokens de falhas não contabilizados' : ''}`;
    const providerTable = $('#metrics-provider-model');
    if (providerTable) providerTable.innerHTML = byProviderModel?.length ? byProviderModel.map(item => {
      const monthCost = item.monthlyEstimatedUsd === null ? 'Não calculado' : `US$ ${Number(item.monthlyEstimatedUsd || 0).toFixed(4)}`;
      const budget = item.budgetUsd === null ? '—' : `US$ ${Number(item.budgetUsd).toFixed(2)} · ${item.budgetUsagePercent === null ? (item.monthlyTokenUsageComplete ? 'sem tarifa' : 'uso incompleto') : `${item.budgetUsagePercent}%`}`;
      const tokenUse = item.tokenUsageComplete ? `${Number(item.promptTokens || 0).toLocaleString('pt-BR')} / ${Number(item.completionTokens || 0).toLocaleString('pt-BR')}` : `${Number(item.promptTokens || 0).toLocaleString('pt-BR')} / ${Number(item.completionTokens || 0).toLocaleString('pt-BR')} · parcial`;
      return `<tr><td><strong>${esc(item.provider)}</strong><div class="ops-muted">${esc(item.model)}</div></td><td>${item.requests} <span class="ops-muted">(${item.failedRequests} falhas)</span></td><td title="Chamadas com falha não têm tokens presumidos">${tokenUse}</td><td>${Number(item.avgLatencyMs || 0)} ms</td><td>${monthCost}</td><td>${budget}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="table-empty">Nenhuma chamada persistida no escopo informado.</td></tr>';

    if (state.role === 'admin') await loadPricingDraft();

    // 3. Taxa de Sucesso
    const rate = overview?.successRate ?? 100;
    const elRate = $('#metric-success-rate');
    if (elRate) elRate.textContent = `${rate}%`;
    const elReqs = $('#metric-total-reqs') || $('#kpi-calls');
    if (elReqs) elReqs.textContent = overview?.totalRequests || 0;
    const elFails = $('#metric-total-fails') || $('#kpi-errors');
    if (elFails) elFails.textContent = overview?.failedRequests || 0;
    const rateBadge = $('#metric-rate-badge');
    if (rateBadge) {
      if (overview?.failedRequests > 0) {
        rateBadge.textContent = `${overview.failedRequests} falhas`;
        rateBadge.className = 'pill mini';
        rateBadge.style.background = '#ffe6e2';
        rateBadge.style.color = '#b85842';
      } else {
        rateBadge.textContent = '100% estável';
        rateBadge.className = 'pill mini mint';
        rateBadge.removeAttribute('style');
      }
    }

    // 4. Provedor Ativo
    const elProv = $('#metric-active-provider') || $('#kpi-provider');
    if (elProv) elProv.textContent = (system?.activeProvider || 'Gemini').toUpperCase();
    const elModel = $('#metric-active-model') || $('#kpi-model');
    if (elModel) elModel.textContent = system?.activeModel || '—';
    renderActiveModelLabel();

    // 5. Badge de status no menu lateral
    const anyQuarantine = Object.values(circuitBreakers || {}).some((c) => c.status === 'aberto');
    const badgeMini = $('#metrics-status-badge');
    if (badgeMini) {
      if (anyQuarantine) {
        badgeMini.textContent = 'alerta';
        badgeMini.className = 'badge-mini err';
      } else if (overview?.failedRequests > 0) {
        badgeMini.textContent = 'atenção';
        badgeMini.className = 'badge-mini warn';
      } else {
        badgeMini.textContent = 'ok';
        badgeMini.className = 'badge-mini ok';
      }
    }

    // 6. Tabela de chamadas recentes
    const elHistCount = $('#metrics-history-count');
    if (elHistCount) elHistCount.textContent = `${recentCalls?.length || 0} registradas`;
    const tbody = $('#metrics-history-tbody');
    if (tbody) {
      if (!recentCalls || recentCalls.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Nenhuma chamada registrada ainda. Envie uma mensagem na aba Conversas ou faça um teste de ping.</td></tr>';
      } else {
        tbody.innerHTML = recentCalls
          .map((item) => {
            const time = new Date(item.timestamp).toLocaleTimeString('pt-BR');
            const speedClass = item.latencyMs < 1200 ? 'fast' : item.latencyMs < 3000 ? 'medium' : 'slow';
            const barWidth = Math.min(80, Math.max(10, Math.round((item.latencyMs / 4000) * 80)));
            const statusHtml = item.success
              ? '<span class="status-label"><span class="status-dot"></span> ok</span>'
              : '<span class="pill mini" style="background:#ffe6e2;color:#b85842">falha</span>';
            return `<tr>
            <td><time style="color:var(--muted)">${time}</time></td>
            <td><strong>${esc(item.provider)}</strong><div style="font-size:9px;color:var(--muted)">${esc(item.model || '')}</div></td>
            <td><span class="tag-intent">${esc(item.intent || 'outro')}</span></td>
            <td>
              <div class="latency-bar-container">
                <div class="latency-bar ${speedClass}" style="width:${barWidth}px"></div>
                <span>${item.latencyMs} ms</span>
              </div>
            </td>
            <td>${item.tokenUsageKnown === false ? '<span class="ops-muted">tokens desconhecidos</span>' : `<span style="color:var(--muted)">↓${item.promptTokens || 0} ↑${item.completionTokens || 0}</span> <b>(${item.totalTokens || 0})</b>`}</td>
            <td>${statusHtml}</td>
          </tr>`;
          })
          .join('');
      }
    }

    // 7. Lista de Circuit Breakers
    const circuitList = $('#metrics-circuit-list');
    if (circuitList) {
      const provEntries = Object.entries(circuitBreakers || {});
      circuitList.innerHTML = provEntries
        .map(([prov, info]) => {
          const isCurrent = prov === system?.activeProvider;
          let statusBadge = '<span class="pill mini mint">operacional</span>';
          if (!info.configured) statusBadge = '<span class="pill mini pale">não configurado</span>';
          else if (info.status === 'aberto') statusBadge = `<span class="pill mini" style="background:#ffe6e2;color:#b85842">aberto (${info.quarantineSeconds}s)</span>`;
          else if (info.status === 'degradado') statusBadge = `<span class="pill mini" style="background:#fff3d6;color:#8a6217">degradado (${info.failures} err)</span>`;

          return `<div class="provider-status-card">
          <div>
            <strong>${esc(prov.toUpperCase())} ${isCurrent ? '<span class="pill mini mint" style="font-size:8px">ativo</span>' : ''}</strong>
            <span>${info.configured ? `Disjuntor: ${info.status} · Falhas: ${info.failures}` : 'Chave não informada no .env'}</span>
          </div>
          <div>${statusBadge}</div>
        </div>`;
        })
        .join('');
    }

    // 8. Lista de erros sanitizada
    const elErrCount = $('#metrics-errors-count');
    if (elErrCount) elErrCount.textContent = recentErrors?.length || 0;
    const errorsList = $('#metrics-errors-list');
    if (errorsList) {
      if (!recentErrors || recentErrors.length === 0) {
        errorsList.innerHTML = '<div class="detail-placeholder" style="padding:16px;">Nenhum erro registrado. Todas as chamadas operando normalmente sem quedas.</div>';
      } else {
        errorsList.innerHTML = recentErrors
          .map((err) => {
            const time = new Date(err.timestamp).toLocaleTimeString('pt-BR');
            return `<div class="error-item">
            <div class="error-head">
              <strong>${esc(err.provider?.toUpperCase() || 'ERRO')}</strong>
              <time>${time}</time>
            </div>
            <div class="error-msg">${esc(err.message || 'Falha de comunicação')}</div>
          </div>`;
          })
          .join('');
      }
    }
  } catch (err) {
    console.error('[metrics]', err);
  }
}

function renderHandoff() {
  const container = $('#handoff-list');
  if (!container) return;
  const list = state.sessions.filter((item) => item.human);
  const counter = $('#handoff-count');
  if (counter) counter.textContent = list.length;

  if (!list.length) {
    container.innerHTML = '<div class="empty-state" style="padding:40px 18px;text-align:center;"><p>Nenhum transbordo pendente. O robô está atendendo normalmente.</p></div>';
    return;
  }

  container.innerHTML = list
    .map((item) => {
      const dName = esc(item.displayName || item.name || 'Contato');
      const fPhone = esc(item.phoneFormatted || item.phone || '');
      const cleanNum = String(item.phone || '').replace(/\D/g, '');
      const reason = esc(item.handoffReason || 'Solicitação para falar diretamente com o responsável');
      const timeWait = esc(item.time || 'recente');
      const urgency = item.handoffUrgency === 'urgente' ? '<span class="pill mini" style="background:#ffe6e2;color:#b85842;">URGENTE</span>' : '';

      return `
      <div class="handoff-card">
        <div class="handoff-info">
          <div class="handoff-header">
            <strong>${dName}</strong>
            <span style="font-family:monospace;font-size:12px;opacity:0.8;">${fPhone}</span>
            ${urgency}
          </div>
          <div class="handoff-reason">Motivo: <em>${reason}</em></div>
          <div class="handoff-meta">
            <span>Última mensagem: ${timeWait}</span>
            <span>Origem: ${item.origin === 'simulation' ? 'Simulação' : 'WhatsApp Real'}</span>
          </div>
        </div>
        <div class="handoff-actions">
          <button class="btn-handoff primary" data-open-chat="${esc(item.phone)}">Abrir Conversa</button>
          ${cleanNum ? `<a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" class="btn-handoff wa">WhatsApp ↗</a>` : ''}
          <button class="btn-handoff resume" data-resume-bot="${esc(item.phone)}">Reativar Bot</button>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('[data-open-chat]').forEach((btn) => {
    btn.onclick = () => {
      state.selected = btn.dataset.openChat;
      showView('inbox');
    };
  });

  container.querySelectorAll('[data-resume-bot]').forEach((btn) => {
    btn.onclick = async () => {
      const phone = btn.dataset.resumeBot;
      btn.disabled = true;
      btn.textContent = 'Reativando...';
      try {
        await api('/api/dashboard/mode', { method: 'POST', body: JSON.stringify({ phone, mode: 'bot' }) });
        await refresh();
      } catch (e) {
        window.alert(e.message || 'Erro ao reativar bot');
      }
    };
  });
}

const adminGet = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const adminSet = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((value, key) => (value[key] ||= {}), object);
  target[last] = value;
};

function adminFeedback(message, type = 'success') {
  const el = $('#admin-feedback');
  if (!el) return;
  el.textContent = message;
  el.className = `admin-feedback ${type}`;
  clearTimeout(adminFeedback.timer);
  adminFeedback.timer = setTimeout(() => el.classList.add('hidden'), 4500);
}

function renderAdminFaq() {
  const list = $('#admin-faq-list');
  const faq = state.adminConfig?.draft?.knowledge?.faq || [];
  $('#admin-faq-summary').textContent = `${faq.length} itens no rascunho · alterações entram após publicação`;
  list.innerHTML = faq.map((item, index) => `<div class="admin-faq-row" data-faq-index="${index}">
    <div class="admin-faq-key"><span class="faq-index">${String(index + 1).padStart(2, '0')}</span><input data-faq-keys value="${esc((item.keys || []).join(', '))}" aria-label="Palavras-chave" /></div>
    <textarea data-faq-answer rows="2" aria-label="Resposta">${esc(item.answer || '')}</textarea>
    <label class="faq-enabled"><input type="checkbox" data-faq-enabled ${item.enabled !== false ? 'checked' : ''} /> ativo</label>
    <button class="icon-btn faq-remove" data-faq-remove="${index}" aria-label="Remover item">×</button>
  </div>`).join('') || '<div class="detail-placeholder admin-empty">Nenhum item cadastrado. Adicione a primeira resposta da base.</div>';
}

function updateHumanDestinationVisibility() {
  const destSelect = $('#admin-human-destination');
  const phoneGroup = $('#admin-human-phone-group');
  if (destSelect && phoneGroup) {
    const isCustom = destSelect.value === 'custom';
    phoneGroup.style.display = isCustom ? 'flex' : 'none';
  }
}

function renderAdmin({ force = false } = {}) {
  // Atualizações globais chegam enquanto o usuário edita. Nunca sobrescreva
  // controles locais antes da confirmação do autosave.
  if (state.adminFormDirty && !force) return;
  const draft = state.adminConfig?.draft;
  if (!draft) return;
  document.querySelectorAll('[data-config]').forEach(input => {
    const value = adminGet(draft, input.dataset.config);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (input.dataset.config === 'identity.aliases') input.value = Array.isArray(value) ? value.join(', ') : (value ?? '');
  else input.value = value ?? '';
  });
  renderActiveModelLabel();
  updateHumanDestinationVisibility();
  loadProviderModels();
  loadFallbackCatalogs();
  renderHoursWeekdays(draft);
  renderHoursPreview();
  const revision = state.adminConfig.revision || 0;
  $('#admin-version-badge').textContent = `rascunho · v${revision}`;
  $('#admin-draft-badge').classList.toggle('hidden', JSON.stringify(state.adminConfig.active) === JSON.stringify(draft));
  renderAdminFaq();
}

function renderActiveModelLabel() {
  const label = $('#admin-ai-active-model');
  if (!label) return;
  const runtime = state.metrics?.system;
  const draft = state.adminConfig?.draft?.ai;
  const active = state.adminConfig?.active?.ai;
  const model = runtime?.activeModel || draft?.activeModel || active?.activeModel || 'gemini-3.8-flash';
  const provider = runtime?.activeProvider || draft?.activeProvider || active?.activeProvider || 'gemini';
  label.textContent = `${provider} · ${model}`;
}

// A regra do expediente vive no servidor; a tela apenas reflete a prévia publicada.
function renderHoursWeekdays(draft) {
  const days = Array.isArray(draft?.business?.hoursConfig?.weekdays) ? draft.business.hoursConfig.weekdays.map(Number) : [];
  document.querySelectorAll('.admin-hours-weekday').forEach(input => {
    input.checked = days.includes(Number(input.value));
  });
}

function renderHoursPreview() {
  const badge = $('#admin-hours-published');
  const summary = $('#admin-hours-summary');
  if (!badge || !summary) return;
  const published = state.adminConfig?.hoursPreview || null;
  const draftPreview = state.adminConfig?.hoursDraftPreview || null;
  if (!published && !draftPreview) {
    badge.textContent = 'sem prévia';
    summary.textContent = 'Publique uma versão para ver o expediente efetivo usado pela Lia e lido pelo Chatwoot.';
    return;
  }
  badge.textContent = published
    ? (published.enabled ? (published.isOpenNow ? 'publicado · aberto' : 'publicado · fechado') : 'publicado · 24 horas')
    : 'sem publicação';
  const pending = published && draftPreview && JSON.stringify(published) !== JSON.stringify(draftPreview);
  const next = draftPreview?.enabled && !draftPreview.isOpenNow && draftPreview.nextOpenAt
    ? ` Reabertura em ${new Date(draftPreview.nextOpenAt).toLocaleString('pt-BR')}.` : '';
  summary.textContent = `Rascunho: ${draftPreview?.summary || '–'}.${next}${pending ? ' Ainda vale o expediente publicado até você publicar.' : ''}`;
}

async function loadProviderModels({ refresh = false } = {}) {
  const provider = $('#admin-ai-provider')?.value;
  const primary = $('#admin-ai-model');
  const status = $('#admin-ai-models-status');
  if (!provider || !primary) return;
  if (!refresh && state.modelCatalogProvider === provider && state.modelCatalog.length) {
    renderModelOptions(state.modelCatalog, primary);
    return;
  }
  if (status) status.textContent = 'Consultando catálogo seguro do provedor…';
  try {
    const result = await api(`/api/dashboard/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=true' : ''}`);
    if (!result.ok || !Array.isArray(result.models)) throw new Error(result.error || 'catalog_unavailable');
    state.modelCatalogProvider = provider;
    state.modelCatalog = result.models;
    renderModelOptions(result.models, primary);
    if (status) status.textContent = `${result.models.length} modelos disponíveis${result.truncated ? ' (lista parcial: limite de paginação atingido)' : ''}${result.cached ? ' (cache recente)' : ''}. As chaves permanecem no servidor.`;
  } catch (error) {
    state.modelCatalogProvider = provider;
    state.modelCatalog = [];
    if (status) {
      let code = error.message;
      try { code = JSON.parse(code).error || code; } catch {}
      status.textContent = code === 'provider_not_configured'
        ? 'Este provedor não está configurado no servidor; nenhuma chave é solicitada ou exibida aqui.'
        : `Não foi possível consultar modelos (${code}). Verifique a chave e a conectividade do provedor no servidor.`;
    }
    const savedModel = String(state.adminConfig?.draft?.ai?.activeModel || '').trim();
    primary.replaceChildren(new Option(savedModel ? `${savedModel} (salvo no banco; catálogo indisponível)` : 'Catálogo indisponível', savedModel));
    if (savedModel) primary.value = savedModel;
  }
}

function renderModelOptions(models, primary) {
  const draft = state.adminConfig?.draft?.ai || {};
  const selectedPrimary = primary.value || draft.activeModel || '';
  const addOptions = (select, selected, includePrimary) => {
    const allowed = models.filter(model => includePrimary || model.id !== selectedPrimary);
    const ids = new Set(allowed.map(model => model.id));
    select.replaceChildren(new Option(includePrimary ? 'Selecione modelo principal' : 'Nenhum', ''));
    for (const model of allowed) select.add(new Option(`${model.name} · ${model.id}`, model.id));
    if (selected && !ids.has(selected)) select.add(new Option(`${selected} (salvo no banco; catálogo ainda não retornou)`, selected));
    select.value = selected || '';
  };
  addOptions(primary, selectedPrimary, true);
  const activeModelLabel = $('#admin-ai-active-model');
  if (activeModelLabel && selectedPrimary) activeModelLabel.textContent = selectedPrimary;
}

const FALLBACK_PROVIDERS = [['gemini', 'Gemini'], ['openrouter', 'OpenRouter'], ['openai', 'OpenAI'], ['qwen', 'Qwen']];
function fallbackEntry(value = '') {
  const match = String(value).trim().match(/^(gemini|openrouter|openai|qwen):(.*)$/i);
  return match ? { provider: match[1].toLowerCase(), model: match[2].trim() } : { provider: 'openrouter', model: String(value).trim() };
}
function renderFallbackRows() {
  const container = $('#admin-fallback-rows');
  if (!container || state.adminFormDirty) return;
  const values = Array.isArray(state.adminConfig?.draft?.ai?.fallbackModels) ? state.adminConfig.draft.ai.fallbackModels.slice(0, 3) : [];
  container.innerHTML = [0, 1, 2].map(index => {
    const selected = fallbackEntry(values[index] || '');
    const models = state.fallbackCatalogs[selected.provider] || [];
    const options = models.map(model => `<option value="${esc(model.id)}" ${model.id === selected.model ? 'selected' : ''}>${esc(model.name || model.id)} · ${esc(model.id)}</option>`).join('');
    const extra = selected.model && !models.some(model => model.id === selected.model) ? `<option value="${esc(selected.model)}" selected>${esc(selected.model)} (salvo)</option>` : '';
    return `<label>Reserva ${index + 1}<select class="admin-fallback-provider" data-index="${index}">${FALLBACK_PROVIDERS.map(([id, name]) => `<option value="${id}" ${id === selected.provider ? 'selected' : ''}>${name}</option>`).join('')}</select><select class="admin-fallback-model" data-index="${index}"><option value="">Nenhum modelo</option>${options}${extra}</select></label>`;
  }).join('');
  container.querySelectorAll('.admin-fallback-provider').forEach(select => select.addEventListener('change', async event => {
    await loadFallbackCatalog(event.target.value, { refresh: true });
    renderFallbackRows();
    syncFallbackModelInputs();
  }));
  container.querySelectorAll('.admin-fallback-model').forEach(select => select.addEventListener('change', syncFallbackModelInputs));
}
async function loadFallbackCatalog(provider, { refresh = false } = {}) {
  if (!refresh && state.fallbackCatalogs[provider]) return;
  try {
    const result = await api(`/api/dashboard/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=true' : ''}`);
    state.fallbackCatalogs[provider] = result.ok && Array.isArray(result.models) ? result.models : [];
  } catch { state.fallbackCatalogs[provider] = []; }
}
async function loadFallbackCatalogs() {
  await Promise.all(FALLBACK_PROVIDERS.map(([provider]) => loadFallbackCatalog(provider)));
  renderFallbackRows();
}

function syncFallbackModelInputs() {
  const hidden = $('#admin-ai-fallbacks');
  if (!hidden) return;
  const primary = $('#admin-ai-model')?.value;
  const selected = [...document.querySelectorAll('.admin-fallback-model')].map(select => {
    const provider = document.querySelector(`.admin-fallback-provider[data-index="${select.dataset.index}"]`)?.value;
    return provider && select.value && !(provider === $('#admin-ai-provider')?.value && select.value === primary) ? `${provider}:${select.value}` : '';
  }).filter(Boolean).slice(0, 3);
  hidden.value = selected.join('\n');
  queueAdminSave();
}

function adminReadForm() {
  const draft = state.adminConfig.draft;
  document.querySelectorAll('[data-config]').forEach(input => {
    let value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
    // A consulta de catálogo pode falhar ou ainda estar carregando. Nesse caso,
    // um select vazio não significa que o usuário pediu para apagar o modelo.
    if (input.dataset.config === 'ai.activeModel' && !value) {
      value = String(draft.ai?.activeModel || '').trim();
    }
    if (input.dataset.config === 'identity.aliases') {
      value = String(input.value).split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    }
    adminSet(draft, input.dataset.config, value);
  });
  draft.business ||= {};
  draft.business.hoursConfig ||= {};
  // Os dias são um grupo de checkboxes, não um campo data-config simples.
  draft.business.hoursConfig.weekdays = [...document.querySelectorAll('.admin-hours-weekday')]
    .filter(input => input.checked)
    .map(input => Number(input.value))
    .sort((a, b) => a - b);
  const fallbackInput = $('#admin-ai-fallbacks');
  if (fallbackInput) draft.ai.fallbackModels = fallbackInput.value.split(/[\n,]/).map(value => value.trim()).filter(Boolean).slice(0, 3);
  document.querySelectorAll('.admin-faq-row').forEach(row => {
    const index = Number(row.dataset.faqIndex);
    const item = draft.knowledge.faq[index];
    if (!item) return;
    item.keys = row.querySelector('[data-faq-keys]').value.split(',').map(value => value.trim()).filter(Boolean);
    item.answer = row.querySelector('[data-faq-answer]').value.trim();
    item.enabled = row.querySelector('[data-faq-enabled]').checked;
  });
  draft.ai.enableToolCalling = draft.ai.agentMode === 'super_agente';
}

async function saveAdminDraft(showMessage = false) {
  if (!state.adminConfig) return;
  if (state.adminSaveInFlight) {
    state.adminSaveQueued = true;
    return;
  }
  adminReadForm();
  const requestVersion = state.adminChangeVersion;
  const payload = JSON.parse(JSON.stringify(state.adminConfig.draft));
  state.adminSaveInFlight = true;
  let result;
  try {
    result = await api('/api/admin/config/draft', { method: 'PATCH', body: JSON.stringify(payload) });
  } finally {
    state.adminSaveInFlight = false;
  }
  if (!result.ok) throw new Error((result.errors || []).join(' '));
  if (result.persistence && result.persistence !== 'supabase') throw new Error(result.persistenceError || 'O backend não confirmou a persistência do rascunho.');
  if (requestVersion === state.adminChangeVersion) {
    state.adminConfig = result.snapshot;
    state.adminFormDirty = false;
    renderAdmin();
  } else {
    // Houve nova edição durante a requisição; mantenha a tela e grave a versão atual.
    queueAdminSave();
  }
  if (state.adminSaveQueued) {
    state.adminSaveQueued = false;
    clearTimeout(state.adminSaveTimer);
    state.adminSaveTimer = setTimeout(() => saveAdminDraft().catch(error => adminFeedback(error.message, 'error')), 0);
  }
  if (showMessage) adminFeedback('Rascunho salvo. O bot ainda usa a versão publicada.', 'success');
}

function queueAdminSave() {
  state.adminFormDirty = true;
  state.adminChangeVersion += 1;
  clearTimeout(state.adminSaveTimer);
  state.adminSaveTimer = setTimeout(() => saveAdminDraft().catch(error => adminFeedback(error.message, 'error')), 650);
}

async function renderAdminData() {
  const requestVersion = state.adminChangeVersion;
  try {
    const snapshot = await api('/api/admin/config');
    // A requisição pode terminar depois de o usuário já ter alterado um
    // controle. Nesse caso, o snapshot remoto é antigo para esta tela.
    if (state.adminFormDirty || requestVersion !== state.adminChangeVersion) return;
    state.adminConfig = snapshot;
    state.adminFormDirty = false;
    renderAdmin();
    if (state.adminConfig.persistence !== 'supabase') adminFeedback(state.adminConfig.persistenceError ? `Banco não gravando: ${state.adminConfig.persistenceError}` : 'Banco não configurado: alterações estão somente no arquivo local.', 'error');
  } catch (error) {
    adminFeedback(`Não foi possível carregar a configuração: ${error.message}`, 'error');
  }
}

const ROLE_LEVEL = { viewer: 0, operator: 1, admin: 2 };
function applyRoleVisibility() {
  const level = ROLE_LEVEL[state.role] ?? 0;
  document.querySelectorAll('[data-role]').forEach(el => el.classList.toggle('hidden', level < (ROLE_LEVEL[el.dataset.role] ?? 2)));
  const operationalControls = ['#mode-selector', '#refresh', '#new-sim', '#overview-open-simulation'];
  operationalControls.forEach(selector => $(selector)?.classList.toggle('hidden', level < ROLE_LEVEL.operator));
  if (level < ROLE_LEVEL.operator && ['inbox', 'handoff', 'campaigns', 'admin'].includes(state.view)) showView('overview');
}

function opsFeedback(id, message, type = 'success') {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = message;
  element.className = `admin-feedback ${type}`;
}

async function renderOverview() {
  const healthEl = $('#overview-health');
  const costsEl = $('#overview-costs');
  const modelsEl = $('#overview-models');
  const operationsEl = $('#overview-operations');
  if (!healthEl) return;
  healthEl.innerHTML = '<div class="ops-row">Consultando estado do serviço…</div>';
  const tasks = [api('/api/dashboard/health-summary'), api('/api/dashboard/metrics'), state.role === 'viewer' ? Promise.resolve(null) : api('/api/dashboard/operations')];
  const [healthResult, metricsResult, operationsResult] = await Promise.allSettled(tasks);
  const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
  const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
  const operations = operationsResult.status === 'fulfilled' ? operationsResult.value : null;
  healthEl.innerHTML = health?.readiness?.checks?.length ? health.readiness.checks.map(item => `<div class="ops-row"><strong>${esc(item.name || 'dependência')}</strong><span class="status-text ${item.status === 'ok' || item.status === 'ready' ? 'ok' : item.status === 'not_configured' ? 'warn' : 'err'}">${esc(item.status || 'desconhecido')}</span></div>`).join('') : `<div class="ops-row"><strong>Lia Sync</strong><span class="status-text ${health?.liveness?.status === 'alive' ? 'ok' : 'err'}">${health?.liveness?.status === 'alive' ? 'viva' : 'sem resposta'}</span></div>`;
  const cost = metrics?.estimatedCost;
  if (costsEl) costsEl.innerHTML = `<div class="ops-row"><strong>Custo estimado no mês (UTC)</strong><span>${cost?.complete ? `US$ ${Number(cost.totalUsd || 0).toFixed(4)}` : cost?.knownUsd > 0 ? `≥ US$ ${Number(cost.knownUsd).toFixed(4)}` : 'não calculado'}</span></div><div class="ops-row"><strong>Telemetria</strong><span>${metrics?.source === 'supabase' ? 'persistente' : 'memória local'} · ${Number(metrics?.overview?.totalRequests || 0)} chamadas</span></div>`;
  if (modelsEl) modelsEl.innerHTML = Object.entries(metrics?.circuitBreakers || {}).map(([provider, item]) => `<div class="ops-row"><strong>${esc(provider)}</strong><span>${esc(item.status || 'desconhecido')} · ${item.configured ? `${Number(item.failures || 0)} falhas` : 'não configurado'}</span></div>`).join('') || '<div class="ops-row">Nenhum provedor reportado.</div>';
  if (operationsEl) operationsEl.innerHTML = operations ? `<div class="ops-row"><strong>Campanhas registradas</strong><span>${operations.campaigns?.length || 0}</span></div><div class="ops-row"><strong>Supressões registradas</strong><span>${operations.suppressions?.length || 0} recentes</span></div><div class="ops-row"><strong>Persistência</strong><span>${operations.configured ? 'Supabase ativo' : 'não configurada'}</span></div>` : '<div class="ops-row">Detalhes operacionais de campanhas exigem papel operator.</div>';
}

async function renderTools() {
  try {
    state.tools = await api('/api/dashboard/tools');
    const catalog = state.role === 'admin' && state.tools.draft ? state.tools.draft : state.tools;
    const activeTools = new Map((state.tools.active?.tools || state.tools.tools || []).map(tool => [tool.name, tool.enabled]));
    const list = $('#tools-catalog');
    $('#tools-catalog-count').textContent = `${catalog.tools.length} ferramentas · ${state.tools.persistence || 'configuração local'}${state.role === 'admin' ? ' · exibindo rascunho' : ''}`;
    $('#tools-web-search').checked = catalog.webSearch.enabled;
    $('#tools-web-search').disabled = state.role !== 'admin';
    $('#tools-web-search-meta').textContent = `${catalog.webSearch.provider} · ${catalog.webSearch.configured ? 'provedor configurado' : 'chave do provedor ausente'} · aplicado a ${catalog.webSearch.appliesTo.join(' e ')}`;
    list.innerHTML = catalog.tools.map(tool => {
      const active = activeTools.get(tool.name) !== false;
      const draftDiffers = tool.enabled !== active;
      return `<article class="tool-card"><div class="tool-card-head"><strong>${esc(tool.name)}</strong><input type="checkbox" class="tool-toggle" data-tool="${esc(tool.name)}" aria-label="Ativar ${esc(tool.name)}" ${tool.enabled ? 'checked' : ''} ${state.role === 'admin' ? '' : 'disabled'} /></div><p>${esc(tool.description)}</p><div class="tool-meta">${tool.clientAllowed ? 'Disponível no fluxo de cliente' : 'Apenas fluxos internos'}${draftDiffers ? ` · estado ativo: ${active ? 'ligado' : 'desligado'}` : ''}</div></article>`;
    }).join('');
  } catch (error) { opsFeedback('tools-feedback', `Falha ao carregar catálogo: ${error.message}`, 'error'); }
}

async function renderCampaigns() {
  try {
    const data = await api('/api/dashboard/operations');
    state.operations = data;
    $('#campaign-summary').textContent = `${data.campaigns?.length || 0} campanhas · persistência ${data.configured ? 'Supabase' : 'indisponível'}`;
    $('#campaign-list').innerHTML = (data.campaigns || []).map(campaign => {
      const stats = campaign.recipientStats || {};
      const count = Number(campaign.total_recipients || 0);
      const status = String(campaign.status || '').toLowerCase();
      const actions = [];
      if (state.role === 'admin' && ['pending', 'paused'].includes(status)) actions.push(`<button data-campaign-action="execute" data-campaign-id="${esc(campaign.id)}">Confirmar envio</button>`);
      if (['pending', 'running'].includes(status)) actions.push(`<button data-campaign-action="pause" data-campaign-id="${esc(campaign.id)}">Pausar</button>`);
      if (!['cancelled', 'completed'].includes(status)) actions.push(`<button class="danger" data-campaign-action="cancel" data-campaign-id="${esc(campaign.id)}">Cancelar</button>`);
      return `<article class="ops-row"><div><strong>${esc(campaign.title)}</strong><div class="ops-muted">${esc(status)} · ${count} destinatários · ${Number(stats.sent || 0)} enviados · ${Number(stats.failed || 0)} falhas · ${Number(stats.suppressed || 0)} suprimidos</div><div class="ops-muted">Criada: ${esc(campaign.created_at || '')}</div></div><div class="ops-actions">${actions.join('')}</div></article>`;
    }).join('') || '<div class="detail-placeholder">Nenhuma campanha cadastrada.</div>';
    $('#suppression-list').innerHTML = (data.suppressions || []).map(item => `<article class="ops-row"><div><strong>${esc(item.phone)}</strong><div class="ops-muted">${esc(item.reason)} · ${esc(item.source)} · ${esc(item.suppressedAt || '')}</div></div><div class="ops-actions">${state.role === 'admin' ? `<button class="danger" data-unsuppress="1">Remover</button>` : ''}</div></article>`).join('') || '<div class="detail-placeholder">Nenhuma supressão recente.</div>';
  } catch (error) { opsFeedback('campaigns-feedback', `Falha ao carregar campanhas/supressões: ${error.message}`, 'error'); }
}

async function renderUsers() {
  try {
    const [usersResult, auditResult] = await Promise.all([api('/api/dashboard/users'), api('/api/dashboard/audit')]);
    $('#users-table').innerHTML = usersResult.users.map(user => `<tr><td>${esc(user.fullName || 'Sem nome')}</td><td>${esc(user.email || '—')}</td><td><select class="user-action-select" data-user-role="${esc(user.id)}"><option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>viewer</option><option value="operator" ${user.role === 'operator' ? 'selected' : ''}>operator</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option></select></td><td><input type="checkbox" data-user-active="${esc(user.id)}" ${user.active ? 'checked' : ''} aria-label="Perfil ativo" /></td><td>${esc(user.lastSignInAt || '—')}</td><td><button class="admin-ghost-btn" data-user-save="${esc(user.id)}">Salvar</button></td></tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nenhum perfil encontrado.</td></tr>';
    $('#audit-list').innerHTML = auditResult.entries.map(entry => `<article class="ops-row"><div><strong>${esc(entry.action)}</strong><div class="ops-muted">${esc(entry.entityType || 'sistema')} · ator ${esc(entry.actorId || 'não identificado')} · ${esc(entry.createdAt || '')}</div><div class="ops-muted">${esc(JSON.stringify(entry.metadata || {}))}</div></div></article>`).join('') || '<div class="detail-placeholder">Nenhum evento de auditoria registrado.</div>';
  } catch (error) { opsFeedback('users-feedback', `Falha ao carregar usuários/auditoria: ${error.message}`, 'error'); }
}

async function renderIntegrations() {
  try {
    const data = await api('/api/dashboard/integrations');
    const hours = data.businessHours || {};
    const sectors = data.sectorsProjection || {};
    const hoursDetail = `${hours.summary || 'Expediente indisponível.'}${hours.enabled && !hours.isOpenNow && hours.nextOpenAt ? ` · reabertura ${new Date(hours.nextOpenAt).toLocaleString('pt-BR')}` : ''}`;
    const sectorsDetail = `${Number(sectors.count) || 0} setor(es) na projeção · última leitura ${sectors.updatedAt ? new Date(sectors.updatedAt).toLocaleString('pt-BR') : 'ainda não sincronizada'}`;
    const statuses = [
      ['Ponte Chatwoot Lia', data.chatwootBridge?.status || 'unknown', `Revisão ${data.chatwootBridge?.revision ?? '—'} · última leitura ${data.chatwootBridge?.lastReadAt ? new Date(data.chatwootBridge.lastReadAt).toLocaleString('pt-BR') : 'aguardando primeira leitura'}`],
      ['Expediente da Lia', !hours.enabled ? '24 horas' : (hours.isOpenNow ? 'aberto' : 'fechado'), hoursDetail],
      ['Setores do Chatwoot', sectors.synced ? 'sincronizado' : 'aguardando sincronização', sectorsDetail],
      ['Evolution API', data.evolution.status, `Host ${data.evolution.apiHost || '—'} · instância ${data.evolution.instance || '—'} · latência ${data.evolution.latencyMs ?? '—'} ms`],
      ['Supabase', data.supabase.configured ? 'configurado' : 'não configurado', `Projeto ${data.supabase.urlHost || '—'} · backend-only`],
      ['Autenticação do webhook', data.webhook.authenticated ? 'token configurado' : 'sem token', `Rota ${data.webhook.route} · ledger ${data.webhook.ledgerConfigured ? 'ativo' : 'indisponível'}`],
      ...(data.providers || []).map(item => [item.name, item.state, `${item.configured ? 'configurado' : 'não configurado'} · ${item.failures} falhas · quarentena ${item.quarantineSeconds}s`])
    ];
    $('#integrations-status').innerHTML = statuses.map(([name, status, detail]) => `<article class="integration-card"><div class="integration-card-head"><strong>${esc(name)}</strong><span class="status-text ${/connected|ok|configured|token configured|operacional|aberto|24 horas|sincronizado/i.test(status) ? 'ok' : /not_configured|não configurado|disconnected|unreachable|timeout|awaiting_first_read|stale|unknown|fechado|aguardando/i.test(status) ? 'warn' : 'err'}">${esc(status)}</span></div><p>${esc(detail)}</p>${name === 'Evolution API' ? `<p>${data.evolution.ownerLinked ? 'Instância vinculada a um telefone' : 'Telefone proprietário não vinculado'}</p>` : ''}</article>`).join('');
    const events = data.webhook.recentEvents || [];
    $('#webhook-summary').textContent = `${events.length} eventos recentes · ${data.webhook.ledgerConfigured ? 'ledger persistente' : 'ledger não disponível'}`;
    $('#webhook-events').innerHTML = events.map(event => `<tr><td>${esc(event.receivedAt || '')}</td><td>${esc(event.eventType)}</td><td>${esc(event.instance || '—')}</td><td>${esc(event.status)}</td><td>${Number(event.attempts || 1)}</td><td>${esc(event.errorCode || '—')}</td></tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nenhum evento recente ou ledger não aplicado.</td></tr>';
  } catch (error) { opsFeedback('integrations-feedback', `Falha ao consultar integrações: ${error.message}`, 'error'); }
}

async function loadPricingDraft() {
  if (state.role !== 'admin' || !$('#metrics-pricing-rates') || document.activeElement === $('#metrics-pricing-rates') || document.activeElement === $('#metrics-monthly-budgets')) return;
  try {
    if (!state.adminConfig) state.adminConfig = await api('/api/admin/config');
    $('#metrics-pricing-rates').value = JSON.stringify(state.adminConfig.draft?.ai?.pricingRates || [], null, 2);
    $('#metrics-monthly-budgets').value = JSON.stringify(state.adminConfig.draft?.ai?.monthlyBudgets || [], null, 2);
  } catch (error) { opsFeedback('metrics-rates-feedback', `Configuração não carregada: ${error.message}`, 'error'); }
}

function render() {
  try { renderList(); } catch (e) { console.error('[renderList]', e); }
  try { renderChat(); } catch (e) { console.error('[renderChat]', e); }
  try { renderHandoff(); } catch (e) { console.error('[renderHandoff]', e); }
  if (state.view === 'admin') { try { renderAdmin(); } catch (e) { console.error('[renderAdmin]', e); } }
  if (state.view === 'settings') { try { renderSettings(); } catch (e) { console.error('[renderSettings]', e); } }
  if (state.view === 'agent') { try { renderAgent(); } catch (e) { console.error('[renderAgent]', e); } }
  if (state.view === 'metrics') { try { renderMetrics(); } catch (e) { console.error('[renderMetrics]', e); } }
  if (state.view === 'overview') { try { renderOverview(); } catch (e) { console.error('[renderOverview]', e); } }
  if (state.view === 'tools') { try { renderTools(); } catch (e) { console.error('[renderTools]', e); } }
  if (state.view === 'campaigns') { try { renderCampaigns(); } catch (e) { console.error('[renderCampaigns]', e); } }
  if (state.view === 'users') { try { renderUsers(); } catch (e) { console.error('[renderUsers]', e); } }
  if (state.view === 'integrations') { try { renderIntegrations(); } catch (e) { console.error('[renderIntegrations]', e); } }
  const lastSync = $('#last-sync');
  if (lastSync) lastSync.textContent = `atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function refresh() {
  const data = await api(`/api/dashboard/state?mode=${encodeURIComponent(state.mode)}`);
  state.sessions = data.sessions;
  const subtitle = $('#inbox-subtitle');
  if (subtitle) subtitle.textContent = data.persistence === 'supabase' ? 'dados do Supabase' : data.persistenceError ? 'fallback local — Supabase indisponível' : 'suas sessões recentes';
  if (!state.sessions.some((item) => item.phone === state.selected)) state.selected = state.sessions[0]?.phone || null;
  render();
}

async function setMode(mode) {
  if (!state.selected) return;
  const toggleBtn = $('#toggle-mode');
  const topBtn = $('#transfer-top');
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = mode === 'bot' ? 'Reativando bot...' : 'Transferindo para humano...';
  }
  if (topBtn) topBtn.disabled = true;
  try {
    await api('/api/dashboard/mode', { method: 'POST', body: JSON.stringify({ phone: state.selected, mode }) });
    await refresh();
    adminFeedback(mode === 'bot' ? '🤖 Bot reativado com sucesso!' : '👤 Modo humano ativado para a conversa.', 'success');
  } catch (err) {
    adminFeedback(`Erro ao alternar modo: ${err.message}`, 'error');
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
    if (topBtn) topBtn.disabled = false;
  }
}

async function clearSession() {
  if (!state.selected) return;
  try {
    const real = state.mode === 'real';
    if (real && !window.confirm('Arquivar esta conversa real?')) return;
    await api('/api/dashboard/clear', {
      method: 'POST',
      body: JSON.stringify({
        phone: state.selected,
        mode: state.mode,
        confirm: !real || true,
        reason: real ? 'Arquivamento solicitado no dashboard' : 'Limpeza de simulação'
      })
    });
    await refresh();
  } catch (error) {
    window.alert(error.message || 'Não foi possível concluir a operação.');
  }
}

function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((item) => item.classList.remove('active-view'));
  document.querySelector(`#${view}-view`)?.classList.add('active-view');
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#page-title').textContent =
    view === 'inbox'
      ? 'Conversas'
      : view === 'settings'
      ? 'Configuração'
      : view === 'agent'
      ? 'Seu agente de IA'
      : view === 'metrics'
      ? 'Monitoramento & Consumo'
      : view === 'admin'
      ? 'Administração'
      : view === 'overview'
      ? 'Saúde & Operação'
      : view === 'tools'
      ? 'Ferramentas & Web'
      : view === 'campaigns'
      ? 'Campanhas & Opt-out'
      : view === 'users'
      ? 'Usuários & Auditoria'
      : view === 'integrations'
      ? 'Integrações & Webhooks'
      : 'Transferências';
  if (view === 'settings') renderSettings();
  if (view === 'handoff') renderHandoff();
  if (view === 'agent') renderAgent();
  if (view === 'metrics') renderMetrics();
  if (view === 'admin') renderAdminData();
  if (view === 'overview') renderOverview();
  if (view === 'tools') renderTools();
  if (view === 'campaigns') renderCampaigns();
  if (view === 'users') renderUsers();
  if (view === 'integrations') renderIntegrations();
}

function startDashboard() {
  showView('overview');
  $('#mode-selector').value = state.mode;
  $('#mode-selector').addEventListener('change', () => {
    state.mode = $('#mode-selector').value;
    state.selected = null;
    $('#new-sim').disabled = state.mode === 'real';
    refresh();
  });
  $('#logout').addEventListener('click', () => supabase?.auth.signOut());
  $('#composer')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text || !state.selected) return;
    input.value = '';
    const endpoint = state.mode === 'real' ? '/api/dashboard/send' : '/api/dashboard/simulate';
    try {
      await api(endpoint, { method: 'POST', body: JSON.stringify({ phone: state.selected, text }) });
    } catch (err) {
      window.alert(err.message || 'Falha ao enviar mensagem');
    }
    await refresh();
    if (state.view === 'metrics') renderMetrics();
  });
  $('#search')?.addEventListener('input', renderList);
  const triggerRefreshWithIcon = async (btn) => {
    if (btn) btn.classList.add('spinning');
    try {
      await refresh();
    } finally {
      if (btn) setTimeout(() => btn.classList.remove('spinning'), 600);
    }
  };
  $('#refresh')?.addEventListener('click', () => triggerRefreshWithIcon($('#refresh')));
  $('#refresh-overview')?.addEventListener('click', () => renderOverview());
  $('#tools-refresh')?.addEventListener('click', renderTools);
  $('#tools-save')?.addEventListener('click', async () => {
    try {
      const enabled = Object.fromEntries([...document.querySelectorAll('.tool-toggle')].map(input => [input.dataset.tool, input.checked]));
      const result = await api('/api/dashboard/tools', { method: 'PATCH', body: JSON.stringify({ enabled, webSearchEnabled: $('#tools-web-search').checked }) });
      opsFeedback('tools-feedback', `Rascunho salvo (revisão ${result.revision}). Publicação ainda necessária.`, 'success');
      await renderTools();
    } catch (error) { opsFeedback('tools-feedback', `Não foi possível salvar: ${error.message}`, 'error'); }
  });
  $('#campaigns-refresh')?.addEventListener('click', renderCampaigns);
  $('#campaign-create')?.addEventListener('click', async () => {
    const recipients = $('#campaign-recipients').value.split(/\r?\n/).map(line => {
      const [phone, ...name] = line.split(',');
      return { phone: phone.trim(), name: name.join(',').trim() || 'Cliente' };
    }).filter(item => item.phone);
    try {
      const result = await api('/api/dashboard/campaigns', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ title: $('#campaign-title').value.trim(), message: $('#campaign-message').value.trim(), minDelay: Number($('#campaign-min-delay').value), maxDelay: Number($('#campaign-max-delay').value), recipients }) });
      $('#campaign-title').value = '';
      $('#campaign-message').value = '';
      $('#campaign-recipients').value = '';
      opsFeedback('campaigns-feedback', `Campanha ${result.campaign?.id || ''} criada em rascunho. Nenhuma mensagem foi enviada.`, 'success');
      await renderCampaigns();
    } catch (error) { opsFeedback('campaigns-feedback', `Não foi possível criar campanha: ${error.message}`, 'error'); }
  });
  $('#campaign-list')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-campaign-action]');
    if (!button) return;
    const action = button.dataset.campaignAction;
    const campaign = state.operations?.campaigns?.find(item => item.id === button.dataset.campaignId);
    if (!campaign) return;
    if (action === 'execute' && !window.confirm(`Confirmar envio real da campanha “${campaign.title}” para até ${campaign.total_recipients} destinatários? A ação enviará mensagens via WhatsApp.`)) return;
    if (action === 'cancel' && !window.confirm(`Cancelar a campanha “${campaign.title}”?`)) return;
    button.disabled = true;
    try {
      await api(`/api/dashboard/campaigns/${encodeURIComponent(campaign.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'execute' ? { confirm: true } : {}) });
      opsFeedback('campaigns-feedback', action === 'execute' ? 'Execução solicitada. O worker processa até o limite por execução.' : `Campanha ${action === 'pause' ? 'pausada' : 'cancelada'}.`, 'success');
      await renderCampaigns();
    } catch (error) { opsFeedback('campaigns-feedback', `Operação não concluída: ${error.message}`, 'error'); }
  });
  $('#suppression-add')?.addEventListener('click', async () => {
    try {
      await api('/api/dashboard/suppressions', { method: 'POST', body: JSON.stringify({ phone: $('#suppression-phone').value.trim(), reason: $('#suppression-reason').value }) });
      $('#suppression-phone').value = '';
      opsFeedback('campaigns-feedback', 'Supressão registrada. O envio para esse telefone será bloqueado.', 'success');
      await renderCampaigns();
    } catch (error) { opsFeedback('campaigns-feedback', `Não foi possível registrar opt-out: ${error.message}`, 'error'); }
  });
  $('#suppression-list')?.addEventListener('click', async event => {
    if (!event.target.closest('[data-unsuppress]')) return;
    const phone = window.prompt('Por privacidade, informe o telefone completo que deseja remover da supressão:');
    if (!phone) return;
    if (!window.confirm('Remover o opt-out deste telefone? Isso permitirá novos envios sujeitos às demais regras.')) return;
    try {
      await api('/api/dashboard/suppressions', { method: 'DELETE', body: JSON.stringify({ phone, confirm: true }) });
      opsFeedback('campaigns-feedback', 'Supressão removida após confirmação.', 'success');
      await renderCampaigns();
    } catch (error) { opsFeedback('campaigns-feedback', `Não foi possível remover: ${error.message}`, 'error'); }
  });
  $('#integrations-refresh')?.addEventListener('click', renderIntegrations);
  $('#users-refresh')?.addEventListener('click', renderUsers);
  $('#users-table')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-user-save]');
    if (!button) return;
    const id = button.dataset.userSave;
    const role = $(`[data-user-role="${id}"]`)?.value;
    const active = $(`[data-user-active="${id}"]`)?.checked;
    button.disabled = true;
    try {
      await api(`/api/dashboard/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ role, active }) });
      opsFeedback('users-feedback', 'Perfil atualizado e evento auditado.', 'success');
      await renderUsers();
    } catch (error) { opsFeedback('users-feedback', `Não foi possível atualizar perfil: ${error.message}`, 'error'); }
    finally { button.disabled = false; }
  });
  $('#metrics-rates-save')?.addEventListener('click', async () => {
    try {
      const pricingRates = JSON.parse($('#metrics-pricing-rates').value || '[]');
      const monthlyBudgets = JSON.parse($('#metrics-monthly-budgets').value || '[]');
      if (!Array.isArray(pricingRates) || !Array.isArray(monthlyBudgets)) throw new Error('Tarifas e orçamentos precisam ser listas JSON.');
      const snapshot = state.adminConfig || await api('/api/admin/config');
      snapshot.draft.ai ||= {};
      snapshot.draft.ai.pricingRates = pricingRates;
      snapshot.draft.ai.monthlyBudgets = monthlyBudgets;
      const result = await api('/api/admin/config/draft', { method: 'PATCH', body: JSON.stringify(snapshot.draft) });
      if (!result.ok) throw new Error((result.errors || []).join(' '));
      state.adminConfig = result.snapshot;
      opsFeedback('metrics-rates-feedback', 'Tarifas e limites salvos no rascunho. Publique para que passem a valer.', 'success');
      await renderMetrics();
    } catch (error) { opsFeedback('metrics-rates-feedback', `Não foi possível salvar: ${error.message}`, 'error'); }
  });
  $('#overview-open-simulation')?.addEventListener('click', () => { state.mode = 'simulation'; $('#mode-selector').value = 'simulation'; showView('inbox'); $('#new-sim')?.click(); });
  $('#refresh-handoff')?.addEventListener('click', async () => {
    const btn = $('#refresh-handoff');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('spinning');
    }
    try {
      await refresh();
      renderHandoff();
    } finally {
      if (btn) {
        setTimeout(() => {
          btn.classList.remove('spinning');
          btn.disabled = false;
        }, 500);
      }
    }
  });
  $('#transfer-top')?.addEventListener('click', () => {
    const session = selectedSession();
    if (session) setMode(session.human ? 'bot' : 'human');
  });
  $('#agent-drawer-close')?.addEventListener('click', () => $('#agent-detail-drawer')?.classList.add('hidden'));
  $('#agent-test-action')?.addEventListener('click', () => {
    showView('inbox');
    $('#message-input')?.focus();
  });
  document.querySelectorAll('[data-config]').forEach(input => {
    input.addEventListener('input', () => {
      updateHumanDestinationVisibility();
      queueAdminSave();
    });
    input.addEventListener('change', () => {
      updateHumanDestinationVisibility();
      queueAdminSave();
    });
  });
  document.querySelectorAll('.admin-hours-weekday').forEach(input => {
    input.addEventListener('change', queueAdminSave);
  });
  $('#admin-ai-provider')?.addEventListener('change', () => {
    state.modelCatalogProvider = null;
    state.modelCatalog = [];
    const primary = $('#admin-ai-model');
    if (primary) primary.value = '';
    loadProviderModels({ refresh: true });
  });
  $('#admin-ai-models-refresh')?.addEventListener('click', () => loadProviderModels({ refresh: true }));
  $('#admin-ai-model')?.addEventListener('change', () => {
    renderModelOptions(state.modelCatalog, $('#admin-ai-model'));
    syncFallbackModelInputs();
  });
  $('#admin-ai-change-model')?.addEventListener('click', () => {
    const select = $('#admin-ai-model');
    if (!select) return;
    select.classList.toggle('hidden');
    if (!select.classList.contains('hidden')) {
      loadProviderModels();
      select.focus();
    }
  });
  $('#admin-publish')?.addEventListener('click', async () => {
    const btn = $('#admin-publish');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Publicando...';
    }
    try {
      await saveAdminDraft();
      const result = await api('/api/admin/config/publish', { method: 'POST', body: '{}' });
      if (!result.ok) throw new Error((result.errors || []).join(' '));
      state.adminConfig = result.snapshot;
      renderAdmin();
      adminFeedback(`✓ Versão ${result.snapshot.revision} publicada. O novo contexto já está ativo no WhatsApp.`, 'success');
    } catch (error) {
      adminFeedback(`Erro na publicação: ${error.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Publicar Alterações';
      }
    }
  });
  $('#admin-reset-draft')?.addEventListener('click', async () => {
    if (!state.adminConfig || !window.confirm('Descartar o rascunho e voltar à versão publicada?')) return;
    state.adminConfig.draft = JSON.parse(JSON.stringify(state.adminConfig.active));
    await saveAdminDraft(true);
    adminFeedback('Rascunho restaurado para a versão publicada.', 'success');
  });
  $('#admin-add-faq')?.addEventListener('click', () => {
    if (!state.adminConfig) return;
    adminReadForm();
    state.adminConfig.draft.knowledge.faq.push({ keys: ['nova pergunta'], answer: 'Escreva aqui a resposta aprovada pela equipe.', enabled: true });
    renderAdmin();
    queueAdminSave();
  });
  $('#admin-faq-list')?.addEventListener('input', queueAdminSave);
  $('#admin-faq-list')?.addEventListener('change', queueAdminSave);
  $('#admin-faq-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-faq-remove]');
    if (!button || !state.adminConfig) return;
    adminReadForm();
    state.adminConfig.draft.knowledge.faq.splice(Number(button.dataset.faqRemove), 1);
    renderAdmin();
    queueAdminSave();
  });
  $('#admin-preview-run')?.addEventListener('click', async () => {
    const button = $('#admin-preview-run');
    const resultBox = $('#admin-preview-result');
    try {
      await saveAdminDraft();
      button.disabled = true;
      button.textContent = 'Simulando...';
      resultBox.classList.remove('hidden');
      resultBox.className = 'admin-preview-result loading';
      resultBox.textContent = 'Executando o rascunho em uma sessão isolada com a IA…';
      const result = await api('/api/admin/config/preview', {
        method: 'POST',
        body: JSON.stringify({ phone: $('#admin-preview-phone').value.trim(), text: $('#admin-preview-text').value.trim() })
      });
      resultBox.className = 'admin-preview-result success';
      resultBox.innerHTML = `<div class="preview-result-head"><strong>Resposta simulada da IA</strong><span>versão ${esc(result.revision)}</span></div><p>${esc(result.answer || 'O fluxo não gerou resposta para esta mensagem.')}</p><small>Esta execução foi descartada e não alterou o bot publicado.</small>`;
    } catch (error) {
      resultBox.classList.remove('hidden');
      resultBox.className = 'admin-preview-result error';
      resultBox.textContent = error.message || 'Não foi possível executar o preview.';
    } finally {
      button.disabled = false;
      button.textContent = 'Simular Resposta';
    }
  });

  const openNewSimModal = () => {
    const existing = document.querySelector('.sim-modal-overlay');
    if (existing) existing.remove();
    let defaultPhone = '55869' + Math.floor(10000000 + Math.random() * 90000000);
    const modal = document.createElement('div');
    modal.className = 'sim-modal-overlay';
    modal.innerHTML = `
      <div class="sim-modal-card">
        <h3>Nova Simulação de Atendimento</h3>
        <p>Inicie uma sessão isolada para testar o comportamento da assistente sem enviar mensagens para o WhatsApp real.</p>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:6px;letter-spacing:0.5px;">Telefone de Simulação</label>
        <input id="modal-sim-phone" type="text" value="${defaultPhone}" inputmode="numeric" />
        <div class="sim-modal-actions">
          <button type="button" class="sim-modal-cancel">Cancelar</button>
          <button type="button" class="sim-modal-confirm">Iniciar Teste</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#modal-sim-phone');
    input.focus();
    input.select();

    const closeModal = () => modal.remove();
    modal.querySelector('.sim-modal-cancel').onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    modal.querySelector('.sim-modal-confirm').onclick = async () => {
      const phone = input.value.trim() || defaultPhone;
      closeModal();
      await api('/api/dashboard/simulate', {
        method: 'POST',
        body: JSON.stringify({ phone, text: 'Olá, gostaria de conhecer o atendimento.' })
      });
      state.selected = `sim:${phone.replace(/^sim:/, '')}`;
      await refresh();
      adminFeedback('Nova simulação iniciada com sucesso!', 'success');
    };
  };

  $('#new-sim')?.addEventListener('click', openNewSimModal);

  // Métricas: Ping ao vivo
  const handlePing = async () => {
    const btn = $('#btn-ping-ai') || $('#metrics-ping-btn');
    const banner = $('#ping-result-banner') || $('#metrics-ping-banner');
    if (!btn || !banner) return;
    const selectVal = $('#metrics-model-select')?.value;
    const body = {};
    if (selectVal && selectVal !== 'active') {
      body.provider = 'openrouter';
      body.model = selectVal;
    }
    btn.disabled = true;
    btn.textContent = '⏳ Testando latência...';
    banner.classList.add('hidden');
    try {
      const res = await api('/api/dashboard/ping-ai', { method: 'POST', body: JSON.stringify(body) });
      banner.classList.remove('hidden');
      if (res.ok) {
        banner.className = 'ping-banner success';
        banner.innerHTML = `⚡ <strong>Conexão bem-sucedida!</strong> Provedor: <b>${esc(res.provider)}</b> | Modelo: <b>${esc(
          res.model
        )}</b> | Latência real: <b>${res.latencyMs} ms</b> | Tokens: <b>${res.tokens?.totalTokens || 0}</b>`;
      } else {
        banner.className = 'ping-banner error';
        banner.innerHTML = `⚠ <strong>Falha no teste:</strong> Provedor <b>${esc(res.provider)}</b> (${esc(
          res.model || selectVal || 'modelo padrão'
        )}) retornou erro: ${esc(res.error || 'sem resposta')}`;
      }
      await renderMetrics();
    } catch (e) {
      banner.classList.remove('hidden');
      banner.className = 'ping-banner error';
      banner.innerHTML = `⚠ Erro ao testar conectividade: ${esc(e.message)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Testar Latência (Ping)';
    }
  };

  $('#btn-ping-ai')?.addEventListener('click', handlePing);
  $('#metrics-ping-btn')?.addEventListener('click', handlePing);

  $('#btn-refresh-metrics')?.addEventListener('click', () => renderMetrics());
  $('#btn-reset-metrics')?.addEventListener('click', async () => {
    if (!window.confirm('Deseja zerar as métricas de latência e consumo registradas nesta sessão?')) return;
    await api('/api/dashboard/metrics/reset', { method: 'POST' });
    await renderMetrics();
  });

  $('#metrics-refresh-rate')?.addEventListener('change', (e) => {
    const ms = Number(e.target.value);
    if (state.metricsTimer) {
      clearInterval(state.metricsTimer);
      state.metricsTimer = null;
    }
    if (ms > 0) {
      state.metricsTimer = setInterval(() => {
        if (state.view === 'metrics' && !document.hidden) renderMetrics();
      }, ms);
    }
  });

  // Auto-refresh padrão das métricas a cada 15s quando na aba
  state.metricsTimer = setInterval(() => {
    if (state.view === 'metrics' && !document.hidden) renderMetrics();
  }, 15000);
  state.sessionTimer = setInterval(() => {
    if (!document.hidden) syncSession().catch(() => {});
  }, 30000);

  document.querySelectorAll('.nav-item').forEach((item) =>
    item.addEventListener('click', () => showView(item.dataset.view))
  );

  api('/api/dashboard/session').then(async session => {
    state.role = ROLE_LEVEL[session.role] === undefined ? 'viewer' : session.role;
    applyRoleVisibility();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) {
      try {
        await refresh();
        state.refreshTimer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
      } catch (error) {
        $('#conversation-items').innerHTML = `<div class="detail-placeholder" style="padding:18px">Não foi possível carregar o dashboard.<br>${esc(error.message)}</div>`;
      }
    } else {
      state.sessions = [];
      renderOverview();
    }
  }).catch(error => {
    opsFeedback('overview-health', `Não foi possível verificar permissões: ${error.message}`, 'error');
  });
}

initAuth().catch((error) => {
  showLogin();
  $('#login-error').textContent = error.message || 'Não foi possível carregar o login.';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  } else if (!state.refreshTimer && state.initialized && (ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) {
    refresh().catch(() => {});
    state.refreshTimer = setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 5000);
  }
});

// macOS/iPadOS collapsible sidebar controller
(() => {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  if (!sidebar || !toggleBtn) return;

  const STORAGE_KEY = 'lia_sidebar_collapsed';
  const applyState = (collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  };

  if (window.innerWidth > 768 && localStorage.getItem(STORAGE_KEY) === '1') {
    applyState(true);
  }

  toggleBtn.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('mobile-open');
      return;
    }
    const next = !sidebar.classList.contains('collapsed');
    applyState(next);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  });
})();
