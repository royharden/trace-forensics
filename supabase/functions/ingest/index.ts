import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    let rawBody: string;

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      rawBody = await file.text();
    } else {
      rawBody = await req.text();
    }

    // 2 MB cap
    if (rawBody.length > 2 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "File exceeds 2 MB limit" }), {
        status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let parsed: { trace: NormalizedTrace; format: string };
    try {
      parsed = normalizeTrace(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: `Parse error: ${(e as Error).message}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { trace, format } = parsed;

    // 500 step cap
    if (trace.steps.length > 500) {
      return new Response(JSON.stringify({ error: `Trace has ${trace.steps.length} steps, exceeding the 500 step limit` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (trace.steps.length === 0) {
      return new Response(JSON.stringify({ error: "Trace has no steps" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

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
      return new Response(JSON.stringify({ error: `Failed to create run: ${runErr?.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        return new Response(JSON.stringify({ error: `Failed to insert steps: ${stepErr.message}` }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({
      run_id: run.id,
      step_count: trace.steps.length,
      source_format: format,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
