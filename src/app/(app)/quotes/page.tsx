import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import ModalTrigger from "@/components/Modal";
import { createQuoteForContact } from "@/app/actions/quotes";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { MobileDataCard, MobileDataField, MobileDataFields, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";

export default async function QuotesPage() {
  await requireUser();
  const [quotes, contacts, products] = await Promise.all([
    prisma.quote.findMany({
      // Only the current head of each revision chain — old versions live in
      // the quote's Versions panel, not the list.
      where: { supersededAt: null },
      orderBy: { createdAt: "desc" },
      include: { items: true, lead: true, contact: true, createdBy: true },
      take: 200,
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title="Quotes" description={`${quotes.length} current quotes · Create, send and track every customer proposal.`}>
        <ModalTrigger label={<><Plus className="size-4" />New quote</>} title="New quote for a customer" buttonClass={buttonVariants({ size: "sm" })}>
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
      </PageHeader>

      {quotes.length === 0 ? (
        <EmptyState icon={FileText} title="No quotes yet" description="Create a quote for a customer or open lead to start tracking a proposal." />
      ) : (
      <ResponsiveDataView
        mobile={
          <MobileDataList>
            {quotes.map((q) => {
              const total = q.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
              return (
                <MobileDataCard key={q.id}>
                  <MobileDataHeader
                    title={<Link href={`/quotes/${q.id}`} className="text-primary hover:underline">Quote Q-{q.number}</Link>}
                    detail={q.contact ? contactName(q.contact) : q.lead?.name ?? "Unlinked quote"}
                    aside={<StatusPill tone={q.status === "accepted" ? "success" : q.status === "declined" ? "danger" : q.status === "sent" ? "info" : "neutral"}>{q.status}</StatusPill>}
                  />
                  <MobileDataFields>
                    <MobileDataField label="Total">{formatZAR(Math.round(total))}</MobileDataField>
                    <MobileDataField label="Valid until">{formatDate(q.validUntil)}</MobileDataField>
                    <MobileDataField label="Lead">{q.lead ? <Link href={`/leads/${q.lead.id}`} className="text-primary hover:underline">{q.lead.title}</Link> : "—"}</MobileDataField>
                    <MobileDataField label="Created">{formatDate(q.createdAt)}</MobileDataField>
                  </MobileDataFields>
                </MobileDataCard>
              );
            })}
          </MobileDataList>
        }
        desktop={
      <div className="card overflow-x-auto p-0">
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
                  <td><StatusPill tone={q.supersededAt ? "neutral" : q.status === "accepted" ? "success" : q.status === "declined" ? "danger" : q.status === "sent" ? "info" : "neutral"}>{q.supersededAt ? "superseded" : q.status}</StatusPill></td>
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
        }
      />
      )}
    </div>
  );
}
