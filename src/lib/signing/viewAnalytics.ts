/**
 * Engagement analytics for a signing session.
 *
 * Kept out of SignatureEvent on purpose: heartbeats are operational, not
 * evidence. The hash chain stays the legal trail.
 */

export type ViewRow = {
  startedAt: Date;
  lastSeenAt: Date;
  seconds: number;
  maxPage: number;
  sections: string[];
};

export type ViewSummary = {
  sessions: number;
  totalSeconds: number;
  maxPage: number;
  sections: string[];
  firstOpened: Date | null;
  lastSeen: Date | null;
};

const MAX_SECONDS = 30 * 60;

export function summariseViews(rows: ViewRow[]): ViewSummary {
  if (!rows.length) {
    return { sessions: 0, totalSeconds: 0, maxPage: 0, sections: [], firstOpened: null, lastSeen: null };
  }
  const sections = [...new Set(rows.flatMap((r) => r.sections))].sort();
  return {
    sessions: rows.length,
    totalSeconds: rows.reduce((s, r) => s + Math.min(r.seconds, MAX_SECONDS), 0),
    maxPage: Math.max(...rows.map((r) => r.maxPage)),
    sections,
    firstOpened: rows.reduce((a, r) => (a < r.startedAt ? a : r.startedAt), rows[0].startedAt),
    lastSeen: rows.reduce((a, r) => (a > r.lastSeenAt ? a : r.lastSeenAt), rows[0].lastSeenAt),
  };
}

/** "4 min" / "45 sec" / "1 hr 2 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}
