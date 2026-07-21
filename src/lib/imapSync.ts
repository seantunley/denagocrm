import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { prisma } from "./db";
import { getSetting, putSetting } from "./settings";
import { sendPushToAll } from "./push";
import { sendEmail } from "./email";
import { contactName } from "./format";

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
 * Turn a support-mailbox email into a ticket: resolve/create the sender contact,
 * thread onto an open ticket with the same subject or open a new one, append the
 * message, and (only on a NEW ticket, never to automated mail) send the mailbox's
 * auto-reply. Returns true when filed.
 */
async function fileSupportEmail(mailbox: Mailbox, parsed: ParsedMail, fromEmail: string): Promise<boolean> {
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
  const body = (parsed.text ?? "").trim().slice(0, 10000) || (parsed.html ? "[HTML email — open the ticket to view]" : "");
  const when = parsed.date ?? new Date();

  // Thread onto the most recent non-closed ticket for this contact + mailbox with
  // the same normalized subject; otherwise open a new one.
  const openCase = await prisma.customerCase.findFirst({
    where: { contactId: contact.id, mailboxId: mailbox.id, status: { not: "closed" } },
    orderBy: { updatedAt: "desc" },
  });
  const existing = openCase && normalizeSubject(openCase.subject) === norm ? openCase : null;

  let caseId: string;
  let caseNumber: bigint;
  const isNew = !existing;
  if (existing) {
    await prisma.customerCase.update({
      where: { id: existing.id },
      data: {
        status: existing.status === "resolved" ? "open" : existing.status,
        lastReplyAt: when,
        lastReplyBy: "customer",
        messages: { create: { contactId: contact.id, direction: "customer", type: "message", body } },
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
        messages: { create: { contactId: contact.id, direction: "customer", type: "message", body } },
      },
      select: { id: true, number: true },
    });
    caseId = created.id;
    caseNumber = created.number;
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

/**
 * Pulls new inbox mail via IMAP and files replies onto the matching
 * customer's record. Read-only on the mailbox (flags untouched); progress
 * tracked by UID. Mail from unknown senders is ignored — this files
 * conversations, it doesn't create leads from inbox noise.
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
      let maxSeen = lastUid;

      for await (const msg of client.fetch(
        { uid: `${lastUid + 1}:*` },
        { uid: true, source: true },
        { uid: true }
      )) {
        if (msg.uid <= lastUid) continue; // IMAP quirk: range can echo the last message
        if (msg.uid > maxSeen) maxSeen = msg.uid;
        if (!msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source);
          const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase();
          if (!fromEmail) continue;
          const ourAddress = user.toLowerCase();
          if (fromEmail === ourAddress) continue; // our own sent mail

          // Help desk: mail addressed to a support mailbox becomes a ticket
          // (create or thread), incl. mail from brand-new senders. Everything else
          // keeps the timeline-filing behaviour below.
          const mailbox = await matchSupportMailbox(parsed);
          if (mailbox) {
            if (await fileSupportEmail(mailbox, parsed, fromEmail)) filed++;
            continue;
          }

          const contact = await prisma.contact.findFirst({
            where: { email: { equals: fromEmail, mode: "insensitive" } },
          });
          const lead = contact
            ? null
            : await prisma.lead.findFirst({
                where: { email: { equals: fromEmail, mode: "insensitive" }, status: "open" },
              });
          if (!contact && !lead) continue; // unknown sender — leave in the mailbox

          const body =
            (parsed.text ?? "").trim().slice(0, 5000) ||
            (parsed.html ? "[HTML email — see mailbox]" : "");
          const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
          if (!firstUser) continue;

          await prisma.communication.create({
            data: {
              type: "email",
              direction: "inbound",
              subject: parsed.subject ?? "(no subject)",
              body,
              occurredAt: parsed.date ?? new Date(),
              // Email threading (shared inbox): keep the provider headers so replies chain.
              messageId: parsed.messageId ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              references: Array.isArray(parsed.references)
                ? parsed.references.join(" ")
                : parsed.references ?? null,
              contactId: contact?.id ?? lead?.contactId ?? null,
              leadId: lead?.id ?? null,
              userId: firstUser.id,
            },
          });
          filed++;
          await sendPushToAll(
            {
              title: "📧 Email reply",
              body: `${contact ? contactName(contact) : lead?.name}: ${parsed.subject ?? ""}`.slice(0, 100),
              url: contact ? `/contacts/${contact.id}` : `/leads/${lead?.id}`,
            },
            "email_in"
          ).catch(() => {});
        } catch {
          // one bad message must not stall the sync
        }
      }
      if (maxSeen > lastUid) await putSetting("IMAP_LAST_UID", String(maxSeen));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return filed;
}
