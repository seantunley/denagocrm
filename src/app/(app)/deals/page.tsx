import Link from "next/link";
import { Briefcase } from "lucide-react";
import { requireRoute } from "@/lib/permissions";
import { loadDealsCentre } from "@/lib/dealsCentre";
import { DEALS_VIEWS, dealsView } from "@/lib/dealsCentreRules";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { financeStatusShort, financeTone } from "@/lib/dealFinanceRules";
import { pageWindow, parsePage } from "@/lib/listPaging";
import { getRegionalSettings } from "@/lib/settings";
import { withCurrency } from "@/lib/currencyRules";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import ListPager from "@/components/ListPager";

export const metadata = { title: "Deals" };

const statusTone = (status: string) =>
  status === "accepted" ? "success" : status === "declined" || status === "cancelled" ? "danger" : status === "sent" ? "info" : "neutral";

/**
 * The Deals Centre (brief §3): every quote you can see as a deal — its value,
 * what has come in, what is still owed and what is in the way. Each row opens the
 * deal page (/deals/[id]); nothing here is a record of its own.
 */
export default async function DealsPage({ searchParams }: { searchParams: Promise<{ show?: string; q?: string; page?: string }> }) {
  // The same door as the deal page: quotes.view_all or quotes.view_owned (ROUTE_RULES "/deals").
  const user = await requireRoute("/deals");
  const params = await searchParams;
  const view = dealsView(params.show, await isModuleEnabled("finance"));
  const q = params.q?.trim() || undefined;
  const [{ rows, totals, financeOn }, regional] = await Promise.all([loadDealsCentre(user, view, { q }), getRegionalSettings()]);
  const { page, skip, take } = pageWindow(parsePage(params.page), rows.length);
  const shown = rows.slice(skip, skip + take);
  const money = (cents: number, currency: string | null) => formatZAR(cents, withCurrency(regional, currency));
  const views = DEALS_VIEWS.filter((option) => option.key !== "finance" || financeOn);

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Briefcase className="size-5 text-primary" />
            Deals
          </span>
        }
        description="Every quote you can see as a deal: what it is worth, what has come in, what is still owed and what is in the way. Open a row for the full deal."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Deal views">
        {views.map((option) => (
          <Link
            key={option.key}
            href={`/deals?show=${option.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            title={option.hint}
            aria-current={view === option.key ? "page" : undefined}
            className={view === option.key ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      <form method="GET" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="show" value={view} />
        <input name="q" defaultValue={q ?? ""} className="input w-72" placeholder="Search quote number, customer or fleet" aria-label="Search deals" />
        <button className="btn-secondary btn-sm">Search</button>
        {q && <Link href={`/deals?show=${view}`} className="btn-secondary btn-sm">Clear</Link>}
      </form>

      {totals.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {totals.map((t) => (
            <div key={t.currency ?? "base"} className="card space-y-1 p-4 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.count} deal{t.count === 1 ? "" : "s"}{totals.length > 1 ? ` · ${t.currency ?? regional.currency}` : ""}
              </p>
              <p title="Accepted quotes: what has been sold.">Committed <span className="float-right font-semibold tabular-nums">{money(t.committed, t.currency)}</span></p>
              <p title="Money in against accepted deals: deposits and payments.">Received <span className="float-right tabular-nums">{money(t.received, t.currency)}</span></p>
              <p title="Still owed on accepted deals.">Owed <span className="float-right tabular-nums">{money(t.owed, t.currency)}</span></p>
              <p className="text-muted-foreground" title="Quotes sent and not accepted yet: on the table, not sold.">Proposed <span className="float-right tabular-nums">{money(t.proposed, t.currency)}</span></p>
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState icon={Briefcase} title="No deals in this view" description={views.find((option) => option.key === view)?.hint ?? ""} />
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead>
              <tr>
                <th>Deal</th>
                <th>Status</th>
                <th className="text-right">Value</th>
                <th className="text-right">Owed</th>
                {financeOn && <th>Finance</th>}
                <th>Delivery</th>
                <th>In the way</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/deals/${row.id}`} className="font-medium text-primary hover:underline">
                      {row.customer ? contactName(row.customer) : "No customer"}
                    </Link>
                    <p className="text-xs text-muted-foreground">Q-{row.number}{row.owner ? ` · ${row.owner}` : ""}</p>
                  </td>
                  <td><StatusPill tone={statusTone(row.status)}>{row.deliveredAt ? "delivered" : row.status}</StatusPill></td>
                  <td className="text-right tabular-nums">{money(row.totalCents, row.currency)}</td>
                  <td className="text-right tabular-nums">{row.status === "accepted" ? money(Math.max(0, row.balanceCents), row.currency) : "—"}</td>
                  {financeOn && (
                    <td>{row.financeStatus ? <StatusPill tone={financeTone(row.financeStatus)}>{financeStatusShort(row.financeStatus)}</StatusPill> : <span className="text-muted-foreground">—</span>}</td>
                  )}
                  <td className="text-sm text-muted-foreground">
                    {row.deliveredAt ? `Delivered ${formatDate(row.deliveredAt)}` : row.deliveryScheduledFor ? formatDate(row.deliveryScheduledFor) : "—"}
                  </td>
                  <td className="text-sm">
                    {row.ready ? (
                      <StatusPill tone="success">Ready for delivery</StatusPill>
                    ) : row.blockers.length ? (
                      <span className="text-amber-700 dark:text-amber-400">{row.blockers.join(" · ")}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager path="/deals" page={page} total={rows.length} className="border-t border-border" />
        </ResponsiveEntityTable>
      )}
    </div>
  );
}
