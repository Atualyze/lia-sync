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
  vpsTimer: null,
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
    '.integrations-table td strong', '.integrations-table .integrations-detail', '.tool-meta'
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
  if (!e.target.closest('#chat-smart-bar') && !e.target.closest('#composer-attach-btn')) {
    closeComposerAttachPanel();
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
    closeComposerAttachPanel();
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

  if (integ?.evolution) {
    const ev = integ.evolution;
    const isOk = ev.connected || ev.status === 'connected';
    if (waDot) waDot.className = `status-dot ${isOk ? '' : ev.configured ? 'warn' : 'err'}`;
    if (waPill) {
      waPill.textContent = isOk ? 'Conectado' : ev.status === 'not_configured' ? 'Não config.' : ev.status;
      waPill.className = `pill mini ${isOk ? 'mint' : 'amber'}`;
    }
    if (waMeta) {
      waMeta.textContent = ev.isBaileysNative
        ? `Baileys Nativo · ${ev.instance || '-'}`
        : ev.instance === 'manychat' || ev.provider === 'manychat'
          ? 'ManyChat · API Oficial'
          : ev.instance === 'ghl' || ev.provider === 'ghl'
            ? 'GoHighLevel · API Oficial'
            : `Instância: ${ev.instance || '-'}${ev.latencyMs != null ? ` · ${ev.latencyMs}ms` : ''}`;
    }
  } else if (hlth?.readiness?.checks) {
    const evCheck = hlth.readiness.checks.find(c => c.name === 'whatsapp' || c.name === 'evolution');
    const isOk = evCheck?.status === 'ready' || evCheck?.status === 'ok';
    if (waDot) waDot.className = `status-dot ${isOk ? '' : 'warn'}`;
    if (waPill) {
      waPill.textContent = isOk ? 'Online' : (evCheck?.status || 'verificando');
      waPill.className = `pill mini ${isOk ? 'mint' : 'amber'}`;
    }
    if (waMeta) {
      waMeta.textContent = evCheck?.name === 'whatsapp'
        ? `WhatsApp · Baileys Nativo`
        : `Instância: ${hlth.system?.instance || '-'} · Evolution API`;
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
  const shell = $('#dashboard-shell');
  const mobileNav = $('#mobile-bottom-nav');
  shell?.classList.add('hidden');
  shell?.setAttribute('aria-hidden', 'true');
  mobileNav?.classList.add('hidden');
  mobileNav?.setAttribute('aria-hidden', 'true');
  setupLoginModifierDetection();
  checkLoginLockout();
}
function showDashboard() {
  $('#login-screen').classList.add('hidden');
  const shell = $('#dashboard-shell');
  const mobileNav = $('#mobile-bottom-nav');
  shell?.classList.remove('hidden');
  shell?.setAttribute('aria-hidden', 'false');
  mobileNav?.classList.remove('hidden');
  mobileNav?.setAttribute('aria-hidden', 'false');
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
      body: JSON.stringify({ text: clean, voiceName: voiceName || state.adminConfig?.draft?.voice?.voiceName || state.draft?.voice?.voiceName })
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

function closeComposerAttachPanel() {
  const panel = $('#chat-smart-bar');
  const btn = $('#composer-attach-btn');
  panel?.classList.add('hidden');
  btn?.classList.remove('open');
  btn?.setAttribute('aria-expanded', 'false');
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

const avatarCache = new Map();
const avatarInFlight = new Set();

function isAvatarEligiblePhone(phone = '') {
  const p = String(phone || '').trim();
  return Boolean(p && p !== 'owner_self' && !/^[a-z0-9_]+_self$/i.test(p) && !p.startsWith('sim:'));
}

function applyAvatarToElements(phone, url) {
  if (!url) return;
  document.querySelectorAll(`[data-avatar-phone="${CSS.escape(phone)}"]`).forEach((el) => {
    if (!el.querySelector('img.avatar-img')) {
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.alt = '';
      img.src = url;
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
  });
}

async function ensureContactAvatar(phone) {
  if (!isAvatarEligiblePhone(phone)) return;
  if (avatarCache.has(phone)) {
    const cached = avatarCache.get(phone);
    if (cached) applyAvatarToElements(phone, cached);
    return;
  }
  if (avatarInFlight.has(phone)) return;
  avatarInFlight.add(phone);
  try {
    const headers = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const res = await fetch(`/api/dashboard/avatar?phone=${encodeURIComponent(phone)}`, { headers });
    if (res.status === 200) {
      const blob = await res.blob();
      if (blob && blob.size > 0 && blob.type.startsWith('image/')) {
        const url = URL.createObjectURL(blob);
        avatarCache.set(phone, url);
        applyAvatarToElements(phone, url);
        return;
      }
    }
    avatarCache.set(phone, null);
  } catch {
    avatarCache.set(phone, null);
  } finally {
    avatarInFlight.delete(phone);
  }
}

function avatarHtml(phone, fallbackName) {
  const init = esc(initials(fallbackName));
  if (!isAvatarEligiblePhone(phone)) {
    return `<div class="contact-avatar">${init}</div>`;
  }
  const cached = avatarCache.get(phone);
  const imgTag = cached ? `<img class="avatar-img" src="${cached}" alt="" onerror="this.remove()" />` : '';
  return `<div class="contact-avatar" data-avatar-phone="${esc(phone)}">${init}${imgTag}</div>`;
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
      const originTag = item.origin === 'simulation' ? '<span class="ops-inline-sep">· Simulador</span>' : '';

      return `<div class="conversation ${isSelected}" data-phone="${esc(item.phone)}">
        ${avatarHtml(item.phone, titleName)}
        <div class="conversation-body">
          <div class="conversation-top"><strong title="${titleName}">${titleName}</strong><time>${timeLabel}</time></div>
          <div class="conversation-phone-tag">${phoneLabel}${originTag}</div>
          <p>${mediaIcon}${previewText}</p>
          <span class="mode-mini ${statusClass}">${statusLabel}</span>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.conversation').forEach((el) => {
    void ensureContactAvatar(el.dataset.phone);
    el.addEventListener('click', () => {
      state.selected = el.dataset.phone;
      clearReplyTo();
      const grid = $('#inbox-grid');
      if (grid) {
        grid.classList.add('mobile-chat-open');
        grid.classList.remove('mobile-context-open');
      }
      const ctxBtn = $('#chat-context-toggle');
      if (ctxBtn && window.innerWidth <= 1120) {
        ctxBtn.classList.remove('active');
        ctxBtn.setAttribute('aria-expanded', 'false');
      }
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
  syncFinishButton();
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

  const chatAvatarEl = $('#chat-avatar');
  if (chatAvatarEl) {
    chatAvatarEl.textContent = initials(dName);
    if (isAvatarEligiblePhone(session.phone)) {
      chatAvatarEl.setAttribute('data-avatar-phone', session.phone);
      void ensureContactAvatar(session.phone);
    } else {
      chatAvatarEl.removeAttribute('data-avatar-phone');
    }
  }
  $('#chat-name').textContent = dName;
  const phoneLink = $('#chat-phone-link');
  if (phoneLink) phoneLink.href = cleanNum ? `https://wa.me/${cleanNum}` : '#';
  $('#chat-phone').textContent = fPhone;

  const pendingOptimistic = state.pendingOutboundByPhone?.get(session.phone) || [];
  const rawHistory = [...(session.history || []), ...pendingOptimistic];
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
  const chatSig = `${session.phone}::${rawHistory.length}::${pendingOptimistic.length}::${lastMsgStamp}::${searchQ}::${session.human}`;
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
    : 'Digite uma mensagem de teste ou use o botão +…';

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
        ${avatarHtml(session.phone, dName)}
        <div>
          <strong>${esc(dName)}</strong>
          <span style="display:block;font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);">${esc(fPhone)}</span>
          ${cleanNum ? `<a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" class="detail-wa-link"><span>Abrir no WhatsApp</span><svg class="svg-icon xs" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></a>` : ''}
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
    <div class="detail-actions">
      <button type="button" class="detail-action primary" id="toggle-mode">${session.human ? 'Reativar Lia (Bot)' : 'Transferir para Humano'}</button>
      <button type="button" class="detail-action danger" id="clear-session">${session.origin === 'simulation' ? 'Limpar Sessão de Teste' : 'Arquivar Conversa'}</button>
    </div>
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
        const roleTag = isPrimary
          ? '<span class="inline-role-tag is-primary">Principal</span>'
          : isFallback
          ? '<span class="inline-role-tag is-fallback">Fallback</span>'
          : '<span class="inline-role-tag is-demand">Sob demanda</span>';
        const caps = (meta.capabilities || []).map(c => `<span class="cap-chip">${esc(c)}</span>`).join('');
        return `<tr>
          <td><strong>${esc(modelId)}</strong></td>
          <td>${esc((meta.provider || 'gemini').toUpperCase())}</td>
          <td>${caps}</td>
          <td><code>${Number(meta.thinkingBudget || 0)} tokens</code></td>
          <td>${roleTag}</td>
        </tr>`;
      }).join('');
    }

    const modContainer = $('#agent-modules-container');
    if (modContainer) {
      const groups = [
        ['capabilities', 'Capacidades & Execução'],
        ['knowledge', 'Conhecimento & Regras'],
        ['controls', 'Controles & Segurança']
      ];
      modContainer.innerHTML = groups.map(([groupKey, groupTitle]) => {
        const items = Object.entries(data[groupKey] || {});
        if (!items.length) return '';
        return `<section class="panel ops-section">
          <div class="panel-head"><div><strong>${esc(groupTitle)}</strong><span>Clique em um módulo para ver os detalhes</span></div></div>
          <div class="ops-list">
            ${items.map(([topicKey, item]) => `
              <button type="button" class="ops-row agent-card-item" data-topic="${esc(topicKey)}">
                <div class="agent-card-copy">
                  <strong>${esc(item.title || topicKey)}</strong>
                  <div class="ops-muted">${esc(item.description || '')}</div>
                </div>
                <span class="row-inspect-link">
                  <span>Inspecionar</span>
                  <svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </span>
              </button>
            `).join('')}
          </div>
        </section>`;
      }).join('');
      modContainer.querySelectorAll('.agent-card-item[data-topic]').forEach((card) => {
        card.onclick = () => renderAgentDrawer(card.dataset.topic);
      });
    }

  } catch (error) {
    const modContainer = $('#agent-modules-container');
    if (modContainer) modContainer.innerHTML = `<div class="panel">Não foi possível carregar a arquitetura do agente: ${esc(error.message)}</div>`;
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
            <td>${item.tokenUsageKnown === false ? '<span class="ops-muted">tokens desconhecidos</span>' : `<span class="ops-muted">Ent. ${item.promptTokens || 0} · Saí. ${item.completionTokens || 0}</span> <b>(${item.totalTokens || 0})</b>`}</td>
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
            <strong>${esc(prov.toUpperCase())}${isCurrent ? ' <span class="ops-inline-accent">· em uso</span>' : ''}</strong>
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
            <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);">${fPhone}</span>
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
          ${cleanNum ? `<a href="https://wa.me/${cleanNum}" target="_blank" rel="noopener" class="btn-handoff wa"><span>WhatsApp</span><svg class="svg-icon xs" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></a>` : ''}
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
  for (const selector of ['#admin-publish', '#global-publish-btn']) {
    const button = $(selector);
    if (button) {
      button.disabled = !hasAnyDiff;
      button.title = hasAnyDiff ? 'Publicar alterações do rascunho' : 'Não há alterações para publicar';
    }
  }
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
  if (draft.voice && (!['Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir'].includes(draft.voice.voiceName))) {
    draft.voice.voiceName = 'Aoede';
    if (!state.adminFormDirty && state.adminConfig?.draft?.voice) state.adminConfig.draft.voice.voiceName = 'Aoede';
  }
  // O autosave chama renderAdmin() enquanto o usuário digita: não sobrescreve o
  // campo focado (o valor dele já foi lido para o rascunho) e preserva a seleção,
  // senão o cursor salta para o fim a cada pausa. Cargas explícitas (force) e
  // publish/discard continuam reescrevendo todos os campos.
  const focusedInput = document.activeElement;
  const preserveFocus = !force && Boolean(focusedInput) && focusedInput.matches?.('[data-config]');
  const savedSelection = preserveFocus && typeof focusedInput.selectionStart === 'number'
    ? { start: focusedInput.selectionStart, end: focusedInput.selectionEnd, direction: focusedInput.selectionDirection || 'none' }
    : null;
  document.querySelectorAll('[data-config]').forEach(input => {
    if (preserveFocus && input === focusedInput) return;
    const value = adminGet(draft, input.dataset.config);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (input.dataset.config === 'identity.aliases') input.value = Array.isArray(value) ? value.join(', ') : (value ?? '');
    else input.value = value ?? '';
  });
  if (savedSelection && document.activeElement === focusedInput) {
    try {
      focusedInput.setSelectionRange(savedSelection.start, savedSelection.end, savedSelection.direction);
    } catch {
      // inputs sem suporte a seleção (number, email, date) — nada a restaurar
    }
  }
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

const BUILTIN_PROVIDER_LABELS = {
  gemini: 'Google Gemini',
  groq: 'Groq Cloud',
  nvidia: 'NVIDIA NIM',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  openai: 'OpenAI (ChatGPT)',
  qwen: 'Qwen (Alibaba)'
};

function getProviderDisplayLabel(id, info = null) {
  const key = String(id || '').toLowerCase();
  if (info?.name) return info.name;
  return BUILTIN_PROVIDER_LABELS[key] || key.toUpperCase();
}

function getSelectableProviders(extraIds = []) {
  const map = state.configuredProvidersMap;
  const fallbackAll = Object.entries(BUILTIN_PROVIDER_LABELS);
  if (!map || typeof map !== 'object' || !Object.keys(map).length) {
    return fallbackAll;
  }
  const configured = Object.entries(map)
    .filter(([, info]) => info && info.configured === true)
    .map(([id, info]) => [id, getProviderDisplayLabel(id, info)]);

  const result = configured.length ? [...configured] : [...fallbackAll];
  const seen = new Set(result.map(([id]) => id));
  for (const extra of extraIds) {
    const id = String(extra || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    const info = map[id];
    const suffix = info && info.configured === false ? ' (sem chave)' : '';
    result.push([id, `${getProviderDisplayLabel(id, info)}${suffix}`]);
    seen.add(id);
  }
  return result;
}

function syncPrimaryProviderSelect() {
  const select = $('#admin-ai-provider');
  if (!select) return;
  const current = String(select.value || state.adminConfig?.draft?.ai?.activeProvider || 'gemini').trim().toLowerCase();
  const options = getSelectableProviders(current ? [current] : []);
  select.innerHTML = options
    .map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`)
    .join('');
  if (current && options.some(([id]) => id === current)) {
    select.value = current;
  } else if (options.length) {
    select.value = options[0][0];
  }
}

async function refreshConfiguredProviders({ reloadCatalogs = false } = {}) {
  try {
    const data = await api('/api/dashboard/models');
    if (data?.providers && typeof data.providers === 'object') {
      state.configuredProvidersMap = data.providers;
    }
  } catch {}
  syncPrimaryProviderSelect();
  if (reloadCatalogs) {
    await loadProviderModels({ refresh: true });
    await loadFallbackCatalogs({ forceRefreshList: false });
  } else {
    renderFallbackRows();
  }
}

function fallbackEntry(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/^([a-z][a-z0-9_-]{1,31}):(.*)$/i);
  if (match) return { provider: match[1].toLowerCase(), model: match[2].trim() };
  const selectable = getSelectableProviders();
  const defaultProv = selectable[0]?.[0] || 'openrouter';
  return { provider: defaultProv, model: raw };
}
function populateFallbackModelSelect(select, provider, selectedModel = '') {
  if (!select) return;
  const models = state.fallbackCatalogs[provider] || [];
  const options = models.map(model => `<option value="${esc(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${esc(model.name || model.id)} · ${esc(model.id)}</option>`).join('');
  const extra = selectedModel && !models.some(model => model.id === selectedModel)
    ? `<option value="${esc(selectedModel)}" selected>${esc(selectedModel)} (salvo)</option>`
    : '';
  select.innerHTML = `<option value="">Nenhum modelo selecionado</option>${options}${extra}`;
  if (selectedModel) select.value = selectedModel;
}
function renderFallbackRows() {
  const container = $('#admin-fallback-rows');
  if (!container || state.adminFormDirty || container.contains(document.activeElement)) return;
  const values = Array.isArray(state.adminConfig?.draft?.ai?.fallbackModels) ? state.adminConfig.draft.ai.fallbackModels.slice(0, 3) : [];
  const savedProviders = values.map(v => fallbackEntry(v).provider).filter(Boolean);
  const selectableProviders = getSelectableProviders(savedProviders);
  container.innerHTML = [0, 1, 2].map(index => {
    const selected = fallbackEntry(values[index] || '');
    return `<div class="fallback-row-card">
      <span class="fallback-slot-title">Reserva #${index + 1}</span>
      <select class="admin-fallback-provider" data-index="${index}">${selectableProviders.map(([id, name]) => `<option value="${esc(id)}" ${id === selected.provider ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>
      <select class="admin-fallback-model" data-index="${index}"></select>
    </div>`;
  }).join('');
  [0, 1, 2].forEach(index => {
    const selected = fallbackEntry(values[index] || '');
    const modelSelect = container.querySelector(`.admin-fallback-model[data-index="${index}"]`);
    populateFallbackModelSelect(modelSelect, selected.provider, selected.model);
  });
  container.querySelectorAll('.admin-fallback-provider').forEach(select => select.addEventListener('change', async event => {
    const index = event.target.dataset.index;
    const provider = event.target.value;
    const modelSelect = container.querySelector(`.admin-fallback-model[data-index="${index}"]`);
    state.adminFormDirty = true;
    state.adminChangeVersion += 1;
    clearTimeout(state.adminSaveTimer);
    if (modelSelect) modelSelect.innerHTML = '<option value="">Carregando modelos...</option>';
    await loadFallbackCatalog(provider, { refresh: true });
    populateFallbackModelSelect(modelSelect, provider, '');
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
async function loadFallbackCatalogs({ forceRefreshList = true } = {}) {
  if (forceRefreshList || !state.configuredProvidersMap) {
    try {
      const data = await api('/api/dashboard/models');
      if (data?.providers && typeof data.providers === 'object') {
        state.configuredProvidersMap = data.providers;
      }
    } catch {}
    syncPrimaryProviderSelect();
  }
  const values = Array.isArray(state.adminConfig?.draft?.ai?.fallbackModels) ? state.adminConfig.draft.ai.fallbackModels.slice(0, 3) : [];
  const savedProviders = values.map(v => fallbackEntry(v).provider).filter(Boolean);
  const selectable = getSelectableProviders(savedProviders);
  await Promise.all(selectable.map(([provider]) => loadFallbackCatalog(provider)));
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
  if (state.adminConfig?.draft?.ai) state.adminConfig.draft.ai.fallbackModels = selected;
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
    result = await api('/api/admin/config/draft', { method: 'PATCH', body: JSON.stringify({ ...payload, baseRevision: state.adminConfig?.revision }) });
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
  setButtonLoading(btn, true, 'Publicando…');
  setButtonLoading(globalBtn, true, 'Publicando…');
  try {
    if (state.adminConfig && state.adminFormDirty) {
      await saveAdminDraft();
    }
    const result = await api('/api/admin/config/publish', { method: 'POST', body: JSON.stringify({ baseRevision: state.adminConfig?.revision }) });
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
    setButtonLoading(btn, false);
    setButtonLoading(globalBtn, false);
  }
}

async function discardAdminDraft() {
  if (!state.adminConfig) return;
  const cancelBtn = $('#global-cancel-btn');
  setButtonLoading(cancelBtn, true, 'Cancelando…');
  try {
    const result = await api('/api/admin/config/discard', { method: 'POST', body: '{}' });
    if (!result.ok) throw new Error((result.errors || []).join(' ') || 'Falha ao descartar rascunho.');
    state.adminConfig = result.snapshot;
    state.adminFormDirty = false;
    renderAdmin({ force: true });
    adminFeedback('Rascunho descartado. Configurações restauradas para a versão publicada.', 'success');
    if (state.view === 'tools') await renderTools();
    if (state.view === 'overview') await renderOverview();
  } catch (error) {
    adminFeedback(`Erro ao cancelar rascunho: ${error.message}`, 'error');
    opsFeedback('tools-feedback', `Erro ao cancelar rascunho: ${error.message}`, 'error');
  } finally {
    setButtonLoading(cancelBtn, false);
  }
}

const ROLE_LEVEL = { viewer: 0, operator: 1, admin: 2 };
function syncModeSelectorVisibility() {
  const level = ROLE_LEVEL[state.role] ?? 0;
  const showModeControl = state.view === 'inbox' && level >= ROLE_LEVEL.operator;
  $('.segmented-control')?.classList.toggle('hidden', !showModeControl);
  $('#mode-selector')?.classList.toggle('hidden', !showModeControl);
}
function applyRoleVisibility() {
  const level = ROLE_LEVEL[state.role] ?? 0;
  document.querySelectorAll('[data-role]').forEach(el => el.classList.toggle('hidden', level < (ROLE_LEVEL[el.dataset.role] ?? 2)));
  const operationalControls = ['#refresh', '#new-sim', '#overview-open-simulation'];
  operationalControls.forEach(selector => $(selector)?.classList.toggle('hidden', level < ROLE_LEVEL.operator));
  syncModeSelectorVisibility();
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
function drawOverviewLatencySvg(latEl) {
  if (!latEl) return;
  const wrap = latEl.querySelector('.chart-svg-wrap');
  if (!wrap) return;

  const samples = state.overviewSamples.length
    ? state.overviewSamples
    : [{ ts: '--:--:--', latencyMs: 0, requests: 0 }];

  const w = Math.max(220, Math.round(wrap.clientWidth || 520));
  const h = Math.max(148, Math.round(wrap.clientHeight || 156));
  wrap._lastW = wrap.clientWidth;
  wrap._lastH = wrap.clientHeight;

  const maxLat = Math.max(100, ...samples.map((s) => s.latencyMs));
  const insetX = 6;
  const padTop = 10;
  const padBottom = 10;
  const plotW = Math.max(1, w - insetX * 2);
  const plotH = Math.max(1, h - padTop - padBottom);

  const pts = samples.map((s, idx) => {
    const x = samples.length === 1 ? w / 2 : insetX + (idx / (samples.length - 1)) * plotW;
    const y = padTop + plotH - (Math.min(s.latencyMs, maxLat) / maxLat) * plotH;
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...s };
  });

  const midY = Number((padTop + plotH / 2).toFixed(1));
  const baseY = h - padBottom;
  const innerPoints = pts.map((p) => `L${p.x},${p.y}`).join(' ');
  const linePath = `M0,${pts[0].y} ${innerPoints} L${w},${pts[pts.length - 1].y}`;
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const circles = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.2" fill="#86DEBA" stroke="#131313" stroke-width="1.4"><title>${esc(p.ts)}: ${p.latencyMs} ms (${p.requests} req)</title></circle>`).join('');

  wrap.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Gráfico de latência em tempo real">
      <line x1="0" y1="${padTop}" x2="${w}" y2="${padTop}" stroke="#2A2B2F" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="#2A2B2F" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="#2A2B2F" stroke-width="1" vector-effect="non-scaling-stroke" />
      <path d="${areaPath}" fill="#17323e" />
      <path d="${linePath}" fill="none" stroke="#48AA7E" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      ${circles}
    </svg>
  `;
}

function renderOverviewCharts(metrics, health) {
  const latEl = $('#overview-chart-latency');
  const modEl = $('#overview-chart-models');
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

  if (succBadge) {
    succBadge.textContent = `${successRate}% sucesso`;
    succBadge.className = `pill mini ${successRate >= 95 ? 'mint' : successRate >= 80 ? 'amber' : 'err'}`;
  }
  if (latSub) latSub.textContent = `${state.overviewSamples.length} amostra(s) em sessão · última às ${nowLabel}`;

  const samples = state.overviewSamples;
  const uptimeText = health?.liveness?.uptimeSeconds != null ? `${Math.floor(health.liveness.uptimeSeconds / 60)} min` : 'ativo';

  let wrap = latEl.querySelector('.chart-svg-wrap');
  let legend = latEl.querySelector('.chart-legend-row');
  if (!wrap || !legend) {
    latEl.innerHTML = `
      <div class="chart-svg-wrap"></div>
      <div class="chart-legend-row"></div>
    `;
    wrap = latEl.querySelector('.chart-svg-wrap');
    legend = latEl.querySelector('.chart-legend-row');
  }

  legend.innerHTML = `
    <span>Pico observado: <strong>${Math.max(0, ...samples.map((s) => s.latencyMs))} ms</strong></span>
    <span>Chamadas acumuladas: <strong>${totalReq}</strong></span>
    <span>Uptime: <strong>${uptimeText}</strong></span>
  `;

  drawOverviewLatencySvg(latEl);

  if (wrap && !wrap._ro && typeof ResizeObserver === 'function') {
    wrap._ro = new ResizeObserver(() => {
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      if (wrap.clientWidth === wrap._lastW && wrap.clientHeight === wrap._lastH) return;
      requestAnimationFrame(() => drawOverviewLatencySvg(latEl));
    });
    wrap._ro.observe(wrap);
  }

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
      $('#ov-kpi-wa-sub').textContent = ev
        ? (ev.isBaileysNative ? `Baileys Nativo · ${ev.instance || '-'}` : `Instância ${ev.instance || '-'} · ${ev.latencyMs ?? '-'} ms`)
        : `Instância ${health?.system?.instance || '-'}`;
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

    healthEl.innerHTML = '';

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
          <summary><span>Configurações da ferramenta (${schema.length})</span><svg class="chevron-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary>
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
    const isBaileysEngine = data.activeWhatsappEngine === 'baileys' || data.evolution?.isBaileysNative;
    const whatsappChannelRow = isBaileysEngine
      ? [
          'WhatsApp Nativo (Baileys)',
          'WhatsApp & Canal',
          data.evolution?.status || 'connected',
          `WebSocket Direto na Lia · número ${data.evolution?.instance || '-'} · ${data.baileys?.stats?.rssMb ? `${data.baileys.stats.rssMb} MB RSS` : 'latência 0 ms'}`,
          `Recebidas: ${data.baileys?.stats?.messagesReceived ?? 0} · Enviadas: ${data.baileys?.stats?.messagesSent ?? 0} · Filtradas (Gate): ${data.baileys?.stats?.messagesFiltered ?? 0}`
        ]
      : [
          'Evolution API',
          'WhatsApp & Canal',
          data.evolution.status,
          `Host ${data.evolution.apiHost || '-'} · instância ${data.evolution.instance || '-'} · latência ${data.evolution.latencyMs ?? '-'} ms`,
          data.evolution.ownerLinked ? 'Instância vinculada a um telefone' : 'Telefone proprietário não vinculado'
        ];
    const statuses = [
      ['Ponte Chatwoot Lia', 'Ponte Chatwoot', data.chatwootBridge?.status || 'unknown', `Revisão ${data.chatwootBridge?.revision ?? '-'} · última leitura ${data.chatwootBridge?.lastReadAt ? new Date(data.chatwootBridge.lastReadAt).toLocaleString('pt-BR') : 'aguardando primeira leitura'}`],
      ['Expediente da Lia', 'Operação', !hours.enabled ? '24 horas' : (hours.isOpenNow ? 'aberto' : 'fechado'), hoursDetail],
      ['Setores do Chatwoot', 'Ponte Chatwoot', sectors.synced ? 'sincronizado' : 'aguardando sincronização', sectorsDetail],
      whatsappChannelRow,
      ['Supabase', 'Banco de Dados', data.supabase.configured ? 'configurado' : 'não configurado', `Projeto ${data.supabase.urlHost || '-'} · backend-only`],
      ['Eventos & Ledger WhatsApp', 'Canal & Webhook', data.webhook.authenticated ? 'token configurado' : 'ativo', `Transporte ${data.webhook.route} · ledger ${data.webhook.ledgerConfigured ? 'ativo' : 'indisponível'}`],
      ...(data.providers || []).map(item => [item.name, 'Provedor IA', item.state, `${item.configured ? 'configurado' : 'não configurado'} · ${item.failures} falhas · quarentena ${item.quarantineSeconds}s`])
    ];
    const countBadge = $('#integrations-status-count');
    if (countBadge) countBadge.textContent = `${statuses.length} itens`;
    $('#integrations-status').innerHTML = statuses.map(([name, category, status, detail, extra]) => {
      const tone = /connected|ok|configured|token configured|token configurado|operacional|aberto|24 horas|sincronizado|configurado/i.test(status)
        ? 'ok'
        : /not_configured|não configurado|nao_configurado|disconnected|unreachable|timeout|awaiting_first_read|stale|unknown|fechado|aguardando/i.test(status)
          ? 'warn'
          : 'err';
      return `<tr>
        <td><strong>${esc(name)}</strong></td>
        <td><span class="badge-mini">${esc(category)}</span></td>
        <td><span class="status-text ${tone}">${esc(status)}</span></td>
        <td class="integrations-detail-cell">
          <div class="integrations-detail">${esc(detail)}</div>
          ${extra ? `<div class="ops-muted">${esc(extra)}</div>` : ''}
        </td>
      </tr>`;
    }).join('');
    const events = data.webhook.recentEvents || [];
    $('#webhook-summary').textContent = `${events.length} eventos recentes · ${data.webhook.ledgerConfigured ? 'ledger persistente' : 'ledger não disponível'}`;
    $('#webhook-events').innerHTML = events.map(event => `<tr><td>${esc(event.receivedAt || '')}</td><td>${esc(event.eventType)}</td><td>${esc(event.instance || '-')}</td><td>${esc(event.status)}</td><td>${Number(event.attempts || 1)}</td><td>${esc(event.errorCode || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="table-empty">Nenhum evento recente ou ledger não aplicado.</td></tr>';
    if (state.role === 'admin') {
      await loadApiIntegrationsPanel();
    }
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator && typeof window.loadBaileysPanel === 'function') {
      await window.loadBaileysPanel();
    }
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
  try { renderFunnel(); } catch (e) { console.error('[renderFunnel]', e); }
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

let refreshSeq = 0;
let latestAppliedRefreshSeq = 0;

async function refresh({ background = false } = {}) {
  const reqSeq = ++refreshSeq;
  if (!background) setTopProgress(true);
  try {
    const incOther = state.includeOtherInstances ? '&includeOtherInstances=1' : '';
    const data = await api(`/api/dashboard/state?mode=${encodeURIComponent(state.mode)}${incOther}`);
    if (reqSeq < latestAppliedRefreshSeq) return;
    latestAppliedRefreshSeq = reqSeq;
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    state.activeInstancePhone = data.activeInstancePhone || null;
    state.otherInstancesCount = Number(data.otherInstancesCount || 0);
    if (data.counts) state.sessionCounts = data.counts;
    const subtitle = $('#inbox-subtitle');
    if (subtitle) {
      const baseText = data.persistence === 'supabase'
        ? `${state.sessions.length} sessões (${state.mode === 'real' ? 'WhatsApp' : state.mode === 'simulation' ? 'Simulador' : 'Todas'}) · Supabase`
        : data.persistenceError
        ? 'fallback local - Supabase indisponível'
        : `${state.sessions.length} sessões ativas`;
      if (state.otherInstancesCount > 0) {
        const toggleLabel = state.includeOtherInstances
          ? 'Filtrar só número atual'
          : `Ver outros números (${state.otherInstancesCount})`;
        subtitle.innerHTML = `${esc(baseText)} · <button type="button" id="toggle-other-instances-btn" class="link-btn" style="background:none;border:0;padding:0;color:var(--accent,#6366f1);cursor:pointer;font-size:inherit;text-decoration:underline">${esc(toggleLabel)}</button>`;
        const btn = $('#toggle-other-instances-btn');
        if (btn) {
          btn.onclick = () => {
            state.includeOtherInstances = !state.includeOtherInstances;
            refresh({ background: false }).catch(() => {});
          };
        }
      } else {
        subtitle.textContent = baseText;
      }
    }
    if (!state.sessions.some((item) => item.phone === state.selected)) {
      state.selected = state.sessions[0]?.phone || null;
    }
    render({ background });
  } finally {
    if (!background) setTopProgress(false);
  }
}

function syncFinishButton() {
  const btn = document.getElementById('chat-finish-btn');
  if (!btn) return;
  const sess = selectedSession();
  // Regra: chat já em modo bot => botão desabilitado (nada a concluir).
  btn.disabled = !sess || !sess.human;
  btn.title = sess && sess.human ? 'Concluir atendimento' : 'Atendimento já em modo automático';
}

async function finishSession() {
  if (!state.selected) return;
  const sess = selectedSession();
  if (!sess || !sess.human) {
    showToast({ title: 'Nada a Concluir', message: 'Esta conversa já está em modo automático (Lia).', type: 'info' });
    return;
  }
  const who = sess.displayName || sess.phoneFormatted || sess.phone;
  // Confirmação simples, uma única vez, antes de qualquer ação.
  if (!window.confirm(`Concluir o atendimento de ${who}? A Lia voltará a responder automaticamente.`)) return;
  const btn = document.getElementById('chat-finish-btn');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/dashboard/finish', { method: 'POST', body: JSON.stringify({ phone: state.selected }) });
    if (!result.ok) throw new Error(result.error || 'Falha ao concluir atendimento');
    await refresh();
    showToast({
      title: 'Atendimento Concluído',
      message: `O atendimento de ${who} foi finalizado e a Lia retomou o contato.`,
      type: 'success'
    });
  } catch (err) {
    showToast({ title: 'Falha ao Concluir', message: err.message, type: 'error' });
  } finally {
    syncFinishButton();
  }
}

async function setMode(mode) {
  if (!state.selected) return;
  const toggleBtn = $('#toggle-mode');
  if (toggleBtn) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = mode === 'bot' ? 'Reativando Lia…' : 'Transferindo para humano…';
  }
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
  inbox: 'Conversas',
  handoff: 'Fila Humana',
  'ai-hub': 'Motor de IA & APIs',
  admin: 'Configurações do Bot',
  tools: 'Ferramentas & Busca Web',
  agent: 'Motor de IA & APIs',
  integrations: 'Integrações & Webhooks',
  users: 'Acessos & Auditoria',
  metrics: 'Monitoramento & Custos',
  vps: 'Monitor da VPS',
  runtime: 'Autonomia & Memória',
  funnel: 'CRM · Funil de Leads',
  sectors: 'Setores & Triagem',
  automations: 'Automações & Réguas',
  prospecting: 'Prospecção Ativa'
};

function resolveViewFromUrl() {
  const m = window.location.pathname.match(/^(?:\/dashboard)?\/([a-z0-9-]+)\/?$/i);
  const candidate = m ? m[1].toLowerCase() : '';
  return candidate && document.querySelector(`#${candidate}-view`) ? candidate : null;
}

window.addEventListener('popstate', () => {
  const v = resolveViewFromUrl() || 'overview';
  showView(v, { skipHistory: true });
});

function showView(view, opts = {}) {
  if (view === 'agent') view = 'ai-hub';
  state.view = view;
  const targetUrl = view === 'overview' ? '/dashboard' : `/${view}`;
  if (!opts.skipHistory && window.location.pathname !== targetUrl) {
    try { window.history.pushState({ view }, '', targetUrl); } catch {}
  }
  document.querySelectorAll('.view').forEach((item) => item.classList.remove('active-view'));
  const activeViewEl = document.querySelector(`#${view}-view`);
  activeViewEl?.classList.add('active-view');
  if (activeViewEl && view !== 'inbox') {
    activeViewEl.scrollTop = 0;
  }
  document.querySelectorAll('.nav-item, .mob-nav-btn').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view] || 'Console Lia Sync';

  $('#app-sidebar')?.classList.remove('mobile-open');
  $('#sidebar-backdrop')?.classList.add('hidden');
  $('#inbox-grid')?.classList.remove('mobile-context-open');
  const ctxBtn = $('#chat-context-toggle');
  if (ctxBtn && window.innerWidth <= 1120) {
    ctxBtn.classList.remove('active');
    ctxBtn.setAttribute('aria-expanded', 'false');
  }
  syncModeSelectorVisibility();

  if (view === 'inbox') {
    renderList();
    renderChat();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) refresh().catch(() => {});
  }
  if (view === 'sectors') {
    loadCustomSectors().catch(() => {});
  }
  if (view === 'automations') {
    renderAdminData();
    loadCadence().catch(() => {});
    loadReputation().catch(() => {});
    loadMissedCall().catch(() => {});
    loadCannedResponses().catch(() => {});
  }
  if (view === 'prospecting') {
    renderAdminData();
    window.loadProspectLists?.().catch?.(() => {});
  }
  if (view === 'integrations') {
    loadTenants().catch(() => {});
  }
  if (view === 'funnel') {
    api('/api/dashboard/sectors-custom').then(d => syncSectorDropdowns(d?.sectors || [])).catch(() => {});
    renderFunnel();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) refresh().catch(() => {});
  }
  if (view === 'handoff') {
    renderHandoff();
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator) refresh().catch(() => {});
  }
  if (view === 'ai-hub') {
    renderAdminData();
    renderAgent();
    window.loadAiHubExtras?.();
  }
  if (view === 'metrics') renderMetrics();
  if (view === 'vps') renderVpsMonitor();
  if (view === 'admin') renderAdminData();
  if (view === 'overview') renderOverview();
  if (view === 'tools') {
    renderTools();
    window.loadApiSettingsGroup?.();
  }
  if (view === 'users') renderUsers();
  if (view === 'integrations') {
    renderIntegrations();
    window.loadApiSettingsGroup?.();
  }
  if (view === 'runtime') renderRuntimeView();
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
    { title: 'Monitor VPS (Somente Leitura)', sub: 'CPU, RAM, Swap/ZRAM, Docker e processos em tempo real', action: () => showView('vps') },
    { title: 'Conversas (Inbox)', sub: 'Atendimento em tempo real e simulador', role: 'operator', action: () => showView('inbox') },
    { title: 'Fila de Transbordos', sub: 'Atendimentos aguardando humano', role: 'operator', action: () => showView('handoff') },
    { title: 'Ferramentas & Consulta Web', sub: 'Catálogo de Tool Calling e Google Search', action: () => showView('tools') },
    { title: 'Capacidades & Roteador IA', sub: 'Matriz de modelos e simulador de rota', action: () => showView('agent') },
    { title: 'Integrações & Webhooks', sub: 'Evolution API, Supabase e Ponte Chatwoot', action: () => showView('integrations') },
    { title: 'Configurações: Identidade & System Prompt', sub: 'Persona, empresa e diretriz mestre', role: 'admin', action: () => openAdminSection('acc-identity') },
    { title: 'Configurações: Motor IA & Fallbacks', sub: 'Provedor, modelo ativo e reservas', role: 'admin', action: () => openAdminSection('acc-ai') },
    { title: 'Configurações: Voz Nativa (TTS WAV)', sub: 'Aoede, Kore, velocidade e PTT automático', role: 'admin', action: () => openAdminSection('acc-voice') },
    { title: 'Atendimento: Automações & Follow-up', sub: 'Follow-up proativo, cadências, ligação perdida e reputação', role: 'admin', action: () => showView('automations') },
    { title: 'Atendimento: Prospecção Ativa', sub: 'Motor de prospecção, janela de envio e listas CSV/JSON', role: 'admin', action: () => showView('prospecting') },
    { title: 'Configurações: Operações & Transbordo', sub: 'Mídias, sincronização WhatsApp e alertas humanos', role: 'admin', action: () => openAdminSection('acc-automation') },
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
  const targetPhone = state.selected;
  const sess = selectedSession();
  const isSim = sess ? sess.origin === 'simulation' : state.mode === 'simulation';
  const isInternal = Boolean(sess?.isInternalChat || targetPhone === 'owner_self' || /^[a-z0-9_]+_self$/i.test(targetPhone));
  const endpoint = isSim ? '/api/dashboard/simulate' : '/api/dashboard/send';
  const replyPayload = state.replyTo ? { ...state.replyTo } : null;
  clearReplyTo();

  if (!state.pendingOutboundByPhone) state.pendingOutboundByPhone = new Map();
  const optimisticId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const optimisticMsg = {
    id: optimisticId,
    role: (isInternal || isSim) ? 'user' : 'assistant',
    content: `${cleanText}\n\n⏳ _Enviando..._`,
    createdAt: new Date().toISOString(),
    _optimistic: true
  };
  const existingPending = state.pendingOutboundByPhone.get(targetPhone) || [];
  state.pendingOutboundByPhone.set(targetPhone, [...existingPending, optimisticMsg]);
  const sendBtn = $('#composer button[type="submit"]');
  if (sendBtn) sendBtn.disabled = true;
  renderChat({ forceRender: true });

  const removeOptimistic = () => {
    const list = (state.pendingOutboundByPhone.get(targetPhone) || []).filter(m => m.id !== optimisticId);
    if (list.length) state.pendingOutboundByPhone.set(targetPhone, list);
    else state.pendingOutboundByPhone.delete(targetPhone);
  };

  try {
    const res = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        phone: targetPhone,
        text: cleanText,
        replyTo: replyPayload,
        mediaType,
        fileName
      })
    });
    removeOptimistic();
    if (res?.selectedPhone) state.selected = res.selectedPhone;
    await refresh();
    renderChat({ forceRender: true });
    if (state.view === 'metrics') renderMetrics();
  } catch (err) {
    removeOptimistic();
    const input = $('#message-input');
    if (input && !input.value.trim()) input.value = cleanText;
    renderChat({ forceRender: true });
    showToast({ title: 'Falha ao Enviar Mensagem', message: err.message || 'Erro de comunicação', type: 'error' });
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

function startDashboard() {
  showView(resolveViewFromUrl() || 'overview', { skipHistory: true });
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

  // In-chat search bar & context panel helpers
  const toggleChatSearch = () => {
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
  };
  const isChatContextOpen = () => {
    const grid = $('#inbox-grid');
    if (!grid) return false;
    if (window.innerWidth <= 1120) {
      return grid.classList.contains('mobile-context-open');
    }
    return !grid.classList.contains('context-collapsed');
  };
  const syncChatContextToggle = () => {
    const btn = $('#chat-context-toggle');
    if (!btn) return;
    const open = isChatContextOpen();
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  const toggleChatContextPanel = () => {
    const grid = $('#inbox-grid');
    if (!grid) return;
    if (window.innerWidth <= 1120) {
      grid.classList.toggle('mobile-context-open');
    } else {
      grid.classList.toggle('context-collapsed');
    }
    syncChatContextToggle();
  };
  syncChatContextToggle();
  window.addEventListener('resize', syncChatContextToggle);
  $('#chat-context-toggle')?.addEventListener('click', toggleChatContextPanel);

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

  // Chat Header Hamburger Menu (Unified Actions)
  const openChatHeaderMenu = (e) => {
    e.stopPropagation();
    const sess = selectedSession();
    if (!sess) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const searchOpen = !$('#chat-search-bar')?.classList.contains('hidden');
    const contextOpen = isChatContextOpen();
    openAppleContextMenu({
      x: rect.right - 230,
      y: rect.bottom + 8,
      header: 'Ações da Conversa',
      items: [
        {
          label: searchOpen ? 'Fechar busca na conversa' : 'Buscar nesta conversa',
          shortcut: '⌘F',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
          action: toggleChatSearch
        },
        {
          label: sess.human ? 'Reativar Lia (Automático)' : 'Transferir para Humano',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>`,
          action: () => setMode(sess.human ? 'bot' : 'human')
        },
        {
          label: contextOpen ? 'Ocultar Contexto & Memória' : 'Mostrar Contexto & Memória',
          icon: `<svg width="15" height="15" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
          action: toggleChatContextPanel
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
  };
  $('#chat-more-menu')?.addEventListener('click', openChatHeaderMenu);
  $('#chat-more-btn')?.addEventListener('click', openChatHeaderMenu);
  $('#chat-finish-btn')?.addEventListener('click', finishSession);

  // Composer Attach (+) Integrated WhatsApp Panel
  $('#composer-attach-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAppleContextMenu();
    const panel = $('#chat-smart-bar');
    const btn = e.currentTarget;
    if (!panel) return;
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    btn.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });

  // Composer Reply Cancel
  $('#reply-bar-cancel')?.addEventListener('click', clearReplyTo);
  $('#composer-reply-cancel')?.addEventListener('click', clearReplyTo);

  // Integrated Panel: Media Simulation, Quick Replies & Transcript Export
  document.querySelectorAll('[data-sim-media]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      closeComposerAttachPanel();
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
      closeComposerAttachPanel();
      const input = $('#message-input');
      if (!input) return;
      input.value = chip.dataset.quickReply || '';
      input.focus();
    });
  });

  $('#wa-export-transcript')?.addEventListener('click', () => {
    closeComposerAttachPanel();
    exportConversationTranscript(selectedSession());
  });

  // Mobile Inbox & Context Drawer controls
  $('#chat-mobile-back')?.addEventListener('click', () => {
    $('#inbox-grid')?.classList.remove('mobile-chat-open', 'mobile-context-open');
    syncChatContextToggle();
  });
  $('#detail-close-mobile')?.addEventListener('click', () => {
    $('#inbox-grid')?.classList.remove('mobile-context-open');
    syncChatContextToggle();
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
  const withIconSpin = async (btn, fn) => {
    if (btn) {
      btn.disabled = true;
      btn.classList.add('spinning');
    }
    try {
      await fn();
    } finally {
      if (btn) {
        setTimeout(() => {
          btn.classList.remove('spinning');
          btn.disabled = false;
        }, 480);
      }
    }
  };

  $('#refresh')?.addEventListener('click', () => triggerRefreshWithIcon($('#refresh')));
  $('#overview-go-config')?.addEventListener('click', () => showView('admin'));
  $('#overview-ping-quick')?.addEventListener('click', () => {
    showView('metrics');
    setTimeout(() => $('#btn-ping-ai')?.click(), 120);
  });

  // Agent controls
  $('#agent-refresh-btn')?.addEventListener('click', () => withIconSpin($('#agent-refresh-btn'), () => renderAgent({ force: true })));

  // Tools controls
  $('#tools-refresh')?.addEventListener('click', () => withIconSpin($('#tools-refresh'), renderTools));
  $('#tools-save')?.addEventListener('click', async () => {
    const btn = $('#tools-save');
    setButtonLoading(btn, true, 'Salvando…');
    try {
      const result = await saveToolsDraft();
      opsFeedback('tools-feedback', `Rascunho salvo (revisão v${result.revision}). Clique em "Publicar" para ativar no runtime.`, 'success');
      await renderTools();
    } catch (error) { opsFeedback('tools-feedback', `Não foi possível salvar: ${error.message}`, 'error'); }
    finally { setButtonLoading(btn, false); }
  });
  $('#tools-publish')?.addEventListener('click', async () => {
    const btn = $('#tools-publish');
    setButtonLoading(btn, true, 'Publicando…');
    try {
      await saveToolsDraft();
      await publishAdminChanges();
      opsFeedback('tools-feedback', `Ferramentas e busca web publicadas e ativas no motor!`, 'success');
      await renderTools();
    } catch (error) { opsFeedback('tools-feedback', `Não foi possível publicar: ${error.message}`, 'error'); }
    finally { setButtonLoading(btn, false); }
  });
  $('#tools-enable-all')?.addEventListener('click', () => {
    document.querySelectorAll('.tool-toggle').forEach(el => { if (!el.disabled) el.checked = true; });
    showToast({ title: 'Ferramentas Selecionadas', message: 'Todas as ferramentas foram marcadas. Salve ou publique para aplicar.', type: 'info' });
  });

  $('#integrations-refresh')?.addEventListener('click', () => withIconSpin($('#integrations-refresh'), renderIntegrations));
  $('#users-refresh')?.addEventListener('click', () => withIconSpin($('#users-refresh'), renderUsers));
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
      document.querySelectorAll('[data-open-acc]').forEach((item) => item.classList.toggle('active', item === chip));
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
  $('#global-cancel-btn')?.addEventListener('click', discardAdminDraft);

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
      const result = await api('/api/admin/config/rollback', { method: 'POST', body: JSON.stringify({ revision: rev, baseRevision: state.adminConfig?.revision }) });
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
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'sim-modal-title');
    modal.innerHTML = `
      <div class="sim-modal-card">
        <h3 id="sim-modal-title">Nova Simulação Isolada</h3>
        <p class="ops-muted" style="margin-bottom:14px;">Inicie uma sessão de teste para validar prompts, ferramentas e multimídia sem acionar o WhatsApp real.</p>
        <label for="modal-sim-phone" style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:6px;">Identificador Numérico da Sessão</label>
        <input id="modal-sim-phone" type="text" value="${esc(defaultPhone)}" inputmode="numeric" />
        <div class="sim-modal-actions">
          <button type="button" class="sim-modal-cancel">Cancelar</button>
          <button type="button" class="sim-modal-confirm btn-primary">Iniciar Simulação</button>
        </div>
      </div>
    `;
    const previouslyFocused = document.activeElement;
    document.body.appendChild(modal);
    const input = modal.querySelector('#modal-sim-phone');
    input.focus();
    input.select();

    const focusables = () => [...modal.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);

    const closeModal = () => {
      document.removeEventListener('keydown', onKeydown, true);
      modal.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;
      // Trap básico: mantém o foco do teclado dentro do diálogo.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeydown, true);

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
    setButtonLoading(btn, true, 'Testando…');
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
      setButtonLoading(btn, false);
    }
  };

  $('#btn-ping-ai')?.addEventListener('click', handlePing);
  $('#metrics-ping-btn')?.addEventListener('click', handlePing);

  $('#btn-refresh-metrics')?.addEventListener('click', () => withIconSpin($('#btn-refresh-metrics'), renderMetrics));
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

  $('#btn-refresh-vps')?.addEventListener('click', () => withIconSpin($('#btn-refresh-vps'), renderVpsMonitor));
  $('#vps-refresh-rate')?.addEventListener('change', (e) => {
    const ms = Number(e.target.value);
    if (state.vpsTimer) {
      clearInterval(state.vpsTimer);
      state.vpsTimer = null;
    }
    if (ms > 0) {
      if (state.view === 'vps' && !document.hidden) renderVpsMonitor();
      state.vpsTimer = setInterval(() => {
        if (state.view === 'vps' && !document.hidden) renderVpsMonitor();
      }, ms);
    }
  });
  state.vpsTimer = setInterval(() => {
    if (state.view === 'vps' && !document.hidden) renderVpsMonitor();
  }, 3000);

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

    const sampleBot = state.adminConfig?.draft?.identity?.assistantName || 'Lia';
    const sampleCompany = state.adminConfig?.draft?.identity?.companyName || '';
    const sampleIntro = sampleCompany ? `assistente virtual da ${sampleCompany}` : 'sua assistente virtual';
    await playNeuralAudio(`Olá! Eu sou ${sampleBot}, ${sampleIntro}. Como posso ajudar você hoje?`, {
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
        if (state.refreshTimer) clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(() => { if (!document.hidden) refresh({ background: true }).catch(() => {}); }, 2500);
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
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (!document.hidden) refresh({ background: true }).catch(() => {});
    }, 2500);
  }
});

