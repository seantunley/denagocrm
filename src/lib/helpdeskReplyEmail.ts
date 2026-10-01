/**
 * Emailing a help desk reply: who gets it, how it threads, and what the agent is
 * told. Pure — the action in app/actions/helpdesk.ts does the sending.
 *
 * A reply used to be saved to the ticket and the portal only, while the composer
 * said "Reply sent". A customer who wrote in by email never saw it.
 */

/** Why a reply was, or was not, emailed. Stored on the reply's `meta.email`. */
export type ReplyEmailOutcome =
  | { status: "sent"; to: string; messageId: string }
  | { status: "failed"; to: string; error: string }
  | { status: "skipped"; reason: "no_email" | "no_mailbox" };

/**
 * Email the reply when the customer has an address AND the ticket is an email
 * conversation: it came in by email, or it sits in a mailbox with an address
 * (so the customer's answer comes back to the ticket).
 */
export function replyEmailRecipient(input: {
  source: string;
  contactEmail: string | null | undefined;
  mailboxEmail: string | null | undefined;
}): { to: string } | { skip: "no_email" | "no_mailbox" } {
  const to = input.contactEmail?.trim();
  if (!to) return { skip: "no_email" };
  if (input.source !== "email" && !input.mailboxEmail?.trim()) return { skip: "no_mailbox" };
  return { to };
}

// An RFC 5322 msg-id as mailparser hands it over: `<left@right>`, no whitespace.
// These come from INBOUND headers, so anything else is dropped — a CR/LF here
// would be header injection on our outgoing mail.
const MSG_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/**
 * In-Reply-To / References for the reply, from the case's messages in order.
 *
 * `sourceMessageId` is `msg:<Message-ID>` for every emailed message on the case —
 * the customer's (imapSync) and ours (set when a reply is emailed) — so the chain
 * is already on the case. References keeps the first id (the thread root) and the
 * most recent ones, which is what mail clients thread on.
 */
export function replyThreadHeaders(sourceMessageIds: Array<string | null | undefined>): Record<string, string> | undefined {
  const ids = sourceMessageIds
    .filter((k): k is string => typeof k === "string" && k.startsWith("msg:"))
    .map((k) => k.slice(4))
    .filter((id) => MSG_ID.test(id));
  const unique = [...new Set(ids)];
  if (unique.length === 0) return undefined;
  const refs = unique.length > 10 ? [unique[0], ...unique.slice(-9)] : unique;
  return { "In-Reply-To": unique[unique.length - 1], References: refs.join(" ") };
}

/** A fresh Message-ID for our reply, on the mailbox's domain when it has one. */
export function newReplyMessageId(uuid: string, fromAddress: string | null | undefined): string {
  const domain = fromAddress?.split("@")[1]?.trim().toLowerCase();
  return `<${uuid}@${domain && /^[a-z0-9.-]+$/.test(domain) ? domain : "helpdesk.local"}>`;
}

/** What the agent who pressed Send is told. Says what happened, not what was hoped. */
export function replyOutcomeText(outcome: ReplyEmailOutcome): string {
  switch (outcome.status) {
    case "sent":
      return `Emailed to ${outcome.to}`;
    case "failed":
      return `Saved to the ticket and portal, but the email to ${outcome.to} FAILED: ${outcome.error}`;
    case "skipped":
      return outcome.reason === "no_email"
        ? "Posted to portal only — no email on file"
        : "Posted to portal only — this ticket has no help desk mailbox to email from";
  }
}

/** The same outcome, short, for under the reply in the ticket thread. */
export function replyDeliveryNote(meta: unknown): { text: string; failed: boolean } | null {
  const email = (meta as { email?: ReplyEmailOutcome } | null)?.email;
  if (!email || typeof email !== "object") return null;
  if (email.status === "sent") return { text: `Emailed to ${email.to}`, failed: false };
  if (email.status === "failed") return { text: `Email to ${email.to} failed — portal only`, failed: true };
  if (email.status === "skipped") return { text: "Portal only — not emailed", failed: false };
  return null;
}
