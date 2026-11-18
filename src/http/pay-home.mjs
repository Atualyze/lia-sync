export function renderPayHomePage(res) {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#07131a" />
  <meta name="description" content="Portal público de pagamentos da Atualyze. Acesse seu link de cobrança para pagar por Pix ou InfinitePay." />
  <title>Atualyze Pay · Portal de pagamentos</title>
  <style>
    :root { color-scheme:dark; --ink:#effaff; --muted:#a8bec6; --line:rgba(182,232,235,.16); --accent:#62e6c2; --blue:#63c7ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100dvh; color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; background:radial-gradient(circle at 18% 0%,#12475a 0,#07131a 42%,#050b10 100%); }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.2; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:32px 32px; mask-image:linear-gradient(to bottom,#000,transparent 75%); }
    .shell { width:min(960px,100%); margin:0 auto; padding:clamp(24px,6vw,64px) clamp(18px,4vw,32px); position:relative; }
    .brand { display:flex; align-items:center; gap:12px; margin-bottom:clamp(54px,10vw,100px); }
    .mark { display:grid; place-items:center; width:44px; height:44px; border-radius:15px; color:#06211e; background:linear-gradient(135deg,var(--accent),#bbffe8); font-size:23px; font-weight:900; box-shadow:0 12px 30px rgba(98,230,194,.18); }
    .brand-name { font-size:14px; letter-spacing:.16em; text-transform:uppercase; font-weight:850; }
    .brand-sub { margin-top:3px; color:var(--muted); font-size:12px; }
    .hero { max-width:760px; }
    .eyebrow { display:inline-flex; align-items:center; gap:9px; color:var(--accent); font-size:12px; font-weight:850; letter-spacing:.13em; text-transform:uppercase; }
    .eyebrow:before { content:""; width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 6px rgba(98,230,194,.12); }
    h1 { margin:20px 0 18px; max-width:700px; font-size:clamp(38px,7vw,72px); line-height:.98; letter-spacing:-.055em; }
    .lead { max-width:640px; margin:0; color:#bad0d6; font-size:clamp(16px,2vw,19px); line-height:1.65; }
    .methods { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-top:clamp(32px,6vw,52px); }
    .method { padding:22px; border:1px solid var(--line); border-radius:22px; background:linear-gradient(150deg,rgba(18,48,60,.82),rgba(7,20,28,.88)); box-shadow:0 22px 60px rgba(0,0,0,.18),inset 0 1px rgba(255,255,255,.05); }
    .method-icon { display:grid; place-items:center; width:38px; height:38px; margin-bottom:18px; border-radius:12px; color:#06211e; background:linear-gradient(135deg,#86f5d1,var(--accent)); font-size:20px; font-weight:900; }
    .method:nth-child(2) .method-icon { background:linear-gradient(135deg,#a4e5ff,var(--blue)); }
    .method h2 { margin:0 0 8px; font-size:17px; letter-spacing:-.02em; }
    .method p { margin:0; color:var(--muted); font-size:14px; line-height:1.55; }
    .notice { display:flex; gap:12px; align-items:flex-start; margin-top:20px; padding:16px 18px; border:1px solid rgba(182,232,235,.12); border-radius:16px; color:#b6cbd1; background:rgba(255,255,255,.035); font-size:13px; line-height:1.55; }
    .notice strong { color:#e3f5f5; }
    footer { margin-top:clamp(44px,8vw,76px); padding-top:18px; border-top:1px solid var(--line); color:#78919a; font-size:12px; }
    @media (max-width:560px) { .brand { margin-bottom:58px; } .methods { grid-template-columns:1fr; } .method { padding:19px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="brand"><div class="mark" aria-hidden="true">A</div><div><div class="brand-name">Atualyze Pay</div><div class="brand-sub">Portal de pagamentos</div></div></header>
    <section class="hero" aria-labelledby="title">
      <div class="eyebrow">Bem-vindo</div>
      <h1 id="title">Pagamentos simples, em um só lugar.</h1>
      <p class="lead">Este é o portal público de pagamentos da Atualyze. Para pagar uma cobrança, abra o link de pagamento que você recebeu pelo nosso atendimento.</p>
      <div class="methods">
        <article class="method"><div class="method-icon" aria-hidden="true">▦</div><h2>Pix</h2><p>No link da cobrança, escaneie o QR Code ou copie o código Pix para pagar no aplicativo do seu banco.</p></article>
        <article class="method"><div class="method-icon" aria-hidden="true">↗</div><h2>InfinitePay</h2><p>Quando disponível, o link da cobrança também oferece a opção de continuar pelo checkout InfinitePay.</p></article>
      </div>
      <p class="notice"><span aria-hidden="true">ⓘ</span><span><strong>Não recebeu um link de cobrança?</strong> Entre em contato com o atendimento da Atualyze para solicitar ou confirmar os dados do pagamento. Antes de pagar, confira os dados do recebedor no seu banco.</span></p>
    </section>
    <footer>Atualyze Pay · Pagamentos da Atualyze</footer>
  </main>
</body>
</html>`;

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  return res.end(html);
}
