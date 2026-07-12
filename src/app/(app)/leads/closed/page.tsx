import Link from "next/link";
import { prisma } from "@/lib/db";
import { reopenLead } from "@/app/actions/leads";
import { formatDate, formatZAR } from "@/lib/format";
import {
  getAccessibleLeadIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Won &amp; lost leads</h1>
        <Link href="/leads" className="btn-secondary">← Pipeline</Link>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr><th>Lead</th><th>Customer</th><th>Product</th><th>Value</th><th>Status</th><th>Closed</th><th /></tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">No accessible closed leads yet.</td></tr>
            )}
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link href={`/leads/${lead.id}`} className="font-medium text-orange-400 hover:underline">
                    {lead.title}
                  </Link>
                </td>
                <td>{lead.name}</td>
                <td>{lead.product?.name ?? "—"}{lead.color ? ` (${lead.color})` : ""}</td>
                <td>{formatZAR(lead.valueCents)}</td>
                <td>
                  <span className={`badge ${lead.status === "won" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                    {lead.status}
                  </span>
                  {lead.lostReason && <span className="text-xs text-slate-400 ml-2">{lead.lostReason}</span>}
                </td>
                <td className="text-slate-400">{formatDate(lead.updatedAt)}</td>
                <td>
                  {canReopen && (
                    <form action={reopenLead.bind(null, lead.id)}>
                      <button className="btn-secondary btn-sm">Reopen</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
