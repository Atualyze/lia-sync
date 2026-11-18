import QRCode from 'qrcode';
import { resolveIdentity } from '../core/identity.mjs';
import { getSafeInfinitePayCheckoutUrl } from '../payment-urls.mjs';

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

function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== Number(digits[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === Number(digits[10]);
}

export function normalizePixKey(rawKey, keyType = 'auto') {
  const raw = String(rawKey || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw.toLowerCase();

  const type = String(keyType || 'auto').trim().toLowerCase();
  const digits = raw.replace(/\D/g, '');
  if (type === 'telefone' || type === 'phone' || type === 'celular') {
    if (!digits) return raw;
    return digits.startsWith('55') && digits.length >= 12 ? `+${digits}` : `+55${digits}`;
  }
  if (type === 'cpf' || type === 'cnpj') return digits || raw;
  if (type === 'email' || type === 'aleatoria') return raw;

  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`;
  if (/[()]/.test(raw) && (digits.length === 10 || digits.length === 11)) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return `+${digits}`;
  if (digits.length === 11 && !isValidCpf(digits) && /^[1-9]{2}9\d{8}$/.test(digits)) {
    return `+55${digits}`;
  }
  if (digits.length === 10 && /^[1-9]{2}[2-8]\d{7}$/.test(digits)) {
    return `+55${digits}`;
  }
  return raw;
}

function cleanPixDescription(description) {
  const raw = sanitizeAscii(description, 40);
  if (!raw) return '';
  if (/^(?:preciso|quero|pode|gostaria\s+de|me)?\s*(?:gerar|criar|fazer|enviar|mandar)?\s*(?:um|uma)?\s*(?:cobranca\s*)?pix$/i.test(raw)) {
    return '';
  }
  return raw;
}

export function buildPixPayload({
  pixKey,
  keyType = 'auto',
  amount = 0,
  merchantName = 'Lia Sync',
  merchantCity = 'SAO PAULO',
  txid = '***',
  description = ''
} = {}) {
  const cleanKey = normalizePixKey(pixKey, keyType);
  if (!cleanKey) throw new Error('Chave Pix não informada.');

  const cleanName = sanitizeAscii(merchantName, 25) || 'Lia Sync';
  const cleanCity = sanitizeAscii(merchantCity, 15) || 'SAO PAULO';
  const cleanTxid = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const cleanDesc = cleanPixDescription(description);

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
      keyType: toolSettings.keyType || 'auto',
      amount,
      merchantName,
      merchantCity,
      txid,
      description: args.descricao || ''
    });

    const dataUrl = await QRCode.toDataURL(payload, { width: 512, margin: 2 });
    const baseUrl = String(
      toolSettings.paymentBaseUrl ||
      process.env.PAYMENT_BASE_URL ||
      toolSettings.publicBaseUrl ||
      process.env.PUBLIC_BASE_URL ||
      process.env.DASHBOARD_ORIGIN ||
      'https://pay.atualyze.com.br'
    ).replace(/\/$/, '');
    const safeCheckoutUrl = amount > 0 ? getSafeInfinitePayCheckoutUrl(args.checkoutUrl) : '';
    const linkParams = new URLSearchParams({
      p: Buffer.from(payload, 'utf8').toString('base64url'),
      ...(amount > 0 ? { v: amount.toFixed(2) } : {}),
      n: merchantName,
      ...(args.descricao ? { d: String(args.descricao).slice(0, 80) } : {}),
      tx: txid,
      ...(safeCheckoutUrl
        ? { c: safeCheckoutUrl }
        : {})
    });
    const paymentUrl = baseUrl ? `${baseUrl}/pix?${linkParams.toString()}` : `/pix?${linkParams.toString()}`;

    const shouldSend = args.enviarWhatsApp !== false;
    const rawTarget = String(context?.targetPhone || context?.phone || '').trim();
    const isValidWhatsAppTarget = Boolean(rawTarget) && rawTarget !== '__owner_self__' && (/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(rawTarget) || /^\d{8,15}$/.test(rawTarget.replace(/\D/g, '')));
    let qrCodeSent = false;

    if (shouldSend && isValidWhatsAppTarget && context?.whatsapp?.sendImage) {
      const amountText = amount > 0 ? ` - R$ ${amount.toFixed(2).replace('.', ',')}` : '';
      const cleanDescCap = cleanPixDescription(args.descricao || '');
      const caption = `💳 *QR Code Pix*${amountText}${cleanDescCap ? ` (${cleanDescCap})` : ''}`;
      try {
        await context.whatsapp.sendImage(rawTarget, {
          dataUrl,
          mimetype: 'image/png',
          caption
        });
        qrCodeSent = true;
      } catch {
        // Falha no envio da imagem no WhatsApp não invalida o payload/link Pix gerado
        qrCodeSent = false;
      }
    }

    return {
      success: true,
      pixCopiaECola: payload,
      paymentUrl,
      valor: amount > 0 ? Number(amount.toFixed(2)) : null,
      txid,
      favorecido: merchantName,
      qrCodeSent,
      qrCodeDataUrl: dataUrl
    };
  }
};
