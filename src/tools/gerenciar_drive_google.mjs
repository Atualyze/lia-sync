import { resolveGoogleAccessToken } from './google_auth.mjs';
import { createGoogleHttp, GoogleHttpError } from './google_http.mjs';
import { config } from '../config.mjs';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const DOCS_WRITE_SCOPES = ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file'];
const MAX_DRIVE_FILE_BYTES = 15 * 1024 * 1024;

function sanitizeQueryTerm(text) {
  return String(text || '').replace(/['\\]/g, '').trim();
}

export const toolGerenciarDriveGoogle = {
  name: 'gerenciar_drive_google',
  description:
    'Lista, busca, lê, atualiza Google Docs (somente dono) e envia catálogos, contratos ou documentos em PDF do Google Drive diretamente para o cliente no WhatsApp.',
  parameters: {
    type: 'OBJECT',
    properties: {
      acao: {
        type: 'STRING',
        enum: ['listar_arquivos', 'buscar_arquivo', 'ler_documento', 'atualizar_documento', 'enviar_arquivo_whatsapp'],
        description: 'Ação no Google Drive / Google Docs (ler_documento lê texto; atualizar_documento anexa ou substitui texto em um Google Doc).'
      },
      busca: {
        type: 'STRING',
        description: 'Nome ou parte do nome do arquivo para buscar.'
      },
      fileId: {
        type: 'STRING',
        description: 'ID do arquivo no Google Drive / Google Doc.'
      },
      folderId: {
        type: 'STRING',
        description: 'ID da pasta no Google Drive (opcional; usa GOOGLE_DRIVE_FOLDER_ID se omitido).'
      },
      modo: {
        type: 'STRING',
        enum: ['anexar', 'substituir'],
        description: 'Modo para atualizar_documento: "anexar" (adiciona texto ao final) ou "substituir" (troca textoAntigo por textoNovo).'
      },
      texto: {
        type: 'STRING',
        description: 'Texto a anexar no documento (para atualizar_documento com modo "anexar").'
      },
      textoAntigo: {
        type: 'STRING',
        description: 'Trecho exato a substituir (para atualizar_documento com modo "substituir").'
      },
      textoNovo: {
        type: 'STRING',
        description: 'Novo texto substituto (para atualizar_documento com modo "substituir").'
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
    if (acao === 'atualizar_documento') {
      if (context.actor === 'client') {
        return { success: false, error: 'forbidden_for_client', message: 'Apenas o responsável pode editar documentos no Google Docs.' };
      }
      const docId = String(args.fileId || '').trim();
      if (!docId) {
        return { success: false, error: 'missing_file_id', message: 'Informe o fileId do Google Doc para atualizar.' };
      }
      const modo = String(args.modo || (args.textoAntigo ? 'substituir' : 'anexar')).trim();
      const writeToken = await resolveGoogleAccessToken({ scopes: DOCS_WRITE_SCOPES, envPrefix: 'GOOGLE_DRIVE' });
      if (!writeToken) {
        return { success: false, error: 'google_docs_unavailable', message: 'Integração com Google Docs não está configurada para edição.' };
      }
      const http = createGoogleHttp({ accessToken: writeToken, fetchImpl: context.fetchImpl || globalThis.fetch });
      const requests = [];
      if (modo === 'substituir') {
        const oldText = String(args.textoAntigo || '');
        const newText = String(args.textoNovo ?? '');
        if (!oldText) {
          return { success: false, error: 'missing_old_text', message: 'Informe textoAntigo para substituir no documento.' };
        }
        requests.push({
          replaceAllText: {
            containsText: { text: oldText, matchCase: true },
            replaceText: newText
          }
        });
      } else {
        const appendText = String(args.texto ?? args.textoNovo ?? '').trim();
        if (!appendText) {
          return { success: false, error: 'missing_text', message: 'Informe o texto para anexar ao documento.' };
        }
        requests.push({
          insertText: {
            endOfSegmentLocation: { segmentId: '' },
            text: `\n${appendText}`
          }
        });
      }
      try {
        const res = await http.send({
          method: 'POST',
          host: 'docs.googleapis.com',
          path: `/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
          body: { requests }
        });
        const occurrences = res?.replies?.[0]?.replaceAllText?.occurrencesChanged;
        return {
          success: true,
          acao,
          modo,
          fileId: docId,
          ...(typeof occurrences === 'number' ? { occurrencesChanged: occurrences } : {}),
          message: modo === 'substituir'
            ? `Documento atualizado (${occurrences ?? 0} ocorrência(s) substituída(s)).`
            : 'Texto anexado ao final do Google Doc com sucesso.'
        };
      } catch (error) {
        if (error instanceof GoogleHttpError) {
          return { success: false, error: `google_docs_${error.code}`, status: error.status || undefined, message: error.message };
        }
        return { success: false, error: 'google_docs_update_failed', message: error?.message || 'Falha ao atualizar o Google Doc.' };
      }
    }

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
      const folderId = sanitizeQueryTerm(args.folderId || toolSettings.defaultFolderId || config.googleDriveFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID || '');
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

    if (acao === 'ler_documento') {
      const textUrl = isGoogleDoc
        ? `${DRIVE_BASE}/${encodeURIComponent(fileId)}/export?mimeType=text/plain`
        : `${DRIVE_BASE}/${encodeURIComponent(fileId)}?alt=media`;
      const docRes = await fetch(textUrl, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15_000)
      });
      if (!docRes.ok) {
        return { success: false, error: 'google_docs_read_failed', status: docRes.status, message: 'Não foi possível ler o conteúdo do documento no Google Drive/Docs.' };
      }
      const textContent = (await docRes.text()).trim().slice(0, 12_000);
      return {
        success: true,
        acao,
        fileId,
        fileName: String(meta.name || 'documento').trim(),
        mimeType: meta.mimeType || 'text/plain',
        content: textContent
      };
    }

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
    const targetPhone = String(args.telefoneDestino || context?.targetPhone || context?.phone || '').trim();

    if (targetPhone && context?.whatsapp?.sendDocument) {
      const document = {
        base64,
        fileName,
        mimetype: outMime,
        caption: String(args.legenda || '').trim()
      };
      if (context.dispatchConfirmed !== true) {
        return {
          success: false,
          requiresConfirmation: true,
          acao,
          fileId,
          fileName,
          mimetype: outMime,
          bytes: arrayBuf.byteLength,
          targetPhone,
          recipient: String(args.telefoneDestino || targetPhone),
          document
        };
      }
      await context.whatsapp.sendDocument(targetPhone, {
        ...document
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
