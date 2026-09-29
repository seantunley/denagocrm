import { AlertTriangle, ServerCrash } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Errors that belong to NO workspace.
 *
 * ── WHY THIS PAGE HAD TO EXIST ──────────────────────────────────────────────
 *
 * `logError` records `tenantId: null` whenever it fires somewhere no tenant
 * resolves: cron sweeps, public webhook routes, the boot path, and anything
 * logged before ErrorLog gained the column. That is correct — inventing an
 * owner for a system-level failure would file it against a tenant that did not
 * cause it.
 *
 * But nothing could then SHOW them. Settings → System Log filters on the acting
 * tenant and deliberately excludes nulls, because a tenant cannot be told whose
 * an unattributed error is. Its own comment says these are "the platform
 * console's job" — and the console only ever listed errors per tenant. So a
 * production install could hold weeks of failures that every screen in the
 * product declined to display, while the security runbook counted them
 * install-wide and told the reader to go and look at a log that structurally
 * could not contain them. That is how 27 real errors sat behind an empty screen.
 *
 * This is the "somewhere" the runbook now points at.
 *
 * Grouped the same way the System Log groups: an identical error repeating two
 * hundred times is one line with a count, not two hundred lines, or a crash-loop
 * buries everything else that happened that week.
 */
const WINDOW_DAYS = 7;
/* DISPLAY ONLY — capped. The totals below are counted in the database so they
   stay correct past this cap; deriving them from the list would under-report
   during exactly the error storm worth knowing about. */
const MAX_ROWS = 500;

function signature(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 100);
}

export default async function PlatformSystemErrorsPage() {
  // Defence-in-depth: the (console) layout gates this route group, but re-check so
  // the queries below can never run without a platform session.
  await requirePlatformAdmin();

  const since = new Date(Date.now() - WINDOW_DAYS * 864e5);
  const [rows, total, attributed] = await Promise.all([
    basePrisma.errorLog.findMany({
      where: { tenantId: null, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: { id: true, scope: true, message: true, context: true, stack: true, createdAt: true },
    }),
    basePrisma.errorLog.count({ where: { tenantId: null, createdAt: { gte: since } } }),
    basePrisma.errorLog.count({ where: { tenantId: { not: null }, createdAt: { gte: since } } }),
  ]);

  const groups = (() => {
    const map = new Map<
      string,
      { scope: string; message: string; count: number; first: Date; last: Date; stack: string | null; context: string | null }
    >();
    for (const row of rows) {
      const key = `${row.scope}::${signature(row.message)}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          scope: row.scope,
          message: row.message,
          count: 1,
          first: row.createdAt,
          last: row.createdAt,
          stack: row.stack,
          context: row.context,
        });
      } else {
        existing.count += 1;
        if (row.createdAt < existing.first) existing.first = row.createdAt;
        if (row.createdAt > existing.last) existing.last = row.createdAt;
      }
    }
    return [...map.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
  })();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ServerCrash className="size-5 text-amber-400" />
          System errors
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Failures with no owning workspace — cron runs, webhooks, boot and anything logged
          before errors carried a tenant. A workspace&apos;s own errors stay in its Settings →
          System Log; these appear nowhere else in the product.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-3.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Unattributed · {WINDOW_DAYS} days</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{total}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-3.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Attributed to a workspace</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{attributed}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Shown in that workspace&apos;s System Log.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-3.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Distinct problems{total > MAX_ROWS ? " · displayed rows" : ""}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{groups.length}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {total > MAX_ROWS
              ? `Among the latest ${MAX_ROWS}; identical repeats collapsed.`
              : "Identical repeats collapsed."}
          </p>
        </div>
      </div>

      {total > MAX_ROWS && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="size-3.5 shrink-0" />
          Showing the most recent {MAX_ROWS} of {total}. Error totals are exact; the distinct-problem count covers only these displayed rows.
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No unattributed errors in the last {WINDOW_DAYS} days.
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <details key={`${group.scope}-${group.message.slice(0, 60)}`} className="rounded-xl border border-border bg-card p-3.5">
              <summary className="cursor-pointer list-none">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.scope}
                  </span>
                  {group.count > 1 && (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                      ×{group.count}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">{formatDateTime(group.last)}</span>
                </span>
                <span className="mt-1.5 block break-words text-sm text-foreground">{group.message}</span>
              </summary>
              <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
                {group.count > 1 && (
                  <p>
                    First seen {formatDateTime(group.first)} · last {formatDateTime(group.last)}
                  </p>
                )}
                {group.context && <p className="break-words">{group.context}</p>}
                {group.stack && (
                  <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2.5 text-[10px] leading-4 text-muted-foreground">
                    {group.stack}
                  </pre>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
