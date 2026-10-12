import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// --- Request limits ---
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_STEPS = 500;
const MAX_FIELD_CHARS = 20 * 1024; // per-step content, and per-step args as JSON
const MAX_GOAL_CHARS = 2000;
const MAX_AGENT_NAME_CHARS = 200;
const MAX_TOOL_CHARS = 200;
const MAX_ACTOR_CHARS = 100;
const MAX_TS_CHARS = 64;
const MAX_STEP_IDX = 1_000_000;
const STEP_TYPES = new Set(["thought", "tool_call", "tool_result", "message"]);

interface NormalizedStep {
  idx: number;
  ts: string | null;
  type: "thought" | "tool_call" | "tool_result" | "message";
  tool?: string | null;
  args?: Record<string, unknown> | null;
  content?: string | null;
  actor?: string | null;
}

interface NormalizedTrace {
  run_id: string;
  agent_name: string;
  user_goal: string;
  started_at: string;
  steps: NormalizedStep[];
}

function detectFormat(raw: unknown): "native" | "openai" | "jsonl" | null {
  if (typeof raw !== "string") {
    if (Array.isArray(raw)) return "openai";
    if (raw && typeof raw === "object" && "steps" in raw) return "native";
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && "steps" in obj) return "native";
      if (obj && typeof obj === "object" && "messages" in obj) return "openai";
    } catch { /* fall through */ }
  }
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return "openai";
    } catch { /* fall through */ }
  }
  // JSONL: each line is a JSON object with ts/event/data
  const lines = trimmed.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    try {
      const first = JSON.parse(lines[0]);
      if (first && typeof first === "object" && "event" in first) return "jsonl";
    } catch { /* fall through */ }
  }
  return null;
}

function parseNative(obj: Record<string, unknown>): NormalizedTrace {
  const steps = (obj.steps as unknown[] || []).map((s, i) => {
    const st = s as Record<string, unknown>;
    return {
      idx: typeof st.idx === "number" ? st.idx : i,
      ts: st.ts ? String(st.ts) : null,
      type: (st.type as NormalizedStep["type"]) || "message",
      tool: st.tool ? String(st.tool) : null,
      args: (st.args as Record<string, unknown>) || null,
      content: st.content ? String(st.content) : null,
      actor: st.actor ? String(st.actor) : null,
    };
  });
  return {
    run_id: (obj.run_id as string) || `run-${Date.now()}`,
    agent_name: (obj.agent_name as string) || "Unknown Agent",
    user_goal: (obj.user_goal as string) || "Unknown goal",
    started_at: (obj.started_at as string) || new Date().toISOString(),
    steps,
  };
}

function parseOpenAI(arr: unknown[]): NormalizedTrace {
  const steps: NormalizedStep[] = [];
  let idx = 0;
  let userGoal = "Unknown goal";
  for (const raw of arr) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;
    const content = msg.content ? String(msg.content) : null;
    if (role === "user" && content && !userGoal) {
      userGoal = content.slice(0, 500);
    }
    if (role === "assistant") {
      if (content) {
        steps.push({ idx: idx++, ts: null, type: "thought", content, actor: "assistant" });
      }
      const toolCalls = msg.tool_calls as unknown[] | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = (t.function as Record<string, unknown>) || {};
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = JSON.parse((fn.arguments as string) || "{}"); } catch { /* ignore */ }
          steps.push({
            idx: idx++, ts: null, type: "tool_call",
            tool: (fn.name as string) || "unknown",
            args: parsedArgs, actor: "assistant",
          });
        }
      }
    } else if (role === "tool") {
      steps.push({
        idx: idx++, ts: null, type: "tool_result",
        tool: (msg.name as string) || null,
        content, actor: "tool",
      });
    } else if (role === "user") {
      steps.push({ idx: idx++, ts: null, type: "message", content, actor: "user" });
    }
  }
  return {
    run_id: `run-${Date.now()}`,
    agent_name: "OpenAI Agent",
    user_goal: userGoal,
    started_at: new Date().toISOString(),
    steps,
  };
}

