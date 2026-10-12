import { useState } from "react";
import type { IncidentRecord } from "@/lib/types";
import { SeverityBadge } from "./SeverityBadge";
import { FileText, Copy, Loader2, AlertTriangle } from "lucide-react";

interface Props {
  incidents: IncidentRecord[];
  onWriteReport: () => void;
  reportLoading: boolean;
  report: string | null;
  reportMock: boolean;
}

export function IncidentPanel({ incidents, onWriteReport, reportLoading, report, reportMock }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!report) return;
    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          Incidents ({incidents.length})
        </h3>
        {incidents.length > 0 && (
          <button
            onClick={onWriteReport}
            disabled={reportLoading}
            className="flex items-center gap-1.5 rounded-lg bg-violet-500/20 px-3 py-1.5 text-xs font-medium text-violet-300 transition-all hover:bg-violet-500/30 disabled:opacity-50"
          >
            {reportLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Write incident report
          </button>
        )}
      </div>

      {incidents.length === 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-4 text-center">
          <p className="text-xs text-slate-500">No incidents detected. The run appears clean.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {incidents.map((inc) => (
            <div key={inc.id} className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
              <div className="flex items-center gap-2">
                <SeverityBadge severity={inc.severity} size="md" />
                <span className="text-xs font-medium text-slate-300">{inc.label}</span>
                <span className="ml-auto text-[10px] font-mono text-slate-600">
                  steps {inc.start_idx}–{inc.end_idx}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {report && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-violet-300">
              Incident Report
              {reportMock && <span className="ml-2 text-[10px] text-slate-500">(mock)</span>}
            </span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied!" : "Copy as Markdown"}
            </button>
          </div>
          <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
            {report}
          </div>
        </div>
      )}
    </div>
  );
}
