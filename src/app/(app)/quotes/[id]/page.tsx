import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  addQuoteItem,
  deleteQuoteItem,
  updateQuoteMeta,
  setQuoteStatus,
  deleteQuote,
} from "@/app/actions/quotes";
import ConfirmDelete from "@/components/ConfirmDelete";
import SigningBlock from "@/components/SigningBlock";
import { contactName, formatDate, formatZAR } from "@/lib/format";

const statusBadge: Record<string, string> = {
  draft: "bg-slate-800 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  accepted: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-red-500/15 text-red-300",
};

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const currentUser = await requireUser();
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, lead: true, contact: true, createdBy: true },
  });
  if (!quote) notFound();
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const editable = quote.status === "draft" || quote.status === "sent";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Quote Q-{quote.number}</h1>
            <span className={`badge ${statusBadge[quote.status] ?? statusBadge.draft}`}>
              {quote.status}
            </span>
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            {quote.contact && (
              <>
                <Link href={`/contacts/${quote.contact.id}`} className="text-orange-400 hover:underline">
                  {contactName(quote.contact)}
                </Link>
                {" · "}
              </>
            )}
            {quote.lead && (
              <>
                <Link href={`/leads/${quote.lead.id}`} className="text-orange-400 hover:underline">
                  {quote.lead.title}
                </Link>
                {" · "}
              </>
            )}
            created {formatDate(quote.createdAt)}
            {quote.createdBy ? ` by ${quote.createdBy.name}` : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={`/quotes/${quote.id}/print`} className="btn-secondary">
            🖨 Print / PDF
          </Link>
          {quote.status === "draft" && (
            <form action={setQuoteStatus.bind(null, quote.id, "sent")}>
              <button className="btn-primary">Mark sent</button>
            </form>
          )}
          {quote.status === "sent" && (
            <>
              <form action={setQuoteStatus.bind(null, quote.id, "accepted")}>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  ✓ Accepted
                </button>
              </form>
              <form action={setQuoteStatus.bind(null, quote.id, "declined")}>
                <button className="btn-secondary">Declined</button>
              </form>
            </>
          )}
          {(quote.status === "accepted" || quote.status === "declined") && (
            <form action={setQuoteStatus.bind(null, quote.id, "draft")}>
              <button className="btn-secondary">Back to draft</button>
            </form>
          )}
          <ConfirmDelete
            action={deleteQuote.bind(null, quote.id)}
            title={`Delete quote Q-${quote.number}?`}
            description="The quote moves to the Trash and can be restored for 60 days."
          />
        </div>
      </div>

      {quote.status === "accepted" && quote.lead && !quote.signedAt && (
        <div className="card bg-emerald-500/10 border-emerald-500/30">
          <p className="text-sm text-emerald-300">
            🎉 Quote accepted — the lead was marked won automatically.
          </p>
        </div>
      )}

      <SigningBlock
        kind="quote"
        id={quote.id}
        refLabel={`Q-${quote.number}`}
        signToken={quote.signToken}
        signedAt={quote.signedAt}
        signedByName={quote.signedByName}
        customerEmail={quote.contact?.email ?? quote.lead?.email}
        customerPhone={quote.contact?.whatsapp ?? quote.contact?.phone ?? quote.lead?.phone}
        dealerSignedAt={quote.dealerSignedAt}
        dealerSignedByName={quote.dealerSignedByName}
        hasSavedSignature={Boolean(currentUser.drawnSignatureRef)}
      />

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 card">
          <h2 className="font-semibold mb-4">Line items</h2>
          <table className="table-base mb-4">
            <thead>
              <tr>
                <th>Description</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Unit price</th>
                <th className="text-right">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {quote.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-4">
                    No items yet.
                  </td>
                </tr>
              )}
              {quote.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.description}</td>
                  <td className="text-right">{i.qty}</td>
                  <td className="text-right">{formatZAR(i.unitPriceCents)}</td>
                  <td className="text-right font-medium">
                    {formatZAR(Math.round(i.qty * i.unitPriceCents))}
                  </td>
                  <td className="text-right">
                    {editable && (
                      <ConfirmDelete
                        action={deleteQuoteItem.bind(null, i.id, quote.id)}
                        title={`Remove “${i.description}”?`}
                        description="This cannot be undone."
                        trigger="✕"
                        triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {editable && (
            <form
              action={addQuoteItem.bind(null, quote.id)}
              className="grid grid-cols-12 gap-2 items-end rounded-lg bg-slate-800/40 p-3 border border-slate-800"
            >
              <div className="col-span-6">
                <label className="label">Description</label>
                <input name="description" className="input" required placeholder="e.g. Denago EV Rover XL — Lava / Canopy / Delivery" />
              </div>
              <div className="col-span-1">
                <label className="label">Qty</label>
                <input name="qty" className="input" defaultValue="1" inputMode="decimal" />
              </div>
              <div className="col-span-3">
                <label className="label">Unit price (R)</label>
                <input name="unitPrice" className="input" inputMode="decimal" />
              </div>
              <div className="col-span-2">
                <button className="btn-primary w-full">Add</button>
              </div>
            </form>
          )}

          <div className="flex justify-end mt-4">
            <div className="w-64">
              <div className="flex justify-between border-t-2 border-slate-700 pt-2">
                <span className="font-semibold">Total (incl. VAT)</span>
                <span className="font-bold text-lg">{formatZAR(Math.round(total))}</span>
              </div>
            </div>
          </div>
        </div>

        <form action={updateQuoteMeta.bind(null, quote.id)} className="card space-y-4">
          <h2 className="font-semibold">Quote details</h2>
          <div>
            <label className="label">Valid until</label>
            <input
              type="date"
              name="validUntil"
              className="input"
              defaultValue={quote.validUntil ? quote.validUntil.toISOString().slice(0, 10) : ""}
            />
          </div>
          <div>
            <label className="label">Terms</label>
            <textarea name="terms" className="input" rows={5} defaultValue={quote.terms ?? ""} />
          </div>
          <button className="btn-secondary w-full">Save details</button>
        </form>
      </div>
    </div>
  );
}
