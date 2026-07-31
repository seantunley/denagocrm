import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ciExactIdFilter, ciExactIds } from "./ciExact";
import { resolveTenantActor } from "./tenantActor";
import { getSetting, putSetting, resolveIntegrationBundle } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { sendPushToAll } from "./push";
import { sendEmail } from "./email";
import { contactName } from "./format";
import { normalizeHtml } from "./competitors";
import { logError } from "./errorLog";

// The transaction client handed to prisma.$transaction — derived from our
// EXTENDED client (soft-delete filtering), which differs from the plain
// Prisma.TransactionClient, so extension-aware model calls typecheck.
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Durable idempotency key for an inbound email. Prefer the Message-ID; when the
 * mail has none, fall back to the IMAP transport identity (account + UIDVALIDITY
 * + UID) supplied by the caller. That transport key is STABLE across retries and
 * DISTINCT per physical message — a content/date hash would change on retry
 * (parsed.date ?? new Date()) and could collide across two legitimately-identical
 * messages. Namespaced so the two kinds of key can never collide.
 */
function emailIdemKey(messageId: string | null, transportKey: string): string {
  return messageId ? `msg:${messageId}` : transportKey;
}

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
  // Addresses are unique per mailbox (case-insensitive unique index), but order
  // deterministically anyway so routing never depends on row order.
  const boxes = await prisma.supportMailbox.findMany({
    where: { active: true, email: { not: null } },
    orderBy: { id: "asc" },
  });
  return boxes.find((b) => b.email && recipients.has(b.email.toLowerCase())) ?? null;
}

type Mailbox = NonNullable<Awaited<ReturnType<typeof matchSupportMailbox>>>;

/**
 * Find the ticket this email belongs to, if any. Prefers real reply-header
 * threading (In-Reply-To/References → a message we already filed), then falls
 * back to matching the normalized subject against ANY of this contact's recent
 * non-closed tickets in the mailbox (not just the single most recent one).
 * Runs on the caller's transaction client so it sees its uncommitted writes.
 */
