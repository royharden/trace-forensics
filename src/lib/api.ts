import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { RunRecord, StepRecord, ScanBatchRecord, IncidentRecord, SeverityPolicy } from "./types";
import type { StepAnswers } from "./assess";
import type { AssessResult } from "./types";
import { assess } from "./assess";
import { getSampleTrace } from "./sampleTraces";

interface FunctionErrorBody {
  error?: string;
  message?: string;
  mode?: string;
}

class FunctionCallError extends Error {
  constructor(msg: string, readonly body: FunctionErrorBody | null) {
    super(msg);
    this.name = "FunctionCallError";
  }
}

// Invokes an Edge Function. Non-2xx responses throw with the server's error message.
async function invokeFunction<T>(name: string, body: string | Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let errBody: FunctionErrorBody | null = null;
    if (error instanceof FunctionsHttpError) {
      try {
        errBody = await error.context.json();
      } catch { /* not JSON */ }
    }
    throw new FunctionCallError(errBody?.message || errBody?.error || error.message, errBody);
  }
  if (!data || typeof data !== "object") throw new Error(`${name} returned no data`);
  if (data.error) throw new FunctionCallError(data.message || data.error, data);
  return data as T;
}

// ============================================================
// Ingest
// ============================================================
export async function ingestTrace(rawJson: string): Promise<{ run_id: string; step_count: number; source_format: string }> {
  // Raw text body: the trace may be JSON or JSONL.
  return invokeFunction("ingest", rawJson);
}

// ============================================================
// Jev scan
// ============================================================
export interface ScanResult {
  run_id: string;
  scanned: number;
  remaining?: number;
  partial?: boolean;
  batches: number;
  total_cost_usd: number;
  total_latency_ms: number;
  results: Array<{
    stepIds: number[];
    batchId: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    costUsd: number;
    answers: Record<string, Record<string, unknown>>;
  }>;
}

export async function scanRun(runId: string): Promise<ScanResult> {
  try {
    return await invokeFunction<ScanResult>("jev-scan", { run_id: runId });
  } catch (e) {
    if (e instanceof FunctionCallError && e.body?.mode === "replay") {
      throw new ReplayModeError(e.message || "Daily limit reached");
    }
    throw e;
  }
}

export class ReplayModeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ReplayModeError";
  }
}

// ============================================================
// LLM report
// ============================================================
export async function generateReport(runId: string): Promise<{ report: string; mock: boolean }> {
  const data = await invokeFunction<{ report: string; mock?: boolean }>("llm", {
    action: "incident_report",
    run_id: runId,
  });
  return { report: data.report, mock: data.mock || false };
}

// ============================================================
// Data fetching
// ============================================================
export async function fetchRuns(): Promise<RunRecord[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data || []) as RunRecord[]).filter((r) => !hiddenRunIds.has(r.id));
}

export async function fetchSteps(runId: string): Promise<StepRecord[]> {
  const { data, error } = await supabase
    .from("steps")
    .select("*")
    .eq("run_id", runId)
    .order("idx", { ascending: true });
  if (error) throw error;
  return (data || []) as StepRecord[];
}

export async function fetchScanBatches(runId: string): Promise<ScanBatchRecord[]> {
  const { data, error } = await supabase
    .from("scan_batches")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []) as ScanBatchRecord[];
}

export async function fetchIncidents(runId: string): Promise<IncidentRecord[]> {
  const { data, error } = await supabase
    .from("incidents")
    .select("*")
    .eq("run_id", runId)
    .order("start_idx", { ascending: true });
  if (error) throw error;
  return (data || []) as IncidentRecord[];
}

// ============================================================
// Writes (browser has read-only table access; these go through the llm function)
// ============================================================
// Keeps each save request well under the function's 64 KB body limit.
const SAVE_STEP_CHUNK = 100;

export async function saveAssessment(runId: string, result: AssessResult): Promise<void> {
  for (let i = 0; i < result.stepResults.length; i += SAVE_STEP_CHUNK) {
    const chunk = result.stepResults.slice(i, i + SAVE_STEP_CHUNK);
    await invokeFunction("llm", {
      action: "save_step_severities",
      run_id: runId,
      steps: chunk.map((sr) => ({ idx: sr.idx, severity: sr.severity, fired_rules: sr.firedRules })),
    });
  }
  await invokeFunction("llm", {
    action: "save_run_assessment",
    run_id: runId,
    risk_score: result.riskScore,
    incidents: result.incidents.map((inc) => ({
      start_idx: inc.startIdx,
      end_idx: inc.endIdx,
      severity: inc.severity,
      label: inc.label,
    })),
  });
}

// Deleting removes the run from this browser's view only; the shared demo data is kept.
const HIDDEN_RUNS_STORAGE_KEY = "trace-forensics-hidden-runs";
const MAX_HIDDEN_RUNS = 1000;

function loadHiddenRunIds(): string[] {
  try {
    const stored = localStorage.getItem(HIDDEN_RUNS_STORAGE_KEY);
    const ids = stored ? JSON.parse(stored) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const hiddenRunIds = new Set<string>(loadHiddenRunIds());

export function hideRun(runId: string): void {
  hiddenRunIds.add(runId);
  try {
    localStorage.setItem(HIDDEN_RUNS_STORAGE_KEY, JSON.stringify([...hiddenRunIds].slice(-MAX_HIDDEN_RUNS)));
  } catch { /* storage unavailable: hidden until reload */ }
}

// ============================================================
// Parse Jev responses into StepAnswers
// ============================================================
export function parseJevResponses(
  batches: ScanBatchRecord[],
): Map<number, StepAnswers> {
  const result = new Map<number, StepAnswers>();

  for (const batch of batches) {
    const resp = batch.jev_response as Record<string, Record<string, unknown>>;
    if (!resp) continue;
    const stepIds = batch.step_ids || [];

    for (const stepIdx of stepIds) {
      const prefix = `s${stepIdx}`;
      const destructive = resp[`${prefix}__destructive`];
      const coversTracks = resp[`${prefix}__covers_tracks`];
      const selfModify = resp[`${prefix}__self_modify`];
      const inScope = resp[`${prefix}__in_scope`];
      const injected = resp[`${prefix}__injected`];
      const category = resp[`${prefix}__category`];

      result.set(stepIdx, {
        destructive: typeof destructive?.noul === "number" ? destructive.noul : 0,
        covers_tracks: typeof coversTracks?.noul === "number" ? coversTracks.noul : 0,
        self_modify: typeof selfModify?.noul === "number" ? selfModify.noul : 0,
        in_scope: typeof inScope?.noul === "number" ? inScope.noul : 1,
        injected: typeof injected?.noul === "number" ? injected.noul : 0,
        category: typeof category?.choice === "string" ? category.choice : "uncertain",
        category_confidence: typeof category?.confidence === "number" ? category.confidence : 0,
      });
    }
  }

  return result;
}

// ============================================================
// Replay mode: compute assessment from pre-scanned sample data
// ============================================================
export function replayAssess(
  sampleId: string,
  policy: SeverityPolicy,
): AssessResult | null {
  const sample = getSampleTrace(sampleId);
  if (!sample) return null;
  const stepIndices = sample.trace.steps.map((s) => s.idx);
  return assess(sample.replayAnswers, stepIndices, policy);
}
