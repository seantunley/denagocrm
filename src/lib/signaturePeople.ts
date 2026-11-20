/**
 * The Email signatures pack's people features (Sean, 2026-11-20 — items 1–4 of email-signature-improvements.md):
 * each person's own extra details, which of them staff may change (the rest are the owner's), a line per team, and a
 * short signature for replies. Pure — the signature builder (lib/signature.ts) and the settings preview both call it,
 * on the server and in the browser.
 */
import { escapeHtml } from "./escapeHtml";

/** The extra details a person can have on their signature. Each appears only when set. */
export const SIGNATURE_FIELDS = ["qualifications", "directLine", "whatsapp", "bookingUrl", "hours", "cta", "photo"] as const;
export type SignatureField = (typeof SIGNATURE_FIELDS)[number];

export const SIGNATURE_FIELD_LABELS: Record<SignatureField, string> = {
  qualifications: "Qualifications",
  directLine: "Direct line",
  whatsapp: "WhatsApp number",
  bookingUrl: "Booking link (“book a time with me”)",
  hours: "Working hours",
  cta: "Your own line (e.g. “Ask me about the new model”)",
  photo: "Photo (your profile photo)",
};

/** A person's details as the signature shows them. photoUrl: set only when they opted in and have a profile photo. */
export type SignatureExtras = {
  qualifications?: string | null;
  directLine?: string | null;
  whatsapp?: string | null;
  bookingUrl?: string | null;
  hours?: string | null;
  cta?: string | null;
  photoUrl?: string | null;
};

/** One line under the signature for everyone in a team — the workshop's hours, a parts number. */
export type TeamLine = { teamId: string; line: string };
export const TEAM_LINES_MAX = 20;
export const TEAM_LINE_MAX = 160;

/** The owner's list of fields staff may NOT change (stored on the design; unknown names dropped). */
export function parseLocked(value: unknown): SignatureField[] {
  return Array.isArray(value) ? SIGNATURE_FIELDS.filter((field) => value.includes(field)) : [];
}

/** The team lines on the design, cleaned: one per team, short, no line breaks. */
export function parseTeamLines(value: unknown): TeamLine[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TeamLine[] = [];
  for (const row of value) {
    const teamId = typeof row?.teamId === "string" ? row.teamId.trim() : "";
    const line = typeof row?.line === "string" ? row.line.replace(/[\r\n]+/g, " ").trim().slice(0, TEAM_LINE_MAX) : "";
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(teamId) || !line || seen.has(teamId)) continue;
    seen.add(teamId);
    out.push({ teamId, line });
    if (out.length >= TEAM_LINES_MAX) break;
  }
  return out;
}

/** The line for someone in these teams: the first of the owner's team lines that is one of theirs, else none. */
export function teamLineFor(teamLines: readonly TeamLine[], teamIds: readonly string[]): string {
  return teamLines.find((row) => teamIds.includes(row.teamId))?.line ?? "";
}

/** May this person change this field themselves? The owner may change every field, for anyone. */
export function mayEdit(field: SignatureField, locked: readonly SignatureField[], isOwner: boolean): boolean {
  return isOwner || !locked.includes(field);
}

const PHONE = /^\+?[\d\s()-]{6,24}$/;

