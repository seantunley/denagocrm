/**
 * Email signature banners — the rules, pure (Sean, 2026-10-11: "a module similar
 * [to Rocketseed] for email signatures, so I can add marketing and change it
 * temporarily").
 *
 * A banner is an image with a link, shown under the sender's signature on the
 * emails the team writes. The owner keeps one STANDING banner (no end date) and
 * puts a TEMPORARY one over it for a promotion: it goes live on its start date,
 * and on its end date the standing one shows again by itself.
 *
 * Marketing rides on a one-to-one email here, so two rules are not optional:
 * a customer who opted out of marketing never gets one (the send path checks),
 * and nothing shows until the owner switches a banner on.
 */
import { escapeHtml } from "./escapeHtml";

export type BannerRow = {
  id: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  linkUrl: string;
  altText: string;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  senderIds: string[];
  teamIds: string[];
  position: string;
  onQuoteEmails: boolean;
  token: string;
  createdAt: Date;
};

/**
 * The emails a banner can ride on. "composer" is an email a person writes; it
 * always qualifies. "quote" is a quote a person emails from the CRM — only for
 * a banner the owner ticked for it.
 */
export type BannerPlace = "composer" | "quote";
export type BannerSender = { id: string; teamIds?: readonly string[] };
export const bannerPosition = (value: string): "above" | "below" => (value === "above" ? "above" : "below");

/** The widest a banner is shown. Mail apps and phones both cope with this; wider gets scaled by the app, badly. */
export const BANNER_MAX_WIDTH = 600;
export const BANNER_MIN_WIDTH = 120;
/** A banner taller than this stops being a banner and becomes the email. */
export const BANNER_MAX_HEIGHT = 300;
export const BANNER_NAME_MAX = 80;
export const BANNER_ALT_MAX = 160;

export type BannerState = "off" | "scheduled" | "live" | "ended";

export function bannerState(banner: Pick<BannerRow, "active" | "startsAt" | "endsAt">, now: Date): BannerState {
  // Ended first: a banner whose dates have passed is over whether or not anyone switched it off.
  if (banner.endsAt && banner.endsAt <= now) return "ended";
  if (!banner.active) return "off";
  if (banner.startsAt && banner.startsAt > now) return "scheduled";
  return "live";
}

/**
 * The one banner an email from `senderId` carries right now, or null.
 *
 * Several can be live at once (the standing banner and a promotion over it), so
 * the order is the feature: a banner with an END DATE beats one without — that
 * is what "change it temporarily" means — then the one that started most
 * recently, then the newest.
 */
export function pickBanner<T extends BannerRow>(banners: readonly T[], sender: BannerSender, now: Date, place: BannerPlace = "composer"): T | null {
  // Named people OR anyone in a named team; nobody named at all means everyone.
  const forSender = (banner: T) =>
    (banner.senderIds.length === 0 && banner.teamIds.length === 0) ||
    banner.senderIds.includes(sender.id) ||
    banner.teamIds.some((teamId) => sender.teamIds?.includes(teamId));
  const live = banners.filter(
    (banner) => bannerState(banner, now) === "live" && forSender(banner) && (place === "composer" || banner.onQuoteEmails),
  );
  const started = (banner: T) => (banner.startsAt ?? banner.createdAt).getTime();
  live.sort(
    (a, b) => Number(Boolean(b.endsAt)) - Number(Boolean(a.endsAt)) || started(b) - started(a) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return live[0] ?? null;
}

/**
 * Stands in the banner's link for "the email this banner was sent in". The mail
 * sender (lib/email.ts) swaps it for the email's open-tracking token, or for
 * nothing when the email is not tracked — a click is then counted but belongs
 * to no email.
 */
export const EMAIL_REF_MARKER = "__crm_email_ref__";

/** The address a banner's link points at: our own redirect, which knows the real destination. */
export function bannerClickUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/api/track/b/${token}?e=${EMAIL_REF_MARKER}`;
}

/**
 * The banner as email HTML: a table row, every style inline, the size given
 * both as attributes and as CSS (Outlook reads the first, phones the second).
 * The alt text is what a customer sees until their mail app shows images.
 *
 * `href` is bannerClickUrl() in an email that is being SENT, and the banner's
 * own address in a preview — a click in a preview is not a customer's click.
 */
export function bannerHtml(banner: Pick<BannerRow, "imageUrl" | "width" | "height" | "altText" | "name">, href: string): string {
  const alt = escapeHtml(banner.altText.trim() || banner.name);
  return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:18px;border-collapse:collapse;">
  <tr>
    <td><a href="${escapeHtml(href)}" style="text-decoration:none;"><img class="sig-marketing" src="${escapeHtml(banner.imageUrl)}" alt="${alt}" width="${banner.width}" height="${banner.height}" style="display:block;border:0;width:${banner.width}px;max-width:100%;height:auto;" /></a></td>
  </tr>
</table>`;
}

/**
 * Put a banner into a FINISHED email (a whole HTML document): above the message,
 * straight after <body>, or below everything, straight before </body>. Centred,
 * because the emails this is used on (a quote email in the workspace's frame)
 * are a centred card. An email with no <body> gets it at the matching end.
 */
export function placeBannerInEmail(html: string, banner: string, position: "above" | "below"): string {
  const block = `<div style="text-align:center;padding:0 12px;"><div style="display:inline-block;text-align:left;max-width:100%;">${banner}</div></div>`;
  if (position === "above") return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (open) => `${open}${block}`) : `${block}${html}`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : `${html}${block}`;
}

/** A destination a customer may be sent to: a plain https address, nothing else. */
export function isBannerLink(value: string): boolean {
  if (value.length > 500 || /[\s"'<>]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * The size a banner is SHOWN at, from the uploaded image's own size: never wider
 * than BANNER_MAX_WIDTH, never enlarged, proportions kept. A 1200 × 300 upload
 * is shown at 600 × 150 and stays sharp on a retina screen.
 */
export function bannerDisplaySize(naturalWidth: number, naturalHeight: number): { width: number; height: number } | null {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth < BANNER_MIN_WIDTH || naturalHeight < 20) return null;
  // Retina artwork is drawn at twice its shown size; anything wider than the cap is shown AT the cap.
  const width = Math.min(BANNER_MAX_WIDTH, Math.round(naturalWidth));
  const height = Math.round((naturalHeight * width) / naturalWidth);
  return height > BANNER_MAX_HEIGHT ? null : { width, height };
}

/**
 * A date typed on the form ("2026-11-01") as a moment, in South African time:
 * a banner starts at the beginning of its first day and ends at the end of its last.
 * ponytail: every workspace is on SAST (no daylight saving). A workspace elsewhere
 * needs its own offset here — the setting does not exist yet.
 */
export function bannerDay(value: string, edge: "start" | "end"): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}+02:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The form's date for a stored moment — the inverse of bannerDay. */
export function bannerDayValue(date: Date | null): string {
  return date ? new Date(date.getTime() + 2 * 3_600_000).toISOString().slice(0, 10) : "";
}

/** Clicks per hundred emails sent, as "4%"; "—" until something has been sent. */
export function clickRate(sent: number, clicks: number): string {
  if (sent <= 0) return "—";
  const rate = (clicks / sent) * 100;
  return `${rate > 0 && rate < 1 ? rate.toFixed(1) : Math.round(rate)}%`;
}
