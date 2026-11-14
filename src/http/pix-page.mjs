import QRCode from 'qrcode';

const escHtml = (v = '') =>
  String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

export async function renderPixPaymentPage(res, urlObj) {
  const encodedPayload = urlObj.searchParams.get('p') || '';
  let payload = '';
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8').trim();
  } catch {
    payload = '';
  }

  if (!payload || !payload.startsWith('000201') || payload.length > 512) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html lang="pt-BR"><body style="background:#131313;color:#F5F5F5;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><p>Link Pix inválido ou expirado.</p></body></html>');
  }

  const rawAmount = Number(urlObj.searchParams.get('v') || 0);
  const amountText = Number.isFinite(rawAmount) && rawAmount > 0
    ? `R$ ${rawAmount.toFixed(2).replace('.', ',')}`
    : 'Valor livre';
  const merchantName = (urlObj.searchParams.get('n') || 'Lia Sync').slice(0, 40);
  const description = (urlObj.searchParams.get('d') || '').slice(0, 80);
  const txid = (urlObj.searchParams.get('tx') || '').slice(0, 25);

  const qrDataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 1 });

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Pagamento Pix · ${escHtml(merchantName)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      background: #131313;
      color: #F5F5F5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: grid;
      place-items: center;
      padding: 16px;
    }
    .card {
      width: 100%;
      max-width: 360px;
      background: #1C1D1F;
      border: 1px solid #2D2E33;
      border-radius: 16px;
      padding: 20px 18px;
      text-align: center;
    }
    .tag {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #86DEBA;
      background: #172B24;
      border: 1px solid #27845F;
      border-radius: 999px;
      padding: 3px 10px;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 4px; font-size: 17px; font-weight: 650; }
    .desc { margin: 0 0 12px; font-size: 12.5px; color: #A6A8B1; }
    .amount { font-size: 26px; font-weight: 700; color: #86DEBA; margin: 0 0 14px; }
    .qr-wrap {
      background: #FFFFFF;
      border-radius: 12px;
      padding: 10px;
      display: inline-block;
      margin-bottom: 14px;
    }
    .qr-wrap img { display: block; width: 200px; height: 200px; max-width: 100%; }
    .code-box {
      width: 100%;
      background: #252629;
      border: 1px solid #2D2E33;
      border-radius: 10px;
      color: #A6A8B1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      padding: 9px 10px;
      resize: none;
      text-align: left;
      margin-bottom: 10px;
    }
    .btn {
      width: 100%;
      height: 42px;
      border: 0;
      border-radius: 10px;
      background: #48AA7E;
      color: #0B1913;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn:hover { background: #58BC8F; }
    .btn.copied { background: #295C6F; color: #F5F5F5; }
    .meta { margin-top: 10px; font-size: 11px; color: #A6A8B1; }
  </style>
</head>
<body>
  <main class="card">
    <span class="tag">Pix Copia e Cola</span>
    <h1>${escHtml(merchantName)}</h1>
    ${description ? `<p class="desc">${escHtml(description)}</p>` : ''}
    <div class="amount">${escHtml(amountText)}</div>
    <div class="qr-wrap"><img src="${qrDataUrl}" alt="QR Code Pix" /></div>
    <textarea id="pix-code" class="code-box" rows="2" readonly>${escHtml(payload)}</textarea>
    <button id="copy-btn" class="btn" type="button">Copiar código Pix</button>
    ${txid ? `<div class="meta">ID: ${escHtml(txid)}</div>` : ''}
  </main>
  <script>
    const btn = document.getElementById('copy-btn');
    const box = document.getElementById('pix-code');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(box.value);
      } catch {
        box.select();
        document.execCommand('copy');
      }
      btn.textContent = 'Código Pix copiado!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copiar código Pix';
        btn.classList.remove('copied');
      }, 2400);
    });
  </script>
</body>
</html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  return res.end(html);
}
