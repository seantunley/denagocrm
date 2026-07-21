import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getSetting, putSetting } from "./settings";
import { sendPushToAll } from "./push";
import { sendEmail } from "./email";
import { contactName } from "./format";
import { normalizeHtml } from "./competitors";
import { logError } from "./errorLog";

/** Strip repeated Re:/Fwd: prefixes and lower-case, for subject-based threading. */
function normalizeSubject(s: string): string {
  let t = s.trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^\s*(re|fwd?|fw|aw)\s*:\s*/i, "");
  } while (t !== prev);
  return t.trim().toLowerCase();
}

/** Auto-generated / no-reply mail we must never auto-reply to (loop guard). */
function looksAutomated(parsed: ParsedMail, fromEmail: string): boolean {
  const auto = parsed.headers?.get("auto-submitted");
  const autoStr = typeof auto === "string" ? auto : "";
  if (autoStr && autoStr.toLowerCase() !== "no") return true;
  return /(no-?reply|mailer-daemon|postmaster|do-?not-?reply)/i.test(fromEmail);
}

/** The Message-IDs this mail is a reply to (In-Reply-To + References), for threading. */
function referencedIds(parsed: ParsedMail): string[] {
  const ids: string[] = [];
  if (parsed.inReplyTo) ids.push(parsed.inReplyTo);
  const refs = parsed.references;
  if (Array.isArray(refs)) ids.push(...refs);
  else if (refs) ids.push(refs);
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}

