/*
# Trace Forensics: security hardening

## Overview
Locks down the daily usage counter, adds a capped atomic increment, and makes
the demo data tables read-only for browser clients. All writes now go through
Edge Functions using the service-role client.

## usage_counters
- RLS stays enabled; any policies on the table are dropped.
- REVOKE ALL from anon and authenticated (and PUBLIC).

## increment_usage_by(p_fn text, p_units int, p_cap int DEFAULT 200)
SECURITY DEFINER, SET search_path = public. In a single
INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING statement it adds
p_units to today's (UTC) counter for p_fn only if the new total stays
<= p_cap, and returns the new total. Returns -1 (and changes nothing) when the
increment would exceed the cap. EXECUTE is revoked from PUBLIC, anon and
authenticated and granted to service_role only.

The older increment_usage_counter(p_fn) (uncapped) gets the same revokes. It is
no longer called by any Edge Function.

## runs, steps, scan_batches, incidents
- Drop the anon_insert_*, anon_update_* and anon_delete_* policies.
- REVOKE INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER from anon and
  authenticated. anon and authenticated keep SELECT (anon_select_* policies).
*/

-- ============================================================
-- usage_counters: no client access at all
-- ============================================================
ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usage_counters'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.usage_counters', pol.policyname);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.usage_counters FROM PUBLIC, anon, authenticated;

-- ============================================================
-- increment_usage_by: capped, atomic, service_role only
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_usage_by(
  p_fn text,
  p_units int,
  p_cap int DEFAULT 200
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  IF p_fn IS NULL OR length(p_fn) = 0 OR length(p_fn) > 64 THEN
    RAISE EXCEPTION 'increment_usage_by: invalid p_fn';
  END IF;
  IF p_units IS NULL OR p_units < 1 THEN
    RAISE EXCEPTION 'increment_usage_by: p_units must be >= 1';
  END IF;
  IF p_cap IS NULL OR p_cap < 0 THEN
    RAISE EXCEPTION 'increment_usage_by: p_cap must be >= 0';
  END IF;

  INSERT INTO public.usage_counters AS uc (day, fn, calls)
  SELECT (now() AT TIME ZONE 'utc')::date, p_fn, p_units
  WHERE p_units <= p_cap
  ON CONFLICT (day, fn) DO UPDATE
    SET calls = uc.calls + EXCLUDED.calls
    WHERE uc.calls::bigint + EXCLUDED.calls <= p_cap
  RETURNING uc.calls INTO v_count;

  -- No row inserted or updated means the cap would be exceeded.
  RETURN COALESCE(v_count, -1);
END;
$$;

REVOKE ALL ON FUNCTION public.increment_usage_by(text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_usage_by(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage_by(text, int, int) TO service_role;

-- Legacy uncapped counter: same lockdown.
REVOKE ALL ON FUNCTION public.increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage_counter(text) TO service_role;

-- ============================================================
-- Demo data tables: read-only for anon/authenticated
-- ============================================================
DROP POLICY IF EXISTS "anon_insert_runs" ON public.runs;
DROP POLICY IF EXISTS "anon_update_runs" ON public.runs;
DROP POLICY IF EXISTS "anon_delete_runs" ON public.runs;

DROP POLICY IF EXISTS "anon_insert_steps" ON public.steps;
DROP POLICY IF EXISTS "anon_update_steps" ON public.steps;
DROP POLICY IF EXISTS "anon_delete_steps" ON public.steps;

DROP POLICY IF EXISTS "anon_insert_scan_batches" ON public.scan_batches;
DROP POLICY IF EXISTS "anon_update_scan_batches" ON public.scan_batches;
DROP POLICY IF EXISTS "anon_delete_scan_batches" ON public.scan_batches;

DROP POLICY IF EXISTS "anon_insert_incidents" ON public.incidents;
DROP POLICY IF EXISTS "anon_update_incidents" ON public.incidents;
DROP POLICY IF EXISTS "anon_delete_incidents" ON public.incidents;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.runs, public.steps, public.scan_batches, public.incidents
  FROM anon, authenticated;

GRANT SELECT
  ON TABLE public.runs, public.steps, public.scan_batches, public.incidents
  TO anon, authenticated;
