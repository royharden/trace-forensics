import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// --- Abuse limits ---
const USAGE_FN = "llm";
const DEFAULT_DAILY_LIMIT = 200;
const MAX_BODY_BYTES = 64 * 1024;
const OPENAI_TIMEOUT_MS = 60_000;

// incident_report prompt bounds
const MAX_INCIDENTS = 20;
const MAX_GOAL_CHARS = 500;
const MAX_EXCERPTS_PER_INCIDENT = 20;
const MAX_EXCERPT_CHARS = 200;
const MAX_LABEL_CHARS = 64;
const MAX_TYPE_CHARS = 32;
const MAX_TOOL_CHARS = 100;

// save_* bounds (writes from the browser, not counted against the AI cap)
const MAX_SAVE_STEPS = 100;
const MAX_SAVE_INCIDENTS = 500;
const MAX_FIRED_RULES = 10;
const MAX_RULE_CHARS = 100;
const MAX_STEP_IDX = 1_000_000;
const MAX_RISK_SCORE = 100;

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Incident = Record<string, unknown>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getServiceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getDailyLimit(): number {
  const raw = Deno.env.get("DAILY_CALL_LIMIT");
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_LIMIT;
  if (!/^\d{1,9}$/.test(raw.trim())) {
    console.warn("DAILY_CALL_LIMIT is not a non-negative integer; using default");
    return DEFAULT_DAILY_LIMIT;
  }
  return parseInt(raw.trim(), 10);
}

// Reads the request body, giving up once it exceeds maxBytes. Returns null when too large.
async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Counts one upstream OpenAI fetch against the daily cap. Fails closed.
async function consumeUsage(
  supabase: SupabaseClient,
  dailyLimit: number,
): Promise<"ok" | "limit" | "unavailable"> {
  const { data, error } = await supabase.rpc("increment_usage_by", {
    p_fn: USAGE_FN,
    p_units: 1,
    p_cap: dailyLimit,
  });
  if (error) {
    console.error("increment_usage_by failed:", error.message);
    return "unavailable";
  }
  if (data === -1) return "limit";
  if (typeof data !== "number" || !Number.isInteger(data) || data < 1) {
    console.error("increment_usage_by returned an unexpected value:", data);
    return "unavailable";
  }
  return "ok";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStepIdx(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_STEP_IDX;
}

function clip(v: unknown, max: number): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function optionalString(v: unknown, max: number): string | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max) return false;
  return v;
}

function mockIncidentReport(incidents: Array<Record<string, unknown>>, runGoal: string): string {
  if (incidents.length === 0) {
    return `## Incident Report\n\n**Summary:** No incidents were detected during this run. The agent appears to have operated within the expected scope of the user's goal: "${runGoal}".\n\n**Timeline:** All steps were assessed as low-risk or informational.\n\n**Impact:** None identified.\n\n**Recommended Guardrails:** Continue monitoring. No additional guardrails are required at this time.`;
  }

  const lines: string[] = [`## Incident Report`, ``];
  const labels = incidents.map((i) => i.label as string).filter(Boolean);
  lines.push(`**Summary:** ${incidents.length} incident(s) were detected during this run. The user's goal was: "${runGoal}". The primary concern(s): ${labels.join(", ")}.`);
  lines.push(``);
  lines.push(`**Timeline:**`);
  for (const inc of incidents) {
    lines.push(`- Steps ${inc.start_idx}–${inc.end_idx} (${inc.severity}): ${inc.label}`);
  }
  lines.push(``);
  lines.push(`**Impact:** The flagged steps may have compromised system integrity, data safety, or scope boundaries. See individual step details for specifics.`);
  lines.push(``);
  lines.push(`**Recommended Guardrails:**`);
  lines.push(`- Require human approval before destructive or irreversible operations.`);
  lines.push(`- Enforce scope boundaries with explicit allow-lists for tools and actions.`);
  lines.push(`- Monitor for prompt injection in tool results and external content.`);
  lines.push(`- Log all actions to an append-only audit trail that the agent cannot modify.`);
  return lines.join("\n");
}

