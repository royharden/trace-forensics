/*
# Trace Forensics: Create core schema

## Overview
Creates the full schema for the Trace Forensics demo app — a tool for auditing
what AI agents actually did during their runs. Users upload agent run traces
and get an interactive timeline with risk analysis powered by the Jev scanner.

## New Tables

1. **runs** — stores uploaded/ingested agent run traces
   - `id` uuid PK
   - `agent_name` text — name of the agent
   - `user_goal` text — what the user asked the agent to do
   - `source_format` text — which importer was used (native|openai|jsonl)
   - `step_count` int — number of steps in the run
   - `risk_score` int — 0-100 weighted severity score
   - `created_at` timestamptz

2. **steps** — individual steps within a run
   - `id` uuid PK
   - `run_id` uuid FK → runs(id) ON DELETE CASCADE
   - `idx` int — step index within the run
   - `ts` timestamptz — timestamp of the step
   - `type` text — thought|tool_call|tool_result|message
   - `tool` text — tool name (nullable)
   - `args` jsonb — tool arguments (nullable)
   - `content` text — thought/message/result content (nullable)
   - `actor` text — who produced the step (nullable)
   - `severity` text — computed severity level (nullable, set after scan)
   - `fired_rules` jsonb — which severity rules fired (nullable)
   - `batch_id` uuid — links to the scan batch that analyzed this step (nullable)

3. **scan_batches** — records of each Jev API call
   - `id` uuid PK
   - `run_id` uuid FK → runs(id) ON DELETE CASCADE
   - `step_ids` jsonb — array of step indices in this batch
   - `jev_request` jsonb — the request body sent to Jev
   - `jev_response` jsonb — the response received
   - `model` text — the model string Jev reported
   - `latency_ms` int — round-trip latency
   - `input_tokens` int — token count for cost calc
   - `cost_usd` numeric(12,6) — computed cost
   - `created_at` timestamptz

4. **incidents** — grouped consecutive flagged steps
   - `id` uuid PK
   - `run_id` uuid FK → runs(id) ON DELETE CASCADE
   - `start_idx` int — first step index in the incident
   - `end_idx` int — last step index
   - `severity` text — highest severity in the group
   - `label` text — top signal label
   - `report` text — LLM-generated incident report (nullable)

5. **usage_counters** — daily abuse-limit tracking per function
   - `day` date — the calendar day
   - `fn` text — function name (jev-scan|llm)
   - `calls` int — call count
   - PK(day, fn)

## Security

### Demo tables (runs, steps, scan_batches, incidents)
RLS enabled with permissive `anon, authenticated` CRUD policies — this is a
single-tenant public demo workspace with no auth.

### usage_counters (locked down)
RLS enabled with NO policies — anon and authenticated cannot SELECT, INSERT,
UPDATE, or DELETE. Only the `increment_usage_counter` SECURITY DEFINER function
can modify it, and that function is revoked from PUBLIC/anon/authenticated and
granted only to `service_role`. Edge Functions call it with the service-role
client.

## Functions

### increment_usage_counter(p_fn text)
SECURITY DEFINER, atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING calls.
Used by edge functions to check/increment daily call limits. Revoked from
PUBLIC/anon/authenticated; granted to service_role only.
*/

-- ============================================================
-- runs
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL,
  user_goal text NOT NULL,
  source_format text NOT NULL DEFAULT 'native',
  step_count int NOT NULL DEFAULT 0,
  risk_score int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_runs" ON runs;
CREATE POLICY "anon_select_runs" ON runs FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_runs" ON runs;
CREATE POLICY "anon_insert_runs" ON runs FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_runs" ON runs;
CREATE POLICY "anon_update_runs" ON runs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_runs" ON runs;
CREATE POLICY "anon_delete_runs" ON runs FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- steps
-- ============================================================
CREATE TABLE IF NOT EXISTS steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx int NOT NULL,
  ts timestamptz,
  type text NOT NULL,
  tool text,
  args jsonb,
  content text,
  actor text,
  severity text,
  fired_rules jsonb,
  batch_id uuid
);

CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_run_idx ON steps(run_id, idx);

ALTER TABLE steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_steps" ON steps;
CREATE POLICY "anon_select_steps" ON steps FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_steps" ON steps;
CREATE POLICY "anon_insert_steps" ON steps FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_steps" ON steps;
CREATE POLICY "anon_update_steps" ON steps FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_steps" ON steps;
CREATE POLICY "anon_delete_steps" ON steps FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- scan_batches
-- ============================================================
CREATE TABLE IF NOT EXISTS scan_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  jev_request jsonb,
  jev_response jsonb,
  model text,
  latency_ms int,
  input_tokens int,
  cost_usd numeric(12,6),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_batches_run_id ON scan_batches(run_id);

ALTER TABLE scan_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_scan_batches" ON scan_batches;
CREATE POLICY "anon_select_scan_batches" ON scan_batches FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_scan_batches" ON scan_batches;
CREATE POLICY "anon_insert_scan_batches" ON scan_batches FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_scan_batches" ON scan_batches;
CREATE POLICY "anon_update_scan_batches" ON scan_batches FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_scan_batches" ON scan_batches;
CREATE POLICY "anon_delete_scan_batches" ON scan_batches FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- incidents
-- ============================================================
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  start_idx int NOT NULL,
  end_idx int NOT NULL,
  severity text NOT NULL,
  label text NOT NULL,
  report text
);

CREATE INDEX IF NOT EXISTS idx_incidents_run_id ON incidents(run_id);

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_incidents" ON incidents;
CREATE POLICY "anon_select_incidents" ON incidents FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_incidents" ON incidents;
CREATE POLICY "anon_insert_incidents" ON incidents FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_incidents" ON incidents;
CREATE POLICY "anon_update_incidents" ON incidents FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_incidents" ON incidents;
CREATE POLICY "anon_delete_incidents" ON incidents FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- usage_counters — locked down, no anon/auth policies
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_counters (
  day date NOT NULL,
  fn text NOT NULL,
  calls int NOT NULL DEFAULT 1,
  PRIMARY KEY (day, fn)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: anon and authenticated get nothing.

-- ============================================================
-- increment_usage_counter — SECURITY DEFINER, service_role only
-- ============================================================
CREATE OR REPLACE FUNCTION increment_usage_counter(p_fn text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO usage_counters (day, fn, calls)
  VALUES (CURRENT_DATE, p_fn, 1)
  ON CONFLICT (day, fn)
  DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage_counter(text) TO service_role;