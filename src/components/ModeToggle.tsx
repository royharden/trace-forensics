import type { ScanMode } from "@/lib/types";
import { Radio, History } from "lucide-react";

interface Props {
  mode: ScanMode;
  onChange: (mode: ScanMode) => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
      <button
        onClick={() => onChange("live")}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
          mode === "live"
            ? "bg-violet-500/20 text-violet-300"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <Radio className="h-3.5 w-3.5" />
        Live
      </button>
      <button
        onClick={() => onChange("replay")}
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
          mode === "replay"
            ? "bg-violet-500/20 text-violet-300"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <History className="h-3.5 w-3.5" />
        Replay
      </button>
    </div>
  );
}
