import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ActionRefusal } from "@/lib/actionFailure";
import { contactName } from "@/lib/format";
import { includedLines } from "@/lib/pricing";
import { getRegionalSettings } from "@/lib/settings";
import { loadBillToFleet } from "@/lib/quoteBillTo";
import { deliveryHandoverReadiness } from "@/lib/checklists/deliveryHandover";
import { deliveryNoteContext } from "@/lib/docbuilder/deliveryServiceContext";
import { buildQuoteContext, type MergeContext } from "@/lib/docbuilder/merge";
import type { DocumentModel } from "@/lib/doceditor/model";
import { deliveryTemplateForScreen } from "@/lib/doceditor/standardTemplates";
import { builderLayoutFor, handoverRuns, loadDeliveryEvidence } from "@/lib/deliveryServicePrint";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { staffActor } from "@/lib/signing/events";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { DELIVERY_NOTE } from "@/lib/signing/subject";
import {
  openSubjectRequest,
  recordSubjectWithdrawn,
  signedByCustomerOnly,
  subjectSigningState,
  withdrawOpenSubjectRequests,
  type SubjectSigningState,
} from "@/lib/signing/subjectRequests";

/**
 * The delivery note, signed by the customer on a screen at handover.
 *
 * The customer used to sign a box drawn inside the CRM's own delivery form: a
 * picture of a signature, filed beside a note that was re-drawn from the live
 * record every time it was opened. Here the note is a signature request ABOUT
 * the delivery (signing/subject.ts) — the customer reads the note itself on a
 * screen with nothing else on it, and what they signed is sealed, with a
 * certificate naming the member of staff who handed the vehicle over.
 *
 * WHAT THIS DOES NOT DO is deliver. Marking the quote delivered moves stock and
 * makes the customer's vehicles behind gates only staff can answer for
 * (lib/quoteDelivery.ts). That stays the delivery screen's own step, taken once
 * the customer has signed — with this signature, and the checklist runs frozen
 * into the note they signed, as its evidence ({@link signedDeliveryNote}).
 */

/** What the customer is signing for, as the handover screen gathered it. */
export type HandoverFacts = {
  deliveredByName: string;
  /** The completed guided-checklist runs reviewed with the customer. Empty where no guided handover is set up. */
  runIds: string[];
  /** Where no guided handover is set up: the ticks on the built-in list. */
  checklist: Record<string, boolean> | null;
};

const noteOf = (quoteId: string) => ({ type: DELIVERY_NOTE, id: quoteId });

export function deliveryNoteState(quoteId: string): Promise<SubjectSigningState> {
  return subjectSigningState(noteOf(quoteId));
}

/**
 * Withdraw a delivery note that was opened and never signed — the delivery was
 * completed some other way. Inside the caller's transaction, after it holds the
 * quote row. One with a signature on it is left alone.
 */
export function withdrawOpenDeliveryNote(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  quote: { id: string; tenantId: string | null },
): Promise<string[]> {
  return withdrawOpenSubjectRequests(tx, noteOf(quote.id), quote.tenantId);
}

export function recordDeliveryNoteWithdrawn(requestIds: string[], actor: string, reason: string): Promise<void> {
  return recordSubjectWithdrawn(requestIds, actor, "delivery", reason);
}

/**
 * THE RUNS THE CUSTOMER ACTUALLY REVIEWED — VERIFIED, NOT RE-DERIVED.
 *
 * A delivery checklist is repeatable, so "the newest completed run per
 * template" is an answer that changes. The screen asks once, shows the customer
 * the note for those runs, and hands the same ids here. They arrive through the
 * browser, so they are checked rather than trusted — and what the check permits
 * is only this quote's own completed runs, one for every active template. The
 * choice space is exactly the set of legitimate answers.
 *
 * What comes back is then FROZEN into the note the customer signs, which is
 * what makes "the checklist they signed beside" a fact: the delivery is
 * recorded against the runs in the signed note, not against whatever the form
 * says later.
 *
 * `guided: false` when the workspace has no active delivery checklist — the
 * built-in list is used instead, and no run ids apply.
 */