// Validates incidents supplied in the request body. Returns an error message on failure.
function parseClientIncidents(raw: unknown): Incident[] | string {
  if (!Array.isArray(raw)) return "incidents must be an array";
  if (raw.length > MAX_INCIDENTS) return `At most ${MAX_INCIDENTS} incidents are allowed`;
  const out: Incident[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isPlainObject(item)) return `incidents[${i}] must be an object`;
    if (!isStepIdx(item.start_idx) || !isStepIdx(item.end_idx)) {
      return `incidents[${i}]: start_idx and end_idx must be integers between 0 and ${MAX_STEP_IDX}`;
    }
    if (typeof item.severity !== "string" || !SEVERITIES.has(item.severity)) {
      return `incidents[${i}]: invalid severity`;
    }
    const label = optionalString(item.label, MAX_LABEL_CHARS);
    if (label === false) return `incidents[${i}]: label must be a string of at most ${MAX_LABEL_CHARS} characters`;

    const excerptsRaw = item.step_excerpts ?? [];
    if (!Array.isArray(excerptsRaw) || excerptsRaw.length > MAX_EXCERPTS_PER_INCIDENT) {
      return `incidents[${i}]: step_excerpts must be an array of at most ${MAX_EXCERPTS_PER_INCIDENT} items`;
    }
    const excerpts: Incident[] = [];
    for (const [j, ex] of excerptsRaw.entries()) {
      const where = `incidents[${i}].step_excerpts[${j}]`;
      if (!isPlainObject(ex)) return `${where} must be an object`;
      if (!isStepIdx(ex.idx)) return `${where}: invalid idx`;
      const type = optionalString(ex.type, MAX_TYPE_CHARS);
      const tool = optionalString(ex.tool, MAX_TOOL_CHARS);
      const content = optionalString(ex.content, MAX_EXCERPT_CHARS);
      const args = optionalString(ex.args, MAX_EXCERPT_CHARS);
      if (type === false || tool === false) return `${where}: type/tool too long or not a string`;
      if (content === false || args === false) {
        return `${where}: content and args must be strings of at most ${MAX_EXCERPT_CHARS} characters`;
      }
      if (ex.severity !== undefined && ex.severity !== null &&
          (typeof ex.severity !== "string" || !SEVERITIES.has(ex.severity))) {
        return `${where}: invalid severity`;
      }
      excerpts.push({
        idx: ex.idx, type, tool, content, args,
        severity: (ex.severity as string | null | undefined) ?? null,
      });
    }

    out.push({
      start_idx: item.start_idx,
      end_idx: item.end_idx,
      severity: item.severity,
      label: label ?? "",
      step_excerpts: excerpts,
    });
  }
  return out;
}

