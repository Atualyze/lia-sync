import QRCode from 'qrcode';
import { resolveIdentity } from '../core/identity.mjs';

function tlv(id, value) {
  const str = String(value ?? '');
  const len = String(Buffer.byteLength(str, 'utf8')).padStart(2, '0');
  return `${id}${len}${str}`;
}

function sanitizeAscii(text, maxLen) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .trim()
    .slice(0, maxLen);
}

function crc16Ccitt(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildPixPayload({
  pixKey,
  amount = 0,
  merchantName = 'Lia Sync',
  merchantCity = 'SAO PAULO',
  txid = '***',
  description = ''
} = {}) {
  const cleanKey = String(pixKey || '').trim();
  if (!cleanKey) throw new Error('Chave Pix não informada.');

  const cleanName = sanitizeAscii(merchantName, 25) || 'Lia Sync';
  const cleanCity = sanitizeAscii(merchantCity, 15) || 'SAO PAULO';
  const cleanTxid = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const cleanDesc = sanitizeAscii(description, 40);

  const merchantAccount =
    tlv('00', 'br.gov.bcb.pix') +
    tlv('01', cleanKey) +
    (cleanDesc ? tlv('02', cleanDesc) : '');

  const numericAmount = Number(amount);
  const amountTag = Number.isFinite(numericAmount) && numericAmount > 0
    ? tlv('54', numericAmount.toFixed(2))
    : '';

  const base =
    tlv('00', '01') +
    tlv('26', merchantAccount) +
    tlv('52', '0000') +
    tlv('53', '986') +
    amountTag +
    tlv('58', 'BR') +
    tlv('59', cleanName) +
    tlv('60', cleanCity) +
    tlv('62', tlv('05', cleanTxid)) +
    '6304';

  return base + crc16Ccitt(base);
}

export const toolGerarCobrancaPix = {
  name: 'gerar_cobranca_pix',
  description:
    'Gera cobrança Pix Copia e Cola (BR Code offline) e QR Code PNG para envio no WhatsApp ao fechar atendimento ou reserva.',
  parameters: {
    type: 'OBJECT',
    properties: {
      valor: {
        type: 'NUMBER',
        description: 'Valor em reais (ex: 150.00). Omita ou use 0 para Pix sem valor fixo.'
      },
      descricao: {
        type: 'STRING',
        description: 'Descrição curta do pagamento ou reserva.'
      },
      txid: {
        type: 'STRING',
        description: 'Identificador alfanumérico opcional da cobrança (até 25 caracteres).'
      },
      chavePix: {
        type: 'STRING',
        description: 'Chave Pix opcional (usa PIX_KEY do ambiente/configuração por padrão).'
      },
      enviarWhatsApp: {
        type: 'BOOLEAN',
        description: 'Se true (padrão), envia a imagem do QR Code no WhatsApp do contato atual.'
      }
    },
    required: []
  },

  async execute(args = {}, context = {}) {
    const identity = resolveIdentity(context?.botConfig || {});
    const toolSettings = context?.botConfig?.tools?.settings?.gerar_cobranca_pix || {};
    const configuredKey = toolSettings.key || context?.botConfig?.integrations?.pix?.key || process.env.PIX_KEY || '';
    const pixKey = String((context?.actor !== 'client' && args.chavePix) ? args.chavePix : configuredKey).trim();

    if (!pixKey) {
      return {
        success: false,
        error: 'pix_key_not_configured',
        message: 'Chave Pix não configurada. Defina a Chave Pix no Catálogo de Ferramentas ou PIX_KEY no ambiente.'
      };
    }

    const amount = Number(args.valor || 0);
    const merchantName = toolSettings.merchantName || context?.botConfig?.integrations?.pix?.merchantName || identity.companyName || identity.botName || 'Lia Sync';
    const merchantCity = toolSettings.merchantCity || context?.botConfig?.integrations?.pix?.merchantCity || process.env.PIX_MERCHANT_CITY || 'SAO PAULO';
    const txid = args.txid || `LIA${Date.now().toString().slice(-8)}`;
    const payload = buildPixPayload({
      pixKey,
      amount,
      merchantName,
      merchantCity,
      txid,
      description: args.descricao || ''
    });

    const dataUrl = await QRCode.toDataURL(payload, { width: 512, margin: 2 });
    const shouldSend = args.enviarWhatsApp !== false;
    let qrCodeSent = false;

    if (shouldSend && context?.phone && context?.whatsapp?.sendImage) {
      const amountText = amount > 0 ? ` no valor de R$ ${amount.toFixed(2).replace('.', ',')}` : '';
      const caption = `Pix${amountText}${args.descricao ? ` — ${args.descricao}` : ''}\n\nCopia e Cola:\n${payload}`;
      await context.whatsapp.sendImage(context.phone, {
        dataUrl,
        mimetype: 'image/png',
        caption
      });
      qrCodeSent = true;
    }

    return {
      success: true,
      pixCopiaECola: payload,
      valor: amount > 0 ? Number(amount.toFixed(2)) : null,
      txid,
      favorecido: merchantName,
      qrCodeSent,
      qrCodeDataUrl: dataUrl
    };
  }
};
