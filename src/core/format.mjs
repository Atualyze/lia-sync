/**
 * Formatação de saída de todas as mensagens geradas pela assistente.
 * Transforma texto cru em mensagens de WhatsApp bem distribuídas:
 * negrito em rótulos, bullets próprios, parágrafos curtos e quebras consistentes.
 * É idempotente: aplicar duas vezes não degrada o texto.
 */

const LABEL_RE = /^([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 /&()+.'-]{1,30}):\s+(.+)$/;

function boldLabels(text = '') {
  return String(text)
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      // já formatado, bullet, muito longo ou sem rótulo → não mexe
      if (!trimmed || trimmed.includes('*') || trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.length > 140) return line;
      const m = trimmed.match(LABEL_RE);
      if (!m) return line;
      const label = m[1];
      const value = m[2];
      // rótulo deve ter poucas palavras e não parecer frase
      if (label.split(/\s+/).length > 5 || /[.!?]$/.test(label)) return line;
      return line.replace(trimmed, `*${label}:* ${value}`);
    })
    .join('\n');
}

function splitLongParagraphs(text = '') {
  return String(text)
    .split('\n')
    .map(line => {
      const flat = line.trim();
      // Nunca quebra blocos de código, códigos Pix EMV (000201... / br.gov.bcb.pix),
      // URLs longas ou tokens sem espaços (boletos/chaves/hashes).
      if (
        flat.length <= 120
        || flat.includes('*')
        || flat.includes('•')
        || flat.includes('`')
        || /000201|br\.gov\.bcb\.pix|https?:\/\//i.test(flat)
        || (flat.match(/\s/g) || []).length < 4
      ) return line;
      // Só quebra em pontuação seguida de espaço (nunca em pontos internos como domínios ou decimais)
      const sentences = flat.match(/[^.!?]+(?:[.!?]+["')\]]?(?=\s+|$)|$)/g)?.map(s => s.trim()).filter(Boolean) || [flat];
      if (sentences.length < 2) return line;
      const blocks = [];
      let current = '';
      let sentenceCount = 0;
      for (const sentence of sentences) {
        if (current && ((current.length + sentence.length) > 220 || sentenceCount >= 2)) {
          blocks.push(current.trim());
          current = sentence;
          sentenceCount = 1;
        } else {
          current = current ? `${current} ${sentence}` : sentence;
          sentenceCount += 1;
        }
      }
      if (current) blocks.push(current.trim());
      return blocks.join('\n\n');
    })
    .join('\n');
}

function normalizeBullets(text = '') {
  return String(text)
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/([^\n])\s*•\s*/g, '$1\n• ')
    .replace(/\n{3,}/g, '\n\n');
}

export function formatOutgoingMessage(text = '') {
  let out = String(text || '')
    // Alguns provedores devolvem a string do JSON sem desserializar os \\n.
    // Converta somente sequências escapadas de quebra, sem tocar em URLs ou
    // barras legítimas do conteúdo.
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\*\*(.*?)\*\*/gs, '*$1*')
    .replace(/__(.*?)__/gs, '*$1*')
    .replace(/^\s*#{1,6}\s?(.+)$/gm, '*$1*')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n');

  out = normalizeBullets(out);
  out = boldLabels(out);
  out = splitLongParagraphs(out);
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}
