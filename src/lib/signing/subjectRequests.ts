import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { saveFile, deleteFile } from "@/lib/storage";
import type { MergeContext } from "@/lib/docbuilder/merge";
import type { DocumentModel } from "@/lib/doceditor/model";
import { ensureSignable } from "./autoEnvelope";
import { logSignEvent } from "./events";
import { createSignatureRequestFromDoc } from "./service";
import { recipientLabel, resolvePartyRecipients } from "./templateRecipients";
import { CLOSED_REQUEST_STATUSES } from "./status";
import type { RequestSubject } from "./subject";

/**
 * The requests ABOUT one record (signing/subject.ts) — a test drive's
 * indemnity, a delivery's note — and the rules they share.
 *
 * ONE LIVE REQUEST PER RECORD. A document signed in person is made when the
 * member of staff presses the button and carries the record's details as they
 * were at that moment, so starting again replaces what was opened. What has a
 * signature on it is never replaced and never withdrawn: it is on its way to
 * being sealed, and nothing that happens to the record afterwards un-signs it.
 *
 * The record's own row is the mutex. Whoever starts, withdraws or completes
 * takes it first and the requests second, so none of them can interleave.
 */

/** Where a record's document stands, as far as signing on a screen goes. */
export type SubjectSigningState =
  | { kind: "none" }
  /** Opened and waiting for the signer. */
  | { kind: "open"; requestId: string; recipientId: string; startedAt: Date }
  /** Signed; the document is being sealed and filed. */
  | { kind: "finishing"; requestId: string; signedByName: string }
  | { kind: "signed"; requestId: string; signedByName: string; signedAt: Date };

const OPEN = { notIn: [...CLOSED_REQUEST_STATUSES] };

/**
 * THE NEWEST ONE DECIDES. Where a record can be signed for again (a delivery
 * note, while the delivery is still to be completed), a note opened after an
 * earlier one was signed is what the record is now waiting on — the earlier
 * signature is for a handover that has since changed.
 *
 * Through the workspace-scoped client: another workspace asking about the same
 * id sees nothing.
 */
