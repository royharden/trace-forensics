import { SAMPLE_TRACES } from "@/lib/sampleTraces";
import { FileText, AlertTriangle, Wrench, ShieldAlert, GitBranch, Lock } from "lucide-react";

const ICONS = [FileText, AlertTriangle, Wrench, ShieldAlert, GitBranch, Lock];

interface Props {
  onLoad: (sampleId: string) => void;
  loading: boolean;
}

export function SampleTraces({ onLoad, loading }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {SAMPLE_TRACES.map((sample, i) => {
        const Icon = ICONS[i] || FileText;
        return (
          <button
            key={sample.id}
            onClick={() => onLoad(sample.id)}
            disabled={loading}
            className="group flex flex-col gap-1.5 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-left transition-all hover:border-violet-500/50 hover:bg-slate-800/70 disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-violet-400 shrink-0" />
              <span className="text-xs font-semibold text-slate-200 group-hover:text-violet-300">
                {sample.name}
              </span>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-500">
              {sample.description}
            </p>
          </button>
        );
      })}
    </div>
  );
}
