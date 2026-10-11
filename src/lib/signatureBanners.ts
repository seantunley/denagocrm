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
  return eligibleBanners(banners, sender, now, place)[0] ?? null;
}

/**
 * Every banner an email from this sender could carry right now, the default
 * first. The composer offers these to the person writing (chooseBanner): they
 * may swap the promotion for the standing banner, or send without one — but
 * only ever one the owner switched on, for them, that is in date.
 */
export function eligibleBanners<T extends BannerRow>(banners: readonly T[], sender: BannerSender, now: Date, place: BannerPlace = "composer"): T[] {
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
  return live;
}

/** What the composer posts when the sender wants no banner on this one email. */
export const NO_BANNER = "none";

/**
 * The sender's choice, applied to what they are allowed: "none" is no banner, an
 * id is that banner IF it is one of theirs right now, and anything else — blank,
 * stale, made up — is the default. A choice can never reach a banner that is
 * off, out of date or for somebody else.
 */
export function chooseBanner<T extends BannerRow>(eligible: readonly T[], choice: string | null | undefined): T | null {
  if (choice === NO_BANNER) return null;
  return eligible.find((banner) => banner.id === choice) ?? eligible[0] ?? null;
}

/**
 * Stands in the banner's link for "the email this banner was sent in". The mail
 * sender (lib/email.ts) swaps it for an id made for that one email and kept on
 * its timeline entry (Communication.bannerRef) — its own id, not the open
 * token, so it is there whether or not open tracking is switched on.
 */
export const EMAIL_REF_MARKER = "__crm_email_ref__";

/** The shape of an email's banner reference and of a link token (both made by newOpenToken). */
export const BANNER_REF = /^[A-Za-z0-9_-]{24,64}$/;

/**
 * The most recipients an email may have and still carry a banner. Every one of
 * them is checked for a marketing opt-out; past this many the banner is left
 * off rather than sent on a partial check.
 */
export const BANNER_MAX_RECIPIENTS = 20;

/**
 * The addresses an email is going to, for the opt-out check — every one of them,
 * or `null` when there are more than can be checked, in which case the email
 * carries no banner. Never a partial list: an unchecked recipient is one who may
 * have opted out.
 */
export function bannerRecipients(to: string | null | undefined): string[] | null {
  const addresses = [...new Set((to ?? "").split(/[,;]/).map((address) => address.trim().toLowerCase()).filter(Boolean))];
  return addresses.length > BANNER_MAX_RECIPIENTS ? null : addresses;
}

/**
 * Give an email its own banner reference, if it carries a banner link: every
 * EMAIL_REF_MARKER becomes one fresh id, returned so it can be kept on the
 * email's timeline entry. Independent of open tracking by construction — it
 * takes no setting, only the HTML.
 */
export function withBannerRef(html: string, makeRef: () => string): { html: string; ref: string | null } {
  if (!html.includes(EMAIL_REF_MARKER)) return { html, ref: null };
  const ref = makeRef();
  return { html: html.replaceAll(EMAIL_REF_MARKER, ref), ref };
}

/**
 * What saving a banner does to its link. A destination is never edited in place:
 * a NEW address gets a new token (so emails already sent keep the old address),
 * the same address keeps its token, and a token with no link row gets one.
 */
export function nextBannerLink(input: { current: { linkUrl: string; token: string }; linkUrl: string; hasLinkRow: boolean; newToken: () => string }): { token: string; createLink: boolean } {
  if (input.current.linkUrl !== input.linkUrl) return { token: input.newToken(), createLink: true };
  return { token: input.current.token, createLink: !input.hasLinkRow };
}

/**
 * A click, in the only safe order: find where the link leads, THEN try to count
 * it. The customer is owed the page they clicked for; the count is ours to lose.
 * A failure to record is handed to `onRecordError` and the destination is still
 * returned. Null only when the link itself is unknown.
 */
export async function bannerClickDestination<L extends { destination: string }>(
  deps: { resolve: (token: string) => Promise<L | null>; record: (link: L, emailRef: string | null) => Promise<void>; onRecordError: (error: unknown) => unknown },
  token: string,
  emailRef: string | null,
): Promise<string | null> {
  const link = await deps.resolve(token);
  if (!link) return null;
  try {
    await deps.record(link, emailRef);
  } catch (error) {
    try { await deps.onRecordError(error); } catch { /* logging must not cost the customer their page either */ }
  }
  return link.destination;
}

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