// Collapsible Sidebar & Mobile Drawer Controller
(() => {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const topbarLeft = document.querySelector('.topbar-left');
  const sidebarHeader = sidebar?.querySelector('.sidebar-header');
  const closeMobileBtn = document.getElementById('sidebar-close-mobile');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar || !toggleBtn || !topbarLeft || !sidebarHeader) return;

  const STORAGE_KEY = 'lia_sidebar_collapsed';
  const isMobile = () => window.innerWidth <= 820;

  const applyState = (collapsed) => {
    const activeCollapsed = !isMobile() && collapsed;
    sidebar.classList.toggle('collapsed', activeCollapsed);
    toggleBtn.setAttribute('aria-expanded', String(!activeCollapsed));
    toggleBtn.setAttribute('title', activeCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral');
    toggleBtn.setAttribute('aria-label', activeCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral');

    if (activeCollapsed) {
      if (toggleBtn.parentElement !== sidebarHeader) {
        sidebarHeader.insertBefore(toggleBtn, sidebarHeader.firstChild);
      }
    } else if (toggleBtn.parentElement !== topbarLeft) {
      topbarLeft.insertBefore(toggleBtn, topbarLeft.firstChild);
    }
  };

  if (!isMobile() && localStorage.getItem(STORAGE_KEY) === '1') {
    applyState(true);
  } else {
    applyState(false);
  }

  const closeMobile = () => {
    sidebar.classList.remove('mobile-open');
    backdrop?.classList.add('hidden');
  };

  toggleBtn.addEventListener('click', () => {
    if (isMobile()) {
      const nextOpen = !sidebar.classList.contains('mobile-open');
      sidebar.classList.toggle('mobile-open', nextOpen);
      backdrop?.classList.toggle('hidden', !nextOpen);
      return;
    }
    const next = !sidebar.classList.contains('collapsed');
    applyState(next);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  });

  window.addEventListener('resize', () => {
    applyState(localStorage.getItem(STORAGE_KEY) === '1');
  });

  closeMobileBtn?.addEventListener('click', closeMobile);
  backdrop?.addEventListener('click', closeMobile);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMobile();
      $('#inbox-grid')?.classList.remove('mobile-context-open');
      const ctxBtn = document.getElementById('chat-context-toggle');
      if (ctxBtn && window.innerWidth <= 1120) {
        ctxBtn.classList.remove('active');
        ctxBtn.setAttribute('aria-expanded', 'false');
      }
    }
  });
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

