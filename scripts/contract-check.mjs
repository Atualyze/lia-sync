import { readFile } from 'node:fs/promises';

const legacyMigration = await readFile('supabase/migrations/20261112220000_phone_suppressions.sql', 'utf8');
const observabilityMigration = await readFile('supabase/migrations/20261113000000_operations_observability.sql', 'utf8');
const campaigns = await readFile('src/campaigns.mjs', 'utf8');
const dashboardRoutes = await readFile('src/http/dashboard.mjs', 'utf8');
const operationsRoutes = await readFile('src/http/operations.mjs', 'utf8');
const operations = await readFile('src/operations.mjs', 'utf8');
const router = await readFile('src/http/router.mjs', 'utf8');
const webhook = await readFile('src/http/webhook.mjs', 'utf8');
const webhookEvents = await readFile('src/webhook-events.mjs', 'utf8');
const whatsapp = await readFile('src/whatsapp.mjs', 'utf8');
const index = await readFile('public/index.html', 'utf8');
const app = await readFile('public/app.js', 'utf8');
const supabaseClient = await readFile('public/vendor/supabase.js', 'utf8');
const bridgeRoutes = await readFile('src/http/bridge-routes.mjs', 'utf8');
const bridgeStatus = await readFile('src/http/bridge-config-status.mjs', 'utf8');
const adminConfigSchema = await readFile('src/admin-config.mjs', 'utf8');
const sectorsProjection = await readFile('src/sectors.mjs', 'utf8');
const clientFlow = await readFile('src/flow/client.mjs', 'utf8');
const copilotTasks = await readFile('src/copilot-tasks.mjs', 'utf8');
const copilotWorker = await readFile('src/copilot-task-worker.mjs', 'utf8');
const copilotTaskMigration = await readFile('supabase/migrations/20261120150000_copilot_task_queue.sql', 'utf8');
const copilotTaskSchema = await readFile('supabase/complete_schema_migration.sql', 'utf8');
const copilotOwnerFlow = await readFile('src/flow/owner.mjs', 'utf8');
const copilotContinuity = await readFile('src/flow/copilot-continuity.mjs', 'utf8');
const copilotServer = await readFile('src/server.mjs', 'utf8');
const copilotFlow = await readFile('src/flow.mjs', 'utf8');
const checks = [
  ['canonical suppression table with RLS and no browser policy', legacyMigration.includes('create table if not exists public.phone_suppressions') && legacyMigration.includes('phone text primary key') && legacyMigration.includes('enable row level security') && !legacyMigration.includes('create policy')],
  ['campaign claims and retry state are persisted', observabilityMigration.includes("'sending'") && observabilityMigration.includes('attempt_count') && campaigns.includes('status=in.(pending,paused)') && campaigns.includes("status: 'sending'")],
  ['suppressed contacts are skipped and marked', campaigns.includes('isSuppressed') && campaigns.includes('continue;') && campaigns.includes("status: 'suppressed'")],
  ['outbound Evolution sends run the central suppression check', whatsapp.includes('setOutboundSuppressionCheck') && whatsapp.includes('outboundSuppressionCheck') && whatsapp.includes('recipient_opted_out')],
  ['campaign create does not send and execute requires explicit confirmation', operationsRoutes.includes("u.pathname === '/api/dashboard/campaigns'") && operationsRoutes.includes('body.confirm !== true')],
  ['campaign execution and suppression removal are restricted to admin', router.includes("{ method: 'POST', pattern: /^\\/api\\/dashboard\\/campaigns\\/[0-9a-f-]{36}\\/execute$/i, role: 'admin' }") && router.includes("{ method: 'DELETE', path: '/api/dashboard/suppressions', role: 'admin' }") && operationsRoutes.includes('body.confirm !== true')],
  ['dashboard role guard is separate from machine bridge', router.includes('ROLE_RANK') && router.includes('handleBridgeRoutes') && router.includes('webhookAuthorize') && router.includes('authContext.role')],
  ['viewer UI does not request sessions or conversation content', app.includes("if ((ROLE_LEVEL[state.role] ?? 0) >= ROLE_LEVEL.operator)") && app.includes("state.sessions = [];")],
  ['operations endpoint returns campaign summaries and masked suppressions', operationsRoutes.includes('listSummaries()') && operationsRoutes.includes('maskPhone(item.phone)')],
  ['persistent metrics use ai_calls and do not claim zero cost without rates', operations.includes("'ai_calls'") && operations.includes('estimatedCost') && operations.includes('monthlyMissingRates') && operations.includes('totalUsd: costComplete ? knownMonthlyUsd : null')],
  ['tool catalog and web search settings are wired to draft config', operationsRoutes.includes('safeToolCatalog') && operationsRoutes.includes('webSearchEnabled') && app.includes("api('/api/dashboard/tools'") && app.includes('tools-catalog')],
  ['user profiles and audit endpoints are admin-protected and sanitized', router.includes("{ prefix: '/api/dashboard/users', role: 'admin' }") && router.includes("{ path: '/api/dashboard/audit', role: 'admin' }") && operationsRoutes.includes("u.pathname === '/api/dashboard/users'") && operations.includes('safeMetadata')],
  ['webhook ledger stores hashed identity, status, retries, and no raw payload', webhookEvents.includes("createHash('sha256')") && webhookEvents.includes('attempt_count') && webhookEvents.includes('status=eq.${expectedStatus}') && !webhookEvents.includes('payload')],
  ['webhook handling records processed, ignored, and failed outcomes', webhook.includes("finish('processed')") && webhook.includes("finish('ignored'") && webhook.includes("finish('failed'")],
  ['integration status and detailed dashboard views exist', operationsRoutes.includes("u.pathname === '/api/dashboard/integrations'") && index.includes('id="tools-view"') && index.includes('id="integrations-view"') && index.includes('id="users-view"')],
  ['published Lia config bridge is read-only, versioned, allowlisted and fail-closed', bridgeRoutes.includes("u.pathname === '/api/bridge/v1/config'") && bridgeRoutes.includes("req.method !== 'GET'") && bridgeRoutes.includes("adminConfig.persistence !== 'supabase'") && bridgeRoutes.includes('publicLiaConfig(adminConfig.active)') && bridgeRoutes.includes("req.headers['if-none-match']") && bridgeRoutes.includes('markBridgeConfigRead(revision)')],
  ['Lia admin form centralizes runtime settings and derives tool calling from agent mode', ['ai.agentMode', 'automation.enableMediaProcessing', 'automation.enableProactiveFollowUp', 'automation.businessHoursOnly', 'automation.autoHandoffOnHumanPresence', 'automation.maxDailyFollowUps', 'voice.voiceName', 'voice.tone', 'voice.autoVoiceOnAudio'].every(key => index.includes(`data-config="${key}"`)) && app.includes("draft.ai.enableToolCalling = draft.ai.agentMode === 'super_agente'")],
  ['integration dashboard reports whether Chatwoot bridge has read a published revision', operationsRoutes.includes('getBridgeConfigStatus') && bridgeStatus.includes('lastReadAt') && app.includes('Ponte Chatwoot Lia') && app.includes('chatwootBridge?.revision')],
  ['expediente é editado só no painel central e validado antes de publicar', index.includes('data-config="business.hoursConfig.enabled"') && index.includes('admin-hours-weekday') && app.includes('draft.business.hoursConfig.weekdays') && adminConfigSchema.includes('function validateHoursConfig')],
  ['ponte projeta o expediente derivado sem revelar o aviso ao cliente', bridgeRoutes.includes('resumoJanelaDeAtendimento(active.business?.hoursConfig)') && !bridgeRoutes.includes('outOfHoursNotice')],
  ['setores ficam fora da configuração publicada e valem como projeção de runtime', !adminConfigSchema.includes('sectors') && sectorsProjection.includes('MAX_SECTORS') && bridgeRoutes.includes("u.pathname === '/api/bridge/v1/sectors'")],
  ['motor usa a projeção de setores da ponte com compatibilidade para publicações antigas', clientFlow.includes('Array.isArray(sectors) && sectors.length') && clientFlow.includes("botConfig?.business?.sectors")],
  ['integrações mostram o expediente efetivo e a projeção de setores recebida', operationsRoutes.includes('resumoJanelaDeAtendimento(adminConfig?.active?.business?.hoursConfig)') && operationsRoutes.includes('sectorsProjection: sectorProjection') && app.includes("'Expediente da Lia'") && app.includes("'Setores do Chatwoot'")],
  ['safe integration test is simulation-only by default', index.includes('Simulador Isolado') && (index.includes('Nenhuma dessas ações envia WhatsApp real') || index.includes('sem envio real no WhatsApp')) && app.includes("/api/dashboard/ping-ai")],
  ['critical overview elements exist', ['overview-health', 'overview-costs', 'overview-models', 'overview-operations', 'admin-publish'].every(id => index.includes(`id="${id}"`))],
  ['Supabase captcha payload uses GoTrue metadata', supabaseClient.includes('gotrue_meta_security: { captcha_token: captchaToken }') && !supabaseClient.includes('...(captchaToken ? { captcha_token: captchaToken } : {})')],
  ['Copilot task queue persists idempotent jobs and fails closed on corrupt local state', copilotTasks.includes('createCopilotTaskKey') && copilotTasks.includes('getById') && copilotTasks.includes('localCorrupt') && copilotTasks.includes('claimPendingNotification')],
  ['Copilot worker revalidates plans and stops on unverified results', copilotWorker.includes('buildCopilotToolPlan') && copilotWorker.includes('verifyCopilotToolResult') && copilotWorker.includes('pix_task_must_be_single_step')],
  ['Copilot queue migration is backend-only and claims jobs atomically with valid PostgreSQL clause order', copilotTaskMigration.includes('enable row level security') && !copilotTaskMigration.includes('create policy') && copilotTaskMigration.includes('for update skip locked') && copilotTaskMigration.includes('limit 1\n  for update skip locked') && copilotTaskMigration.includes('copilot_tasks_pix_never_retries') && copilotTaskMigration.includes('copilot_tasks_pix_single_step')],
  ['complete Supabase schema includes the current Copilot queue migration', copilotTaskSchema.includes('-- ======== 20261120150000_copilot_task_queue.sql ========') && copilotTaskSchema.includes('copilot_tasks_pix_single_step')],
  ['owner flow queues eligible tasks, reads active task status, and blocks unsupported execution promises', copilotOwnerFlow.includes('enqueueBackgroundTask') && copilotOwnerFlow.includes('getById(activeTaskId') && copilotOwnerFlow.includes('claimsUnexecutedToolWork(rawReply)')],
  ['Copilot continuity handles direct Pix choices, status questions, and unsupported promises', copilotContinuity.includes('isDirectPixChoice') && copilotContinuity.includes('isCopilotTaskStatusQuestion') && copilotContinuity.includes('claimsUnexecutedToolWork')],
  ['persistent Copilot worker is injected through flow and started/stopped with server lifecycle', copilotFlow.includes('copilotTaskStore = null') && copilotServer.includes('createCopilotTaskWorker') && copilotServer.includes('copilotTaskTimer') && copilotServer.includes('clearInterval(copilotTaskTimer)')],
];
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (checks.some(([, passed]) => !passed)) process.exit(1);
