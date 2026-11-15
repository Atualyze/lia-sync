const state = {
  sessions: [],
  sessionCounts: { total: 0, real: 0, simulation: 0, handoff: 0 },
  selected: null,
  lastSelectedPhone: null,
  lastRenderedChatSig: '',
  inboxFilter: 'all',
  chatSearchQuery: '',
  replyTo: null,
  view: 'overview',
  mode: 'real',
  agent: null,
  metrics: null,
  integrations: null,
  health: null,
  refreshTimer: null,
  metricsTimer: null,
  adminConfig: null,
  adminSaveTimer: null,
  adminFormDirty: false,
  adminChangeVersion: 0,
  adminSaveInFlight: false,
  adminSaveQueued: false,
  role: 'viewer',
  userEmail: '',
  userName: '',
  tools: null,
  operations: null,
  modelCatalogProvider: null,
  modelCatalog: [],
  fallbackCatalogs: {},
  overviewSamples: [],
  overviewPollTimer: null,
  soundEnabled: localStorage.getItem('lia_click_sound') !== '0',
  initialized: false
};

const $ = (selector) => document.querySelector(selector);
const esc = (value = '') =>
  String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

// ============================================================================
// NATIVE CLICK SOUND SYNTHESIZER, TOP PROGRESS BAR, SKELETONS & SPINNERS
// ============================================================================
let _audioCtx = null;
function playNativeClick() {
  if (!state.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!_audioCtx) _audioCtx = new AudioCtx();
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(680, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.022);
    gain.gain.setValueAtTime(0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.024);
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.026);
  } catch { /* ignore audio context restrictions */ }
}

function syncSoundToggleBtn() {
  const btn = $('#sound-toggle-btn');
  if (!btn) return;
  btn.classList.toggle('is-muted', !state.soundEnabled);
  btn.title = state.soundEnabled ? 'Som de clique ativo (clique para silenciar)' : 'Som de clique silenciado (clique para ativar)';
}

function toggleClickSound() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem('lia_click_sound', state.soundEnabled ? '1' : '0');
  syncSoundToggleBtn();
  if (state.soundEnabled) playNativeClick();
}

document.addEventListener('pointerdown', (e) => {
  const target = e.target?.closest?.('button, .nav-item, .mob-nav-btn, .segment-btn, .inbox-tab, .conv, .quick-chip, summary, .cmd-item');
  if (target && !target.disabled) playNativeClick();
}, { passive: true });

let _progressDepth = 0;
function setTopProgress(active) {
  const bar = $('#global-top-progress');
  if (!bar) return;
  if (active) {
    _progressDepth++;
    bar.classList.add('active');
  } else {
    _progressDepth = Math.max(0, _progressDepth - 1);
    if (_progressDepth === 0) bar.classList.remove('active');
  }
}

function renderSkeletonCards(count = 3) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-line short"></div>
      <div class="skeleton-line mid"></div>
      <div class="skeleton-line"></div>
    </div>
  `).join('');
}

function setButtonLoading(btn, loading, loadingLabel = '') {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${loadingLabel ? `<span>${esc(loadingLabel)}</span>` : ''}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}

const API_BASE = '';
let supabase;
let accessToken = '';
let captcha = { token: '', reset: null, configured: false };

const ROLE_LABELS = {
  admin: 'Administrador',
  operator: 'Operador',
  viewer: 'Visualizador'
};

// ============================================================================
// APPLE NATIVE NOTIFICATION ENGINE (TOAST CENTER)
// ============================================================================
const TOAST_ICONS = {
  success: `<svg width="16" height="16" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  warn: `<svg width="16" height="16" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`
};

function showToast({ title, message = '', type = 'info', duration = 4200 } = {}) {
  const container = $('#toast-container');
  if (!container) return;
  const normalizedType = type === 'warning' ? 'warn' : (TOAST_ICONS[type] ? type : 'info');
  const defaultTitles = {
    success: 'Operação Concluída',
    error: 'Atenção · Falha Detectada',
    warn: 'Aviso Operacional',
    info: 'Notificação do Sistema'
  };
  const resolvedTitle = title || defaultTitles[normalizedType];
  const cleanMessage = String(message || '').replace(/^[✓⚡⚠🤖👤\s]+/, '').trim();

  const toast = document.createElement('div');
  toast.className = `apple-toast toast-${normalizedType}`;
  toast.innerHTML = `
    <div class="apple-toast-icon">${TOAST_ICONS[normalizedType]}</div>
    <div class="apple-toast-body">
      <div class="apple-toast-title">${esc(resolvedTitle)}</div>
      ${cleanMessage ? `<div class="apple-toast-msg">${esc(cleanMessage)}</div>` : ''}
    </div>
    <button type="button" class="apple-toast-close" aria-label="Fechar notificação">
      <svg class="svg-icon sm" width="13" height="13" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  const dismiss = () => {
    if (toast.classList.contains('toast-leaving')) return;
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 240);
  };

  toast.querySelector('.apple-toast-close')?.addEventListener('click', dismiss);
  container.appendChild(toast);

  // Limit max simultaneous toasts to 4
  const allToasts = container.querySelectorAll('.apple-toast:not(.toast-leaving)');
  if (allToasts.length > 4) {
    allToasts[0].remove();
  }

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// ============================================================================
// APPLE FLOATING CONTEXT MENU & TECHNICAL GLOSSARY ENGINE
// ============================================================================
const TECH_GLOSSARY = {
  PTT: {
    term: 'PTT · Push-to-Talk (Nota de Voz)',
    category: 'Voz & Áudio',
    summary: 'Mensagem de voz gravada na hora no WhatsApp (como um walkie-talkie), exibida com ondas sonoras no celular do cliente em vez de um arquivo de áudio comum.',
    view: 'admin',
    accId: 'acc-voice'
  },
  TTS: {
    term: 'TTS · Text-to-Speech (Síntese de Voz)',
    category: 'Voz & IA',
    summary: 'Tecnologia que converte automaticamente a resposta em texto da Lia em áudio falado natural (vozes Aoede, Kore, Fenrir, etc.).',
    view: 'admin',
    accId: 'acc-voice'
  },
  WAV: {
    term: 'WAV · Formato de Áudio sem Compressão',
    category: 'Voz & Áudio',
    summary: 'Formato de áudio de alta fidelidade gerado pelo motor Gemini TTS (24kHz PCM) antes de ser entregue como nota de voz no WhatsApp.',
    view: 'admin',
    accId: 'acc-voice'
  },
  SLA: {
    term: 'SLA · Service Level Agreement (Acordo de Nível de Serviço)',
    category: 'Operação',
    summary: 'Meta de tempo máximo para responder ao cliente ou assumir um atendimento humano antes que o contato esfrie.',
    view: 'handoff'
  },
  Handoff: {
    term: 'Handoff · Transbordo para Atendimento Humano',
    category: 'Atendimento',
    summary: 'Transferência segura da conversa da IA (Lia) para um atendente humano quando o cliente pede ajuda direta ou o caso exige decisão humana.',
    view: 'handoff'
  },
  Transbordo: {
    term: 'Transbordo · Fila de Atendimento Humano',
    category: 'Atendimento',
    summary: 'Passagem do atendimento automático da Lia para um operador humano, pausando as respostas automáticas da IA naquela conversa.',
    view: 'handoff'
  },
  'Circuit Breaker': {
    term: 'Circuit Breaker · Disjuntor de Proteção de IA',
    category: 'Resiliência',
    summary: 'Mecanismo automático que detecta falhas repetidas em um provedor de IA (ex: Gemini ou OpenRouter), coloca-o em quarentena temporária e redireciona o tráfego para o modelo reserva.',
    view: 'metrics'
  },
  Disjuntor: {
    term: 'Disjuntor · Circuit Breaker de Provedor',
    category: 'Resiliência',
    summary: 'Proteção que isola automaticamente um provedor de IA instável para evitar travamentos e aciona o modelo reserva (Fallback).',
    view: 'metrics'
  },
  Fallback: {
    term: 'Fallback · Modelo Reserva de Contingência',
    category: 'Motor IA',
    summary: 'Modelo de IA secundário acionado automaticamente em milissegundos caso o modelo principal atinja limite de cota, demore ou apresente erro.',
    view: 'admin',
    accId: 'acc-ai'
  },
  'Thinking Budget': {
    term: 'Thinking Budget · Orçamento de Raciocínio Interno',
    category: 'Motor IA',
    summary: 'Quantidade máxima de tokens que o modelo Gemini 2.5/3.8 pode usar para "pensar passo a passo" antes de redigir a resposta final ao cliente.',
    view: 'agent'
  },
  'Tool Calling': {
    term: 'Tool Calling · Chamada Autônoma de Ferramentas',
    category: 'Agente IA',
    summary: 'Capacidade da Lia de executar funções reais do sistema durante a conversa - como consultar agenda no Google Calendar, buscar na web ou transferir para humano.',
    view: 'tools'
  },
  'Super Agente': {
    term: 'Super Agente · Modo Autônomo com Ferramentas',
    category: 'Agente IA',
    summary: 'Modo avançado em que a Lia não apenas conversa, mas também decide e executa ferramentas (agenda, busca web, CRM, diagnósticos) de forma autônoma.',
    view: 'admin',
    accId: 'acc-ai'
  },
  RBAC: {
    term: 'RBAC · Role-Based Access Control (Controle de Acesso por Papel)',
    category: 'Segurança',
    summary: 'Sistema de permissões em três níveis: Viewer (somente leitura), Operator (atende conversas) e Admin (configura motor, prompts e usuários).',
    view: 'users'
  },
  Liveness: {
    term: 'Liveness · Sonda de Vida do Servidor',
    category: 'Infraestrutura',
    summary: 'Verificação instantânea (/health) que confirma se o processo Node.js da Lia está ativo e respondendo na memória.',
    view: 'overview'
  },
  Readiness: {
    term: 'Readiness · Sonda de Prontidão Operacional',
    category: 'Infraestrutura',
    summary: 'Verificação profunda (/ready) que testa se as dependências críticas (Supabase, Evolution API, configuração publicada) estão prontas para atender clientes.',
    view: 'overview'
  },
  P95: {
    term: 'Latência P95 · Percentil 95 de Tempo de Resposta',
    category: 'Telemetria',
    summary: 'Indica que 95% das respostas da IA foram mais rápidas que este valor (em milissegundos), eliminando distorções de picos isolados.',
    view: 'metrics'
  },
  Idempotência: {
    term: 'Idempotência · Proteção contra Duplicidade',
    category: 'Segurança',
    summary: 'Garantia técnica de que, se o WhatsApp ou a rede reenviar o mesmo webhook ou clique duas vezes, a Lia processará e responderá apenas uma única vez.',
    view: 'integrations'
  },
  Ledger: {
    term: 'Ledger · Livro-Razão Imutável de Eventos',
    category: 'Auditoria',
    summary: 'Registro histórico persistido no banco de dados com todas as chamadas de IA, webhooks recebidos, tokens consumidos e status de entrega.',
    view: 'integrations'
  },
  ETag: {
    term: 'ETag · Identificador de Versão para Cache Sincronizado',
    category: 'Integrações',
    summary: 'Assinatura criptográfica da revisão publicada que permite ao Chatwoot saber instantaneamente se a configuração da Lia mudou sem baixar dados repetidos.',
    view: 'integrations'
  },
  'Ponte Chatwoot': {
    term: 'Ponte Chatwoot Lia · Sincronização Bidirecional',
    category: 'Integrações',
    summary: 'Canal autenticado por HMAC que mantém horários comerciais, setores, status de handoff e configurações sincronizados entre o Chatwoot e a Lia.',
    view: 'integrations'
  },
  Tokens: {
    term: 'Tokens · Unidades de Processamento de Texto da IA',
    category: 'Custos & IA',
    summary: 'Fragmentos de palavras processados pelo modelo de IA (1.000 tokens equivalem a cerca de 750 palavras). Dividem-se em Prompt (entrada) e Completion (saída).',
    view: 'metrics'
  },
  RLS: {
    term: 'RLS · Row-Level Security (Segurança em Nível de Linha)',
    category: 'Segurança',
    summary: 'Política nativa do PostgreSQL/Supabase que restringe no próprio banco de dados quais linhas cada usuário autenticado pode ler ou alterar.',
    view: 'users'
  },
  'Evolution API': {
    term: 'Evolution API · Gateway de Conexão WhatsApp',
    category: 'Integrações',
    summary: 'Servidor responsável por manter a sessão do WhatsApp conectada, enviar mensagens/áudios e entregar eventos em tempo real via Webhook para a Lia.',
    view: 'integrations'
  },
  Supabase: {
    term: 'Supabase · Banco de Dados PostgreSQL & Autenticação',
    category: 'Infraestrutura',
    summary: 'Plataforma onde ficam salvos de forma persistente o histórico de conversas, configurações publicadas, perfis de acesso (RBAC), campanhas e telemetria.',
    view: 'integrations'
  },
  OpenRouter: {
    term: 'OpenRouter · Hub Multi-Provedor de Modelos de IA',
    category: 'Motor IA',
    summary: 'Gateway unificado que permite à Lia usar dezenas de modelos alternativos (Llama, Qwen, DeepSeek, Nemotron, Claude) como modelo principal ou reserva.',
    view: 'admin',
    accId: 'acc-ai'
  },
  FAQ: {
    term: 'FAQ · Base de Perguntas Frequentes Prioritárias',
    category: 'Conhecimento',
    summary: 'Respostas oficiais cadastradas pela sua equipe que têm prioridade máxima no prompt da Lia quando o cliente menciona as palavras-chave correspondentes.',
    view: 'admin',
    accId: 'acc-faq'
  },
  CRM: {
    term: 'CRM · Gestão de Relacionamento com o Cliente',
    category: 'Atendimento',
    summary: 'Dados comerciais extraídos automaticamente pela Lia durante a conversa, como interesse do cliente, estágio do funil e observações de atendimento.',
    view: 'inbox'
  }
};

function findTechTermEntry(rawText = '') {
  const clean = String(rawText || '').trim();
  if (!clean) return null;
  if (TECH_GLOSSARY[clean]) return { key: clean, ...TECH_GLOSSARY[clean] };
  const lower = clean.toLowerCase();
  for (const [key, entry] of Object.entries(TECH_GLOSSARY)) {
    if (key.toLowerCase() === lower || entry.term.toLowerCase().includes(lower)) {
      return { key, ...entry };
    }
  }
  return null;
}

function hideTechTooltip() {
  const pop = $('#tech-tooltip-popover');
  if (pop) {
    pop.classList.add('hidden');
    pop.innerHTML = '';
  }
}

function showTechTooltip(targetEl, key) {
  const pop = $('#tech-tooltip-popover');
  const entry = TECH_GLOSSARY[key];
  if (!pop || !entry || !targetEl) return;

  pop.innerHTML = `
    <div class="tech-tooltip-head">
      <strong>${esc(entry.term)}</strong>
      <span class="tech-tooltip-badge">${esc(entry.category)}</span>
    </div>
    <p>${esc(entry.summary)}</p>
    <div class="tech-tooltip-foot">
      <span>Clique ou use o botão direito para ações</span>
      <span>Glossário Lia</span>
    </div>
  `;
  pop.classList.remove('hidden');

  const rect = targetEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  let top = rect.bottom + 10;
  if (top + popRect.height > window.innerHeight - 12) {
    top = Math.max(12, rect.top - popRect.height - 10);
  }
  left = Math.max(12, Math.min(left, window.innerWidth - popRect.width - 12));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openTechTermContextMenu(key, x, y) {
  const entry = TECH_GLOSSARY[key];
  if (!entry) return;
  hideTechTooltip();
  const items = [];
  if (entry.view) {
    items.push({
      label: entry.accId ? 'Abrir ajuste relacionado nas Configurações' : `Ir para painel: ${VIEW_TITLES[entry.view] || entry.view}`,
      icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`,
      action: () => {
        if (entry.accId) openAdminSection(entry.accId);
        else showView(entry.view);
      }
    });
  }
  items.push(
    {
      label: 'Copiar explicação técnica',
      shortcut: '⌘C',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
      action: () => {
        const text = `${entry.term}: ${entry.summary}`;
        navigator.clipboard?.writeText(text);
        showToast({ title: 'Explicação Copiada', message: entry.term, type: 'success' });
      }
    },
    {
      label: 'Ouvir explicação em voz alta (TTS)',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
      action: () => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(`${entry.term}. ${entry.summary}`);
          u.lang = 'pt-BR';
          window.speechSynthesis.speak(u);
          showToast({ title: 'Lendo Definição Técnica', message: entry.term, type: 'info' });
        }
      }
    },
    { divider: true },
    {
      label: 'Ver todos os termos no Glossário (⌘K)',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      action: () => $('#glossary-trigger-btn')?.click()
    }
  );

  openAppleContextMenu({
    x,
    y,
    header: `Termo Técnico · ${entry.category}`,
    explain: {
      title: entry.term,
      text: entry.summary
    },
    items
  });
}

