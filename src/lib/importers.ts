import type { NormalizedStep, NormalizedTrace, StepType } from "./types";

export type DetectedFormat = "native" | "openai" | "jsonl";

export interface ImportResult {
  trace: NormalizedTrace;
  format: DetectedFormat;
}

export function detectFormat(raw: string): DetectedFormat | null {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && "steps" in obj) return "native";
      if (obj && typeof obj === "object" && "messages" in obj) return "openai";
    } catch {
      // fall through
    }
  }

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return "openai";
    } catch {
      // fall through
    }
  }

  const lines = trimmed.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    try {
      const first = JSON.parse(lines[0]);
      if (first && typeof first === "object" && "event" in first) return "jsonl";
    } catch {
      // fall through
    }
  }

  return null;
}

function parseNative(obj: Record<string, unknown>): NormalizedTrace {
  const steps = (obj.steps as unknown[] || []).map((s, i) => {
    const st = s as Record<string, unknown>;
    return {
      idx: typeof st.idx === "number" ? st.idx : i,
      ts: st.ts ? String(st.ts) : null,
      type: (st.type as StepType) || "message",
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
  let firstUser = true;

  for (const raw of arr) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;
    const content = msg.content ? String(msg.content) : null;

    if (role === "user" && content && firstUser) {
      userGoal = content.slice(0, 500);
      firstUser = false;
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
          try {
            parsedArgs = JSON.parse((fn.arguments as string) || "{}");
          } catch {
            // ignore parse error
          }
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

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`JSONL parse error on line ${lineNum + 1}: ${(e as Error).message}`);
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

export function importTrace(raw: string): ImportResult {
  const format = detectFormat(raw);
  if (!format) {
    throw new Error("Could not detect trace format. Expected native JSON with 'steps', OpenAI chat messages array, or JSONL with 'event' fields.");
  }

  if (format === "native") {
    const obj = JSON.parse(raw);
    return { trace: parseNative(obj), format };
  }
  if (format === "openai") {
    const arr = JSON.parse(raw);
    return { trace: parseOpenAI(arr), format };
  }
  return { trace: parseJSONL(raw), format };
}

export const MAX_FILE_SIZE = 2 * 1024 * 1024;
export const MAX_STEPS = 500;
