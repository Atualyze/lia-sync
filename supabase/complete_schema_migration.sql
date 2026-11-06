-- ==============================================================================
-- LIA ASSISTENTE / CLUBINHO HOMEVET — ESQUEMA COMPLETO DE MIGRAÇÃO SUPABASE
-- ==============================================================================
-- Execute este script completo no painel do Supabase:
-- SQL Editor -> New Query -> Colar -> Run
-- Idempotente: pode ser executado múltiplas vezes sem quebrar o banco existente.
-- ==============================================================================

begin;

-- 1. Extensões necessárias
create extension if not exists pgcrypto;

-- 2. Função utilitária para atualização automática de updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 3. Função para verificar permissões de staff/operador no dashboard
create or replace function public.is_active_staff(required_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active = true
      and (required_roles is null or p.role = any(required_roles))
  );
$$;

grant execute on function public.is_active_staff(text[]) to authenticated;

-- ==============================================================================
-- TABELAS ADMINISTRATIVAS E DE CONTEÚDO (FAQ, PLANOS, CONFIG)
-- ==============================================================================

-- 4. Perfis de usuários do Dashboard
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'operator' check (role in ('admin', 'operator', 'viewer')),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_active_role_idx on public.profiles (active, role);

-- 5. Planos de Atendimento / Assinatura
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  pet_species text not null default 'cao e gatos' check (pet_species in ('cao', 'gato', 'cao e gatos')),
  age_range text,
  monthly_price_cents integer check (monthly_price_cents is null or monthly_price_cents >= 0),
  annual_price_cents integer check (annual_price_cents is null or annual_price_cents >= 0),
  active boolean not null default true,
  description text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_has_price check (monthly_price_cents is not null or annual_price_cents is not null)
);

create index if not exists plans_active_idx on public.plans (active);
create index if not exists plans_active_name_idx on public.plans (active, name);

-- 6. Configurações gerais / Legado AEO FAQ
create table if not exists public.workspace_settings (
  id boolean primary key default true check (id),
  aeo_faq jsonb not null default '[]'::jsonb check (jsonb_typeof(aeo_faq) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 7. FAQ Normalizada (Base de Conhecimento Dinâmica)
create table if not exists public.faq (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  question text not null,
  keys text[] not null default '{}',
  answer text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists faq_active_order_idx on public.faq (active, sort_order, created_at);

-- 8. Horários e Regiões de Atendimento
create table if not exists public.workspace_preferences (
  id boolean primary key default true check (id),
  service_regions text not null default 'todos os bairros de Teresina (PI) e a área urbana de Timon (MA)',
  working_start time not null default '08:00',
  working_end time not null default '18:00',
  timezone text not null default 'America/Fortaleza',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_hours_order check (working_end > working_start)
);

-- ==============================================================================
-- TABELAS OPERACIONAIS DO BOT (SESSÕES, MENSAGENS, CONTATOS, LEMBRETES)
-- ==============================================================================

-- 9. Contatos (Clientes do WhatsApp)
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'other')),
  external_id text not null,
  phone text,
  display_name text,
  push_name text,
  source text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_id)
);

create index if not exists contacts_phone_idx on public.contacts (phone);
create index if not exists contacts_last_seen_idx on public.contacts (last_seen_at desc);

-- 10. Pets Atendidos
create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  name text,
  species text,
  breed text,
  age_text text,
  sex text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pets_contact_idx on public.pets (contact_id);

