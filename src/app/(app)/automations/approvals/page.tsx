import Link from "next/link";
import { CheckCircle2, Clock3, ShieldQuestion, XCircle } from "lucide-react";
import { decideAutomationApproval } from "@/app/actions/automationPlatform";
import { PageHeader } from "@/components/page-header";
import { EmptyState, MetricCard } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { getActiveTenantId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/lib/permissions";
import { listTenantStaff } from "@/lib/tenantActor";

export const dynamic = "force-dynamic";

export default async function AutomationApprovalsPage() {
  const user = await requirePermission("journeys.manage");
  const tenantId = await getActiveTenantId();
  const [rows, staff] = await Promise.all([
    prisma.automationApprovalRequest.findMany({
      where: { tenantId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 250,
    }),
    listTenantStaff(),
  ]);
  const staffMap = new Map(staff.map((member) => [member.id, member.name]));
  const pending = rows.filter((row) => row.status === "pending");
  const approved = rows.filter((row) => row.status === "approved").length;
  const rejected = rows.filter((row) => row.status === "rejected").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Automation approvals" description="Review internal decisions requested by multi-step journeys before staff act on them." />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Clock3} label="Pending" value={pending.length} detail="Awaiting a decision" accent={pending.length > 0} />
        <MetricCard icon={CheckCircle2} label="Approved" value={approved} detail="Most recent 250 requests" />
        <MetricCard icon={XCircle} label="Rejected" value={rejected} detail="Most recent 250 requests" />
        <MetricCard icon={ShieldQuestion} label="Assigned to you" value={pending.filter((row) => !row.assignedToId || row.assignedToId === user.id).length} detail="Open decisions you can complete" />
      </section>

      {rows.length === 0 ? (
        <EmptyState icon={ShieldQuestion} title="No approval requests" description="Requests appear here when a journey reaches a Request internal approval step." />
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead><tr><th>Request</th><th>Linked record</th><th>Assigned to</th><th>Status</th><th>Created</th><th>Decision</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const canDecide = row.status === "pending" && (!row.assignedToId || row.assignedToId === user.id || user.role === "owner");
                const recordHref = row.leadId ? `/leads/${row.leadId}` : row.contactId ? `/contacts/${row.contactId}` : null;
                return (
                  <tr key={row.id}>
                    <td data-primary data-label="Request" className="min-w-72"><p className="font-medium">{row.title}</p>{row.description && <p className="mt-1 max-w-xl whitespace-pre-wrap text-xs text-muted-foreground">{row.description}</p>}{row.decisionNote && <p className="mt-1 text-xs text-muted-foreground">Decision note: {row.decisionNote}</p>}</td>
                    <td data-label="Linked record">{recordHref ? <Link href={recordHref} className="text-primary hover:underline">Open record</Link> : row.entityType ?? "System"}</td>
                    <td data-label="Assigned to">{row.assignedToId ? staffMap.get(row.assignedToId) ?? "Assigned user" : "Any automation manager"}</td>
                    <td data-label="Status"><span className={`badge ${row.status === "pending" ? "bg-amber-500/15 text-amber-300" : row.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{row.status}</span></td>
                    <td data-label="Created">{formatDateTime(row.createdAt)}</td>
                    <td data-actions className="min-w-64">
                      {canDecide ? (
                        <div className="space-y-2">
                          <form action={decideAutomationApproval.bind(null, row.id, "approved")} className="flex gap-2"><input name="note" className="input h-9" placeholder="Optional note" /><button className="btn-primary btn-sm">Approve</button></form>
                          <form action={decideAutomationApproval.bind(null, row.id, "rejected")} className="flex gap-2"><input name="note" className="input h-9" placeholder="Reason" required /><button className="btn-danger btn-sm">Reject</button></form>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">{row.status === "pending" ? "Assigned to another user" : `Decided ${row.decidedAt ? formatDateTime(row.decidedAt) : ""}`}</span>}
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
