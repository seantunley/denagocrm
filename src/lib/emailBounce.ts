import type { ParsedMail } from "mailparser";
import { formatDateTime } from "./format";

/**
 * Bounced email (Sean, 2026-10-26: "Can't have this happening" — a quote to an
 * MWEB customer was refused as "550 High probability of spam", and the only
 * trace was a "Mail delivery failed" notice sitting in the crm@ mailbox).
 *
 * The receiving server refuses AFTER our mail server accepted the email, so
 * the send reported success. The failure comes back later as a delivery-status
 * notice to the CRM's own mailbox, which the IMAP sync reads. This reads that
 * notice: who it failed for, the server's reason, and the Message-ID of the
 * email that failed, so the sync can stamp that exact timeline entry.
 *
 * Only a FAILURE counts. A "still trying" warning (Action: delayed) is not a
 * bounce and is ignored.
 */
export type Bounce = {
  /** Addresses the server says failed, lower-cased. May be empty when only the Message-ID is known. */
  recipients: string[];
  /** The receiving server's words, e.g. "550 High probability of spam". */
  reason: string;
  /** Message-IDs (with <>) of the email that bounced, from its copy inside the notice. */
  originalMessageIds: string[];
};

const MAX_REASON = 300;
const FALLBACK_REASON = "The receiving mail server refused it.";

function header(parsed: ParsedMail, name: string): string {
  const value = parsed.headers?.get(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

/** Is this a delivery-failure notice at all (rather than a customer's email)? */
function looksLikeBounce(parsed: ParsedMail): boolean {
  const ct = parsed.headers?.get("content-type") as { value?: string; params?: Record<string, string> } | undefined;
  if (ct?.value?.toLowerCase() === "multipart/report" && /delivery-status/i.test(ct.params?.["report-type"] ?? "")) return true;
  if (header(parsed, "x-failed-recipients")) return true;
  const from = parsed.from?.value?.[0]?.address ?? "";
  const subject = parsed.subject ?? "";
  return /^(mailer-daemon|postmaster)@/i.test(from)
    && /(undeliver|delivery (status notification \(failure\)|has failed|failure)|mail delivery failed|returned mail|failure notice|could not be delivered|not delivered)/i.test(subject);
}

/** Header lines joined back onto one line each (RFC 5322 folding). */
const unfold = (text: string) => text.replace(/\r?\n[ \t]+/g, " ");

/** The header block of an embedded email: everything before the first blank line. */
const headerBlock = (text: string) => text.split(/\r?\n\r?\n/, 1)[0] ?? "";

function originalHeaderBlocks(parsed: ParsedMail): string[] {
  const blocks: string[] = [];
  for (const a of parsed.attachments ?? []) {
    const type = (a.contentType ?? "").toLowerCase();
    if (type === "message/rfc822" || type === "text/rfc822-headers" || type === "message/rfc822-headers" || type === "message/global") {
      blocks.push(headerBlock(a.content.toString("utf8").slice(0, 64_000)));
    }
  }
  // Exim's plain-text bounce (no DSN) pastes the original after this line.
  const text = parsed.text ?? "";
  const marker = text.search(/^-+ This is a copy of (the|your) message/im);
  if (marker >= 0) blocks.push(headerBlock(text.slice(marker).replace(/^.*\r?\n/, "")));
  return blocks;
}

/** A delivery-status notice → what failed and why; null when it isn't one, or is only a delay. */
export function readBounce(parsed: ParsedMail): Bounce | null {
  if (!looksLikeBounce(parsed)) return null;
  const text = unfold(parsed.text ?? "");

  const actions = [...text.matchAll(/^Action:\s*(\w+)/gim)].map((m) => m[1].toLowerCase());
  // A DSN that reports actions but no failure is a "still trying" or "delivered" notice.
  if (actions.length && !actions.includes("failed")) return null;
  if (!actions.length && /\b(delay(ed)?|warning|will (continue|keep) trying|not yet been delivered)\b/i.test(parsed.subject ?? "")) return null;

  const recipients = new Set<string>();
  for (const addr of header(parsed, "x-failed-recipients").split(",")) if (addr.trim()) recipients.add(addr.trim().toLowerCase());
  for (const m of text.matchAll(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)) recipients.add(m[1].toLowerCase());

  const diagnostic = text.match(/^Diagnostic-Code:\s*(?:smtp;\s*)?(.+)$/im)?.[1];
  // Read before unfolding: Exim indents the server's reply under the address, which unfolding would join.
  const smtpLine = (parsed.text ?? "").match(/^\s*([45]\d\d[ -].+)$/m)?.[1];
  const reason = (diagnostic ?? smtpLine ?? FALLBACK_REASON).trim().replace(/\s+/g, " ").slice(0, MAX_REASON);

  const originalMessageIds = [
    ...new Set(
      originalHeaderBlocks(parsed)
        .map((block) => unfold(block).match(/^Message-ID:\s*(<[^<>\s]+>)/im)?.[1])
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (!recipients.size && !originalMessageIds.length) return null; // nothing to tie it to
  return { recipients: [...recipients], reason, originalMessageIds };
}

/** The timeline badge for an email that bounced, or null. One wording for every timeline. */
export function bouncedLabel(c: { direction: string | null; bouncedAt?: Date | null; bounceReason?: string | null }): string | null {
  if (c.direction !== "outbound" || !c.bouncedAt) return null;
  return `⚠ Not delivered · ${formatDateTime(c.bouncedAt)}${c.bounceReason ? ` — ${c.bounceReason}` : ""}`;
}

export const BOUNCE_HINT =
  "The customer's mail server refused this email, so they never received it. Contact them another way, or check their address.";
