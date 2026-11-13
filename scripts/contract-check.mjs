import { readFile } from 'node:fs/promises';

const migration = await readFile('supabase/migrations/20261112220000_phone_suppressions.sql', 'utf8');
const campaigns = await readFile('src/campaigns.mjs', 'utf8');
const dashboardRoutes = await readFile('src/http/dashboard.mjs', 'utf8');
const router = await readFile('src/http/router.mjs', 'utf8');
const index = await readFile('public/index.html', 'utf8');
const app = await readFile('public/app.js', 'utf8');
const supabaseClient = await readFile('public/vendor/supabase.js', 'utf8');
const checks = [
  ['canonical suppression table', migration.includes('create table if not exists public.phone_suppressions')],
  ['unique phone and RLS', migration.includes('phone text primary key') && migration.includes('enable row level security')],
  ['browser has no suppression policy', !migration.includes('create policy')],
  ['suppressed recipient status', migration.includes("'suppressed'") && campaigns.includes("status: 'suppressed'")],
  ['provider is skipped for opt-out', campaigns.includes('isSuppressed') && campaigns.includes('continue;')],
  ['campaign completion includes suppressed', campaigns.includes("'sent', 'failed', 'suppressed'")],
  ['dashboard health route is authenticated by router', dashboardRoutes.includes('/api/dashboard/health-summary') && router.includes("u.pathname.startsWith('/api/dashboard/')")],
  ['operations route masks suppression phones', dashboardRoutes.includes('/api/dashboard/operations') && dashboardRoutes.includes('maskPhone')],
  ['metrics label estimated cost', dashboardRoutes.includes('estimatedCost') && dashboardRoutes.includes('estimate: true')],
  ['safe integration test is simulation-only by default', index.includes('Simulador Isolado') && index.includes('Nenhuma dessas ações envia WhatsApp real') && app.includes("/api/dashboard/ping-ai")],
  ['critical operations elements exist', ['overview-health', 'overview-costs', 'overview-models', 'overview-operations', 'admin-publish'].every(id => index.includes(`id="${id}"`))],
  ['supabase captcha payload uses gotrue metadata', supabaseClient.includes('gotrue_meta_security: { captcha_token: captchaToken }') && !supabaseClient.includes('...(captchaToken ? { captcha_token: captchaToken } : {})')],
];
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (checks.some(([, passed]) => !passed)) process.exit(1);