const TECH_KEYS_SORTED = Object.keys(TECH_GLOSSARY).sort((a, b) => b.length - a.length);
const TECH_REGEX = new RegExp(`\\b(${TECH_KEYS_SORTED.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');

function decorateTechnicalTerms(root = document.body) {
  if (!root) return;
  const selectors = [
    '.kpi-label', '.kpi-sub', '.panel-head span', '.panel-head strong',
    '.acc-title-group strong', '.acc-title-group span', '.field-hint',
    '.ops-muted', '.section-tag', '.admin-lead', '.metrics-table th',
    '.integration-card-head strong', '.integration-card p', '.tool-meta'
  ];
  const targets = root.querySelectorAll(selectors.join(','));
  targets.forEach((el) => {
    if (el.dataset.techDecorated === '1' || el.querySelector('.tech-term, input, select, textarea, button')) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement && !node.parentElement.closest('.tech-term, code, pre, script, style')) {
        textNodes.push(node);
      }
    }
    let modified = false;
    textNodes.forEach((textNode) => {
      const val = textNode.nodeValue || '';
      if (!TECH_REGEX.test(val)) return;
      TECH_REGEX.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      while ((match = TECH_REGEX.exec(val)) !== null) {
        const matchedWord = match[1];
        if (!TECH_GLOSSARY[matchedWord]) continue;
        if (match.index > lastIdx) {
          frag.appendChild(document.createTextNode(val.slice(lastIdx, match.index)));
        }
        const span = document.createElement('span');
        span.className = 'tech-term';
        span.dataset.techKey = matchedWord;
        span.tabIndex = 0;
        span.setAttribute('role', 'button');
        span.setAttribute('aria-label', `Explicação técnica para ${matchedWord}`);
        span.textContent = matchedWord;
        frag.appendChild(span);
        lastIdx = match.index + matchedWord.length;
        modified = true;
      }
      if (modified && lastIdx < val.length) {
        frag.appendChild(document.createTextNode(val.slice(lastIdx)));
      }
      if (modified && frag.childNodes.length) {
        textNode.parentNode?.replaceChild(frag, textNode);
      }
    });
    el.dataset.techDecorated = '1';
  });
}

function closeAppleContextMenu() {
  const menu = $('#apple-context-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }
  $('#chat-more-menu')?.classList.remove('active');
}

function openAppleContextMenu({ x, y, header, explain, items = [] }) {
  const menu = $('#apple-context-menu');
  if (!menu || (!items.length && !explain)) return;

  menu.innerHTML = `
    ${header ? `<div class="ctx-menu-header">${esc(header)}</div>` : ''}
    ${explain ? `<div class="ctx-menu-explain"><strong>${esc(explain.title || '')}</strong><p>${esc(explain.text || '')}</p></div>` : ''}
    ${items.map((item, idx) => {
      if (item.divider) return `<div class="ctx-menu-divider"></div>`;
      return `<button type="button" class="ctx-menu-item ${item.danger ? 'danger' : ''}" data-ctx-idx="${idx}">
        ${item.icon || ''}
        <span>${esc(item.label)}</span>
        ${item.shortcut ? `<kbd>${esc(item.shortcut)}</kbd>` : ''}
      </button>`;
    }).join('')}
  `;

  menu.classList.remove('hidden');

  // Position safely inside viewport
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 12;
  const maxY = window.innerHeight - rect.height - 12;
  menu.style.left = `${Math.max(12, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(12, Math.min(y, maxY))}px`;

  menu.querySelectorAll('[data-ctx-idx]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = items[Number(btn.dataset.ctxIdx)];
      closeAppleContextMenu();
      target?.action?.();
    });
  });
}

// Global listeners for .tech-term hover, click, and contextmenu
document.addEventListener('mouseover', (e) => {
  const termEl = e.target.closest('.tech-term[data-tech-key]');
  if (termEl) {
    showTechTooltip(termEl, termEl.dataset.techKey);
  }
});
document.addEventListener('mouseout', (e) => {
  const termEl = e.target.closest('.tech-term[data-tech-key]');
  if (termEl && !termEl.contains(e.relatedTarget)) {
    hideTechTooltip();
  }
});
document.addEventListener('click', (e) => {
  const termEl = e.target.closest('.tech-term[data-tech-key]');
  if (termEl) {
    e.preventDefault();
    e.stopPropagation();
    const rect = termEl.getBoundingClientRect();
    openTechTermContextMenu(termEl.dataset.techKey, rect.left, rect.bottom + 6);
    return;
  }
  if (!e.target.closest('#apple-context-menu') && !e.target.closest('#chat-more-menu') && !e.target.closest('#chat-more-btn') && !e.target.closest('#composer-attach-btn') && !e.target.closest('[data-msg-menu]')) {
    closeAppleContextMenu();
  }
});
document.addEventListener('contextmenu', (e) => {
  const termEl = e.target.closest('.tech-term[data-tech-key]');
  if (termEl) {
    e.preventDefault();
    e.stopPropagation();
    openTechTermContextMenu(termEl.dataset.techKey, e.clientX, e.clientY);
    return;
  }
  const selectedText = window.getSelection?.()?.toString()?.trim();
  if (selectedText && selectedText.length <= 36) {
    const found = findTechTermEntry(selectedText);
    if (found) {
      e.preventDefault();
      openTechTermContextMenu(found.key, e.clientX, e.clientY);
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAppleContextMenu();
    hideTechTooltip();
    if (state.replyTo) clearReplyTo();
  }
});

// ============================================================================
// AUTHENTICATION & CAPTCHA
// ============================================================================
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
  const widgetId = api.render(container, {
    sitekey: authConfig.captchaSiteKey,
    theme: 'dark',
    size: 'normal',
    appearance: 'always',
    action: 'login',
    callback: token => { captcha.token = token; },
    'expired-callback': () => { captcha.token = ''; },
    'error-callback': () => { captcha.token = ''; }
  });
  captcha = { token: '', reset: () => api.reset(widgetId), configured: true };
  captcha.getToken = () => provider === 'turnstile' && typeof api.getResponse === 'function' ? api.getResponse(widgetId) || '' : captcha.token;
}

// SMART LOGIN DEFENSE & MODIFIER DETECTION
const LOGIN_SECURITY = {
  maxAttempts: 5,
  lockoutSeconds: 60,
  storageKey: 'lia_sync_login_sec'
};

function getLoginSecState() {
  try {
    const raw = sessionStorage.getItem(LOGIN_SECURITY.storageKey);
    if (!raw) return { attempts: 0, lockoutUntil: 0 };
    const data = JSON.parse(raw);
    return {
      attempts: Number(data.attempts) || 0,
      lockoutUntil: Number(data.lockoutUntil) || 0
    };
  } catch {
    return { attempts: 0, lockoutUntil: 0 };
  }
}

function saveLoginSecState(st) {
  try {
    sessionStorage.setItem(LOGIN_SECURITY.storageKey, JSON.stringify(st));
  } catch {}
}

let loginLockoutInterval = null;
function checkLoginLockout() {
  const st = getLoginSecState();
  const now = Date.now();
  const alertEl = $('#login-lockout-alert');
  const timerEl = $('#login-lockout-timer');
  const submitBtn = $('#login-submit-btn') || $('#login-form button[type="submit"]');
  const emailInput = $('#login-email');
  const passInput = $('#login-password');

  if (st.lockoutUntil && st.lockoutUntil > now) {
    const remaining = Math.ceil((st.lockoutUntil - now) / 1000);
    if (alertEl) alertEl.classList.remove('hidden');
    if (timerEl) timerEl.textContent = remaining;
    if (submitBtn) submitBtn.disabled = true;
    if (emailInput) emailInput.disabled = true;
    if (passInput) passInput.disabled = true;

    if (!loginLockoutInterval) {
      loginLockoutInterval = setInterval(() => {
        const curSt = getLoginSecState();
        const curNow = Date.now();
        if (curSt.lockoutUntil && curSt.lockoutUntil > curNow) {
          const rem = Math.ceil((curSt.lockoutUntil - curNow) / 1000);
          if (timerEl) timerEl.textContent = rem;
        } else {
          clearInterval(loginLockoutInterval);
          loginLockoutInterval = null;
          curSt.attempts = 0;
          curSt.lockoutUntil = 0;
          saveLoginSecState(curSt);
          if (alertEl) alertEl.classList.add('hidden');
          if (submitBtn) submitBtn.disabled = false;
          if (emailInput) emailInput.disabled = false;
          if (passInput) passInput.disabled = false;
        }
      }, 1000);
    }
    return true;
  } else {
    if (alertEl) alertEl.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
    if (emailInput) emailInput.disabled = false;
    if (passInput) passInput.disabled = false;
    if (loginLockoutInterval) {
      clearInterval(loginLockoutInterval);
      loginLockoutInterval = null;
    }
    return false;
  }
}

function recordFailedLoginAttempt() {
  const st = getLoginSecState();
  st.attempts = (st.attempts || 0) + 1;
  if (st.attempts >= LOGIN_SECURITY.maxAttempts) {
    st.lockoutUntil = Date.now() + (LOGIN_SECURITY.lockoutSeconds * 1000);
  }
  saveLoginSecState(st);
  checkLoginLockout();
}

function resetLoginAttempts() {
  saveLoginSecState({ attempts: 0, lockoutUntil: 0 });
  checkLoginLockout();
}

function setupLoginModifierDetection() {
  const pass = $('#login-password');
  const email = $('#login-email');
  const caps = $('#login-caps-badge');
  const numlock = $('#login-numlock-badge');

  function updateModifiers(e) {
    if (!e || typeof e.getModifierState !== 'function') return;
    const isCaps = e.getModifierState('CapsLock');
    const isNumLock = e.getModifierState('NumLock');

    if (caps) {
      if (isCaps) caps.classList.remove('hidden');
      else caps.classList.add('hidden');
    }

    if (numlock) {
      if (e.code && e.code.startsWith('Numpad') && !isNumLock) {
        numlock.classList.remove('hidden');
      } else if (isNumLock) {
        numlock.classList.add('hidden');
      }
    }
  }

  [pass, email].forEach(inp => {
    if (!inp) return;
    inp.addEventListener('keydown', updateModifiers);
    inp.addEventListener('keyup', updateModifiers);
    inp.addEventListener('blur', () => {
      if (caps) caps.classList.add('hidden');
      if (numlock) numlock.classList.add('hidden');
    });
  });
}

function hydrateSessionUser(session) {
  const user = session?.user;
  if (!user) return;
  state.userEmail = user.email || '';
  state.userName = user.user_metadata?.full_name || user.user_metadata?.name || (user.email ? user.email.split('@')[0] : 'Usuário');
  updateSidebarUserProfile();
}

function updateSidebarUserProfile() {
  const nameEl = $('#sidebar-user-name');
  const roleEl = $('#sidebar-user-role');
  const avatarEl = $('#sidebar-user-avatar');
  const display = state.userName || state.userEmail || 'Usuário Autenticado';
  if (nameEl) nameEl.textContent = display;
  if (roleEl) roleEl.textContent = `${ROLE_LABELS[state.role] || state.role}${state.userEmail ? ` · ${state.userEmail}` : ''}`;
  if (avatarEl) avatarEl.textContent = initials(display);
}

function updateSidebarConnection({ integrations, health, adminConfig } = {}) {
  const integ = integrations || state.integrations;
  const hlth = health || state.health;
  const cfg = adminConfig || state.adminConfig;

  const waDot = $('#sidebar-wa-dot');
  const waPill = $('#sidebar-wa-pill');
  const waMeta = $('#sidebar-wa-meta');
  const hoursPill = $('#sidebar-hours-pill');
  const topbarModel = $('#topbar-model-pill');

  if (integ?.evolution) {
    const ev = integ.evolution;
    const isOk = ev.connected || ev.status === 'connected';
    if (waDot) waDot.className = `status-dot ${isOk ? '' : ev.configured ? 'warn' : 'err'}`;
    if (waPill) {
      waPill.textContent = isOk ? 'Conectado' : ev.status === 'not_configured' ? 'Não config.' : ev.status;
      waPill.className = `pill mini ${isOk ? 'mint' : 'amber'}`;
    }
    if (waMeta) {
      waMeta.textContent = `Instância: ${ev.instance || '-'}${ev.latencyMs != null ? ` · ${ev.latencyMs}ms` : ''}`;
    }
  } else if (hlth?.readiness?.checks) {
    const evCheck = hlth.readiness.checks.find(c => c.name === 'evolution');
    const isOk = evCheck?.status === 'ready' || evCheck?.status === 'ok';
    if (waDot) waDot.className = `status-dot ${isOk ? '' : 'warn'}`;
    if (waPill) {
      waPill.textContent = isOk ? 'Online' : (evCheck?.status || 'verificando');
      waPill.className = `pill mini ${isOk ? 'mint' : 'amber'}`;
    }
    if (waMeta && hlth.system?.instance) {
      waMeta.textContent = `Instância: ${hlth.system.instance} · Evolution API`;
    }
  }

  const hours = integ?.businessHours || cfg?.hoursPreview;
  if (hours && hoursPill) {
    if (!hours.enabled) {
      hoursPill.textContent = '24 horas';
      hoursPill.className = 'pill mini mint';
    } else if (hours.isOpenNow) {
      hoursPill.textContent = 'Expediente aberto';
      hoursPill.className = 'pill mini mint';
    } else {
      hoursPill.textContent = 'Fora de hora';
      hoursPill.className = 'pill mini amber';
    }
  }

  const provider = cfg?.active?.ai?.activeProvider || hlth?.system?.provider || state.metrics?.system?.activeProvider;
  const model = cfg?.active?.ai?.activeModel || hlth?.system?.model || state.metrics?.system?.activeModel;
  if (topbarModel && (provider || model)) {
    topbarModel.textContent = `${provider || 'IA'} · ${model || '-'}`;
    topbarModel.className = 'pill mini mint desktop-only';
  }
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
      hydrateSessionUser(data.session);
      showDashboard();
      return;
    }
    showLogin();
    setupLoginModifierDetection();
    checkLoginLockout();
    if (config.captchaSiteKey) await setupCaptcha(config);
    $('#login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (checkLoginLockout()) return;
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
          recordFailedLoginAttempt();
          const msg = readableAuthError(error);
          $('#login-error').textContent = msg;
          showToast({ title: 'Falha na Autenticação', message: msg, type: 'error' });
          return;
        }
        accessToken = result.session?.access_token || '';
        if (!accessToken) throw new Error('O Supabase não retornou um token de acesso.');
        resetLoginAttempts();
        hydrateSessionUser(result.session);
        showToast({ title: 'Sessão Iniciada', message: `Bem-vindo ao Lia Sync Console, ${state.userName || 'operador'}.`, type: 'success' });
        showDashboard();
      } catch (error) {
        recordFailedLoginAttempt();
        const msg = readableAuthError(error);
        $('#login-error').textContent = msg;
        showToast({ title: 'Erro no Login', message: msg, type: 'error' });
      } finally {
        if (submit && !checkLoginLockout()) submit.disabled = false;
      }
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      accessToken = session?.access_token || '';
      if (session) {
        hydrateSessionUser(session);
        showDashboard();
      } else {
        showLogin();
      }
    });
  } catch (error) {
    showLogin();
    $('#login-error').textContent = readableAuthError(error);
  }
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#dashboard-shell').classList.add('hidden');
  setupLoginModifierDetection();
  checkLoginLockout();
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
  if (data.session) hydrateSessionUser(data.session);
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
    let parsedMsg = detail;
    try {
      const parsed = JSON.parse(detail);
      parsedMsg = parsed.error || parsed.message || detail;
    } catch {}
    throw new Error(parsedMsg);
  }
  return response.json();
}

function initials(name = '') {
  return (
    String(name)
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '??'
  );
}

function selectedSession() {
  return state.sessions.find((item) => item.phone === state.selected);
}

// ============================================================================
// INTELLIGENT MULTIMODAL CHAT & CONVERSATION LIST
// ============================================================================
function detectConversationMediaBadge(preview = '') {
  const text = String(preview || '');
  if (/^\[Áudio|^\[PTT|áudio enviado/i.test(text)) {
    return `<svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>`;
  }
  if (/^\[Foto|^\[Imagem|foto enviada/i.test(text)) {
    return `<svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
  }
  if (/^\[Documento|\.pdf|documento anexado/i.test(text)) {
    return `<svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  return '';
}

function formatWhatsAppMarkdown(rawText = '') {
  let safe = esc(rawText);
  // Code blocks / inline code
  safe = safe.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold *text* or **text**
  safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
  // Italic _text_
  safe = safe.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>');
  return safe;
}

function parseMultimodalMessage(message = {}) {
  const raw = String(message.content || '');
  const explicitType = message.mediaType || '';

  // 1. Audio / PTT detection
  const audioMatch = raw.match(/^\[(?:Áudio|PTT|Audio)(?: transcrito)?\]:\s*["“]?([\s\S]*?)["”]?$/i)
    || raw.match(/^\[Áudio enviado(?:\s*·\s*(.*?))?\]\s*([\s\S]*)$/i);
  if (explicitType === 'audio' || audioMatch) {
    const transcript = audioMatch ? (audioMatch[2] || audioMatch[1] || raw) : raw.replace(/^\[Áudio.*?\]:?\s*/i, '');
    return {
      kind: 'audio',
      transcript: transcript.replace(/^["“]|["”]$/g, '').trim() || 'Mensagem de voz (PTT)',
      duration: '0:08'
    };
  }

  // 2. Image / Vision detection
  const imgMatch = raw.match(/^\[(?:Foto|Imagem)([^\]]*)\]:?\s*([\s\S]*)$/i)
    || raw.match(/^\[(foto enviada[^\]]*)\]\s*([\s\S]*)$/i);
  if (explicitType === 'image' || imgMatch) {
    const label = imgMatch ? (imgMatch[1]?.trim() || 'Imagem analisada via Visão Computacional') : 'Imagem recebida';
    const caption = imgMatch ? (imgMatch[2]?.trim() || raw) : raw;
    return {
      kind: 'image',
      label: label.replace(/^[:\s-]+/, '') || 'Visão Computacional',
      caption: caption || 'Análise visual processada pela Lia.'
    };
  }

  // 3. Document / PDF detection
  const docMatch = raw.match(/^\[Documento\s+([^\]]+?)\s+analisado\]:\s*([\s\S]*)$/i)
    || raw.match(/^\[(?:Documento|PDF|Arquivo)([^\]]*)\]:?\s*([\s\S]*)$/i);
  if (explicitType === 'document' || docMatch) {
    const fileName = message.fileName || (docMatch && docMatch[1]?.trim()) || 'documento_anexo.pdf';
    const summary = docMatch ? (docMatch[2]?.trim() || raw) : raw;
    return {
      kind: 'document',
      fileName,
      summary
    };
  }

  return {
    kind: 'text',
    text: raw
  };
}

function renderWaveformBars(seed = 1) {
  const heights = [28, 52, 75, 42, 90, 64, 38, 82, 95, 50, 34, 72, 88, 60, 44, 78, 92, 55, 36, 68, 80, 48, 62, 35, 70, 54, 40, 30];
  return heights
    .map((h, i) => {
      const mod = ((h + seed * 11 + i * 7) % 70) + 22;
      return `<span style="height:${mod}%"></span>`;
    })
    .join('');
}

let activeAudioInstance = null;

async function playNeuralAudio(text, { voiceName = '', onStart, onEnd, onError } = {}) {
  if (activeAudioInstance) {
    try {
      activeAudioInstance.pause();
      activeAudioInstance.currentTime = 0;
    } catch {}
    activeAudioInstance = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  const clean = String(text || '').replace(/[*_#`~]/g, '').slice(0, 320).trim();
  if (!clean) {
    onError?.(new Error('Texto vazio'));
    return;
  }

  try {
    const res = await api('/api/dashboard/tts', {
      method: 'POST',
      body: { text: clean, voiceName: voiceName || state.adminConfig?.draft?.voice?.voiceName || state.draft?.voice?.voiceName }
    });
    if (res?.ok && res.audioBase64) {
      const src = `data:${res.mimeType || 'audio/wav'};base64,${res.audioBase64}`;
      const audio = new Audio(src);
      activeAudioInstance = audio;
      audio.onplay = () => onStart?.(res);
      audio.onended = () => {
        activeAudioInstance = null;
        onEnd?.();
      };
      audio.onerror = (e) => {
        activeAudioInstance = null;
        onError?.(e);
      };
      await audio.play();
      return res;
    }
    throw new Error(res?.error || 'tts_failed');
  } catch (err) {
    console.warn('[tts] Fallback para síntese de fala local:', err.message);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = 'pt-BR';
      utter.rate = 1.05;
      utter.onstart = () => onStart?.({ engine: 'browser-speech-fallback', isFallback: true, error: err.message });
      utter.onend = () => onEnd?.();
      utter.onerror = () => onEnd?.();
      window.speechSynthesis.speak(utter);
    } else {
      onError?.(err);
      onEnd?.();
    }
  }
}

