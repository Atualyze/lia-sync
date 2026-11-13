const MOCK_SLOTS = ['09:00', '10:30', '14:00', '15:30', '17:00'];
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3/calendars';
const mockEnabled = () => process.env.GOOGLE_CALENDAR_MOCK === 'true' && ['development', 'test'].includes(process.env.NODE_ENV || 'development');
const integration = () => ({ accessToken: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || '', apiKey: process.env.GOOGLE_CALENDAR_API_KEY || '', calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary' });
const unavailable = () => ({ success: false, error: 'google_calendar_unavailable', message: 'Integração real com Google Calendar não está configurada.' });
const dateValue = date => { const value = date ? new Date(date) : new Date(); return Number.isNaN(value.getTime()) ? null : value; };
async function googleRequest(path, options = {}) {
  const { accessToken, apiKey, calendarId } = integration();
  const query = apiKey && !accessToken ? `?key=${encodeURIComponent(apiKey)}` : '';
  const response = await fetch(`${GOOGLE_API}/${encodeURIComponent(calendarId)}${path}${query}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error('google_calendar_request_failed'); error.status = response.status; throw error; }
  return body;
}
export const toolGerenciarAgendaGoogle = {
  name: 'gerenciar_agenda_google',
  description: 'Gerencia a agenda do Google Calendar: consulta horários livres, cria reuniões/atendimentos ou remarca compromissos.',
  parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', enum: ['consultar_livres', 'criar_evento', 'listar_eventos', 'cancelar_evento'] }, date: { type: 'STRING' }, startTime: { type: 'STRING' }, summary: { type: 'STRING' }, attendeeEmail: { type: 'STRING' }, attendeePhone: { type: 'STRING' } }, required: ['action'] },
  async execute({ action, date, startTime, summary, attendeeEmail, attendeePhone }, context = {}) {
    if (!['consultar_livres', 'criar_evento', 'listar_eventos', 'cancelar_evento'].includes(action)) return { success: false, error: 'invalid_action', message: 'Ação de agenda inválida.' };
    const targetDate = dateValue(date);
    if (!targetDate) return { success: false, error: 'invalid_date', message: 'Data inválida para a agenda.' };
    const dateFormatted = targetDate.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
    if (mockEnabled()) {
      if (action === 'consultar_livres') return { success: true, mocked: true, date: dateFormatted, availableSlots: MOCK_SLOTS, message: `Para a data ${dateFormatted}, os horários disponíveis na agenda são: ${MOCK_SLOTS.join(', ')}.` };
      if (action === 'criar_evento') return { success: true, mocked: true, event: { title: summary || `Atendimento com ${context.clientName || 'Cliente'}`, date: dateFormatted, time: startTime || '14:00', status: 'confirmed' }, message: `Compromisso simulado com sucesso para ${dateFormatted} às ${startTime || '14:00'}.` };
    }
    const { accessToken, apiKey, calendarId } = integration();
    if (!accessToken && !apiKey) return unavailable();
    try {
      if (action === 'consultar_livres') {
        const body = await googleRequest('/freeBusy', { method: 'POST', body: JSON.stringify({ timeMin: targetDate.toISOString(), timeMax: new Date(targetDate.getTime() + 86400000).toISOString(), items: [{ id: calendarId }] }) });
        const busy = body.calendars?.[calendarId]?.busy || [];
        return { success: true, date: dateFormatted, availableSlots: MOCK_SLOTS.filter(slot => !busy.some(item => String(item.start).includes(`T${slot}:`))), message: `Disponibilidade consultada para ${dateFormatted}.` };
      }
      if (action === 'criar_evento') {
        if (!accessToken) return { success: false, error: 'google_calendar_write_unavailable', message: 'Token OAuth é necessário para criar eventos no Google Calendar.' };
        const time = startTime || '14:00'; const start = new Date(`${date.slice(0, 10)}T${time}:00`).toISOString(); const end = new Date(new Date(start).getTime() + 1800000).toISOString();
        const event = await googleRequest('/events', { method: 'POST', body: JSON.stringify({ summary: summary || `Atendimento com ${context.clientName || 'Cliente'}`, start: { dateTime: start }, end: { dateTime: end }, attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined, description: attendeePhone ? `Telefone: ${attendeePhone}` : undefined }) });
        return { success: true, event: { id: event.id, title: event.summary, date: dateFormatted, time, status: event.status || 'confirmed' }, message: `Compromisso agendado com sucesso para ${dateFormatted} às ${time}.` };
      }
      if (action === 'listar_eventos') { const body = await googleRequest(`/events?timeMin=${encodeURIComponent(targetDate.toISOString())}`); return { success: true, date: dateFormatted, events: body.items || [] }; }
      return { success: false, error: 'unsupported_action', message: 'Cancelamento requer o identificador do evento.' };
    } catch (error) { return { success: false, error: 'google_calendar_error', message: 'Não foi possível consultar o Google Calendar.', status: error.status }; }
  }
};
