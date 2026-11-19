import { randomUUID } from 'node:crypto';

export const OUTBOUND_DISPATCH_TTL_MS = 15 * 60 * 1000;

export function createOutboundDispatchPreview(session, prepared, {
  now = Date.now,
  source = 'copilot',
  resumeBot = false,
  metadata = {}
} = {}) {
  if (!session || !prepared?.phone || (!prepared?.message && !prepared?.document)) return null;
  const existing = session.pendingOutboundDispatch;
  const existingAt = Date.parse(existing?.createdAt || '');
  const existingActive = existing && (
    existing.status === 'sending' || existing.status === 'uncertain' ||
    (existing.status === 'pending' && Number.isFinite(existingAt) && now() - existingAt <= OUTBOUND_DISPATCH_TTL_MS)
  );
  if (existingActive) return null;

  const pending = {
    id: randomUUID().slice(0, 8).toUpperCase(),
    phone: String(prepared.phone),
    recipient: String(prepared.recipient || prepared.phone),
    message: String(prepared.message || `Documento: ${prepared.document?.fileName || 'arquivo'}`),
    asAudio: prepared.asAudio === true,
    ...(prepared.document ? { document: prepared.document } : {}),
    source,
    resumeBot: resumeBot === true,
    status: 'pending',
    createdAt: new Date(now()).toISOString(),
    ...metadata
  };
  session.pendingOutboundDispatch = pending;
  const format = pending.document
    ? `📎 *Anexo:* ${pending.document.fileName || 'arquivo'}${pending.document.caption ? `\n*Legenda:* ${pending.document.caption}` : ''}`
    : pending.asAudio ? '🎙️ *Roteiro do áudio:*' : '💬 *Mensagem:*';
  const body = pending.document ? format : `${format}\n> "${pending.message}"`;
  const preview = `📨 *Prévia do disparo para ${pending.recipient} (${pending.phone}):*\n\n${body}\n\nConfirma o envio exatamente assim? Responda *sim* para enviar ou *não* para cancelar. Você também pode escrever livremente, como *pode enviar* ou *cancela*. A prévia expira em 15 minutos.`;
  return { pending, preview };
}
