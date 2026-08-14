/**
 * The `Reply-To` header — parsing, validating and composing it.
 *
 * PURE, and separate from the action that uses it, for the usual two reasons: it
 * is the half worth testing directly, and `emails.ts` is a `"use server"` module
 * which may only export async functions.
 *
 * ── WHY THE FIELD EXISTS ────────────────────────────────────────────────────
 *
 * Mail sent from the CRM goes out as the WORKSPACE (`SMTP_FROM`), so a customer's
 * reply lands wherever that address delivers — and if that is the shared mailbox
 * the IMAP sync reads, the reply reaches the timeline but not the person who wrote
 * it. If it is the salesperson's own mailbox, the reverse. `Reply-To` takes a
 * LIST, so it can be both: the reply arrives in the rep's inbox as normal AND in
 * the mailbox that files it against the record.
 *
 * ── THIS VALUE REACHES A HEADER, SO IT IS VALIDATED HARD ────────────────────
 *
 * A header value containing CR or LF is header injection: everything after the
 * newline is parsed as a new header, which is how a free-form field becomes a way
 * to add `Bcc:` to mail the workspace sends. Nodemailer does its own encoding, but
 * "the library probably handles it" is not a control — the address list is
 * validated here, before it is anywhere near the transport, and anything that is
 * not a plain address is REJECTED rather than stripped.
 *
 * Rejected, not sanitised, on purpose: silently dropping part of what someone
 * typed produces mail whose replies go somewhere they did not ask for and were
 * not told about. A refusal they can read is better than a header they cannot see.
 */

/**
 * A single address, deliberately stricter than RFC 5322.
 *
 * No display names (`Sean <sean@…>`), no quoted local parts, no comments. Those
 * are all legal and none of them is needed here — the field is filled from a
 * default and occasionally edited — and every one of them widens what has to be
 * escaped correctly on the way to a header. One shape, checkable at a glance.
 */
const ADDRESS = /^[^\s<>@,;:\\"[\]]+@[^\s<>@,;:\\"[\]]+\.[^\s<>@,;:\\"[\]]+$/;

/** Whether one string is an address this module will put in a header. */
export function isReplyToAddress(value: string): boolean {
  // The length cap is not cosmetic: header folding gets involved past a few
  // hundred characters, and no legitimate address is anywhere near it.
  return value.length <= 254 && ADDRESS.test(value);
}

export type ReplyToResult =
  | { ok: true; value: string | null }
  | { ok: false; invalid: string[] };

/**
 * Parse what someone typed into the field.
 *
 * Empty means "no Reply-To" — `{ ok: true, value: null }` — and that is a real
 * choice rather than a failure: without the header, replies go to the From
 * address, which is what happened before this field existed.
 *
 * Duplicates are removed case-insensitively while keeping the first spelling, so
 * a default that already contains the rep's address does not double it when the
 * CRM mailbox is the same address.
 */
export function parseReplyTo(raw: string): ReplyToResult {
  const parts = raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: true, value: null };

  const invalid = parts.filter((part) => !isReplyToAddress(part));
  if (invalid.length > 0) return { ok: false, invalid };

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  // A cap, because this is a header and the field is free-form. Five is far more
  // than the two the default composes and still bounded.
  if (unique.length > MAX_REPLY_TO) return { ok: false, invalid: [`more than ${MAX_REPLY_TO} addresses`] };
  return { ok: true, value: unique.join(", ") };
}

export const MAX_REPLY_TO = 5;

/**
 * The default the composer offers: the sender, then the CRM's own mailbox.
 *
 * In that order because it is the order of importance to the person replying's
 * recipient — the human first, the system second — and because some clients show
 * only the first address.
 *
 * Either may be absent. A workspace with no IMAP configured has no mailbox that
 * would file the reply, so the default is just the sender; a sender with no
 * address on their user record contributes nothing. Both absent yields an empty
 * string, and the composer then shows an empty field rather than a broken one.
 *
 * `crmMailbox` is whatever IMAP is configured to read, which is not guaranteed to
 * be an address at all — some servers take a bare username — so it is included
 * only when it looks like one. Putting a username in Reply-To would produce mail
 * whose replies bounce.
 */
export function defaultReplyTo(input: {
  senderEmail: string | null | undefined;
  crmMailbox: string | null | undefined;
}): string {
  const candidates = [input.senderEmail, input.crmMailbox]
    .map((value) => (value ?? "").trim())
    .filter((value) => value && isReplyToAddress(value));
  const result = parseReplyTo(candidates.join(", "));
  return result.ok ? result.value ?? "" : "";
}
