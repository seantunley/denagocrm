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
 * Three answers, kept apart: opened (when, how often), tracked and not opened yet,
 * and not tracked at all (nothing returned — silence there is not "unopened").
 */
export function openedFact(c: { type: string; direction: string | null; openToken?: string | null; seenAt?: Date | null; openCount?: number }):
  { opened?: string | false; openedTimes?: number } {
  if (c.direction !== "outbound" || c.type !== "email") return {};
  if (c.seenAt) return { opened: c.seenAt.toISOString(), ...(c.openCount && c.openCount > 1 ? { openedTimes: c.openCount } : {}) };
  return c.openToken ? { opened: false } : {};
}

export const OPENED_LEGEND =
  "On an email we sent: `opened` is when the customer's mail app first loaded it (a strong hint, not proof — Apple Mail can do it unread); " +
  "`opened: false` means it is tracked and has not been opened yet; no `opened` at all means that email was not tracked, so nothing is known. " +
  "An email listed here was accepted for sending — do not suggest checking whether it went out.";

export const SEEN_HINT ="The customer's mail app loaded this email. Apple Mail can do this on its own, so treat it as a strong hint, not proof.";

/** The pixel, at the very end of the HTML (after the signature), on the workspace's own address. */
export function withOpenPixel(html: string, origin: string, token: string): string {
  const src = `${origin.replace(/\/$/, "")}/api/track/e/${token}`;
  const pixel = `<img src="${src}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : `${html}${pixel}`;
}