/** A typed value → what is stored (null = cleared), or why it can't be. One rule for the form and the server. */
export function cleanDetail(field: Exclude<SignatureField, "photo">, raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = raw.replace(/[\r\n]+/g, " ").trim();
  if (!value) return { ok: true, value: null };
  if (field === "directLine" || field === "whatsapp") {
    return PHONE.test(value) && value.replace(/\D/g, "").length >= 6 ? { ok: true, value } : { ok: false, error: `${SIGNATURE_FIELD_LABELS[field]}: a phone number, digits and spaces only.` };
  }
  if (field === "bookingUrl") {
    return /^https:\/\/[^\s"'<>]+$/i.test(value) && value.length <= 300 ? { ok: true, value } : { ok: false, error: "Booking link: a full https:// address." };
  }
  return value.length <= 120 ? { ok: true, value } : { ok: false, error: `${SIGNATURE_FIELD_LABELS[field]}: 120 characters at most.` };
}

/** WhatsApp's link for a number written the South African way (0… → 27…). Empty when it isn't a usable number. */
export function whatsappLink(number: string | null | undefined): string {
  const digits = (number ?? "").replace(/\D/g, "").replace(/^0/, "27");
  return digits.length >= 10 ? `https://wa.me/${digits}` : "";
}

/**
 * The extra lines under the contact details, in the signature's own type: direct line, WhatsApp and booking link on
 * one line, working hours on the next, the team's line last. "" when there is nothing to show — an unset detail
 * removes its part, never leaves an empty one.
 */
export function extrasHtml(extras: SignatureExtras | undefined, teamLine: string, accent: string): string {
  const e = extras ?? {};
  const link = (href: string, text: string) => `<a href="${escapeHtml(href)}" style="color:${accent};text-decoration:none;">${text}</a>`;
  const direct = e.directLine?.trim();
  const wa = whatsappLink(e.whatsapp);
  const booking = e.bookingUrl?.trim();
  const reach = [
    direct ? `Direct ${link(`tel:${direct.replace(/[^\d+]/g, "")}`, escapeHtml(direct))}` : "",
    wa ? link(wa, "WhatsApp me") : "",
    booking ? link(booking, "Book a time with me") : "",
  ].filter(Boolean).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  const lines = [
    reach,
    e.hours?.trim() ? escapeHtml(e.hours.trim()) : "",
    teamLine.trim() ? escapeHtml(teamLine.trim()) : "",
    e.cta?.trim() ? `<span style="color:${accent};font-weight:bold;">${escapeHtml(e.cta.trim())}</span>` : "",
  ].filter(Boolean);
  return lines.length
    ? `<div style="padding-top:8px;font-size:13px;line-height:20px;color:#475569;">${lines.join("<br />")}</div>`
    : "";
}

/** The person's photo, round where the mail app allows it. "" without one. */
export function photoHtml(extras: SignatureExtras | undefined, alt: string, size = 64): string {
  const url = extras?.photoUrl?.trim();
  return url
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" width="${size}" height="${size}" style="display:block;border:0;border-radius:${size / 2}px;margin-bottom:8px;" />`
    : "";
}

/** Qualifications, small, under the name. "" without them. */
export function qualificationsHtml(extras: SignatureExtras | undefined): string {
  const q = extras?.qualifications?.trim();
  return q ? `<div style="padding-top:2px;font-size:12px;color:#64748b;">${escapeHtml(q)}</div>` : "";
}

/**
 * The owner's small print under every signature (item 6). The company details and confidentiality notice are the
 * workspace's existing email legal line (lib/emailLegalLine.ts — already at the foot of every email), so only the
 * privacy policy link lives here.
 */
export type SignatureLegal = { privacyUrl: string };

/** The stored link, cleaned: a full https address or nothing. */
export function parseLegal(value: unknown): SignatureLegal {
  const url = typeof (value as { privacyUrl?: unknown })?.privacyUrl === "string" ? (value as { privacyUrl: string }).privacyUrl.trim().slice(0, 300) : "";
  return { privacyUrl: /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : "" };
}

/** The privacy policy link, small, under the signature. "" when none is set. */
export function legalHtml(legal: SignatureLegal | undefined, accent: string): string {
  return legal?.privacyUrl
    ? `<div style="margin-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:15px;"><a href="${escapeHtml(legal.privacyUrl)}" style="color:${accent};text-decoration:none;">Privacy policy</a></div>`
    : "";
}

/** What a person's signature is missing of the basics it is built from (item 8). Empty = complete. */
export function missingBasics(person: { jobTitle?: string | null; mobile?: string | null }): string[] {
  return [!person.jobTitle?.trim() ? "job title" : "", !person.mobile?.trim() ? "mobile" : ""].filter(Boolean);
}

/**
 * The short signature for replies (item 4): two plain lines, no images — so a long thread doesn't repeat the card ten
 * times. Name · title · company, then phone · email.
 */
export function shortSignature(
  user: { name: string; email: string; mobile?: string | null; jobTitle?: string | null },
  company: { name: string; switchboard: string },
  accent: string,
): string {
  const phone = (user.mobile ?? "").trim() || company.switchboard.trim();
  const first = [escapeHtml(user.name), user.jobTitle?.trim() ? escapeHtml(user.jobTitle.trim()) : "", company.name.trim() ? escapeHtml(company.name.trim()) : ""].filter(Boolean).join(" · ");
  const second = [
    phone ? `<a href="tel:${phone.replace(/[^\d+]/g, "")}" style="color:#475569;text-decoration:none;">${escapeHtml(phone)}</a>` : "",
    user.email.trim() ? `<a href="mailto:${encodeURIComponent(user.email)}" style="color:${accent};text-decoration:none;">${escapeHtml(user.email)}</a>` : "",
  ].filter(Boolean).join(" · ");
  return `
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="font-family:Arial,Helvetica,sans-serif;margin-top:16px;">
  <tr><td style="font-size:13px;line-height:19px;color:#0f172a;"><strong>${first}</strong></td></tr>
  ${second ? `<tr><td style="font-size:13px;line-height:19px;color:#475569;">${second}</td></tr>` : ""}
</table>`;
}
