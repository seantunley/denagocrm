import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { prisma } from "@/lib/db";
import { reopenLead } from "@/app/actions/leads";
import { formatDate, formatZAR } from "@/lib/format";
import {
  getAccessibleLeadIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { PageHeader } from "@/components/page-header";

export default async function ClosedLeadsPage() {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const [accessibleIds, canReopen] = await Promise.all([
    getAccessibleLeadIds(user),
    hasPermission(user, "leads.reopen"),
  ]);
  const leads = await prisma.lead.findMany({
    where: {
      status: { in: ["won", "lost"] },
      ...(accessibleIds ? { id: { in: accessibleIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { product: true, contact: true },
    take: 200,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Won & lost leads"
        description="Review completed opportunities and reopen work that needs another pass."
      >
        <Link href="/leads" className="btn-secondary">
          Back to pipeline
        </Link>
      </PageHeader>

      <ResponsiveEntityTable>
        <table className="table-base">
          <thead>
            <tr><th>Lead</th><th>Customer</th><th>Product</th><th>Value</th><th>Status</th><th>Closed</th><th /></tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td data-empty colSpan={7} className="text-center text-slate-400 py-8">No accessible closed leads yet.</td></tr>
            )}
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td data-primary data-label="Lead">
                  <Link href={`/leads/${lead.id}`} className="font-medium text-orange-400 hover:underline">
                    {lead.title}
                  </Link>
                </td>
                <td data-label="Customer">{lead.name}</td>
                <td data-label="Product">{lead.product?.name ?? "—"}{lead.color ? ` (${lead.color})` : ""}</td>
                <td data-label="Value">{formatZAR(lead.valueCents)}</td>
                <td data-label="Status">
                  <span className={`badge ${lead.status === "won" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                    {lead.status}
                  </span>
                  {lead.lostReason && <span className="text-xs text-slate-400 ml-2">{lead.lostReason}</span>}
                </td>
                <td data-label="Closed" className="text-slate-400">{formatDate(lead.updatedAt)}</td>
                <td data-actions>
                  {canReopen && (
                    <SaveForm success="Lead reopened" resetOnSuccess={false} action={reopenLead.bind(null, lead.id)}>
                      <SaveButton className="btn-secondary btn-sm">Reopen</SaveButton>
                    </SaveForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </div>
  );
}