async function findThreadCase(tx: TxClient, mailbox: Mailbox, contactId: string, parsed: ParsedMail, norm: string) {
  const refKeys = referencedIds(parsed).map((r) => `msg:${r}`);
  if (refKeys.length) {
    // The referenced message must belong to THIS sender's case in this mailbox —
    // a forwarded or spoofed References header must not attach one customer's
    // reply onto another customer's ticket.
    const prior = await tx.customerCaseMessage.findFirst({
      where: {
        sourceMessageId: { in: refKeys },
        case: { contactId, mailboxId: mailbox.id, status: { not: "closed" } },
      },
      orderBy: { createdAt: "desc" },
      include: { case: true },
    });
    if (prior?.case) return prior.case;
  }
  const recent = await tx.customerCase.findMany({
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
 * the mailbox's auto-reply. Returns true when newly filed.
 *
 * The idempotency claim, contact resolution/creation and ticket write happen in
 * ONE transaction, guarded by:
 *  - a unique sourceMessageId (Message-ID or the IMAP transport key) — the DB
 *    rejects a second filing of the same email;
 *  - a per-email advisory lock (pg_advisory_xact_lock) — serialises contact
 *    resolution so overlapping runs can't create duplicate contacts.
 * If the message write loses the uniqueness race, the whole transaction rolls
 * back, so a just-created contact is undone too (no orphan). Side effects
 * (auto-reply, push) run only after the commit.
 */
async function fileSupportEmail(mailbox: Mailbox, parsed: ParsedMail, fromEmail: string, transportKey: string): Promise<boolean> {
  const messageId = parsed.messageId ?? null;
  const rawSubject = (parsed.subject ?? "").trim() || "(no subject)";
  const norm = normalizeSubject(rawSubject);
  const body = emailBody(parsed, 10000);
  const when = parsed.date ?? new Date();
  const idemKey = emailIdemKey(messageId, transportKey);

  let outcome: { isNew: boolean; caseId: string; caseNumber: bigint; contactLabel: string } | null;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Idempotency claim — already filed (retry / replay after a poison message).
      const seen = await tx.customerCaseMessage.findUnique({ where: { sourceMessageId: idemKey } });
      if (seen) return null;

      // Serialise contact resolution for THIS email so two overlapping runs can't
      // both create a contact for a new sender. The lock is transaction-scoped
      // (released on commit/rollback) and held on the tx's own connection.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact:${fromEmail}`}))`;

      // Exact (case-folded) sender match. `mode: "insensitive"` compiled to an
      // unescaped ILIKE against a From header, which nothing validates — a message
      // claiming to be from `%@%` filed itself onto an arbitrary real customer's
      // record. `client: tx` keeps the lookup inside the advisory lock above; on
      // its own pooled connection it would not see the row a concurrent run is
      // about to commit, which is the duplicate the lock exists to prevent.
      const senderContactIds = await ciExactIds("contactEmail", fromEmail, { client: tx });
      let contact = senderContactIds.length
        ? await tx.contact.findFirst({
            where: { id: { in: senderContactIds } },
            orderBy: { createdAt: "asc" },
          })
        : null;
      if (!contact) {
        const fromName = parsed.from?.value?.[0]?.name?.trim() || fromEmail.split("@")[0];
        const [first, ...rest] = fromName.split(/\s+/);
        contact = await tx.contact.create({
          data: { firstName: first || fromEmail, lastName: rest.join(" ") || null, email: fromEmail, source: "email" },
        });
      }

      const existing = await findThreadCase(tx, mailbox, contact.id, parsed, norm);
      const messageBase = { contactId: contact.id, direction: "customer" as const, type: "message" as const, body, sourceMessageId: idemKey };
      if (existing) {
        await tx.customerCase.update({
          where: { id: existing.id },
          data: {
            status: existing.status === "resolved" ? "open" : existing.status,
            lastReplyAt: when,
            lastReplyBy: "customer",
          },
        });
        await tx.customerCaseMessage.create({ data: { ...messageBase, caseId: existing.id } });
        return { isNew: false, caseId: existing.id, caseNumber: existing.number, contactLabel: contactName(contact) };
      }
      const created = await tx.customerCase.create({
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
        },
        select: { id: true, number: true },
      });
      await tx.customerCaseMessage.create({ data: { ...messageBase, caseId: created.id } });
      return { isNew: true, caseId: created.id, caseNumber: created.number, contactLabel: contactName(contact) };
    });
  } catch (e) {
    // A concurrent run filed this same email first — its unique sourceMessageId
    // rejects our write and the whole tx (incl. any contact create) rolls back.
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  if (!outcome) return false; // already filed

  if (outcome.isNew && mailbox.autoReplyEnabled && mailbox.autoReplyBody && !looksAutomated(parsed, fromEmail)) {
    const sig = mailbox.signature ? `\n\n${mailbox.signature}` : "";
    await sendEmail({
      to: fromEmail,
      subject: `Re: ${rawSubject} [C-${outcome.caseNumber}]`,
      text: `${mailbox.autoReplyBody}${sig}`,
    }).catch(() => {});
  }

  await sendPushToAll(
    {
      title: outcome.isNew ? `🎫 New ticket · ${mailbox.name}` : `💬 Ticket reply · ${mailbox.name}`,
      body: `${outcome.contactLabel}: ${rawSubject}`.slice(0, 100),
      url: `/cases/${outcome.caseId}`,
    },
    "email_in",
  ).catch(() => {});
  return true;
}

/**
 * File a reply from a known contact/lead onto the timeline. Idempotent on a
 * durable dedupeKey (Message-ID or the IMAP transport key), DB-unique so
 * overlapping runs can't duplicate even though the pre-check is check-then-insert.
 * (No contact is created here — unknown senders are left in the mailbox.)
 */
