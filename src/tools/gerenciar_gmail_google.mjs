import { resolveGoogleAccessToken } from './google_auth.mjs';
import { createGoogleHttp, GoogleHttpError } from './google_http.mjs';

const GMAIL_HOST = 'gmail.googleapis.com';
const GMAIL_READ_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const GMAIL_COMPOSE_SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

function headerValue(headers = [], name = '') {
  const target = String(name || '').toLowerCase();
  const found = (Array.isArray(headers) ? headers : []).find(h => String(h?.name || '').toLowerCase() === target);
  return String(found?.value || '').trim();
}

function decodeBase64Url(data = '') {
  if (!data) return '';
  try {
    const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMessageBody(payload = {}) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).trim();
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  let plain = '';
  let html = '';
  const walk = (nodes) => {
    for (const part of nodes) {
      if (!part) continue;
      if (part.mimeType === 'text/plain' && part.body?.data && !plain) {
        plain = decodeBase64Url(part.body.data).trim();
      } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
        html = decodeBase64Url(part.body.data).trim();
      }
      if (Array.isArray(part.parts) && part.parts.length) walk(part.parts);
    }
  };
  walk(parts);
  if (plain) return plain;
  if (html) return stripHtml(html);
  if (payload.body?.data) {
    const raw = decodeBase64Url(payload.body.data);
    return payload.mimeType === 'text/html' ? stripHtml(raw) : raw.trim();
  }
  return '';
}