// ============================================================================
// PROSPECÇÃO ATIVA & IMPORTAÇÃO CSV/JSON
// ============================================================================
(() => {
  const fileInput = document.getElementById('prospect-file-input');
  const leadsText = document.getElementById('prospect-leads-text');
  const importBtn = document.getElementById('prospect-import-btn');
  const refreshBtn = document.getElementById('prospect-refresh-btn');
  const statusEl = document.getElementById('prospect-import-status');
  const container = document.getElementById('prospect-lists-container');
  const acc = document.getElementById('acc-prospecting');
  if (!container) return;

  const setStatus = (msg, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.style.color = isError ? 'var(--danger, #f87171)' : '';
  };

  const toLocalInputValue = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  async function loadProspectLists() {
    try {
      const data = await api('/api/dashboard/prospecting/lists');
      const lists = data?.lists || [];
      if (!lists.length) {
        container.innerHTML = '<div class="detail-placeholder">Nenhuma lista de prospecção cadastrada ainda.</div>';
        return;
      }
      container.innerHTML = lists.map((l) => {
        const s = l.stats || {};
        const status = l.status || 'paused';
        const statusLabel = status === 'active' ? 'Ativa' : status === 'stopped' ? 'Parada' : status === 'completed' ? 'Concluída' : 'Pausada';
        const pillClass = status === 'active' ? 'mint' : status === 'stopped' ? 'err' : 'amber';
        const scheduleInfo = [
          l.start_at ? `Início: ${new Date(l.start_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : '',
          l.end_at ? `Fim: ${new Date(l.end_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''
        ].filter(Boolean).join(' · ');
        return `
          <div class="ops-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div>
              <strong>${esc(l.name)}</strong>
              <span class="pill mini ${pillClass}" style="margin-left:8px;">${statusLabel}</span>
              <div class="field-hint" style="margin-top:4px;">
                Segmento: ${esc(l.segment || '—')} · Total: ${s.total || 0} · Novos: ${s.new || 0} · Contatados: ${s.contacted || 0} · Opt-out: ${s.opted_out || 0}${scheduleInfo ? ` · ${esc(scheduleInfo)}` : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="admin-ghost-btn btn-sm prospect-edit-btn" data-list-id="${esc(l.id)}">Editar</button>
              <button type="button" class="admin-ghost-btn btn-sm prospect-status-btn" data-list-id="${esc(l.id)}" data-next-status="active" ${status === 'active' ? 'disabled' : ''}>Iniciar</button>
              <button type="button" class="admin-ghost-btn btn-sm prospect-status-btn" data-list-id="${esc(l.id)}" data-next-status="paused" ${status === 'paused' ? 'disabled' : ''}>Pausar</button>
              <button type="button" class="admin-ghost-btn btn-sm prospect-status-btn" data-list-id="${esc(l.id)}" data-next-status="stopped" ${status === 'stopped' ? 'disabled' : ''}>Parar</button>
            </div>
            <div class="prospect-edit-box hidden" data-edit-box="${esc(l.id)}" style="width:100%;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-hairline);display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;">
              <label>Nome <input type="text" data-edit-name="${esc(l.id)}" value="${esc(l.name)}" /></label>
              <label>Segmento <input type="text" data-edit-segment="${esc(l.id)}" value="${esc(l.segment || '')}" /></label>
              <label>Teto/dia <input type="number" min="1" max="500" data-edit-cap="${esc(l.id)}" value="${Number(l.daily_cap || 20)}" /></label>
              <label>Início <input type="datetime-local" data-edit-start="${esc(l.id)}" value="${esc(toLocalInputValue(l.start_at))}" /></label>
              <label>Término <input type="datetime-local" data-edit-end="${esc(l.id)}" value="${esc(toLocalInputValue(l.end_at))}" /></label>
              <div style="display:flex;gap:6px;align-items:flex-end;">
                <button type="button" class="admin-primary-btn btn-sm prospect-save-edit-btn" data-list-id="${esc(l.id)}">Salvar</button>
                <button type="button" class="admin-ghost-btn btn-sm prospect-cancel-edit-btn" data-list-id="${esc(l.id)}">Cancelar</button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      container.querySelectorAll('.prospect-edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const box = container.querySelector(`[data-edit-box="${btn.dataset.listId}"]`);
          box?.classList.toggle('hidden');
        });
      });

      container.querySelectorAll('.prospect-cancel-edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const box = container.querySelector(`[data-edit-box="${btn.dataset.listId}"]`);
          box?.classList.add('hidden');
        });
      });

      container.querySelectorAll('.prospect-save-edit-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.listId;
          const name = container.querySelector(`[data-edit-name="${id}"]`)?.value?.trim() || '';
          const segment = container.querySelector(`[data-edit-segment="${id}"]`)?.value?.trim() || '';
          const dailyCap = Number(container.querySelector(`[data-edit-cap="${id}"]`)?.value || 20);
          const startRaw = container.querySelector(`[data-edit-start="${id}"]`)?.value || '';
          const endRaw = container.querySelector(`[data-edit-end="${id}"]`)?.value || '';
          btn.disabled = true;
          try {
            await api(`/api/dashboard/prospecting/lists/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              body: JSON.stringify({
                name,
                segment,
                dailyCap,
                startAt: startRaw ? new Date(startRaw).toISOString() : null,
                endAt: endRaw ? new Date(endRaw).toISOString() : null
              })
            });
            setStatus('Lista atualizada com sucesso.');
            await loadProspectLists();
          } catch (err) {
            setStatus(err?.message || 'Erro ao salvar edição da lista.', true);
          } finally {
            btn.disabled = false;
          }
        });
      });

      container.querySelectorAll('.prospect-status-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const listId = btn.dataset.listId;
          const nextStatus = btn.dataset.nextStatus;
          btn.disabled = true;
          try {
            await api(`/api/dashboard/prospecting/lists/${encodeURIComponent(listId)}/status`, {
              method: 'POST',
              body: JSON.stringify({ status: nextStatus })
            });
            await loadProspectLists();
          } catch (err) {
            setStatus(err?.message || 'Erro ao atualizar status da lista.', true);
          } finally {
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="detail-placeholder">${esc(err?.message || 'Não foi possível carregar as listas.')}</div>`;
    }
  }

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || !leadsText) return;
    leadsText.value = await file.text();
    const nameInput = document.getElementById('prospect-list-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.(csv|json|txt)$/i, '');
    }
    setStatus(`Arquivo "${file.name}" carregado no campo abaixo.`);
  });

  importBtn?.addEventListener('click', async () => {
    const name = document.getElementById('prospect-list-name')?.value?.trim() || '';
    const segment = document.getElementById('prospect-list-segment')?.value?.trim() || '';
    const consentBasis = document.getElementById('prospect-list-consent')?.value?.trim() || '';
    const startRaw = document.getElementById('prospect-list-start')?.value || '';
    const endRaw = document.getElementById('prospect-list-end')?.value || '';
    const raw = leadsText?.value?.trim() || '';
    if (!name || !raw) {
      setStatus('Informe o nome da lista e cole ou carregue um CSV/JSON.', true);
      return;
    }
    importBtn.disabled = true;
    setStatus('Importando leads...');
    try {
      const res = await api('/api/dashboard/prospecting/lists', {
        method: 'POST',
        body: JSON.stringify({
          name,
          segment,
          consentBasis,
          startAt: startRaw ? new Date(startRaw).toISOString() : null,
          endAt: endRaw ? new Date(endRaw).toISOString() : null,
          leadsText: raw
        })
      });
      setStatus(`Lista importada: ${res.importedCount} lead(s) válidos, ${res.rejectedCount} rejeitado(s).`);
      if (leadsText) leadsText.value = '';
      await loadProspectLists();
    } catch (err) {
      setStatus(err?.message || 'Falha ao importar lista.', true);
    } finally {
      importBtn.disabled = false;
    }
  });

  refreshBtn?.addEventListener('click', loadProspectLists);
  document.getElementById('prospect-test-tick-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('prospect-test-tick-btn');
    if (btn) btn.disabled = true;
    setStatus('Executando ciclo de teste na lista ativa...');
    try {
      const res = await api('/api/dashboard/prospecting/tick', {
        method: 'POST',
        body: JSON.stringify({ testMode: true })
      });
      const s = res?.summary || {};
      const blockedReasons = (s.details || []).filter(d => d.status === 'blocked').map(d => d.reason).join(', ');
      setStatus(`Teste concluído: ${s.sent || 0} enviado(s), ${s.blocked || 0} bloqueado(s)${blockedReasons ? ` (${blockedReasons})` : ''}, ${s.failed || 0} falha(s).`);
      await loadProspectLists();
    } catch (err) {
      setStatus(err?.message || 'Falha ao executar teste.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  window.loadProspectLists = loadProspectLists;
  document.getElementById('prospecting-publish-btn')?.addEventListener('click', () => {
    publishAdminChanges();
  });
})();


function formatUptime(totalSeconds = 0) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${sec % 60}s`;
}

function setVpsBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = `${clamped.toFixed(1)}%`;
  el.classList.remove('warn', 'crit');
  if (clamped >= 85) el.classList.add('crit');
  else if (clamped >= 65) el.classList.add('warn');
}

async function renderVpsMonitor() {
  try {
    const data = await api('/api/dashboard/vps-monitor');
    const m = data?.metrics || {};
    const cpu = m.cpu || {};
    const mem = m.memory || {};
    const swap = m.swap || {};
    const disk = m.disk || {};
    const dockerDisk = m.docker_disk || {};

    const badge = $('#vps-status-badge');
    if (badge) {
      badge.textContent = data?.stale ? 'stale' : data?.source === 'local-fallback' ? 'local' : 'ok';
      badge.className = `badge-mini ${data?.stale ? 'warn' : 'ok'}`;
    }

    const banner = $('#vps-status-banner');
    if (banner) {
      if (data?.stale) {
        banner.className = 'ping-banner error';
        banner.textContent = `Coletor do host atrasado há ${data.age_seconds}s. Verifique o serviço lia-vps-monitor.service.`;
      } else if (data?.source === 'local-fallback') {
        banner.className = 'ping-banner';
        banner.textContent = 'Modo fallback local ativo (arquivo vps-metrics.json do host ainda não encontrado).';
      } else {
        banner.className = 'ping-banner hidden';
      }
    }

    const cpuPct = Number(cpu.usage_pct || 0);
    if ($('#vps-cpu-pct')) $('#vps-cpu-pct').textContent = `${cpuPct.toFixed(1)}%`;
    if ($('#vps-cpu-sub')) {
      $('#vps-cpu-sub').textContent = `Load: ${cpu.load_1m ?? '--'} / ${cpu.load_5m ?? '--'} / ${cpu.load_15m ?? '--'} · ${cpu.cores ?? '--'} vCPU`;
    }
    setVpsBar('vps-cpu-bar', cpuPct);

    const ramPct = Number(mem.used_pct || 0);
    if ($('#vps-ram-pct')) $('#vps-ram-pct').textContent = `${ramPct.toFixed(1)}%`;
    if ($('#vps-ram-sub')) {
      $('#vps-ram-sub').textContent = `${Math.round(mem.used_mb || 0)} / ${Math.round(mem.total_mb || 0)} MB (Disp: ${Math.round(mem.available_mb || 0)} MB)`;
    }
    setVpsBar('vps-ram-bar', ramPct);

    const swapPct = Number(swap.used_pct || 0);
    if ($('#vps-swap-pct')) $('#vps-swap-pct').textContent = `${swapPct.toFixed(1)}%`;
    if ($('#vps-swap-sub')) {
      $('#vps-swap-sub').textContent = `${Math.round(swap.used_mb || 0)} / ${Math.round(swap.total_mb || 0)} MB (${(swap.devices || []).length} disp.)`;
    }
    setVpsBar('vps-swap-bar', swapPct);

    const diskPct = Number(disk.used_pct || 0);
    if ($('#vps-disk-pct')) $('#vps-disk-pct').textContent = disk.total_gb ? `${diskPct.toFixed(1)}%` : '--%';
    if ($('#vps-disk-sub')) {
      $('#vps-disk-sub').textContent = disk.total_gb
        ? `${disk.used_gb} / ${disk.total_gb} GB (Livre: ${disk.avail_gb} GB)`
        : 'Indisponível no modo local';
    }
    setVpsBar('vps-disk-bar', diskPct);

    if ($('#vps-host-meta')) {
      const collectedAt = m.collected_at ? new Date(m.collected_at).toLocaleTimeString('pt-BR') : '--';
      $('#vps-host-meta').textContent = `Host: ${m.hostname || '--'} · Uptime: ${formatUptime(m.uptime_seconds)} · Coletado às ${collectedAt}`;
    }

    const swapBody = $('#vps-swap-devices-body');
    if (swapBody) {
      const devs = Array.isArray(swap.devices) ? swap.devices : [];
      swapBody.innerHTML = devs.length
        ? devs
            .map(
              (d) => `<tr>
                <td><code>${esc(d.name)}</code></td>
                <td>${esc(d.type)}</td>
                <td>${Math.round(d.size_mb || 0)} MB</td>
                <td>${Math.round(d.used_mb || 0)} MB</td>
                <td>${esc(String(d.priority ?? '--'))}</td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="5" class="muted">Nenhum dispositivo de swap ativo</td></tr>';
    }

    const dockerDiskEl = $('#vps-docker-disk-body');
    if (dockerDiskEl) {
      dockerDiskEl.innerHTML = dockerDisk && dockerDisk.images_size
        ? `
          <div class="vps-kv-row"><span>Imagens (${esc(String(dockerDisk.images_count ?? '--'))})</span><strong>${esc(dockerDisk.images_size)} <small class="muted">(recup: ${esc(dockerDisk.images_reclaimable || '0B')})</small></strong></div>
          <div class="vps-kv-row"><span>Camadas de Containers</span><strong>${esc(dockerDisk.containers_size || '0B')}</strong></div>
          <div class="vps-kv-row"><span>Volumes</span><strong>${esc(dockerDisk.volumes_size || '0B')}</strong></div>
          <div class="vps-kv-row"><span>Build Cache</span><strong>${esc(dockerDisk.build_cache_size || '0B')}</strong></div>
        `
        : '<span class="muted">Sem dados do Docker disk neste ambiente.</span>';
    }

    const containers = Array.isArray(m.containers) ? m.containers : [];
    if ($('#vps-containers-count')) $('#vps-containers-count').textContent = String(containers.length);
    const cBody = $('#vps-containers-body');
    if (cBody) {
      cBody.innerHTML = containers.length
        ? containers
            .map(
              (c) => `<tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td><span class="badge-mini ${String(c.status || '').includes('Up') ? 'ok' : 'warn'}">${esc(c.status || '--')}</span></td>
                <td>${Number(c.cpu_pct || 0).toFixed(2)}%</td>
                <td>${esc(c.mem_used || '--')} <small class="muted">/ ${esc(c.mem_limit || '--')}</small></td>
                <td>${Number(c.mem_pct || 0).toFixed(1)}%</td>
                <td><small>${esc(c.net_io || '--')}</small></td>
                <td><small>${esc(c.block_io || '--')}</small></td>
                <td>${esc(String(c.pids ?? '--'))}</td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="8" class="muted">Nenhum container encontrado</td></tr>';
    }

    const procs = Array.isArray(m.processes) ? m.processes : [];
    if ($('#vps-processes-count')) $('#vps-processes-count').textContent = String(procs.length);
    const pBody = $('#vps-processes-body');
    if (pBody) {
      pBody.innerHTML = procs.length
        ? procs
            .map(
              (p) => `<tr>
                <td><code>${esc(String(p.pid))}</code></td>
                <td>${esc(p.user || '--')}</td>
                <td><code>${esc(p.stat || '--')}</code></td>
                <td>${Number(p.cpu_pct || 0).toFixed(1)}%</td>
                <td>${Number(p.rss_mb || 0).toFixed(1)} MB</td>
                <td>${Number(p.mem_pct || 0).toFixed(1)}%</td>
                <td class="vps-cmd-cell" title="${esc(p.command || '')}"><code>${esc(p.command || '--')}</code></td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="7" class="muted">Sem processos listados</td></tr>';
    }
  } catch (err) {
    const banner = $('#vps-status-banner');
    if (banner) {
      banner.className = 'ping-banner error';
      banner.textContent = `Erro ao carregar métricas da VPS: ${err?.message || 'falha desconhecida'}`;
    }
  }
}


async function copyTextWithFeedback(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Copiado!';
    setTimeout(() => { if (btn) btn.textContent = prev; }, 1500);
  } catch {
    showToast({ title: 'Copiar', message: 'Não foi possível copiar automaticamente.', type: 'warn' });
  }
}

async function loadApiIntegrationsPanel() {
  try {
    const data = await api('/api/admin/integrations/keys');
    const webhooks = Array.isArray(data?.webhooks) ? data.webhooks : [];
    const keys = Array.isArray(data?.apiKeys) ? data.apiKeys : [];

    const whBody = $('#outbound-webhooks-list');
    if (whBody) {
      whBody.innerHTML = webhooks.length
        ? webhooks.map((w) => {
            const statusLabel = w.lastStatus ? `HTTP ${w.lastStatus}` : (w.lastError || 'aguardando');
            const badgeTone = !w.enabled ? 'warn' : (w.lastStatus >= 200 && w.lastStatus < 300 ? 'ok' : (w.lastError ? 'err' : 'ok'));
            return `<tr>
              <td><strong>${esc(w.name)}</strong></td>
              <td><code>${esc(w.url)}</code></td>
              <td>${(w.events || []).map((ev) => `<span class="badge-mini">${esc(ev)}</span>`).join(' ')}</td>
              <td>${w.lastTriggeredAt ? esc(new Date(w.lastTriggeredAt).toLocaleString('pt-BR')) : '<span class="ops-muted">Nunca</span>'}</td>
              <td><span class="status-text ${badgeTone}">${esc(w.enabled ? statusLabel : 'pausado')}</span></td>
              <td class="ops-actions-cell">
                <button type="button" class="btn-secondary" data-wh-test="${esc(w.id)}">Testar</button>
                <button type="button" class="btn-secondary" data-wh-toggle="${esc(w.id)}" data-enabled="${w.enabled ? '1' : '0'}">${w.enabled ? 'Pausar' : 'Ativar'}</button>
                <button type="button" class="btn-danger-ghost" data-wh-del="${esc(w.id)}">Excluir</button>
              </td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="6" class="table-empty">Nenhum webhook de saída cadastrado.</td></tr>';
    }

    const keysBody = $('#api-keys-list');
    if (keysBody) {
      keysBody.innerHTML = keys.length
        ? keys.map((k) => {
            const revoked = Boolean(k.revokedAt);
            return `<tr>
              <td><strong>${esc(k.name)}</strong></td>
              <td><code>${esc(k.prefix)}</code></td>
              <td>${(k.scopes || []).map((s) => `<span class="badge-mini">${esc(s)}</span>`).join(' ')}</td>
              <td>${k.lastUsedAt ? esc(new Date(k.lastUsedAt).toLocaleString('pt-BR')) : '<span class="ops-muted">Nunca</span>'}</td>
              <td><span class="status-text ${revoked ? 'err' : 'ok'}">${revoked ? 'revogada' : 'ativa'}</span></td>
              <td class="ops-actions-cell">
                ${revoked ? '<span class="ops-muted">—</span>' : `<button type="button" class="btn-danger-ghost" data-key-revoke="${esc(k.id)}">Revogar</button>`}
              </td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="6" class="table-empty">Nenhuma chave gerada pelo painel.</td></tr>';
    }
  } catch (err) {
    const detail = err?.message || String(err);
    console.warn('[api-integrations]', detail);
    // Falha de leitura precisa ser visível: sem isso as tabelas mostravam
    // "nenhum cadastrado" e o admin podia recriar webhooks/chaves já existentes.
    const whBody = $('#outbound-webhooks-list');
    if (whBody) whBody.innerHTML = `<tr><td colspan="6" class="table-empty">Não foi possível carregar os webhooks de saída. ${esc(detail)}</td></tr>`;
    const keysBody = $('#api-keys-list');
    if (keysBody) keysBody.innerHTML = `<tr><td colspan="6" class="table-empty">Não foi possível carregar as chaves de API. ${esc(detail)}</td></tr>`;
    opsFeedback('integrations-feedback', `Falha ao carregar chaves e webhooks: ${detail}`, 'error');
  }
}

(() => {
  const whForm = $('#outbound-webhook-form');
  const keyForm = $('#api-key-form');

  $('#btn-toggle-webhook-form')?.addEventListener('click', () => whForm?.classList.toggle('hidden'));
  $('#btn-cancel-webhook-form')?.addEventListener('click', () => whForm?.classList.add('hidden'));
  $('#btn-toggle-apikey-form')?.addEventListener('click', () => keyForm?.classList.toggle('hidden'));
  $('#btn-cancel-apikey-form')?.addEventListener('click', () => keyForm?.classList.add('hidden'));

  whForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#wh-name')?.value.trim() || '';
    const url = $('#wh-url')?.value.trim() || '';
    const events = [...whForm.querySelectorAll('input[name="wh-event"]:checked')].map((el) => el.value);
    try {
      const res = await api('/api/admin/integrations/webhooks', {
        method: 'POST',
        body: JSON.stringify({ name, url, events })
      });
      whForm.reset();
      whForm.classList.add('hidden');
      const banner = $('#wh-secret-banner');
      if (banner && res?.secret) {
        banner.className = 'ping-banner';
        banner.innerHTML = `Webhook criado! Segredo HMAC (<code>x-lia-signature</code>): <code id="wh-once-secret">${esc(res.secret)}</code> <button type="button" class="btn-secondary" id="btn-copy-wh-secret">Copiar</button>`;
        $('#btn-copy-wh-secret')?.addEventListener('click', (ev) => copyTextWithFeedback(res.secret, ev.currentTarget));
      }
      await loadApiIntegrationsPanel();
    } catch (err) {
      opsFeedback('integrations-feedback', err?.message || 'Erro ao criar webhook.', 'error');
    }
  });

  keyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#apikey-name')?.value.trim() || '';
    const scopes = [...keyForm.querySelectorAll('input[name="apikey-scope"]:checked')].map((el) => el.value);
    try {
      const res = await api('/api/admin/integrations/keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes })
      });
      keyForm.reset();
      keyForm.classList.add('hidden');
      const banner = $('#apikey-created-banner');
      if (banner && res?.plainKey) {
        banner.className = 'ping-banner';
        banner.innerHTML = `Chave gerada (copie agora, não será exibida novamente): <code>${esc(res.plainKey)}</code> <button type="button" class="btn-secondary" id="btn-copy-new-apikey">Copiar</button>`;
        $('#btn-copy-new-apikey')?.addEventListener('click', (ev) => copyTextWithFeedback(res.plainKey, ev.currentTarget));
      }
      await loadApiIntegrationsPanel();
    } catch (err) {
      opsFeedback('integrations-feedback', err?.message || 'Erro ao gerar chave.', 'error');
    }
  });

  $('#outbound-webhooks-list')?.addEventListener('click', async (e) => {
    const testBtn = e.target.closest('[data-wh-test]');
    if (testBtn) {
      const id = testBtn.getAttribute('data-wh-test');
      testBtn.disabled = true;
      try {
        const res = await api(`/api/admin/integrations/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' });
        showToast({ title: 'Teste de Webhook', message: res?.ok ? `Entregue (HTTP ${res.status})` : `Falhou (${res?.error || res?.status})`, type: res?.ok ? 'info' : 'error' });
        await loadApiIntegrationsPanel();
      } catch (err) {
        showToast({ title: 'Teste de Webhook', message: err?.message || 'Falha ao testar', type: 'error' });
      } finally {
        testBtn.disabled = false;
      }
      return;
    }
    const toggleBtn = e.target.closest('[data-wh-toggle]');
    if (toggleBtn) {
      const id = toggleBtn.getAttribute('data-wh-toggle');
      const currentlyEnabled = toggleBtn.getAttribute('data-enabled') === '1';
      await api(`/api/admin/integrations/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !currentlyEnabled })
      });
      await loadApiIntegrationsPanel();
      return;
    }
    const delBtn = e.target.closest('[data-wh-del]');
    if (delBtn) {
      if (!window.confirm('Excluir este webhook de saída?')) return;
      const id = delBtn.getAttribute('data-wh-del');
      await api(`/api/admin/integrations/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadApiIntegrationsPanel();
    }
  });

  $('#api-keys-list')?.addEventListener('click', async (e) => {
    const revokeBtn = e.target.closest('[data-key-revoke]');
    if (!revokeBtn) return;
    if (!window.confirm('Revogar esta chave de API? Integrações usando ela deixarão de funcionar imediatamente.')) return;
    const id = revokeBtn.getAttribute('data-key-revoke');
    await api(`/api/admin/integrations/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadApiIntegrationsPanel();
  });

  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-snippet-btn');
    if (!copyBtn) return;
    const targetId = copyBtn.getAttribute('data-copy-target');
    const el = targetId ? document.getElementById(targetId) : null;
    if (el) copyTextWithFeedback(el.textContent.trim(), copyBtn);
  });

  // ====================================================================
  // VIEW 6.5: LIA RUNTIME, AUTONOMIA, OBJETIVOS & CONFIGURAÇÃO DE APIS
  // ====================================================================
  const runtimeEscape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setRuntimeFeedback(id, msg, isError = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.className = `admin-feedback ${isError ? 'err' : 'ok'}`;
    el.classList.remove('hidden');
  }


  async function renderUncertainTasks() {
    const listEl = $('#runtime-uncertain-tasks-list');
    if (!listEl) return;
    if ((ROLE_LEVEL[state.role] ?? 0) < ROLE_LEVEL.admin) {
      listEl.innerHTML = '<p class="muted">Área restrita a administradores.</p>';
      return;
    }
    try {
      const data = await api('/api/dashboard/runtime/uncertain-tasks');
      const items = data.items || [];
      if (!items.length) {
        listEl.innerHTML = '<p class="muted">Nenhuma tarefa ou entrega aguarda reconciliação.</p>';
        return;
      }
      listEl.innerHTML = items.map(task => {
        const id = runtimeEscape(task.id);
        const executionUncertain = task.status === 'uncertain';
        const options = executionUncertain
          ? [
              ['confirmed_succeeded', 'Execução confirmada como concluída'],
              ['confirmed_failed', 'Execução confirmada como não concluída'],
              ['still_uncertain', 'Continuar incerta']
            ]
          : [
              ['notification_confirmed_sent', 'Entrega da notificação confirmada'],
              ['notification_confirmed_not_sent', 'Entrega confirmada como não realizada'],
              ['still_uncertain', 'Continuar incerta']
            ];
        const resolved = Boolean(task.reconciledAt && task.reconciliationOutcome !== 'still_uncertain');
        const optionsHtml = options.map(item => '<option value="' + runtimeEscape(item[0]) + '">' + runtimeEscape(item[1]) + '</option>').join('');
        const prior = task.reconciledAt
          ? '<div class="muted" style="font-size:12px;margin-top:8px">Conferência anterior: ' + runtimeEscape(task.reconciliationOutcome || '-') + ' · ' + runtimeEscape(task.reconciledBy || 'admin') + ' · ' + runtimeEscape(new Date(task.reconciledAt).toLocaleString('pt-BR')) + '<br>' + runtimeEscape(task.reconciliationNote || '') + '</div>'
          : '';
        const controls = resolved
          ? '<p class="muted" style="margin-top:8px">Esta tarefa já foi reconciliada. Nenhuma repetição automática será executada.</p>'
          : '<div style="display:grid;gap:8px;margin-top:10px" data-role="admin">'
            + '<label class="field"><span>Resultado verificado</span><select id="rt-uncertain-decision-' + id + '" data-uncertain-decision>' + optionsHtml + '</select></label>'
            + '<label class="field"><span>Evidência da conferência (obrigatória, 10–500 caracteres)</span><textarea id="rt-uncertain-evidence-' + id + '" rows="2" minlength="10" maxlength="500" placeholder="Ex.: Conferi o Drive e confirmei que o arquivo existe; registro verificado..." required></textarea></label>'
            + '<button type="button" class="btn-primary btn-sm" data-task-reconcile="' + id + '">Registrar conferência — sem replay</button>'
            + '</div>';
        return '<article class="panel" style="padding:12px;margin-bottom:8px">'
          + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><strong>Job ' + id.slice(0, 8).toUpperCase() + '</strong><span class="badge-mini">' + runtimeEscape(task.status) + ' · notificação: ' + runtimeEscape(task.notificationStatus) + '</span></div>'
          + '<div class="muted" style="font-size:12px;margin:6px 0">Destino: ' + runtimeEscape(task.target || 'não informado') + ' · Tentativas: ' + Number(task.attemptCount || 0) + ' · Atualizado: ' + (task.updatedAt ? runtimeEscape(new Date(task.updatedAt).toLocaleString('pt-BR')) : '-') + '</div>'
          + '<div style="font-size:13px;margin:6px 0"><strong>Solicitação:</strong> ' + runtimeEscape(task.requestSummary || '-') + '</div>'
          + '<div style="font-size:13px;margin:6px 0"><strong>Ferramentas:</strong> ' + runtimeEscape((task.steps || []).join(', ') || '-') + '</div>'
          + '<div style="font-size:13px;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere"><strong>Último resultado:</strong> ' + runtimeEscape(task.resultText || task.errorCode || 'Sem detalhe registrado') + '</div>'
          + (task.errorCode ? '<div class="muted" style="font-size:11px">Código: ' + runtimeEscape(task.errorCode) + '</div>' : '')
          + prior + controls + '</article>';
      }).join('');
    } catch (error) {
      listEl.innerHTML = '<p class="muted">Não foi possível carregar a fila de reconciliação: ' + runtimeEscape(error.message) + '</p>';
    }
  }

  async function renderRuntimeView() {
    try {
      const data = await api('/api/dashboard/runtime/overview');
      const cardsEl = $('#runtime-status-cards');
      if (cardsEl) {
        const rd = data.readiness || {};
        const m = data.metrics || {};
        cardsEl.innerHTML = [
          `<div class="panel"><div class="muted">Lia Runtime</div><strong>${runtimeEscape(rd.runtime?.status || 'unavailable')} (${runtimeEscape(rd.runtime?.state || 'idle')})</strong><div class="muted">Modo: ${runtimeEscape(rd.runtime?.mode || '-')}</div></div>`,
          `<div class="panel"><div class="muted">Presença &amp; Autonomia</div><strong>${runtimeEscape(data.presence?.state || 'available')}</strong><div class="muted">Nível: ${runtimeEscape(data.policy?.autonomy_level || 'assisted')}</div></div>`,
          `<div class="panel"><div class="muted">Decisões / Ações</div><strong>${Number(m.autonomous_decisions || 0)} / ${Number(m.autonomous_actions || 0)}</strong><div class="muted">Bloqueadas: ${Number(m.blocked_actions || 0)} · Escalações: ${Number(m.human_escalations || 0)}</div></div>`,
          `<div class="panel"><div class="muted">Learning Engine</div><strong>${runtimeEscape(rd.learning?.status || 'unavailable')}</strong><div class="muted">Aprendizados: ${(data.knowledge || []).length} · Propostas: ${(data.proposals || []).length}</div></div>`
        ].join('');
      }

      if (data.policy) {
        const p = data.policy;
        if ($('#rt-policy-level')) $('#rt-policy-level').value = p.autonomy_level || 'assisted';
        if ($('#rt-limit-actions')) $('#rt-limit-actions').value = p.daily_limits?.maxActionsPerHour ?? 30;
        if ($('#rt-limit-outbound')) $('#rt-limit-outbound').value = p.daily_limits?.maxOutboundPerDay ?? 50;
        if ($('#rt-limit-experiments')) $('#rt-limit-experiments').value = p.daily_limits?.maxExperimentsPerDay ?? 3;
        if ($('#rt-comm-cooldown')) $('#rt-comm-cooldown').value = Math.round((p.communication_policy?.cooldownMs ?? 1800000) / 60000);
        if ($('#rt-comm-max-day')) $('#rt-comm-max-day').value = p.communication_policy?.maxProactivePerDay ?? 12;
        if ($('#rt-toggle-learning')) $('#rt-toggle-learning').checked = p.learning_policy?.enabled !== false;
        if ($('#rt-toggle-experiments')) $('#rt-toggle-experiments').checked = p.experiment_policy?.enabled !== false;
        if ($('#rt-toggle-outbound-human')) $('#rt-toggle-outbound-human').checked = p.approval_policy?.requireHumanForOutbound !== false;
        const allowed = new Set(p.allowed_actions || []);
        document.querySelectorAll('.rt-action-cb').forEach(cb => { cb.checked = allowed.has(cb.value); });
      }

      const goalsEl = $('#runtime-goals-list');
      if (goalsEl) {
        const goals = data.goals || [];
        goalsEl.innerHTML = goals.length ? goals.map(g => `
          <div class="panel" style="padding:10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong>${runtimeEscape(g.title)}</strong>
              <span class="badge-mini">${runtimeEscape(g.status)} · ${runtimeEscape(g.priority)} · ${Number(g.progress || 0)}%</span>
            </div>
            <div class="muted" style="font-size:12px;margin:4px 0">Indicador: ${runtimeEscape(g.indicator || '-')}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" data-role="admin">
              ${g.status === 'active' ? `<button type="button" class="btn-secondary" data-goal-act="pause" data-goal-id="${runtimeEscape(g.id)}">Pausar</button>` : ''}
              ${g.status === 'paused' || g.status === 'draft' ? `<button type="button" class="btn-secondary" data-goal-act="resume" data-goal-id="${runtimeEscape(g.id)}">Ativar</button>` : ''}
              ${g.status !== 'completed' ? `<button type="button" class="btn-secondary" data-goal-act="complete" data-goal-id="${runtimeEscape(g.id)}">Concluir</button>` : ''}
              ${g.status !== 'cancelled' ? `<button type="button" class="btn-secondary" data-goal-act="cancel" data-goal-id="${runtimeEscape(g.id)}">Cancelar</button>` : ''}
            </div>
          </div>
        `).join('') : '<p class="muted">Nenhum objetivo cadastrado.</p>';
      }

      const commEl = $('#runtime-commitments-list');
      if (commEl) {
        const items = data.commitments || [];
        commEl.innerHTML = items.length ? items.map(c => `
          <div class="panel" style="padding:10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong>${runtimeEscape(c.title)}</strong>
              <span class="badge-mini">${runtimeEscape(c.status)}</span>
            </div>
            <div class="muted" style="font-size:12px;margin:4px 0">Contato: ${runtimeEscape(c.subject || '-')} · Prazo: ${c.due_at ? new Date(c.due_at).toLocaleString('pt-BR') : '-'}</div>
            <div style="display:flex;gap:6px;margin-top:6px" data-role="admin">
              ${c.status === 'pending' || c.status === 'in_progress' ? `<button type="button" class="btn-secondary" data-commit-act="fulfill" data-commit-id="${runtimeEscape(c.id)}">Concluir</button><button type="button" class="btn-secondary" data-commit-act="cancel" data-commit-id="${runtimeEscape(c.id)}">Cancelar</button>` : ''}
            </div>
          </div>
        `).join('') : '<p class="muted">Nenhum compromisso registrado.</p>';
      }

      const propEl = $('#runtime-proposals-list');
      if (propEl) {
        const props = data.proposals || [];
        propEl.innerHTML = props.length ? props.map(pr => `
          <div class="panel" style="padding:10px;margin-bottom:8px">
            <div><strong>${runtimeEscape(pr.proposal_type)}</strong> <span class="badge-mini">${runtimeEscape(pr.status)}</span></div>
            <div class="muted" style="font-size:12px;margin:4px 0">${runtimeEscape(pr.summary)}</div>
            ${pr.status === 'pending_human_review' ? `<div style="display:flex;gap:6px;margin-top:6px" data-role="admin"><button type="button" class="btn-secondary" data-prop-status="approved" data-prop-id="${runtimeEscape(pr.id)}">Aprovar</button><button type="button" class="btn-secondary" data-prop-status="rejected" data-prop-id="${runtimeEscape(pr.id)}">Rejeitar</button></div>` : ''}
          </div>
        `).join('') : '<p class="muted">Nenhuma proposta pendente.</p>';
      }

      const knowEl = $('#runtime-knowledge-list');
      if (knowEl) {
        const list = (data.knowledge || []).slice(0, 10);
        knowEl.innerHTML = list.length ? `<h4>Aprendizados Recentes</h4>` + list.map(k => `
          <div class="panel" style="padding:8px;margin-bottom:6px;font-size:13px">
            <strong>[${runtimeEscape(k.scope)} · ${runtimeEscape(k.status)}]</strong> ${runtimeEscape(k.content)}
            <div class="muted" style="font-size:11px">Confiança: ${Math.round(Number(k.confidence || 0) * 100)}% · Evidências: ${Number(k.evidence_count || 0)}</div>
          </div>
        `).join('') : '';
      }

      await renderUncertainTasks();

      const decEl = $('#runtime-decisions-list');
      if (decEl) {
        const list = (data.decisions || []).slice(0, 15);
        decEl.innerHTML = list.length ? list.map(d => `
          <div class="panel" style="padding:8px;margin-bottom:6px;font-size:13px">
            <div><strong>${runtimeEscape(d.proposed_action || d.decision_action)}</strong> <span class="badge-mini">${runtimeEscape(d.authorization_decision || d.authorization?.decision || '-')}</span></div>
            <div class="muted" style="font-size:12px">${runtimeEscape(d.why || '')}</div>
          </div>
        `).join('') : '<p class="muted">Nenhuma decisão autônoma registrada ainda.</p>';
      }

      if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.admin) {
        await loadApiSettingsPanel();
        await loadParaMemoriesPanel();
      }
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Erro ao carregar Runtime: ${err.message}`, true);
    }
  }

  let activeParaCategory = '';
  const PARA_LABELS = { project: 'Projeto', area: 'Área', resource: 'Recurso', archive: 'Arquivo' };

  async function loadParaMemoriesPanel(category = activeParaCategory) {
    const listEl = $('#para-memories-list');
    if (!listEl) return;
    activeParaCategory = category || '';
    try {
      const qs = activeParaCategory ? `?category=${encodeURIComponent(activeParaCategory)}` : '';
      const data = await api(`/api/dashboard/memories${qs}`);
      const counts = data.counts || {};
      document.querySelectorAll('.para-filter-btn').forEach(btn => {
        const cat = btn.dataset.paraCat || '';
        const count = cat ? (counts[cat] || 0) : (counts.total || 0);
        const base = cat ? (PARA_LABELS[cat] || cat) : 'Todos';
        btn.textContent = `${base} (${count})`;
        btn.classList.toggle('active', cat === activeParaCategory);
      });
      const items = data.items || [];
      if (!items.length) {
        listEl.innerHTML = '<p class="muted">Nenhuma memória nesta categoria ainda.</p>';
        return;
      }
      listEl.innerHTML = items.map(m => `
        <div class="panel" style="padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
              <span class="badge-mini">${runtimeEscape(PARA_LABELS[m.category] || m.category)}</span>
              <span class="muted" style="font-size:11px">${runtimeEscape(m.scopeKey)} · ${runtimeEscape(m.source || 'conversa')}</span>
            </div>
            <div style="font-size:13px;word-break:break-word">${runtimeEscape(m.content)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="btn-secondary btn-sm para-edit-btn" data-mem-id="${runtimeEscape(m.id)}" data-mem-content="${runtimeEscape(m.content)}" data-mem-cat="${runtimeEscape(m.category)}">Editar</button>
            <button type="button" class="btn-secondary btn-sm para-del-btn" data-mem-id="${runtimeEscape(m.id)}">Apagar</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<p class="muted">Erro ao carregar memórias: ${runtimeEscape(err.message)}</p>`;
    }
  }

  document.addEventListener('click', async (ev) => {
    const filterBtn = ev.target.closest?.('.para-filter-btn');
    if (filterBtn) {
      await loadParaMemoriesPanel(filterBtn.dataset.paraCat || '');
      return;
    }
    const delBtn = ev.target.closest?.('.para-del-btn');
    if (delBtn) {
      const id = delBtn.dataset.memId;
      if (!id || !confirm('Apagar esta memória definitivamente?')) return;
      await api(`/api/dashboard/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadParaMemoriesPanel();
      return;
    }
    const editBtn = ev.target.closest?.('.para-edit-btn');
    if (editBtn) {
      const id = editBtn.dataset.memId;
      const nextContent = prompt('Editar conteúdo da memória:', editBtn.dataset.memContent || '');
      if (!nextContent || !nextContent.trim()) return;
      await api(`/api/dashboard/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: nextContent.trim() })
      });
      await loadParaMemoriesPanel();
    }
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target?.id !== 'para-memory-form') return;
    ev.preventDefault();
    const contentEl = $('#para-memory-content');
    const catEl = $('#para-memory-category');
    const content = contentEl?.value?.trim();
    if (!content) return;
    try {
      await api('/api/dashboard/memories', {
        method: 'POST',
        body: JSON.stringify({ content, category: catEl?.value || 'area', scopeKey: 'default:business' })
      });
      if (contentEl) contentEl.value = '';
      await loadParaMemoriesPanel();
      setRuntimeFeedback('#runtime-feedback', 'Memória salva no sistema PARA!');
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Erro ao salvar memória: ${err.message}`, true);
    }
  });

  function renderApiSettingsCards(items = []) {
    return items.map(item => `
      <div class="panel" style="padding:10px">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;margin-bottom:6px">
          <strong style="font-size:13px">${runtimeEscape(item.label)}</strong>
          <span class="badge-mini">${item.source === 'panel' ? 'Painel' : (item.source === 'env' ? 'VPS (.env)' : 'Vazio')}</span>
        </div>
        <input
          type="${item.secret ? 'password' : (item.isNumber ? 'number' : 'text')}"
          class="api-setting-input"
          data-api-key="${runtimeEscape(item.key)}"
          data-is-secret="${item.secret ? '1' : '0'}"
          placeholder="${item.secret ? (item.configured ? `Atual: ${runtimeEscape(item.masked)} (digite para trocar)` : 'Digite a chave...') : 'Digite o valor...'}"
          value="${item.secret ? '' : runtimeEscape(item.value)}"
          style="width:100%"
        >
        ${item.source === 'panel' ? `<button type="button" class="btn-secondary api-setting-clear" data-clear-key="${runtimeEscape(item.key)}" style="margin-top:6px;font-size:11px">Voltar para .env</button>` : ''}
      </div>
    `).join('');
  }

  async function loadApiSettingsPanel() {
    if ((ROLE_LEVEL[state.role] ?? 0) < ROLE_LEVEL.admin) return;
    const aiGrid = $('#api-settings-grid');
    const googleGrid = $('#tools-google-api-grid');
    const intGrid = $('#integrations-api-grid');
    if (!aiGrid && !googleGrid && !intGrid) return;
    try {
      const data = await api('/api/dashboard/api-settings');
      const items = data.items || [];
      if (aiGrid) {
        const aiItems = items.filter(i => i.group === 'ai');
        aiGrid.innerHTML = aiItems.length ? renderApiSettingsCards(aiItems) : '<p class="muted">Nenhum provedor de IA listado.</p>';
      }
      if (googleGrid) {
        // Mostra apenas credenciais de autenticação (Client ID/Secret + Service Account);
        // os IDs de Agenda/Pasta/Planilha agora ficam nos seletores visuais (Passo 2) sem duplicação!
        const authOnlyKeys = new Set(['googleClientId', 'googleClientSecret', 'googleServiceAccountEmail', 'googleServiceAccountPrivateKey']);
        const googleItems = items.filter(i => i.group === 'google' && authOnlyKeys.has(i.key));
        googleGrid.innerHTML = googleItems.length ? renderApiSettingsCards(googleItems) : '<p class="muted">Nenhuma credencial Google listada.</p>';
      }
      if (intGrid) {
        const intItems = items.filter(i => i.group === 'whatsapp' || i.group === 'integrations');
        intGrid.innerHTML = intItems.length ? renderApiSettingsCards(intItems) : '<p class="muted">Nenhuma integração listada.</p>';
      }
    } catch (err) {
      const msg = `<p class="muted">Indisponível: ${runtimeEscape(err.message)}</p>`;
      if (aiGrid) aiGrid.innerHTML = msg;
      if (googleGrid) googleGrid.innerHTML = msg;
      if (intGrid) intGrid.innerHTML = msg;
    }
  }
  window.loadApiSettingsGroup = async () => {
    await loadApiSettingsPanel();
    await loadGoogleOAuthStatus();
    await loadGoogleWorkspaceResourcesPicker();
  };

  $('#runtime-refresh-btn')?.addEventListener('click', () => renderRuntimeView());
  $('#runtime-uncertain-refresh')?.addEventListener('click', () => renderUncertainTasks());

  $('#runtime-wake-btn')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/dashboard/runtime/wake', { method: 'POST', body: '{}' });
      setRuntimeFeedback('#runtime-feedback', `Runtime acordado: ${res.summary?.processedEvents || 0} evento(s), ${res.summary?.tasksCreated || 0} tarefa(s).`);
      await renderRuntimeView();
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Falha ao acordar Runtime: ${err.message}`, true);
    }
  });

  $('#runtime-policy-save')?.addEventListener('click', async () => {
    try {
      const allowed_actions = Array.from(document.querySelectorAll('.rt-action-cb:checked')).map(cb => cb.value);
      const payload = {
        tenant_id: 'default',
        autonomy_level: $('#rt-policy-level')?.value || 'assisted',
        allowed_actions,
        approval_policy: {
          requireHumanForOutbound: Boolean($('#rt-toggle-outbound-human')?.checked),
          requireHumanForPix: true
        },
        daily_limits: {
          maxActionsPerHour: Number($('#rt-limit-actions')?.value || 30),
          maxOutboundPerDay: Number($('#rt-limit-outbound')?.value || 50),
          maxExperimentsPerDay: Number($('#rt-limit-experiments')?.value || 3)
        },
        communication_policy: {
          cooldownMs: Number($('#rt-comm-cooldown')?.value || 30) * 60000,
          maxProactivePerDay: Number($('#rt-comm-max-day')?.value || 12)
        },
        learning_policy: { enabled: Boolean($('#rt-toggle-learning')?.checked) },
        experiment_policy: { enabled: Boolean($('#rt-toggle-experiments')?.checked) }
      };
      await api('/api/dashboard/runtime/policy', { method: 'PUT', body: JSON.stringify(payload) });
      setRuntimeFeedback('#runtime-feedback', 'Política de autonomia salva e persistida com sucesso!');
      await renderRuntimeView();
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Erro ao salvar política: ${err.message}`, true);
    }
  });

  $('#runtime-goal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/dashboard/runtime/goals', {
        method: 'POST',
        body: JSON.stringify({
          title: $('#rt-goal-title')?.value,
          indicator: $('#rt-goal-indicator')?.value,
          priority: $('#rt-goal-priority')?.value || 'medium',
          status: 'active'
        })
      });
      if ($('#rt-goal-title')) $('#rt-goal-title').value = '';
      if ($('#rt-goal-indicator')) $('#rt-goal-indicator').value = '';
      setRuntimeFeedback('#runtime-feedback', 'Objetivo criado com sucesso!');
      await renderRuntimeView();
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Erro ao criar objetivo: ${err.message}`, true);
    }
  });

  $('#runtime-commitment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const dueRaw = $('#rt-commit-due')?.value;
      await api('/api/dashboard/runtime/commitments', {
        method: 'POST',
        body: JSON.stringify({
          title: $('#rt-commit-title')?.value,
          subject: $('#rt-commit-subject')?.value,
          dueAt: dueRaw ? new Date(dueRaw).toISOString() : ''
        })
      });
      if ($('#rt-commit-title')) $('#rt-commit-title').value = '';
      if ($('#rt-commit-subject')) $('#rt-commit-subject').value = '';
      setRuntimeFeedback('#runtime-feedback', 'Compromisso registrado!');
      await renderRuntimeView();
    } catch (err) {
      setRuntimeFeedback('#runtime-feedback', `Erro ao criar compromisso: ${err.message}`, true);
    }
  });

  $('#runtime-view')?.addEventListener('click', async (e) => {
    const reconcileBtn = e.target.closest('[data-task-reconcile]');
    if (reconcileBtn) {
      if ((ROLE_LEVEL[state.role] ?? 0) < ROLE_LEVEL.admin) return;
      const taskId = reconcileBtn.dataset.taskReconcile;
      const decision = $('#rt-uncertain-decision-' + taskId)?.value || '';
      const evidence = $('#rt-uncertain-evidence-' + taskId)?.value || '';
      if (evidence.trim().length < 10) {
        setRuntimeFeedback('#runtime-feedback', 'Descreva a evidência da conferência (mínimo de 10 caracteres).', true);
        return;
      }
      try {
        const result = await api('/api/dashboard/runtime/tasks/' + encodeURIComponent(taskId) + '/reconcile', {
          method: 'POST',
          body: JSON.stringify({ decision, evidence })
        });
        setRuntimeFeedback('#runtime-feedback', result.auditFinalized === false
          ? 'Estado reconciliado e salvo no job. O evento final da auditoria ficou pendente; não clique novamente, pois nenhuma execução foi repetida.'
          : 'Conferência registrada e auditada. Nenhuma tarefa, cobrança ou mensagem foi repetida.');
        await renderUncertainTasks();
      } catch (error) {
        setRuntimeFeedback('#runtime-feedback', 'Falha ao reconciliar tarefa: ' + error.message, true);
      }
      return;
    }
    const goalBtn = e.target.closest('[data-goal-act]');
    if (goalBtn) {
      await api(`/api/dashboard/runtime/goals/${encodeURIComponent(goalBtn.dataset.goalId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: goalBtn.dataset.goalAct })
      });
      await renderRuntimeView();
      return;
    }
    const commitBtn = e.target.closest('[data-commit-act]');
    if (commitBtn) {
      await api(`/api/dashboard/runtime/commitments/${encodeURIComponent(commitBtn.dataset.commitId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: commitBtn.dataset.commitAct })
      });
      await renderRuntimeView();
      return;
    }
    const propBtn = e.target.closest('[data-prop-status]');
    if (propBtn) {
      await api(`/api/dashboard/runtime/proposals/${encodeURIComponent(propBtn.dataset.propId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: propBtn.dataset.propStatus })
      });
      await renderRuntimeView();
      return;
    }
    const clearBtn = e.target.closest('[data-clear-key]');
    if (clearBtn) {
      try {
        await api('/api/dashboard/api-settings', {
          method: 'PUT',
          body: JSON.stringify({ [clearBtn.dataset.clearKey]: '__CLEAR__' })
        });
        setRuntimeFeedback('#api-settings-feedback', `Campo ${clearBtn.dataset.clearKey} restaurado para .env.`);
        await loadApiSettingsPanel();
        await refreshConfiguredProviders({ reloadCatalogs: true });
      } catch (err) {
        setRuntimeFeedback('#api-settings-feedback', `Erro ao limpar: ${err.message}`, true);
      }
    }
  });

  async function saveApiSettingsFromContainer(gridSelector, feedbackSelector) {
    try {
      const container = $(gridSelector);
      const payload = {};
      (container || document).querySelectorAll('.api-setting-input').forEach(input => {
        const key = input.dataset.apiKey;
        const val = String(input.value || '').trim();
        if (val) payload[key] = val;
      });
      const res = await api('/api/dashboard/api-settings', { method: 'PUT', body: JSON.stringify(payload) });
      setRuntimeFeedback(feedbackSelector, `Aplicado em tempo real (hot-reload): ${(res.changedKeys || []).join(', ') || 'nenhuma alteração'}.`);
      await loadApiSettingsPanel();
      await refreshConfiguredProviders({ reloadCatalogs: true });
    } catch (err) {
      setRuntimeFeedback(feedbackSelector, `Erro ao salvar: ${err.message}`, true);
    }
  }

  async function loadGoogleWorkspaceResourcesPicker() {
    if ((ROLE_LEVEL[state.role] ?? 0) < ROLE_LEVEL.admin) return;
    const calSel = $('#google-pick-calendar');
    const folderSel = $('#google-pick-folder');
    const sheetSel = $('#google-pick-sheet');
    if (!calSel || !folderSel || !sheetSel) return;
    try {
      const data = await api('/api/dashboard/oauth/google/resources');
      if (!data?.connected) {
        calSel.innerHTML = '<option value="primary">Conecte sua conta Google acima para listar agendas</option>';
        folderSel.innerHTML = '<option value="">Conecte sua conta Google acima para listar pastas</option>';
        sheetSel.innerHTML = '<option value="">Conecte sua conta Google acima para listar planilhas</option>';
        return;
      }
      const selCal = data.selected?.googleCalendarId || 'primary';
      const selFolder = data.selected?.googleDriveFolderId || '';
      const selSheet = data.selected?.googleSheetsDefaultId || '';

      const calOpts = [{ id: 'primary', name: 'Agenda Principal (primary)' }, ...(data.calendars || []).filter(c => c.id !== 'primary')];
      if (selCal && !calOpts.some(c => c.id === selCal)) calOpts.push({ id: selCal, name: selCal });
      calSel.innerHTML = calOpts.map(c => `<option value="${runtimeEscape(c.id)}" ${c.id === selCal ? 'selected' : ''}>${runtimeEscape(c.name)}${c.primary ? ' (Principal)' : ''}</option>`).join('');

      const folderOpts = [{ id: '', name: 'Todo o Meu Drive (sem restrição)' }, ...(data.folders || [])];
      if (selFolder && !folderOpts.some(f => f.id === selFolder)) folderOpts.push({ id: selFolder, name: `Pasta atual (${selFolder})` });
      folderSel.innerHTML = folderOpts.map(f => `<option value="${runtimeEscape(f.id)}" ${f.id === selFolder ? 'selected' : ''}>${runtimeEscape(f.name)}</option>`).join('');

      const sheetOpts = [{ id: '', name: 'Nenhuma planilha padrão' }, ...(data.spreadsheets || [])];
      if (selSheet && !sheetOpts.some(s => s.id === selSheet)) sheetOpts.push({ id: selSheet, name: `Planilha atual (${selSheet})` });
      sheetSel.innerHTML = sheetOpts.map(s => `<option value="${runtimeEscape(s.id)}" ${s.id === selSheet ? 'selected' : ''}>${runtimeEscape(s.name)}</option>`).join('');
    } catch {}
  }

  $('#google-resources-refresh')?.addEventListener('click', async () => {
    setRuntimeFeedback('#tools-google-api-feedback', 'Atualizando agendas, pastas e planilhas da sua conta Google…');
    await loadGoogleWorkspaceResourcesPicker();
    setRuntimeFeedback('#tools-google-api-feedback', 'Listas do Google Workspace atualizadas!');
  });

  $('#google-resources-save')?.addEventListener('click', async () => {
    try {
      const payload = {
        googleCalendarId: $('#google-pick-calendar')?.value || 'primary',
        googleDriveFolderId: $('#google-pick-folder')?.value || '__CLEAR__',
        googleSheetsDefaultId: $('#google-pick-sheet')?.value || '__CLEAR__'
      };
      await api('/api/dashboard/api-settings', { method: 'PUT', body: JSON.stringify(payload) });
      setRuntimeFeedback('#tools-google-api-feedback', '✅ Conteúdo padrão do Google Workspace salvo e aplicado em tempo real!');
    } catch (err) {
      setRuntimeFeedback('#tools-google-api-feedback', `Erro ao salvar seleção: ${err.message}`, true);
    }
  });

  async function loadGoogleOAuthStatus() {
    if ((ROLE_LEVEL[state.role] ?? 0) < ROLE_LEVEL.admin) return;
    const badge = $('#google-oauth-badge');
    const uriEl = $('#google-oauth-redirect-uri');
    const discBtn = $('#google-oauth-disconnect-btn');
    const advEl = $('#google-oauth-advanced');
    if (!badge) return;
    try {
      const st = await api('/api/dashboard/oauth/google/status');
      const redirectUri = `${window.location.origin}/api/oauth/google/callback`;
      if (uriEl) uriEl.textContent = redirectUri;
      if (st.connected) {
        badge.textContent = 'Conectado (OAuth2)';
        badge.className = 'badge-mini ok';
        discBtn?.classList.remove('hidden');
        if (advEl) advEl.open = false;
      } else if (st.serviceAccountConfigured) {
        badge.textContent = 'Service Account Ativa';
        badge.className = 'badge-mini ok';
        discBtn?.classList.add('hidden');
      } else if (st.clientConfigured) {
        badge.textContent = 'Pronto para conectar';
        badge.className = 'badge-mini warn';
        discBtn?.classList.add('hidden');
      } else {
        badge.textContent = 'Informe Client ID + Secret';
        badge.className = 'badge-mini';
        discBtn?.classList.add('hidden');
        if (advEl) advEl.open = true;
      }
    } catch {}
  }

  $('#google-oauth-copy-uri')?.addEventListener('click', () => {
    const uri = $('#google-oauth-redirect-uri')?.textContent?.trim();
    if (!uri || uri === '-') return;
    navigator.clipboard?.writeText(uri).catch(() => {});
    setRuntimeFeedback('#tools-google-api-feedback', `Redirect URI copiada: ${uri}`);
  });

  $('#google-oauth-connect-btn')?.addEventListener('click', async () => {
    const scopes = Array.from(document.querySelectorAll('.google-scope-cb:checked')).map(cb => cb.value);
    if (!scopes.length) {
      setRuntimeFeedback('#tools-google-api-feedback', 'Selecione ao menos um serviço do Google para conceder acesso.', true);
      return;
    }
    try {
      const res = await api('/api/dashboard/oauth/google/start', {
        method: 'POST',
        body: JSON.stringify({ scopes, origin: window.location.origin })
      });
      if (!res?.authUrl) throw new Error('URL OAuth não retornada.');
      window.open(res.authUrl, 'lia_google_oauth', 'width=560,height=680,noopener=no');
      setRuntimeFeedback('#tools-google-api-feedback', 'Janela de autorização do Google aberta! Conclua o login e aceite as permissões.');
    } catch (err) {
      setRuntimeFeedback('#tools-google-api-feedback', err.message || 'Salve primeiro o Client ID e Client Secret abaixo.', true);
      const advEl = $('#google-oauth-advanced');
      if (advEl) advEl.open = true;
    }
  });

  $('#google-oauth-disconnect-btn')?.addEventListener('click', async () => {
    if (!confirm('Desconectar a conta Google Workspace da Lia?')) return;
    try {
      await api('/api/dashboard/oauth/google/disconnect', { method: 'POST', body: '{}' });
      setRuntimeFeedback('#tools-google-api-feedback', 'Conta Google desconectada.');
      await loadGoogleOAuthStatus();
      await loadApiSettingsPanel();
    } catch (err) {
      setRuntimeFeedback('#tools-google-api-feedback', `Erro ao desconectar: ${err.message}`, true);
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.type === 'lia-google-oauth-success') {
      const email = ev.data.email ? ` (${ev.data.email})` : '';
      setRuntimeFeedback('#tools-google-api-feedback', `✅ Google Workspace conectado${email}! Ferramentas Google prontas em tempo real.`);
      void loadGoogleOAuthStatus();
      void loadApiSettingsPanel();
      void loadGoogleWorkspaceResourcesPicker();
      if (state.view === 'tools') renderTools();
    } else if (ev.data?.type === 'lia-google-oauth-error') {
      setRuntimeFeedback('#tools-google-api-feedback', `Falha na conexão Google: ${ev.data.error || 'erro desconhecido'}`, true);
    }
  });

  $('#api-settings-save')?.addEventListener('click', () => saveApiSettingsFromContainer('#api-settings-grid', '#api-settings-feedback'));
  $('#tools-google-api-save')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await saveApiSettingsFromContainer('#tools-google-api-grid', '#tools-google-api-feedback');
    await loadGoogleOAuthStatus();
  });
  $('#integrations-api-save')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void saveApiSettingsFromContainer('#integrations-api-grid', '#integrations-api-feedback');
  });

  // ====================================================================
  // GESTOR INLINE DE PROVEDORES DE IA (CUSTOM PROVIDERS + API HOT-RELOAD)
  // ====================================================================
  async function loadCustomProvidersInline() {
    const listEl = $('#custom-providers-list');
    if (!listEl) return;
    try {
      const data = await api('/api/dashboard/ai-providers');
      const items = data.customProviders || [];
      const breakers = data.circuitBreakers || {};
      listEl.innerHTML = items.length ? items.map(p => {
        const cb = breakers[p.id] || {};
        const rateInfo = (p.inputUsdPerMillion !== null && p.outputUsdPerMillion !== null)
          ? ` · $${p.inputUsdPerMillion}/$${p.outputUsdPerMillion} por 1M`
          : '';
        const errInfo = cb.lastError ? `<div class="muted" style="color:#f59e0b;font-size:11px;margin-top:3px">⚠️ ${runtimeEscape(cb.lastError)}</div>` : '';
        return `
          <div class="panel" style="padding:8px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div>
              <strong>${runtimeEscape(p.name)}</strong> <span class="badge-mini">${runtimeEscape(p.id)} · ${runtimeEscape(cb.status || 'operacional')}</span>
              <div class="muted" style="font-size:12px">${runtimeEscape(p.defaultModel)} · ${runtimeEscape(p.baseUrl)}${rateInfo}</div>
              ${errInfo}
            </div>
            <button type="button" class="btn-secondary btn-sm" data-del-custom-prov="${runtimeEscape(p.id)}">Remover</button>
          </div>
        `;
      }).join('') : '<p class="muted" style="font-size:12px">Nenhum provedor customizado cadastrado ainda.</p>';
    } catch (err) {
      listEl.innerHTML = `<p class="muted">${runtimeEscape(err.message)}</p>`;
    }
  }

  window.loadAiHubExtras = async () => {
    if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.admin) {
      await Promise.allSettled([
        loadCustomProvidersInline(),
        loadApiSettingsPanel()
      ]);
    }
  };

  $('#overview-providers-toggle')?.addEventListener('click', () => {
    showView('ai-hub');
  });


  $('#admin-go-ai-hub')?.addEventListener('click', () => {
    showView('ai-hub');
  });

  $('#ai-hub-save-draft')?.addEventListener('click', async () => {
    try {
      await saveAdminDraft?.();
      setRuntimeFeedback('#ai-hub-feedback', 'Rascunho do Motor de IA salvo! Clique em "Publicar Motor IA" para ativar no atendimento.');
    } catch (err) {
      setRuntimeFeedback('#ai-hub-feedback', `Erro ao salvar rascunho: ${err.message}`, true);
    }
  });

  $('#ai-hub-publish')?.addEventListener('click', () => {
    document.getElementById('admin-publish')?.click();
  });

  $('#custom-provider-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        id: $('#cp-id')?.value?.trim().toLowerCase(),
        name: $('#cp-name')?.value?.trim(),
        baseUrl: $('#cp-url')?.value?.trim(),
        apiKey: $('#cp-key')?.value?.trim(),
        defaultModel: $('#cp-model')?.value?.trim(),
        inputUsdPerMillion: $('#cp-rate-in')?.value === '' ? null : Number($('#cp-rate-in')?.value),
        outputUsdPerMillion: $('#cp-rate-out')?.value === '' ? null : Number($('#cp-rate-out')?.value)
      };
      await api('/api/dashboard/ai-providers', { method: 'POST', body: JSON.stringify(payload) });
      setRuntimeFeedback('#overview-providers-feedback', `Provedor "${payload.name}" (${payload.id}) cadastrado e pronto para roteamento/contingência!`);
      ['#cp-id', '#cp-name', '#cp-url', '#cp-key', '#cp-model', '#cp-rate-in', '#cp-rate-out'].forEach(sel => { if ($(sel)) $(sel).value = ''; });
      await loadCustomProvidersInline();
      await refreshConfiguredProviders({ reloadCatalogs: true });
      renderOverview?.();
    } catch (err) {
      setRuntimeFeedback('#overview-providers-feedback', `Erro ao salvar provedor: ${err.message}`, true);
    }
  });

  $('#custom-providers-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-custom-prov]');
    if (!btn) return;
    const id = btn.dataset.delCustomProv;
    if (!window.confirm(`Remover o provedor customizado "${id}"?`)) return;
    await api(`/api/dashboard/ai-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setRuntimeFeedback('#overview-providers-feedback', `Provedor "${id}" removido.`);
    await loadCustomProvidersInline();
    await refreshConfiguredProviders({ reloadCatalogs: true });
    renderOverview?.();
  });

  // ====================================================================
  // WHATSAPP NATIVO (BAILEYS EMBUTIDO - QR CODE & PAIRING CODE)
  // ====================================================================
  let baileysPollTimer = null;

  function renderBaileysState(data = {}) {
    const status = data.status || 'disconnected';
    const badge = $('#baileys-status-badge');
    if (badge) {
      const labelMap = {
        connected: '🟢 Conectado',
        qr_ready: '🟡 Aguardando leitura do QR Code',
        connecting: '🟡 Conectando ao WhatsApp…',
        logged_out: '🔴 Desconectado (Sessão encerrada)',
        error: '🔴 Erro de conexão',
        disconnected: '⚪ Desconectado'
      };
      badge.textContent = labelMap[status] || status;
    }
    if ($('#baileys-active-engine')) {
      $('#baileys-active-engine').textContent = data.activeEngine === 'baileys'
        ? 'Baileys Nativo (WebSocket direto na Lia)'
        : 'Evolution API (Container externo)';
    }
    if ($('#baileys-engine-select') && data.activeEngine) {
      $('#baileys-engine-select').value = data.activeEngine;
    }
    if ($('#baileys-phone')) {
      $('#baileys-phone').textContent = data.phone ? `+${data.phone}${data.name ? ` (${data.name})` : ''}` : 'Não conectado';
    }
    if ($('#baileys-last-msg')) {
      $('#baileys-last-msg').textContent = data.lastMessageAt ? new Date(data.lastMessageAt).toLocaleString('pt-BR') : 'Nenhuma nesta sessão';
    }
    if ($('#baileys-msg-in')) $('#baileys-msg-in').textContent = String(data.stats?.messagesReceived || 0);
    if ($('#baileys-msg-out')) $('#baileys-msg-out').textContent = String(data.stats?.messagesSent || 0);
    if ($('#baileys-msg-filtered')) $('#baileys-msg-filtered').textContent = String(data.stats?.messagesFiltered || 0);
    if ($('#baileys-mem-stats')) {
      const rss = data.stats?.rssMb ? `${data.stats.rssMb} MB RSS` : '-';
      const sig = data.stats?.persistedSessions !== undefined ? ` · ${data.stats.persistedSessions} sessões / ${data.stats.ephemeralKeysInRam || 0} LRU` : '';
      $('#baileys-mem-stats').textContent = `${rss}${sig}`;
    }
    if ($('#baileys-error-box')) $('#baileys-error-box').textContent = data.lastError || '';
    if ($('#baileys-pair-code-display') && data.pairingCode) {
      $('#baileys-pair-code-display').textContent = `Código: ${data.pairingCode}`;
    }

    const qrBox = $('#baileys-qr-container');
    if (qrBox) {
      if (status === 'connected') {
        qrBox.innerHTML = `<div style="padding:18px;color:#10b981;font-weight:600">✅ WhatsApp conectado via Baileys Nativo!<br><span class="muted" style="font-size:12px;font-weight:400">+${runtimeEscape(data.phone || '')} · Eventos em tempo real ativos</span></div>`;
      } else if (status === 'qr_ready' && data.qrDataUrl) {
        qrBox.innerHTML = `<img src="${runtimeEscape(data.qrDataUrl)}" alt="QR Code WhatsApp Baileys" style="width:230px;height:230px;border-radius:10px;background:#fff;padding:8px" />`;
      } else if (status === 'connecting') {
        qrBox.innerHTML = `<p class="muted">Negociando WebSocket com o WhatsApp… O QR Code aparecerá em instantes.</p>`;
      } else {
        qrBox.innerHTML = `<p class="muted" style="max-width:260px">Clique em <strong>Conectar / Gerar QR Code</strong> para iniciar uma sessão Baileys diretamente na Lia.</p>`;
      }
    }

    if (state.view === 'integrations' && !baileysPollTimer) {
      baileysPollTimer = setInterval(() => {
        if (state.view !== 'integrations') {
          clearInterval(baileysPollTimer);
          baileysPollTimer = null;
          return;
        }
        window.loadBaileysPanel?.({ silent: true });
      }, 2500);
    }
  }

  window.loadBaileysPanel = async ({ silent = false } = {}) => {
    try {
      const data = await api('/api/dashboard/whatsapp/baileys');
      renderBaileysState(data);
    } catch (err) {
      if (!silent) setRuntimeFeedback('#baileys-feedback', `Erro ao consultar Baileys: ${err.message}`, true);
    }
  };

  $('#baileys-engine-select')?.addEventListener('change', async (e) => {
    try {
      const engine = e.target.value;
      const res = await api('/api/dashboard/whatsapp/baileys/engine', {
        method: 'POST',
        body: JSON.stringify({ engine })
      });
      renderBaileysState(res);
      setRuntimeFeedback('#baileys-feedback', `Motor WhatsApp alterado para: ${engine === 'baileys' ? 'Baileys Nativo' : 'Evolution API'}.`);
    } catch (err) {
      setRuntimeFeedback('#baileys-feedback', `Erro ao alternar motor: ${err.message}`, true);
    }
  });

  $('#baileys-connect-btn')?.addEventListener('click', async () => {
    try {
      setRuntimeFeedback('#baileys-feedback', 'Iniciando socket Baileys e gerando QR Code…');
      const res = await api('/api/dashboard/whatsapp/baileys/connect', { method: 'POST', body: '{}' });
      renderBaileysState(res);
    } catch (err) {
      setRuntimeFeedback('#baileys-feedback', `Erro ao conectar Baileys: ${err.message}`, true);
    }
  });

  $('#baileys-disconnect-btn')?.addEventListener('click', async () => {
    if (!window.confirm('Desconectar a sessão do Baileys Nativo?')) return;
    try {
      const res = await api('/api/dashboard/whatsapp/baileys/disconnect', {
        method: 'POST',
        body: JSON.stringify({ logout: true })
      });
      renderBaileysState(res);
      setRuntimeFeedback('#baileys-feedback', 'Sessão Baileys desconectada com sucesso.');
    } catch (err) {
      setRuntimeFeedback('#baileys-feedback', `Erro ao desconectar: ${err.message}`, true);
    }
  });

  $('#baileys-pair-btn')?.addEventListener('click', async () => {
    const phone = $('#baileys-pair-phone')?.value?.trim();
    if (!phone) {
      setRuntimeFeedback('#baileys-feedback', 'Informe o número com DDI + DDD (ex: 5588999999999).', true);
      return;
    }
    try {
      const res = await api('/api/dashboard/whatsapp/baileys/pair', {
        method: 'POST',
        body: JSON.stringify({ phone })
      });
      renderBaileysState(res);
      setRuntimeFeedback('#baileys-feedback', `Código gerado: ${res.pairingCode}. Digite no seu WhatsApp em Aparelhos Conectados → Conectar com número de telefone.`);
    } catch (err) {
      setRuntimeFeedback('#baileys-feedback', `Erro ao gerar código: ${err.message}`, true);
    }
  });
})();

