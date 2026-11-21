import { readFile } from 'node:fs/promises';

const readNormalized = async (file) => (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');

const legacyMigration = await readNormalized('supabase/migrations/20261112220000_phone_suppressions.sql');
const observabilityMigration = await readNormalized('supabase/migrations/20261113000000_operations_observability.sql');
const campaigns = await readNormalized('src/campaigns.mjs');
const dashboardRoutes = await readNormalized('src/http/dashboard.mjs');
const operationsRoutes = await readNormalized('src/http/operations.mjs');
const operations = await readNormalized('src/operations.mjs');
const router = await readNormalized('src/http/router.mjs');
const webhook = await readNormalized('src/http/webhook.mjs');
const webhookEvents = await readNormalized('src/webhook-events.mjs');
const whatsapp = await readNormalized('src/whatsapp.mjs');
const index = await readNormalized('public/index.html');
const app = await readNormalized('public/app.js');
const supabaseClient = await readNormalized('public/vendor/supabase.js');
const bridgeRoutes = await readNormalized('src/http/bridge-routes.mjs');
const bridgeStatus = await readNormalized('src/http/bridge-config-status.mjs');
const adminConfigSchema = await readNormalized('src/admin-config.mjs');
const sectorsProjection = await readNormalized('src/sectors.mjs');
const clientFlow = await readNormalized('src/flow/client.mjs');
const copilotTasks = await readNormalized('src/copilot-tasks.mjs');
const copilotWorker = await readNormalized('src/copilot-task-worker.mjs');
const copilotTaskMigration = await readNormalized('supabase/migrations/20261120150000_copilot_task_queue.sql');
const copilotTaskSchema = await readNormalized('supabase/complete_schema_migration.sql');
const copilotOwnerFlow = await readNormalized('src/flow/owner.mjs');
const copilotContinuity = await readNormalized('src/flow/copilot-continuity.mjs');
const copilotServer = await readNormalized('src/server.mjs');
const copilotFlow = await readNormalized('src/flow.mjs');
const supabaseRuntime = await readNormalized('src/supabase-runtime.mjs');
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
  ['Copilot task queue persists idempotent jobs and fails closed on corrupt local state', copilotTasks.includes('createCopilotTaskKey') && copilotTasks.includes('getById') && copilotTasks.includes('localCorrupt') && copilotTasks.includes("this.mode === 'unavailable'") && copilotTasks.includes('claimPendingNotification') && copilotTasks.includes('get available()') && copilotTasks.includes('result_summary: {}')],
  ['Copilot worker revalidates plans and stops on unverified results', copilotWorker.includes('buildCopilotToolPlan') && copilotWorker.includes('verifyCopilotToolResult') && copilotWorker.includes('pix_task_must_be_single_step')],
  ['Copilot queue migration is backend-only and claims jobs atomically with valid PostgreSQL clause order', copilotTaskMigration.includes('enable row level security') && !copilotTaskMigration.includes('create policy') && copilotTaskMigration.includes('for update skip locked') && copilotTaskMigration.includes('limit 1\n  for update skip locked') && copilotTaskMigration.includes('copilot_tasks_pix_never_retries') && copilotTaskMigration.includes('copilot_tasks_pix_single_step')],
  ['complete Supabase schema includes the current Copilot queue migration', copilotTaskSchema.includes('-- ======== 20261120150000_copilot_task_queue.sql ========') && copilotTaskSchema.includes('copilot_tasks_pix_single_step')],
  ['owner flow queues eligible tasks, reads active task status, and blocks unsupported execution promises', copilotOwnerFlow.includes('enqueueBackgroundTask') && copilotOwnerFlow.includes('getById(activeTaskId') && copilotOwnerFlow.includes('claimsUnexecutedToolWork(rawReply)') && copilotOwnerFlow.includes('COPILOT_TASK_CONTEXT_TTL_MS')],
  ['Copilot continuity handles direct Pix choices, status questions, and unsupported promises', copilotContinuity.includes('isDirectPixChoice') && copilotContinuity.includes('isCopilotTaskStatusQuestion') && copilotContinuity.includes('claimsUnexecutedToolWork')],
  ['persistent Copilot worker is injected through flow and started/stopped with server lifecycle', copilotFlow.includes('copilotTaskStore = null') && copilotServer.includes('createCopilotTaskWorker') && copilotServer.includes('taskQueueReadinessCheck') && copilotServer.includes('name: \'copilot_tasks\'') && copilotServer.includes('copilotTaskTimer') && copilotServer.includes('clearInterval(copilotTaskTimer)') && copilotServer.includes('COPILOT_TASK_LOCAL_FALLBACK')],
  ['Supabase conversation metadata preserves the active durable task identity across restarts', supabaseRuntime.includes('taskId: value.taskId') && supabaseRuntime.includes('taskStatus: value.taskStatus')],
];
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (checks.some(([, passed]) => !passed)) process.exit(1);
