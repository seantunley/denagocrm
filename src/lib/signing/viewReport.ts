import { boundedViewReport } from "./viewAnalytics";

/**
 * Apply a report from the signing page to its sitting — so that the figures
 * only ever go UP, whatever order reports arrive in.
 *
 * "Only ever up" is a claim about two reports landing together, and reading the
 * row, taking the larger figure and writing it back cannot keep it: an older
 * report that finishes last writes its smaller figure over the newer one. So
 * each figure is raised by the DATABASE in one statement — `UPDATE … WHERE
 * seconds < $new` — which either moves it up or changes nothing. There is no
 * moment between a read and a write for another report to slip into.
 *
 * `which` must name the workspace, the recipient and the request the signing
 * link resolved to: a sitting's id alone is never enough to change it.
 *
 * Returns false when there is no such sitting under that link.
 */
type ViewTable = {
  signatureView: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> };
};

export async function applyViewReport(
  db: ViewTable,
  which: { id: string; tenantId: string; recipientId: string; requestId: string },
  report: { seconds?: unknown; page?: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  const next = boundedViewReport(report);
  // The workspace is named in every write, here, whichever client this is handed: that the caller
  // looked the link up in the right workspace does not make the ROW that workspace's.
  const { id, tenantId, recipientId, requestId } = which;
  // Touching "last seen" is also what says whether the sitting exists under this link.
  const touched = await db.signatureView.updateMany({ where: { id, tenantId, recipientId, requestId }, data: { lastSeenAt: now } });
  if (touched.count === 0) return false;
  await db.signatureView.updateMany({ where: { id, tenantId, recipientId, requestId, seconds: { lt: next.seconds } }, data: { seconds: next.seconds } });
  await db.signatureView.updateMany({ where: { id, tenantId, recipientId, requestId, maxPage: { lt: next.maxPage } }, data: { maxPage: next.maxPage } });
  return true;
}
