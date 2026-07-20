import Link from "next/link";
import { requireAnyPermission } from "@/lib/permissions";
import AutoRefresh from "@/components/AutoRefresh";
import { listTickets } from "@/lib/helpdesk";
import { statusMeta } from "@/lib/helpdesk-constants";
import { StatusPill } from "@/components/visual-system";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Help desk — Denago Messages" };

export default async function MessagesCasesPage() {
  const user = await requireAnyPermission("cases.view_all", "cases.view_owned");
  const tickets = await listTickets(user, { folder: "open" });

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Help desk</h1>
        <p className="text-xs text-muted-foreground">
          {tickets.length} open {tickets.length === 1 ? "case" : "cases"}
        </p>
      </div>

      {tickets.length === 0 ? (
        <div className="card max-w-2xl text-sm text-slate-400">
          No open cases. New help desk tickets from customers appear here.
        </div>
      ) : (
        <div className="card max-w-3xl divide-y divide-slate-800 p-0">
          {tickets.map((t) => {
            const s = statusMeta(t.status);
            return (
              <Link
                key={t.id}
                href={`/cases/${t.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.subject}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    #{String(t.number)} · {t.contactName}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <StatusPill tone={s.tone}>{s.label}</StatusPill>
                  <p className="mt-0.5 text-[11px] text-slate-500">{formatDateTime(t.updatedAt)}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