async function fileTimelineEmail(parsed: ParsedMail, fromEmail: string, transportKey: string): Promise<boolean> {
  const messageId = parsed.messageId ?? null;
  const subject = parsed.subject ?? "(no subject)";
  const body = emailBody(parsed, 5000);
  const when = parsed.date ?? new Date();
  const dedupeKey = emailIdemKey(messageId, transportKey);

  const seen = await prisma.communication.findFirst({ where: { dedupeKey } });
  if (seen) return false; // already filed on a previous run

  // Exact (case-folded) sender match — see fileSupportEmail. Under the old ILIKE
  // a crafted From header filed an inbound email onto someone else's timeline.
  const contact = await prisma.contact.findFirst({
    where: await ciExactIdFilter("contactEmail", fromEmail),
    orderBy: { createdAt: "asc" },
  });
  const lead = contact
    ? null
    : await prisma.lead.findFirst({
        where: { AND: [await ciExactIdFilter("leadEmail", fromEmail), { status: "open" }] },
        orderBy: { createdAt: "asc" },
      });
  if (!contact && !lead) return false; // unknown sender — leave in the mailbox

  const firstUser = await resolveTenantActor();
  if (!firstUser) return false;

  try {
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "inbound",
        subject,
        body,
        occurredAt: when,
        messageId,
        dedupeKey,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references ?? null,
        contactId: contact?.id ?? lead?.contactId ?? null,
        leadId: lead?.id ?? null,
        userId: firstUser.id,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false; // a concurrent run filed it first
    throw e;
  }
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
async function handleParsedMessage(parsed: ParsedMail, ourAddress: string, transportKey: string): Promise<boolean> {
  const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (!fromEmail) return false;
  if (fromEmail === ourAddress) return false; // our own sent mail

  // Help desk: mail addressed to a support mailbox becomes a ticket (create or
  // thread), incl. mail from brand-new senders. Everything else files onto the
  // known contact's/lead's timeline.
  const mailbox = await matchSupportMailbox(parsed);
  if (mailbox) return fileSupportEmail(mailbox, parsed, fromEmail, transportKey);
  return fileTimelineEmail(parsed, fromEmail, transportKey);
}

const SYNC_LOCK = "IMAP_SYNC_LOCK";
const SYNC_LOCK_TTL_MS = 10 * 60 * 1000;
const POISON_MAX_TRIES = 5;

/**
 * Best-effort overlap guard — purely an optimisation to avoid two runs doing
 * redundant IMAP work. It is deliberately NOT relied on for correctness: the
 * check-then-set is non-atomic, so it can let two runs through, and that is
 * safe because every filing path is idempotent on a DB-UNIQUE key
 * (CustomerCaseMessage.sourceMessageId / Communication.dedupeKey), contact
 * creation is serialised by a per-email advisory lock, and unique violations
 * roll the transaction back. Duplicates are impossible regardless of this lock.
 */
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
 * queue. Filing is idempotent on the email Message-ID — or, when it has none, on
 * the IMAP transport identity (account + UIDVALIDITY + UID) — so those retries,
 * and any overlapping run, never produce a duplicate ticket, reply or timeline
 * row (nor a duplicate/orphan contact).
 */
export async function syncInboundEmail(): Promise<number> {
  // Runs inside runCronPerTenant's per-tenant slice — currentTenantScope() is
  // that tenant's scope when enforcing, else undefined (dormant): a tenant
  // with no IMAP override correctly falls back to the one global mailbox
  // (today's only mailbox). The "poll once globally vs per tenant" cron
  // structure is unchanged — only the credential resolution below is new.
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const bundle = await resolveIntegrationBundle(tenantId, "imap");
  if (!bundle) return 0;
  const { IMAP_HOST: host, IMAP_PORT: portRaw, IMAP_SECURE: secureRaw, IMAP_USER: user, IMAP_PASS: pass } = bundle;
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
      const storedIdentity = await getSetting("IMAP_CURSOR_IDENTITY");
      const mailbox = client.mailbox;
      const uidNext = typeof mailbox === "object" ? mailbox.uidNext : undefined;
      const uidValidity = typeof mailbox === "object" ? mailbox.uidValidity : undefined;
      const ourAddress = user.toLowerCase();
      // A UID is only meaningful within ONE UIDVALIDITY generation of ONE
      // mailbox. Bind the cursor to host/account/mailbox/UIDVALIDITY so that a
      // rebuild, restore or provider migration (new UIDVALIDITY → UIDs can
      // restart below the saved cursor) doesn't make us skip freshly-renumbered
      // mail against a stale UID.
      const mailboxIdentity = `${host.toLowerCase()}|${ourAddress}|INBOX|${uidValidity ?? "0"}`;

      // Explicit policy for "no usable cursor for this generation": start from
      // the current top of the mailbox — don't trust a stale UID, don't import
      // history. Runs on first-ever sync and whenever the identity changes.
      const startFromNow = async () => {
        if (uidNext) {
          await putSetting("IMAP_LAST_UID", String(uidNext - 1));
          await putSetting("IMAP_CURSOR_IDENTITY", mailboxIdentity);
        }
        return 0;
      };

      if (!lastUidRaw) return await startFromNow(); // first run ever
      if (storedIdentity && storedIdentity !== mailboxIdentity) {
        await logError("imap-sync", `Mailbox identity changed (${storedIdentity} → ${mailboxIdentity}); resetting cursor to now.`);
        return await startFromNow();
      }
      if (!storedIdentity) {
        // Cursor saved before identity tracking existed — adopt it for the
        // current mailbox so the deploy that adds this doesn't reset/seam.
        await putSetting("IMAP_CURSOR_IDENTITY", mailboxIdentity);
      }

      const lastUid = parseInt(lastUidRaw, 10);
      // Stable per-message identity for mail that lacks a Message-ID.
      const account = `imap:${ourAddress}:INBOX:${uidValidity ?? "0"}`;
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
            if (await handleParsedMessage(parsed, ourAddress, `${account}:${msg.uid}`)) filed++;
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