export async function subjectSigningState(subject: RequestSubject): Promise<SubjectSigningState> {
  const current = await prisma.signatureRequest.findFirst({
    where: {
      subjectType: subject.type,
      subjectId: subject.id,
      deletedAt: null,
      // Signed and sealed, or still live — never one that was withdrawn,
      // declined, expired or rejected.
      OR: [{ status: "completed" }, { status: OPEN }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      completedAt: true,
      recipients: {
        where: { role: { not: "viewer" } },
        orderBy: { order: "asc" },
        select: { id: true, name: true, signedName: true, signedAt: true, status: true },
      },
    },
  });
  if (!current) return { kind: "none" };
  const signer = current.recipients.find((recipient) => recipient.status === "signed");
  const signedByName = signer?.signedName || signer?.name || "the signer";
  if (current.status === "completed") {
    return { kind: "signed", requestId: current.id, signedByName, signedAt: signer?.signedAt ?? current.completedAt ?? current.createdAt };
  }
  const waiting = current.recipients.find((recipient) => recipient.status !== "signed" && recipient.status !== "declined");
  if (waiting) return { kind: "open", requestId: current.id, recipientId: waiting.id, startedAt: current.createdAt };
  // Everyone has signed and it is not completed yet: sealing takes a few
  // seconds, and is retried in the background if it fails.
  return signer ? { kind: "finishing", requestId: current.id, signedByName } : { kind: "none" };
}

type RawTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Hold every request about this record, so a signature being submitted right
 * now has either landed or not by the next statement.
 *
 * The signing route locks the request row while it records a signature. A
 * statement that started before that commit would still see "nobody has signed"
 * for the signer's row, and withdraw a document the signer had just signed. So:
 * take the rows first, and only then ask.
 */
export async function holdSubjectRequests(tx: RawTx, subject: RequestSubject, tenantId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT r."id" FROM "SignatureRequest" r
     WHERE r."subjectType" = ${subject.type} AND r."subjectId" = ${subject.id} AND r."tenantId" = ${tenantId}
       FOR UPDATE
  `;
}

/**
 * Is there one with a signature on it — completed, or signed and still being
 * sealed? Ask inside the transaction, after {@link holdSubjectRequests}.
 */
export async function subjectIsSigned(tx: Prisma.TransactionClient, subject: RequestSubject, tenantId: string): Promise<boolean> {
  const signed = await tx.signatureRequest.findFirst({
    where: {
      subjectType: subject.type,
      subjectId: subject.id,
      tenantId,
      OR: [{ status: "completed" }, { status: OPEN, recipients: { some: { status: "signed" } } }],
    },
    select: { id: true },
  });
  return signed !== null;
}

/**
 * Withdraw what was opened for this record and never signed — when a new one
 * replaces it, or the thing it was for is called off. Run inside the caller's
 * transaction, AFTER it holds the record's own row.
 *
 * Raw SQL so the base client's transaction and the workspace-scoped one both
 * fit. Returns the ids, for {@link recordSubjectWithdrawn} once committed.
 */
export async function withdrawOpenSubjectRequests(tx: RawTx, subject: RequestSubject, tenantId: string | null): Promise<string[]> {
  if (!tenantId) return [];
  await holdSubjectRequests(tx, subject, tenantId);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "SignatureRequest" r
       SET "status" = 'voided', "updatedAt" = NOW()
     WHERE r."subjectType" = ${subject.type}
       AND r."subjectId" = ${subject.id}
       AND r."tenantId" = ${tenantId}
       AND r."status" NOT IN (${Prisma.join([...CLOSED_REQUEST_STATUSES])})
       AND NOT EXISTS (
         SELECT 1 FROM "SignatureRecipient" s WHERE s."requestId" = r."id" AND s."status" = 'signed'
       )
    RETURNING r."id"
  `;
  return rows.map((row) => row.id);
}

/** The evidence entry for each request {@link withdrawOpenSubjectRequests} closed. `via` names the door: "test_drive", "delivery". */
export async function recordSubjectWithdrawn(requestIds: string[], actor: string, via: string, reason: string): Promise<void> {
  for (const requestId of requestIds) {
    await logSignEvent(requestId, { type: "voided", actor, metadata: { via, reason } });
  }
}

/**
 * A document signed in person has ONE signer: the customer the device is handed
 * to. The layout's parties are filled in — the customer from the record, "our
 * team" as whoever is running it — and a signature box is added for the
 * customer when the layout draws none (the engine's own page for signatures).
 *
 * A layout that ALSO asks someone else to sign is not made signable here: the
 * request would wait for ever on a signature this screen never collects. Its
 * label comes back instead, for the caller to refuse in its own words.
 */
export function signedByCustomerOnly(
  layout: DocumentModel,
  people: { staff: { name: string; email: string | null }; customer: { name: string; email: string | null; phone: string | null } },
): { doc: DocumentModel } | { alsoAsks: string } {
  resolvePartyRecipients(layout, { denago: people.staff, customer: people.customer });
  const someoneElse = layout.recipients.find((recipient) => recipient.role !== "viewer" && recipient.party !== "customer");
  if (someoneElse) return { alsoAsks: recipientLabel(someoneElse) };
  return { doc: ensureSignable(layout, people.customer) };
}

/** `gone`: the record can no longer be signed for. `signed`: it already has been. */
export type OpenSubjectOutcome = { requestId: string; replaced: string[] } | "gone" | "signed";

/**
 * Make the request for a record and leave it waiting for its signer, replacing
 * any that was opened and not signed.
 *
 * The caller has built the document and frozen the record's values, and has
 * rendered the unsigned PDF — BEFORE this, like a quote's: a PDF render must
 * not hold a row lock. `holdRecord` locks the record's own row (first in the
 * transaction, the order completion takes) and says whether it can still be
 * signed for.
 */
export async function openSubjectRequest(opts: {
  subject: RequestSubject;
  tenantId: string;
  holdRecord: (tx: Prisma.TransactionClient) => Promise<boolean>;
  doc: DocumentModel;
  title: string;
  context: MergeContext;
  contactId: string | null;
  createdById: string;
  pdf: Buffer;
  /**
   * Make a new one even though one has been signed. For a signature that is
   * the end of the matter (an indemnity) this stays off, and a second start is
   * refused. A signed delivery note is evidence for a delivery that has still
   * to be completed — and if the handover changes before it is, the customer
   * has to be able to sign for what is now true. The signed one is kept.
   */
  again?: boolean;
}): Promise<OpenSubjectOutcome> {
  const { subject, tenantId } = opts;
  // The file has to exist before a request can name it.
  const storedName = await saveFile(opts.pdf, `${opts.title}.pdf`, "application/pdf", tenantId);
  let outcome: OpenSubjectOutcome = "gone";
  let committed = false;
  try {
    outcome = await basePrisma.$transaction(async (tx) => {
      if (!(await opts.holdRecord(tx))) return "gone" as const;
      await holdSubjectRequests(tx, subject, tenantId);
      if (!opts.again && (await subjectIsSigned(tx, subject, tenantId))) return "signed" as const;
      const replaced = await withdrawOpenSubjectRequests(tx, subject, tenantId);
      const created = await createSignatureRequestFromDoc({
        doc: opts.doc,
        title: opts.title,
        unsignedPdfRef: storedName,
        // No document or record of its own beside the customer: who may open it
        // in the Signatures list follows who may open the customer.
        source: { contactId: opts.contactId, subject },
        context: opts.context,
        createdById: opts.createdById,
        client: tx,
      });
      return { requestId: created.id, replaced };
    });
    committed = typeof outcome === "object";
  } finally {
    // A thrown commit is not a rollback (recordSigning.ts spells this out): the
    // file goes only when a read PROVES no request names it.
    if (!committed) {
      const named = await basePrisma.signatureRequest
        .findFirst({ where: { unsignedPdfRef: storedName }, select: { id: true } })
        .then(Boolean, () => true);
      if (!named) await deleteFile(storedName).catch(() => {});
    }
  }
  return outcome;
}
