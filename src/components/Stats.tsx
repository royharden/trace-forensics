import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import type { StepRecord, ScanBatchRecord } from "@/lib/types";
import type { LLMCostParams } from "@/lib/types";
import { Brain, DollarSign, Clock, TrendingDown } from "lucide-react";

interface Props {
  steps: StepRecord[];
  batches: ScanBatchRecord[];
  llmCostParams: LLMCostParams;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#e879f9",
  high: "#f87171",
  medium: "#fb923c",
  low: "#facc15",
  info: "#64748b",
};

const SIGNAL_KEYS = ["destructive", "covers_tracks", "self_modify", "injected", "out_of_scope"];

export function Stats({ steps, batches, llmCostParams }: Props) {
  const severityData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of steps) {
      const sev = s.severity || "info";
      counts[sev] = (counts[sev] || 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [steps]);

  const signalData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of steps) {
      const rules = s.fired_rules || [];
      for (const r of rules) {
        for (const key of SIGNAL_KEYS) {
          if (r.includes(key) || r.includes(key.replace(/_/g, "-"))) {
            counts[key] = (counts[key] || 0) + 1;
          }
        }
      }
    }
    return SIGNAL_KEYS.map((k) => ({ name: k.replace(/_/g, " "), count: counts[k] || 0 }));
  }, [steps]);

  const latencyData = useMemo(() => {
    if (batches.length === 0) return { avgBatch: 0, avgStep: 0, totalMs: 0, batchCount: 0 };
    const totalMs = batches.reduce((sum, b) => sum + (b.latency_ms || 0), 0);
    const totalSteps = batches.reduce((sum, b) => sum + (b.step_ids?.length || 0), 0);
    return {
      avgBatch: Math.round(totalMs / batches.length),
      avgStep: totalSteps > 0 ? Math.round(totalMs / totalSteps) : 0,
      totalMs,
      batchCount: batches.length,
    };
  }, [batches]);

  const costData = useMemo(() => {
    const jevCost = batches.reduce((sum, b) => sum + (b.cost_usd || 0), 0);
    const jevInputTokens = batches.reduce((sum, b) => sum + (b.input_tokens || 0), 0);
    const scannedSteps = steps.filter((s) => s.batch_id).length;
    const llmInputTokens = jevInputTokens; // similar input
    const llmOutputTokens = scannedSteps * llmCostParams.outputTokensPerStep;
    const llmCost =
      (llmInputTokens * llmCostParams.inputCostPerM) / 1_000_000 +
      (llmOutputTokens * llmCostParams.outputCostPerM) / 1_000_000;
    return { jevCost, llmCost, jevInputTokens, llmOutputTokens, scannedSteps };
  }, [batches, steps, llmCostParams]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Severity Distribution */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Brain className="h-3.5 w-3.5 text-violet-400" />
          Severity Distribution
        </h4>
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie
              data={severityData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={60}
              innerRadius={30}
              paddingAngle={2}
            >
              {severityData.map((entry, i) => (
                <Cell key={i} fill={SEVERITY_COLORS[entry.name] || "#64748b"} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #475569", borderRadius: 8, fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Flags by Signal */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <TrendingDown className="h-3.5 w-3.5 text-orange-400" />
          Flags by Signal
        </h4>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={signalData} layout="vertical" margin={{ left: 20 }}>
            <XAxis type="number" tick={{ fill: "#64748b", fontSize: 10 }} />
            <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 10 }} width={80} />
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #475569", borderRadius: 8, fontSize: 12 }}
              cursor={{ fill: "#33415540" }}
            />
            <Bar dataKey="count" fill="#a78bfa" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Latency */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Clock className="h-3.5 w-3.5 text-sky-400" />
          Jev Latency
        </h4>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-2xl font-bold text-slate-200">{latencyData.avgBatch}</p>
            <p className="text-[10px] text-slate-500">ms / batch avg</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-slate-200">{latencyData.avgStep}</p>
            <p className="text-[10px] text-slate-500">ms / step avg</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-slate-200">{latencyData.batchCount}</p>
            <p className="text-[10px] text-slate-500">batches</p>
          </div>
        </div>
      </div>

      {/* Cost Comparison */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <DollarSign className="h-3.5 w-3.5 text-emerald-400" />
          Jev Cost vs LLM-Judge Estimate
        </h4>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Jev (this run)</span>
            <span className="text-sm font-mono font-bold text-violet-300">${costData.jevCost.toFixed(6)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">LLM-judge estimate</span>
            <span className="text-sm font-mono font-bold text-orange-300">${costData.llmCost.toFixed(6)}</span>
          </div>
          <div className="border-t border-slate-700 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Savings</span>
              <span className="text-sm font-mono font-bold text-emerald-400">
                {costData.llmCost > 0 ? `${((1 - costData.jevCost / costData.llmCost) * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-600">
            LLM estimate: ${llmCostParams.inputCostPerM}/M input + ${llmCostParams.outputCostPerM}/M output, ~{llmCostParams.outputTokensPerStep} output tokens/step
          </p>
        </div>
      </div>
    </div>
  );
}
