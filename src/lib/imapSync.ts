import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "./db";
import { getSetting, putSetting } from "./settings";
import { sendPushToAll } from "./push";
import { contactName } from "./format";

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