function playAudioPreview(button, textToSpeak = '') {
  const card = button.closest('.media-audio-card');
  if (!card) return;
  if (card.classList.contains('playing')) {
    if (activeAudioInstance) {
      activeAudioInstance.pause();
      activeAudioInstance = null;
    }
    window.speechSynthesis?.cancel();
    card.classList.remove('playing');
    button.innerHTML = `<svg class="svg-icon sm" width="14" height="14" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>`;
    return;
  }

  document.querySelectorAll('.media-audio-card.playing').forEach((other) => {
    other.classList.remove('playing');
  });

  const finish = () => {
    card.classList.remove('playing');
    button.innerHTML = `<svg class="svg-icon sm" width="14" height="14" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>`;
  };

  playNeuralAudio(textToSpeak || 'Áudio recebido no WhatsApp', {
    onStart: (info) => {
      card.classList.add('playing');
      button.innerHTML = `<svg class="svg-icon sm" width="14" height="14" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>`;
    },
    onEnd: finish,
    onError: finish
  });
}

function setReplyTo(message, index) {
  if (!message) return;
  const sender = message.role === 'user' ? (selectedSession()?.displayName || 'Contato') : 'Lia (Assistente)';
  const content = String(message.content || '').slice(0, 180);
  state.replyTo = { sender, content, index };
  const bar = $('#composer-reply-bar');
  const senderEl = $('#reply-bar-sender') || $('#composer-reply-sender');
  const textEl = $('#reply-bar-text') || $('#composer-reply-text');
  if (bar && senderEl && textEl) {
    senderEl.textContent = `Respondendo a ${sender}`;
    textEl.textContent = content;
    bar.classList.remove('hidden');
  }
  $('#message-input')?.focus();
}

function clearReplyTo() {
  state.replyTo = null;
  $('#composer-reply-bar')?.classList.add('hidden');
}

function exportConversationTranscript(session) {
  if (!session) return;
  const lines = [
    `====================================================`,
    `TRANSCRIÇÃO DE ATENDIMENTO · LIA SYNC CONSOLE`,
    `Contato: ${session.displayName || session.name || 'Contato'} (${session.phoneFormatted || session.phone})`,
    `Modo: ${session.human ? 'Atendimento Humano' : 'Lia Automática'}`,
    `Exportado em: ${new Date().toLocaleString('pt-BR')}`,
    `====================================================`,
    ''
  ];
  for (const msg of session.history || []) {
    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleString('pt-BR') : '';
    const who = msg.role === 'user' ? 'CLIENTE' : 'LIA';
    lines.push(`[${time}] ${who}:`);
    lines.push(`${msg.content || ''}`);
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversa-${String(session.phone || 'sessao').replace(/\D/g, '') || 'simulacao'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast({ title: 'Transcrição Exportada', message: 'O arquivo .txt da conversa foi baixado.', type: 'success' });
}

function renderList() {
  const query = ($('#search')?.value || '').toLowerCase();
  const filterMode = state.inboxFilter || 'all';
  const items = state.sessions.filter((item) => {
    if (filterMode === 'human' && !item.human) return false;
    if (filterMode === 'bot' && item.human) return false;
    return `${item.name || ''} ${item.displayName || ''} ${item.phone || ''} ${item.phoneFormatted || ''} ${item.preview || ''}`.toLowerCase().includes(query);
  });

  const convCountEl = $('#conversation-count');
  if (convCountEl) convCountEl.textContent = state.sessions.length;
  const handoffCountEl = $('#handoff-count');
  if (handoffCountEl) handoffCountEl.textContent = state.sessionCounts?.handoff ?? state.sessions.filter((item) => item.human).length;

  const container = $('#conversation-items');
  if (!container) return;

  if (!items.length) {
    const counts = state.sessionCounts || {};
    const otherReal = state.mode !== 'real' && counts.real > 0;
    const otherSim = state.mode !== 'simulation' && counts.simulation > 0;
    let switchHint = '';
    if (otherReal) {
      switchHint = `<button type="button" class="btn-primary btn-sm" data-switch-mode="real" style="margin-top:10px;">Ver ${counts.real} conversa(s) do WhatsApp Real</button>`;
    } else if (otherSim) {
      switchHint = `<button type="button" class="btn-primary btn-sm" data-switch-mode="simulation" style="margin-top:10px;">Ver ${counts.simulation} sessão(ões) no Simulador</button>`;
    } else if (counts.total > 0 && state.mode !== 'all') {
      switchHint = `<button type="button" class="btn-primary btn-sm" data-switch-mode="all" style="margin-top:10px;">Exibir Todas (${counts.total})</button>`;
    }
    container.innerHTML = `<div class="detail-placeholder" style="padding:28px 18px;text-align:center;">
      <div>Nenhuma conversa encontrada para o filtro atual (<b>${state.mode === 'real' ? 'WhatsApp' : state.mode === 'simulation' ? 'Simulador' : 'Todas'}</b>).</div>
      <div style="margin-top:6px;font-size:11.5px;color:var(--text-tertiary);">Use o botão “+” acima para iniciar uma simulação ou alterne o modo.</div>
      ${switchHint}
    </div>`;
    container.querySelectorAll('[data-switch-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetMode = btn.dataset.switchMode;
        const select = $('#mode-selector');
        if (select) {
          select.value = targetMode;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const titleName = esc(item.displayName || item.name || 'Contato');
      const phoneLabel = esc(item.phoneFormatted || item.phone || '');
      const timeLabel = esc(item.time || '');
      const previewText = esc(item.preview || 'Sem mensagens ainda');
      const isSelected = item.phone === state.selected ? 'selected' : '';
      const statusLabel = item.human ? 'humano' : 'lia ativa';
      const statusClass = item.human ? 'human' : 'bot';
      const mediaIcon = detectConversationMediaBadge(item.preview);
      const originBadge = item.origin === 'simulation' ? '<span class="pill mini pale" style="font-size:9.5px;padding:1px 6px;">SIM</span>' : '';

      return `<div class="conversation ${isSelected}" data-phone="${esc(item.phone)}">
        <div class="contact-avatar">${esc(initials(titleName))}</div>
        <div class="conversation-body">
          <div class="conversation-top"><strong title="${titleName}">${titleName}</strong><time>${timeLabel}</time></div>
          <div class="conversation-phone-tag">${phoneLabel} ${originBadge}</div>
          <p>${mediaIcon}${previewText}</p>
          <span class="mode-mini ${statusClass}">${statusLabel}</span>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.conversation').forEach((el) => {
    el.addEventListener('click', () => {
      state.selected = el.dataset.phone;
      clearReplyTo();
      $('#inbox-grid')?.classList.add('mobile-chat-open');
      render();
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const phone = el.dataset.phone;
      const sess = state.sessions.find((s) => s.phone === phone);
      if (!sess) return;
      state.selected = phone;
      render();
      openAppleContextMenu({
        x: e.clientX,
        y: e.clientY,
        header: sess.displayName || sess.phoneFormatted || sess.phone,
        items: [
          {
            label: sess.human ? 'Reativar Lia (Automático)' : 'Assumir Atendimento Humano',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/></svg>`,
            action: () => setMode(sess.human ? 'bot' : 'human')
          },
          {
            label: 'Copiar Telefone / ID',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
            action: () => {
              navigator.clipboard?.writeText(sess.phoneFormatted || sess.phone);
              showToast({ title: 'Telefone Copiado', message: sess.phoneFormatted || sess.phone, type: 'success' });
            }
          },
          {
            label: 'Exportar Transcrição (.txt)',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
            action: () => exportConversationTranscript(sess)
          },
          { divider: true },
          {
            label: sess.origin === 'simulation' ? 'Limpar Sessão de Teste' : 'Arquivar Conversa',
            danger: true,
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
            action: () => clearSession()
          }
        ]
      });
    });
  });
}

function updateChatScrollButton() {
  const messagesEl = $('#messages');
  const btn = $('#chat-scroll-bottom');
  if (!messagesEl || !btn) return;
  const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  btn.classList.toggle('hidden', distanceFromBottom < 120);
}

