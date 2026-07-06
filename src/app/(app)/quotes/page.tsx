import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import ModalTrigger from "@/components/Modal";
import { createQuoteForContact } from "@/app/actions/quotes";
import { contactName, formatDate, formatZAR } from "@/lib/format";

const statusBadge: Record<string, string> = {
  draft: "bg-slate-800 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  accepted: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-red-500/15 text-red-300",
};

export default async function QuotesPage() {
  await requireUser();
  const [quotes, contacts, products] = await Promise.all([
    prisma.quote.findMany({
      orderBy: { createdAt: "desc" },
      include: { items: true, lead: true, contact: true, createdBy: true },
      take: 200,
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Quotes</h1>
          <p className="text-sm text-slate-400 mt-1">
            New quotes for existing customers start here; quotes for open deals start from the
            lead&apos;s page. Signing or accepting a quote wins its lead automatically.
          </p>
        </div>
        <ModalTrigger label="+ New quote" title="New quote for a customer">
          <form action={createQuoteForContact} className="card space-y-4">
            <div>
              <label className="label">Customer *</label>
              <select name="contactId" className="input" required defaultValue="">
                <option value="" disabled>
                  Select customer…
                </option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {contactName(c)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Product (optional — pre-fills the first line)</label>
              <select name="productId" className="input" defaultValue="">
                <option value="">— start empty —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatZAR(p.basePriceCents)})
                  </option>
                ))}
              </select>
            </div>
            <button className="btn-primary">Create quote</button>
          </form>
        </ModalTrigger>
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
