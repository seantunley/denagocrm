/**
 * Reply, Reply all and Forward from an email on the timeline (Sean, 2026-10-15) —
 * what the composer opens with. Pure: the timeline button hands over the entry,
 * the composer fills itself from this.
 *
 * The timeline keeps an email as PLAIN TEXT (Communication.body: the words, then
 * the "[Attachments: …]", "[Cc: …]", "[Bcc: …]" lines the composer adds). So the
 * quote below a reply is the words without their formatting, and a forward says
 * which files the original carried — the files themselves were never kept.
 */
import { escapeHtml } from "./escapeHtml";

export type ReplyKind = "reply" | "reply-all" | "forward";

/** The timeline's buttons announce an email on this; the composer on the same page listens. */
export const COMPOSE_REPLY_EVENT = "crm:compose-reply";
export type ComposeReplyDetail = { email: TimelineEmail; kind: ReplyKind };

/** One email on the timeline, as the reply buttons hand it to the composer. */
export type TimelineEmail = {
  id: string;
  subject: string | null;
  body: string;
  /** ISO string — it crosses from a server component to the browser. */
  occurredAt: string;
  direction: string | null;
  /** The member of staff on the entry: who wrote it, for an outbound email. */
  staffName: string;
  /** Who it was copied to, from its own column (Communication.cc) — never read out of the words. */
  cc: string | null;
};

const NOTE_LINE = /^\[(Cc|Bcc|Attachments|Sent as secure links[^:]*): (.*)\]$/;

/**
 * The words of the email, and which files it carried. The note lines are the composer's, so they are read only on
 * an email WE sent; an inbound email is quoted exactly as it came — its words may look like a note, and are not one.
 * Who to copy is never taken from here (see TimelineEmail.cc).
 */
export function splitTimelineEmail(body: string, direction: string | null): { text: string; files: string } {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  let files = "";
  while (direction === "outbound" && lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === "") { lines.pop(); continue; }
    const note = NOTE_LINE.exec(last);
    if (!note) break;
    if (note[1] !== "Cc" && note[1] !== "Bcc") files = note[2].trim(); // a Bcc stays hidden: replying never re-copies a blind copy
    lines.pop();
  }
  return { text: lines.join("\n").trimEnd(), files };
}

/** "Re: Your quote", once — "Re: Re: Re:" is what a CRM looks like when nobody checked. */
export function replySubject(subject: string | null, kind: ReplyKind): string {
  const base = String(subject ?? "").trim();
  const prefix = kind === "forward" ? "Fw:" : "Re:";
  if (new RegExp(`^${kind === "forward" ? "(fw|fwd)" : "re"}:`, "i").test(base)) return base;
  return base ? `${prefix} ${base}` : prefix;
}

/**
 * What the composer opens with. `customer` names the other side of an inbound
 * email (the address the composer would write to); `when` is the entry's date as
 * the person reads it. The message starts with two empty lines to type into.
 */
export function replyDraft(email: TimelineEmail, kind: ReplyKind, input: { customer: string; when: string }): {
  subject: string;
  html: string;
  cc: string;
} {
  const { text, files } = splitTimelineEmail(email.body, email.direction);
  const author = email.direction === "inbound" ? input.customer || "The customer" : email.staffName;
  const quoted = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const head =
    kind === "forward"
      ? `<p>---------- Forwarded message ----------<br>From: ${escapeHtml(author)}<br>Date: ${escapeHtml(input.when)}<br>Subject: ${escapeHtml(email.subject ?? "")}</p>`
      : `<p>On ${escapeHtml(input.when)}, ${escapeHtml(author)} wrote:</p>`;
  const filesNote =
    kind === "forward" && files
      ? `<p><em>The original email carried: ${escapeHtml(files)}. Files are not kept on the timeline — attach them again to send them on.</em></p>`
      : "";
  return {
    subject: replySubject(email.subject, kind),
    html: `<p></p><p></p>${filesNote}${head}<blockquote>${quoted}</blockquote>`,
    cc: kind === "reply-all" ? email.cc ?? "" : "",
  };
}

/** A Message-ID fit for an In-Reply-To header: one <id@host>, nothing that could start another header. */
export function threadableMessageId(value: string | null | undefined): string | null {
  const id = String(value ?? "").trim();
  return /^<[^<>\s@]+@[^<>\s@]+>$/.test(id) ? id : null;
}