function renderChat({ forceRender = false } = {}) {
  const session = selectedSession();
  if (!session) {
    state.lastSelectedPhone = null;
    state.lastRenderedChatSig = '';
    $('#chat-empty')?.classList.remove('hidden');
    $('#chat-active')?.classList.add('hidden');
    if ($('#detail-content')) $('#detail-content').innerHTML = '<div class="detail-placeholder">Nenhuma conversa selecionada.</div>';
    return;
  }
  $('#chat-empty')?.classList.add('hidden');
  $('#chat-active')?.classList.remove('hidden');
  const dName = session.displayName || session.name || 'Contato';
  const cleanNum = String(session.phone || '').replace(/\D/g, '');
  const fPhone = session.phoneFormatted || session.phone || '';

  $('#chat-avatar').textContent = initials(dName);
  $('#chat-name').textContent = dName;
  const originTag = $('#chat-origin-tag');
  if (originTag) {
    originTag.textContent = session.origin === 'simulation' ? 'Simulador' : 'WhatsApp';
    originTag.className = `pill mini ${session.origin === 'simulation' ? 'amber' : 'mint'}`;
  }
  const phoneLink = $('#chat-phone-link');
  if (phoneLink) phoneLink.href = cleanNum ? `https://wa.me/${cleanNum}` : '#';
  $('#chat-phone').textContent = fPhone;
  const badge = $('#chat-mode');
  badge.textContent = session.human ? 'HUMANO' : 'LIA ATIVA';
  badge.className = `mode-badge ${session.human ? 'human' : 'bot'}`;

  const rawHistory = session.history || [];
  const searchQ = (state.chatSearchQuery || '').trim().toLowerCase();
  const filteredHistory = rawHistory
    .map((m, idx) => ({ ...m, _idx: idx }))
    .filter((m) => !searchQ || String(m.content || '').toLowerCase().includes(searchQ));

  const searchCountEl = $('#chat-search-count');
  if (searchCountEl) {
    searchCountEl.textContent = searchQ ? `${filteredHistory.length}/${rawHistory.length}` : '';
  }

  const lastMsg = rawHistory[rawHistory.length - 1];
  const lastMsgStamp = lastMsg ? `${lastMsg.createdAt || ''}:${String(lastMsg.content || '').length}` : '0';
  const chatSig = `${session.phone}::${rawHistory.length}::${lastMsgStamp}::${searchQ}::${session.human}`;
  const switchedSession = state.lastSelectedPhone !== session.phone;
  state.lastSelectedPhone = session.phone;

  const messagesEl = $('#messages');
  if (messagesEl && (forceRender || switchedSession || state.lastRenderedChatSig !== chatSig)) {
    const prevScrollTop = messagesEl.scrollTop;
    const prevDistanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const shouldStickToBottom = switchedSession || prevDistanceFromBottom < 140;
    state.lastRenderedChatSig = chatSig;

    messagesEl.innerHTML = filteredHistory.length
      ? filteredHistory
          .map((message) => {
            const idx = message._idx;
            const isUser = message.role === 'user';
            const time = message.createdAt
              ? new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
              : '';
            const parsed = parseMultimodalMessage(message);

            // Quoted Reply block
            let quoteHtml = '';
            if (message.replyTo && (message.replyTo.content || message.replyTo.text)) {
              const qSender = esc(message.replyTo.sender || 'Mensagem anterior');
              const qText = esc(String(message.replyTo.content || message.replyTo.text).slice(0, 140));
              const qIdx = message.replyTo.index ?? '';
              quoteHtml = `<div class="bubble-quote" data-scroll-msg="${esc(qIdx)}">
                <strong>${qSender}</strong>
                <span>${qText}</span>
              </div>`;
            }

            // Content block by media type
            let bodyHtml = '';
            if (parsed.kind === 'audio') {
              bodyHtml = `
                <div class="media-card media-audio-card">
                  <div class="media-audio-row">
                    <button type="button" class="audio-play-btn" data-play-audio="${esc(parsed.transcript)}" title="Ouvir prévia de voz">
                      <svg class="svg-icon sm" width="14" height="14" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
                    </button>
                    <div class="audio-waveform">${renderWaveformBars(idx + 1)}</div>
                    <span class="audio-duration">${esc(parsed.duration)}</span>
                  </div>
                  <div class="audio-transcript">
                    <strong>Transcrição de Voz · IA</strong>
                    <div>${formatWhatsAppMarkdown(parsed.transcript)}</div>
                  </div>
                </div>
              `;
            } else if (parsed.kind === 'image') {
              bodyHtml = `
                <div class="media-card">
                  <div class="media-image-preview">
                    <svg class="svg-icon lg" width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                    <span>${esc(parsed.label)}</span>
                  </div>
                  <div class="bubble-body">${formatWhatsAppMarkdown(parsed.caption)}</div>
                </div>
              `;
            } else if (parsed.kind === 'document') {
              bodyHtml = `
                <div class="media-card">
                  <div class="media-doc-row">
                    <div class="media-doc-icon">
                      <svg class="svg-icon" width="16" height="16" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div class="media-doc-info">
                      <strong>${esc(parsed.fileName)}</strong>
                      <span>Documento Processado · Memória Ativa</span>
                    </div>
                  </div>
                  <div class="bubble-body" style="margin-top:8px;">${formatWhatsAppMarkdown(parsed.summary)}</div>
                </div>
              `;
            } else {
              const rawText = String(parsed.text || '');
              bodyHtml = `<div class="bubble-body">${formatWhatsAppMarkdown(rawText)}</div>`;
            }

            const readCheck = !isUser
              ? `<svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>`
              : '';

            return `<div class="bubble ${isUser ? 'in' : 'out'}" data-msg-index="${idx}">
              <div class="bubble-actions">
                <button type="button" class="bubble-act-btn" data-msg-reply="${idx}" title="Responder mensagem">
                  <svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                </button>
                <button type="button" class="bubble-act-btn" data-msg-copy="${idx}" title="Copiar texto">
                  <svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button type="button" class="bubble-act-btn" data-msg-menu="${idx}" title="Mais opções">
                  <svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></svg>
                </button>
              </div>
              ${quoteHtml}
              ${bodyHtml}
              <small>${isUser ? esc(dName.split(' ')[0].toLowerCase()) : 'lia'}${time ? ` · ${time}` : ''} ${readCheck}</small>
            </div>`;
          })
          .join('')
      : `<div class="detail-placeholder" style="margin:auto">${searchQ ? 'Nenhuma mensagem corresponde à busca neste chat.' : 'Envie uma mensagem ou use os atalhos inteligentes abaixo para iniciar.'}</div>`;

    if (shouldStickToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      messagesEl.scrollTop = prevScrollTop;
    }
    updateChatScrollButton();

    // Bind audio play buttons
    messagesEl.querySelectorAll('[data-play-audio]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioPreview(btn, btn.dataset.playAudio);
      });
    });

    // Bind scroll to quoted message
    messagesEl.querySelectorAll('[data-scroll-msg]').forEach((quoteEl) => {
      quoteEl.addEventListener('click', () => {
        const targetIdx = quoteEl.dataset.scrollMsg;
        if (targetIdx === '' || targetIdx == null) return;
        const targetBubble = messagesEl.querySelector(`.bubble[data-msg-index="${targetIdx}"]`);
        if (targetBubble) {
          targetBubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetBubble.style.boxShadow = '0 0 0 2px var(--accent-blue)';
          setTimeout(() => { targetBubble.style.boxShadow = ''; }, 1600);
        }
      });
    });

    // Bind bubble hover actions & context menu
    const openBubbleMenu = (idx, x, y) => {
      const msg = rawHistory[idx];
      if (!msg) return;
      openAppleContextMenu({
        x,
        y,
        header: msg.role === 'user' ? 'Mensagem do Contato' : 'Resposta da Lia',
        items: [
          {
            label: 'Responder com Citação',
            shortcut: 'R',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
            action: () => setReplyTo(msg, idx)
          },
          {
            label: 'Copiar Texto da Mensagem',
            shortcut: '⌘C',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
            action: () => {
              navigator.clipboard?.writeText(msg.content || '');
              showToast({ title: 'Mensagem Copiada', message: String(msg.content || '').slice(0, 80), type: 'success' });
            }
          },
          {
            label: 'Ouvir em Voz Alta (Voz Neural)',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
            action: () => {
              showToast({ title: 'Sintetizando Áudio', message: 'Gerando voz neural no servidor...', type: 'info' });
              playNeuralAudio(msg.content, {
                onStart: (info) => {
                  showToast({ title: 'Reproduzindo Voz Neural', message: `Motor: ${info?.engine || 'neural'}`, type: 'success' });
                },
                onError: (err) => {
                  showToast({ title: 'Falha na Síntese', message: err?.message || 'Erro ao sintetizar áudio', type: 'error' });
                }
              });
            }
          },
          { divider: true },
          {
            label: 'Testar Frase no Roteador IA',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
            action: () => {
              const routerInput = $('#router-test-input');
              if (routerInput) routerInput.value = String(msg.content || '').slice(0, 220);
              showView('agent');
              setTimeout(() => runRouterTest(), 120);
            }
          },
          {
            label: 'Reutilizar Texto no Campo de Envio',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
            action: () => {
              const input = $('#message-input');
              if (input) {
                input.value = String(msg.content || '');
                input.focus();
              }
            }
          }
        ]
      });
    };

    messagesEl.querySelectorAll('[data-msg-reply]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.msgReply);
        setReplyTo(rawHistory[idx], idx);
      });
    });

    messagesEl.querySelectorAll('[data-msg-copy]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.msgCopy);
        const text = rawHistory[idx]?.content || '';
        navigator.clipboard?.writeText(text);
        showToast({ title: 'Texto Copiado', message: text.slice(0, 75), type: 'success' });
      });
    });

    messagesEl.querySelectorAll('[data-msg-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.msgMenu);
        const rect = btn.getBoundingClientRect();
        openBubbleMenu(idx, rect.left, rect.bottom + 6);
      });
    });

    messagesEl.querySelectorAll('.bubble[data-msg-index]').forEach((bubble) => {
      bubble.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const idx = Number(bubble.dataset.msgIndex);
        openBubbleMenu(idx, e.clientX, e.clientY);
      });
    });
  }

  const isRealSession = session.origin !== 'simulation' && state.mode === 'real';
  $('#message-input').disabled = false;
  const submitBtn = $('#composer button[type="submit"]');
  if (submitBtn) submitBtn.disabled = false;
  $('#message-input').placeholder = isRealSession
    ? (session.human ? 'Responder cliente via WhatsApp (modo humano ativo)…' : 'Responder cliente via WhatsApp (assume atendimento)…')
    : 'Digite uma mensagem de teste ou use os chips acima…';

  const doc = session.lastAnalyzedDocument;
  const docHtml = doc
    ? `<div class="detail-block"><h3>Documento na Memória</h3><div class="detail-row"><span>Arquivo</span><b>${esc(doc.fileName || doc.mediaType || 'Anexo')}</b></div><p class="ops-muted" style="margin:4px 0 0;">${esc(String(doc.analysis || '').slice(0, 220))}${String(doc.analysis || '').length > 220 ? '…' : ''}</p></div>`
    : '';
  const crmHtml = (session.productInterest || session.dealStage || session.contactNotes || session.crmNotes)
    ? `<div class="detail-block"><h3>Dados CRM Extraídos</h3>
        ${session.dealStage ? `<div class="detail-row"><span>Estágio</span><b>${esc(session.dealStage)}</b></div>` : ''}
        ${session.productInterest ? `<div class="detail-row"><span>Interesse</span><b>${esc(session.productInterest)}</b></div>` : ''}
        ${(session.contactNotes || session.crmNotes) ? `<p class="ops-muted" style="margin:6px 0 0;">${esc(session.contactNotes || session.crmNotes)}</p>` : ''}
      </div>`
    : '';

  $('#detail-content').innerHTML = `
    <div class="detail-block">
      <h3>Identificação</h3>
      <div class="detail-profile">
        <div class="contact-avatar">${esc(initials(dName))}</div>
        <div>
          <strong>${esc(dName)}</strong>
          <span style="display:block;font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);">${esc(fPhone)}</span>
          ${cleanNum ? `<a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent-blue-hover);text-decoration:none;display:inline-block;margin-top:4px;">Abrir no WhatsApp ↗</a>` : ''}
        </div>
      </div>
    </div>
    <div class="detail-block">
      <h3>Estado da Sessão</h3>
      <div class="detail-row"><span>Modo atual</span><b>${session.human ? 'Atendimento Humano' : 'Lia (Automático)'}</b></div>
      <div class="detail-row"><span>Origem</span><b>${session.origin === 'simulation' ? 'Simulador Isolado' : 'WhatsApp Real'}</b></div>
      <div class="detail-row"><span>Última atividade</span><b>${esc(session.time || 'agora')}</b></div>
      <div class="detail-row"><span>Mensagens</span><b>${rawHistory.length}</b></div>
      ${session.handoffReason ? `<div class="detail-row"><span>Motivo Handoff</span><b>${esc(session.handoffReason)}</b></div>` : ''}
    </div>
    ${crmHtml}
    ${docHtml}
    <button class="detail-action primary" id="toggle-mode">${session.human ? 'Reativar Lia (Bot)' : 'Transferir para Humano'}</button>
    <button class="detail-action" id="clear-session">${session.origin === 'simulation' ? 'Limpar Sessão de Teste' : 'Arquivar Conversa'}</button>
  `;
  $('#toggle-mode')?.addEventListener('click', () => setMode(session.human ? 'bot' : 'human'));
  $('#clear-session')?.addEventListener('click', clearSession);
  decorateTechnicalTerms($('#detail-content'));
}

// ============================================================================
// AGENT ARCHITECTURE & ROUTER
// ============================================================================
function agentTopic(topic) {
  for (const group of ['knowledge', 'capabilities', 'controls']) if (state.agent?.[group]?.[topic]) return state.agent[group][topic];
  return null;
}

function formatAgentValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `<ul style="margin:4px 0;padding-left:18px;">${value.map((item) => `<li>${formatAgentValue(item)}</li>`).join('')}</ul>`;
  if (typeof value === 'object') return `<dl style="margin:4px 0;">${Object.entries(value).map(([key, item]) => `<dt style="font-weight:600;color:var(--text-secondary);">${esc(key)}</dt><dd style="margin:0 0 6px 12px;">${formatAgentValue(item)}</dd>`).join('')}</dl>`;
  return `<span>${esc(value)}</span>`;
}

function renderAgentDrawer(topic) {
  const item = agentTopic(topic);
  if (!item) return;
  $('#agent-drawer-title').textContent = item.title || 'Detalhes do módulo';
  $('#agent-drawer-subtitle').textContent = item.description || 'Informações ativas no runtime';
  const details = Object.entries(item).filter(([key]) => !['title', 'description'].includes(key));
  $('#agent-drawer-content').innerHTML = details.length
    ? details.map(([key, value]) => `<section class="detail-block"><strong>${esc(key)}</strong>${formatAgentValue(value)}</section>`).join('')
    : '<p>Este módulo está ativo conforme a configuração publicada da Lia.</p>';
  $('#agent-detail-drawer')?.classList.remove('hidden');
  $('#agent-detail-drawer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderAgent({ force = false } = {}) {
  try {
    if (!state.agent || force) {
      state.agent = await api('/api/dashboard/agent-structure');
    }
    const data = state.agent || {};
    const rt = data.runtime || {};
    const voice = data.voice || {};
    const cal = data.googleCalendar || {};
    const toolsList = data.toolsSummary || [];
    const activeToolsCount = toolsList.filter(t => t.enabled).length;

    const strip = $('#agent-runtime-strip');
    if (strip) {
      strip.innerHTML = `
        <article class="kpi-tile panel">
          <span class="kpi-label">Modelo Principal Ativo</span>
          <strong class="kpi-val">${esc(rt.activeModel || '-')}</strong>
          <small class="kpi-sub">Provedor: ${esc((rt.activeProvider || 'gemini').toUpperCase())} · rev v${Number(rt.revision || 0)}</small>
        </article>
        <article class="kpi-tile panel">
          <span class="kpi-label">Modo & Roteamento</span>
          <strong class="kpi-val">${rt.agentMode === 'super_agente' ? 'Super Agente' : 'Assistente'}</strong>
          <small class="kpi-sub">${rt.autoRouting ? 'Roteador por capacidades ativo' : 'Modelo fixo'} · ${rt.contextTurns || 24} turnos</small>
        </article>
        <article class="kpi-tile panel">
          <span class="kpi-label">Ferramentas & Voz</span>
          <strong class="kpi-val">${activeToolsCount}/${toolsList.length} ativas</strong>
          <small class="kpi-sub">Voz: ${esc(voice.voiceName || 'Aoede')} (${voice.autoVoiceOnAudio !== false ? 'PTT auto' : 'manual'})</small>
        </article>
        <article class="kpi-tile panel">
          <span class="kpi-label">Agenda & Conhecimento</span>
          <strong class="kpi-val">${cal.enabled !== false ? 'Calendar Ativo' : 'Calendar Off'}</strong>
          <small class="kpi-sub">${Number(data.faqCount || 0)} respostas FAQ ativas · Slots ${cal.slotDurationMinutes || 30}m</small>
        </article>
      `;
    }

    const capTbody = $('#agent-capabilities-tbody');
    if (capTbody && data.modelCapabilities) {
      const entries = Object.entries(data.modelCapabilities);
      capTbody.innerHTML = entries.map(([modelId, meta]) => {
        const isPrimary = modelId === rt.activeModel;
        const isFallback = Array.isArray(rt.fallbackModels) && rt.fallbackModels.some(f => f.includes(modelId));
        const roleBadge = isPrimary
          ? '<span class="pill mini mint">Principal Publicado</span>'
          : isFallback
          ? '<span class="pill mini amber">Reserva / Fallback</span>'
          : '<span class="pill mini pale">Roteável sob demanda</span>';
        const caps = (meta.capabilities || []).map(c => `<span class="cap-chip">${esc(c)}</span>`).join('');
        return `<tr>
          <td><strong>${esc(modelId)}</strong></td>
          <td>${esc((meta.provider || 'gemini').toUpperCase())}</td>
          <td>${caps}</td>
          <td><code>${Number(meta.thinkingBudget || 0)} tokens</code></td>
          <td>${roleBadge}</td>
        </tr>`;
      }).join('');
    }

    const modContainer = $('#agent-modules-container');
    if (modContainer) {
      const groups = [
        ['capabilities', 'Capacidades Cognitivas & Execução'],
        ['knowledge', 'Conhecimento & Regras de Negócio'],
        ['controls', 'Controles Operacionais & Segurança']
      ];
      modContainer.innerHTML = groups.map(([groupKey, groupTitle]) => {
        const items = Object.entries(data[groupKey] || {});
        if (!items.length) return '';
        return `<section class="panel ops-section">
          <div class="panel-head"><div><strong>${esc(groupTitle)}</strong><span>Clique em um módulo para inspecionar parâmetros reais</span></div></div>
          <div class="ops-list">
            ${items.map(([topicKey, item]) => `
              <div class="ops-row agent-card-item" data-topic="${esc(topicKey)}" style="cursor:pointer;">
                <div>
                  <strong>${esc(item.title || topicKey)}</strong>
                  <div class="ops-muted">${esc(item.description || '')}</div>
                </div>
                <span class="pill mini pale">Inspecionar →</span>
              </div>
            `).join('')}
          </div>
        </section>`;
      }).join('');
      modContainer.querySelectorAll('.agent-card-item[data-topic]').forEach((card) => {
        card.onclick = () => renderAgentDrawer(card.dataset.topic);
      });
    }

    await runRouterTest();
  } catch (error) {
    const out = $('#router-test-output');
    if (out) out.textContent = `Não foi possível carregar a arquitetura do agente: ${error.message}`;
  }
}

async function runRouterTest() {
  const input = $('#router-test-input');
  const out = $('#router-test-output');
  if (!input || !out) return;
  const text = input.value.trim();
  if (!text) {
    out.textContent = 'Digite uma frase acima para simular a decisão do roteador.';
    return;
  }
  const hasDoc = Boolean($('#router-test-doc')?.checked);
  const isOwner = Boolean($('#router-test-owner')?.checked);
  try {
    const res = await api(`/api/dashboard/agent-structure?testText=${encodeURIComponent(text)}&hasDocument=${hasDoc}&actor=${isOwner ? 'owner' : 'client'}`);
    const preview = res.routePreview;
    if (!preview) return;
    const d = preview.decision || {};
    const caps = (preview.requiredCapabilities || []).map(c => `<span class="cap-chip">${esc(c)}</span>`).join('');
    out.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
        <div><strong>Modelo Escolhido:</strong> <code style="color:var(--accent-blue-hover);font-weight:700;">${esc(d.model)}</code> <span class="pill mini mint">${esc(d.tier || 'flash')}</span></div>
        <div><strong>Thinking Budget:</strong> <code>${Number(d.thinkingBudget || 0)}</code> · <strong>Motivo:</strong> <code>${esc(d.reason || '-')}</code></div>
      </div>
      <div><strong>Capacidades Exigidas Detectadas:</strong> ${caps || 'nenhuma'}</div>
    `;
  } catch (err) {
    out.textContent = `Falha ao simular rota: ${err.message}`;
  }
}

