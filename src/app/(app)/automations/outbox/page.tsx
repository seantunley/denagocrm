import { AlertTriangle, CheckCircle2, Clock3, ListRestart, LockKeyhole } from "lucide-react";
import { cancelAutomationOutbox, retryAutomationOutbox } from "@/app/actions/automationPlatform";
import { PageHeader } from "@/components/page-header";
import { EmptyState, MetricCard } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { getActiveTenantId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const kindLabel: Record<string, string> = {
  "document.generate": "Generate document",
  "signing.create_request": "Create signing request",
  "xero.draft_invoice": "Create Xero draft invoice",
};

export default async function AutomationOutboxPage() {
  await requirePermission("journeys.manage");
  const tenantId = await getActiveTenantId();
  const rows = await prisma.automationOutbox.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const pending = rows.filter((row) => ["pending", "processing"].includes(row.status)).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const blocked = rows.filter((row) => row.status === "blocked").length;
  const completed = rows.filter((row) => row.status === "completed").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Automation action queue" description="Durable delivery and integration work. Failed actions remain visible and retryable instead of disappearing silently." />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Clock3} label="Pending" value={pending} detail="Queued or processing" />
        <MetricCard icon={CheckCircle2} label="Completed" value={completed} detail="Most recent 300 items" />
        <MetricCard icon={AlertTriangle} label="Failed" value={failed} detail="Needs attention" accent={failed > 0} />
        <MetricCard icon={LockKeyhole} label="Blocked" value={blocked} detail="Waiting for an integration" accent={blocked > 0} />
      </section>

      {rows.length === 0 ? (
        <EmptyState icon={ListRestart} title="The action queue is empty" description="Document, signing and Xero actions appear here when a Journey requests them." />
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead><tr><th>Action</th><th>Status</th><th>Attempts</th><th>Created</th><th>Result / error</th><th>Controls</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
                const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? payload.result as Record<string, unknown> : null;
                return (
                  <tr key={row.id}>
                    <td data-primary data-label="Action"><p className="font-medium">{kindLabel[row.kind] ?? row.kind.replaceAll("_", " ")}</p><p className="text-xs text-muted-foreground">{row.entityType ?? "System"}{row.entityId ? ` · ${row.entityId}` : ""}</p></td>
                    <td data-label="Status"><span className={`badge ${row.status === "completed" ? "bg-emerald-500/15 text-emerald-300" : row.status === "failed" ? "bg-red-500/15 text-red-300" : row.status === "blocked" ? "bg-amber-500/15 text-amber-300" : "bg-blue-500/15 text-blue-300"}`}>{row.status}</span></td>
                    <td data-label="Attempts">{row.attempts}</td>
                    <td data-label="Created">{formatDateTime(row.createdAt)}</td>
                    <td data-label="Result / error" className="max-w-xl"><p className="whitespace-pre-wrap text-xs text-muted-foreground">{row.error ?? (result ? JSON.stringify(result) : row.status === "completed" ? "Completed" : "Waiting")}</p></td>
                    <td data-actions className="min-w-64">
                      {new Set(["failed", "blocked"]).has(row.status) && (
                        <div className="space-y-2">
                          {row.kind !== "xero.draft_invoice" && <form action={retryAutomationOutbox.bind(null, row.id)}><button className="btn-secondary btn-sm w-full">Retry action</button></form>}
                          <form action={cancelAutomationOutbox.bind(null, row.id)} className="flex gap-2"><input name="reason" className="input h-9" placeholder="Cancellation reason" required /><button className="btn-danger btn-sm">Close</button></form>
                        </div>
                      )}
                      {row.kind === "xero.draft_invoice" && row.status === "blocked" && <p className="text-xs text-amber-300">Xero OAuth and tenant connection must be configured before this request can run.</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveEntityTable>
      )}
    </div>
  );
}