const FUNNEL_STAGES = [
  { id: 'novo', label: 'Novo' },
  { id: 'em_atendimento', label: 'Em atendimento' },
  { id: 'agendado', label: 'Agendado' },
  { id: 'transferido', label: 'Transferido' },
  { id: 'fechado', label: 'Fechado' },
];

const formatBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

let lastHandoffAlertCount = -1;
function playHandoffChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  } catch {}
}

function syncSectorDropdowns(sectors = []) {
  const filterEl = $('#crm-sector-filter');
  const modalEl = $('#crm-sector');
  if (filterEl) {
    const cur = filterEl.value;
    filterEl.innerHTML = '<option value="">Todos os setores</option>' + sectors.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    filterEl.value = cur;
  }
  if (modalEl) {
    const cur = modalEl.value;
    modalEl.innerHTML = '<option value="">Sem setor</option>' + sectors.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    modalEl.value = cur;
  }
}

function renderFunnel() {
  const board = $('#funnel-board');
  if (!board) return;
  const instDigits = String(state.activeInstancePhone || '').replace(/\D/g, '');
  const query = String($('#crm-search')?.value || '').trim().toLowerCase();
  const secFilter = String($('#crm-sector-filter')?.value || '').trim();

  const leads = (state.sessions || []).filter((s) => {
    if (s.origin === 'simulation' || s.isInternal) return false;
    if (s.phoneFormatted === 'Canal Interno Copiloto') return false;
    const rawP = String(s.rawPhone || s.phone || '');
    if (/^[a-z0-9_]+_self$/i.test(rawP) || rawP === 'owner_self') return false;
    const digits = rawP.replace(/\D/g, '');
    if (instDigits && digits && digits === instDigits) return false;
    if (secFilter && (s.sectorId || '') !== secFilter) return false;
    if (query) {
      const hay = [s.displayName, s.name, s.phoneFormatted, s.phone, ...(s.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const counter = $('#funnel-count');
  if (counter) counter.textContent = leads.length;
  const totalVal = leads.reduce((acc, s) => acc + Number(s.dealValue || 0), 0);
  const totalEl = $('#crm-total-value');
  if (totalEl) totalEl.textContent = `Pipeline: ${formatBRL(totalVal)}`;

  const handoffTotal = (state.sessions || []).filter(s => s.human).length;
  if (lastHandoffAlertCount >= 0 && handoffTotal > lastHandoffAlertCount) playHandoffChime();
  lastHandoffAlertCount = handoffTotal;

  board.innerHTML = FUNNEL_STAGES.map((col) => {
    const items = leads.filter((s) => (s.funnelStage || 'novo') === col.id);
    const colSum = items.reduce((acc, s) => acc + Number(s.dealValue || 0), 0);
    const cardsHtml = items.length ? items.map((item) => {
      const dName = esc(item.displayName || item.name || item.phoneFormatted || 'Contato');
      const preview = esc(item.preview || '');
      const valBadge = Number(item.dealValue || 0) > 0 ? `<span class="pill mini mint">${formatBRL(item.dealValue)}</span>` : '';
      const secBadge = item.sectorId ? `<span class="pill mini">${esc(item.sectorId)}</span>` : '';
      const tagsHtml = (item.tags || []).slice(0, 3).map(t => `<span class="pill mini amber">${esc(t)}</span>`).join(' ');
      const opts = FUNNEL_STAGES.map((st) => `<option value="${st.id}"${st.id === col.id ? ' selected' : ''}>${st.label}</option>`).join('');
      return `<div class="kanban-card">
        <div class="kanban-card-title" style="display:flex;justify-content:space-between;gap:6px;align-items:center;"><span>${dName}</span>${valBadge}</div>
        <div class="kanban-card-preview">${preview}</div>
        ${(secBadge || tagsHtml) ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${secBadge}${tagsHtml}</div>` : ''}
        <div class="kanban-card-actions">
          <select class="kanban-stage-select" data-funnel-phone="${esc(item.phone)}">${opts}</select>
          <button class="btn-handoff" style="padding:4px 8px;font-size:11px;" data-crm-edit="${esc(item.phone)}">Ficha</button>
          <button class="btn-handoff primary" style="padding:4px 8px;font-size:11px;" data-open-chat="${esc(item.phone)}">Chat</button>
        </div>
      </div>`;
    }).join('') : '<div class="ops-muted" style="font-size:12px;">Sem contatos</div>';

    return `<div class="kanban-col">
      <div class="kanban-col-head"><span>${col.label}</span><span class="pill mini">${items.length}${colSum > 0 ? ' · ' + formatBRL(colSum) : ''}</span></div>
      <div class="kanban-cards">${cardsHtml}</div>
    </div>`;
  }).join('');

  board.querySelectorAll('[data-funnel-phone]').forEach((sel) => {
    sel.onchange = async () => {
      const phone = sel.getAttribute('data-funnel-phone');
      const stage = sel.value;
      await api('/api/dashboard/funnel-stage', { method: 'POST', body: JSON.stringify({ phone, stage }) });
      const target = state.sessions.find((s) => s.phone === phone);
      if (target) target.funnelStage = stage;
      renderFunnel();
    };
  });
  board.querySelectorAll('[data-crm-edit]').forEach((btn) => {
    btn.onclick = () => openCrmModal(btn.getAttribute('data-crm-edit'));
  });
  board.querySelectorAll('[data-open-chat]').forEach((btn) => {
    btn.onclick = () => {
      state.selected = btn.getAttribute('data-open-chat');
      document.querySelector('.nav-item[data-view="inbox"]')?.click();
    };
  });
}

function openCrmModal(phone) {
  const item = (state.sessions || []).find((s) => s.phone === phone);
  if (!item) return;
  if ($('#crm-phone')) $('#crm-phone').value = item.phone;
  if ($('#crm-modal-title')) $('#crm-modal-title').textContent = `Ficha · ${item.displayName || item.phoneFormatted || item.phone}`;
  if ($('#crm-name')) $('#crm-name').value = item.clientName || item.name || '';
  if ($('#crm-email')) $('#crm-email').value = item.email || '';
  if ($('#crm-value')) $('#crm-value').value = item.dealValue || '';
  if ($('#crm-sector')) $('#crm-sector').value = item.sectorId || '';
  if ($('#crm-stage')) $('#crm-stage').value = item.funnelStage || 'novo';
  if ($('#crm-tags')) $('#crm-tags').value = (item.tags || []).join(', ');
  if ($('#crm-notes')) $('#crm-notes').value = item.notes || '';
  $('#crm-lead-modal')?.classList.remove('hidden');
}
$('#crm-close-btn')?.addEventListener('click', () => $('#crm-lead-modal')?.classList.add('hidden'));
$('#crm-search')?.addEventListener('input', () => renderFunnel());
$('#crm-sector-filter')?.addEventListener('change', () => renderFunnel());
$('#crm-save-btn')?.addEventListener('click', async () => {
  const phone = $('#crm-phone')?.value;
  if (!phone) return;
  const payload = {
    phone,
    clientName: $('#crm-name')?.value || '',
    email: $('#crm-email')?.value || '',
    dealValue: $('#crm-value')?.value || 0,
    sectorId: $('#crm-sector')?.value || '',
    funnelStage: $('#crm-stage')?.value || 'novo',
    tags: $('#crm-tags')?.value || '',
    notes: $('#crm-notes')?.value || '',
  };
  await api('/api/dashboard/crm-contact', { method: 'POST', body: JSON.stringify(payload) });
  const target = (state.sessions || []).find((s) => s.phone === phone);
  if (target) Object.assign(target, { ...payload, displayName: payload.clientName || target.displayName, dealValue: Number(payload.dealValue || 0), tags: String(payload.tags).split(',').map(x => x.trim()).filter(Boolean) });
  $('#crm-lead-modal')?.classList.add('hidden');
  renderFunnel();
});
$('#refresh-funnel')?.addEventListener('click', () => refresh().catch(() => {}));

let cannedCache = [];
async function loadCannedResponses() {
  const data = await api('/api/dashboard/canned-responses');
  cannedCache = Array.isArray(data?.items) ? data.items : [];
  const listEl = $('#canned-list');
  if (!listEl) return;
  listEl.innerHTML = cannedCache.length ? cannedCache.map(m => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;">
    <div><strong>/${esc(m.shortcut)}</strong> · ${esc(m.title)} <div class="ops-muted" style="font-size:12px;">${esc(m.content)}</div></div>
    <button type="button" class="btn-handoff" data-macro-del="${esc(m.shortcut)}">Remover</button>
  </div>`).join('') : '<div class="ops-muted" style="font-size:12px;">Nenhuma macro cadastrada.</div>';
  listEl.querySelectorAll('[data-macro-del]').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/dashboard/canned-responses?shortcut=${encodeURIComponent(btn.dataset.macroDel)}`, { method: 'DELETE' });
      loadCannedResponses().catch(() => {});
    };
  });
}
$('#macro-save-btn')?.addEventListener('click', async () => {
  const shortcut = $('#macro-shortcut')?.value?.trim();
  const title = $('#macro-title')?.value?.trim();
  const content = $('#macro-content')?.value?.trim();
  if (!shortcut || !content) return;
  await api('/api/dashboard/canned-responses', { method: 'POST', body: JSON.stringify({ shortcut, title, content }) });
  if ($('#macro-shortcut')) $('#macro-shortcut').value = '';
  if ($('#macro-title')) $('#macro-title').value = '';
  if ($('#macro-content')) $('#macro-content').value = '';
  loadCannedResponses().catch(() => {});
});
let cadenceSteps = [];
async function loadCadence() {
  const data = await api('/api/dashboard/cadence');
  cadenceSteps = Array.isArray(data?.cadence) ? data.cadence : [];
  renderCadence();
}
function renderCadence() {
  const list = $('#cadence-steps-list');
  if (!list) return;
  if (!cadenceSteps.length) {
    list.innerHTML = '<div class="ops-muted" style="font-size:12px;">Nenhuma etapa configurada. Clique em "+ Etapa" para criar uma régua (ex.: 120 min).</div>';
    return;
  }
  list.innerHTML = cadenceSteps.map((st, idx) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <input type="number" min="1" class="kanban-stage-select" style="max-width:100px;" data-cad-delay="${idx}" value="${Number(st.delayMinutes || 120)}" title="Minutos sem resposta" />
    <span class="ops-muted" style="font-size:12px;">min</span>
    <select class="kanban-stage-select" style="max-width:150px;" data-cad-stage="${idx}">
      <option value="all"${st.stageFilter === 'all' ? ' selected' : ''}>Todas as etapas</option>
      <option value="novo"${st.stageFilter === 'novo' ? ' selected' : ''}>Novo</option>
      <option value="em_atendimento"${st.stageFilter === 'em_atendimento' ? ' selected' : ''}>Em atendimento</option>
      <option value="agendado"${st.stageFilter === 'agendado' ? ' selected' : ''}>Agendado</option>
    </select>
    <input type="text" class="kanban-stage-select" style="flex:1;min-width:220px;" data-cad-msg="${idx}" value="${esc(st.message || '')}" placeholder="Mensagem de follow-up..." />
    <button type="button" class="btn-handoff" data-cad-del="${idx}">Remover</button>
  </div>`).join('');
  list.querySelectorAll('[data-cad-delay]').forEach((el) => { el.onchange = () => { cadenceSteps[Number(el.dataset.cadDelay)].delayMinutes = Number(el.value || 60); }; });
  list.querySelectorAll('[data-cad-stage]').forEach((el) => { el.onchange = () => { cadenceSteps[Number(el.dataset.cadStage)].stageFilter = el.value; }; });
  list.querySelectorAll('[data-cad-msg]').forEach((el) => { el.oninput = () => { cadenceSteps[Number(el.dataset.cadMsg)].message = el.value; }; });
  list.querySelectorAll('[data-cad-del]').forEach((el) => { el.onclick = () => { cadenceSteps.splice(Number(el.dataset.cadDel), 1); renderCadence(); }; });
}
$('#cadence-add-btn')?.addEventListener('click', () => {
  cadenceSteps.push({ delayMinutes: 120, stageFilter: 'all', message: 'Oi! Ficou alguma dúvida sobre o que conversamos?' });
  renderCadence();
});
$('#cadence-save-btn')?.addEventListener('click', async () => {
  const res = await api('/api/dashboard/cadence', { method: 'PUT', body: JSON.stringify({ cadence: cadenceSteps }) });
  cadenceSteps = res?.cadence || cadenceSteps;
  renderCadence();
});
$('#cadence-run-btn')?.addEventListener('click', async () => {
  const res = await api('/api/dashboard/cadence/run', { method: 'POST', body: '{}' });
  alert(`Cadência executada: ${res?.sent || 0} enviada(s), ${res?.skipped || 0} ignorada(s).`);
});
$('#followup-publish-btn')?.addEventListener('click', () => {
  publishAdminChanges();
});
async function loadReputation() {
  const data = await api('/api/dashboard/reputation');
  const rep = data?.reputation || {};
  const en = $('#rep-enabled'); if (en) en.checked = Boolean(rep.enabled);
  const url = $('#rep-google-url'); if (url) url.value = rep.googleReviewUrl || '';
  const msg = $('#rep-survey-msg'); if (msg) msg.value = rep.surveyMessage || '';
}
$('#rep-save-btn')?.addEventListener('click', async () => {
  await api('/api/dashboard/reputation', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: Boolean($('#rep-enabled')?.checked),
      googleReviewUrl: $('#rep-google-url')?.value || '',
      surveyMessage: $('#rep-survey-msg')?.value || '',
    }),
  });
  alert('Configuração de Reputação salva!');
});
async function loadTenants() {
  const data = await api('/api/dashboard/tenants');
  const listEl = $('#tenants-list');
  if (!listEl) return;
  const tenants = Array.isArray(data?.tenants) ? data.tenants : [];
  listEl.innerHTML = tenants.map((t) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;flex-wrap:wrap;">
    <div><strong>${esc(t.name)}</strong> <span class="pill mini">${esc(t.id)}</span> <span class="ops-muted" style="font-size:12px;">· ${esc(t.whatsappProvider || 'baileys')}</span></div>
    <div style="display:flex;align-items:center;gap:8px;">
      <code style="font-size:11px;opacity:0.8;">/webhook/${esc(t.whatsappProvider === 'ghl' ? 'ghl' : 'manychat')}/${esc(t.id)}</code>
      ${t.id !== 'default' ? `<button type="button" class="btn-handoff" data-tenant-del="${esc(t.id)}">Remover</button>` : ''}
    </div>
  </div>`).join('');
  listEl.querySelectorAll('[data-tenant-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/dashboard/tenants?id=${encodeURIComponent(btn.dataset.tenantDel)}`, { method: 'DELETE' });
      loadTenants().catch(() => {});
    };
  });
}
$('#tenant-add-btn')?.addEventListener('click', async () => {
  const id = $('#tenant-id-input')?.value?.trim();
  const name = $('#tenant-name-input')?.value?.trim();
  const whatsappProvider = $('#tenant-provider-input')?.value || 'manychat';
  if (!id && !name) return;
  await api('/api/dashboard/tenants', { method: 'POST', body: JSON.stringify({ id, name, whatsappProvider }) });
  if ($('#tenant-id-input')) $('#tenant-id-input').value = '';
  if ($('#tenant-name-input')) $('#tenant-name-input').value = '';
  loadTenants().catch(() => {});
});
async function loadMissedCall() {
  const data = await api('/api/dashboard/missed-call');
  const mc = data?.missedCall || {};
  const en = $('#mc-enabled'); if (en) en.checked = Boolean(mc.enabled);
  const d = $('#mc-delay'); if (d) d.value = Number(mc.delaySeconds || 60);
  const m = $('#mc-msg'); if (m) m.value = mc.message || '';
}
$('#mc-save-btn')?.addEventListener('click', async () => {
  await api('/api/dashboard/missed-call', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: Boolean($('#mc-enabled')?.checked),
      delaySeconds: Number($('#mc-delay')?.value || 60),
      message: $('#mc-msg')?.value || '',
    }),
  });
  alert('Configuração de Ligação Perdida salva!');
});
let customSectorsCache = [];
async function loadCustomSectors() {
  const data = await api('/api/dashboard/sectors-custom');
  customSectorsCache = Array.isArray(data?.sectors) ? data.sectors : [];
  const listEl = $('#sectors-list');
  if (!listEl) return;
  listEl.innerHTML = customSectorsCache.map((s) => `<div class="panel" style="padding:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
    <div style="flex:1;min-width:220px;">
      <div><strong>${esc(s.name)}</strong> <span class="pill mini">${esc(s.id)}</span> ${s.handoffEnabled ? '<span class="pill mini amber">Handoff direto</span>' : '<span class="pill mini mint">IA atende</span>'}</div>
      <div class="ops-muted" style="font-size:12px;margin-top:4px;">Palavras-chave: ${esc((s.keywords || []).join(', ') || '-')}</div>
      <div style="font-size:12px;margin-top:4px;">${esc(s.promptInstructions || '')}</div>
    </div>
    <div style="display:flex;gap:6px;">
      <button type="button" class="btn-handoff" data-sec-edit="${esc(s.id)}">Editar</button>
      <button type="button" class="btn-handoff" data-sec-del="${esc(s.id)}">Remover</button>
    </div>
  </div>`).join('');
  listEl.querySelectorAll('[data-sec-edit]').forEach((btn) => {
    btn.onclick = () => {
      const s = customSectorsCache.find((x) => x.id === btn.dataset.secEdit);
      if (!s) return;
      if ($('#sec-id')) $('#sec-id').value = s.id;
      if ($('#sec-name')) $('#sec-name').value = s.name;
      if ($('#sec-phone')) $('#sec-phone').value = s.responsiblePhone || '';
      if ($('#sec-handoff')) $('#sec-handoff').checked = Boolean(s.handoffEnabled);
      if ($('#sec-keywords')) $('#sec-keywords').value = (s.keywords || []).join(', ');
      if ($('#sec-prompt')) $('#sec-prompt').value = s.promptInstructions || '';
    };
  });
  listEl.querySelectorAll('[data-sec-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/api/dashboard/sectors-custom?id=${encodeURIComponent(btn.dataset.secDel)}`, { method: 'DELETE' });
      loadCustomSectors().catch(() => {});
    };
  });
}
$('#sec-save-btn')?.addEventListener('click', async () => {
  const id = $('#sec-id')?.value?.trim();
  const name = $('#sec-name')?.value?.trim();
  if (!id && !name) return;
  await api('/api/dashboard/sectors-custom', {
    method: 'POST',
    body: JSON.stringify({
      id,
      name,
      responsiblePhone: $('#sec-phone')?.value?.trim() || '',
      handoffEnabled: Boolean($('#sec-handoff')?.checked),
      keywords: $('#sec-keywords')?.value || '',
      promptInstructions: $('#sec-prompt')?.value || '',
    }),
  });
  loadCustomSectors().catch(() => {});
});