// ============================================================================
// TELEMETRY & METRICS
// ============================================================================
async function renderMetrics() {
  try {
    const data = await api('/api/dashboard/metrics');
    state.metrics = data;
    updateSidebarConnection();
    const { overview, circuitBreakers, recentCalls, recentErrors, system, estimatedCost, byProviderModel, source, scope, truncated } = data || {};

    // 1. Latência
    const avg = overview?.avgLatencyMs || 0;
    const elAvg = $('#metric-avg-latency') || $('#kpi-latency');
    if (elAvg) elAvg.textContent = avg;
    const elLast = $('#metric-last-latency');
    if (elLast) elLast.textContent = overview?.lastLatencyMs ? `${overview.lastLatencyMs} ms` : '-';
    const elP95 = $('#metric-p95-latency');
    if (elP95) elP95.textContent = overview?.p95LatencyMs ? `${overview.p95LatencyMs} ms` : '-';
    const latBadge = $('#metric-latency-badge') || $('#kpi-latency-status');
    if (latBadge) {
      if (avg === 0) {
        latBadge.textContent = 'Sem dados';
        latBadge.className = 'pill mini pale';
      } else if (avg < 1200) {
        latBadge.textContent = 'Rápido';
        latBadge.className = 'pill mini mint';
      } else if (avg < 3000) {
        latBadge.textContent = 'Normal';
        latBadge.className = 'pill mini mint';
      } else {
        latBadge.textContent = 'Alto';
        latBadge.className = 'pill mini err';
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
      const budget = item.budgetUsd === null ? '-' : `US$ ${Number(item.budgetUsd).toFixed(2)} · ${item.budgetUsagePercent === null ? (item.monthlyTokenUsageComplete ? 'sem tarifa' : 'uso incompleto') : `${item.budgetUsagePercent}%`}`;
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
        rateBadge.className = 'pill mini err';
      } else {
        rateBadge.textContent = '100% estável';
        rateBadge.className = 'pill mini mint';
      }
    }

    // 4. Provedor Ativo
    const elProv = $('#metric-active-provider') || $('#kpi-provider');
    if (elProv) elProv.textContent = (system?.activeProvider || 'Gemini').toUpperCase();
    const elModel = $('#metric-active-model') || $('#kpi-model');
    if (elModel) elModel.textContent = system?.activeModel || '-';
    renderActiveModelLabel();

    // 5. Badge no menu lateral
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
              ? '<span class="pill mini mint">ok</span>'
              : '<span class="pill mini err">falha</span>';
            return `<tr>
            <td><time class="ops-muted">${time}</time></td>
            <td><strong>${esc(item.provider)}</strong><div class="ops-muted">${esc(item.model || '')}</div></td>
            <td><span class="cap-chip">${esc(item.intent || 'outro')}</span></td>
            <td>
              <div class="latency-bar-container">
                <div class="latency-bar ${speedClass}" style="width:${barWidth}px"></div>
                <span>${item.latencyMs} ms</span>
              </div>
            </td>
            <td>${item.tokenUsageKnown === false ? '<span class="ops-muted">tokens desconhecidos</span>' : `<span class="ops-muted">↓${item.promptTokens || 0} ↑${item.completionTokens || 0}</span> <b>(${item.totalTokens || 0})</b>`}</td>
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
          else if (info.status === 'aberto') statusBadge = `<span class="pill mini err">aberto (${info.quarantineSeconds}s)</span>`;
          else if (info.status === 'degradado') statusBadge = `<span class="pill mini amber">degradado (${info.failures} err)</span>`;

          return `<div class="provider-status-card">
          <div>
            <strong>${esc(prov.toUpperCase())} ${isCurrent ? '<span class="pill mini mint" style="font-size:9px">ativo</span>' : ''}</strong>
            <span>${info.configured ? `Disjuntor: ${info.status} · Falhas: ${info.failures}` : 'Chave não configurada no servidor'}</span>
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
        errorsList.innerHTML = '<div class="detail-placeholder" style="padding:12px 0;color:var(--text-secondary);">Nenhum incidente recente registrado.</div>';
      } else {
        errorsList.innerHTML = recentErrors
          .map((err) => {
            const time = new Date(err.timestamp).toLocaleTimeString('pt-BR');
            return `<div class="error-item">
            <div>
              <strong>${esc(err.provider?.toUpperCase() || 'ERRO')}</strong>
              <div class="ops-muted">${esc(err.message || 'Falha de comunicação')}</div>
            </div>
            <time class="ops-muted">${time}</time>
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
    container.innerHTML = '<div class="empty-state panel"><p>Nenhum transbordo pendente. A Lia está atendendo normalmente.</p></div>';
    return;
  }

  container.innerHTML = list
    .map((item) => {
      const dName = esc(item.displayName || item.name || 'Contato');
      const fPhone = esc(item.phoneFormatted || item.phone || '');
      const cleanNum = String(item.phone || '').replace(/\D/g, '');
      const reason = esc(item.handoffReason || 'Solicitação para falar diretamente com o responsável');
      const timeWait = esc(item.time || 'recente');
      const urgency = item.handoffUrgency === 'urgente' ? '<span class="pill mini err">URGENTE</span>' : '';

      return `
      <div class="handoff-card">
        <div class="handoff-info">
          <div class="handoff-header">
            <strong>${dName}</strong>
            <span style="font-family:var(--font-mono);font-size:12px;opacity:0.8;">${fPhone}</span>
            ${urgency}
          </div>
          <div class="handoff-reason">Motivo: <em>${reason}</em></div>
          <div class="handoff-meta">
            <span>Última atividade: ${timeWait}</span>
            <span>Origem: ${item.origin === 'simulation' ? 'Simulador Isolado' : 'WhatsApp Real'}</span>
          </div>
        </div>
        <div class="handoff-actions">
          <button class="btn-handoff primary" data-open-chat="${esc(item.phone)}">Abrir no Console</button>
          ${cleanNum ? `<a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" class="btn-handoff wa">WhatsApp ↗</a>` : ''}
          <button class="btn-handoff resume" data-resume-bot="${esc(item.phone)}">Reativar Lia</button>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('[data-open-chat]').forEach((btn) => {
    btn.onclick = () => {
      state.selected = btn.dataset.openChat;
      $('#inbox-grid')?.classList.add('mobile-chat-open');
      showView('inbox');
    };
  });

  container.querySelectorAll('[data-resume-bot]').forEach((btn) => {
    btn.onclick = async () => {
      const phone = btn.dataset.resumeBot;
      btn.disabled = true;
      btn.textContent = 'Reativando…';
      try {
        await api('/api/dashboard/mode', { method: 'POST', body: JSON.stringify({ phone, mode: 'bot' }) });
        showToast({ title: 'Lia Reativada', message: `O atendimento automático foi retomado para ${phone}.`, type: 'success' });
        await refresh();
      } catch (e) {
        showToast({ title: 'Erro ao Reativar', message: e.message || 'Não foi possível reativar a Lia.', type: 'error' });
      }
    };
  });
}

// ============================================================================
// ADMIN CONFIGURATION & COLLAPSIBLE ACCORDIONS
// ============================================================================
const adminGet = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const adminSet = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((value, key) => (value[key] ||= {}), object);
  target[last] = value;
};

function adminFeedback(message, type = 'success') {
  const el = $('#admin-feedback');
  if (el) {
    el.textContent = message;
    el.className = `admin-feedback ${type}`;
    clearTimeout(adminFeedback.timer);
    adminFeedback.timer = setTimeout(() => el.classList.add('hidden'), 5000);
  }
  showToast({
    title: type === 'error' ? 'Erro na Configuração' : 'Configuração da Lia',
    message,
    type: type === 'error' ? 'error' : 'success'
  });
}

function renderAdminFaq() {
  const list = $('#admin-faq-list');
  if (!list) return;
  const faq = state.adminConfig?.draft?.knowledge?.faq || [];
  $('#admin-faq-summary').textContent = `${faq.length} perguntas registradas · alterações entram após publicação`;
  list.innerHTML = faq.map((item, index) => `<div class="admin-faq-row" data-faq-index="${index}">
    <div class="admin-faq-key"><span class="faq-index">#${String(index + 1).padStart(2, '0')}</span><input type="text" data-faq-keys value="${esc((item.keys || []).join(', '))}" aria-label="Palavras-chave" placeholder="palavras-chave separadas por vírgula" /></div>
    <textarea data-faq-answer rows="2" aria-label="Resposta">${esc(item.answer || '')}</textarea>
    <label class="faq-enabled"><input type="checkbox" data-faq-enabled ${item.enabled !== false ? 'checked' : ''} /> ativo</label>
    <button type="button" class="icon-btn faq-remove" data-faq-remove="${index}" aria-label="Remover item">
      <svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>`).join('') || '<div class="detail-placeholder admin-empty">Nenhum item cadastrado. Adicione a primeira resposta da base.</div>';
}

function renderAdminHistory() {
  const listEl = $('#admin-history-list');
  const countEl = $('#admin-history-count');
  if (!listEl) return;
  const history = Array.isArray(state.adminConfig?.history) ? [...state.adminConfig.history].reverse() : [];
  const publishedEntries = history.filter(item => item.action === 'published' || item.action === 'rollback');
  if (countEl) countEl.textContent = `${publishedEntries.length} publicações recentes`;
  if (!history.length) {
    listEl.innerHTML = '<div class="detail-placeholder">Nenhum histórico de revisão registrado ainda.</div>';
    return;
  }
  listEl.innerHTML = history.map((entry) => {
    const time = entry.at ? new Date(entry.at).toLocaleString('pt-BR') : '-';
    const canRollback = Boolean(entry.snapshot) && Number(entry.revision) !== Number(state.adminConfig?.revision);
    const label = entry.action === 'published' ? 'Publicação' : entry.action === 'rollback' ? `Rollback (de v${entry.sourceRevision})` : 'Rascunho salvo';
    return `<article class="ops-row">
      <div>
        <strong>Revisão v${Number(entry.revision || 0)} · ${esc(label)}</strong>
        <div class="ops-muted">Ator: ${esc(entry.actor || 'dashboard')} · Data: ${esc(time)}</div>
      </div>
      <div class="ops-actions">
        ${canRollback ? `<button type="button" class="admin-ghost-btn btn-sm" data-rollback-rev="${Number(entry.revision)}">Restaurar v${Number(entry.revision)}</button>` : ''}
      </div>
    </article>`;
  }).join('');
}

function updateSectionDiffBadges() {
  const active = state.adminConfig?.active;
  const draft = state.adminConfig?.draft;
  if (!active || !draft) return;

  let modifiedSections = 0;
  document.querySelectorAll('.config-accordion[data-section-keys]').forEach((acc) => {
    const keys = (acc.dataset.sectionKeys || '').split(',').map(k => k.trim()).filter(Boolean);
    const differs = keys.some(key => JSON.stringify(adminGet(active, key)) !== JSON.stringify(adminGet(draft, key)));
    acc.classList.toggle('has-draft-diff', differs);
    if (differs) modifiedSections++;
    const badge = acc.querySelector('[data-section-badge]');
    if (badge) {
      badge.textContent = differs ? 'Modificado no rascunho' : 'Sincronizado';
      badge.className = `admin-status ${differs ? 'dirty' : ''}`;
    }
  });

  const hasAnyDiff = JSON.stringify(active) !== JSON.stringify(draft);
  $('#admin-draft-badge')?.classList.toggle('hidden', !hasAnyDiff);
  const globalBanner = $('#global-draft-banner');
  if (globalBanner && state.role === 'admin') {
    globalBanner.classList.toggle('hidden', !hasAnyDiff);
    const textEl = $('#global-draft-text');
    if (textEl) textEl.textContent = modifiedSections > 0 ? `${modifiedSections} seção(ões) em rascunho` : 'Alterações em rascunho';
  }
  const diffSummary = $('#admin-diff-summary');
  if (diffSummary) {
    diffSummary.textContent = hasAnyDiff
      ? `Há alterações em rascunho (${modifiedSections || 1} seção modificada). Publique para atualizar o motor em produção.`
      : `Todas as seções estão sincronizadas com a versão publicada (v${state.adminConfig?.revision || 0}).`;
  }
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
  if (state.adminFormDirty && !force) return;
  const draft = state.adminConfig?.draft;
  if (!draft) return;
  if (draft.voice && !draft.voice.deliveryMode) {
    draft.voice.deliveryMode = draft.voice.sendTranscriptionWithAudio === false ? 'audio_only' : 'audio_and_text';
  }
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
  $('#admin-version-badge').textContent = `publicado · v${revision}`;
  renderAdminFaq();
  renderAdminHistory();
  updateSectionDiffBadges();
  updateSidebarConnection();
}

function renderActiveModelLabel() {
  const label = $('#admin-ai-active-model');
  if (!label) return;
  const runtime = state.metrics?.system;
  const draft = state.adminConfig?.draft?.ai;
  const active = state.adminConfig?.active?.ai;
  const model = draft?.activeModel || active?.activeModel || runtime?.activeModel || 'gemini-3.8-flash';
  const provider = draft?.activeProvider || active?.activeProvider || runtime?.activeProvider || 'gemini';
  label.textContent = `${provider.toUpperCase()} · ${model}`;
}

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
    if (status) status.textContent = `${result.models.length} modelos disponíveis${result.truncated ? ' (lista parcial)' : ''}${result.cached ? ' (cache)' : ''}. As chaves permanecem protegidas no servidor.`;
  } catch (error) {
    state.modelCatalogProvider = provider;
    state.modelCatalog = [];
    if (status) {
      let code = error.message;
      try { code = JSON.parse(code).error || code; } catch {}
      status.textContent = code === 'provider_not_configured'
        ? 'Este provedor não está configurado no servidor; nenhuma chave é solicitada ou exibida aqui.'
        : `Não foi possível consultar modelos (${code}).`;
    }
    const savedModel = String(state.adminConfig?.draft?.ai?.activeModel || '').trim();
    primary.replaceChildren(new Option(savedModel ? `${savedModel} (salvo no banco)` : 'Catálogo indisponível', savedModel));
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
    if (selected && !ids.has(selected)) select.add(new Option(`${selected} (salvo no banco)`, selected));
    select.value = selected || '';
  };
  addOptions(primary, selectedPrimary, true);
  renderActiveModelLabel();
}

const FALLBACK_PROVIDERS = [['gemini', 'Gemini'], ['openrouter', 'OpenRouter'], ['cloudflare', 'Cloudflare Workers AI'], ['openai', 'OpenAI'], ['qwen', 'Qwen']];
function fallbackEntry(value = '') {
  const match = String(value).trim().match(/^(gemini|openrouter|cloudflare|openai|qwen):(.*)$/i);
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
    return `<div class="fallback-row-card">
      <span class="fallback-slot-title">Reserva #${index + 1}</span>
      <select class="admin-fallback-provider" data-index="${index}">${FALLBACK_PROVIDERS.map(([id, name]) => `<option value="${id}" ${id === selected.provider ? 'selected' : ''}>${name}</option>`).join('')}</select>
      <select class="admin-fallback-model" data-index="${index}"><option value="">Nenhum modelo selecionado</option>${options}${extra}</select>
    </div>`;
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
  if (draft.voice) {
    const delivery = draft.voice.deliveryMode || (draft.voice.sendTranscriptionWithAudio === false ? 'audio_only' : 'audio_and_text');
    draft.voice.deliveryMode = delivery;
    draft.voice.sendTranscriptionWithAudio = delivery !== 'audio_only';
  }
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
    queueAdminSave();
  }
  if (state.adminSaveQueued) {
    state.adminSaveQueued = false;
    clearTimeout(state.adminSaveTimer);
    state.adminSaveTimer = setTimeout(() => saveAdminDraft().catch(error => adminFeedback(error.message, 'error')), 0);
  }
  if (showMessage) adminFeedback('Rascunho salvo no Supabase. Publique quando desejar aplicar no WhatsApp.', 'success');
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
    if (state.adminFormDirty || requestVersion !== state.adminChangeVersion) return;
    state.adminConfig = snapshot;
    state.adminFormDirty = false;
    renderAdmin();
    if (state.adminConfig.persistence !== 'supabase') adminFeedback(state.adminConfig.persistenceError ? `Banco não gravando: ${state.adminConfig.persistenceError}` : 'Banco não configurado: alterações estão somente no arquivo local.', 'error');
  } catch (error) {
    adminFeedback(`Não foi possível carregar a configuração: ${error.message}`, 'error');
  }
}

