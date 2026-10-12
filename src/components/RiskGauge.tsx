interface Props {
  score: number;
  size?: number;
}

export function RiskGauge({ score, size = 60 }: Props) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(score / 100, 1);
  const dashOffset = circumference * (1 - pct);

  let color = "#10b981";
  if (score >= 70) color = "#e879f9";
  else if (score >= 40) color = "#f87171";
  else if (score >= 20) color = "#fb923c";
  else if (score >= 5) color = "#facc15";

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="currentColor" strokeWidth={4}
          className="text-slate-700"
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      <span className="absolute text-sm font-bold text-slate-100" style={{ fontSize: size < 70 ? 12 : 16 }}>
        {score}
      </span>
    </div>
  );
}
