import Link from "next/link";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { setWorkDisposition } from "@/app/actions/myWork";
import { formatDate } from "@/lib/format";
import { workKey, type WorkItem } from "@/lib/myWork/rules";
import type { DoneItem, TeamRow } from "@/lib/myWork/extras";
import { CardEmpty } from "@/components/centre";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

/** My Work's other views: what I snoozed, what I finished today, and (owner) the team's load. */

export function SnoozedList({ items, regional }: { items: (WorkItem & { until: Date })[]; regional: Parameters<typeof formatDate>[1] }) {
  if (items.length === 0) return <CardEmpty>Nothing snoozed.</CardEmpty>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={workKey(item)} className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="min-w-0">
            <Link href={item.href} className="block truncate text-sm font-medium hover:underline">{item.title}</Link>
            <span className="text-xs text-muted-foreground">{item.area} · back {formatDate(item.until, regional)}</span>
          </span>
          <SaveForm action={setWorkDisposition} success="Back on your list" resetOnSuccess={false}>
            <input type="hidden" name="itemKey" value={workKey(item)} />
            <input type="hidden" name="choice" value="restore" />
            <SaveButton className="btn-secondary btn-sm">Bring back now</SaveButton>
          </SaveForm>
        </li>
      ))}
    </ul>
  );
}

export function DoneList({ items, time }: { items: DoneItem[]; time: Intl.DateTimeFormat }) {
  if (items.length === 0) return <CardEmpty>Nothing finished yet today.</CardEmpty>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={item.key}>
          <Link href={item.href} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">{item.area}</span>
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">{time.format(item.at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function TeamTable({ rows, feedback }: { rows: TeamRow[]; feedback?: { kind: string; dismissed: number; snoozed: number }[] | null }) {
  if (rows.length === 0) return <CardEmpty>No colleagues in this workspace.</CardEmpty>;
  return (
    <div className="space-y-4">
    <ResponsiveEntityTable>
      <table className="table-base">
        <thead>
          <tr>
            <th>Person</th>
            <th className="text-right" title="Planned activities past their time">Overdue</th>
            <th className="text-right" title="Planned activities still to do today">Due today</th>
            <th className="text-right" title="Open help desk cases assigned to them">Open cases</th>
            <th className="text-right" title="Open job cards where they are the technician">Open job cards</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="font-medium">{row.name}</td>
              <td className={`text-right tabular-nums ${row.overdue > 0 ? "text-red-600 dark:text-red-400" : ""}`}>{row.overdue}</td>
              <td className="text-right tabular-nums">{row.today}</td>
              <td className="text-right tabular-nums">{row.cases}</td>
              <td className="text-right tabular-nums">{row.jobs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveEntityTable>
    {feedback && (
      <div>
        <h3 className="text-sm font-semibold">How suggestions land — last 30 days</h3>
        <p className="mb-2 text-xs text-muted-foreground">How often people dismissed or snoozed each kind of item on their lists. Many dismissals of one kind means its rule is noisy.</p>
        {feedback.length === 0 ? (
          <CardEmpty>Nobody has dismissed or snoozed anything yet.</CardEmpty>
        ) : (
          <ResponsiveEntityTable>
            <table className="table-base">
              <thead><tr><th>Kind</th><th className="text-right">Dismissed</th><th className="text-right">Snoozed</th></tr></thead>
              <tbody>
                {feedback.map((row) => (
                  <tr key={row.kind}><td>{row.kind}</td><td className="text-right tabular-nums">{row.dismissed}</td><td className="text-right tabular-nums">{row.snoozed}</td></tr>
                ))}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        )}
      </div>
    )}
    </div>
  );
}
