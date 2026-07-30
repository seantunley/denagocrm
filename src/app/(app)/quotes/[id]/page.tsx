import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
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
import CustomFieldsCard from "@/components/custom-fields/CustomFieldsCard";
import QuoteVersions from "@/components/QuoteVersions";
import { uploadDeliveryPhotos } from "@/app/actions/fulfilment";
import { listBuilderTemplates } from "@/lib/docbuilder/store";
import { generateDocEditorDocument } from "@/app/actions/doceditor";
import SigningBlock from "@/components/SigningBlock";
import { activeRecordRequest, isLockedForSigning } from "@/lib/signing/record";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { isLineIncluded, lineNetCents, payableTotalCents, quotePricing } from "@/lib/pricing";
import { addQuoteFee, deleteQuoteFee, setQuoteDeposit, setQuoteTaxMode } from "@/app/actions/cpq";
import { isModuleEnabled } from "@/lib/modules/enabled";

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
  items: { qty: number; unitPriceCents: number; description: string; colorPreference: string | null; discountPct: number; taxRatePct: number }[];
  fees: { amountCents: number; taxRatePct: number }[];
  taxInclusive: boolean;
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
        items: { select: { qty: true, unitPriceCents: true, description: true, colorPreference: true, discountPct: true, taxRatePct: true } },
        // Each historical version is totalled the same way as the live quote.
        fees: { select: { amountCents: true, taxRatePct: true }, orderBy: { sortOrder: "asc" } },
        taxInclusive: true,
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
      fees: { orderBy: { sortOrder: "asc" } },
      lead: true,
      contact: true,
      createdBy: true,
      revisions: { select: { id: true, number: true } },
    },
  });
  if (!quote) notFound();
  const automotiveOn = await isModuleEnabled("automotive");
  const builderDocs = (await listBuilderTemplates()).filter((t) => t.key === "quote");
  const family = await getQuoteFamily(quote);
  const deliveryPhotos =
    quote.status === "accepted"
      ? await prisma.document.findMany({
          where: { quoteId: quote.id, tag: "delivery-photo", deletedAt: null },
          orderBy: { createdAt: "desc" },
        })
      : [];
  const successor = quote.revisions[0] ?? null;
  const pricing = quotePricing(quote.items, quote.fees, {
    taxInclusive: quote.taxInclusive,
    depositType: quote.depositType,
    depositValue: quote.depositValue,
  });
  const signingState = await activeRecordRequest({ quoteId: quote.id });
  const signWorkflows = await prisma.signWorkflow.findMany({ where: { isArchived: false }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" } });
  const lockedBySigning = (Boolean(quote.signToken) && !quote.signedAt) || isLockedForSigning(signingState);
  const readOnly = Boolean(quote.signedAt || quote.supersededAt);
  const editable = quote.status === "draft" && !lockedBySigning && !readOnly;
  const canRevise = !readOnly && (quote.status === "sent" || quote.status === "declined");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-[-0.035em]">Quote Q-{quote.number}</h1>
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
          {quote.status === "accepted" && (
            <>
              <Link href={`/quotes/${quote.id}/invoice`} className="btn-secondary" target="_blank">
                🧾 Invoice
              </Link>
              <Link href={`/quotes/${quote.id}/agreement`} className="btn-secondary" target="_blank">
                📜 Sales agreement
              </Link>
            </>
          )}
          {builderDocs.length > 0 && currentUser.role === "owner" && (
            <SaveForm resetOnSuccess={false} action={generateDocEditorDocument} className="flex items-center gap-1">
              <input type="hidden" name="quoteId" value={quote.id} />
              <select
                name="templateId"
                defaultValue={builderDocs[0].id}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                title="Builder template"
              >
                {builderDocs.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <SaveButton className="btn-secondary" title="Generate this builder document for the quote and file it in the repository">
                📄 Generate
              </SaveButton>
            </SaveForm>
          )}
          {canRevise && (
            <SaveForm
              success="Revision created"
              resetOnSuccess={false}
              action={createQuoteRevision.bind(null, quote.id)}
            >
              <SaveButton
                pendingLabel="Creating revision…"
                className="btn-primary"
                title="Copies this quote into a fresh editable draft; this version stays on record read-only."
              >
                ↻ Create revision
              </SaveButton>
            </SaveForm>
          )}
          {!readOnly && quote.status === "draft" && (
            <SaveForm success="Quote status updated" resetOnSuccess={false} action={setQuoteStatus.bind(null, quote.id, "sent")}>
              <SaveButton className="btn-primary">Mark sent</SaveButton>
            </SaveForm>
          )}
          {!readOnly && quote.status === "sent" && (
            <>
              <SaveForm success="Quote status updated" resetOnSuccess={false} action={setQuoteStatus.bind(null, quote.id, "accepted")}>
                <SaveButton className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  ✓ Accepted
                </SaveButton>
              </SaveForm>
              <SaveForm success="Quote status updated" resetOnSuccess={false} action={setQuoteStatus.bind(null, quote.id, "declined")}>
                <SaveButton className="btn-secondary">Declined</SaveButton>
              </SaveForm>
            </>
          )}
          {!readOnly && (quote.status === "accepted" || quote.status === "declined") && (
            <SaveForm success="Quote status updated" resetOnSuccess={false} action={setQuoteStatus.bind(null, quote.id, "draft")}>
              <SaveButton className="btn-secondary">Back to draft</SaveButton>
            </SaveForm>
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
          <SaveForm success="Revision created" resetOnSuccess={false} action={createQuoteRevision.bind(null, quote.id)}>
            <SaveButton className="btn-primary btn-sm">↻ Create revision</SaveButton>
          </SaveForm>
        </div>
      )}

      {family.length > 1 && (
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
            Version history
          </p>
          <QuoteVersions
            currentId={quote.id}
            versions={family.map((f) => ({
              id: f.id,
              number: f.number,
              status: f.status,
              superseded: Boolean(f.supersededAt),
              createdAt: formatDate(f.createdAt),
              declineReason: f.declineReason,
              totalZAR: formatZAR(payableTotalCents(f)),
              items: f.items.map((i) => ({
                qty: i.qty,
                description: i.description,
                colorPreference: i.colorPreference,
                priceZAR: formatZAR(lineNetCents(i)),
              })),
            }))}
          />
        </div>
      )}

      {quote.status === "accepted" && quote.lead && !quote.signedAt && (
        <div className="card bg-emerald-500/10 border-emerald-500/30">
          <p className="text-sm text-emerald-300">
            🎉 Quote accepted — the lead was marked won automatically.
          </p>
        </div>
      )}

      {automotiveOn && quote.status === "accepted" && !quote.supersededAt && (
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
          {automotiveOn && !quote.deliveredAt && (
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
        signedAt={quote.signedAt}
        signedByName={quote.signedByName}
        signedPdfHash={quote.signedPdfHash}
        dealerSignedAt={quote.dealerSignedAt}
        dealerSignedByName={quote.dealerSignedByName}
        hasSavedSignature={Boolean(currentUser.drawnSignatureRef)}
        state={signingState}
        workflows={signWorkflows}
      />
      )}

      {automotiveOn && quote.status === "accepted" && !quote.supersededAt && (
        <div className="card">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div>
              <h2 className="font-semibold">📷 Delivery photos</h2>
              <p className="text-xs text-slate-400">
                The happy handover — filed on the customer and this quote.
              </p>
            </div>
            {/* No `success` prop: the action returns a count-aware message
                ("3 photos uploaded — 1 skipped"), which takes precedence anyway,
                so a hardcoded one here would only be misleading to read. */}
            <SaveForm
              action={uploadDeliveryPhotos.bind(null, quote.id)}
              className="flex items-center gap-2"
            >
              <input
                type="file"
                name="files"
                multiple
                required
                accept="image/*"
                capture="environment"
                className="block text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
              />
              <button className="btn-primary btn-sm">Upload</button>
            </SaveForm>
          </div>
          {deliveryPhotos.length === 0 ? (
            <p className="text-xs text-slate-500">No photos yet.</p>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {deliveryPhotos.map((d) => (
                <a key={d.id} href={d.storedName} target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={d.storedName}
                    alt={d.fileName}
                    className="h-24 w-24 object-cover rounded-lg border border-slate-700 hover:border-orange-500 transition-colors"
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 card min-w-0">
          <h2 className="font-semibold mb-4">Line items</h2>
          <div className="overflow-x-auto">
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
                <tr key={i.id} className={isLineIncluded(i) ? "" : "text-muted-foreground"}>
                  <td>
                    <span className="block">{i.description}</span>
                    {i.colorPreference && <span className="mt-1 block text-xs text-muted-foreground">Colour preference: {i.colorPreference}</span>}
                    {/* Staff need to see what was offered, so an unselected
                        option stays listed here — but without a line total, so
                        the amounts still add up to the quote total above. The
                        printed documents drop it entirely. */}
                    {!isLineIncluded(i) && (
                      <span className="mt-1 block text-xs">Optional — not selected</span>
                    )}
                  </td>
                  <td className="text-right">{i.qty}</td>
                  <td className="text-right">{formatZAR(i.unitPriceCents)}</td>
                  <td className="text-right font-medium">
                    {isLineIncluded(i) ? formatZAR(lineNetCents(i)) : "—"}
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
          </div>

          {editable && (
            <SaveForm
              success="Item added"
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
                <SaveButton pendingLabel="Adding…" className="btn-primary w-full">Add</SaveButton>
              </div>
            </SaveForm>
          )}

          <div className="flex justify-end mt-4">
            <div className="w-72 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Subtotal (excl. VAT)</span><span className="tabular-nums">{formatZAR(pricing.netCents)}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">VAT</span><span className="tabular-nums">{formatZAR(pricing.taxCents)}</span></div>
              {pricing.feesTotalCents > 0 && (
                <div className="flex justify-between"><span className="text-slate-400">Fees &amp; delivery (incl.)</span><span className="tabular-nums">{formatZAR(pricing.feesTotalCents)}</span></div>
              )}
              <div className="flex justify-between border-t-2 border-slate-700 pt-2">
                <span className="font-semibold">Total (incl. VAT)</span>
                <span className="font-bold text-lg tabular-nums">{formatZAR(pricing.totalCents)}</span>
              </div>
              {pricing.depositCents > 0 && (
                <>
                  <div className="flex justify-between"><span className="text-slate-400">Deposit</span><span className="tabular-nums">{formatZAR(pricing.depositCents)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Balance on delivery</span><span className="tabular-nums">{formatZAR(pricing.balanceCents)}</span></div>
                </>
              )}
              {pricing.costCents > 0 && (
                <div className="flex justify-between border-t border-slate-800 pt-1 text-xs">
                  <span className="text-slate-500">Margin</span>
                  <span className={`tabular-nums ${pricing.marginPct < 0 ? "text-red-400" : "text-slate-400"}`}>{formatZAR(pricing.marginCents)} · {pricing.marginPct}%</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/*
          The BREAKDOWN renders whether or not the quote is still editable.
          Gating the whole card on `editable` meant that the moment a quote was
          sent or signed, the fee list vanished and the totals showed only a
          rolled-up "Fees & delivery" figure — so nobody could see what the
          customer had actually been charged for. Only the controls need the
          gate; reading what was agreed is not editing.
        */}
        {(editable || quote.fees.length > 0) && (
          <div className="card space-y-4">
            <h2 className="font-semibold">Fees, delivery &amp; deposit</h2>
            {quote.fees.length > 0 && (
              <div className="divide-y divide-border text-sm">
                {quote.fees.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate text-muted-foreground"><span className="capitalize">{f.kind}</span> · {f.label}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="tabular-nums">{formatZAR(f.amountCents)}</span>
                      {editable && (
                        <SaveForm success="Fee removed" resetOnSuccess={false} action={deleteQuoteFee.bind(null, f.id, quote.id)}><SaveButton className="text-xs text-slate-600 hover:text-red-500">✕</SaveButton></SaveForm>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!editable && (
              <p className="text-xs text-muted-foreground">
                This quote is locked — showing what was agreed.
              </p>
            )}
            {editable && (<>
            <SaveForm success="Fee added" action={addQuoteFee.bind(null, quote.id)} className="flex flex-wrap items-end gap-2">
              <select name="kind" defaultValue="fee" className="input w-28"><option value="fee">Fee</option><option value="delivery">Delivery</option></select>
              <input name="label" required placeholder="Label (e.g. Delivery to Cape Town)" className="input flex-1 min-w-40" />
              <input name="amount" inputMode="decimal" placeholder="Amount R" className="input w-28 tabular-nums" />
              <input name="taxRatePct" inputMode="decimal" defaultValue="15" placeholder="VAT %" className="input w-20 tabular-nums" title="VAT %" />
              <SaveButton className="btn-secondary btn-sm">Add</SaveButton>
            </SaveForm>
            <div className="grid gap-3 sm:grid-cols-2">
              <SaveForm success="Deposit updated" resetOnSuccess={false} action={setQuoteDeposit.bind(null, quote.id)} className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="depositType">Deposit</label>
                  <select id="depositType" name="depositType" defaultValue={quote.depositType ?? ""} className="input">
                    <option value="">No deposit</option>
                    <option value="percent">Percent of total</option>
                    <option value="amount">Fixed amount</option>
                  </select>
                </div>
                <input name="depositValue" inputMode="decimal" defaultValue={quote.depositValue ?? ""} placeholder="% or R" className="input w-24 tabular-nums" />
                <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
              </SaveForm>
              <SaveForm success="Tax mode updated" resetOnSuccess={false} action={setQuoteTaxMode.bind(null, quote.id)} className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="taxInclusive">Pricing basis</label>
                  <select id="taxInclusive" name="taxInclusive" defaultValue={quote.taxInclusive ? "true" : "false"} className="input">
                    <option value="true">Prices include VAT</option>
                    <option value="false">Add VAT on top</option>
                  </select>
                </div>
                <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
              </SaveForm>
            </div>
            </>)}
          </div>
        )}

        {editable ? (
          <SaveForm success="Quote updated" resetOnSuccess={false} action={updateQuoteMeta.bind(null, quote.id)} className="card space-y-4">
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
            <SaveButton className="btn-secondary w-full">Save details</SaveButton>
          </SaveForm>
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

      <CustomFieldsCard entity="quote" recordId={quote.id} readOnly={!editable} />
    </div>
  );
}
