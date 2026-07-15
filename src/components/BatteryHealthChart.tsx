import { BATTERY } from "@/lib/battery";

// Pure SVG state-of-health trend with 80% / 60% threshold bands. Points are in
// chronological (oldest → newest) order.
export function BatteryHealthChart({ points }: { points: { soh: number }[] }) {
  if (points.length === 0) return null;
  const W = 320;
  const H = 120;
  const pad = 8;
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad));
  const y = (soh: number) => pad + (1 - Math.min(100, Math.max(0, soh)) / 100) * (H - 2 * pad);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.soh).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32" role="img" aria-label="Battery state-of-health trend">
      {/* threshold bands */}
      <rect x="0" y={y(100)} width={W} height={y(BATTERY.healthy) - y(100)} fill="rgba(16,185,129,0.07)" />
      <rect x="0" y={y(BATTERY.healthy)} width={W} height={y(BATTERY.warning) - y(BATTERY.healthy)} fill="rgba(245,158,11,0.07)" />
      <rect x="0" y={y(BATTERY.warning)} width={W} height={y(0) - y(BATTERY.warning)} fill="rgba(239,68,68,0.07)" />
      <line x1="0" y1={y(BATTERY.healthy)} x2={W} y2={y(BATTERY.healthy)} stroke="rgba(245,158,11,0.5)" strokeDasharray="3 3" strokeWidth="0.6" />
      <line x1="0" y1={y(BATTERY.warning)} x2={W} y2={y(BATTERY.warning)} stroke="rgba(239,68,68,0.5)" strokeDasharray="3 3" strokeWidth="0.6" />
      <path d={area} fill="rgba(234,88,12,0.12)" />
      <path d={line} fill="none" stroke="#ea580c" strokeWidth="1.6" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.soh)} r="1.8" fill="#ea580c" />
      ))}
    </svg>
  );
}