async function publishAdminChanges() {
  const btn = $('#admin-publish');
  const globalBtn = $('#global-publish-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Publicando…';
  }
  if (globalBtn) {
    globalBtn.disabled = true;
    globalBtn.textContent = 'Publicando…';
  }
  try {
    if (state.adminConfig && state.adminFormDirty) {
      await saveAdminDraft();
    }
    const result = await api('/api/admin/config/publish', { method: 'POST', body: '{}' });
    if (!result.ok) throw new Error((result.errors || []).join(' '));
    state.adminConfig = result.snapshot;
    renderAdmin({ force: true });
    adminFeedback(`Revisão v${result.snapshot.revision} publicada e ativa em tempo real!`, 'success');
    if (state.view === 'tools') await renderTools();
    if (state.view === 'overview') await renderOverview();
  } catch (error) {
    adminFeedback(`Erro na publicação: ${error.message}`, 'error');
    opsFeedback('tools-feedback', `Erro na publicação: ${error.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Publicar Alterações';
    }
    if (globalBtn) {
      globalBtn.disabled = false;
      globalBtn.textContent = 'Publicar';
    }
  }
}

const ROLE_LEVEL = { viewer: 0, operator: 1, admin: 2 };
function applyRoleVisibility() {
  const level = ROLE_LEVEL[state.role] ?? 0;
  document.querySelectorAll('[data-role]').forEach(el => el.classList.toggle('hidden', level < (ROLE_LEVEL[el.dataset.role] ?? 2)));
  const operationalControls = ['#mode-selector', '#refresh', '#new-sim', '#overview-open-simulation'];
  operationalControls.forEach(selector => $(selector)?.classList.toggle('hidden', level < ROLE_LEVEL.operator));
  if (level < ROLE_LEVEL.operator && ['inbox', 'handoff', 'admin'].includes(state.view)) showView('overview');
  updateSidebarUserProfile();
}

function opsFeedback(id, message, type = 'success') {
  const element = $(`#${id}`);
  if (element) {
    element.textContent = message;
    element.className = `admin-feedback ${type}`;
    element.classList.remove('hidden');
  }
  showToast({
    title: type === 'error' ? 'Falha na Operação' : 'Atualização do Sistema',
    message,
    type: type === 'error' ? 'error' : 'success'
  });
}

// ============================================================================
// OVERVIEW, TOOLS, CAMPAIGNS, USERS, INTEGRATIONS
// ============================================================================
function renderOverviewCharts(metrics, health) {
  const latEl = $('#overview-chart-latency');
  const modEl = $('#overview-chart-models');
  const latBadge = $('#chart-latency-badge');
  const succBadge = $('#chart-success-badge');
  const latSub = $('#chart-latency-subtitle');
  const modSub = $('#chart-models-subtitle');
  if (!latEl || !modEl) return;

  const avgLat = Number(metrics?.overview?.avgLatencyMs || 0);
  const totalReq = Number(metrics?.overview?.totalRequests || 0);
  const successRate = Number(metrics?.overview?.successRate ?? 100);
  const nowLabel = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  state.overviewSamples.push({ ts: nowLabel, latencyMs: avgLat, requests: totalReq });
  if (state.overviewSamples.length > 16) state.overviewSamples.shift();

  if (latBadge) latBadge.textContent = `${avgLat} ms`;
  if (succBadge) {
    succBadge.textContent = `${successRate}% sucesso`;
    succBadge.className = `pill mini ${successRate >= 95 ? 'mint' : successRate >= 80 ? 'amber' : 'err'}`;
  }
  if (latSub) latSub.textContent = `${state.overviewSamples.length} amostra(s) em sessão · última às ${nowLabel}`;

  const samples = state.overviewSamples;
  const maxLat = Math.max(100, ...samples.map((s) => s.latencyMs));
  const w = 420;
  const h = 110;
  const padX = 12;
  const padY = 12;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  const pts = samples.map((s, idx) => {
    const x = samples.length === 1 ? padX + plotW / 2 : padX + (idx / (samples.length - 1)) * plotW;
    const y = padY + plotH - (Math.min(s.latencyMs, maxLat) / maxLat) * plotH;
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...s };
  });

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = pts.length > 1
    ? `${linePath} L${pts[pts.length - 1].x},${h - padY} L${pts[0].x},${h - padY} Z`
    : '';
  const circles = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.2" fill="#86DEBA" stroke="#131313" stroke-width="1.4"><title>${esc(p.ts)}: ${p.latencyMs} ms (${p.requests} req)</title></circle>`).join('');

  latEl.innerHTML = `
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Gráfico de latência em tempo real">
        <line x1="${padX}" y1="${padY}" x2="${w - padX}" y2="${padY}" stroke="#2A2B2F" stroke-dasharray="3 3" stroke-width="1" />
        <line x1="${padX}" y1="${h / 2}" x2="${w - padX}" y2="${h / 2}" stroke="#2A2B2F" stroke-dasharray="3 3" stroke-width="1" />
        <line x1="${padX}" y1="${h - padY}" x2="${w - padX}" y2="${h - padY}" stroke="#2A2B2F" stroke-width="1" />
        ${areaPath ? `<path d="${areaPath}" fill="#20495B" fill-opacity="0.38" />` : ''}
        ${linePath ? `<path d="${linePath}" fill="none" stroke="#48AA7E" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />` : ''}
        ${circles}
      </svg>
    </div>
    <div class="chart-legend-row">
      <span>Pico observado: <strong>${Math.max(0, ...samples.map((s) => s.latencyMs))} ms</strong></span>
      <span>Chamadas acumuladas: <strong>${totalReq}</strong></span>
      <span>Uptime: <strong>${health?.liveness?.uptimeSeconds != null ? `${Math.floor(health.liveness.uptimeSeconds / 60)} min` : 'ativo'}</strong></span>
    </div>
  `;

  const byModelRaw = metrics?.byModel || metrics?.models || {};
  const entries = Array.isArray(byModelRaw)
    ? byModelRaw.map((m) => [m.model || m.name || 'modelo', Number(m.requests || m.count || 0)])
    : Object.entries(byModelRaw).map(([k, v]) => [k, typeof v === 'object' ? Number(v.requests || v.count || 0) : Number(v || 0)]);

  entries.sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 5);
  const maxCount = Math.max(1, ...top.map(([, c]) => c));

  if (modSub) modSub.textContent = top.length ? `${top.length} modelo(s) ativos no ledger` : 'Aguardando chamadas de IA no período';

  if (!top.length) {
    const activeProvider = `${(health?.system?.provider || 'gemini').toUpperCase()} · ${health?.system?.model || '-'}`;
    modEl.innerHTML = `
      <div class="model-bar-list">
        <div class="model-bar-row">
          <div class="model-bar-meta"><strong>${esc(activeProvider)}</strong><span>${totalReq} chamada(s)</span></div>
          <div class="model-bar-track"><div class="model-bar-fill" style="width:${totalReq > 0 ? 100 : 12}%"></div></div>
        </div>
        <div class="ops-muted">Taxa de sucesso global: ${successRate}% · fonte ${metrics?.source === 'supabase' ? 'Supabase' : 'Memória'}</div>
      </div>
    `;
    return;
  }

  modEl.innerHTML = `<div class="model-bar-list">${top.map(([name, count], idx) => {
    const pct = Math.max(6, Math.round((count / maxCount) * 100));
    return `
      <div class="model-bar-row">
        <div class="model-bar-meta"><strong>${esc(name)}</strong><span>${count} req</span></div>
        <div class="model-bar-track"><div class="model-bar-fill ${idx > 0 ? 'secondary' : ''}" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('')}</div>`;
}

function startOverviewPolling() {
  if (state.overviewPollTimer) clearInterval(state.overviewPollTimer);
  state.overviewPollTimer = setInterval(() => {
    if (!document.hidden && state.initialized && state.view === 'overview') {
      renderOverview({ silent: true }).catch(() => {});
    }
  }, 10000);
}

async function renderOverview(opts = {}) {
  const healthEl = $('#overview-health');
  const costsEl = $('#overview-costs');
  const modelsEl = $('#overview-models');
  const operationsEl = $('#overview-operations');
  if (!healthEl) return;
  if (!opts.silent) {
    setTopProgress(true);
    if (!state.health) {
      healthEl.innerHTML = renderSkeletonCards(3);
      if (costsEl) costsEl.innerHTML = renderSkeletonCards(2);
      if (modelsEl) modelsEl.innerHTML = renderSkeletonCards(2);
      if (operationsEl) operationsEl.innerHTML = renderSkeletonCards(2);
    }
  }
  try {
    const tasks = [
      api('/api/dashboard/health-summary'),
      api('/api/dashboard/metrics'),
      api('/api/dashboard/integrations').catch(() => null)
    ];
    const [healthResult, metricsResult, integResult] = await Promise.allSettled(tasks);
    const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
    const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
    const integrations = integResult.status === 'fulfilled' ? integResult.value : null;

    state.health = health;
    state.metrics = metrics;
    if (integrations) state.integrations = integrations;
    updateSidebarConnection({ integrations, health });

    const ovBadge = $('#overview-status-badge');
    if (ovBadge) {
      const isReady = health?.readiness?.ok !== false && health?.liveness?.status === 'alive';
      ovBadge.textContent = isReady ? 'ok' : 'atenção';
      ovBadge.className = `badge-mini ${isReady ? 'ok' : 'warn'}`;
    }

    const ev = integrations?.evolution;
    if ($('#ov-kpi-wa')) {
      $('#ov-kpi-wa').textContent = ev ? (ev.connected ? 'Conectado' : ev.status) : (health?.readiness?.ok ? 'Online' : 'Verificando');
      $('#ov-kpi-wa-sub').textContent = ev ? `Instância ${ev.instance || '-'} · ${ev.latencyMs ?? '-'} ms` : `Instância ${health?.system?.instance || '-'}`;
    }
    if ($('#ov-kpi-ai')) {
      $('#ov-kpi-ai').textContent = `${(health?.system?.provider || 'gemini').toUpperCase()} · ${health?.system?.model || '-'}`;
      $('#ov-kpi-ai-sub').textContent = `Revisão publicada v${health?.system?.revision ?? state.adminConfig?.revision ?? 0}`;
    }
    if ($('#ov-kpi-sessions')) {
      const sys = metrics?.system || {};
      $('#ov-kpi-sessions').textContent = `${Number(sys.totalSessions ?? state.sessionCounts?.total ?? state.sessions.length)}`;
      $('#ov-kpi-sessions-sub').textContent = `${Number(sys.handoffWaiting ?? state.sessionCounts?.handoff ?? state.sessions.filter(s => s.human).length)} em atendimento humano`;
    }
    if ($('#ov-kpi-bridge')) {
      const br = integrations?.chatwootBridge;
      const sec = integrations?.sectorsProjection;
      $('#ov-kpi-bridge').textContent = br?.status === 'ok' || br?.lastReadAt ? `Sincronizada (v${br.revision ?? 0})` : (br?.status || 'Aguardando leitura');
      $('#ov-kpi-bridge-sub').textContent = `${Number(sec?.count || 0)} setor(es) projetados pelo Chatwoot`;
    }

    healthEl.innerHTML = health?.readiness?.checks?.length
      ? health.readiness.checks.map(item => `
          <div class="ops-row">
            <div>
              <strong>${esc(item.name || 'dependência')}</strong>
              ${item.reason ? `<div class="ops-muted">${esc(item.reason)}</div>` : ''}
            </div>
            <span class="status-text ${item.status === 'ok' || item.status === 'ready' ? 'ok' : item.status === 'not_configured' || item.status === 'disabled' ? 'warn' : 'err'}">${esc(item.status || 'desconhecido')}</span>
          </div>`).join('')
      : `<div class="ops-row"><strong>Lia Sync</strong><span class="status-text ${health?.liveness?.status === 'alive' ? 'ok' : 'err'}">${health?.liveness?.status === 'alive' ? 'viva' : 'sem resposta'}</span></div>`;

    const cost = metrics?.estimatedCost;
    if (costsEl) {
      costsEl.innerHTML = `
        <div class="ops-row"><strong>Custo estimado no mês (UTC)</strong><span>${cost?.complete ? `US$ ${Number(cost.totalUsd || 0).toFixed(4)}` : cost?.knownUsd > 0 ? `≥ US$ ${Number(cost.knownUsd).toFixed(4)}` : 'não calculado'}</span></div>
        <div class="ops-row"><strong>Telemetria & Chamadas</strong><span>${metrics?.source === 'supabase' ? 'persistente (Supabase)' : 'memória local'} · ${Number(metrics?.overview?.totalRequests || 0)} chamadas</span></div>
        <div class="ops-row"><strong>Latência média / Taxa de sucesso</strong><span>${Number(metrics?.overview?.avgLatencyMs || 0)} ms · ${Number(metrics?.overview?.successRate ?? 100)}%</span></div>
      `;
    }
    if (modelsEl) {
      modelsEl.innerHTML = Object.entries(metrics?.circuitBreakers || {}).map(([provider, item]) => `
        <div class="ops-row">
          <strong>${esc(provider.toUpperCase())}</strong>
          <span class="pill mini ${!item.configured ? 'pale' : item.status === 'aberto' ? 'err' : 'mint'}">${esc(item.status || 'desconhecido')} · ${item.configured ? `${Number(item.failures || 0)} falhas` : 'não configurado'}</span>
        </div>`).join('') || '<div class="ops-row">Nenhum provedor reportado.</div>';
    }
    if (operationsEl) {
      const sys = metrics?.system || {};
      operationsEl.innerHTML = `
        <div class="ops-row"><strong>Sessões Ativas / Simulação</strong><span>${Number(sys.totalSessions ?? state.sessionCounts?.total ?? 0)} totais · ${Number(state.sessionCounts?.simulation ?? 0)} sim</span></div>
        <div class="ops-row"><strong>Transbordos Humanos</strong><span>${Number(sys.handoffWaiting ?? state.sessionCounts?.handoff ?? 0)} aguardando</span></div>
        <div class="ops-row"><strong>Persistência de Estado</strong><span class="pill mini ${metrics?.source === 'supabase' ? 'mint' : 'amber'}">${metrics?.source === 'supabase' ? 'Supabase ativo' : 'memória local'}</span></div>
      `;
    }
    renderOverviewCharts(metrics, health);
    startOverviewPolling();
    decorateTechnicalTerms($('#overview-view'));
  } finally {
    if (!opts.silent) setTopProgress(false);
  }
}

async function renderTools() {
  try {
    state.tools = await api('/api/dashboard/tools');
    const catalog = state.role === 'admin' && state.tools.draft ? state.tools.draft : state.tools;
    const activeTools = new Map((state.tools.active?.tools || state.tools.tools || []).map(tool => [tool.name, tool.enabled]));
    const list = $('#tools-catalog');
    $('#tools-catalog-count').textContent = `${catalog.tools.length} ferramentas · ${state.tools.persistence || 'configuração local'} · rev v${state.tools.revision || 0}`;
    $('#tools-web-search').checked = catalog.webSearch.enabled;
    $('#tools-web-search').disabled = state.role !== 'admin';
    const webBadge = $('#tools-web-badge');
    if (webBadge) {
      webBadge.textContent = catalog.webSearch.enabled && catalog.webSearch.configured ? 'Ativo' : 'Desativado';
      webBadge.className = `pill mini ${catalog.webSearch.enabled && catalog.webSearch.configured ? 'mint' : 'amber'}`;
    }
    $('#tools-web-search-meta').textContent = `${catalog.webSearch.provider} · ${catalog.webSearch.configured ? 'provedor configurado' : 'chave do provedor ausente'} · aplicado a ${catalog.webSearch.appliesTo.join(' e ')}`;
    list.innerHTML = catalog.tools.map(tool => {
      const active = activeTools.get(tool.name) !== false;
      const draftDiffers = tool.enabled !== active;
      const schema = Array.isArray(tool.settingsSchema) ? tool.settingsSchema : [];
      const currentSettings = tool.settings && typeof tool.settings === 'object' ? tool.settings : {};
      const settingsHtml = schema.length ? `
        <details class="tool-settings-details">
          <summary>Configurações da ferramenta (${schema.length})</summary>
          <div class="tool-settings-body">
            ${schema.map(field => `
              <label class="tool-setting-field">
                <span>${esc(field.label || field.key)}</span>
                <input
                  type="${esc(field.type || 'text')}"
                  data-tool-setting-tool="${esc(tool.name)}"
                  data-tool-setting-key="${esc(field.key)}"
                  value="${esc(currentSettings[field.key] ?? '')}"
                  placeholder="${esc(field.placeholder || '')}"
                  ${state.role === 'admin' ? '' : 'disabled'}
                />
              </label>
            `).join('')}
          </div>
        </details>
      ` : '';
      return `<article class="tool-card">
        <div class="tool-card-head">
          <strong><code>${esc(tool.name)}</code></strong>
          <input type="checkbox" class="tool-toggle" data-tool="${esc(tool.name)}" aria-label="Ativar ${esc(tool.name)}" ${tool.enabled ? 'checked' : ''} ${state.role === 'admin' ? '' : 'disabled'} />
        </div>
        <p>${esc(tool.description)}</p>
        ${settingsHtml}
        <div class="tool-meta">${tool.clientAllowed ? 'Fluxo de clientes & Copiloto' : 'Exclusiva do Copiloto (Proprietário)'}${draftDiffers ? ` · <b style="color:var(--accent-amber)">rascunho difere do publicado (${active ? 'ligado' : 'desligado'})</b>` : ''}</div>
      </article>`;
    }).join('');
    decorateTechnicalTerms($('#tools-view'));
  } catch (error) { opsFeedback('tools-feedback', `Falha ao carregar catálogo: ${error.message}`, 'error'); }
}

async function saveToolsDraft() {
  const enabled = Object.fromEntries([...document.querySelectorAll('.tool-toggle')].map(input => [input.dataset.tool, input.checked]));
  const settings = {};
  document.querySelectorAll('[data-tool-setting-tool]').forEach(input => {
    const t = input.dataset.toolSettingTool;
    const k = input.dataset.toolSettingKey;
    if (!t || !k) return;
    if (!settings[t]) settings[t] = {};
    settings[t][k] = input.value.trim();
  });
  const result = await api('/api/dashboard/tools', { method: 'PATCH', body: JSON.stringify({ enabled, settings, webSearchEnabled: $('#tools-web-search').checked }) });
  if (state.adminConfig) {
    state.adminConfig = await api('/api/admin/config').catch(() => state.adminConfig);
    updateSectionDiffBadges();
  }
  return result;
}

async function renderUsers() {
  try {
    const [usersResult, auditResult] = await Promise.all([api('/api/dashboard/users'), api('/api/dashboard/audit')]);
    $('#users-table').innerHTML = usersResult.users.map(user => `<tr><td>${esc(user.fullName || 'Sem nome')}</td><td>${esc(user.email || '-')}</td><td><select class="user-action-select" data-user-role="${esc(user.id)}"><option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>viewer</option><option value="operator" ${user.role === 'operator' ? 'selected' : ''}>operator</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option></select></td><td><input type="checkbox" data-user-active="${esc(user.id)}" ${user.active ? 'checked' : ''} aria-label="Perfil ativo" /></td><td>${esc(user.lastSignInAt || '-')}</td><td><button class="admin-ghost-btn btn-sm" data-user-save="${esc(user.id)}">Salvar</button></td></tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nenhum perfil encontrado.</td></tr>';
    $('#audit-list').innerHTML = auditResult.entries.map(entry => `<article class="ops-row"><div><strong>${esc(entry.action)}</strong><div class="ops-muted">${esc(entry.entityType || 'sistema')} · ator ${esc(entry.actorId || 'não identificado')} · ${esc(entry.createdAt || '')}</div><div class="ops-muted">${esc(JSON.stringify(entry.metadata || {}))}</div></div></article>`).join('') || '<div class="detail-placeholder">Nenhum evento de auditoria registrado.</div>';
    decorateTechnicalTerms($('#users-view'));
  } catch (error) { opsFeedback('users-feedback', `Falha ao carregar usuários/auditoria: ${error.message}`, 'error'); }
}

async function renderIntegrations() {
  try {
    const data = await api('/api/dashboard/integrations');
    state.integrations = data;
    updateSidebarConnection({ integrations: data });
    const hours = data.businessHours || {};
    const sectors = data.sectorsProjection || {};
    const hoursDetail = `${hours.summary || 'Expediente indisponível.'}${hours.enabled && !hours.isOpenNow && hours.nextOpenAt ? ` · reabertura ${new Date(hours.nextOpenAt).toLocaleString('pt-BR')}` : ''}`;
    const sectorsDetail = `${Number(sectors.count) || 0} setor(es) na projeção · última leitura ${sectors.updatedAt ? new Date(sectors.updatedAt).toLocaleString('pt-BR') : 'ainda não sincronizada'}`;
    const statuses = [
      ['Ponte Chatwoot Lia', data.chatwootBridge?.status || 'unknown', `Revisão ${data.chatwootBridge?.revision ?? '-'} · última leitura ${data.chatwootBridge?.lastReadAt ? new Date(data.chatwootBridge.lastReadAt).toLocaleString('pt-BR') : 'aguardando primeira leitura'}`],
      ['Expediente da Lia', !hours.enabled ? '24 horas' : (hours.isOpenNow ? 'aberto' : 'fechado'), hoursDetail],
      ['Setores do Chatwoot', sectors.synced ? 'sincronizado' : 'aguardando sincronização', sectorsDetail],
      ['Evolution API', data.evolution.status, `Host ${data.evolution.apiHost || '-'} · instância ${data.evolution.instance || '-'} · latência ${data.evolution.latencyMs ?? '-'} ms`],
      ['Supabase', data.supabase.configured ? 'configurado' : 'não configurado', `Projeto ${data.supabase.urlHost || '-'} · backend-only`],
      ['Autenticação do webhook', data.webhook.authenticated ? 'token configurado' : 'sem token', `Rota ${data.webhook.route} · ledger ${data.webhook.ledgerConfigured ? 'ativo' : 'indisponível'}`],
      ...(data.providers || []).map(item => [item.name, item.state, `${item.configured ? 'configurado' : 'não configurado'} · ${item.failures} falhas · quarentena ${item.quarantineSeconds}s`])
    ];
    $('#integrations-status').innerHTML = statuses.map(([name, status, detail]) => `<article class="integration-card"><div class="integration-card-head"><strong>${esc(name)}</strong><span class="status-text ${/connected|ok|configured|token configured|operacional|aberto|24 horas|sincronizado/i.test(status) ? 'ok' : /not_configured|não configurado|disconnected|unreachable|timeout|awaiting_first_read|stale|unknown|fechado|aguardando/i.test(status) ? 'warn' : 'err'}">${esc(status)}</span></div><p>${esc(detail)}</p>${name === 'Evolution API' ? `<p>${data.evolution.ownerLinked ? 'Instância vinculada a um telefone' : 'Telefone proprietário não vinculado'}</p>` : ''}</article>`).join('');
    const events = data.webhook.recentEvents || [];
    $('#webhook-summary').textContent = `${events.length} eventos recentes · ${data.webhook.ledgerConfigured ? 'ledger persistente' : 'ledger não disponível'}`;
    $('#webhook-events').innerHTML = events.map(event => `<tr><td>${esc(event.receivedAt || '')}</td><td>${esc(event.eventType)}</td><td>${esc(event.instance || '-')}</td><td>${esc(event.status)}</td><td>${Number(event.attempts || 1)}</td><td>${esc(event.errorCode || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nenhum evento recente ou ledger não aplicado.</td></tr>';
    decorateTechnicalTerms($('#integrations-view'));
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

function render({ background = false } = {}) {
  try { renderList(); } catch (e) { console.error('[renderList]', e); }
  try { renderChat(); } catch (e) { console.error('[renderChat]', e); }
  try { renderHandoff(); } catch (e) { console.error('[renderHandoff]', e); }
  if (!background) {
    if (state.view === 'admin') { try { renderAdmin(); } catch (e) { console.error('[renderAdmin]', e); } }
    if (state.view === 'agent') { try { renderAgent(); } catch (e) { console.error('[renderAgent]', e); } }
    if (state.view === 'metrics') { try { renderMetrics(); } catch (e) { console.error('[renderMetrics]', e); } }
    if (state.view === 'overview') { try { renderOverview(); } catch (e) { console.error('[renderOverview]', e); } }
    if (state.view === 'tools') { try { renderTools(); } catch (e) { console.error('[renderTools]', e); } }
    if (state.view === 'users') { try { renderUsers(); } catch (e) { console.error('[renderUsers]', e); } }
    if (state.view === 'integrations') { try { renderIntegrations(); } catch (e) { console.error('[renderIntegrations]', e); } }
  }
  const lastSync = $('#last-sync');
  if (lastSync) lastSync.textContent = `sincronizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  if (!background) setTimeout(() => decorateTechnicalTerms(document.body), 60);
}

async function refresh({ background = false } = {}) {
  if (!background) setTopProgress(true);
  try {
    const data = await api(`/api/dashboard/state?mode=${encodeURIComponent(state.mode)}`);
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (data.counts) state.sessionCounts = data.counts;
    const subtitle = $('#inbox-subtitle');
    if (subtitle) {
      subtitle.textContent = data.persistence === 'supabase'
        ? `${state.sessions.length} sessões (${state.mode === 'real' ? 'WhatsApp' : state.mode === 'simulation' ? 'Simulador' : 'Todas'}) · Supabase`
        : data.persistenceError
        ? 'fallback local - Supabase indisponível'
        : `${state.sessions.length} sessões ativas`;
    }
    if (!state.sessions.some((item) => item.phone === state.selected)) {
      state.selected = state.sessions[0]?.phone || null;
    }
    render({ background });
  } finally {
    if (!background) setTopProgress(false);
  }
}

async function setMode(mode) {
  if (!state.selected) return;
  const toggleBtn = $('#toggle-mode');
  const topBtn = $('#transfer-top');
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = mode === 'bot' ? 'Reativando Lia…' : 'Transferindo para humano…';
  }
  if (topBtn) topBtn.disabled = true;
  try {
    await api('/api/dashboard/mode', { method: 'POST', body: JSON.stringify({ phone: state.selected, mode }) });
    await refresh();
    showToast({
      title: mode === 'bot' ? 'Lia Reativada' : 'Atendimento Humano',
      message: mode === 'bot' ? 'A Lia voltou a responder esta conversa automaticamente.' : 'Conversa transferida para atendimento humano.',
      type: 'success'
    });
  } catch (err) {
    showToast({ title: 'Falha ao Alternar Modo', message: err.message, type: 'error' });
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
    if (topBtn) topBtn.disabled = false;
  }
}

async function clearSession() {
  if (!state.selected) return;
  const sess = selectedSession();
  try {
    const real = sess ? sess.origin !== 'simulation' : state.mode === 'real';
    if (real && !window.confirm('Arquivar esta conversa real?')) return;
    await api('/api/dashboard/clear', {
      method: 'POST',
      body: JSON.stringify({
        phone: state.selected,
        mode: real ? 'real' : 'simulation',
        confirm: !real || true,
        reason: real ? 'Arquivamento solicitado no dashboard' : 'Limpeza de simulação'
      })
    });
    showToast({
      title: real ? 'Conversa Arquivada' : 'Simulação Reiniciada',
      message: real ? 'A sessão foi arquivada com sucesso.' : 'O histórico de teste foi limpo.',
      type: 'info'
    });
    await refresh();
  } catch (error) {
    showToast({ title: 'Erro ao Arquivar', message: error.message || 'Não foi possível concluir a operação.', type: 'error' });
  }
}

const VIEW_TITLES = {
  overview: 'Saúde & Operação',
  inbox: 'Conversas em Tempo Real',
  handoff: 'Fila de Transbordos Humanos',
  admin: 'Configurações Gerais da Lia',
  tools: 'Ferramentas & Busca Web',
  agent: 'Capacidades & Roteador IA',
  integrations: 'Integrações & Ponte Chatwoot',
  users: 'Usuários, Perfis & Auditoria',
  metrics: 'Monitoramento & Custos'
};

function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((item) => item.classList.remove('active-view'));
  document.querySelector(`#${view}-view`)?.classList.add('active-view');
  document.querySelectorAll('.nav-item, .mob-nav-btn').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view] || 'Console Lia Sync';

  $('#app-sidebar')?.classList.remove('mobile-open');
  $('#sidebar-backdrop')?.classList.add('hidden');

  if (view === 'inbox') {
    renderList();
    renderChat();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) refresh().catch(() => {});
  }
  if (view === 'handoff') {
    renderHandoff();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) refresh().catch(() => {});
  }
  if (view === 'agent') renderAgent();
  if (view === 'metrics') renderMetrics();
  if (view === 'admin') renderAdminData();
  if (view === 'overview') renderOverview();
  if (view === 'tools') renderTools();
  if (view === 'users') renderUsers();
  if (view === 'integrations') renderIntegrations();
  setTimeout(() => decorateTechnicalTerms(document.body), 90);
}

