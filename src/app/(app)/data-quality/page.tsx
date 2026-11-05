import Link from "next/link";
import { requireRoute } from "@/lib/permissions";
import { loadDataQuality } from "@/lib/dataQuality";
import { CONTACT_CHECKS, DEAL_CHECKS } from "@/lib/dataQualityRules";
import { contactName } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

const tone = (score: number) => (score >= 90 ? "text-emerald-400" : score >= 70 ? "text-amber-400" : "text-red-400");

/**
 * DATA QUALITY CENTRE: how complete and consistent the customer and deal records you can open are — missing details,
 * conflicting data, possible duplicates, where records came from — and, for whoever sees the whole workspace, whether
 * it's getting better. Every problem links to the record to fix it.
 */
export default async function DataQualityPage() {
  const user = await requireRoute("/data-quality");
  const q = await loadDataQuality(user);

  const card = (label: string, value: number, detail: string) => (
    <div className="card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${tone(value)}`}>{value}%</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );

  const checkRow = (key: string, label: string, why: string, rows: { id: string; label: string; href: string }[]) => (
    <details key={key} className="group py-2">
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <span className={`w-14 text-right text-sm font-semibold tabular-nums ${rows.length ? "text-amber-400" : "text-emerald-400"}`}>{rows.length}</span>
        <span className="text-sm font-medium">{label}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{why}</span>
      </summary>
      {rows.length > 0 && (
        <ul className="ml-[4.25rem] mt-2 space-y-1 text-sm">
          {rows.slice(0, 50).map((row) => <li key={row.id}><Link href={row.href} className="text-primary hover:underline">{row.label}</Link></li>)}
          {rows.length > 50 && <li className="text-xs text-muted-foreground">…and {rows.length - 50} more.</li>}
        </ul>
      )}
    </details>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data quality"
        description={`How complete and consistent the ${q.wholeWorkspace ? "workspace's" : "your"} customer and deal records are. Open a check to see the records and fix them.`}
      >
        <Link href="/duplicates" className="btn-secondary btn-sm">Duplicates</Link>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        {card("Overall", q.score, `${q.contacts} customers · ${q.deals} deals`)}
        {card("Customers", q.contactScore, "with no problem found")}
        {card("Deals", q.dealScore, "with no problem found")}
      </div>

      {q.trend.length > 1 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold">Over time</h2>
          <div className="mt-3 flex h-20 items-end gap-1" role="img" aria-label={`Overall score over the last ${q.trend.length} days, from ${q.trend[0].score}% to ${q.trend[q.trend.length - 1].score}%`}>
            {q.trend.map((t) => (
              <div key={t.day} className="flex-1 rounded-t bg-primary/60" style={{ height: `${Math.max(4, t.score)}%` }} title={`${t.day}: ${t.score}%`} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{q.trend[0].day} → {q.trend[q.trend.length - 1].day}: {q.trend[0].score}% → {q.trend[q.trend.length - 1].score}%. Recorded once a day, the first time someone who sees the whole workspace opens this page.</p>
        </div>
      )}

      <div className="card p-4">
        <h2 className="text-sm font-semibold">Customers</h2>
        <div className="mt-2 divide-y divide-border">
          {CONTACT_CHECKS.map((check) =>
            checkRow(`c-${check.key}`, check.label, check.why, q.contactProblems[check.key].map((c) => ({ id: c.id, label: contactName(c), href: `/contacts/${c.id}/edit` }))),
          )}
          <div className="flex items-center gap-3 py-2">
            <span className={`w-14 text-right text-sm font-semibold tabular-nums ${q.duplicateGroups ? "text-amber-400" : "text-emerald-400"}`}>{q.duplicateGroups}</span>
            <span className="text-sm font-medium">Possible duplicates</span>
            <Link href="/duplicates" className="text-xs text-primary hover:underline">Review and merge →</Link>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="text-sm font-semibold">Deals</h2>
        <div className="mt-2 divide-y divide-border">
          {DEAL_CHECKS.map((check) =>
            checkRow(`d-${check.key}`, check.label, check.why, q.dealProblems[check.key].map((d) => ({ id: d.id, label: d.title || d.name, href: `/leads/${d.id}` }))),
          )}
        </div>
      </div>

      <div className="card p-4">
        <h2 className="text-sm font-semibold">Where customers came from</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {q.sources.map((s) => (
            <li key={s.source} className="flex items-center gap-3">
              <span className="w-14 text-right tabular-nums">{s.count}</span>
              <span className={s.source === "Unknown" ? "text-amber-400" : ""}>{s.source}</span>
            </li>
          ))}
        </ul>
      </div>
      {q.truncated && <p className="text-xs text-muted-foreground">Only the newest 20,000 customers and deals were checked.</p>}
    </div>
  );
}
