import type { RunRecord } from "@/lib/types";
import { RiskGauge } from "./RiskGauge";
import { SeverityBadge } from "./SeverityBadge";
import { Trash2, ChevronRight } from "lucide-react";
import { useState } from "react";

interface Props {
  runs: RunRecord[];
  selectedId: string | null;
  onSelect: (run: RunRecord) => void;
  onDelete: (runId: string) => void;
  incidentCounts: Map<string, number>;
  scanCosts: Map<string, number>;
}

export function RunsList({ runs, selectedId, onSelect, onDelete, incidentCounts, scanCosts }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-8 text-center">
        <p className="text-sm text-slate-500">No runs yet. Upload a trace or load a sample to begin.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => {
        const incCount = incidentCounts.get(run.id) || 0;
        const cost = scanCosts.get(run.id) || 0;
        const isSelected = run.id === selectedId;
        return (
          <div
            key={run.id}
            onClick={() => onSelect(run)}
            className={`group cursor-pointer rounded-lg border p-3 transition-all ${
              isSelected
                ? "border-violet-500/50 bg-violet-500/10"
                : "border-slate-700 bg-slate-800/40 hover:border-slate-600 hover:bg-slate-800/60"
            }`}
          >
            <div className="flex items-center gap-3">
              <RiskGauge score={run.risk_score} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-200">{run.agent_name}</span>
                  {incCount > 0 && (
                    <SeverityBadge severity={run.risk_score >= 70 ? "critical" : run.risk_score >= 40 ? "high" : run.risk_score >= 20 ? "medium" : "low"} />
                  )}
                </div>
                <p className="truncate text-xs text-slate-500">{run.user_goal}</p>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-600">
                  <span>{run.step_count} steps</span>
                  <span>{incCount} incidents</span>
                  {cost > 0 && <span>${cost.toFixed(4)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {confirmDelete === run.id ? (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(run.id); setConfirmDelete(null); }}
                      className="rounded p-1 text-xs text-red-400 hover:bg-red-500/20"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                      className="rounded p-1 text-xs text-slate-400 hover:bg-slate-700"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(run.id); }}
                  className="rounded p-1.5 text-slate-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <ChevronRight className="h-4 w-4 text-slate-600" />
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