function setupCommandPalette() {
  const modal = $('#cmd-palette-modal');
  const input = $('#cmd-palette-input');
  const list = $('#cmd-palette-list');
  if (!modal || !input || !list) return;

  const commands = [
    { title: 'Saúde & Operação', sub: 'Visão geral, liveness e readiness', action: () => showView('overview') },
    { title: 'Monitoramento & Custos', sub: 'Telemetria, latência e circuit breakers', action: () => showView('metrics') },
    { title: 'Conversas (Inbox)', sub: 'Atendimento em tempo real e simulador', role: 'operator', action: () => showView('inbox') },
    { title: 'Fila de Transbordos', sub: 'Atendimentos aguardando humano', role: 'operator', action: () => showView('handoff') },
    { title: 'Ferramentas & Consulta Web', sub: 'Catálogo de Tool Calling e Google Search', action: () => showView('tools') },
    { title: 'Capacidades & Roteador IA', sub: 'Matriz de modelos e simulador de rota', action: () => showView('agent') },
    { title: 'Integrações & Webhooks', sub: 'Evolution API, Supabase e Ponte Chatwoot', action: () => showView('integrations') },
    { title: 'Configurações: Identidade & System Prompt', sub: 'Persona, empresa e diretriz mestre', role: 'admin', action: () => openAdminSection('acc-identity') },
    { title: 'Configurações: Motor IA & Fallbacks', sub: 'Provedor, modelo ativo e reservas', role: 'admin', action: () => openAdminSection('acc-ai') },
    { title: 'Configurações: Voz Nativa (TTS WAV)', sub: 'Aoede, Kore, velocidade e PTT automático', role: 'admin', action: () => openAdminSection('acc-voice') },
    { title: 'Configurações: Operações & Follow-up', sub: 'Automação, janelas e alertas humanos', role: 'admin', action: () => openAdminSection('acc-automation') },
    { title: 'Configurações: Janela de Atendimento', sub: 'Expediente comercial e aviso fora de hora', role: 'admin', action: () => openAdminSection('acc-hours') },
    { title: 'Configurações: Google Calendar', sub: 'Horários livres, duração de slots e agenda', role: 'admin', action: () => openAdminSection('acc-calendar') },
    { title: 'Configurações: Base de Conhecimento (FAQ)', sub: 'Perguntas e respostas prioritárias', role: 'admin', action: () => openAdminSection('acc-faq') },
    { title: 'Configurações: Histórico & Rollback', sub: 'Restaurar versões anteriores publicadas', role: 'admin', action: () => openAdminSection('acc-history') },
    { title: 'Usuários & Auditoria', sub: 'Perfis RBAC e trilha de auditoria', role: 'admin', action: () => showView('users') },
    ...Object.entries(TECH_GLOSSARY).map(([key, entry]) => ({
      title: `Glossário · ${entry.term}`,
      sub: entry.summary,
      badge: entry.category,
      isGlossary: true,
      action: () => {
        showToast({ title: entry.term, message: entry.summary, type: 'info', duration: 6500 });
        if (entry.accId) openAdminSection(entry.accId);
        else if (entry.view) showView(entry.view);
      }
    }))
  ];

  let glossaryOnlyMode = false;
  let activeIndex = 0;
  let currentFiltered = [];

  const getCmdIcon = (cmd) => {
    if (cmd.isGlossary) {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    }
    if (cmd.title.startsWith('Configurações')) {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 19 21 12 17 5 21 12 2"/></svg>`;
  };

  const updateActiveHighlight = () => {
    const items = list.querySelectorAll('.cmd-item');
    items.forEach((btn, i) => {
      const isActive = i === activeIndex;
      btn.classList.toggle('active', isActive);
      if (isActive) btn.scrollIntoView({ block: 'nearest' });
    });
  };

  const renderCmds = () => {
    const q = input.value.trim().toLowerCase();
    const level = ROLE_LEVEL[state.role] ?? 0;
    currentFiltered = commands.filter(cmd => {
      if (glossaryOnlyMode && !cmd.isGlossary) return false;
      if (cmd.role && level < (ROLE_LEVEL[cmd.role] ?? 2)) return false;
      return !q || `${cmd.title} ${cmd.sub} ${cmd.badge || ''}`.toLowerCase().includes(q);
    });
    activeIndex = 0;
    const countEl = $('#cmd-footer-count');
    if (countEl) countEl.textContent = `${currentFiltered.length} item${currentFiltered.length === 1 ? '' : 's'}`;

    if (!currentFiltered.length) {
      list.innerHTML = `<div class="detail-placeholder" style="padding:22px 14px;text-align:center;">Nenhum comando ou termo encontrado para "${esc(q)}".</div>`;
      return;
    }

    list.innerHTML = currentFiltered.map((cmd, idx) => `
      <button type="button" class="cmd-item ${idx === 0 ? 'active' : ''}" data-cmd-idx="${idx}">
        <div class="cmd-item-icon">${getCmdIcon(cmd)}</div>
        <div class="cmd-item-body">
          <div class="cmd-item-title">${esc(cmd.title)}</div>
          <div class="cmd-item-sub">${esc(cmd.sub)}</div>
        </div>
        <span class="cmd-item-badge ${cmd.isGlossary ? 'badge-glossary' : 'badge-nav'}">${esc(cmd.badge || 'Ir ↵')}</span>
      </button>
    `).join('');

    list.querySelectorAll('[data-cmd-idx]').forEach(btn => {
      btn.onclick = () => {
        const target = currentFiltered[Number(btn.dataset.cmdIdx)];
        modal.classList.add('hidden');
        target?.action();
      };
      btn.onmouseenter = () => {
        activeIndex = Number(btn.dataset.cmdIdx);
        updateActiveHighlight();
      };
    });
  };

  const openModal = ({ glossary = false } = {}) => {
    glossaryOnlyMode = Boolean(glossary);
    modal.classList.remove('hidden');
    input.value = '';
    input.placeholder = glossaryOnlyMode
      ? 'Buscar sigla ou termo técnico (ex: PTT, TTS, SLA, Circuit Breaker, RBAC, P95)…'
      : 'Ir para seção, buscar configuração, sigla técnica ou executar ação…';
    renderCmds();
    input.focus();
  };

  $('#cmd-palette-trigger')?.addEventListener('click', () => openModal({ glossary: false }));
  $('#glossary-trigger-btn')?.addEventListener('click', () => openModal({ glossary: true }));
  $('#cmd-palette-close')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  input.addEventListener('input', renderCmds);
  input.addEventListener('keydown', (e) => {
    if (!currentFiltered.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % currentFiltered.length;
      updateActiveHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + currentFiltered.length) % currentFiltered.length;
      updateActiveHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = currentFiltered[activeIndex];
      if (target) {
        modal.classList.add('hidden');
        target.action();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (modal.classList.contains('hidden')) openModal({ glossary: false });
      else modal.classList.add('hidden');
    } else if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
    }
  });
}

function openAdminSection(accId) {
  showView('admin');
  setTimeout(() => {
    const el = document.getElementById(accId);
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 80);
}

async function sendChatMessage({ text, mediaType = 'text', fileName = '' } = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText || !state.selected) return;
  const sess = selectedSession();
  const isSim = sess ? sess.origin === 'simulation' : state.mode === 'simulation';
  const endpoint = isSim ? '/api/dashboard/simulate' : '/api/dashboard/send';
  const replyPayload = state.replyTo ? { ...state.replyTo } : null;
  clearReplyTo();

  try {
    await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        phone: state.selected,
        text: cleanText,
        replyTo: replyPayload,
        mediaType,
        fileName
      })
    });
    await refresh();
    if (state.view === 'metrics') renderMetrics();
  } catch (err) {
    showToast({ title: 'Falha ao Enviar Mensagem', message: err.message || 'Erro de comunicação', type: 'error' });
  }
}

