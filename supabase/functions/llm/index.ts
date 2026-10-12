import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, run_id, incident_id, incidents: clientIncidents, goal } = body;

    if (!action) {
      return new Response(JSON.stringify({ error: "action is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // --- Usage cap check (fail closed) ---
    const dailyLimit = parseInt(Deno.env.get("DAILY_CALL_LIMIT") || "200", 10);
    try {
      const { data: countData, error: countErr } = await supabase
        .rpc("increment_usage_counter", { p_fn: "llm" });
      if (countErr) throw countErr;
      if (countData && countData > dailyLimit) {
        return new Response(JSON.stringify({
          error: "Daily demo limit reached",
          limit: dailyLimit,
        }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (capErr) {
      return new Response(JSON.stringify({
        error: "Usage check failed, service unavailable",
      }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "incident_report") {
      // Gather incidents and steps
      let incidents: Array<Record<string, unknown>> = [];
      let runGoal = goal || "";

      if (run_id) {
        const { data: runData } = await supabase
          .from("runs")
          .select("user_goal")
          .eq("id", run_id)
          .single();
        if (runData) runGoal = runData.user_goal;

        const { data: incData } = await supabase
          .from("incidents")
          .select("*")
          .eq("run_id", run_id)
          .order("start_idx", { ascending: true });

        if (incData && incData.length > 0) {
          // Fetch step excerpts for each incident
          for (const inc of incData as Array<Record<string, unknown>>) {
            const { data: stepData } = await supabase
              .from("steps")
              .select("idx, type, tool, args, content, severity, fired_rules")
              .eq("run_id", run_id)
              .gte("idx", inc.start_idx as number)
              .lte("idx", inc.end_idx as number)
              .order("idx", { ascending: true });

            (inc as Record<string, unknown>).step_excerpts = (stepData || []).map((s: Record<string, unknown>) => ({
              idx: s.idx,
              type: s.type,
              tool: s.tool,
              args: s.args ? JSON.stringify(s.args).slice(0, 200) : "",
              content: s.content ? String(s.content).slice(0, 200) : "",
              severity: s.severity,
            }));
          }
          incidents = incData as Array<Record<string, unknown>>;
        }
      } else if (clientIncidents) {
        incidents = clientIncidents;
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
        return new Response(JSON.stringify({ report }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
      const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

      if (!openaiKey) {
        // Mock LLM mode
        const report = mockIncidentReport(incidents, runGoal);
        if (run_id) {
          for (const inc of incidents) {
            await supabase.from("incidents")
              .update({ report })
              .eq("run_id", run_id)
              .eq("start_idx", inc.start_idx as number);
          }
        }
        return new Response(JSON.stringify({ report, mock: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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

      const llmResp = await fetch(`${baseUrl}/chat/completions`, {
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
      });

      if (!llmResp.ok) {
        const errText = await llmResp.text();
        // Fall back to mock
        const report = mockIncidentReport(incidents, runGoal);
        return new Response(JSON.stringify({ report, mock: true, llm_error: errText }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const llmData = await llmResp.json();
      const report = llmData.choices?.[0]?.message?.content || mockIncidentReport(incidents, runGoal);

      // Store report on incidents
      if (run_id) {
        for (const inc of incidents) {
          await supabase.from("incidents")
            .update({ report })
            .eq("run_id", run_id)
            .eq("start_idx", inc.start_idx as number);
        }
      }

      return new Response(JSON.stringify({ report, mock: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
