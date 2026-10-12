import type { StepRecord, ScanBatchRecord } from "@/lib/types";
import type { StepAnswers } from "@/lib/assess";
import { DiffView } from "./DiffView";
import { hasBeforeAfter } from "@/lib/diff";
import { X, ChevronRight } from "lucide-react";
import { useEffect } from "react";

interface Props {
  step: StepRecord | null;
  answers: StepAnswers | null;
  batch: ScanBatchRecord | null;
  onClose: () => void;
}

const SIGNAL_LABELS: Record<string, string> = {
  destructive: "Destructive",
  covers_tracks: "Covers Tracks",
  self_modify: "Self-Modify",
  in_scope: "In Scope",
  injected: "Injected",
};

function AnswerBar({ label, value, threshold }: { label: string; value: number; threshold?: number }) {
  const pct = Math.round(value * 100);
  const isHigh = threshold !== undefined && value >= threshold;
  const barColor = isHigh ? "bg-fuchsia-500" : value >= 0.35 ? "bg-orange-500" : "bg-slate-600";

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-xs text-slate-400">{label}</span>
      <div className="relative h-4 flex-1 overflow-hidden rounded bg-slate-800">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
        {threshold !== undefined && (
          <div
            className="absolute top-0 h-full w-px bg-red-400/50"
            style={{ left: `${threshold * 100}%` }}
          />
        )}
        <span className="absolute inset-0 flex items-center justify-end pr-1.5 text-[10px] font-medium text-slate-300">
          {pct}%
        </span>
      </div>
    </div>
  );
}

export function StepInspector({ step, answers, batch, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!step) return null;

  const showDiff = step.type === "tool_call" && hasBeforeAfter(step.args);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-lg overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-700 bg-slate-900/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <ChevronRight className="h-4 w-4 text-slate-600" />
            <span className="text-sm font-semibold text-slate-200">
              Step #{step.idx} — {step.type}
              {step.tool && `: ${step.tool}`}
            </span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Args */}
          {step.args && Object.keys(step.args).length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Arguments</h4>
              <pre className="overflow-x-auto rounded border border-slate-700 bg-slate-950/60 p-2 text-xs text-slate-400 font-mono">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            </div>
          )}

          {/* Content */}
          {step.content && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Content</h4>
              <div className="rounded border border-slate-700 bg-slate-950/60 p-2 text-xs leading-relaxed text-slate-400">
                {step.content}
              </div>
            </div>
          )}

          {/* Diff */}
          {showDiff && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Diff (before → after)</h4>
              <DiffView before={step.args!.before as string} after={step.args!.after as string} />
            </div>
          )}

          {/* Jev Answers */}
          {answers && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Jev Answers</h4>
              <div className="space-y-2">
                <AnswerBar label="Destructive" value={answers.destructive} threshold={0.7} />
                <AnswerBar label="Covers Tracks" value={answers.covers_tracks} threshold={0.7} />
                <AnswerBar label="Self-Modify" value={answers.self_modify} threshold={0.7} />
                <AnswerBar label="In Scope" value={answers.in_scope} threshold={0.4} />
                <AnswerBar label="Injected" value={answers.injected} threshold={0.7} />
                <div className="flex items-center gap-2 pt-1">
                  <span className="w-24 text-xs text-slate-400">Category</span>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-violet-300">
                    {answers.category}
                  </span>
                  <span className="text-[10px] text-slate-600">
                    confidence: {Math.round(answers.category_confidence * 100)}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Fired Rules */}
          {step.fired_rules && step.fired_rules.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Fired Rules</h4>
              <div className="flex flex-wrap gap-1.5">
                {step.fired_rules.map((rule, i) => (
                  <span key={i} className="rounded bg-slate-800 px-2 py-1 text-xs font-mono text-orange-300">
                    {rule}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Raw Request/Response */}
          {batch && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Batch Data</h4>
              <div className="space-y-2">
                <details className="rounded border border-slate-700 bg-slate-950/40">
                  <summary className="cursor-pointer px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200">
                    Request JSON ({batch.step_ids?.length || 0} steps in batch)
                  </summary>
                  <pre className="overflow-x-auto p-2 text-[10px] text-slate-500 font-mono max-h-48">
                    {JSON.stringify(batch.jev_request, null, 2)}
                  </pre>
                </details>
                <details className="rounded border border-slate-700 bg-slate-950/40">
                  <summary className="cursor-pointer px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200">
                    Response JSON
                  </summary>
                  <pre className="overflow-x-auto p-2 text-[10px] text-slate-500 font-mono max-h-48">
                    {JSON.stringify(batch.jev_response, null, 2)}
                  </pre>
                </details>
                {batch.model && (
                  <p className="text-[10px] text-slate-600">Model: {batch.model} · Latency: {batch.latency_ms}ms · Tokens: {batch.input_tokens} · Cost: ${batch.cost_usd?.toFixed(6) || "0"}</p>
                )}
              </div>
            </div>
          )}

          {!answers && !batch && (
            <p className="text-xs text-slate-600">
              This step was not scanned (only tool calls and agent messages are scanned).
            </p>
          )}
        </div>
      </div>
    </>
  );
}
