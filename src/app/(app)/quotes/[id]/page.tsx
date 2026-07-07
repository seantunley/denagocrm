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
  createQuoteRevision,
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

type FamilyQuote = {
  id: string;
  number: number;
  status: string;
  supersededAt: Date | null;
  declineReason: string | null;
  createdAt: Date;
  items: { qty: number; unitPriceCents: number }[];
};

/** All versions of a quote: walk up to the root, then collect descendants. */
async function getQuoteFamily(start: {
  id: string;
  revisionOfId: string | null;
}): Promise<FamilyQuote[]> {
  let rootId = start.id;
  let parentId = start.revisionOfId;
  while (parentId) {
    const parent = await prisma.quote.findUnique({
      where: { id: parentId },
      select: { id: true, revisionOfId: true },
    });
    if (!parent) break;
    rootId = parent.id;
    parentId = parent.revisionOfId;
  }
  const family: FamilyQuote[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const batch = await prisma.quote.findMany({
      where: { id: { in: frontier } },
      select: {
        id: true,
        number: true,
        status: true,
        supersededAt: true,
        declineReason: true,
        createdAt: true,
        items: { select: { qty: true, unitPriceCents: true } },
        revisions: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    family.push(...batch);
    frontier = batch.flatMap((q) => q.revisions.map((r) => r.id));
  }
  return family;
}

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const currentUser = await requireUser();
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      items: true,
      lead: true,
      contact: true,
      createdBy: true,
      revisions: { select: { id: true, number: true } },
    },
  });
  if (!quote) notFound();
  const family = await getQuoteFamily(quote);
  const successor = quote.revisions[0] ?? null;
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const lockedBySigning = Boolean(quote.signToken) && !quote.signedAt;
  const readOnly = Boolean(quote.signedAt || quote.supersededAt);
  const editable = quote.status === "draft" && !lockedBySigning && !readOnly;
  const canRevise = !readOnly && (quote.status === "sent" || quote.status === "declined");

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
          {canRevise && (
            <form action={createQuoteRevision.bind(null, quote.id)}>
              <button
                className="btn-primary"
                title="Copies this quote into a fresh editable draft; this version stays on record read-only."
              >
                ↻ Create revision
              </button>
            </form>
          )}
          {!readOnly && quote.status === "draft" && (
            <form action={setQuoteStatus.bind(null, quote.id, "sent")}>
              <button className="btn-primary">Mark sent</button>
            </form>
          )}
          {!readOnly && quote.status === "sent" && (
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
          {!readOnly && (quote.status === "accepted" || quote.status === "declined") && (
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

      {quote.supersededAt && (
        <div className="card bg-slate-800/60 border-slate-700">
          <p className="text-sm text-slate-300">
            📜 This is an old version, kept for the record — it was superseded on{" "}
            {formatDate(quote.supersededAt)}
            {successor && (
              <>
                {" "}by{" "}
                <Link href={`/quotes/${successor.id}`} className="text-orange-400 hover:underline font-medium">
                  Q-{successor.number}
                </Link>
              </>
            )}
            . It can be viewed and printed but not edited.
          </p>
        </div>
      )}

      {quote.changeRequestedAt && !quote.supersededAt && !quote.signedAt && (
        <div className="card bg-sky-500/10 border-sky-500/30 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-sky-300">
            ✏️ Customer requested changes on {formatDate(quote.changeRequestedAt)} —{" "}
            <span className="font-medium">“{quote.changeRequestNote}”</span>
          </p>
          <form action={createQuoteRevision.bind(null, quote.id)}>
            <button className="btn-primary btn-sm">↻ Create revision</button>
          </form>
        </div>
      )}

      {family.length > 1 && (
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
            Version history
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {family.map((f, idx) => {
              const fTotal = f.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
              const current = f.id === quote.id;
              return (
                <div key={f.id} className="flex items-center gap-2">
                  {idx > 0 && <span className="text-slate-600">→</span>}
                  <Link
                    href={`/quotes/${f.id}`}
                    className={`rounded-lg border px-3 py-2 text-xs leading-5 transition-colors ${
                      current
                        ? "border-orange-500 bg-orange-500/10"
                        : "border-slate-700 hover:border-slate-500"
                    }`}
                  >
                    <span className="font-semibold text-slate-200">Q-{f.number}</span>{" "}
                    <span className="text-slate-400">{formatZAR(Math.round(fTotal))}</span>{" "}
                    <span
                      className={`badge ${
                        f.supersededAt
                          ? "bg-slate-800 text-slate-400"
                          : statusBadge[f.status] ?? statusBadge.draft
                      }`}
                    >
                      {f.supersededAt ? "superseded" : f.status}
                    </span>
                    {f.declineReason && (
                      <span className="block text-slate-500 mt-0.5">“{f.declineReason}”</span>
                    )}
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {quote.status === "accepted" && quote.lead && !quote.signedAt && (
        <div className="card bg-emerald-500/10 border-emerald-500/30">
          <p className="text-sm text-emerald-300">
            🎉 Quote accepted — the lead was marked won automatically.
          </p>
        </div>
      )}

      {quote.status === "accepted" && !quote.supersededAt && (
        <div className="card py-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 mr-1">
            Fulfilment
          </span>
          {[
            { label: "Invoiced", at: quote.invoicedAt },
            { label: "Deposit paid", at: quote.depositPaidAt },
            {
              label: quote.deliveryScheduledFor
                ? `Delivery ${formatDate(quote.deliveryScheduledFor)}`
                : "Delivery scheduled",
              at: quote.deliveryScheduledFor,
            },
            { label: "Delivered", at: quote.deliveredAt },
          ].map((s, i) => (
            <span
              key={i}
              className={`badge ${
                s.at ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-500"
              }`}
            >
              {s.at ? "✓ " : ""}
              {s.label}
            </span>
          ))}
          {!quote.deliveredAt && (
            <Link href="/deliveries" className="text-xs text-orange-400 hover:underline ml-auto">
              Manage on the Deliveries board →
            </Link>
          )}
        </div>
      )}

      {!quote.supersededAt && (
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
        viewedAt={quote.viewedAt}
        declinedAt={quote.declinedAt}
        declineReason={quote.declineReason}
        signedPdfHash={quote.signedPdfHash}
      />
      )}

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

        {editable ? (
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
        ) : (
          <div className="card space-y-3">
            <h2 className="font-semibold">Quote details</h2>
            {lockedBySigning ? (
              <p className="text-xs text-slate-400">
                🔒 Locked while the signing link is active. Revoke the link in the signature card
                to edit this quote.
              </p>
            ) : quote.supersededAt ? (
              <p className="text-xs text-slate-400">📜 Old version — read-only.</p>
            ) : quote.signedAt ? (
              <p className="text-xs text-slate-400">✍ Signed — read-only.</p>
            ) : quote.status !== "draft" ? (
              <p className="text-xs text-slate-400">
                🔒 This version has been in front of the customer, so it can&apos;t be edited —
                use “↻ Create revision” to make changes.
              </p>
            ) : null}
            <div className="text-sm space-y-1.5">
              <p>
                <span className="text-slate-400">Valid until:</span>{" "}
                {quote.validUntil ? formatDate(quote.validUntil) : "—"}
              </p>
              {quote.terms && (
                <div>
                  <p className="text-slate-400 mb-1">Terms:</p>
                  <p className="text-xs text-slate-300 whitespace-pre-wrap">{quote.terms}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