-- 11. Conversas e Estado da Sessão
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  external_key text not null unique,
  origin text not null default 'real' check (origin in ('real', 'simulation')),
  status text not null default 'open' check (status in ('open', 'archived', 'closed')),
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  human_source text check (human_source in ('takeover', 'dashboard', 'resume', 'admin', 'auto-resume') or human_source is null),
  contact_name text,
  tutor_name text,
  preferred_time text,
  neighborhood text,
  pet_name text,
  pet_species text,
  pet_age text,
  last_intent text,
  intents text[] not null default '{}',
  symptom_turns integer not null default 0 check (symptom_turns >= 0),
  symptom_triage_until timestamptz,
  awaiting_reply boolean not null default false,
  inactivity_stage integer not null default 0 check (inactivity_stage >= 0 and inactivity_stage <= 3),
  inactivity_closed boolean not null default false,
  send_failed boolean not null default false,
  violations_count integer not null default 0 check (violations_count >= 0),
  fallback_handoff_at timestamptz,
  handoff_at timestamptz,
  handoff_reason text,
  handoff_urgency text check (handoff_urgency in ('normal', 'urgente', 'emergencia') or handoff_urgency is null),
  handoff_notified boolean not null default false,
  handoff_notify_failed boolean not null default false,
  handoff_reminder_at timestamptz,
  handoff_reminder1_sent boolean not null default false,
  handoff_reminder60_sent boolean not null default false,
  last_user_at timestamptz,
  last_bot_at timestamptz,
  archived_at timestamptz,
  archive_reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_contact_idx on public.conversations (contact_id);
create index if not exists conversations_status_updated_idx on public.conversations (status, updated_at desc);
create index if not exists conversations_handoff_idx on public.conversations (mode, handoff_reminder_at) where mode = 'human';

-- 12. Histórico de Mensagens
create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_id text,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'audio', 'video', 'document', 'location', 'sticker', 'other')),
  from_me boolean not null default false,
  delivery_status text not null default 'received' check (delivery_status in ('received', 'queued', 'sent', 'delivered', 'failed')),
  provider text,
  model text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (conversation_id, external_id)
);

create index if not exists conversation_messages_conversation_idx on public.conversation_messages (conversation_id, created_at);
create index if not exists conversation_messages_external_idx on public.conversation_messages (external_id) where external_id is not null;

-- 13. Transferências para Humano (Handoffs)
create table if not exists public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  urgency text not null default 'normal' check (urgency in ('normal', 'urgente', 'emergencia')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'cancelled')),
  assigned_to uuid references public.profiles(id) on delete set null,
  notified_at timestamptz,
  reminder_15_sent_at timestamptz,
  reminder_60_sent_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists handoffs_open_idx on public.handoffs (status, urgency, created_at desc) where status in ('open', 'acknowledged');
create index if not exists handoffs_conversation_idx on public.handoffs (conversation_id, created_at desc);

-- 14. Eventos e Auditoria de Conversas
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'system' check (actor_type in ('system', 'bot', 'human', 'dashboard', 'webhook')),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists conversation_events_conversation_idx on public.conversation_events (conversation_id, created_at desc);

