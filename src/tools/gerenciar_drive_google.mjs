import { resolveGoogleAccessToken } from './google_auth.mjs';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const MAX_DRIVE_FILE_BYTES = 15 * 1024 * 1024;

function sanitizeQueryTerm(text) {
  return String(text || '').replace(/['\\]/g, '').trim();
}

export const toolGerenciarDriveGoogle = {
  name: 'gerenciar_drive_google',
  description:
    'Lista, busca e envia catálogos, contratos ou documentos em PDF do Google Drive diretamente para o cliente no WhatsApp.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['listar_arquivos', 'buscar_arquivo', 'enviar_arquivo_whatsapp'],
        description: 'Ação no Google Drive.'
      },
      busca: {
        type: 'STRING',
        description: 'Nome ou parte do nome do arquivo para buscar.'
      },
      fileId: {
        type: 'STRING',
        description: 'ID do arquivo no Google Drive (obrigatório para enviar_arquivo_whatsapp).'
      },
      folderId: {
        type: 'STRING',
        description: 'ID da pasta no Google Drive (opcional; usa GOOGLE_DRIVE_FOLDER_ID se omitido).'
      },
      telefoneDestino: {
        type: 'STRING',
        description: 'Telefone do destinatário (opcional; usa o contato da conversa atual).'
      },
      legenda: {
        type: 'STRING',
        description: 'Legenda opcional ao enviar o documento no WhatsApp.'
      }
    },
    required: ['acao']
  },

  async execute(args = {}, context = {}) {
    const acao = String(args.acao || '').trim();
    const token = await resolveGoogleAccessToken({ scopes: DRIVE_SCOPES, envPrefix: 'GOOGLE_DRIVE' });
    if (!token) {
      return {
        success: false,
        error: 'google_drive_unavailable',
        message: 'Integração com Google Drive não está configurada (OAuth ou Service Account ausente).'
      };
    }

    const authHeaders = { authorization: `Bearer ${token}` };

    if (acao === 'listar_arquivos' || acao === 'buscar_arquivo') {
      const toolSettings = context?.botConfig?.tools?.settings?.gerenciar_drive_google || {};
      const folderId = sanitizeQueryTerm(args.folderId || toolSettings.defaultFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || '');
      const search = sanitizeQueryTerm(args.busca || '');
      const clauses = ['trashed = false'];
      if (folderId) clauses.push(`'${folderId}' in parents`);
      if (search) clauses.push(`name contains '${search}'`);
      const params = new URLSearchParams({
        q: clauses.join(' and '),
        pageSize: '20',
        fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)'
      });
      const res = await fetch(`${DRIVE_BASE}?${params.toString()}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(12_000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, error: 'google_drive_api_error', status: res.status, message: data?.error?.message || 'Falha ao consultar Google Drive.' };
      }
      return {
        success: true,
        acao,
        total: (data.files || []).length,
        files: data.files || []
      };
    }

    const fileId = String(args.fileId || '').trim();
    if (!fileId) {
      return { success: false, error: 'missing_file_id', message: 'Informe o fileId do arquivo no Google Drive para enviar.' };
    }

    const metaRes = await fetch(`${DRIVE_BASE}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(10_000)
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      return { success: false, error: 'google_drive_api_error', status: metaRes.status, message: meta?.error?.message || 'Arquivo não encontrado no Google Drive.' };
    }

    if (Number(meta.size || 0) > MAX_DRIVE_FILE_BYTES) {
      return { success: false, error: 'file_too_large', message: 'O arquivo excede o limite de 15 MB para envio via WhatsApp.' };
    }

    const isGoogleDoc = String(meta.mimeType || '').startsWith('application/vnd.google-apps.');
    const downloadUrl = isGoogleDoc
      ? `${DRIVE_BASE}/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`
      : `${DRIVE_BASE}/${encodeURIComponent(fileId)}?alt=media`;

    const fileRes = await fetch(downloadUrl, {
      headers: authHeaders,
      signal: AbortSignal.timeout(25_000)
    });
    if (!fileRes.ok) {
      return { success: false, error: 'google_drive_download_failed', status: fileRes.status, message: 'Não foi possível baixar o arquivo do Google Drive.' };
    }

    const arrayBuf = await fileRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_DRIVE_FILE_BYTES) {
      return { success: false, error: 'file_too_large', message: 'O arquivo excede o limite de 15 MB para envio via WhatsApp.' };
    }

    const base64 = Buffer.from(arrayBuf).toString('base64');
    const outMime = isGoogleDoc ? 'application/pdf' : (meta.mimeType || 'application/pdf');
    const baseName = String(meta.name || 'documento').trim();
    const fileName = isGoogleDoc && !/\.pdf$/i.test(baseName) ? `${baseName}.pdf` : baseName;
    const targetPhone = String(args.telefoneDestino || context?.phone || '').trim();

    if (targetPhone && context?.whatsapp?.sendDocument) {
      await context.whatsapp.sendDocument(targetPhone, {
        base64,
        fileName,
        mimetype: outMime,
        caption: String(args.legenda || '').trim()
      });
      return {
        success: true,
        acao,
        sentViaWhatsApp: true,
        fileId,
        fileName,
        mimetype: outMime,
        bytes: arrayBuf.byteLength,
        targetPhone
      };
    }

    return {
      success: true,
      acao,
      sentViaWhatsApp: false,
      fileId,
      fileName,
      mimetype: outMime,
      bytes: arrayBuf.byteLength,
      message: 'Arquivo baixado do Drive, mas o canal WhatsApp não está disponível neste contexto.'
    };
  }
};
