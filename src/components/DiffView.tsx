import type { DiffLine } from "@/lib/diff";
import { computeDiff } from "@/lib/diff";

interface Props {
  before: string;
  after: string;
  compact?: boolean;
}

export function DiffView({ before, after, compact }: Props) {
  const lines = computeDiff(before, after);

  return (
    <div className={`overflow-x-auto rounded border border-slate-700 bg-slate-950/60 font-mono text-xs ${compact ? "max-h-40" : "max-h-96"}`}>
      <pre className="p-2">
        {lines.map((line, i) => {
          const cls =
            line.type === "add" ? "text-emerald-400 bg-emerald-500/5" :
            line.type === "remove" ? "text-red-400 bg-red-500/5" :
            "text-slate-500";
          const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
          return (
            <div key={i} className={`whitespace-pre-wrap ${cls}`}>
              <span className="select-none opacity-50">{prefix} </span>
              {line.text || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