-- 15. Lembretes e Agendamentos
create table if not exists public.reminders (
  id text primary key,
  text text not null,
  due_at timestamptz not null,
  phone text,
  client_name text,
  created_by text not null default 'contato',
  status text not null default 'pending' check (status in ('pending', 'sent', 'cancelled')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reminders_due_status_idx on public.reminders (status, due_at);

-- 16. Configuração Remota do Bot (Prompt, Parâmetros e Revisões)
create table if not exists public.bot_config_state (
  id boolean primary key default true check (id),
  revision integer not null default 0 check (revision >= 0),
  active_config jsonb not null default '{}'::jsonb check (jsonb_typeof(active_config) = 'object'),
  draft_config jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_config) = 'object'),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_config_revisions (
  id uuid primary key default gen_random_uuid(),
  revision integer not null,
  action text not null check (action in ('published', 'rollback', 'draft_updated')),
  actor uuid references public.profiles(id) on delete set null,
  source_revision integer,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (revision, action)
);

create index if not exists bot_config_revisions_created_idx on public.bot_config_revisions (created_at desc);

-- 17. Telemetria e Métricas de IA (Sem PII / Sem texto sensível de cliente)
create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  request_id text,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider text not null,
  model text,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  intent text,
  success boolean not null default true,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists ai_calls_created_idx on public.ai_calls (created_at desc);
create index if not exists ai_calls_provider_idx on public.ai_calls (provider, created_at desc);

-- 18. Log de Auditoria Geral
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

-- ==============================================================================
-- TRIGGERS DE ATUALIZAÇÃO AUTOMÁTICA
-- ==============================================================================
drop trigger if exists profiles_set_updated_at on public.profiles;
drop trigger if exists plans_set_updated_at on public.plans;
drop trigger if exists workspace_settings_set_updated_at on public.workspace_settings;
drop trigger if exists workspace_preferences_set_updated_at on public.workspace_preferences;
drop trigger if exists faq_set_updated_at on public.faq;
drop trigger if exists contacts_set_updated_at on public.contacts;
drop trigger if exists pets_set_updated_at on public.pets;
drop trigger if exists conversations_set_updated_at on public.conversations;
drop trigger if exists handoffs_set_updated_at on public.handoffs;
drop trigger if exists bot_config_state_set_updated_at on public.bot_config_state;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger plans_set_updated_at before update on public.plans for each row execute function public.set_updated_at();
create trigger workspace_settings_set_updated_at before update on public.workspace_settings for each row execute function public.set_updated_at();
create trigger workspace_preferences_set_updated_at before update on public.workspace_preferences for each row execute function public.set_updated_at();
create trigger faq_set_updated_at before update on public.faq for each row execute function public.set_updated_at();
create trigger contacts_set_updated_at before update on public.contacts for each row execute function public.set_updated_at();
create trigger pets_set_updated_at before update on public.pets for each row execute function public.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger handoffs_set_updated_at before update on public.handoffs for each row execute function public.set_updated_at();
create trigger bot_config_state_set_updated_at before update on public.bot_config_state for each row execute function public.set_updated_at();

-- ==============================================================================
-- POLÍTICAS DE SEGURANÇA (ROW LEVEL SECURITY - RLS)
-- ==============================================================================
alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.workspace_preferences enable row level security;
alter table public.faq enable row level security;
alter table public.contacts enable row level security;
alter table public.pets enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.handoffs enable row level security;
alter table public.conversation_events enable row level security;
alter table public.reminders enable row level security;
alter table public.bot_config_state enable row level security;
alter table public.bot_config_revisions enable row level security;
alter table public.ai_calls enable row level security;
alter table public.audit_log enable row level security;

-- Políticas de Leitura Pública / Autenticada
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated using ((select auth.uid()) = id);

drop policy if exists plans_select_active on public.plans;
create policy plans_select_active on public.plans for select to anon, authenticated using (active = true or (select auth.uid()) is not null);

drop policy if exists workspace_settings_select_public on public.workspace_settings;
create policy workspace_settings_select_public on public.workspace_settings for select to anon, authenticated using (true);

drop policy if exists workspace_preferences_select_public on public.workspace_preferences;
create policy workspace_preferences_select_public on public.workspace_preferences for select to anon, authenticated using (true);

drop policy if exists faq_select_public on public.faq;
create policy faq_select_public on public.faq for select to anon, authenticated using (active = true or (select auth.uid()) is not null);

-- Políticas Operacionais (Dashboard autenticado)
drop policy if exists contacts_staff_select on public.contacts;
create policy contacts_staff_select on public.contacts for select to authenticated using (public.is_active_staff(null));

drop policy if exists pets_staff_select on public.pets;
create policy pets_staff_select on public.pets for select to authenticated using (public.is_active_staff(null));

drop policy if exists conversations_staff_select on public.conversations;
create policy conversations_staff_select on public.conversations for select to authenticated using (public.is_active_staff(null));

drop policy if exists messages_staff_select on public.conversation_messages;
create policy messages_staff_select on public.conversation_messages for select to authenticated using (public.is_active_staff(null));

drop policy if exists handoffs_staff_select on public.handoffs;
create policy handoffs_staff_select on public.handoffs for select to authenticated using (public.is_active_staff(null));

drop policy if exists events_staff_select on public.conversation_events;
create policy events_staff_select on public.conversation_events for select to authenticated using (public.is_active_staff(null));

drop policy if exists reminders_staff_select on public.reminders;
create policy reminders_staff_select on public.reminders for select to authenticated using (public.is_active_staff(null));

drop policy if exists config_state_staff_select on public.bot_config_state;
create policy config_state_staff_select on public.bot_config_state for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists config_revisions_staff_select on public.bot_config_revisions;
create policy config_revisions_staff_select on public.bot_config_revisions for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists ai_calls_staff_select on public.ai_calls;
create policy ai_calls_staff_select on public.ai_calls for select to authenticated using (public.is_active_staff(array['admin', 'operator']));

drop policy if exists audit_log_admin_select on public.audit_log;
create policy audit_log_admin_select on public.audit_log for select to authenticated using (public.is_active_staff(array['admin']));

-- ==============================================================================
-- CARGA INICIAL DE DADOS (SEEDS ESSENCIAIS)
-- ==============================================================================

insert into public.workspace_settings (id, aeo_faq)
values (true, '[]'::jsonb)
on conflict (id) do nothing;

insert into public.workspace_preferences (id, service_regions, working_start, working_end, timezone)
values (true, 'todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA)', '08:00', '18:00', 'America/Fortaleza')
on conflict (id) do update set
  service_regions = excluded.service_regions,
  working_start = excluded.working_start,
  working_end = excluded.working_end,
  timezone = excluded.timezone;

insert into public.bot_config_state (id)
values (true)
on conflict (id) do nothing;

-- Planos Oficiais do Clubinho
insert into public.plans (
  slug, name, pet_species, age_range,
  monthly_price_cents, annual_price_cents,
  active, description, metadata
)
values
(
  'plano-filhote', 'Plano Filhote', 'cao e gatos', 'até 12 meses',
  10500, 105000, true,
  'Um começo de vida seguro e protegido desde os primeiros meses, com protocolo preventivo completo.',
  '{"benefits":["protocolo vacinal completo","acompanhamento preventivo em domicílio","check-ups preventivos","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 1.050 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x."}'::jsonb
),
(
  'plano-adulto', 'Plano Adulto', 'cao e gatos', '1 a 7 anos',
  7400, 74000, true,
  'Cuidado constante e preventivo para viver mais, melhor e longe de doenças silenciosas.',
  '{"benefits":["vacinação preventiva","consulta eletiva","check-up preventivo","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 740 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x."}'::jsonb
),
(
  'plano-idoso', 'Plano Idoso', 'cao e gatos', 'a partir de 8 anos',
  12000, 120000, true,
  'Mais atenção, carinho e monitoramento preventivo em cada novo capítulo da vida sênior.',
  '{"benefits":["acompanhamento preventivo individualizado","check-ups adaptados à avaliação da Dra. Elisângela","consultoria preventiva","guia de cuidados personalizados","descontos exclusivos"],"payment_note":"R$ 1.200 à vista no Pix, equivalente a 10 mensalidades; assinatura mensal em até 12x."}'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  pet_species = excluded.pet_species,
  age_range = excluded.age_range,
  monthly_price_cents = excluded.monthly_price_cents,
  annual_price_cents = excluded.annual_price_cents,
  active = excluded.active,
  description = excluded.description,
  metadata = excluded.metadata;

-- FAQ Oficial do Atendimento
insert into public.faq (slug, question, keys, answer, active, sort_order, metadata)
values
  ('o-que-e-o-clubinho', 'O que é o Clubinho HomeVet?', array['o que e o clubinho','sobre o clubinho','como funciona'], 'O Clubinho HomeVet é um programa de acompanhamento veterinário preventivo contínuo em domicílio para cães e gatos, com visitas programadas da Dra. Elisângela em Teresina e na área urbana de Timon.', true, 10, '{}'::jsonb),
  ('atendimento-domiciliar', 'O atendimento é domiciliar?', array['domicilio','em casa','atendimento domiciliar','veterinaria em casa'], 'Sim. A Dra. Elisângela vai até a sua casa, com hora marcada, sem transporte, filas ou sala de espera.', true, 20, '{}'::jsonb),
  ('regioes-atendidas', 'Quais regiões são atendidas?', array['onde atende','regiao','teresina','timon','bairros'], 'O Clubinho atende todos os bairros de Teresina (PI) e toda a área urbana de Timon (MA).', true, 30, '{}'::jsonb),
  ('horarios-atendimento', 'Quais são os horários?', array['horario','horarios','dias','sabado','fim de semana'], 'As visitas preventivas são realizadas de segunda a sexta, das 08h às 18h, e aos sábados, das 08h às 13h, sempre com horário agendado.', true, 40, '{}'::jsonb),
  ('primeira-visita', 'Quando posso agendar a primeira visita?', array['primeira visita','agendar','quando agendar','adesao'], 'Após a adesão, a equipe entra em contato pelo WhatsApp para conhecer o pet, conferir o histórico da carteirinha e marcar o melhor dia e horário.', true, 50, '{}'::jsonb),
  ('emergencia-24h', 'O Clubinho atende emergências 24h?', array['emergencia','urgencia','24 horas','pronto socorro'], 'Não. O Clubinho é um programa de prevenção domiciliar com horário marcado. Em uma emergência crítica, procure imediatamente um hospital veterinário ou pronto-socorro 24h.', true, 60, '{}'::jsonb),
  ('pet-doente-entre-visitas', 'E se meu pet ficar doente entre as visitas?', array['ficar doente','sintoma entre visitas','doente'], 'Você pode relatar a situação pelo WhatsApp da Dra. Elisângela. Ela orientará se é indicado atendimento domiciliar eletivo ou encaminhamento imediato, em caso de emergência crítica.', true, 70, '{}'::jsonb),
  ('formas-de-pagamento', 'Como funciona o pagamento?', array['pagamento','pagar','cartao','pix'], 'O site informa assinatura mensal no cartão em até 12x e opção de pagamento à vista via Pix com valor equivalente a 10 mensalidades. A equipe confirma as condições antes da adesão.', true, 80, '{}'::jsonb),
  ('limite-do-cartao', 'A assinatura compromete o limite total do cartão?', array['limite do cartao','limite','cobranca mensal'], 'Não. Na assinatura mensal, somente o valor da mensalidade vigente é utilizado do limite a cada mês, e não o valor anual total.', true, 90, '{}'::jsonb),
  ('cancelamento', 'Posso cancelar quando quiser?', array['cancelar','cancelamento','fidelidade'], 'Sim. O site informa que não há fidelidade forçada e que o cancelamento pode ser solicitado pelo WhatsApp, respeitando o período mensal já faturado e as condições da adesão.', true, 100, '{}'::jsonb),
  ('multiplos-pets', 'Posso cadastrar mais de um pet?', array['mais de um pet','multiplos pets','dois pets','varios pets'], 'Sim. Cada pet deve ter seu plano individual para acompanhamento personalizado. O site informa benefício especial para famílias com múltiplos pets.', true, 110, '{}'::jsonb),
  ('vacinas-em-dia', 'Já tenho as vacinas deste ano. Posso assinar?', array['ja vacinei','vacinas deste ano','vacina em dia'], 'Sim. O Clubinho vai além da vacinação e inclui check-ups, orientações e acompanhamento preventivo contínuo.', true, 120, '{}'::jsonb),
  ('beneficios-dos-planos', 'O que o plano preventivo oferece?', array['beneficios','inclui','vacinas','check up','parasitas'], 'Os planos envolvem vacinação preventiva, consultas eletivas, check-ups, consultoria preventiva, orientação de cuidados e benefícios conforme a fase de vida e a avaliação do pet.', true, 130, '{}'::jsonb)
on conflict (slug) do update set
  question = excluded.question,
  keys = excluded.keys,
  answer = excluded.answer,
  active = excluded.active,
  sort_order = excluded.sort_order,
  metadata = excluded.metadata;

commit;
