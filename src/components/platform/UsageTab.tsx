"use client";

import { useEffect, useState } from "react";
import { loadTenantUsage, type TenantUsage } from "@/app/actions/platformUsage";
import { formatBytes } from "@/lib/tenantUsageFormat";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

/**
 * The Usage tab.
 *
 * A CLIENT component that fetches on mount, rather than a server component
 * rendered with the rest of the profile. The distinction matters: the tab strip
 * keeps every panel mounted so in-progress form input survives a switch, which
 * means a server-rendered panel is rendered whether or not anybody looks at it.
 * A Suspense boundary made that non-blocking but not optional — the storage
 * estimate (one COUNT per sampled table, the most expensive query in the
 * console) still ran on every profile visit.
 *
 * Paired with `lazy` on the tab, this component is not mounted until the tab is
 * first opened, so the scan happens only when someone asks for it. After that it
 * stays mounted, and a short-lived server-side cache (see lib/tenantUsage.ts)
 * keeps repeat visits from re-scanning.
 */
export default function UsageTab({ tenantId }: { tenantId: string }) {
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    loadTenantUsage(tenantId)
      .then((result) => {
        if (live) setUsage(result);
      })
      .catch(() => {
        if (live) setError("Could not work out this tenant's usage.");
      });
    return () => {
      live = false;
    };
  }, [tenantId]);

  if (error) {
    return <p className="card p-5 text-sm text-muted-foreground">{error}</p>;
  }

  if (!usage) {
    return <p className="card p-5 text-sm text-muted-foreground">Estimating storage…</p>;
  }

  const { storage, activity } = usage;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Estimated database storage</h3>
          <p className="text-2xl font-semibold tabular-nums">{formatBytes(storage.estimatedBytes)}</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          An <strong>estimate</strong>, not a measurement. Postgres reports size per table,
          never per tenant, so each table&apos;s real on-disk size is apportioned by this
          tenant&apos;s share of its rows. A tenant whose records carry large text will use
          more than its row share suggests; index and dead-tuple overhead is included.
        </p>

        {storage.breakdown.length > 0 && (
          <ResponsiveEntityTable className="mt-4 rounded-none border-0 bg-transparent">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 font-semibold">Table</th>
                  <th className="py-2 text-right font-semibold">Rows</th>
                  <th className="py-2 text-right font-semibold">Share</th>
                  <th className="py-2 text-right font-semibold">Est. size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {storage.breakdown.map((row) => (
                  <tr key={row.table}>
                    <td data-primary data-label="Table" className="py-2 font-mono text-xs">
                      {row.table}
                    </td>
                    <td data-label="Rows" className="py-2 text-right tabular-nums">{row.rows}</td>
                    <td data-label="Share" className="py-2 text-right tabular-nums text-muted-foreground">
                      {row.sharePct}%
                    </td>
                    <td data-label="Est. size" className="py-2 text-right tabular-nums">
                      {formatBytes(row.bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        )}

        {storage.tablesOmitted > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground/80">
            {storage.tablesOmitted} smaller tenant-scoped table
            {storage.tablesOmitted === 1 ? " was" : "s were"} not sampled — the tail contributes
            little and would cost a query each.
          </p>
        )}
      </div>

      <div className="card p-5">
        <h3 className="font-semibold">Activity, last 30 days</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          <strong>Request traffic and bandwidth are not recorded anywhere in this
          application</strong>, so they cannot be estimated from the database — inventing a
          figure would be worse than saying so. These are business activity counts, which is
          usually the underlying question.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {[
            { label: "Messages", value: activity.communications30d },
            { label: "Leads created", value: activity.leadsCreated30d },
            { label: "Contacts created", value: activity.contactsCreated30d },
            { label: "Activities", value: activity.activities30d },
            { label: "Audited changes", value: activity.auditEvents30d },
            { label: "Sign-ins", value: activity.sessions30d },
          ].map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
