/**
 * Whether the signed PDF a failed completion uploaded is safe to delete.
 *
 * Deliberately NOT `server-only` and importing no database client: this is the
 * decision that was wrong in production, so it is the thing that has to be
 * testable on its own.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 *
 * `completeRequest` uploads the sealed PDF BEFORE the transaction that claims
 * the completion, because the blob's name has to be written into the row. If the
 * transaction then failed it compensated unconditionally:
 *
 *     } catch (err) {
 *       await deleteFile(storedName).catch(() => {});
 *
 * which assumes a thrown error means the transaction rolled back. It does not.
 * When the COMMIT succeeds and only its acknowledgement is lost — a connection
 * reset, a Neon compute suspend, a pooler timeout, a serverless invocation torn
 * down mid-flight — Postgres has committed. `SignatureRequest.signedPdfRef` and
 * the freshly created `Document` row both name that blob, and the compensating
 * delete then destroys the file underneath a record that says it exists.
 *
 * That is not hypothetical. Quote Q-1010, production, 2026-08-04: the request
 * read `completed`, the Document row was present and not soft-deleted with
 * `sizeBytes` recorded from inside the transaction — so the upload succeeded and
 * the commit landed — and the blob returned 404. The customer opening their
 * signed quote got "File missing in storage".
 *
 * It is also unrecoverable. Re-rendering the document produces a different
 * `signedPdfHash`, so the replacement is provably not the artefact anybody
 * signed. The only fix is to not delete it in the first place.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Ask the database whether anything still references the blob, and delete ONLY
 * on a positive answer that nothing does. Every uncertain outcome keeps the
 * file, because the two failure modes are not comparable: an orphaned blob costs
 * a few hundred kilobytes of storage, a deleted one costs a signed contract.
 *
 * ── ASK ABOUT EVERY REFERENCE, NOT THE CONVENIENT ONE ──────────────────────
 *
 * The first version of this check asked only whether the live `SignatureRequest`
 * named the blob. That reopens the same hole by another door. The completion
 * transaction files TWO durable references — `SignatureRequest.signedPdfRef` and
 * a `Document` row whose `storedName` is the blob — and the request is
 * soft-deletable. Commit lands, the request is trashed, the request lookup
 * answers "no row", the helper says "unreferenced", and the blob is deleted out
 * from under a `Document` that still points at it. Same lost contract, different
 * route: the Documents tab, where the signed PDF is actually filed.
 *
 * So the caller must probe EVERY durable reference, the probes must be
 * soft-delete INCLUSIVE (a trashed row still names the blob, and Trash restores),
 * and a missing probe is treated exactly like an unanswered one — keep the file.
 * {@link DURABLE_BLOB_REFERENCES} is the list; adding a third reference to it
 * fails every call site closed until that call site is updated, which is the
 * point of naming them.
 */

/**
 * Every place the completion path durably records the name of a sealed PDF.
 *
 * Both are written inside the SAME transaction, so after a lost commit
 * acknowledgement either may exist. Deleting requires positive proof that
 * NEITHER references the blob.
 */
export const DURABLE_BLOB_REFERENCES = [
  "SignatureRequest.signedPdfRef",
  "Document.storedName",
] as const;

export type DurableBlobReference = (typeof DURABLE_BLOB_REFERENCES)[number];

/**
 * One counter per durable reference: how many rows of that kind name this blob.
 *
 * A probe MUST be soft-delete inclusive and explicitly scoped to the owning
 * tenant — see the call site in complete.ts. Counting, rather than returning the
 * row, keeps the contract unambiguous: there is no shape to misread, and
 * anything that is not a finite count ≥ 0 is treated as no answer at all.
 */
export type BlobReferenceProbes = Record<DurableBlobReference, () => Promise<number | bigint>>;

/**
 * True only when the stored blob is provably unreferenced and may be deleted.
 *
 * Returns false — KEEP THE FILE — in every ambiguous case:
 *
 *   • any probe counts ≥ 1                   something names this blob; it is live
 *   • any probe throws                       usually the same broken connection
 *                                            that lost the acknowledgement, so
 *                                            this is exactly the case that
 *                                            caused the incident
 *   • any probe answers with a non-count     no answer is not a "no"
 *   • a required probe was not supplied      an unasked question is not a "no"
 *   • the blob has no name we can match on   we could not identify what we were
 *                                            about to delete
 *
 * Returns true only when EVERY durable reference has been asked and every one of
 * them counted zero — which is what a genuine rollback looks like, and what
 * still lets a genuine rollback clean up after itself.
 */
export async function signedPdfIsUnreferenced(
  storedName: string,
  probes: BlobReferenceProbes,
): Promise<boolean> {
  // An empty stored name can never be matched against a row, so it could only
  // ever produce a delete call for a blob we cannot identify. Refuse.
  if (!storedName) return false;
  if (!probes || typeof probes !== "object") return false;

  for (const reference of DURABLE_BLOB_REFERENCES) {
    const probe = probes[reference];
    // A reference nobody asked about is not a reference that answered "no".
    if (typeof probe !== "function") return false;
    let answer: unknown;
    try {
      answer = await probe();
    } catch {
      return false;
    }
    // Prisma `count` gives a number; a raw COUNT(*) gives a bigint. Anything
    // else — null, undefined, NaN, a string, a row object — is not an answer.
    const count = typeof answer === "bigint" ? Number(answer) : answer;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return false;
    if (count > 0) return false;
  }
  return true;
}
