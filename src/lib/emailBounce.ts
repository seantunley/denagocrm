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
/** One address that FAILED, with the receiving server's own words for it ("550 High probability of spam"). */
export type BounceFailure = { address: string | null; reason: string };

export type Bounce = {
  /**
   * Only the recipients whose delivery failed — a report can also list ones that
   * were delivered or are still being tried, and those are left out (review of
   * #907). `address` is null when the notice names nobody.
   */
  failures: BounceFailure[];
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

/** A `Name: value` line in one delivery-status block. */
const field = (block: string, name: string) => block.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();

/** The address in a Final-Recipient / Original-Recipient value ("rfc822; a@b.c"). */
const addressIn = (value: string | undefined) => value?.match(/^(?:[\w-]+;\s*)?<?([^\s<>;]+@[^\s<>;]+?)>?$/)?.[1]?.toLowerCase() ?? null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A mail server's refusal in plain words, with its codes once at the end (Sean,
 * 2026-10-26). Servers reply over several lines with the code repeated on each
 * ("550-5.1.1 The email account … 550-5.1.1 double-checking …"), and Google adds
 * a help link and a tracking id:
 *   "The email account that you tried to reach does not exist. Please try
 *    double-checking the recipient's email address for typos or unnecessary spaces. (550 5.1.1)"
 * Only the reply's OWN code is taken out, so a number in the words survives.
 * Idempotent: a reason already tidied comes back unchanged, so old rows can be shown through it.
 */
export function tidyReason(raw: string): string {
  let text = raw.replace(/^smtp;\s*/i, "").replace(/\s+/g, " ").trim();
  const lead = text.match(/^([245]\d\d)(?:[ -]+(\d\.\d{1,3}\.\d{1,3}))?(?=[\s-]|$)/);
  if (!lead) return text;
  const [, basic, enhanced] = lead;
  // A repeated code is the full "550-5.1.1" / "550 5.1.1", or a bare "550-" continuation —
  // never "550 " on its own mid-text, which is a number in the words.
  const repeated = enhanced ? `${basic}[ -]+${escapeRe(enhanced)}|${basic}-` : `${basic}-`;
  text = text
    .replace(new RegExp(`^${basic}[ -]+(?:${enhanced ? escapeRe(enhanced) : "(?!)"}\\s*)?`), "")
    .replace(new RegExp(`(^|\\s)(?:${repeated})\\s*`, "g"), "$1")
    .replace(/\s*(?:For more information,? (?:go to|see|visit)\s*)?https?:\/\/\S+/gi, "")
    .replace(/\s*-\s*gsmtp\s*$/i, "")
    .replace(/\s+[a-z0-9]{8,}-[a-z0-9.]{10,}\s*$/i, "") // Google's per-message tracking id
    .replace(/\s+/g, " ")
    .trim();
  const code = enhanced ? `${basic} ${enhanced}` : basic;
  return text ? `${text} (${code})` : code;
}

const cleanReason = (value: string | null | undefined) =>
  value ? tidyReason(value).slice(0, MAX_REASON) || null : null;

/** A delivery-status notice → what failed and why; null when it isn't one, or reports no failure. */
export function readBounce(parsed: ParsedMail): Bounce | null {
  if (!looksLikeBounce(parsed)) return null;
  const raw = parsed.text ?? "";
  // Read before unfolding: Exim indents the server's reply under the address, which unfolding would join.
  const fallback = cleanReason(raw.match(/^\s*([45]\d\d[ -].+)$/m)?.[1]) ?? FALLBACK_REASON;

  const failures = new Map<string | null, string>();
  // A delivery-status report: one block per recipient, each with its OWN Action.
  // Split on blank lines BEFORE unfolding, which would join a whitespace-only line onto its neighbour.
  const blocks = raw.split(/\r?\n[ \t]*\r?\n/).map(unfold).filter((block) => /^Action:/im.test(block));
  if (blocks.length) {
    for (const block of blocks) {
      if (field(block, "Action")?.split(/\s/)[0]?.toLowerCase() !== "failed") continue; // delivered, delayed, relayed…
      const address = addressIn(field(block, "Final-Recipient")) ?? addressIn(field(block, "Original-Recipient"));
      if (!failures.has(address)) failures.set(address, cleanReason(field(block, "Diagnostic-Code")) ?? fallback);
    }
    if (!failures.size) return null; // a "still trying" or "delivered" report
  } else {
    // No report: Exim's plain bounce lists exactly the failed addresses in a header.
    if (/\b(delay(ed)?|warning|will (continue|keep) trying|not yet been delivered)\b/i.test(parsed.subject ?? "")) return null;
    for (const address of header(parsed, "x-failed-recipients").split(",")) {
      const a = address.trim().toLowerCase();
      if (a && !failures.has(a)) failures.set(a, fallback);
    }
  }

  const originalMessageIds = [
    ...new Set(
      originalHeaderBlocks(parsed)
        .map((block) => unfold(block).match(/^Message-ID:\s*(<[^<>\s]+>)/im)?.[1])
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (!originalMessageIds.length && ![...failures.keys()].some(Boolean)) return null; // nothing to tie it to
  if (!failures.size) failures.set(null, fallback); // the email is known, the address isn't
  return { failures: [...failures].map(([address, reason]) => ({ address, reason })), originalMessageIds };
}

/**
 * What an email keeps in `Communication.bounceReason`: one line per failed
 * address ("erik@x.co.za: 550 …"), so an email to several people says exactly
 * which of them it failed for. Just the reason when the notice names no address.
 */
export function bounceLines(b: Bounce): string[] {
  return b.failures.map((f) => (f.address ? `${f.address}: ${f.reason}` : f.reason));
}

/** The failed addresses a notice names. */
export const failedAddresses = (b: Bounce) => b.failures.flatMap((f) => (f.address ? [f.address] : []));

/** Which line a failure is: its address, or the whole line when it has none. */
const lineKey = (line: string) => line.match(/^([^\s:]+@[^\s:]+): /)?.[1] ?? line;

/** The lines a notice adds to what an email already records. None = this failure is already filed. */
export function newBounceLines(recorded: string | null | undefined, lines: string[]): string[] {
  const have = new Set((recorded ?? "").split("\n").filter(Boolean).map(lineKey));
  return lines.filter((line) => !have.has(lineKey(line)));
}

/** The timeline badge for an email that bounced, or null. One wording for every timeline. */
export function bouncedLabel(c: { direction: string | null; bouncedAt?: Date | null; bounceReason?: string | null }): string | null {
  if (c.direction !== "outbound" || !c.bouncedAt) return null;
  // Tidied again on the way out, so a reason stored before tidyReason existed reads the same.
  const reason = (c.bounceReason ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^\s:]+@[^\s:]+): (.*)$/);
      return m ? `${m[1]}: ${tidyReason(m[2])}` : tidyReason(line);
    })
    .join("; ");
  return `⚠ Not delivered · ${formatDateTime(c.bouncedAt)}${reason ? ` — ${reason}` : ""}`;
}

export const BOUNCE_HINT =
  "The customer's mail server refused this email, so they never received it. Contact them another way, or check their address.";
