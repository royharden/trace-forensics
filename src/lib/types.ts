export type StepType = "thought" | "tool_call" | "tool_result" | "message";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type SourceFormat = "native" | "openai" | "jsonl";

export interface NormalizedStep {
  idx: number;
  ts: string | null;
  type: StepType;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  content?: string | null;
  actor?: string | null;
}

export interface NormalizedTrace {
  run_id: string;
  agent_name: string;
  user_goal: string;
  started_at: string;
  steps: NormalizedStep[];
}

export interface JevAnswers {
  destructive?: number;
  covers_tracks?: number;
  self_modify?: number;
  in_scope?: number;
  injected?: number;
  category?: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
}

export interface StepRecord {
  id: string;
  run_id: string;
  idx: number;
  ts: string | null;
  type: StepType;
  tool: string | null;
  args: Record<string, unknown> | null;
  content: string | null;
  actor: string | null;
  severity: Severity | null;
  fired_rules: string[] | null;
  batch_id: string | null;
}

export interface RunRecord {
  id: string;
  agent_name: string;
  user_goal: string;
  source_format: SourceFormat;
  step_count: number;
  risk_score: number;
  created_at: string;
}

export interface ScanBatchRecord {
  id: string;
  run_id: string;
  step_ids: number[];
  jev_request: Record<string, unknown>;
  jev_response: Record<string, unknown>;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface IncidentRecord {
  id: string;
  run_id: string;
  start_idx: number;
  end_idx: number;
  severity: Severity;
  label: string;
  report: string | null;
}

export interface SeverityPolicy {
  criticalCoversTracks: number;
  criticalSelfModify: number;
  criticalInjected: number;
  highDestructive: number;
  highInScope: number;
  highPrivilegeConfidence: number;
  mediumInScope: number;
  mediumDestructive: number;
  lowSignalMin: number;
  incidentGap: number;
  weights: Record<Severity, number>;
  scoreCap: number;
}

export interface SeverityResult {
  severity: Severity;
  firedRules: string[];
}

export interface IncidentResult {
  startIdx: number;
  endIdx: number;
  severity: Severity;
  label: string;
}

export interface AssessResult {
  stepResults: Array<{ idx: number; severity: Severity; firedRules: string[] }>;
  incidents: IncidentResult[];
  riskScore: number;
}

export type ScanMode = "live" | "replay";

export interface LLMCostParams {
  inputCostPerM: number;
  outputCostPerM: number;
  outputTokensPerStep: number;
}
