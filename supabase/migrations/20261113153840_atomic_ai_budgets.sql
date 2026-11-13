CREATE TABLE IF NOT EXISTS public.ai_budget_reservations (
  request_id uuid PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  reserved_usd numeric(20, 9) NOT NULL CHECK (reserved_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled boolean NOT NULL DEFAULT false,
  lease_expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_budget_reservations_created_idx
  ON public.ai_budget_reservations (created_at DESC);

CREATE INDEX IF NOT EXISTS ai_calls_request_id_idx
  ON public.ai_calls (request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.ai_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_budget_reservations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_ai_budget(
  p_request_id uuid,
  p_provider text,
  p_model text,
  p_reserved_usd numeric,
  p_month_start timestamptz,
  p_budgets jsonb,
  p_rates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_budget jsonb;
  v_rate jsonb;
  v_call record;
  v_budget_provider text;
  v_budget_model text;
  v_limit numeric;
  v_input_rate numeric;
  v_output_rate numeric;
  v_usage numeric;
  v_reserved numeric;
  v_request_applies boolean;
BEGIN
  IF p_request_id IS NULL
     OR p_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')
     OR p_model IS NULL OR btrim(p_model) = ''
     OR p_reserved_usd IS NULL OR p_reserved_usd < 0
     OR p_month_start IS NULL
     OR jsonb_typeof(p_budgets) <> 'array'
     OR jsonb_typeof(p_rates) <> 'array' THEN
    RETURN false;
  END IF;

  -- Serialize all admissions within a UTC calendar month across app instances.
  PERFORM pg_advisory_xact_lock(hashtext('lia_ai_budget:' || to_char(p_month_start AT TIME ZONE 'UTC', 'YYYY-MM'))::bigint);

  -- Once the matching call is durably present in ai_calls, it is the source of truth;
  -- remove the duplicate reservation row. Expired, un-settled leases represent work
  -- that died before it could be accounted for and can no longer consume this month.
  DELETE FROM public.ai_budget_reservations r
  WHERE EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text)
     OR (r.settled = false AND r.lease_expires_at < now());

  FOR v_budget IN SELECT value FROM jsonb_array_elements(p_budgets) AS items(value) LOOP
    BEGIN
      v_budget_provider := coalesce(v_budget->>'provider', '');
      v_budget_model := coalesce(v_budget->>'model', '');
      v_limit := (v_budget->>'amountUsd')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;

    IF v_limit IS NULL OR v_limit <= 0 THEN RETURN false; END IF;
    IF (v_budget_provider <> '' AND v_budget_provider NOT IN ('gemini', 'openrouter', 'qwen', 'openai')) THEN RETURN false; END IF;

    v_request_applies := (v_budget_provider = '' OR v_budget_provider = p_provider)
      AND (v_budget_model = '' OR v_budget_model = p_model);
    IF NOT v_request_applies THEN CONTINUE; END IF;

    v_usage := 0;
    FOR v_call IN
      SELECT c.provider, c.model, c.prompt_tokens, c.completion_tokens, c.success
      FROM public.ai_calls c
      WHERE c.created_at >= p_month_start
        AND (v_budget_provider = '' OR c.provider = v_budget_provider)
        AND (v_budget_model = '' OR c.model = v_budget_model)
    LOOP
      IF v_call.success IS DISTINCT FROM true OR v_call.model IS NULL THEN RETURN false; END IF;
      v_input_rate := NULL;
      v_output_rate := NULL;
      FOR v_rate IN SELECT value FROM jsonb_array_elements(p_rates) AS rates(value) LOOP
        IF v_rate->>'provider' = v_call.provider AND v_rate->>'model' = v_call.model THEN
          BEGIN
            v_input_rate := (v_rate->>'inputUsdPerMillion')::numeric;
            v_output_rate := (v_rate->>'outputUsdPerMillion')::numeric;
          EXCEPTION WHEN OTHERS THEN
            RETURN false;
          END;
          EXIT;
        END IF;
      END LOOP;
      IF v_input_rate IS NULL OR v_output_rate IS NULL OR v_input_rate < 0 OR v_output_rate < 0 THEN RETURN false; END IF;
      v_usage := v_usage + ((v_call.prompt_tokens * v_input_rate) + (v_call.completion_tokens * v_output_rate)) / 1000000;
    END LOOP;

    SELECT coalesce(sum(r.reserved_usd), 0) INTO v_reserved
    FROM public.ai_budget_reservations r
    WHERE r.created_at >= p_month_start
      AND (r.settled = true OR r.lease_expires_at > now())
      AND (v_budget_provider = '' OR r.provider = v_budget_provider)
      AND (v_budget_model = '' OR r.model = v_budget_model)
      AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = r.request_id::text);

    IF v_usage + v_reserved + p_reserved_usd > v_limit THEN RETURN false; END IF;
  END LOOP;

  INSERT INTO public.ai_budget_reservations (request_id, provider, model, reserved_usd, created_at, settled, lease_expires_at)
  VALUES (p_request_id, p_provider, p_model, p_reserved_usd, now(), false, now() + interval '5 minutes')
  ON CONFLICT (request_id) DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_ai_budget(
  p_request_id uuid,
  p_actual_usd numeric
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_request_id IS NULL OR p_actual_usd IS NULL OR p_actual_usd < 0 THEN RETURN false; END IF;
  UPDATE public.ai_budget_reservations
  SET reserved_usd = greatest(reserved_usd, p_actual_usd),
      settled = true,
      lease_expires_at = NULL
  WHERE request_id = p_request_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_ai_budget(
  p_request_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_request_id IS NULL THEN RETURN false; END IF;
  DELETE FROM public.ai_budget_reservations
  WHERE request_id = p_request_id AND settled = false
    AND NOT EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.request_id = p_request_id::text);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_ai_budget(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_budget(uuid, text, text, numeric, timestamptz, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_ai_budget(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_budget(uuid) TO service_role;
