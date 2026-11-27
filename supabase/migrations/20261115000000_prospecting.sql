-- Prospecção autônoma (Fase 1): listas, leads, cadências e eventos.
-- Reutiliza phone_suppressions como fonte única de opt-out.

CREATE TABLE IF NOT EXISTS prospect_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'csv',
  segment TEXT NOT NULL DEFAULT '',
  consent_basis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paused', -- paused | active | stopped | completed
  daily_cap INTEGER NOT NULL DEFAULT 20,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  warmup_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospect_cadences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prospect_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES prospect_lists(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new', -- new | queued | contacted | replied | handoff | opted_out | stopped | failed | exhausted
  stage INTEGER NOT NULL DEFAULT 0,
  next_action_at TIMESTAMPTZ,
  last_contacted_at TIMESTAMPTZ,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_prospect_leads_due
  ON prospect_leads (status, next_action_at)
  WHERE status IN ('new', 'queued', 'failed', 'contacted');

CREATE INDEX IF NOT EXISTS idx_prospect_leads_phone
  ON prospect_leads (phone);

CREATE TABLE IF NOT EXISTS prospect_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID REFERENCES prospect_lists(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES prospect_leads(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL, -- queued | sent | failed | replied | optout | handoff | stopped
  stage INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospect_events_list_created
  ON prospect_events (list_id, created_at DESC);

-- Estas tabelas contêm dados pessoais de leads. O dashboard usa apenas o
-- service_role no backend; a chave publicável nunca deve acessar o REST delas.
ALTER TABLE prospect_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_cadences ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE prospect_lists, prospect_cadences, prospect_leads, prospect_events FROM anon, authenticated;
GRANT ALL ON TABLE prospect_lists, prospect_cadences, prospect_leads, prospect_events TO service_role;
