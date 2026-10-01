/**
 * Evidence files that belong to a database write which may still be refused.
 *
 * A blob cannot join a database transaction, so the order is:
 *
 *   1. UPLOAD the files first, each under a fresh random key (saveFile uses a
 *      UUID) that nothing references yet;
 *   2. COMMIT — the caller creates the Document rows INSIDE its transaction, so
 *      they commit or roll back with the write they evidence;
 *   3. if anything from step 1 onward throws — a refusal, a lost
 *      compare-and-set, a database error — DELETE exactly the blobs this attempt
 *      uploaded, then rethrow.
 *
 * Cleanup is best-effort: an unreferenced private blob is harmless, a Document
 * row pointing at a refused delivery is not. A failed delete is reported through
 * `onCleanupFailure` with a count only — never a key or a file name.
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

export async function withStagedEvidence<E, T>(
  deps: {
    save: (buffer: Buffer, originalName: string, mimeType: string) => Promise<string>;
    remove: (storedName: string) => Promise<void>;
    onCleanupFailure: (error: unknown, failed: number) => Promise<void>;
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
    let failed = 0;
    let lastError: unknown = null;
    for (const document of documents) {
      try {
        await deps.remove(document.storedName);
      } catch (removeError) {
        failed++;
        lastError = removeError;
      }
    }
    if (failed) await deps.onCleanupFailure(lastError, failed).catch(() => {});
    throw error;
  }
}
