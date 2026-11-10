/**
 * Cria o entregador de PDFs gerados pelo Copiloto.
 * O texto de confirmação continua no chat; aqui só o arquivo real é enviado.
 */
export function createPdfDelivery({ whatsapp, rawItem, getHumanPhone, logger }) {
  return async (pdfRes) => {
    if (!pdfRes?.success || !pdfRes?.dataUrl) {
      return { sent: false, error: pdfRes?.error || 'PDF não foi gerado' };
    }
    const targetPhone = String(rawItem?.jid || rawItem?.phone || getHumanPhone() || '')
      .replace(/@.*$/, '')
      .replace(/\D/g, '');
    if (!targetPhone || targetPhone.length < 8) {
      return { sent: false, error: 'Número de destino indisponível' };
    }
    if (typeof whatsapp?.sendDocument !== 'function') {
      return { sent: false, error: 'Envio de documento indisponível' };
    }
    try {
      await whatsapp.sendDocument(targetPhone, {
        dataUrl: pdfRes.dataUrl,
        fileName: pdfRes.fileName || 'documento.pdf',
        mimetype: 'application/pdf'
      });
      return { sent: true, phone: targetPhone };
    } catch (err) {
      logger?.error?.('[flow] Falha ao enviar PDF no WhatsApp:', err.message);
      return { sent: false, error: err.message };
    }
  };
}
