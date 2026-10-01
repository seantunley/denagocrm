/**
 * Evidence files that belong to a database write which may still be refused.
 *
 * A blob cannot join a database transaction, so the order is:
 *
 *   1. UPLOAD the files first, each under a fresh random key (saveFile uses a
 *      UUID) that nothing references yet;
 *   2. COMMIT — the caller creates the Document rows INSIDE its transaction, so
 *      they commit or roll back with the write they evidence;
 *   3. if anything from step 1 onward throws, CLEAN UP — but only what is
 *      PROVABLY unreferenced, then rethrow.
 *
 * ── A THROWN TRANSACTION IS NOT PROOF OF A ROLLBACK ────────────────────────
 *
 * When Postgres COMMITS and only the acknowledgement is lost (connection reset,
 * compute suspend, pooler timeout), the client sees an error while the Document
 * rows exist. Deleting on "it threw" then destroys files under valid records —
 * the Q-1010 signed-PDF incident (lib/signing/compensate.ts). So each staged
 * blob is deleted only when `isUnreferenced` positively proves, with a fresh
 * query outside the failed transaction, that nothing names it. A "no", a probe
 * that throws, or anything uncertain RETAINS the file: an orphaned private blob
 * costs storage, a deleted one costs the delivery's evidence.
 *
 * Retained or undeletable files are reported through `onRetained` as COUNTS —
 * never a key or a file name.
 *
 * Kept free of prisma and storage imports so the race can be tested with fakes.
 */

export type StagedDocument = {
  storedName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  tag: string;
};

export type StageFile = (file: {
  buffer: Buffer;
  /** Used for the stored blob's extension only. */
  originalName: string;
  mimeType: string;
  /** The Document row's display name. */
  fileName: string;
  tag: string;
}) => Promise<string>;

export type CleanupSummary = {
  /** Kept because a reference was found, or the check could not prove there was none. */
  retained: number;
  /** Proven unreferenced, but the delete itself failed. */
  deleteFailed: number;
};

export async function withStagedEvidence<E, T>(
  deps: {
    save: (buffer: Buffer, originalName: string, mimeType: string) => Promise<string>;
    /** True ONLY on positive proof that nothing durable names this blob. */
    isUnreferenced: (storedName: string) => Promise<boolean>;
    remove: (storedName: string) => Promise<void>;
    onRetained: (summary: CleanupSummary) => Promise<void>;
  },
  collect: (stage: StageFile) => Promise<E>,
  commit: (evidence: E, documents: StagedDocument[]) => Promise<T>,
): Promise<T> {
  const documents: StagedDocument[] = [];
  try {
    const evidence = await collect(async (file) => {
      const storedName = await deps.save(file.buffer, file.originalName, file.mimeType);
      documents.push({
        storedName,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.buffer.length,
        tag: file.tag,
      });
      return storedName;
    });
    return await commit(evidence, documents);
  } catch (error) {
    const summary: CleanupSummary = { retained: 0, deleteFailed: 0 };
    for (const document of documents) {
      let provenUnreferenced = false;
      try {
        provenUnreferenced = (await deps.isUnreferenced(document.storedName)) === true;
      } catch {
        provenUnreferenced = false; // no answer is not a "no"
      }
      if (!provenUnreferenced) {
        summary.retained++;
        continue;
      }
      try {
        await deps.remove(document.storedName);
      } catch {
        summary.deleteFailed++;
      }
    }
    if (summary.retained || summary.deleteFailed) await deps.onRetained(summary).catch(() => {});
    throw error;
  }
}
