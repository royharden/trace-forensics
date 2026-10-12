import { supabase } from "./supabase";
import type { RunRecord, StepRecord, ScanBatchRecord, IncidentRecord, SeverityPolicy } from "./types";
import type { StepAnswers } from "./assess";
import type { AssessResult } from "./types";
import { assess } from "./assess";
import { getSampleTrace } from "./sampleTraces";

// ============================================================
// Ingest
// ============================================================
export async function ingestTrace(rawJson: string): Promise<{ run_id: string; step_count: number; source_format: string }> {
  const { data, error } = await supabase.functions.invoke("ingest", {
    body: rawJson,
    headers: { "Content-Type": "application/json" },
  });

  if (error) throw error;
  if (!data || data.error) throw new Error(data?.error || "Ingest failed");
  return data;
}

// ============================================================
// Jev scan
// ============================================================
export interface ScanResult {
  run_id: string;
  scanned: number;
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
  const { data, error } = await supabase.functions.invoke("jev-scan", {
    body: JSON.stringify({ run_id: runId }),
  });

  if (error) throw error;
  if (!data || data.error) {
    if (data?.mode === "replay") {
      throw new ReplayModeError(data.error || "Daily limit reached");
    }
    throw new Error(data?.error || "Scan failed");
  }
  return data;
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
  const { data, error } = await supabase.functions.invoke("llm", {
    body: JSON.stringify({ action: "incident_report", run_id: runId }),
  });

  if (error) throw error;
  if (!data || data.error) throw new Error(data?.error || "Report generation failed");
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
  return (data || []) as RunRecord[];
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

export async function updateStepSeverity(runId: string, idx: number, severity: string, firedRules: string[]): Promise<void> {
  const { error } = await supabase
    .from("steps")
    .update({ severity, fired_rules: firedRules })
    .eq("run_id", runId)
    .eq("idx", idx);
  if (error) throw error;
}

export async function updateRunRiskScore(runId: string, score: number): Promise<void> {
  const { error } = await supabase
    .from("runs")
    .update({ risk_score: score })
    .eq("id", runId);
  if (error) throw error;
}

export async function saveIncidents(runId: string, incidents: AssessResult["incidents"]): Promise<void> {
  // Delete old incidents
  await supabase.from("incidents").delete().eq("run_id", runId);
  if (incidents.length === 0) return;
  const rows = incidents.map((inc) => ({
    run_id: runId,
    start_idx: inc.startIdx,
    end_idx: inc.endIdx,
    severity: inc.severity,
    label: inc.label,
  }));
  const { error } = await supabase.from("incidents").insert(rows);
  if (error) throw error;
}

export async function deleteRun(runId: string): Promise<void> {
  const { error } = await supabase.from("runs").delete().eq("id", runId);
  if (error) throw error;
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
