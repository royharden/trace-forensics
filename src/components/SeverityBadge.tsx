import type { Severity } from "@/lib/types";
import { severityBg, severityLabel } from "@/lib/assess";

interface Props {
  severity: Severity;
  size?: "sm" | "md";
}

export function SeverityBadge({ severity, size = "sm" }: Props) {
  const sizeCls = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-1";
  return (
    <span className={`inline-flex items-center rounded border font-medium uppercase tracking-wide ${severityBg(severity)} ${sizeCls}`}>
      {severityLabel(severity)}
    </span>
  );
}