function parseJSONL(text: string): NormalizedTrace {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const steps: NormalizedStep[] = [];
  let idx = 0;
  let userGoal = "Unknown goal";
  let agentName = "Unknown Agent";
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      const lineNum = steps.length + 1;
      throw new Error(`JSONL parse error on line ${lineNum}: ${(e as Error).message}`);
    }
    const event = (obj.event as string) || "message";
    const ts = obj.ts ? String(obj.ts) : null;
    const data = (obj.data as Record<string, unknown>) || {};
    if (event === "goal" || event === "user_goal") {
      userGoal = String(data.goal || data.text || "Unknown goal");
    }
    if (event === "agent_name" || event === "meta") {
      agentName = String(data.name || data.agent_name || "Unknown Agent");
    }
    if (event === "thought" || event === "thinking") {
      steps.push({ idx: idx++, ts, type: "thought", content: String(data.text || data.content || ""), actor: "agent" });
    } else if (event === "tool_call") {
      steps.push({ idx: idx++, ts, type: "tool_call", tool: String(data.tool || data.name || "unknown"), args: (data.args as Record<string, unknown>) || {}, actor: "agent" });
    } else if (event === "tool_result" || event === "tool_output") {
      steps.push({ idx: idx++, ts, type: "tool_result", tool: String(data.tool || data.name || null), content: String(data.output || data.content || ""), actor: "tool" });
    } else if (event === "message" || event === "user_message") {
      steps.push({ idx: idx++, ts, type: "message", content: String(data.text || data.content || ""), actor: String(data.actor || "user") });
    }
  }
  return {
    run_id: `run-${Date.now()}`,
    agent_name: agentName,
    user_goal: userGoal,
    started_at: new Date().toISOString(),
    steps,
  };
}

function normalizeTrace(body: string | unknown): { trace: NormalizedTrace; format: string } {
  const format = detectFormat(body);
  if (!format) throw new Error("Could not detect trace format. Expected native JSON, OpenAI chat messages, or JSONL.");
  if (format === "native") {
    const obj = typeof body === "string" ? JSON.parse(body) : body as Record<string, unknown>;
    return { trace: parseNative(obj), format };
  }
  if (format === "openai") {
    const arr = typeof body === "string" ? JSON.parse(body) : body as unknown[];
    return { trace: parseOpenAI(arr), format };
  }
  // jsonl
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { trace: parseJSONL(text), format };
}

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

function tooLong(v: unknown, max: number): boolean {
  return v !== null && v !== undefined && (typeof v !== "string" || v.length > max);
}

