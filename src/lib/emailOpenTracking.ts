import { randomBytes } from "node:crypto";
import { formatDateTime } from "./format";

/**
 * Email open tracking (Sean, 2026-10-07: "I want open tracking on emails").
 *
 * Each tracked email carries a 1×1 image whose address holds an unguessable
 * token; when the customer's mail app loads it, /api/track/e/<token> stamps the
 * email's timeline entry as opened (Communication.seenAt) and counts the load.
 *
 * What it can and can't tell you: an open means the images loaded. Apple Mail's
 * privacy protection loads them on receipt, so an iPhone recipient can read as
 * "opened" without reading, and a client that blocks images never reports one.
 *
 * On by default; the owner switches it off in Settings → Email (EMAIL_OPEN_TRACKING).
 */
export const EMAIL_OPEN_TRACKING_KEY = "EMAIL_OPEN_TRACKING";
export const OPEN_TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

/** Off only when the owner switched it off. */
export const openTrackingOn = (setting: string | null | undefined) => setting !== "off";

export const newOpenToken = () => randomBytes(24).toString("base64url");

/** The timeline badge for an outbound message the customer opened/read, or null. One wording for every timeline. */
export function seenLabel(c: { type: string; direction: string | null; seenAt?: Date | null; openCount?: number; bannerClickedAt?: Date | null }): string | null {
  if (c.direction !== "outbound") return null;
  // A click on the signature banner (lib/signatureBanners.ts) is stronger news than an open, and can
  // arrive without one: a mail app that blocks images never loads the pixel, but its reader can still click.
  const clicked = c.bannerClickedAt ? `Clicked your banner ${formatDateTime(c.bannerClickedAt)}` : "";
  if (!c.seenAt) return clicked ? `👆 ${clicked}` : null;
  const times = c.openCount && c.openCount > 1 ? ` · ${c.openCount}×` : "";
  return `👁 ${c.type === "email" ? "Opened" : "Read"} ${formatDateTime(c.seenAt)}${times}${clicked ? ` · 👆 ${clicked}` : ""}`;
}

/**
 * The same fact for the assistant, which was asked "has he opened his email?" and
 * could only say the CRM doesn't show it — its lookup never read these columns.
 *
 * TWO SEPARATE FACTS, each said only as far as the CRM knows it (review of #868):
 *
 * `emailOpen` — what tracking saw. Never a yes/no about READING:
 *   "opened"            an open was detected (when, how often). Not proof it was read.
 *   "no_open_detected"  tracked, and no open recorded. NOT "unread": a mail app
 *                       that blocks images never reports one. (The first version
 *                       said `opened: false`, which reads as proof it was not.)
 *   "not_tracked"       the CRM cannot tell either way.
 *
 * `provenance` — whether the CRM itself sent it:
 *   "sent_by_crm"    the mail server accepted it from the CRM: it carries the
 *                    tracking token or the server's message id.
 *   "recorded_only"  a timeline entry with neither. It may be an email somebody
 *                    logged by hand; the entry alone does not establish it was sent.
 *                    (An email the composer sent with tracking switched off stores
 *                    neither either, so it reads as this — the cautious answer.)
 */
export type EmailOpenFact = {
  emailOpen: "opened" | "no_open_detected" | "not_tracked";
  openedAt?: string;
  openedTimes?: number;
  provenance: "sent_by_crm" | "recorded_only";
};
export function openedFact(c: {
  type: string;
  direction: string | null;
  openToken?: string | null;
  messageId?: string | null;
  seenAt?: Date | null;
  openCount?: number;
}): EmailOpenFact | Record<string, never> {
  if (c.direction !== "outbound" || c.type !== "email") return {};
  const provenance = c.openToken || c.messageId ? "sent_by_crm" : "recorded_only";
  if (c.seenAt) {
    return { emailOpen: "opened", openedAt: c.seenAt.toISOString(), ...(c.openCount && c.openCount > 1 ? { openedTimes: c.openCount } : {}), provenance };
  }
  return { emailOpen: c.openToken ? "no_open_detected" : "not_tracked", provenance };
}

export const OPENED_LEGEND =
  "On an outbound email, `emailOpen` is what open-tracking saw — never whether it was READ. " +
  "\"opened\": tracking detected an open at `openedAt` (the mail app loaded it; Apple Mail can do that unread) — say it was opened, not that it was read. " +
  "\"no_open_detected\": tracking was on and no open is recorded — the recipient may still have read it (mail apps that block images report nothing); say no open has been detected, never that it is unread or unopened for certain. " +
  "\"not_tracked\": the CRM cannot tell whether it was opened. " +
  "`provenance` — \"sent_by_crm\": the mail server accepted it from the CRM. \"recorded_only\": an email is logged on the timeline, which alone does not establish that it was sent — say it is recorded, not that it went out.";

export const SEEN_HINT ="The customer's mail app loaded this email. Apple Mail can do this on its own, so treat it as a strong hint, not proof.";

/** The pixel, at the very end of the HTML (after the signature), on the workspace's own address. */
export function withOpenPixel(html: string, origin: string, token: string): string {
  const src = `${origin.replace(/\/$/, "")}/api/track/e/${token}`;
  const pixel = `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : `${html}${pixel}`;
}
