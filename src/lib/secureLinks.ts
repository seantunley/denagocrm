/**
 * Secure links — the rules, pure (Sean, 2026-10-11, after looking at Mimecast's
 * Secure Messaging: "a link with an expiry date, a read receipt and a recall
 * button", for ID copies, finance documents and large files).
 *
 * An attachment is a copy the sender can never take back: it sits in the
 * customer's mailbox, and in every mailbox it is forwarded to, for good. A
 * secure link keeps the file in OUR store and puts only a link in the email. So
 * it can stop working on a date, be recalled the moment it went to the wrong
 * person, and tell the sender when it was first downloaded.
 *
 * What it is NOT: proof of who downloaded it. Whoever holds the link can use it
 * until it expires or is recalled — the same as the email itself. It limits how
 * long and how far a document travels; it does not identify the reader.
 */
import { escapeHtml } from "./escapeHtml";

/** How long a link may live, in days, as offered in the composer. */
export const SECURE_LINK_DAYS = [1, 3, 7, 14, 30] as const;
export const SECURE_LINK_DEFAULT_DAYS = 7;

/** The value in a link: 32 random bytes as base64url. */
export const SECURE_LINK_TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

/** The number of days asked for, if it is one of the choices; otherwise the default. Never longer than the longest. */
export function secureLinkDays(value: unknown): number {
  const days = Number(value);
  return (SECURE_LINK_DAYS as readonly number[]).includes(days) ? days : SECURE_LINK_DEFAULT_DAYS;
}

/** A link sent now, for `days`, stops working at this moment. */
export function secureLinkExpiry(now: Date, days: number): Date {
  return new Date(now.getTime() + secureLinkDays(days) * 86_400_000);
}

export type SecureLinkState = "active" | "expired" | "recalled";

/** Recalled wins over expired: it is the more useful thing to tell someone holding the link. */
export function secureLinkState(link: { expiresAt: Date; revokedAt: Date | null }, now: Date): SecureLinkState {
  if (link.revokedAt) return "recalled";
  return link.expiresAt <= now ? "expired" : "active";
}

/** "1.4 MB", "320 KB" — what a person needs to decide whether to download on mobile data. */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export type SecureLinkLine = { name: string; url: string; sizeBytes: number };

/**
 * The block that stands in the email where the attachments would have been:
 * what each file is, where to get it, and until when. Appended to the message
 * BEFORE the signature, so it reads as part of what the sender wrote.
 */
export function secureLinksHtml(links: readonly SecureLinkLine[], expiresLabel: string): string {
  if (links.length === 0) return "";
  const rows = links
    .map((link) => {
      const size = fileSizeLabel(link.sizeBytes);
      return `<li style="margin:0 0 6px;"><a href="${escapeHtml(link.url)}" style="color:#ea580c;font-weight:bold;text-decoration:underline;">${escapeHtml(link.name)}</a>${size ? ` <span style="color:#64748b;">(${size})</span>` : ""}</li>`;
    })
    .join("");
  return `<div style="margin:18px 0 0;padding:14px 16px;border:1px solid #e2e8f0;border-radius:8px;background-color:#f8fafc;">
<p style="margin:0 0 8px;font-weight:bold;color:#0f172a;">${links.length === 1 ? "A file for you — open it with this secure link" : `${links.length} files for you — open them with these secure links`}</p>
<ul style="margin:0 0 8px;padding-left:18px;">${rows}</ul>
<p style="margin:0;font-size:12px;color:#64748b;">${links.length === 1 ? "The link works" : "The links work"} until ${escapeHtml(expiresLabel)}. Please don't forward ${links.length === 1 ? "it" : "them"} — anyone with the link can open the file.</p>
</div>`;
}

/** The same, for the plain-text part of the email. */
export function secureLinksText(links: readonly SecureLinkLine[], expiresLabel: string): string {
  if (links.length === 0) return "";
  const rows = links.map((link) => `- ${link.name}${fileSizeLabel(link.sizeBytes) ? ` (${fileSizeLabel(link.sizeBytes)})` : ""}: ${link.url}`).join("\n");
  return `\n\n${links.length === 1 ? "A file for you — open it with this secure link" : "Files for you — open them with these secure links"} (until ${expiresLabel}):\n${rows}`;
}

/** What staff see beside a link they sent. */
export function secureLinkSummary(link: { expiresAt: Date; revokedAt: Date | null; firstOpenedAt: Date | null; openCount: number }, now: Date, format: (date: Date) => string): { state: SecureLinkState; status: string; opened: string } {
  const state = secureLinkState(link, now);
  const status = state === "recalled" ? `Recalled ${format(link.revokedAt!)}` : state === "expired" ? `Expired ${format(link.expiresAt)}` : `Works until ${format(link.expiresAt)}`;
  const opened = link.firstOpenedAt ? `Downloaded ${format(link.firstOpenedAt)}${link.openCount > 1 ? ` · ${link.openCount}×` : ""}` : "Not downloaded yet";
  return { state, status, opened };
}

/** A file name safe to put in a Content-Disposition header: no quotes, slashes, control characters or line breaks. */
export function downloadFileName(name: string): { ascii: string; encoded: string } {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, "_").trim().slice(0, 150) || "file";
  return { ascii: clean.replace(/[^\x20-\x7e]/g, "_"), encoded: encodeURIComponent(clean) };
}
