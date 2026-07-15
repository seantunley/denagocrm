import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import { createQuoteForContact } from "@/app/actions/quotes";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import {
  getAccessibleContactIds,
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

const statusBadge: Record<string, string> = {
  draft: "bg-slate-800 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  accepted: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-red-500/15 text-red-300",
};

export default async function QuotesPage() {
  const user = await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const [quoteIds, contactIds, canCreate] = await Promise.all([
    getAccessibleQuoteIds(user),
    getAccessibleContactIds(user),
    hasPermission(user, "quotes.create"),
  ]);
  const [quotes, contacts, products] = await Promise.all([
    prisma.quote.findMany({
      where: {
        AND: [
          { supersededAt: null },
          ...(quoteIds === null ? [] : [{ id: { in: quoteIds } }]),
        ],
      },
      orderBy: { createdAt: "desc" },
      include: { items: true, lead: true, contact: true, createdBy: true },
      take: 200,
    }),
    canCreate
      ? prisma.contact.findMany({
          where: contactIds === null ? {} : { id: { in: contactIds } },
          orderBy: { firstName: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
    canCreate
      ? prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title="Quotes" description={`${quotes.length} accessible current quotes · Create, send and track customer proposals.`}>
        {canCreate && (
          <ModalTrigger label={<><Plus className="size-4" />New quote</>} title="New quote for a customer" buttonClass={buttonVariants({ size: "sm" })}>
            <form action={createQuoteForContact} className="card space-y-4">
              <div>
                <label className="label">Customer *</label>
                <select name="contactId" className="input" required defaultValue="">
                  <option value="" disabled>Select customer…</option>
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>{contactName(contact)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Product (optional — pre-fills the first line)</label>
                <select name="productId" className="input" defaultValue="">
                  <option value="">— start empty —</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({formatZAR(product.basePriceCents)})
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary">Create quote</button>
            </form>
          </ModalTrigger>
        )}
      </PageHeader>

      <ResponsiveEntityTable>
        <table className="table-base">
          <thead>
            <tr><th>#</th><th>Customer</th><th>Lead</th><th>Total</th><th>Status</th><th>Valid until</th><th>Created</th></tr>
          </thead>
          <tbody>
            {quotes.length === 0 && (
              <tr><td data-empty colSpan={7} className="text-center text-slate-400 py-8">No accessible quotes.</td></tr>
            )}
            {quotes.map((quote) => {
              const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
              return (
                <tr key={quote.id}>
                  <td data-primary data-label="Quote"><Link href={`/quotes/${quote.id}`} className="font-medium text-orange-400 hover:underline">Q-{quote.number}</Link></td>
                  <td data-label="Customer">
                    {quote.contact ? (
                      <Link href={`/contacts/${quote.contact.id}`} className="text-orange-400 hover:underline">{contactName(quote.contact)}</Link>
                    ) : quote.lead?.name ?? "—"}
                  </td>
                  <td data-label="Lead" className="max-w-56 truncate">
                    {quote.lead ? <Link href={`/leads/${quote.lead.id}`} className="text-orange-400 hover:underline">{quote.lead.title}</Link> : "—"}
                  </td>
                  <td data-label="Total" className="font-medium">{formatZAR(Math.round(total))}</td>
                  <td data-label="Status"><span className={`badge ${quote.supersededAt ? "bg-slate-800 text-slate-500" : statusBadge[quote.status] ?? statusBadge.draft}`}>{quote.supersededAt ? "superseded" : quote.status}</span></td>
                  <td data-label="Valid until" className="text-slate-400">{formatDate(quote.validUntil)}</td>
                  <td data-label="Created" className="text-slate-400">{formatDate(quote.createdAt)}{quote.createdBy ? ` · ${quote.createdBy.name}` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </div>
  );
}
