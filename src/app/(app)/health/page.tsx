import Link from "next/link";
import { Crown, Eye, HeartPulse, ShieldCheck, TriangleAlert, UserRoundSearch, type LucideIcon } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { bulkHealth } from "@/lib/healthData";
import { healthLabels, type HealthTier } from "@/lib/health";
import { PageHeader } from "@/components/page-header";
import {
  KpiGrid,
  MobileDataCard,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { EmptyState, MetricCard, SectionHeading, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

const healthTone: Record<HealthTier, "info" | "success" | "warning" | "danger"> = {
  vip: "info",
  healthy: "success",
  watch: "warning",
  at_risk: "danger",
};

function name(c: { firstName: string; lastName: string | null; company: string | null; isCompany: boolean }) {
  if (c.isCompany && c.company) return c.company;
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "—";
}

export default async function HealthPage() {
  // requireRoute returns the caller, and bulkHealth needs it: the route rule only
  // says "may see SOME contacts", so the dashboard has to be scoped to which ones.
  const user = await requireRoute("/health");
  const scored = await bulkHealth(user);

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

  const renderSection = ({
    title,
    rows,
    empty,
    icon: Icon,
  }: {
    title: string;
    rows: typeof scored;
    empty: string;
    icon: LucideIcon;
  }) => (
    <section className="space-y-3">
      <SectionHeading title={`${title} (${rows.length})`} />
      {rows.length === 0 ? (
        <EmptyState icon={Icon} title={empty} description="Customer health updates automatically as ownership, service, feedback and support activity changes." className="py-9" />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {rows.map((row) => (
                <MobileDataCard key={row.id}>
                  <MobileDataHeader
                    title={<Link href={`/contacts/${row.id}`} className="text-primary hover:underline">{name(row)}</Link>}
                    detail={row.health.reasons.slice(0, 3).join(" · ") || "No contributing signals recorded"}
                    aside={<StatusPill tone={healthTone[row.health.tier]}>Score {row.health.score}</StatusPill>}
                  />
                </MobileDataCard>
              ))}
            </MobileDataList>
          }
          desktop={
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
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/contacts/${s.id}`} className="text-orange-400 hover:underline font-medium">
                    {name(s)}
                  </Link>
                </td>
                <td className="text-right">
                  <StatusPill tone={healthTone[s.health.tier]}>{s.health.score}</StatusPill>
                </td>
                <td className="text-slate-400 text-xs">{s.health.reasons.slice(0, 3).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
              </table>
            </div>
          }
        />
      )}
    </section>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Customer health"
        description="A blended view of ownership, service recency, sentiment, referrals and open issues — prioritised for customer care."
      />

      <KpiGrid>
        <MetricCard icon={Crown} label={healthLabels.vip} value={counts.vip} detail="Highest-value relationships" />
        <MetricCard icon={ShieldCheck} label={healthLabels.healthy} value={counts.healthy} detail="Engaged and on track" />
        <MetricCard icon={Eye} label={healthLabels.watch} value={counts.watch} detail="Needs proactive attention" />
        <MetricCard icon={TriangleAlert} label={healthLabels.at_risk} value={counts.at_risk} detail="Prioritise win-back activity" accent={counts.at_risk > 0} />
      </KpiGrid>

      {renderSection({ title: "VIP customers", rows: vips, empty: "No VIP customers yet", icon: UserRoundSearch })}
      {renderSection({ title: "At risk — win these back", rows: atRisk, empty: "No customers are currently at risk", icon: HeartPulse })}
    </div>
  );
}