// Per-field limits on the normalized trace. Returns an error message, or null when valid.
function validateTrace(trace: NormalizedTrace): string | null {
  if (typeof trace.agent_name !== "string" || trace.agent_name.length > MAX_AGENT_NAME_CHARS) {
    return `agent_name must be a string of at most ${MAX_AGENT_NAME_CHARS} characters`;
  }
  if (typeof trace.user_goal !== "string" || trace.user_goal.length > MAX_GOAL_CHARS) {
    return `user_goal must be a string of at most ${MAX_GOAL_CHARS} characters`;
  }
  for (const [i, s] of trace.steps.entries()) {
    if (!Number.isInteger(s.idx) || s.idx < 0 || s.idx > MAX_STEP_IDX) {
      return `Step ${i}: idx must be an integer between 0 and ${MAX_STEP_IDX}`;
    }
    if (!STEP_TYPES.has(s.type)) {
      return `Step ${s.idx}: type must be one of thought, tool_call, tool_result, message`;
    }
    if (tooLong(s.content, MAX_FIELD_CHARS)) {
      return `Step ${s.idx}: content exceeds ${MAX_FIELD_CHARS} characters`;
    }
    if (s.args !== null && s.args !== undefined) {
      if (typeof s.args !== "object" || Array.isArray(s.args)) {
        return `Step ${s.idx}: args must be an object`;
      }
      if (JSON.stringify(s.args).length > MAX_FIELD_CHARS) {
        return `Step ${s.idx}: args exceed ${MAX_FIELD_CHARS} characters`;
      }
    }
    if (tooLong(s.tool, MAX_TOOL_CHARS)) return `Step ${s.idx}: tool exceeds ${MAX_TOOL_CHARS} characters`;
    if (tooLong(s.actor, MAX_ACTOR_CHARS)) return `Step ${s.idx}: actor exceeds ${MAX_ACTOR_CHARS} characters`;
    if (tooLong(s.ts, MAX_TS_CHARS)) return `Step ${s.idx}: ts exceeds ${MAX_TS_CHARS} characters`;
  }
  return null;
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

  try {
    const contentType = req.headers.get("content-type") || "";
    const isMultipart = contentType.includes("multipart/form-data");
    const maxBodyBytes = isMultipart ? MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES : MAX_FILE_BYTES;

    // 2 MB cap: check the declared length before reading, then enforce while reading
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBodyBytes) {
      return json(413, { error: "File exceeds 2 MB limit" });
    }
    const bytes = await readBodyCapped(req, maxBodyBytes);
    if (!bytes) {
      return json(413, { error: "File exceeds 2 MB limit" });
    }

    let rawBody: string;
    if (isMultipart) {
      let formData: FormData;
      try {
        formData = await new Response(bytes.buffer as ArrayBuffer, { headers: { "content-type": contentType } }).formData();
      } catch {
        return json(400, { error: "Invalid multipart body" });
      }
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return json(400, { error: "No file provided" });
      }
      if (file.size > MAX_FILE_BYTES) {
        return json(413, { error: "File exceeds 2 MB limit" });
      }
      rawBody = await file.text();
    } else {
      rawBody = new TextDecoder().decode(bytes);
    }

    let parsed: { trace: NormalizedTrace; format: string };
    try {
      parsed = normalizeTrace(rawBody);
    } catch (e) {
      return json(400, { error: `Parse error: ${(e as Error).message}` });
    }

    const { trace, format } = parsed;

    // 500 step cap
    if (trace.steps.length > MAX_STEPS) {
      return json(400, { error: `Trace has ${trace.steps.length} steps, exceeding the ${MAX_STEPS} step limit` });
    }
    if (trace.steps.length === 0) {
      return json(400, { error: "Trace has no steps" });
    }

    const invalid = validateTrace(trace);
    if (invalid) {
      return json(422, { error: invalid });
    }

    // Insert run
    const { data: run, error: runErr } = await supabase
      .from("runs")
      .insert({
        agent_name: trace.agent_name,
        user_goal: trace.user_goal,
        source_format: format,
        step_count: trace.steps.length,
        risk_score: 0,
      })
      .select()
      .single();

    if (runErr || !run) {
      if (runErr) console.error("Failed to create run:", runErr.message);
      return json(500, { error: "Failed to create run" });
    }

    // Insert steps in batches of 100
    const stepRows = trace.steps.map((s) => ({
      run_id: run.id,
      idx: s.idx,
      ts: s.ts,
      type: s.type,
      tool: s.tool,
      args: s.args,
      content: s.content,
      actor: s.actor,
    }));

    for (let i = 0; i < stepRows.length; i += 100) {
      const batch = stepRows.slice(i, i + 100);
      const { error: stepErr } = await supabase.from("steps").insert(batch);
      if (stepErr) {
        console.error("Failed to insert steps:", stepErr.message);
        // Don't leave a run with missing steps behind
        await supabase.from("runs").delete().eq("id", run.id);
        return json(500, { error: "Failed to insert steps" });
      }
    }

    return json(200, {
      run_id: run.id,
      step_count: trace.steps.length,
      source_format: format,
    });
  } catch (err) {
    console.error("ingest error:", err);
    return json(500, { error: "Internal error" });
  }
});