/** Plain-text body: the text part, else the HTML rendered down to text. */
function emailBody(parsed: ParsedMail, limit: number): string {
  const text = (parsed.text ?? "").trim();
  if (text) return text.slice(0, limit);
  if (parsed.html) return normalizeHtml(parsed.html).text.slice(0, limit) || "[HTML email — open the ticket to view]";
  return "";
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** The active support mailbox this mail was addressed to (To/Cc), if any. */
async function matchSupportMailbox(parsed: ParsedMail) {
  const addrs = [parsed.to, parsed.cc].flatMap((a) =>
    a ? (Array.isArray(a) ? a : [a]).flatMap((x) => x.value ?? []) : [],
  );
  const recipients = new Set(addrs.map((a) => a.address?.toLowerCase()).filter(Boolean) as string[]);
  if (recipients.size === 0) return null;
  const boxes = await prisma.supportMailbox.findMany({ where: { active: true, email: { not: null } } });
  return boxes.find((b) => b.email && recipients.has(b.email.toLowerCase())) ?? null;
}

type Mailbox = NonNullable<Awaited<ReturnType<typeof matchSupportMailbox>>>;

/**
 * Find the ticket this email belongs to, if any. Prefers real reply-header
 * threading (In-Reply-To/References → a message we already filed), then falls
 * back to matching the normalized subject against ANY of this contact's recent
 * non-closed tickets in the mailbox (not just the single most recent one).
 */
async function findThreadCase(mailbox: Mailbox, contactId: string, parsed: ParsedMail, norm: string) {
  const refs = referencedIds(parsed);
  if (refs.length) {
    const prior = await prisma.customerCaseMessage.findFirst({
      where: { sourceMessageId: { in: refs }, case: { mailboxId: mailbox.id, status: { not: "closed" } } },
      orderBy: { createdAt: "desc" },
      include: { case: true },
    });
    if (prior?.case) return prior.case;
  }
  const recent = await prisma.customerCase.findMany({
    where: { contactId, mailboxId: mailbox.id, status: { not: "closed" } },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
  return recent.find((c) => normalizeSubject(c.subject) === norm) ?? null;
}

/**
 * Turn a support-mailbox email into a ticket: resolve/create the sender contact,
 * thread onto an open ticket (by reply headers or subject) or open a new one,
 * append the message, and (only on a NEW ticket, never to automated mail) send
 * the mailbox's auto-reply. Idempotent on the email's Message-ID, so a retry or
 * an overlapping run never files it twice. Returns true when newly filed.
 */
async function fileSupportEmail(mailbox: Mailbox, parsed: ParsedMail, fromEmail: string): Promise<boolean> {
  const messageId = parsed.messageId ?? null;
  // Already filed (retry / replay after a poison message) — nothing to do.
  if (messageId) {
    const seen = await prisma.customerCaseMessage.findUnique({ where: { sourceMessageId: messageId } });
    if (seen) return false;
  }

  const fromName = parsed.from?.value?.[0]?.name?.trim() || fromEmail.split("@")[0];
  let contact = await prisma.contact.findFirst({ where: { email: { equals: fromEmail, mode: "insensitive" } } });
  if (!contact) {
    const [first, ...rest] = fromName.split(/\s+/);
    contact = await prisma.contact.create({
      data: { firstName: first || fromEmail, lastName: rest.join(" ") || null, email: fromEmail, source: "email" },
    });
  }

  const rawSubject = (parsed.subject ?? "").trim() || "(no subject)";
  const norm = normalizeSubject(rawSubject);
  const body = emailBody(parsed, 10000);
  const when = parsed.date ?? new Date();

  const existing = await findThreadCase(mailbox, contact.id, parsed, norm);
  const isNew = !existing;

  let caseId: string;
  let caseNumber: bigint;
  try {
    if (existing) {
      await prisma.customerCase.update({
        where: { id: existing.id },
        data: {
          status: existing.status === "resolved" ? "open" : existing.status,
          lastReplyAt: when,
          lastReplyBy: "customer",
          messages: { create: { contactId: contact.id, direction: "customer", type: "message", body, sourceMessageId: messageId } },
        },
      });
      caseId = existing.id;
      caseNumber = existing.number;
    } else {
      const created = await prisma.customerCase.create({
        data: {
          subject: rawSubject.slice(0, 200),
          description: body,
          type: "support",
          status: "new",
          source: "email",
          contactId: contact.id,
          mailboxId: mailbox.id,
          lastReplyAt: when,
          lastReplyBy: "customer",
          messages: { create: { contactId: contact.id, direction: "customer", type: "message", body, sourceMessageId: messageId } },
        },
        select: { id: true, number: true },
      });
      caseId = created.id;
      caseNumber = created.number;
    }
  } catch (e) {
    // A concurrent run filed this same email first (unique Message-ID) — not an error.
    if (isUniqueViolation(e)) return false;
    throw e;
  }

  if (isNew && mailbox.autoReplyEnabled && mailbox.autoReplyBody && !looksAutomated(parsed, fromEmail)) {
    const sig = mailbox.signature ? `\n\n${mailbox.signature}` : "";
    await sendEmail({
      to: fromEmail,
      subject: `Re: ${rawSubject} [C-${caseNumber}]`,
      text: `${mailbox.autoReplyBody}${sig}`,
    }).catch(() => {});
  }

  await sendPushToAll(
    {
      title: isNew ? `🎫 New ticket · ${mailbox.name}` : `💬 Ticket reply · ${mailbox.name}`,
      body: `${contactName(contact)}: ${rawSubject}`.slice(0, 100),
      url: `/cases/${caseId}`,
    },
    "email_in",
  ).catch(() => {});
  return true;
}

/** File a reply from a known contact/lead onto the timeline. Idempotent on Message-ID. */
async function fileTimelineEmail(parsed: ParsedMail, fromEmail: string): Promise<boolean> {
  const messageId = parsed.messageId ?? null;
  if (messageId) {
    const seen = await prisma.communication.findFirst({ where: { messageId } });
    if (seen) return false; // already filed on a previous run
  }
  const contact = await prisma.contact.findFirst({ where: { email: { equals: fromEmail, mode: "insensitive" } } });
  const lead = contact
    ? null
    : await prisma.lead.findFirst({ where: { email: { equals: fromEmail, mode: "insensitive" }, status: "open" } });
  if (!contact && !lead) return false; // unknown sender — leave in the mailbox

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return false;

  await prisma.communication.create({
    data: {
      type: "email",
      direction: "inbound",
      subject: parsed.subject ?? "(no subject)",
      body: emailBody(parsed, 5000),
      occurredAt: parsed.date ?? new Date(),
      messageId,
      inReplyTo: parsed.inReplyTo ?? null,
      references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references ?? null,
      contactId: contact?.id ?? lead?.contactId ?? null,
      leadId: lead?.id ?? null,
      userId: firstUser.id,
    },
  });
  await sendPushToAll(
    {
      title: "📧 Email reply",
      body: `${contact ? contactName(contact) : lead?.name}: ${parsed.subject ?? ""}`.slice(0, 100),
      url: contact ? `/contacts/${contact.id}` : `/leads/${lead?.id}`,
    },
    "email_in",
  ).catch(() => {});
  return true;
}

/** Route one parsed message. Throws on real errors (so the sync retries it). */
async function handleParsedMessage(parsed: ParsedMail, ourAddress: string): Promise<boolean> {
  const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!fromEmail) return false;
  if (fromEmail === ourAddress) return false; // our own sent mail

  // Help desk: mail addressed to a support mailbox becomes a ticket (create or
  // thread), incl. mail from brand-new senders. Everything else files onto the
  // known contact's/lead's timeline.
  const mailbox = await matchSupportMailbox(parsed);
  if (mailbox) return fileSupportEmail(mailbox, parsed, fromEmail);
  return fileTimelineEmail(parsed, fromEmail);
}

const SYNC_LOCK = "IMAP_SYNC_LOCK";
const SYNC_LOCK_TTL_MS = 10 * 60 * 1000;
const POISON_MAX_TRIES = 5;

/** Best-effort overlap guard (correctness is guaranteed by the Message-ID keys). */
async function acquireSyncLock(): Promise<boolean> {
  const raw = await getSetting(SYNC_LOCK);
  if (raw) {
    const since = parseInt(raw, 10);
    if (Number.isFinite(since) && Date.now() - since < SYNC_LOCK_TTL_MS) return false;
  }
  await putSetting(SYNC_LOCK, String(Date.now()));
  return true;
}

/** Count consecutive failed attempts on the same stuck UID; reset when it moves. */
async function bumpStuck(uid: number): Promise<number> {
  const prevUid = await getSetting("IMAP_STUCK_UID");
  const prevTries = parseInt((await getSetting("IMAP_STUCK_TRIES")) || "0", 10) || 0;
  const tries = String(uid) === prevUid ? prevTries + 1 : 1;
  await putSetting("IMAP_STUCK_UID", String(uid));
  await putSetting("IMAP_STUCK_TRIES", String(tries));
  return tries;
}
async function clearStuck(): Promise<void> {
  if (await getSetting("IMAP_STUCK_UID")) {
    await putSetting("IMAP_STUCK_UID", "");
    await putSetting("IMAP_STUCK_TRIES", "0");
  }
}

/**
 * Pulls new inbox mail via IMAP and files it (support tickets or timeline).
 * Read-only on the mailbox (flags untouched); progress tracked by UID. The UID
 * cursor only advances past messages that were handled cleanly, so a transient
 * failure retries next run instead of being skipped for good; a message that
 * fails POISON_MAX_TRIES times is logged and stepped over so it can't wedge the
 * queue. Filing is idempotent on the email Message-ID, so those retries — and
 * any overlapping run — never produce a duplicate ticket, reply or timeline row.
 */
export async function syncInboundEmail(): Promise<number> {
  const [host, portRaw, secureRaw, user, pass] = await Promise.all([
    getSetting("IMAP_HOST"),
    getSetting("IMAP_PORT"),
    getSetting("IMAP_SECURE"),
    getSetting("IMAP_USER"),
    getSetting("IMAP_PASS"),
  ]);
  if (!host || !user || !pass) return 0;
  if (!(await acquireSyncLock())) return 0; // another run is in progress

  const client = new ImapFlow({
    host,
    port: portRaw ? parseInt(portRaw, 10) : 993,
    secure: secureRaw !== "false",
    auth: { user, pass },
    logger: false,
  });

  let filed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const lastUidRaw = await getSetting("IMAP_LAST_UID");
      const mailbox = client.mailbox;
      const uidNext = typeof mailbox === "object" ? mailbox.uidNext : undefined;
      if (!lastUidRaw) {
        // First run: start from now — don't import the whole mailbox history
        if (uidNext) await putSetting("IMAP_LAST_UID", String(uidNext - 1));
        return 0;
      }
      const lastUid = parseInt(lastUidRaw, 10);
      const ourAddress = user.toLowerCase();
      let maxSeen = lastUid;
      let advanceTo = lastUid; // highest contiguously-handled UID
      let blocked = false; // a message failed — stop advancing past it
      let firstFail = 0;

      for await (const msg of client.fetch(
        { uid: `${lastUid + 1}:*` },
        { uid: true, source: true },
        { uid: true }
      )) {
        if (msg.uid <= lastUid) continue; // IMAP quirk: range can echo the last message
        if (msg.uid > maxSeen) maxSeen = msg.uid;
        try {
          if (msg.source) {
            const parsed = await simpleParser(msg.source);
            if (await handleParsedMessage(parsed, ourAddress)) filed++;
          }
          if (!blocked) advanceTo = msg.uid; // contiguous success — safe to advance the cursor here
        } catch (e) {
          if (!blocked) {
            blocked = true;
            firstFail = msg.uid;
          }
          await logError("imap-sync", e);
        }
      }

      if (!blocked) {
        if (maxSeen > lastUid) await putSetting("IMAP_LAST_UID", String(maxSeen));
        await clearStuck();
      } else {
        const tries = await bumpStuck(firstFail);
        if (tries >= POISON_MAX_TRIES) {
          await logError("imap-sync", `Skipping poison message uid=${firstFail} after ${tries} attempts`);
          await putSetting("IMAP_LAST_UID", String(firstFail)); // step over it
          await clearStuck();
        } else if (advanceTo > lastUid) {
          await putSetting("IMAP_LAST_UID", String(advanceTo)); // keep the failing UID for retry
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
    await putSetting(SYNC_LOCK, ""); // release the overlap guard
  }
  return filed;
}
