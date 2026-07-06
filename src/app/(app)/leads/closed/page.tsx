import Link from "next/link";
import { prisma } from "@/lib/db";
import { reopenLead } from "@/app/actions/leads";
import { formatDate, formatZAR } from "@/lib/format";

export default async function ClosedLeadsPage() {
  const leads = await prisma.lead.findMany({
    where: { status: { in: ["won", "lost"] } },
    orderBy: { updatedAt: "desc" },
    include: { product: true, contact: true },
    take: 200,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Won &amp; lost leads</h1>
        <Link href="/leads" className="btn-secondary">
          ← Pipeline
        </Link>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Customer</th>
              <th>Product</th>
              <th>Value</th>
              <th>Status</th>
              <th>Closed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  No closed leads yet.
                </td>
              </tr>
            )}
            {leads.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/leads/${l.id}`} className="font-medium text-orange-400 hover:underline">
                    {l.title}
                  </Link>
                </td>
                <td>{l.name}</td>
                <td>
                  {l.product?.name ?? "—"}
                  {l.color ? ` (${l.color})` : ""}
                </td>
                <td>{formatZAR(l.valueCents)}</td>
                <td>
                  <span
                    className={`badge ${
                      l.status === "won"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-red-500/15 text-red-300"
                    }`}
                  >
                    {l.status}
                  </span>
                  {l.lostReason && (
                    <span className="text-xs text-slate-400 ml-2">{l.lostReason}</span>
                  )}
                </td>
                <td className="text-slate-400">{formatDate(l.updatedAt)}</td>
                <td>
                  <form action={reopenLead.bind(null, l.id)}>
                    <button className="btn-secondary btn-sm">Reopen</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
