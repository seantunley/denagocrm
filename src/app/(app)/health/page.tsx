import Link from "next/link";
import { requireCrm } from "@/lib/auth";
import { bulkHealth } from "@/lib/healthData";
import { healthColors, healthLabels, type HealthTier } from "@/lib/health";

export const dynamic = "force-dynamic";

function name(c: { firstName: string; lastName: string | null; company: string | null; isCompany: boolean }) {
  if (c.isCompany && c.company) return c.company;
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "—";
}

export default async function HealthPage() {
  await requireCrm();
  const scored = await bulkHealth();

  const counts: Record<HealthTier, number> = { vip: 0, healthy: 0, watch: 0, at_risk: 0 };
  for (const s of scored) counts[s.health.tier] += 1;

  const vips = scored
    .filter((s) => s.health.tier === "vip")
    .sort((a, b) => b.health.score - a.health.score)
    .slice(0, 50);
  const atRisk = scored
    .filter((s) => s.health.tier === "at_risk")
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, 50);

  const Section = ({
    title,
    rows,
    empty,
  }: {
    title: string;
    rows: typeof scored;
    empty: string;
  }) => (
    <section className="space-y-3">
      <h2 className="font-semibold">
        {title} ({rows.length})
      </h2>
      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="text-right">Score</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-6">
                  {empty}
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/contacts/${s.id}`} className="text-orange-400 hover:underline font-medium">
                    {name(s)}
                  </Link>
                </td>
                <td className="text-right">
                  <span className={`badge ${healthColors[s.health.tier]}`}>{s.health.score}</span>
                </td>
                <td className="text-slate-400 text-xs">{s.health.reasons.slice(0, 3).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Customer health</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          A blended score from ownership, service recency, survey sentiment, referrals and open
          issues — so you know who to look after and who to win back.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["vip", "healthy", "watch", "at_risk"] as HealthTier[]).map((t) => (
          <div key={t} className="card">
            <p className="text-xs uppercase tracking-wide text-slate-400">{healthLabels[t]}</p>
            <p className="text-3xl font-bold mt-1">{counts[t]}</p>
          </div>
        ))}
      </div>

      <Section title="⭐ VIPs" rows={vips} empty="No VIPs yet." />
      <Section title="⚠️ At risk — win these back" rows={atRisk} empty="Nobody at risk. 🎉" />
    </div>
  );
}
