/**
 * Engagement with a signing page: how often it was opened, for how long it was
 * actually in view, and how far the reader got.
 *
 * Kept out of SignatureEvent on purpose: this is operational, not evidence. It
 * is reported by the signer's own browser, so it is an INDICATION. The hash
 * chain stays the legal trail, and nothing here should be quoted as proof that
 * somebody read something.
 */

export type ViewRow = {
  startedAt: Date;
  lastSeenAt: Date;
  seconds: number;
  maxPage: number;
};

export type ViewSummary = {
  sessions: number;
  totalSeconds: number;
  maxPage: number;
  firstOpened: Date | null;
  lastSeen: Date | null;
};

/** The most one sitting can count for. A tab left open all afternoon is not four hours of reading. */
export const MAX_VIEW_SECONDS = 30 * 60;
/** The most sittings kept per recipient. Reloading the page a thousand times does not write a thousand rows. */
export const MAX_VIEWS_PER_RECIPIENT = 100;
/** No document has more pages than this; a larger number is not a page. */
const MAX_PAGE = 500;

const whole = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);

/**
 * What a sitting's totals become when the browser reports again.
 *
 * Both figures only ever go UP, and neither past its ceiling. The browser's
 * word is taken for nothing more than that: a report that arrives late, out of
 * order, twice, or with a silly number in it can never shorten a sitting, move
 * the furthest page backwards, or claim more than the cap.
 */
export function mergeViewReport(current: { seconds: number; maxPage: number }, report: { seconds?: unknown; page?: unknown }): { seconds: number; maxPage: number } {
  return {
    seconds: Math.max(current.seconds, Math.min(MAX_VIEW_SECONDS, Math.max(0, whole(report.seconds)))),
    maxPage: Math.max(current.maxPage, Math.min(MAX_PAGE, Math.max(1, whole(report.page)))),
  };
}

export function summariseViews(rows: ViewRow[]): ViewSummary {
  if (!rows.length) return { sessions: 0, totalSeconds: 0, maxPage: 0, firstOpened: null, lastSeen: null };
  return {
    sessions: rows.length,
    totalSeconds: rows.reduce((s, r) => s + Math.min(Math.max(0, r.seconds), MAX_VIEW_SECONDS), 0),
    maxPage: Math.max(...rows.map((r) => r.maxPage)),
    firstOpened: rows.reduce((a, r) => (a < r.startedAt ? a : r.startedAt), rows[0].startedAt),
    lastSeen: rows.reduce((a, r) => (a > r.lastSeenAt ? a : r.lastSeenAt), rows[0].lastSeenAt),
  };
}

/** "45 sec" / "4 min" / "1 hr 2 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

/** The line staff read: "Opened 3 times, about 4 min in view, reached page 2 of 3." Empty when it was never opened. */
export function engagementLine(views: ViewSummary, pageCount?: number): string {
  if (!views.sessions) return "";
  const times = `Opened ${views.sessions} ${views.sessions === 1 ? "time" : "times"}`;
  // Under a few seconds in view is "opened", not "read for 3 seconds".
  const time = views.totalSeconds >= 5 ? `, about ${formatDuration(views.totalSeconds)} in view` : "";
  const pages = pageCount && pageCount > 1 ? `, reached page ${Math.min(views.maxPage, pageCount)} of ${pageCount}` : views.maxPage > 1 ? `, reached page ${views.maxPage}` : "";
  return `${times}${time}${pages}.`;
}