function sanitizeHeaderLine(value = '') {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeRfc2047Subject(subject = '') {
  const clean = sanitizeHeaderLine(subject);
  if (!clean || /^[\x20-\x7e]+$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function buildRawMimeDraft({ to, subject, body, cc = '', bcc = '' }) {
  const lines = [
    `To: ${sanitizeHeaderLine(to)}`,
    ...(cc ? [`Cc: ${sanitizeHeaderLine(cc)}`] : []),
    ...(bcc ? [`Bcc: ${sanitizeHeaderLine(bcc)}`] : []),
    `Subject: ${encodeRfc2047Subject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body || '').replace(/\r?\n/g, '\r\n')
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function mapGmailError(error) {
  if (error instanceof GoogleHttpError) {
    return {
      success: false,
      error: `google_gmail_${error.code}`,
      status: error.status || undefined,
      message: error.message
    };
  }
  return {
    success: false,
    error: 'google_gmail_error',
    message: error?.message || 'Falha ao acessar o Gmail.'
  };
}

export const toolGerenciarGmailGoogle = {
  name: 'gerenciar_gmail_google',
  description:
    'Consulta e-mails do Gmail (buscar mensagens, ler conteúdo, listar rascunhos) e cria rascunhos seguros (nunca envia nem apaga e-mails automaticamente). Uso exclusivo do dono.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['buscar_mensagens', 'ler_mensagem', 'listar_rascunhos', 'criar_rascunho'],
        description: 'Ação no Gmail: buscar_mensagens, ler_mensagem, listar_rascunhos ou criar_rascunho.'
      },
      busca: {
        type: 'STRING',
        description: 'Filtro de busca do Gmail (ex.: "is:unread", "from:fornecedor@empresa.com", "nota fiscal").'
      },
      messageId: {
        type: 'STRING',
        description: 'ID da mensagem no Gmail (obrigatório para ler_mensagem).'
      },
      limite: {
        type: 'INTEGER',
        description: 'Quantidade máxima de resultados (1 a 15; padrão 8).'
      },
      para: {
        type: 'STRING',
        description: 'E-mail destinatário do rascunho (obrigatório para criar_rascunho).'
      },
      assunto: {
        type: 'STRING',
        description: 'Assunto do rascunho (obrigatório para criar_rascunho).'
      },
      corpo: {
        type: 'STRING',
        description: 'Texto do corpo do e-mail para criar_rascunho.'
      },
      cc: {
        type: 'STRING',
        description: 'Destinatários em cópia (opcional).'
      },
      threadId: {
        type: 'STRING',
        description: 'ID da thread para vincular o rascunho como resposta (opcional).'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    const acao = String(args.acao || '').trim();
    const isWriteAction = acao === 'criar_rascunho';
    const token = await resolveGoogleAccessToken({
      scopes: isWriteAction ? GMAIL_COMPOSE_SCOPES : GMAIL_READ_SCOPES,
      envPrefix: 'GOOGLE_GMAIL'
    });
    if (!token) {
      return {
        success: false,
        error: 'google_gmail_unavailable',
        message: 'Integração com Gmail não está configurada (conecte OAuth do Google no painel com escopo do Gmail).'
      };
    }

    const http = createGoogleHttp({
      accessToken: token,
      fetchImpl: context.fetchImpl || globalThis.fetch
    });

    try {
      if (acao === 'buscar_mensagens') {
        const maxResults = Math.min(15, Math.max(1, Number(args.limite) || 8));
        const q = String(args.busca || '').trim();
        const list = await http.send({
          method: 'GET',
          host: GMAIL_HOST,
          path: '/gmail/v1/users/me/messages',
          query: { maxResults, ...(q ? { q } : {}) }
        });
        const refs = Array.isArray(list.messages) ? list.messages.slice(0, maxResults) : [];
        if (!refs.length) {
          return {
            success: true,
            acao,
            total: 0,
            messages: [],
            message: q ? `Nenhum e-mail encontrado para "${q}".` : 'Nenhuma mensagem encontrada na caixa de entrada.'
          };
        }
        const details = await Promise.all(refs.map(async ref => {
          const msg = await http.send({
            method: 'GET',
            host: GMAIL_HOST,
            path: `/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}`,
            query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }
          });
          const headers = msg?.payload?.headers || [];
          return {
            id: msg.id,
            threadId: msg.threadId,
            from: headerValue(headers, 'From'),
            to: headerValue(headers, 'To'),
            subject: headerValue(headers, 'Subject') || '(sem assunto)',
            date: headerValue(headers, 'Date'),
            snippet: String(msg.snippet || '').slice(0, 260),
            unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD')
          };
        }));
        return {
          success: true,
          acao,
          total: details.length,
          messages: details
        };
      }

      if (acao === 'ler_mensagem') {
        const messageId = String(args.messageId || '').trim();
        if (!messageId) {
          return { success: false, error: 'missing_message_id', message: 'Informe o messageId do e-mail que deseja ler.' };
        }
        const msg = await http.send({
          method: 'GET',
          host: GMAIL_HOST,
          path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
          query: { format: 'full' }
        });
        const headers = msg?.payload?.headers || [];
        const body = extractMessageBody(msg.payload).slice(0, 12_000);
        return {
          success: true,
          acao,
          messageId: msg.id,
          threadId: msg.threadId,
          from: headerValue(headers, 'From'),
          to: headerValue(headers, 'To'),
          subject: headerValue(headers, 'Subject') || '(sem assunto)',
          date: headerValue(headers, 'Date'),
          snippet: String(msg.snippet || '').slice(0, 300),
          body
        };
      }

      if (acao === 'listar_rascunhos') {
        const maxResults = Math.min(15, Math.max(1, Number(args.limite) || 8));
        const list = await http.send({
          method: 'GET',
          host: GMAIL_HOST,
          path: '/gmail/v1/users/me/drafts',
          query: { maxResults }
        });
        const refs = Array.isArray(list.drafts) ? list.drafts.slice(0, maxResults) : [];
        return {
          success: true,
          acao,
          total: refs.length,
          drafts: refs.map(item => ({
            draftId: item.id,
            messageId: item.message?.id || null,
            threadId: item.message?.threadId || null
          }))
        };
      }

      if (acao === 'criar_rascunho') {
        const to = String(args.para || '').trim();
        const subject = String(args.assunto || '').trim();
        const body = String(args.corpo || '').trim();
        if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
          return { success: false, error: 'invalid_recipient', message: 'Informe um e-mail destinatário válido no campo "para".' };
        }
        if (!subject) {
          return { success: false, error: 'missing_subject', message: 'Informe o assunto do rascunho no campo "assunto".' };
        }
        if (!body) {
          return { success: false, error: 'missing_body', message: 'Informe o texto do rascunho no campo "corpo".' };
        }
        const raw = buildRawMimeDraft({ to, subject, body, cc: args.cc });
        const draft = await http.send({
          method: 'POST',
          host: GMAIL_HOST,
          path: '/gmail/v1/users/me/drafts',
          body: {
            message: {
              raw,
              ...(args.threadId ? { threadId: String(args.threadId).trim() } : {})
            }
          }
        });
        return {
          success: true,
          acao,
          draftId: draft.id,
          messageId: draft.message?.id || null,
          threadId: draft.message?.threadId || null,
          to,
          subject,
          message: `Rascunho criado no Gmail para ${to} com assunto "${subject}". Ele NÃO foi enviado automaticamente — revise e envie quando quiser.`
        };
      }

      return { success: false, error: 'invalid_action', message: 'Ação do Gmail inválida.' };
    } catch (error) {
      return mapGmailError(error);
    }
  }
};
