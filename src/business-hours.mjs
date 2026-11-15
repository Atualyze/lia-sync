/**
 * Janela de Atendimento e Pacing Fora do Horário para a Lia Sync.
 * Baseado nos padrões testados em produção (fail-open, zero-dependency, zero-polling).
 *
 * Princípios fundamentais:
 * 1. Fail-open: Se o fuso ou a configuração forem inválidos, a janela é considerada aberta (nunca silencia).
 * 2. Adiar e não descartar: Mensagens fora do expediente são marcadas com timestamp de abertura.
 * 3. Aviso amigável único por período fechado: Evita spam se o cliente mandar várias mensagens.
 * 4. Isenção total para o responsável / Copiloto: O atendimento ao dono do sistema é 24/7 incondicional.
 */

const HORA_RX = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

const NOMES_DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Texto humanizado dos dias da semana (ex: "segunda a sexta").
 * Fonte única para o aviso de fora do expediente e para o resumo publicado na ponte.
 */
export function diasSemanaTexto(weekdays = []) {
  const dias = [...new Set((Array.isArray(weekdays) ? weekdays : []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (dias.length === 0) return 'segunda a sexta';
  if (dias.length === 7) return 'todos os dias';
  if (dias.length === 5 && dias.every(d => [1, 2, 3, 4, 5].includes(d))) return 'segunda a sexta';
  if (dias.length === 6 && !dias.includes(0)) return 'segunda a sábado';
  return dias.map(d => NOMES_DIAS[d]).join(', ');
}

function minutosDe(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = HORA_RX.exec(hhmm.trim());
  if (m === null) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Retorna o dia da semana (0=Dom...6=Sáb) e minutos desde 00:00 no fuso especificado.
 */
function relogioLocal(timezone, agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(agora);

  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value ?? '';
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dia = DIAS[valor('weekday')] ?? 0;
  const hora = Number(valor('hour')) % 24;
  return { dia, minutos: hora * 60 + Number(valor('minute')) };
}

/**
 * Valida e normaliza a configuração de janela de atendimento.
 * Retorna null se não estiver ativado ou se houver dados corrompidos (fail-open).
 */
export function normalizarJanelaDeAtendimento(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.enabled === false) return null;

  const timezone = typeof cfg.timezone === 'string' && cfg.timezone.trim() ? cfg.timezone.trim() : 'America/Sao_Paulo';
  const start = typeof cfg.start === 'string' ? cfg.start.trim() : '08:00';
  const end = typeof cfg.end === 'string' ? cfg.end.trim() : '18:00';

  const inicio = minutosDe(start);
  const fim = minutosDe(end);
  if (inicio === null || fim === null || fim <= inicio) return null;

  const rawWeekdays = Array.isArray(cfg.weekdays) && cfg.weekdays.length > 0 ? cfg.weekdays : [1, 2, 3, 4, 5];
  const weekdays = [...new Set(rawWeekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (weekdays.length === 0) return null;

  try {
    relogioLocal(timezone, new Date());
  } catch {
    return null; // timezone inválido -> fail-open
  }

  const outOfHoursNotice = typeof cfg.outOfHoursNotice === 'string' && cfg.outOfHoursNotice.trim()
    ? cfg.outOfHoursNotice.trim()
    : 'Olá! Nosso horário de atendimento é de {dias}, das {inicio} às {fim}.\n\nJá registrei sua mensagem aqui e retornaremos com prioridade assim que o expediente iniciar! 🕒✨';

  const autoResumeOnOpen = cfg.autoResumeOnOpen !== false;

  return {
    enabled: true,
    timezone,
    start,
    end,
    weekdays,
    outOfHoursNotice,
    autoResumeOnOpen
  };
}

/**
 * Avalia se o horário atual está dentro da janela de atendimento.
 * Retorna:
 * - { isOpen: true } se a janela estiver aberta ou se não houver janela ativa (fail-open).
 * - { isOpen: false, msAteAbrir, proximaAberturaISO, periodoFechadoId, noticeText } se fechado.
 */
export function avaliarJanelaDeAtendimento(configOrJanela, agora = new Date()) {
  const janela = normalizarJanelaDeAtendimento(configOrJanela);
  if (!janela) {
    return { isOpen: true };
  }

  let local;
  try {
    local = relogioLocal(janela.timezone, agora);
  } catch {
    return { isOpen: true }; // fail-open
  }

  const inicio = minutosDe(janela.start);
  const fim = minutosDe(janela.end);

  const isOpen = janela.weekdays.includes(local.dia) && local.minutos >= inicio && local.minutos < fim;
  if (isOpen) {
    return { isOpen: true, janela };
  }

  // Calcula quanto tempo falta até a próxima abertura
  let msAteAbrir = null;
  let proximaAberturaDate = null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const dia = (local.dia + offset) % 7;
    if (!janela.weekdays.includes(dia)) continue;
    if (offset === 0 && local.minutos >= inicio) continue; // hoje a janela já passou
    const minutosAteAbrir = offset * 24 * 60 + inicio - local.minutos;
    if (minutosAteAbrir > 0) {
      msAteAbrir = minutosAteAbrir * 60_000;
      proximaAberturaDate = new Date(agora.getTime() + msAteAbrir);
      break;
    }
  }

  // Gera identificador único do período fechado atual (para deduplicação do aviso)
  // Baseado no último momento em que a janela fechou
  let periodoFechadoId = 'closed_period';
  for (let voltas = 0; voltas <= 7; voltas += 1) {
    const dia = (local.dia - voltas + 14) % 7;
    if (!janela.weekdays.includes(dia)) continue;
    const minutosDesdeOFechamento = local.minutos - fim + voltas * 24 * 60;
    if (minutosDesdeOFechamento < 0) continue;
    const agoraNoMinuto = Math.floor(agora.getTime() / 60_000) * 60_000;
    const closedInstant = new Date(agoraNoMinuto - minutosDesdeOFechamento * 60_000);
    periodoFechadoId = `closed_${closedInstant.toISOString().slice(0, 16)}`;
    break;
  }

  // Monta texto humanizado dos dias (ex: "segunda a sexta")
  const diasTexto = diasSemanaTexto(janela.weekdays);

  const noticeText = janela.outOfHoursNotice
    .replace(/\{dias\}/gi, diasTexto)
    .replace(/\{inicio\}/gi, janela.start)
    .replace(/\{fim\}/gi, janela.end)
    .replace(/\{horario\}/gi, `${janela.start} às ${janela.end}`);

  return {
    isOpen: false,
    janela,
    msAteAbrir,
    proximaAberturaISO: proximaAberturaDate ? proximaAberturaDate.toISOString() : null,
    periodoFechadoId,
    noticeText
  };
}

/**
 * Projeção operacional da janela de atendimento para consumidores externos (ponte Chatwoot Lia).
 * Devolve somente a configuração e o estado derivados - nunca o texto do aviso ao cliente,
 * que é conteúdo do atendimento da Lia e não configuração do console.
 * @param {object} cfg valor de `business.hoursConfig`
 * @param {Date} agora
 */
export function resumoJanelaDeAtendimento(cfg, agora = new Date()) {
  const avaliacao = avaliarJanelaDeAtendimento(cfg, agora);
  const janela = avaliacao.janela;
  if (!janela) {
    return {
      enabled: false,
      timezone: (typeof cfg?.timezone === 'string' && cfg.timezone.trim()) || 'America/Sao_Paulo',
      start: null,
      end: null,
      weekdays: [],
      autoResumeOnOpen: false,
      isOpenNow: true,
      nextOpenAt: null,
      summary: 'Atendimento contínuo (24 horas)'
    };
  }
  return {
    enabled: true,
    timezone: janela.timezone,
    start: janela.start,
    end: janela.end,
    weekdays: [...janela.weekdays].sort((a, b) => a - b),
    autoResumeOnOpen: janela.autoResumeOnOpen === true,
    isOpenNow: avaliacao.isOpen === true,
    nextOpenAt: avaliacao.isOpen ? null : (avaliacao.proximaAberturaISO || null),
    summary: `${diasSemanaTexto(janela.weekdays)}, das ${janela.start} às ${janela.end} (${janela.timezone})`
  };
}