export async function reviewedHandoverRuns(
  tenantId: string,
  quoteId: string,
  claimedRunIds: readonly string[],
): Promise<{ guided: boolean; runIds: string[] }> {
  const templates = await prisma.checklistTemplate.findMany({
    where: { tenantId, host: "quote.delivery", active: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (templates.length === 0) return { guided: false, runIds: [] };

  const runs = await prisma.checklistRun.findMany({
    where: { tenantId, hostType: "quote.delivery", hostId: quoteId, templateId: { in: templates.map((template) => template.id) } },
    select: { id: true, templateId: true, completedAt: true },
    orderBy: { completedAt: "desc" },
  });
  const readiness = deliveryHandoverReadiness(templates, runs);
  if (!readiness.ready) {
    const missing = templates.filter((template) => readiness.missingTemplateIds.includes(template.id)).map((template) => template.name);
    throw new ActionRefusal(
      missing.length === 1
        ? `Finish “${missing[0]}” before the customer signs.`
        : `Finish the guided handover checklists before the customer signs: ${missing.join(", ")}.`,
    );
  }

  const CHANGED = "The delivery note has changed since it was reviewed. Reload it and review it again before signing.";
  const claimed = [...new Set(claimedRunIds)];
  if (claimed.length === 0) throw new ActionRefusal("Reload the delivery note and review it again before signing.");
  const completedById = new Map(runs.filter((run) => run.completedAt).map((run) => [run.id, run]));
  const seenTemplates = new Set<string>();
  for (const id of claimed) {
    const run = completedById.get(id);
    // Not in the map means: not this quote's, not this tenant's, not against an
    // active delivery template, or not finished. All of them are "no".
    // One run per template, or the note would show a template twice and the
    // signature would cover an ambiguous document.
    if (!run || seenTemplates.has(run.templateId)) throw new ActionRefusal(CHANGED);
    seenTemplates.add(run.templateId);
  }
  // Every active template must be covered, so a short list cannot get a
  // signature against a partial handover.
  if (templates.some((template) => !seenTemplates.has(template.id))) throw new ActionRefusal(CHANGED);
  return { guided: true, runIds: claimed };
}

function handoverFactsOf(contextJson: unknown): HandoverFacts | null {
  const delivery = (contextJson as { vars?: { delivery?: unknown } } | null)?.vars?.delivery;
  if (!delivery || typeof delivery !== "object") return null;
  const { driver, runIds, checklist } = delivery as { driver?: unknown; runIds?: unknown; checklist?: unknown };
  if (typeof driver !== "string" || !Array.isArray(runIds) || !runIds.every((id) => typeof id === "string")) return null;
  return {
    deliveredByName: driver,
    runIds,
    checklist: checklist && typeof checklist === "object" && !Array.isArray(checklist) ? (checklist as Record<string, boolean>) : null,
  };
}

export type SignedDeliveryNote = HandoverFacts & {
  requestId: string;
  signedByName: string;
  /** The customer's drawn signature, as stored when they signed. */
  signatureRef: string | null;
};

/**
 * The newest delivery note for a quote that is still standing: completed, or
 * live — never one that was declined, withdrawn or rejected.
 *
 * The tenant and `deletedAt` are written into the query, not left to the scoped
 * client: the delivery asks this through its own transaction, and there is no
 * scoped client inside one.
 */
const newestNoteStanding = (quoteId: string, tenantId: string) =>
  ({
    where: {
      subjectType: DELIVERY_NOTE,
      subjectId: quoteId,
      tenantId,
      deletedAt: null,
      OR: [{ status: "completed" }, { status: { notIn: [...CLOSED_REQUEST_STATUSES] } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contextJson: true,
      recipients: { where: { role: { not: "viewer" } }, select: { name: true, signedName: true, signatureRef: true, status: true } },
    },
  }) satisfies Prisma.SignatureRequestFindFirstArgs;

/**
 * The delivery note the customer has signed for this quote, with what was
 * frozen into it — or null.
 *
 * "Signed" here is the customer's signature, whether or not the document has
 * finished being sealed: sealing takes seconds and is retried on its own, and a
 * delivery must not wait at the kerb for it.
 *
 * THE NEWEST NOTE DECIDES, signed or not. If a new note was opened after the
 * customer signed an earlier one, the handover changed and that earlier
 * signature is for something else: there is no signed note until they sign the
 * new one (subjectSigningState tells the screen the same thing).
 *
 * This is the SERVER'S answer. Completing a delivery reads its evidence from
 * here — who handed over, which checklist runs, whose signature — and never
 * from what the browser posts beside it (lib/quoteDelivery.ts, which asks a
 * second time through its own transaction once it holds the quote's row).
 */
export async function signedDeliveryNote(
  quoteId: string,
  tenantId: string,
  /** The delivery's own transaction, when the answer has to hold under the quote's lock. */
  tx?: Prisma.TransactionClient,
): Promise<SignedDeliveryNote | null> {
  // One question, asked of the scoped client or of that transaction.
  const newest = await (tx
    ? tx.signatureRequest.findFirst(newestNoteStanding(quoteId, tenantId))
    : prisma.signatureRequest.findFirst(newestNoteStanding(quoteId, tenantId)));
  const signer = newest?.recipients.find((recipient) => recipient.status === "signed");
  const facts = newest && signer ? handoverFactsOf(newest.contextJson) : null;
  if (!newest || !signer || !facts) return null;
  return { ...facts, requestId: newest.id, signedByName: signer.signedName || signer.name || "the customer", signatureRef: signer.signatureRef ?? null };
}

/**
 * Make the delivery note for a quote and leave it waiting for the customer.
 *
 * The caller has decided this person may manage the delivery, and has had the
 * handover verified ({@link reviewedHandoverRuns}). Refusals come back as
 * messages for the delivery screen.
 */
export async function prepareDeliveryNote(
  input: { quoteId: string; tenantId: string; user: { id: string; name: string; email?: string | null }; facts: HandoverFacts },
  /** The unsigned PDF. It is rendered by a browser process, so the database test brings its own. */
  toPdf: (doc: DocumentModel, context: MergeContext, tenantId: string) => Promise<Buffer> = (doc, context, tenantId) =>
    renderEnvelopePdf(doc, null, null, { context, tenantId }),
): Promise<{ requestId: string; replaced: string[] }> {
  const { quoteId, tenantId, user, facts } = input;
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, lead: { include: { product: true, contact: true } }, contact: true, createdBy: true },
  });
  if (!quote) throw new ActionRefusal("This quote is no longer available in this workspace.");
  if (quote.deliveredAt) throw new ActionRefusal("This delivery is already marked as delivered.");
  if (!quote.deliveryScheduledFor) throw new ActionRefusal("Schedule the delivery on the Deliveries board before the customer signs for it.");

  // Who receives it: the quote's customer, or the lead's when the quote was made
  // straight from a lead. They type their own name when they sign.
  const person = quote.contact ?? quote.lead?.contact ?? null;
  const customer = {
    name: person ? contactName(person) : quote.lead?.name ?? "Customer",
    email: person?.email ?? quote.lead?.email ?? null,
    phone: person?.phone ?? quote.lead?.phone ?? null,
  };

  // The workspace's own delivery note once it has PUBLISHED one (the same switch
  // as the printed note), otherwise the standard one.
  const layout = (await builderLayoutFor("delivery")) ?? deliveryTemplateForScreen();
  const title = `Delivery note DN-${quote.number}`;
  layout.title = title;
  const signable = signedByCustomerOnly(layout, { staff: { name: user.name, email: user.email ?? null }, customer });
  if ("alsoAsks" in signable) {
    throw new ActionRefusal(
      `Your delivery note layout also asks for a signature from “${signable.alsoAsks}”. Signing on this device collects the customer's only — ` +
        "remove that signature block in Document Studio. Who handed the vehicle over is recorded on the note and on its certificate.",
    );
  }

  // The note's values, as they are NOW, to be frozen with the request. The
  // quote's own tokens only: the company's are frozen separately as the brand.
  const regional = await getRegionalSettings();
  const record = { ...buildQuoteContext(quote, await loadBillToFleet(prisma, quote.fleetId), regional), regional };
  const { guidedRunsForNote } = await loadDeliveryEvidence(
    { id: quote.id, tenantId: quote.tenantId, deliveryHandoverRunIds: [], deliverySignatureRef: null },
    facts.runIds.join(","),
  );
  // The note must show exactly the runs that were reviewed — the same ones, not
  // merely as many: asked for runs it cannot find, the loader falls back to the
  // newest per checklist, which is a different note.
  const shown = new Set(guidedRunsForNote.map((run) => run.id));
  if (facts.runIds.length > 0 && (shown.size !== facts.runIds.length || !facts.runIds.every((id) => shown.has(id)))) {
    throw new ActionRefusal("The delivery note has changed since it was reviewed. Reload it and review it again before signing.");
  }
  // Photos stay as references to the stored files; the signing renderer embeds
  // them when it draws the note (signing/render.ts).
  const runs = await handoverRuns(facts.runIds.length > 0 ? guidedRunsForNote : [], facts.checklist, regional, (url) => url);
  const ctx = deliveryNoteContext(record, {
    quoteNumber: quote.number,
    // The customer is signing for receipt, now.
    deliveredAt: new Date(),
    deliveryScheduledFor: quote.deliveryScheduledFor,
    deliveredByName: facts.deliveredByName,
    lineCount: includedLines(quote.items).length,
    handover: { runs, signature: null, signedOn: null },
  });
  const context: MergeContext = {
    tokens: ctx.tokens,
    items: ctx.items,
    // What completing the delivery will read back: who, and against which runs.
    vars: { ...ctx.vars, delivery: { ...(ctx.vars.delivery as object), runIds: facts.runIds, checklist: facts.checklist } },
  };

  const outcome = await openSubjectRequest({
    subject: noteOf(quoteId),
    tenantId,
    // The quote row is the mutex: taken first here, first by completion
    // (lockSubject) and first by the delivery itself.
    holdRecord: async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const live = await tx.quote.findFirst({
        where: { id: quoteId, tenantId, deletedAt: null },
        select: { status: true, deliveredAt: true, supersededAt: true, deliveryScheduledFor: true },
      });
      return Boolean(live && live.status === "accepted" && !live.deliveredAt && !live.supersededAt && live.deliveryScheduledFor);
    },
    doc: signable.doc,
    title,
    context,
    contactId: person?.id ?? null,
    createdById: user.id,
    pdf: await toPdf(signable.doc, context, tenantId),
    // A note the customer signed earlier does not stop a new one: until the
    // delivery is completed the handover can still change (a checklist redone,
    // another added), and the delivery is recorded against the newest note they
    // signed. The earlier one stays filed — it was signed.
    again: true,
  });
  if (outcome === "signed" || outcome === "gone") {
    throw new ActionRefusal("This delivery changed while the note was being prepared — refresh and try again.");
  }
  await recordDeliveryNoteWithdrawn(outcome.replaced, await staffActor(user.name, tenantId), "Replaced by a new delivery note").catch(() => {});
  return outcome;
}
