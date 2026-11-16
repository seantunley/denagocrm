import Link from "next/link";
import { Landmark } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { loadFinanceDeals } from "@/lib/dealFinance";
import { financeStatusShort, financeTone } from "@/lib/dealFinanceRules";
import { getRegionalSettings } from "@/lib/settings";
import { withCurrency } from "@/lib/currencyRules";
import { formatDate, formatZAR } from "@/lib/format";
import { WorkspaceHero } from "@/components/workspace-hero";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { StatusPill } from "@/components/visual-system";

export const metadata = { title: "Finance" };

/**
 * Every financed deal this person may open, and where each stands with its finance house (Sean, 2026-11-16).
 * Waiting too long comes first, then by how long the status has stood. "All" adds paid-out, withdrawn and lost ones.
 */
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const user = await requireRoute("/finance");
  await requireModuleEnabled("finance");
  const all = (await searchParams).show === "all";
  const now = new Date();
  const deals = (await loadFinanceDeals(user, now, { active: !all }))
    .sort((a, b) => Number(Boolean(b.chase)) - Number(Boolean(a.chase)) || a.statusAt.getTime() - b.statusAt.getTime());
  const regional = await getRegionalSettings();
  const toChase = deals.filter((deal) => deal.chase).length;

  return (
    <div className="space-y-4">
      <WorkspaceHero
        icon={Landmark}
        eyebrow="Sales"
        title="Finance"
        description="Every financed deal and where it stands with the finance house. A status waiting on the customer or the finance house for 3 working days is flagged to chase."
        stats={[{ label: "To chase", value: toChase }, { label: all ? "Deals" : "In progress", value: deals.length }]}
        actions={
          <div className="flex gap-2">
            <Link href="/finance" className={all ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>In progress</Link>
            <Link href="/finance?show=all" className={all ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>All</Link>
          </div>
        }
      />
      {deals.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No financed deals{all ? "" : " in progress"}. Start one from a lead&apos;s Finance tab.
        </p>
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Finance house</th>
                <th>Status</th>
                <th>Since</th>
                <th>Owner</th>
                <th className="text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((deal) => (
                <tr key={deal.id}>
                  <td>
                    <Link href={`/leads/${deal.leadId}?tab=finance`} className="font-medium hover:text-primary">{deal.name}</Link>
                    {deal.leadStatus !== "open" && <span className="ml-2 text-xs text-muted-foreground">{deal.leadStatus}</span>}
                    {deal.chase && <p className="mt-0.5 text-xs text-amber-300">{deal.chase.actionLabel}</p>}
                  </td>
                  <td>{deal.financeHouse}{deal.reference && <span className="block text-xs text-muted-foreground">{deal.reference}</span>}</td>
                  <td><StatusPill tone={financeTone(deal.status)}>{financeStatusShort(deal.status)}</StatusPill></td>
                  <td className="whitespace-nowrap">{formatDate(deal.statusAt)}</td>
                  <td>{deal.ownerName ?? "Unassigned"}</td>
                  <td className="text-right tabular-nums">{formatZAR(deal.valueCents, withCurrency(regional, deal.currency))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveEntityTable>
      )}
    </div>
  );
}
