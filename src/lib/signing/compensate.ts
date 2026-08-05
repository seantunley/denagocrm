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
 */

/** What the check needs from the request row — nothing else. */
export type CompletionRefLookup = () => Promise<{ signedPdfRef: string | null } | null | undefined>;

/**
 * True only when the stored blob is provably unreferenced and may be deleted.
 *
 * Returns false — KEEP THE FILE — in every ambiguous case:
 *
 *   • the row names this blob                the commit landed; it is live
 *   • the lookup throws                      usually the same broken connection
 *                                            that lost the acknowledgement, so
 *                                            this is exactly the case that
 *                                            caused the incident
 *   • the lookup returns a malformed row     no answer is not a "no"
 *
 * Returns true when the row is gone, or names a DIFFERENT blob (a concurrent
 * completion won the claim and wrote its own upload — ours is genuinely
 * unreferenced), or names none at all.
 */
export async function signedPdfIsUnreferenced(
  storedName: string,
  lookup: CompletionRefLookup,
): Promise<boolean> {
  // An empty stored name can never be matched against a row, so it could only
  // ever produce a delete call for a blob we cannot identify. Refuse.
  if (!storedName) return false;
  try {
    const row = await lookup();
    if (row === null || row === undefined) return true; // no request row references anything
    if (typeof row !== "object" || !("signedPdfRef" in row)) return false; // unreadable — keep
    return row.signedPdfRef !== storedName;
  } catch {
    return false;
  }
}
