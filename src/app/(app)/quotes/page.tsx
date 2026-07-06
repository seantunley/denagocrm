import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatDate, formatZAR } from "@/lib/format";

const statusBadge: Record<string, string> = {
  draft: "bg-slate-800 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  accepted: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-red-500/15 text-red-300",
};

export default async function QuotesPage() {
  await requireUser();
  const quotes = await prisma.quote.findMany({
    orderBy: { createdAt: "desc" },
    include: { items: true, lead: true, contact: true, createdBy: true },
    take: 200,
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Quotes</h1>
        <p className="text-sm text-slate-400 mt-1">
          Create quotes from a lead&apos;s page — the “Create quote” button pre-fills the model
          and price. Accepting a quote wins its lead automatically.
        </p>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              <th>Customer</th>
              <th>Lead</th>
              <th>Total</th>
              <th>Status</th>
              <th>Valid until</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {quotes.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  No quotes yet — open a lead and click “Create quote”.
                </td>
              </tr>
            )}
            {quotes.map((q) => {
              const total = q.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
              return (
                <tr key={q.id}>
                  <td>
                    <Link href={`/quotes/${q.id}`} className="font-medium text-orange-400 hover:underline">
                      Q-{q.number}
                    </Link>
                  </td>
                  <td>
                    {q.contact ? (
                      <Link href={`/contacts/${q.contact.id}`} className="text-orange-400 hover:underline">
                        {contactName(q.contact)}
                      </Link>
                    ) : (
                      q.lead?.name ?? "—"
                    )}
                  </td>
                  <td className="max-w-56 truncate">
                    {q.lead ? (
                      <Link href={`/leads/${q.lead.id}`} className="text-orange-400 hover:underline">
                        {q.lead.title}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="font-medium">{formatZAR(Math.round(total))}</td>
                  <td>
                    <span className={`badge ${statusBadge[q.status] ?? statusBadge.draft}`}>
                      {q.status}
                    </span>
                  </td>
                  <td className="text-slate-400">{formatDate(q.validUntil)}</td>
                  <td className="text-slate-400">
                    {formatDate(q.createdAt)}
                    {q.createdBy ? ` · ${q.createdBy.name}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