async function handleIncidentReport(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const { run_id, incidents: clientIncidents, goal } = body;

  if (run_id !== undefined && run_id !== null && (typeof run_id !== "string" || !UUID_RE.test(run_id))) {
    return json(400, { error: "run_id must be a UUID" });
  }
  if (goal !== undefined && goal !== null && (typeof goal !== "string" || goal.length > MAX_GOAL_CHARS)) {
    return json(422, { error: `goal must be a string of at most ${MAX_GOAL_CHARS} characters` });
  }

  // Gather incidents and steps
  let incidents: Incident[] = [];
  let runGoal = typeof goal === "string" ? goal : "";

  if (run_id) {
    const { data: runData } = await supabase
      .from("runs")
      .select("user_goal")
      .eq("id", run_id)
      .single();
    if (runData) runGoal = clip(runData.user_goal, MAX_GOAL_CHARS);

    const { data: incData } = await supabase
      .from("incidents")
      .select("start_idx, end_idx, severity, label")
      .eq("run_id", run_id)
      .order("start_idx", { ascending: true })
      .limit(MAX_INCIDENTS);

    if (incData && incData.length > 0) {
      // Fetch step excerpts for each incident
      for (const row of incData as Incident[]) {
        const { data: stepData } = await supabase
          .from("steps")
          .select("idx, type, tool, args, content, severity")
          .eq("run_id", run_id)
          .gte("idx", row.start_idx as number)
          .lte("idx", row.end_idx as number)
          .order("idx", { ascending: true })
          .limit(MAX_EXCERPTS_PER_INCIDENT);

        incidents.push({
          start_idx: row.start_idx,
          end_idx: row.end_idx,
          severity: clip(row.severity, MAX_TYPE_CHARS),
          label: clip(row.label, MAX_LABEL_CHARS),
          step_excerpts: (stepData || []).map((s: Record<string, unknown>) => ({
            idx: s.idx,
            type: clip(s.type, MAX_TYPE_CHARS),
            tool: clip(s.tool, MAX_TOOL_CHARS),
            args: s.args ? JSON.stringify(s.args).slice(0, MAX_EXCERPT_CHARS) : "",
            content: clip(s.content, MAX_EXCERPT_CHARS),
            severity: clip(s.severity, MAX_TYPE_CHARS),
          })),
        });
      }
    }
  } else if (clientIncidents !== undefined && clientIncidents !== null) {
    const parsed = parseClientIncidents(clientIncidents);
    if (typeof parsed === "string") return json(422, { error: parsed });
    incidents = parsed;
  }

  if (incidents.length === 0) {
    const report = mockIncidentReport([], runGoal);
    if (run_id) {
      await supabase.from("incidents").upsert({
        run_id,
        start_idx: 0,
        end_idx: 0,
        severity: "info",
        label: "No incidents",
        report,
      });
    }
    return json(200, { report });
  }

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

  if (!openaiKey) {
    // Mock LLM mode: no upstream call, nothing counted
    const report = mockIncidentReport(incidents, runGoal);
    if (run_id) {
      await supabase.from("incidents").update({ report }).eq("run_id", run_id);
    }
    return json(200, { report, mock: true });
  }

  // Build prompt for LLM
  const incidentText = incidents.map((inc, i) => {
    const excerpts = ((inc.step_excerpts || []) as Array<Record<string, unknown>>)
      .map((s) => `  - Step ${s.idx} [${s.type}${s.tool ? `:${s.tool}` : ""}] (${s.severity}): ${s.content || s.args || ""}`)
      .join("\n");
    return `Incident ${i + 1}: Steps ${inc.start_idx}–${inc.end_idx}, Severity: ${inc.severity}, Label: ${inc.label}\nSteps:\n${excerpts}`;
  }).join("\n\n");

  const systemPrompt = `You are a security analyst writing an incident report for an AI agent run. Write a concise report with: a summary paragraph, a timeline citing step numbers, the impact, and recommended guardrails. Cite step numbers explicitly. Use markdown.`;
  const userPrompt = `User goal: "${runGoal}"\n\nIncidents:\n${incidentText}\n\nWrite the incident report now.`;

  // Count the OpenAI call right before making it. Fails closed.
  const usage = await consumeUsage(supabase, getDailyLimit());
  if (usage === "limit") {
    return json(429, { error: "daily_limit", message: "Daily demo limit reached" });
  }
  if (usage === "unavailable") {
    return json(503, { error: "usage_check_failed", message: "Usage check failed, service unavailable" });
  }

  let llmResp: Response;
  try {
    llmResp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("LLM request failed:", (e as Error).message);
    return json(200, { report: mockIncidentReport(incidents, runGoal), mock: true });
  }

  if (!llmResp.ok) {
    const errText = await llmResp.text().catch(() => "");
    console.error(`LLM error ${llmResp.status}: ${errText.slice(0, 2000)}`);
    // Fall back to mock
    return json(200, { report: mockIncidentReport(incidents, runGoal), mock: true });
  }

  let report: string;
  try {
    const llmData = await llmResp.json();
    report = llmData.choices?.[0]?.message?.content || mockIncidentReport(incidents, runGoal);
  } catch (e) {
    console.error("LLM returned invalid JSON:", (e as Error).message);
    return json(200, { report: mockIncidentReport(incidents, runGoal), mock: true });
  }

  // Store report on incidents
  if (run_id) {
    await supabase.from("incidents").update({ report }).eq("run_id", run_id);
  }

  return json(200, { report, mock: false });
}

// Writes per-step severity from the browser's assess() result.
async function handleSaveStepSeverities(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const { run_id, steps } = body;
  if (typeof run_id !== "string" || !UUID_RE.test(run_id)) {
    return json(400, { error: "run_id must be a UUID" });
  }
  if (!Array.isArray(steps) || steps.length > MAX_SAVE_STEPS) {
    return json(422, { error: `steps must be an array of at most ${MAX_SAVE_STEPS} items` });
  }

  // Group steps sharing the same severity + rules so each group is one UPDATE.
  const groups = new Map<string, { severity: string; fired_rules: string[]; idxs: number[] }>();
  for (const [i, s] of steps.entries()) {
    if (!isPlainObject(s) || !isStepIdx(s.idx)) return json(422, { error: `steps[${i}]: invalid idx` });
    if (typeof s.severity !== "string" || !SEVERITIES.has(s.severity)) {
      return json(422, { error: `steps[${i}]: invalid severity` });
    }
    const rules = s.fired_rules ?? [];
    if (!Array.isArray(rules) || rules.length > MAX_FIRED_RULES ||
        rules.some((r) => typeof r !== "string" || r.length > MAX_RULE_CHARS)) {
      return json(422, {
        error: `steps[${i}]: fired_rules must be at most ${MAX_FIRED_RULES} strings of at most ${MAX_RULE_CHARS} characters`,
      });
    }
    const key = JSON.stringify([s.severity, rules]);
    const group = groups.get(key) ?? { severity: s.severity, fired_rules: rules as string[], idxs: [] };
    group.idxs.push(s.idx);
    groups.set(key, group);
  }

  for (const g of groups.values()) {
    const { error } = await supabase
      .from("steps")
      .update({ severity: g.severity, fired_rules: g.fired_rules })
      .eq("run_id", run_id)
      .in("idx", g.idxs);
    if (error) {
      console.error("Failed to update step severities:", error.message);
      return json(500, { error: "Failed to save step severities" });
    }
  }

  return json(200, { ok: true, updated: steps.length });
}

