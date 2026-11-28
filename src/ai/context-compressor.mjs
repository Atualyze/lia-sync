/**
 * Compressão inteligente de histórico para provedores com janela/TPM limitada
 * (ex.: Groq free tier, OpenRouter :free, NVIDIA NIM), preservando os turnos recentes.
 */
export function compressHistoryForProvider(history = [], {
  maxMessages = 16,
  maxTotalChars = 12000,
  keepRecent = 6,
  olderTurnMaxChars = 220
} = {}) {
  const list = Array.isArray(history) ? history.filter(item => item && typeof item.content === 'string' && item.content.trim()) : [];
  if (!list.length) return [];

  const sliced = list.length > maxMessages ? list.slice(-maxMessages) : list;
  const splitIdx = Math.max(0, sliced.length - keepRecent);

  const compressed = sliced.map((item, idx) => {
    const content = String(item.content || '').trim();
    if (idx >= splitIdx || content.length <= olderTurnMaxChars) {
      return { role: item.role === 'assistant' ? 'assistant' : 'user', content };
    }
    const head = Math.floor(olderTurnMaxChars * 0.65);
    const tail = Math.max(24, olderTurnMaxChars - head - 7);
    return {
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: `${content.slice(0, head)} [...] ${content.slice(-tail)}`
    };
  });

  let totalChars = compressed.reduce((sum, item) => sum + item.content.length, 0);
  while (compressed.length > 2 && totalChars > maxTotalChars) {
    const removed = compressed.shift();
    totalChars -= removed.content.length;
  }
  return compressed;
}
