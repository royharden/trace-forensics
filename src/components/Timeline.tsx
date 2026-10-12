import { useState, useMemo } from "react";
import type { StepRecord, IncidentRecord } from "@/lib/types";
import { SeverityBadge } from "./SeverityBadge";
import { DiffView } from "./DiffView";
import {
  Brain, Wrench, FileOutput, MessageSquare, ChevronDown, ChevronRight,
  Search, Filter, AlertTriangle,
} from "lucide-react";

interface Props {
  steps: StepRecord[];
  incidents: IncidentRecord[];
  onStepClick: (step: StepRecord) => void;
  selectedStepIdx: number | null;
}

const TYPE_ICONS = {
  thought: Brain,
  tool_call: Wrench,
  tool_result: FileOutput,
  message: MessageSquare,
};

const TYPE_COLORS = {
  thought: "text-sky-400",
  tool_call: "text-violet-400",
  tool_result: "text-emerald-400",
  message: "text-amber-400",
};

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low" | "info";

export function Timeline({ steps, incidents, onStepClick, selectedStepIdx }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const tools = useMemo(() => {
    const set = new Set<string>();
    steps.forEach((s) => { if (s.tool) set.add(s.tool); });
    return Array.from(set).sort();
  }, [steps]);

  const filteredSteps = useMemo(() => {
    return steps.filter((s) => {
      if (severityFilter !== "all" && s.severity !== severityFilter) return false;
      if (toolFilter !== "all" && s.tool !== toolFilter) return false;
      if (categoryFilter !== "all") {
        const rules = s.fired_rules || [];
        if (categoryFilter === "destructive" && !rules.some((r) => r.includes("destructive"))) return false;
        if (categoryFilter === "covers_tracks" && !rules.some((r) => r.includes("covers_tracks"))) return false;
        if (categoryFilter === "self_modify" && !rules.some((r) => r.includes("self_modify"))) return false;
        if (categoryFilter === "injected" && !rules.some((r) => r.includes("injected"))) return false;
        if (categoryFilter === "out_of_scope" && !rules.some((r) => r.includes("out-of-scope") || r.includes("out_of_scope"))) return false;
      }
      return true;
    });
  }, [steps, severityFilter, toolFilter, categoryFilter]);

  const toggleCollapse = (idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // Build a map of incident ranges by step index
  const incidentMap = useMemo(() => {
    const m = new Map<number, IncidentRecord>();
    for (const inc of incidents) {
      for (let i = inc.start_idx; i <= inc.end_idx; i++) {
        m.set(i, inc);
      }
    }
    return m;
  }, [incidents]);

  // Find incident starts for bracket rendering
  const incidentStarts = useMemo(() => {
    const starts = new Set(incidents.map((i) => i.start_idx));
    return starts;
  }, [incidents]);

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/40 p-2">
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <Filter className="h-3.5 w-3.5" />
          <span>Filter:</span>
        </div>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="all">All categories</option>
          <option value="destructive">Destructive</option>
          <option value="covers_tracks">Covers Tracks</option>
          <option value="self_modify">Self-Modify</option>
          <option value="injected">Injected</option>
          <option value="out_of_scope">Out of Scope</option>
        </select>
        <select
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300"
        >
          <option value="all">All tools</option>
          {tools.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="ml-auto text-xs text-slate-600">
          {filteredSteps.length} / {steps.length} steps
        </span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[19px] top-0 bottom-0 w-px bg-slate-700" />

        <div className="space-y-1">
          {filteredSteps.map((step) => {
            const Icon = TYPE_ICONS[step.type] || MessageSquare;
            const colorCls = TYPE_COLORS[step.type] || "text-slate-400";
            const isCollapsed = collapsed.has(step.idx) && (step.type === "thought" || step.type === "tool_result");
            const isSelected = selectedStepIdx === step.idx;
            const hasIncident = incidentMap.has(step.idx);
            const isIncidentStart = incidentStarts.has(step.idx);

            return (
              <div key={step.id} className="relative">
                {/* Incident bracket start */}
                {isIncidentStart && (() => {
                  const inc = incidentMap.get(step.idx)!;
                  return (
                    <div className="mb-1 ml-10 flex items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded border-l-2 border-fuchsia-500/50 bg-fuchsia-500/10 px-2 py-1">
                        <AlertTriangle className="h-3 w-3 text-fuchsia-400" />
                        <span className="text-[10px] font-medium text-fuchsia-300">
                          Incident: {inc.label} ({inc.start_idx}–{inc.end_idx})
                        </span>
                        <SeverityBadge severity={inc.severity} />
                      </div>
                    </div>
                  );
                })()}

                <div
                  onClick={() => onStepClick(step)}
                  className={`group flex items-start gap-3 rounded-lg py-1.5 pl-0 pr-2 transition-all cursor-pointer ${
                    isSelected ? "bg-violet-500/10" : "hover:bg-slate-800/40"
                  }`}
                >
                  {/* Icon node */}
                  <div className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 bg-slate-900 ${
                    hasIncident ? "border-fuchsia-500/50" : "border-slate-700"
                  }`}>
                    <Icon className={`h-4 w-4 ${colorCls}`} />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-slate-600">#{step.idx}</span>
                      <span className={`text-xs font-medium ${colorCls}`}>
                        {step.type === "tool_call" && step.tool ? step.tool :
                         step.type === "tool_result" && step.tool ? `${step.tool} result` :
                         step.type}
                      </span>
                      {step.severity && step.severity !== "info" && (
                        <SeverityBadge severity={step.severity} />
                      )}
                      {step.severity === "info" && step.batch_id && (
                        <SeverityBadge severity="info" />
                      )}
                      {(step.type === "thought" || step.type === "tool_result") && step.content && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleCollapse(step.idx); }}
                          className="ml-auto text-slate-600 hover:text-slate-400"
                        >
                          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </div>
                    {!isCollapsed && step.content && (
                      <p className="mt-0.5 text-xs leading-relaxed text-slate-400 line-clamp-3">
                        {step.content}
                      </p>
                    )}
                    {step.type === "tool_call" && step.args && (
                      <div className="mt-0.5">
                        <DiffInline step={step} />
                      </div>
                    )}
                    {step.fired_rules && step.fired_rules.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {step.fired_rules.map((rule, i) => (
                          <span key={i} className="rounded bg-slate-700/40 px-1.5 py-0.5 text-[9px] text-slate-500 font-mono">
                            {rule}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DiffInline({ step }: { step: StepRecord }) {
  const args = step.args;
  if (!args) return null;
  if (typeof args.before === "string" && typeof args.after === "string") {
    return (
      <div className="mt-1 rounded border border-slate-700 bg-slate-900/60 p-2">
        <p className="text-[9px] text-slate-600 mb-1">Diff detected (click step for full view)</p>
        <DiffView before={args.before as string} after={args.after as string} compact />
      </div>
    );
  }
  const argStr = JSON.stringify(args, null, 2);
  if (argStr.length < 200) {
    return <p className="mt-0.5 text-[10px] font-mono text-slate-500 line-clamp-2">{argStr}</p>;
  }
  return <p className="mt-0.5 text-[10px] font-mono text-slate-500">{argStr.slice(0, 200)}...</p>;
}