// Writes the run's risk score and replaces its incidents.
async function handleSaveRunAssessment(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const { run_id, risk_score, incidents } = body;
  if (typeof run_id !== "string" || !UUID_RE.test(run_id)) {
    return json(400, { error: "run_id must be a UUID" });
  }
  if (!Number.isInteger(risk_score) || (risk_score as number) < 0 || (risk_score as number) > MAX_RISK_SCORE) {
    return json(422, { error: `risk_score must be an integer between 0 and ${MAX_RISK_SCORE}` });
  }
  if (!Array.isArray(incidents) || incidents.length > MAX_SAVE_INCIDENTS) {
    return json(422, { error: `incidents must be an array of at most ${MAX_SAVE_INCIDENTS} items` });
  }

  const rows = [];
  for (const [i, inc] of incidents.entries()) {
    if (!isPlainObject(inc) || !isStepIdx(inc.start_idx) || !isStepIdx(inc.end_idx)) {
      return json(422, { error: `incidents[${i}]: invalid start_idx/end_idx` });
    }
    if (typeof inc.severity !== "string" || !SEVERITIES.has(inc.severity)) {
      return json(422, { error: `incidents[${i}]: invalid severity` });
    }
    if (typeof inc.label !== "string" || inc.label.length > MAX_LABEL_CHARS) {
      return json(422, { error: `incidents[${i}]: label must be a string of at most ${MAX_LABEL_CHARS} characters` });
    }
    rows.push({
      run_id,
      start_idx: inc.start_idx,
      end_idx: inc.end_idx,
      severity: inc.severity,
      label: inc.label,
    });
  }

  const { data: updated, error: runErr } = await supabase
    .from("runs")
    .update({ risk_score })
    .eq("id", run_id)
    .select("id");
  if (runErr) {
    console.error("Failed to update risk score:", runErr.message);
    return json(500, { error: "Failed to save risk score" });
  }
  if (!updated || updated.length === 0) {
    return json(404, { error: "Run not found" });
  }

  // Replace old incidents
  const { error: delErr } = await supabase.from("incidents").delete().eq("run_id", run_id);
  if (delErr) {
    console.error("Failed to clear incidents:", delErr.message);
    return json(500, { error: "Failed to save incidents" });
  }
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from("incidents").insert(rows);
    if (insErr) {
      console.error("Failed to insert incidents:", insErr.message);
      return json(500, { error: "Failed to save incidents" });
    }
  }

  return json(200, { ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const supabase = getServiceClient();
  if (!supabase) {
    console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return json(503, { error: "Service not configured" });
  }

  let body: unknown;
  try {
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return json(413, { error: "Request body too large" });
    }
    const bytes = await readBodyCapped(req, MAX_BODY_BYTES);
    if (!bytes) return json(413, { error: "Request body too large" });
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!isPlainObject(body)) {
    return json(400, { error: "Request body must be a JSON object" });
  }

  const { action } = body;
  if (!action) {
    return json(400, { error: "action is required" });
  }

  try {
    switch (action) {
      case "incident_report":
        return await handleIncidentReport(supabase, body);
      case "save_step_severities":
        return await handleSaveStepSeverities(supabase, body);
      case "save_run_assessment":
        return await handleSaveRunAssessment(supabase, body);
      default:
        return json(400, { error: "Unknown action" });
    }
  } catch (err) {
    console.error("llm error:", err);
    return json(500, { error: "Internal error" });
  }
});
