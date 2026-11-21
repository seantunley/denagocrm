/**
 * Dated lines on email signatures (Sean, 2026-11-20: "Temporary lines with dates. 'On leave until 5 January, contact
 * Thandi', or holiday trading hours, which appear and disappear on schedule"). Pure: which lines show today, and the
 * one rule for what may be saved. The rows are SignatureNotice; the store is lib/signatureNoticeStore.ts.
 *
 * A line is a person's own (their leave) or the owner's for everyone (holiday hours). Days are South African days —
 * the same day boundaries as signature banners (lib/signatureBanners.ts bannerDay).
 */
import { bannerDay } from "./signatureBanners";

export const NOTICE_MAX = 160;
/** At most this many dated lines on one signature: a signature is not a notice board. */
export const NOTICES_SHOWN = 2;
/** How far ahead a line may be planned, and how long one may run. */
export const NOTICE_MAX_DAYS_AHEAD = 400;
export const NOTICE_MAX_DAYS_LONG = 120;

export type NoticeRow = { id: string; userId: string | null; text: string; startsAt: Date; endsAt: Date; createdAt: Date };
export type NoticeState = "scheduled" | "live" | "ended";

export function noticeState(row: Pick<NoticeRow, "startsAt" | "endsAt">, now: Date): NoticeState {
  if (row.endsAt <= now) return "ended";
  return row.startsAt > now ? "scheduled" : "live";
}

/** The lines on this person's signature right now: their own first, then everyone's; the sooner-ending first. */
export function liveNotices(rows: readonly NoticeRow[], userId: string, now: Date): string[] {
  return rows
    .filter((row) => (row.userId === null || row.userId === userId) && noticeState(row, now) === "live")
    .sort((a, b) => Number(a.userId === null) - Number(b.userId === null) || a.endsAt.getTime() - b.endsAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, NOTICES_SHOWN)
    .map((row) => row.text);
}

const DAY_MS = 86_400_000;

/** A typed line and its first and last day → what is stored, or why it can't be. One rule for the form and the server. */
export function cleanNotice(
  input: { text: string; startsOn: string; endsOn: string },
  now: Date,
): { ok: true; text: string; startsAt: Date; endsAt: Date } | { ok: false; error: string } {
  const text = input.text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "Type the line to show, for example “On leave until 5 January — please contact Thandi”." };
  if (text.length > NOTICE_MAX) return { ok: false, error: `The line is too long: ${NOTICE_MAX} characters at most.` };
  const startsAt = bannerDay(input.startsOn.trim(), "start");
  const endsAt = bannerDay(input.endsOn.trim(), "end");
  if (!startsAt || !endsAt) return { ok: false, error: "Choose the first and the last day to show it." };
  if (endsAt <= now) return { ok: false, error: "The last day has already passed." };
  if (endsAt <= startsAt) return { ok: false, error: "The last day is before the first day." };
  if (startsAt.getTime() - now.getTime() > NOTICE_MAX_DAYS_AHEAD * DAY_MS) return { ok: false, error: `Start it within ${NOTICE_MAX_DAYS_AHEAD} days.` };
  if (endsAt.getTime() - startsAt.getTime() > NOTICE_MAX_DAYS_LONG * DAY_MS) {
    return { ok: false, error: `A dated line can run ${NOTICE_MAX_DAYS_LONG} days at most. For something permanent, use your own line or a team line.` };
  }
  return { ok: true, text, startsAt, endsAt };
}
