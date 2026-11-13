ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS follow_up_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_claim_token uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_follow_up_count_nonnegative'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_follow_up_count_nonnegative CHECK (follow_up_count >= 0);
  END IF;
END;
$$;

-- Preserve follow-up history written by older runtimes in metadata.
UPDATE public.conversations
SET follow_up_count = CASE
      WHEN metadata->>'followUpCount' ~ '^[0-9]+$' THEN (metadata->>'followUpCount')::integer
      ELSE 0
    END,
    follow_up_sent_at = CASE
      WHEN metadata->>'followUpSentAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (metadata->>'followUpSentAt')::timestamptz
      ELSE NULL
    END,
    follow_up_claimed_at = CASE
      WHEN metadata->>'followUpClaimedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (metadata->>'followUpClaimedAt')::timestamptz
      ELSE NULL
    END
WHERE metadata ?| ARRAY['followUpCount', 'followUpSentAt', 'followUpClaimedAt'];

CREATE OR REPLACE FUNCTION public.claim_follow_up(
  p_external_key text,
  p_claimed_at timestamptz,
  p_lease_seconds integer DEFAULT 900
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token uuid;
  v_lease_seconds integer := GREATEST(60, LEAST(COALESCE(p_lease_seconds, 900), 3600));
BEGIN
  UPDATE public.conversations
  SET follow_up_count = 1,
      follow_up_claimed_at = p_claimed_at,
      follow_up_claim_token = gen_random_uuid(),
      updated_at = now()
  WHERE external_key = p_external_key
    AND status = 'open'
    AND mode = 'bot'
    AND follow_up_sent_at IS NULL
    AND (
      (follow_up_count = 0 AND follow_up_claim_token IS NULL)
      OR (follow_up_count = 1 AND follow_up_claimed_at < p_claimed_at - make_interval(secs => v_lease_seconds))
    )
  RETURNING follow_up_claim_token INTO v_token;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_follow_up(
  p_external_key text,
  p_claim_token uuid,
  p_sent_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.conversations
  SET follow_up_sent_at = p_sent_at,
      follow_up_count = 1,
      follow_up_claimed_at = NULL,
      follow_up_claim_token = NULL,
      updated_at = now()
  WHERE external_key = p_external_key
    AND follow_up_claim_token = p_claim_token
    AND follow_up_sent_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_follow_up_claim(
  p_external_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.conversations
  SET follow_up_count = 0,
      follow_up_claimed_at = NULL,
      follow_up_claim_token = NULL,
      updated_at = now()
  WHERE external_key = p_external_key
    AND follow_up_claim_token = p_claim_token
    AND follow_up_sent_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_follow_up(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_follow_up(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_follow_up_claim(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_follow_up(text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_follow_up(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_follow_up_claim(text, uuid) TO service_role;
