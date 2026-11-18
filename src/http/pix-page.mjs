import QRCode from 'qrcode';

const escHtml = (v = '') =>
  String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

function readTlv(payload, start = 0) {
  const id = payload.slice(start, start + 2);
  const length = Number(payload.slice(start + 2, start + 4));
  if (!id || !Number.isFinite(length)) return null;
  const valueStart = start + 4;
  return { id, length, value: payload.slice(valueStart, valueStart + length), next: valueStart + length };
}

function extractPixKey(payload) {
  const merchant = readTlv(payload, 6);
  if (!merchant || merchant.id !== '26') return '';
  let cursor = 0;
  while (cursor < merchant.value.length) {
    const item = readTlv(merchant.value, cursor);
    if (!item) break;
    if (item.id === '01') return item.value;
    cursor = item.next;
  }
  return '';
}

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
    return res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pagamento indisponível</title></head><body style="margin:0;min-height:100dvh;display:grid;place-items:center;background:#07131a;color:#f5fbff;font:500 16px system-ui,sans-serif"><main style="max-width:420px;padding:28px;text-align:center"><strong style="font-size:42px">×</strong><h1>Link Pix inválido</h1><p>Este link está incompleto ou expirou. Solicite uma nova cobrança.</p></main></body></html>`);
  }

  const rawAmount = Number(urlObj.searchParams.get('v') || 0);
  const amountText = Number.isFinite(rawAmount) && rawAmount > 0
    ? `R$ ${rawAmount.toFixed(2).replace('.', ',')}`
    : 'Valor livre';
  const merchantName = (urlObj.searchParams.get('n') || 'Atualyze').slice(0, 40);
  const description = (urlObj.searchParams.get('d') || '').slice(0, 80);
  const txid = (urlObj.searchParams.get('tx') || '').slice(0, 25);
  const pixKey = (urlObj.searchParams.get('k') || extractPixKey(payload)).slice(0, 120);
  const checkoutUrl = urlObj.searchParams.get('c') || '';
  const safeCheckoutUrl = /^https:\/\/(?:checkout\.)?infinitepay\.io\//i.test(checkoutUrl) ? checkoutUrl : '';
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 420, margin: 1, color: { dark: '#09222c', light: '#ffffff' } });
  const hasKey = Boolean(pixKey);

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#07131a" />
  <meta name="description" content="Pagamento seguro por Pix ou InfinitePay." />
  <title>Pagamento · ${escHtml(merchantName)}</title>
  <style>
    :root { color-scheme: dark; --ink:#effaff; --muted:#9fb6bf; --line:rgba(182,232,235,.16); --panel:rgba(11,31,41,.82); --accent:#62e6c2; --accent-2:#63c7ff; --deep:#07131a; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100dvh; color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; background:radial-gradient(circle at 20% 0%,#12475a 0,#07131a 42%,#050b10 100%); }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(to bottom,#000,transparent 75%); }
    .shell { width:min(1080px,100%); margin:0 auto; padding:clamp(22px,5vw,64px) clamp(16px,4vw,32px); position:relative; }
    .brand { display:flex; align-items:center; gap:12px; margin-bottom:clamp(34px,7vw,72px); }
    .mark { display:grid; place-items:center; width:42px; height:42px; border-radius:14px; color:#06211e; background:linear-gradient(135deg,var(--accent),#bbffe8); font-size:22px; font-weight:900; box-shadow:0 12px 30px rgba(98,230,194,.18); }
    .brand-name { font-size:14px; letter-spacing:.16em; text-transform:uppercase; font-weight:800; }
    .brand-sub { margin-top:3px; color:var(--muted); font-size:12px; }
    .layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(330px,440px); gap:clamp(28px,7vw,88px); align-items:center; }
    .eyebrow { display:inline-flex; align-items:center; gap:8px; color:var(--accent); font-weight:800; font-size:12px; letter-spacing:.13em; text-transform:uppercase; }
    .eyebrow:before { content:""; width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 6px rgba(98,230,194,.12); }
    h1 { margin:20px 0 14px; max-width:580px; font-size:clamp(34px,6vw,64px); line-height:.98; letter-spacing:-.055em; }
    .lead { max-width:510px; margin:0; color:#bad0d6; font-size:clamp(16px,2vw,19px); line-height:1.55; }
    .summary { margin-top:30px; display:flex; flex-wrap:wrap; gap:10px; }
    .pill { border:1px solid var(--line); background:rgba(255,255,255,.045); border-radius:999px; padding:9px 13px; color:#c8dce1; font-size:13px; }
    .card { padding:clamp(20px,4vw,30px); border:1px solid var(--line); border-radius:28px; background:linear-gradient(150deg,rgba(18,48,60,.92),rgba(7,20,28,.94)); box-shadow:0 28px 80px rgba(0,0,0,.3),inset 0 1px rgba(255,255,255,.07); }
    .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:20px; }
    .card-label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.13em; font-weight:800; }
    .secure { color:#a8f4dd; font-size:12px; white-space:nowrap; }
    .secure:before { content:"✓"; display:inline-grid; place-items:center; width:18px; height:18px; margin-right:5px; border-radius:50%; background:rgba(98,230,194,.14); }
    .amount { margin:6px 0 4px; font-size:clamp(32px,6vw,46px); font-weight:850; letter-spacing:-.055em; }
    .description { min-height:20px; margin:0 0 20px; color:var(--muted); font-size:14px; }
    .qr { display:grid; place-items:center; padding:14px; border-radius:20px; background:#fff; box-shadow:0 14px 40px rgba(0,0,0,.22); }
    .qr img { display:block; width:min(100%,290px); aspect-ratio:1; }
    .actions { display:grid; gap:10px; margin-top:18px; }
    button, .action { display:flex; align-items:center; justify-content:center; gap:9px; min-height:49px; width:100%; border:1px solid transparent; border-radius:14px; padding:13px 16px; font:800 14px inherit; text-decoration:none; cursor:pointer; transition:transform .16s ease,background .16s ease,border-color .16s ease; }
    button:hover, .action:hover { transform:translateY(-1px); }
    .primary { color:#05211c; background:linear-gradient(135deg,#86f5d1,var(--accent)); }
    .secondary { color:var(--ink); border-color:var(--line); background:rgba(255,255,255,.055); }
    .checkout { color:#061b2b; background:linear-gradient(135deg,#8bddff,var(--accent-2)); }
    .key-row { display:flex; align-items:center; gap:9px; margin-top:15px; padding:12px; border:1px solid var(--line); border-radius:14px; background:rgba(0,0,0,.14); }
    .key-label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.1em; white-space:nowrap; }
    .key-value { min-width:0; overflow:hidden; text-overflow:ellipsis; color:#dff8f3; font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .tiny { margin:16px 0 0; color:#78919a; font-size:11px; line-height:1.5; text-align:center; }
    .toast { position:fixed; left:50%; bottom:24px; transform:translate(-50%,20px); opacity:0; pointer-events:none; padding:11px 16px; border:1px solid rgba(134,245,209,.35); border-radius:999px; color:#dffef2; background:#0d2e2b; box-shadow:0 12px 35px rgba(0,0,0,.3); transition:.2s ease; font-size:13px; font-weight:800; }
    .toast.show { opacity:1; transform:translate(-50%,0); }
    @media (max-width:760px) { .shell { padding-top:22px; } .brand { margin-bottom:42px; } .layout { grid-template-columns:1fr; gap:34px; } h1 { max-width:440px; } .card { max-width:520px; width:100%; margin:0 auto; } }
    @media (max-width:400px) { .card { border-radius:22px; padding:18px; } .key-row { align-items:flex-start; flex-direction:column; gap:5px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="brand"><div class="mark">A</div><div><div class="brand-name">Atualyze Pay</div><div class="brand-sub">Pagamento simples, claro e seguro</div></div></header>
    <section class="layout">
      <div class="intro"><div class="eyebrow">Pagamento protegido</div><h1>Escolha como deseja pagar.</h1><p class="lead">Use o QR Code, copie o código Pix ou abra o checkout InfinitePay. Tudo reunido em um só lugar para facilitar no celular ou no computador.</p><div class="summary"><span class="pill">Pix instantâneo</span><span class="pill">Checkout InfinitePay</span><span class="pill">Seguro e responsivo</span></div></div>
      <section class="card" aria-label="Detalhes do pagamento">
        <div class="card-head"><div><div class="card-label">Pagamento para</div><strong>${escHtml(merchantName)}</strong></div><div class="secure">Seguro</div></div>
        <div class="amount">${escHtml(amountText)}</div>
        <p class="description">${escHtml(description || 'Pagamento via Pix')}</p>
        <div class="qr"><img src="${qrDataUrl}" alt="QR Code Pix para pagamento" /></div>
        <div class="actions">
          <button class="primary" id="copy-code" type="button">▣&nbsp; Copiar código Pix</button>
          ${hasKey ? '<button class="secondary" id="copy-key" type="button">⌁&nbsp; Copiar chave Pix</button>' : ''}
          ${safeCheckoutUrl ? `<a class="action checkout" href="${escHtml(safeCheckoutUrl)}" target="_blank" rel="noopener">↗&nbsp; Pagar com InfinitePay</a>` : ''}
        </div>
        ${hasKey ? `<div class="key-row"><span class="key-label">Chave Pix</span><span class="key-value">${escHtml(pixKey)}</span></div>` : ''}
        <p class="tiny">Ao pagar, confira o nome do recebedor no seu banco antes de confirmar.</p>
      </section>
    </section>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script>
    const payload = ${JSON.stringify(payload)};
    const pixKey = ${JSON.stringify(pixKey)};
    const toast = document.getElementById('toast');
    let toastTimer;
    function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400); }
    async function copyText(value, label) {
      try { await navigator.clipboard.writeText(value); }
      catch { const area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
      showToast(label + ' copiado');
    }
    document.getElementById('copy-code')?.addEventListener('click', () => copyText(payload, 'Código Pix'));
    document.getElementById('copy-key')?.addEventListener('click', () => copyText(pixKey, 'Chave Pix'));
  </script>
</body>
</html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  return res.end(html);
}