function startDashboard() {
  showView('overview');
  setupCommandPalette();

  $('#mode-selector').value = state.mode;
  $('#mode-selector').addEventListener('change', () => {
    state.mode = $('#mode-selector').value;
    state.selected = null;
    clearReplyTo();
    refresh();
  });
  syncSoundToggleBtn();
  $('#sound-toggle-btn')?.addEventListener('click', toggleClickSound);
  $('#logout')?.addEventListener('click', async () => {
    const btn = $('#logout');
    setButtonLoading(btn, true, 'Saindo…');
    try {
      await supabase?.auth?.signOut?.().catch(() => {});
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('sb-') || k.includes('supabase')) localStorage.removeItem(k);
      }
    } catch { /* ignore storage errors */ }
    accessToken = '';
    state.initialized = false;
    state.sessions = [];
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    if (state.overviewPollTimer) { clearInterval(state.overviewPollTimer); state.overviewPollTimer = null; }
    setButtonLoading(btn, false);
    showLogin();
    showToast({ title: 'Sessão Encerrada', message: 'Você saiu da conta com segurança.', type: 'info' });
  });

  // Inbox filter tabs
  document.querySelectorAll('.inbox-tab[data-inbox-filter]').forEach(tab => {
    tab.addEventListener('click', () => {
      state.inboxFilter = tab.dataset.inboxFilter || 'all';
      document.querySelectorAll('.inbox-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderList();
    });
  });

  // In-chat search bar controls
  $('#chat-search-toggle')?.addEventListener('click', () => {
    const bar = $('#chat-search-bar');
    if (!bar) return;
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) {
      $('#chat-search-input')?.focus();
    } else {
      state.chatSearchQuery = '';
      if ($('#chat-search-input')) $('#chat-search-input').value = '';
      renderChat({ forceRender: true });
    }
  });
  $('#chat-search-close')?.addEventListener('click', () => {
    $('#chat-search-bar')?.classList.add('hidden');
    state.chatSearchQuery = '';
    if ($('#chat-search-input')) $('#chat-search-input').value = '';
    renderChat({ forceRender: true });
  });
  $('#chat-search-input')?.addEventListener('input', (e) => {
    state.chatSearchQuery = e.target.value;
    renderChat({ forceRender: true });
  });

  // Smart scroll listener & "Ir para o final" button
  $('#messages')?.addEventListener('scroll', updateChatScrollButton, { passive: true });
  $('#chat-scroll-bottom')?.addEventListener('click', () => {
    const messagesEl = $('#messages');
    if (messagesEl) {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      setTimeout(updateChatScrollButton, 260);
    }
  });

  // Chat Header More Options (⋮)
  const openChatHeaderMenu = (e) => {
    e.stopPropagation();
    const sess = selectedSession();
    if (!sess) return;
    const rect = e.currentTarget.getBoundingClientRect();
    openAppleContextMenu({
      x: rect.right - 220,
      y: rect.bottom + 8,
      header: 'Ações da Conversa',
      items: [
        {
          label: 'Buscar nesta conversa',
          shortcut: '⌘F',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
          action: () => $('#chat-search-toggle')?.click()
        },
        {
          label: 'Exportar Transcrição (.txt)',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
          action: () => exportConversationTranscript(sess)
        },
        {
          label: sess.human ? 'Reativar Lia (Automático)' : 'Transferir para Humano',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/></svg>`,
          action: () => setMode(sess.human ? 'bot' : 'human')
        },
        { divider: true },
        {
          label: sess.origin === 'simulation' ? 'Limpar Sessão de Teste' : 'Arquivar Conversa',
          danger: true,
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
          action: () => clearSession()
        }
      ]
    });
  };
  $('#chat-more-menu')?.addEventListener('click', openChatHeaderMenu);
  $('#chat-more-btn')?.addEventListener('click', openChatHeaderMenu);

  // Composer Attach (+) Context Menu
  $('#composer-attach-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openAppleContextMenu({
      x: rect.left,
      y: rect.top - 220,
      header: 'Enviar Mídia / Ação Inteligente',
      items: [
        {
          label: 'Simular Nota de Voz (Áudio PTT)',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>`,
          action: () => document.querySelector('[data-sim-media="audio"]')?.click()
        },
        {
          label: 'Simular Imagem (Visão Computacional)',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
          action: () => document.querySelector('[data-sim-media="image"]')?.click()
        },
        {
          label: 'Simular Documento PDF Analisado',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
          action: () => document.querySelector('[data-sim-media="document"]')?.click()
        },
        { divider: true },
        {
          label: 'Exportar Transcrição da Conversa',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
          action: () => exportConversationTranscript(selectedSession())
        }
      ]
    });
  });

  // Composer Reply Cancel
  $('#reply-bar-cancel')?.addEventListener('click', clearReplyTo);
  $('#composer-reply-cancel')?.addEventListener('click', clearReplyTo);

  // Smart Bar: Media Simulation & Quick Reply Chips
  document.querySelectorAll('[data-sim-media]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      if (!state.selected) {
        showToast({ title: 'Selecione uma Conversa', message: 'Abra uma conversa ou inicie uma simulação primeiro.', type: 'warn' });
        return;
      }
      const kind = chip.dataset.simMedia;
      if (kind === 'audio') {
        await sendChatMessage({
          text: '[Áudio]: "Olá Lia, pode me explicar como funcionam os horários de agendamento e valores?"',
          mediaType: 'audio'
        });
      } else if (kind === 'image') {
        await sendChatMessage({
          text: '[Foto enviada: comprovante_pagamento.jpg] Segue a imagem do documento solicitado para análise.',
          mediaType: 'image'
        });
      } else if (kind === 'document') {
        await sendChatMessage({
          text: '[Documento contrato_prestacao.pdf analisado]: Solicito revisão das cláusulas de prazo e agendamento.',
          mediaType: 'document',
          fileName: 'contrato_prestacao.pdf'
        });
      }
    });
  });

  document.querySelectorAll('[data-quick-reply]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = $('#message-input');
      if (!input) return;
      input.value = chip.dataset.quickReply || '';
      input.focus();
    });
  });

  // Mobile Inbox & Context Drawer controls
  $('#chat-mobile-back')?.addEventListener('click', () => {
    $('#inbox-grid')?.classList.remove('mobile-chat-open');
  });
  $('#chat-context-toggle')?.addEventListener('click', () => {
    const grid = $('#inbox-grid');
    if (!grid) return;
    if (window.innerWidth <= 1120) {
      grid.classList.toggle('mobile-context-open');
    } else {
      grid.classList.toggle('context-collapsed');
    }
  });
  $('#detail-close-mobile')?.addEventListener('click', () => {
    $('#inbox-grid')?.classList.remove('mobile-context-open');
  });

  $('#composer')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text || !state.selected) return;
    input.value = '';
    await sendChatMessage({ text });
  });
  $('#search')?.addEventListener('input', renderList);

  const triggerRefreshWithIcon = async (btn) => {
    if (btn) btn.classList.add('spinning');
    try {
      await refresh();
      if (state.view === 'overview') await renderOverview();
      if (state.view === 'integrations') await renderIntegrations();
      showToast({ title: 'Dados Sincronizados', message: 'Sessões e indicadores atualizados em tempo real.', type: 'info', duration: 2400 });
    } finally {
      if (btn) setTimeout(() => btn.classList.remove('spinning'), 600);
    }
  };
  $('#refresh')?.addEventListener('click', () => triggerRefreshWithIcon($('#refresh')));
  $('#refresh-overview')?.addEventListener('click', () => renderOverview());
  $('#overview-go-config')?.addEventListener('click', () => showView('admin'));
  $('#overview-open-router-test')?.addEventListener('click', () => showView('agent'));
  $('#overview-ping-quick')?.addEventListener('click', () => {
    showView('metrics');
    setTimeout(() => $('#btn-ping-ai')?.click(), 120);
  });

  // Agent & Router Test controls
  $('#agent-refresh-btn')?.addEventListener('click', () => renderAgent({ force: true }));
  $('#router-test-btn')?.addEventListener('click', runRouterTest);
  $('#router-test-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runRouterTest(); } });
  $('#router-test-doc')?.addEventListener('change', runRouterTest);
  $('#router-test-owner')?.addEventListener('change', runRouterTest);

  // Tools controls
  $('#tools-refresh')?.addEventListener('click', renderTools);
  $('#tools-save')?.addEventListener('click', async () => {
    try {
      const result = await saveToolsDraft();
      opsFeedback('tools-feedback', `Rascunho salvo (revisão v${result.revision}). Clique em "Salvar & Publicar Agora" para ativar no runtime.`, 'success');
      await renderTools();
    } catch (error) { opsFeedback('tools-feedback', `Não foi possível salvar: ${error.message}`, 'error'); }
  });
  $('#tools-publish')?.addEventListener('click', async () => {
    try {
      await saveToolsDraft();
      await publishAdminChanges();
      opsFeedback('tools-feedback', `Ferramentas e busca web publicadas e ativas no motor!`, 'success');
      await renderTools();
    } catch (error) { opsFeedback('tools-feedback', `Não foi possível publicar: ${error.message}`, 'error'); }
  });
  $('#tools-enable-all')?.addEventListener('click', () => {
    document.querySelectorAll('.tool-toggle').forEach(el => { if (!el.disabled) el.checked = true; });
    showToast({ title: 'Ferramentas Selecionadas', message: 'Todas as ferramentas foram marcadas. Salve ou publique para aplicar.', type: 'info' });
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

  // Metrics Tariffs & Default Loader (CSP-safe stopPropagation inside <summary>)
  $('#metrics-fill-defaults')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const defaultRates = [
      { provider: 'gemini', model: 'gemini-3.8-flash', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40 },
      { provider: 'gemini', model: 'gemini-2.5-flash', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
      { provider: 'gemini', model: 'gemini-2.5-pro', inputUsdPerMillion: 1.25, outputUsdPerMillion: 5.00 },
      { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    ];
    const defaultBudgets = [
      { provider: 'gemini', model: '', amountUsd: 25 }
    ];
    if ($('#metrics-pricing-rates')) $('#metrics-pricing-rates').value = JSON.stringify(defaultRates, null, 2);
    if ($('#metrics-monthly-budgets') && !$('#metrics-monthly-budgets').value.trim()) {
      $('#metrics-monthly-budgets').value = JSON.stringify(defaultBudgets, null, 2);
    }
    const acc = $('#metrics-tariffs-accordion');
    if (acc) acc.open = true;
    opsFeedback('metrics-rates-feedback', 'Tarifas sugeridas preenchidas. Clique em "Salvar no Rascunho" e depois publique.', 'success');
  });

  $('#metrics-rates-save')?.addEventListener('click', async (e) => {
    e.stopPropagation();
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
      updateSectionDiffBadges();
      opsFeedback('metrics-rates-feedback', 'Tarifas e limites salvos no rascunho. Publique para que passem a valer.', 'success');
      await renderMetrics();
    } catch (error) { opsFeedback('metrics-rates-feedback', `Não foi possível salvar: ${error.message}`, 'error'); }
  });

  $('#overview-open-simulation')?.addEventListener('click', () => {
    state.mode = 'simulation';
    $('#mode-selector').value = 'simulation';
    $('#mode-selector').dispatchEvent(new Event('change', { bubbles: true }));
    showView('inbox');
    $('#new-sim')?.click();
  });

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

  // Collapsible Settings Accordion Toolbar
  $('#admin-expand-all')?.addEventListener('click', () => {
    document.querySelectorAll('#admin-accordion-stack .config-accordion').forEach(acc => { acc.open = true; });
  });
  $('#admin-collapse-all')?.addEventListener('click', () => {
    document.querySelectorAll('#admin-accordion-stack .config-accordion').forEach(acc => { acc.open = false; });
  });
  document.querySelectorAll('[data-open-acc]').forEach(chip => {
    chip.addEventListener('click', () => {
      const target = document.getElementById(chip.dataset.openAcc);
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  $('#admin-search-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#admin-accordion-stack .config-accordion').forEach(acc => {
      if (!q) {
        acc.classList.remove('hidden');
        return;
      }
      const text = acc.textContent.toLowerCase();
      const inputs = [...acc.querySelectorAll('input, textarea, select')].map(i => `${i.value} ${i.placeholder || ''} ${i.dataset.config || ''}`).join(' ').toLowerCase();
      const matched = text.includes(q) || inputs.includes(q);
      acc.classList.toggle('hidden', !matched);
      if (matched) acc.open = true;
    });
  });

  // Settings form listeners
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
    if (primary) {
      primary.value = '';
      primary.classList.remove('hidden');
    }
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

  $('#admin-publish')?.addEventListener('click', publishAdminChanges);
  $('#global-publish-btn')?.addEventListener('click', publishAdminChanges);

  $('#admin-reset-draft')?.addEventListener('click', async () => {
    if (!state.adminConfig || !window.confirm('Descartar o rascunho e voltar à versão publicada?')) return;
    state.adminConfig.draft = JSON.parse(JSON.stringify(state.adminConfig.active));
    renderAdmin({ force: true });
    await saveAdminDraft(true);
    adminFeedback('Rascunho restaurado para a versão publicada.', 'success');
  });

  $('#admin-history-list')?.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-rollback-rev]');
    if (!btn) return;
    const rev = Number(btn.dataset.rollbackRev);
    if (!window.confirm(`Restaurar e publicar imediatamente a revisão v${rev}?`)) return;
    btn.disabled = true;
    try {
      const result = await api('/api/admin/config/rollback', { method: 'POST', body: JSON.stringify({ revision: rev }) });
      if (!result.ok) throw new Error((result.errors || []).join(' '));
      state.adminConfig = result.snapshot;
      renderAdmin({ force: true });
      adminFeedback(`Rollback concluído! Versão restaurada e publicada como v${result.snapshot.revision}.`, 'success');
    } catch (error) {
      adminFeedback(`Falha no rollback: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#admin-add-faq')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.adminConfig) return;
    adminReadForm();
    state.adminConfig.draft.knowledge.faq.push({ keys: ['nova pergunta'], answer: 'Escreva aqui a resposta aprovada pela equipe.', enabled: true });
    const faqAcc = $('#acc-faq');
    if (faqAcc) faqAcc.open = true;
    renderAdmin({ force: true });
    queueAdminSave();
    showToast({ title: 'Pergunta FAQ Adicionada', message: 'Preencha as palavras-chave e a resposta padrão.', type: 'info' });
  });
  $('#admin-faq-list')?.addEventListener('input', queueAdminSave);
  $('#admin-faq-list')?.addEventListener('change', queueAdminSave);
  $('#admin-faq-list')?.addEventListener('click', event => {
    const button = event.target.closest('[data-faq-remove]');
    if (!button || !state.adminConfig) return;
    adminReadForm();
    state.adminConfig.draft.knowledge.faq.splice(Number(button.dataset.faqRemove), 1);
    renderAdmin({ force: true });
    queueAdminSave();
  });

  $('#admin-preview-run')?.addEventListener('click', async () => {
    const button = $('#admin-preview-run');
    const resultBox = $('#admin-preview-result');
    const phoneInput = $('#admin-preview-phone');
    const testPhone = phoneInput.value.trim() || `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
    if (!phoneInput.value.trim()) phoneInput.value = testPhone;
    try {
      await saveAdminDraft();
      button.disabled = true;
      button.textContent = 'Simulando…';
      resultBox.classList.remove('hidden');
      resultBox.className = 'admin-preview-result loading';
      resultBox.textContent = 'Executando o rascunho em uma sessão isolada com a IA…';
      const result = await api('/api/admin/config/preview', {
        method: 'POST',
        body: JSON.stringify({ phone: testPhone, text: $('#admin-preview-text').value.trim() })
      });
      resultBox.className = 'admin-preview-result success';
      resultBox.innerHTML = `<div class="preview-result-head"><strong>Resposta simulada da IA (Tel: ${esc(testPhone)})</strong><span>rascunho base v${esc(result.revision)}</span></div><p style="white-space:pre-wrap;margin:6px 0;">${esc(result.answer || 'O fluxo não gerou resposta para esta mensagem.')}</p><small class="ops-muted">Esta execução ocorreu em memória temporária e não enviou mensagens reais.</small>`;
      showToast({ title: 'Preview Executado', message: 'Resposta gerada em sessão isolada.', type: 'success', duration: 2800 });
    } catch (error) {
      resultBox.classList.remove('hidden');
      resultBox.className = 'admin-preview-result error';
      resultBox.textContent = error.message || 'Não foi possível executar o preview.';
      showToast({ title: 'Falha no Preview', message: error.message, type: 'error' });
    } finally {
      button.disabled = false;
      button.textContent = 'Simular Resposta';
    }
  });

  const openNewSimModal = () => {
    const existing = document.querySelector('.sim-modal-overlay');
    if (existing) existing.remove();
    const defaultPhone = '55119' + Math.floor(10000000 + Math.random() * 90000000);
    const modal = document.createElement('div');
    modal.className = 'sim-modal-overlay';
    modal.innerHTML = `
      <div class="sim-modal-card">
        <h3>Nova Simulação Isolada</h3>
        <p class="ops-muted" style="margin-bottom:14px;">Inicie uma sessão de teste para validar prompts, ferramentas e multimídia sem acionar o WhatsApp real.</p>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:6px;">Identificador Numérico da Sessão</label>
        <input id="modal-sim-phone" type="text" value="${defaultPhone}" inputmode="numeric" />
        <div class="sim-modal-actions">
          <button type="button" class="sim-modal-cancel">Cancelar</button>
          <button type="button" class="sim-modal-confirm btn-primary">Iniciar Simulação</button>
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
      state.mode = 'simulation';
      $('#mode-selector').value = 'simulation';
      $('#mode-selector').dispatchEvent(new Event('change', { bubbles: true }));
      showView('inbox');
      try {
        await api('/api/dashboard/simulate', {
          method: 'POST',
          body: JSON.stringify({ phone, text: 'Olá, gostaria de conhecer o atendimento.' })
        });
        state.selected = `sim:${phone.replace(/^sim:/, '')}`;
        $('#inbox-grid')?.classList.add('mobile-chat-open');
        await refresh();
        showToast({ title: 'Simulação Iniciada', message: `Sessão isolada ${phone} pronta para testes.`, type: 'success' });
      } catch (err) {
        showToast({ title: 'Erro na Simulação', message: err.message, type: 'error' });
      }
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
    btn.textContent = 'Testando latência…';
    banner.classList.add('hidden');
    try {
      const res = await api('/api/dashboard/ping-ai', { method: 'POST', body: JSON.stringify(body) });
      banner.classList.remove('hidden');
      if (res.ok) {
        banner.className = 'ping-banner success';
        banner.innerHTML = `<strong>Conexão bem-sucedida!</strong> Provedor: <b>${esc(res.provider)}</b> | Modelo: <b>${esc(
          res.model
        )}</b> | Latência real: <b>${res.latencyMs} ms</b> | Tokens: <b>${res.tokens?.totalTokens || 0}</b>`;
        showToast({ title: 'Ping IA Bem-Sucedido', message: `${res.provider.toUpperCase()} (${res.model}) respondeu em ${res.latencyMs} ms.`, type: 'success' });
      } else {
        banner.className = 'ping-banner error';
        banner.innerHTML = `<strong>Falha no teste:</strong> Provedor <b>${esc(res.provider)}</b> (${esc(
          res.model || selectVal || 'modelo padrão'
        )}) retornou erro: ${esc(res.error || 'sem resposta')}`;
        showToast({ title: 'Falha no Ping IA', message: res.error || 'Sem resposta do provedor', type: 'error' });
      }
      await renderMetrics();
    } catch (e) {
      banner.classList.remove('hidden');
      banner.className = 'ping-banner error';
      banner.innerHTML = `Erro ao testar conectividade: ${esc(e.message)}`;
      showToast({ title: 'Erro de Conectividade', message: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Testar Latência (Ping)';
    }
  };

  $('#btn-ping-ai')?.addEventListener('click', handlePing);
  $('#metrics-ping-btn')?.addEventListener('click', handlePing);

  $('#btn-refresh-metrics')?.addEventListener('click', () => renderMetrics());
  $('#btn-reset-metrics')?.addEventListener('click', async () => {
    if (!window.confirm('Deseja zerar as métricas de latência e consumo em memória desta instância?')) return;
    await api('/api/dashboard/metrics/reset', { method: 'POST' });
    showToast({ title: 'Métricas em Memória Zeradas', message: 'Contadores locais foram reiniciados.', type: 'info' });
    await renderMetrics();
  });

  $('#metrics-refresh-rate')?.addEventListener('change', (e) => {
    const ms = Number(e.target.value);
    if (state.metricsTimer) {
      clearInterval(state.metricsTimer);
      state.metricsTimer = null;
    }
    if (ms > 0) {
      if (state.view === 'metrics' && !document.hidden) renderMetrics();
      state.metricsTimer = setInterval(() => {
        if (state.view === 'metrics' && !document.hidden) renderMetrics();
      }, ms);
    }
  });

  state.metricsTimer = setInterval(() => {
    if (state.view === 'metrics' && !document.hidden) renderMetrics();
  }, 15000);
  state.sessionTimer = setInterval(() => {
    if (!document.hidden) syncSession().catch(() => {});
  }, 30000);

  document.querySelectorAll('.nav-item, .mob-nav-btn').forEach((item) =>
    item.addEventListener('click', () => showView(item.dataset.view))
  );

  // Audition de Voz Neural no painel de configurações
  $('#btn-test-voice')?.addEventListener('click', async () => {
    const btn = $('#btn-test-voice');
    const select = $('#admin-voice-select');
    const chosenVoice = select?.value || state.draft?.voice?.voiceName || 'pt-BR-FranciscaNeural';
    const statusText = $('#voice-engine-status-text');
    if (btn) btn.disabled = true;
    if (statusText) statusText.textContent = `Sintetizando amostra com a voz ${chosenVoice}...`;

    showToast({ title: 'Audition Neural', message: `Testando voz ${chosenVoice}...`, type: 'info' });

    await playNeuralAudio('Olá! Eu sou a Lia, assistente virtual da Atualyze. Como posso ajudar você hoje?', {
      voiceName: chosenVoice,
      onStart: (info) => {
        if (info?.isFallback) {
          if (statusText) statusText.textContent = `Motor neural do servidor indisponível (${info?.error || 'fallback'}); reproduzindo voz padrão do navegador.`;
          showToast({ title: 'Fallback do Navegador', message: 'Motor neural do servidor indisponível. A voz padrão do navegador foi usada.', type: 'warning' });
          return;
        }
        const activeVoice = info?.voiceName || chosenVoice;
        if (statusText) statusText.textContent = `Reproduzindo com motor ${info?.engine || 'neural'} (${activeVoice}).`;
        showToast({ title: 'Voz Neural em Execução', message: `Voz: ${activeVoice} · Motor: ${info?.engine || 'neural'}`, type: 'success' });
      },
      onEnd: () => {
        if (btn) btn.disabled = false;
        if (statusText) statusText.textContent = 'Ouvir áudio gerado pelo motor neural do servidor com a voz selecionada.';
      },
      onError: (err) => {
        if (btn) btn.disabled = false;
        if (statusText) statusText.textContent = 'Falha ao sintetizar áudio no servidor.';
        showToast({ title: 'Erro de Síntese', message: err?.message || 'Falha ao sintetizar', type: 'error' });
      }
    });
  });

  api('/api/dashboard/session').then(async session => {
    state.role = ROLE_LEVEL[session.role] === undefined ? 'viewer' : session.role;
    applyRoleVisibility();
    if (state.role === 'admin') {
      api('/api/admin/config').then(snap => {
        state.adminConfig = snap;
        updateSectionDiffBadges();
        updateSidebarConnection();
      }).catch(() => {});
    }
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) {
      try {
        await refresh();
        state.refreshTimer = setInterval(() => { if (!document.hidden) refresh({ background: true }).catch(() => {}); }, 5000);
      } catch (error) {
        $('#conversation-items').innerHTML = `<div class="detail-placeholder" style="padding:18px">Não foi possível carregar o dashboard.<br>${esc(error.message)}</div>`;
        showToast({ title: 'Erro ao Carregar Conversas', message: error.message, type: 'error' });
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
    refresh({ background: true }).catch(() => {});
    state.refreshTimer = setInterval(() => {
      if (!document.hidden) refresh({ background: true }).catch(() => {});
    }, 5000);
  }
});

// Collapsible Sidebar & Mobile Drawer Controller
(() => {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const closeMobileBtn = document.getElementById('sidebar-close-mobile');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar || !toggleBtn) return;

  const STORAGE_KEY = 'lia_sidebar_collapsed';
  const applyState = (collapsed) => {
    sidebar.classList.toggle('collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  };

  if (window.innerWidth > 768 && localStorage.getItem(STORAGE_KEY) === '1') {
    applyState(true);
  }

  const closeMobile = () => {
    sidebar.classList.remove('mobile-open');
    backdrop?.classList.add('hidden');
  };

  toggleBtn.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      const nextOpen = !sidebar.classList.contains('mobile-open');
      sidebar.classList.toggle('mobile-open', nextOpen);
      backdrop?.classList.toggle('hidden', !nextOpen);
      return;
    }
    const next = !sidebar.classList.contains('collapsed');
    applyState(next);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  });

  closeMobileBtn?.addEventListener('click', closeMobile);
  backdrop?.addEventListener('click', closeMobile);
})();

// Segmented Control sync with #mode-selector
(() => {
  const select = document.getElementById('mode-selector');
  const buttons = document.querySelectorAll('.segmented-control .segment-btn');
  if (!select || !buttons.length) return;

  const syncButtons = () => {
    buttons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === select.value);
    });
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (select.value !== btn.dataset.mode) {
        select.value = btn.dataset.mode;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncButtons();
    });
  });

  select.addEventListener('change', syncButtons);
  syncButtons();
})();
