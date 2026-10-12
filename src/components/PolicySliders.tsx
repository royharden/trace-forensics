import type { SeverityPolicy } from "@/lib/types";
import { PRESETS } from "@/lib/assess";
import { Sliders } from "lucide-react";

interface Props {
  policy: SeverityPolicy;
  onChange: (policy: SeverityPolicy) => void;
}

const SLIDER_FIELDS: Array<{
  key: keyof SeverityPolicy;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "criticalCoversTracks", label: "Critical: covers_tracks ≥", min: 0.3, max: 0.95, step: 0.05 },
  { key: "criticalSelfModify", label: "Critical: self_modify ≥", min: 0.3, max: 0.95, step: 0.05 },
  { key: "criticalInjected", label: "Critical: injected ≥", min: 0.3, max: 0.95, step: 0.05 },
  { key: "highDestructive", label: "High: destructive ≥", min: 0.3, max: 0.95, step: 0.05 },
  { key: "highInScope", label: "High: in_scope <", min: 0.2, max: 0.8, step: 0.05 },
  { key: "mediumInScope", label: "Medium: in_scope <", min: 0.2, max: 0.6, step: 0.05 },
  { key: "mediumDestructive", label: "Medium: destructive ≥", min: 0.2, max: 0.8, step: 0.05 },
  { key: "lowSignalMin", label: "Low: signal min", min: 0.1, max: 0.6, step: 0.05 },
];

export function PolicySliders({ policy, onChange }: Props) {
  const applyPreset = (name: string) => {
    onChange({ ...PRESETS[name] });
  };

  const updateField = (key: keyof SeverityPolicy, value: number) => {
    onChange({ ...policy, [key]: value });
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Sliders className="h-3.5 w-3.5 text-violet-400" />
          Severity Policy
        </h4>
        <div className="flex gap-1">
          {Object.keys(PRESETS).map((name) => (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              className={`rounded px-2 py-1 text-[10px] font-medium transition-all ${
                JSON.stringify(policy) === JSON.stringify(PRESETS[name])
                  ? "bg-violet-500/20 text-violet-300"
                  : "bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2.5">
        {SLIDER_FIELDS.map((field) => {
          const value = policy[field.key] as number;
          return (
            <div key={field.key} className="flex items-center gap-3">
              <span className="w-44 text-[10px] text-slate-400">{field.label}</span>
              <input
                type="range"
                min={field.min}
                max={field.max}
                step={field.step}
                value={value}
                onChange={(e) => updateField(field.key, parseFloat(e.target.value))}
                className="flex-1 accent-violet-500"
              />
              <span className="w-10 text-right text-[10px] font-mono text-slate-300">
                {value.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
