import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { inheritedTenantId } from "./tenantWrite";
import { agreedTenantId, attachedTenantId } from "./compositeTenantRules";

/**
 * The tenantId the top-level guard (db.ts `scopeArgs`) will FILTER a Conversation
 * read/update by for the current scope. Conversation bookkeeping runs through
 * `basePrisma` (to avoid recursing back through the Communication create
 * extension), which BYPASSES that guard — so it must apply the same predicate
 * itself. Mirrors `scopeArgs` exactly: only enforcing + a non-system tenant scope
 * narrows anything, because while enforcement is dormant every legacy row carries
 * a NULL tenant and filtering on the acting tenant would simply stop matching
 * them — the thread would look empty and a bump would be a silent no-op.
 *
 * THIS IS A FILTER, AND ONLY A FILTER. It used to be the CREATE stamp as well,
 * and that was the bug: mirroring `scopeArgs` is right for a `where` and useless
 * for a `data`, because what `scopeArgs` stamps while enforcement is dormant is
 * nothing at all. Every conversation opened since therefore landed with a NULL
 * tenant (6 of 32 on production at the 2026-08-10 audit, 5 of them written after
 * the July backfill). See {@link conversationTenantId} for what a create uses.
 */
function conversationFilterTenantId(): string | null {
  if (!tenantEnforcing()) return null;
  const scope = currentTenantScope();
  if (!scope || scope.system) return null;
  return scope.tenantId ?? null;
}

/**
 * The tenantId a NEW conversation is stamped with.
 *
 * A conversation is opened by an INBOUND MESSAGE — a WhatsApp webhook, an IMAP
 * poll, a Messenger callback — so there is frequently no session to ask, and
 * asking the ambient scope alone is how this row came to be unowned in the first
 * place. The owner therefore comes, in order, from:
 *
 *   1. the COMMUNICATION being written. Under enforcement `scopeArgs` has already
 *      stamped `args.data.tenantId` by the time the communication extension runs
 *      (Layer 2 wraps Layer 1), and any caller that stamps it explicitly is making
 *      the same statement. This one matters beyond tidiness: the composite FK
 *      `Communication(tenantId, conversationId) → Conversation(tenantId, id)` is
 *      violated the moment the two disagree, so the message decides.
 *   2. the CONTACT AND LEAD the thread is about — BOTH of them, read from the rows
 *      themselves and put through `agreedTenantId`. A conversation with Denago Cape
 *      Town's customer belongs to Denago Cape Town whichever process happened to
 *      receive the message.
 *   3. `inheritedTenantId`'s own ladder — the enforced scope, the channel scope
 *      `withChannelTenantScope` established from the provider endpoint the message
 *      arrived on, and finally the founding tenant.
 *
 * Never invents an owner: every rung is a fact about a real row or a real scope.
 *
 * RUNG 2 IS VERBATIM, INCLUDING NULL. When the thread has a subject, the subject
 * decides — even when its answer is "I have no owner yet". Climbing past a NULL
 * parent to the founding tenant is not a safe default here, it is a constraint
 * violation: `Conversation(tenantId, contactId) → Contact(tenantId, id)` is a
 * COMPOSITE foreign key, so a child claiming an owner its parent does not have
 * cannot be inserted at all. Postgres rejects it with P2003 and the inbound
 * message is lost.
 *
 * That is not hypothetical. Production is full of Contacts with a NULL tenantId
 * — the audit counted them — and the integration seed reproduces exactly that
 * population, which is how this surfaced.
 *
 * So the ladder only continues past rung 2 when there is NO subject to ask. A
 * conversation about an unowned contact is itself unowned, and a later backfill
 * claims the pair together, which is the only way they can stay consistent.
 *
 * RUNG 2 ASKS BOTH PARENTS, THROUGH THE SHARED RULE. This used to read `contactId ?
 * contact : lead` — the contact when both were present, the lead ignored. A message
 * carrying a contact in one workspace and a lead in another therefore opened a
 * thread stamped with the CONTACT's tenant, which `Conversation(tenantId, leadId) →
 * Lead(tenantId, id)` then refused. The refusal was correct and its handling was
 * not: the caller swallowed it and wrote the Communication with a NULL tenant
 * instead, which under MATCH SIMPLE switches BOTH of that row's composite checks
 * off — a contradiction the database had caught, laundered into an unowned
 * cross-tenant row it could no longer object to. That is precisely what #475 made
 * `agreedTenantId` refuse, so this asks `agreedTenantId`, and the pair is refused
 * here rather than discovered three statements later.
 *
 * NOT `customerRecordTenantId`, which wraps the same rule: its no-parent fallback is
 * the ACTING tenant, and a conversation is opened by a webhook with no session to
 * act as. Rungs 1 and 3 are this module's; only the policy is shared.
 *
 * THIS IS HALF THE RULE, AND ONLY THE CREATE HALF. It settles who owns a thread at
 * the moment it is opened, when the message is the only thing that knows. Once the
 * thread EXISTS the direction reverses and the thread decides — see
 * {@link attachToConversation} and `attachedTenantId`. Reading rung 1 as "the
 * message always decides" is what broke note-taking on 2026-08-11.
 */
async function conversationTenantId(data: MessageData): Promise<string | null> {
  if (typeof data.tenantId === "string" && data.tenantId) return data.tenantId;
  const subject = await subjectAgreement([{ contactId: data.contactId, leadId: data.leadId }]);
  // No subject resolved anything (no ids, or ids that resolve to no row — the
  // insert will fail on its own single-column key, the right place for that
  // failure to surface): fall back the way a session-less writer always has.
  if (subject === NO_SUBJECT) return inheritedTenantId(null);
  // Verbatim when the subjects agree, NULL included; subjectAgreement already
  // THREW if they did not.
  return subject;
}

/** Distinguishes "asked and every id was silent" from "asked and got NULL back". */
const NO_SUBJECT = Symbol("no-subject");

/**
 * The tenant every referenced CONTACT and LEAD id agrees on — across one message,
 * or across a message AND the conversation it is being matched against. One
 * `id[]`-shaped argument per source; a source that supplies neither id contributes
 * nothing and is not an error.
 *
 * THROWS on a genuine contradiction (two different non-null tenants), exactly the
 * rule `agreedTenantId` states and #475 exists to enforce. Returns `NO_SUBJECT`
 * when nothing was referenced at all, so a caller can tell "no evidence either way"
 * from "the evidence says NULL."
 *
 * WHY THIS RUNS ON ATTACH, NOT ONLY ON CREATE. `conversationTenantId` (rung 2)
 * only ever ran for a brand-new conversation — reasonably, since that is the one
 * moment nothing else has an opinion yet. But `attachToConversation` was letting
 * an EXISTING thread's tenant, NULL included, stand in for this check entirely:
 * a thread awaiting backfill says nothing about whether THIS message's own
 * contact and lead agree with each other, or with a caller-supplied thread's own
 * subject. Contact A + Lead B on one unstamped message, aimed at any NULL-tenant
 * thread, resolved to a NULL Communication whose contact key and lead key were
 * BOTH switched off by that NULL — the exact laundering #475 refuses on create,
 * reopened on attach. This is that same refusal, run again at the point it was
 * missing.
 */
async function subjectAgreement(
  sources: Array<{ contactId?: string | null; leadId?: string | null }>,
): Promise<string | null | typeof NO_SUBJECT> {
  const contactIds = [...new Set(sources.map((s) => s.contactId).filter((v): v is string => Boolean(v)))];
  const leadIds = [...new Set(sources.map((s) => s.leadId).filter((v): v is string => Boolean(v)))];
  const [contacts, leads] = await Promise.all([
    Promise.all(contactIds.map((id) => basePrisma.contact.findUnique({ where: { id }, select: { tenantId: true } }))),
    Promise.all(leadIds.map((id) => basePrisma.lead.findUnique({ where: { id }, select: { tenantId: true } }))),
  ]);
  const referenced = [...contacts, ...leads]
    .filter((row): row is { tenantId: string | null } => row != null)
    .map((row) => row.tenantId);
  if (referenced.length === 0) return NO_SUBJECT;
  // Verbatim when they agree, NULL included; THROWS when they do not.
  return agreedTenantId(referenced, null);
}

/** Map a Communication.type to a conversation channel. */
const CHANNEL_OF: Record<string, string> = {
  email: "email",
  whatsapp: "whatsapp",
  messenger: "messenger",
  instagram: "instagram",
  // Public comments on posts and ads. Its OWN channel, deliberately: a comment
  // thread is a post with a crowd in it, not a customer, and mixing it into the
  // DM mailbox would bury the private conversations that need answering under
  // public chatter that mostly does not.
  comment: "comment",
  call: "call",
  meeting: "note",
  note: "note",
};

export function channelForType(type: string): string {
  return CHANNEL_OF[type] ?? "other";
}

type MessageData = {
  contactId?: string | null;
  leadId?: string | null;
  type: string;
  subject?: string | null;
  direction?: string | null;
  occurredAt?: Date;
  /** The thread the caller has already chosen, if it chose one. */
  conversationId?: string | null;
  /**
   * The Communication's own owner, as it will be written. Present once the guard
   * has stamped it (under enforcement) or once a caller stamps it explicitly;
   * absent while enforcement is dormant and nobody has. Read, never assumed.
   */
  tenantId?: string | null;
};

/**
 * The conversation a message attaches to, AND the owner that attachment obliges it
 * to carry.
 *
 * The tenant travels with the id because the caller cannot write its row without it.
 * `Communication(tenantId, conversationId) → Conversation(tenantId, id)` is a
 * composite foreign key, so "which thread" and "whose thread" are one answer, not
 * two — and the second used to be re-derived from the message's subject instead,
 * which is the whole of the 2026-08-11 note-taking outage. Returning them together
 * is what makes the wrong one unavailable.
 */
export type ResolvedConversation = {
  id: string;
  /** The thread's owner, RAW — NULL means a thread still awaiting the backfill. */
  tenantId: string | null;
  /**
   * The thread's OWN subject columns, carried alongside the owner so a caller
   * that supplied this id can be checked against what the thread actually points
   * at — see {@link subjectAgreement}. A search that MATCHED on one of these (see
   * {@link findOpenConversation}) does not need it re-checked; it is here so
   * every producer of a `ResolvedConversation` has the same shape, not a subset
   * that happens to be enough for today's caller.
   */
  contactId: string | null;
  leadId: string | null;
};

/**
 * The open thread this message belongs to, if one already exists. A READ, and
 * nothing else — see {@link attachToConversation} for why that separation is load
 * bearing rather than tidy.
 *
 * `tenantId` is selected because a reused thread is the case where the message
 * cannot decide its own owner: this row already has one and the FK says match it.
 */
async function findOpenConversation(data: MessageData): Promise<ResolvedConversation | null> {
  if (!data.contactId && !data.leadId) return null;
  const filterTenantId = conversationFilterTenantId();
  const subjectScope = data.contactId ? { contactId: data.contactId } : { leadId: data.leadId };
  const existing = await basePrisma.conversation.findFirst({
    // Reuse only the acting tenant's own open conversation when a tenant is in scope.
    where: {
      channel: channelForType(data.type),
      status: { not: "closed" },
      ...(filterTenantId ? { tenantId: filterTenantId } : {}),
      ...subjectScope,
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, tenantId: true, contactId: true, leadId: true },
  });
  return existing
    ? { id: existing.id, tenantId: existing.tenantId ?? null, contactId: existing.contactId, leadId: existing.leadId }
    : null;
}

/**
 * One conversation, by the id a caller chose for itself. Read through `basePrisma`
 * and WITHOUT a tenant predicate, the same narrow pre-scope boundary
 * `customerRecordTenantId` uses for exactly this lookup: it runs before the row's
 * tenant is known, so a guarded read would have nothing to scope by and, under
 * enforcement, would fail closed on the very query that decides the scope.
 *
 * Reading the row raw is what makes the boundary STRONGER here, not weaker. A
 * tenant-filtered read answers "not found" for a thread in another workspace, which
 * teaches the caller nothing and leaves an unstamped message free to attach to it.
 * The raw owner goes to `attachedTenantId`, which refuses the pair outright.
 */
async function conversationById(id: string): Promise<ResolvedConversation | null> {
  const row = await basePrisma.conversation.findUnique({
    where: { id },
    select: { id: true, tenantId: true, contactId: true, leadId: true },
  });
  return row ? { id: row.id, tenantId: row.tenantId ?? null, contactId: row.contactId, leadId: row.leadId } : null;
}

/**
 * Open a thread for a message that has none. A WRITE, and it DECIDES AN OWNER — so
 * it can refuse (`TenantParentConflictError`) and its refusals must not be mistaken
 * for a lookup that came back empty.
 */
async function openConversation(data: MessageData): Promise<ResolvedConversation | null> {
  if (!data.contactId && !data.leadId) return null;
  // Resolved only on this branch, so the extra lookup is paid once per thread rather
  // than once per message.
  const tenantId = await conversationTenantId(data);
  const created = await basePrisma.conversation.create({
    data: {
      channel: channelForType(data.type),
      subject: data.subject ?? null,
      contactId: data.contactId ?? null,
      leadId: data.leadId ?? null,
      tenantId,
    },
    select: { id: true },
  });
  // The same values that were just written, not a re-read: the caller has to
  // match this row, and a second query could only introduce a way for them to
  // differ.
  return { id: created.id, tenantId, contactId: data.contactId ?? null, leadId: data.leadId ?? null };
}

/**
 * Find the open conversation a new message belongs to (per contact/lead + channel),
 * creating one if none exists. Returns null for messages with no contact or lead.
 * Uses basePrisma so it never recurses through the Communication create extension.
 */
export async function resolveConversationId(data: MessageData): Promise<ResolvedConversation | null> {
  return (await findOpenConversation(data)) ?? (await openConversation(data));
}

/**
 * Put a Communication that is about to be inserted onto its conversation: the
 * thread it belongs to, AND the owner that attachment obliges it to carry.
 *
 * Called by the `communication.create` hook in db.ts on the create payload itself,
 * which it MUTATES. It is the last thing to touch `data` before the INSERT, and the
 * two fields it sets have to reach the database together — which is the whole point
 * of it being one function and not two.
 *
 * THE THREAD OWNS THE MESSAGES ON IT.
 *
 * Every caller stamps `tenantId` from the message's SUBJECT — the contact or lead,
 * via `customerRecordTenantId`. That is the right answer for the subject's own
 * composite keys and the wrong one for this row's third key,
 * `Communication(tenantId, conversationId) → Conversation(tenantId, id)`, whenever
 * the thread disagrees with the subject. On 2026-08-11 six production conversations
 * predating the tenant backfill were still unowned while their leads and contacts
 * had been claimed, so every note typed on those six records died on that
 * constraint. The subject decides only when there is no thread yet, which is what
 * {@link conversationTenantId} is for; from the second message onwards the thread
 * has already decided and this row's job is to agree with it.
 *
 * EXACTLY ONE FAILURE IS SWALLOWED, AND ONLY BECAUSE OF WHAT IT LEAVES BEHIND. If
 * the search for an existing thread fails, this returns having set NOTHING: the row
 * goes to the database with no `conversationId`, so there is no conversation key
 * left for it to violate and its remaining keys are still checked against the
 * subject's stamp. That is a message without a thread, which is a degradation.
 *
 * Every other failure here is REFUSAL and must reach the caller. This wrapped
 * find-or-create in one `try` until review caught it, and the hole was not the
 * search — it was the CREATE inside it. An unstamped message carrying a contact in
 * workspace A and a lead in workspace B makes `conversationTenantId` refuse; the
 * broad catch turned that refusal into `return null`, and the Communication went on
 * to be written with `tenantId: NULL, contactId: A's, leadId: B's` — which under
 * MATCH SIMPLE switches BOTH composite checks off. A contradiction the rules had
 * caught became an unowned cross-tenant row nothing could object to: the precise
 * laundering #475 exists to prevent, reintroduced by an over-wide `catch`.
 *
 * So the search is caught and the two decisions are not. A conversation insert that
 * fails for any other reason now fails the message too, and should: it is a write,
 * the transcript row is about to point at it, and a redelivered webhook or a retried
 * note is a better outcome than a row that silently threads nowhere.
 *
 * Inert under enforcement, by construction: reuse is filtered to the acting tenant,
 * so the thread found already carries the tenant `scopeArgs` stamped a moment
 * earlier.
 */
export async function attachToConversation(data: MessageData): Promise<ResolvedConversation | null> {
  // A caller that chose its own thread is answered about THAT thread. Reading the
  // one it actually points at is the only way to inherit or refuse honestly; using
  // the thread the search would have found would decide this row's owner from a row
  // it is not attached to. Deliberately not caught: unlike the search below,
  // returning early here would leave `conversationId` set and the tenant unexamined,
  // which is the defect this function exists to close.
  if (data.conversationId) {
    const chosen = await conversationById(data.conversationId);
    // An id that matches no row: leave the stamp alone and let the plain
    // `conversationId → Conversation(id)` key refuse the insert, which it will.
    if (!chosen) return null;
    // A caller-supplied id has no guarantee attached to it at all — unlike the
    // search below, nothing has confirmed this id's own subject relates to the
    // message's. So both are checked: the message's contact and lead agreeing
    // with EACH OTHER, and with whatever the chosen thread itself already
    // points at. `chosen.tenantId` being NULL is not evidence of anything by
    // itself — a thread stamped for tenant B, whose subject the message's own
    // ids disagree with, is exactly the case this closes.
    const subject = await subjectAgreement([
      { contactId: data.contactId, leadId: data.leadId },
      { contactId: chosen.contactId, leadId: chosen.leadId },
    ]);
    data.tenantId = attachedTenantId(chosen.tenantId, subject === NO_SUBJECT ? data.tenantId : subject);
    return chosen;
  }

  let conversation: ResolvedConversation | null;
  try {
    conversation = await findOpenConversation(data);
  } catch {
    // Sets nothing — see above. This is the whole of the best-effort behaviour.
    return null;
  }

  // Past this line nothing is caught: a refused owner is a decision.
  conversation ??= await openConversation(data);
  if (!conversation) return null;
  data.conversationId = conversation.id;
  // The search above matched THIS message's own id against the thread's stored
  // column, so the found thread's subject already agrees with whichever of
  // contactId/leadId the message supplied. What it never checked is the id the
  // message DIDN'T search by — a message carrying both a contact and a lead
  // searches by contact alone, and the lead could belong to another workspace
  // entirely. `subjectAgreement` on the message's own ids closes that, and
  // THROWS before anything is written if they disagree.
  const subject = await subjectAgreement([{ contactId: data.contactId, leadId: data.leadId }]);
  data.tenantId = attachedTenantId(conversation.tenantId, subject === NO_SUBJECT ? data.tenantId : subject);
  return conversation;
}

/**
 * Rewrite a conversation's derived state from the messages that exist, holding
 * the conversation's row lock for the whole read-then-write.
 *
 * WHY ABSOLUTE, AND WHY EVERYWHERE.
 *
 * This used to roll the counters forward INCREMENTALLY — `messageCount: {
 * increment: 1 }` and friends — which is correct on its own and cannot be mixed
 * with anything else. The echo cleanup has to write ABSOLUTE values, because an
 * increment has no inverse that restores `lastMessageAt`, `lastDirection` or
 * `firstResponseAt` when the message that supplied them is removed. Absolute and
 * relative writers on one row do not compose:
 *
 *   cleanup                       a real new message
 *   ───────                       ──────────────────
 *                                 INSERT Communication  (committed)
 *   snapshot: 6 messages
 *   write messageCount = 6
 *                                 increment -> 7        ← one too high, for ever
 *
 * and the mirror image, where the cleanup's snapshot predates the insert and its
 * absolute write throws the increment away. A lock around the cleanup alone
 * fixes neither: the INSERT and its bookkeeping are separate operations, so the
 * lock cannot span them.
 *
 * So there is exactly one way to write this projection, and it is absolute. Both
 * writers take the conversation's row lock first, then recompute from the rows
 * that are committed at that moment. Every writer recomputes AFTER its own row
 * change has committed, so whichever acquires the lock last sees every change
 * and writes the truth. Any interleaving converges; none can leave the count
 * disagreeing with the transcript.
 *
 * It costs no more than it used to. The incremental version was a read followed
 * by an update — two round trips. This is a lock followed by one statement that
 * computes and writes together.
 */
const RECOMPUTE_SQL = (conversationId: string, tenantId: string | null) => Prisma.sql`
  WITH msgs AS (
    SELECT direction, "occurredAt", id
      FROM "Communication"
     WHERE "conversationId" = ${conversationId}
  ),
  first_inbound AS (
    SELECT min("occurredAt") AS at FROM msgs WHERE direction = 'inbound'
  ),
  agg AS (
    SELECT count(*)::int AS cnt,
           max("occurredAt") AS last_at,
           max("occurredAt") FILTER (WHERE direction = 'inbound') AS last_inbound_at
      FROM msgs
  ),
  newest AS (
    SELECT direction FROM msgs ORDER BY "occurredAt" DESC, id DESC LIMIT 1
  ),
  first_response AS (
    -- The same rule the incremental version applied one message at a time: the
    -- first outbound that happened once a customer message existed.
    SELECT min(m."occurredAt") AS at
      FROM msgs m, first_inbound f
     WHERE f.at IS NOT NULL AND m.direction = 'outbound' AND m."occurredAt" >= f.at
  )
  UPDATE "Conversation" c
     SET "messageCount"    = agg.cnt,
         -- An emptied conversation falls back to its own creation time rather
         -- than to now(): "last message at" must never be later than the last
         -- message.
         "lastMessageAt"   = COALESCE(agg.last_at, c."createdAt"),
         "lastDirection"   = (SELECT direction FROM newest),
         "lastInboundAt"   = agg.last_inbound_at,
         "firstResponseAt" = (SELECT at FROM first_response)
    FROM agg
   WHERE c.id = ${conversationId}
     AND (${tenantId}::text IS NULL OR c."tenantId" = ${tenantId})
`;

/**
 * Take the conversation's row lock, then recompute. Callers must already have
 * committed whatever row change they are reporting.
 */
async function lockAndRecompute(
  tx: Prisma.TransactionClient,
  conversationId: string,
  tenantId: string | null,
): Promise<void> {
  // The fence. Everything after this in the transaction takes a fresh snapshot,
  // so a writer that queued behind another sees that other's committed work.
  await tx.$executeRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} FOR UPDATE`;
  await tx.$executeRaw(RECOMPUTE_SQL(conversationId, tenantId));
}

/**
 * Recompute one conversation's derived state, on its own.
 *
 * `unread` is deliberately NOT derived. It means "nobody has opened the inbound
 * messages", it is cleared explicitly by `markConversationRead`, and deriving it
 * here would let a recompute silently mark a thread read — or silently unread a
 * thread somebody had just opened.
 */
export async function recomputeConversationDerivedState(conversationId: string): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.$transaction(async (tx) => {
    await lockAndRecompute(tx, conversationId, tenantId);
  });
}

/**
 * Roll a conversation forward for a new message.
 *
 * Inbound messages additionally set `unread`, which is state rather than a
 * derivation — nothing about the messages themselves says whether a person has
 * looked at them — so it is written here and cleared only by
 * `markConversationRead`.
 */
export async function bumpConversation(
  conversationId: string,
  msg: { direction?: string | null; occurredAt?: Date }
): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.$transaction(async (tx) => {
    await lockAndRecompute(tx, conversationId, tenantId);
    if (msg.direction === "inbound") {
      await tx.conversation.updateMany({
        where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
        data: { unread: true },
      });
    }
  });
}

/** Mark a conversation read (a staff member opened it). */
export async function markConversationRead(conversationId: string): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.conversation.update({
    where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
    data: { unread: false },
  });
}

/**
 * Remove timeline rows AND put their conversations back to the state they would
 * have been in had those rows never existed.
 *
 * The reason this exists rather than a bare `deleteMany`. The guarded client
 * intercepts `Communication.create` to attach the row to a conversation and roll
 * that conversation's counters forward; nothing intercepts a delete. So removing
 * a row directly leaves the transcript correct and the projection one message
 * ahead for ever — and Conversation is what the inbox increasingly reads for
 * ordering, pagination and "who is waiting on us".
 *
 * Used by the Meta echo reconciliation, which deliberately records a possibly
 * duplicate row and removes it once the ledger proves the message was ours.
 * "Removes it" has to mean all of it.
 */
export async function deleteCommunicationsAndReconcile(
  where: { id?: string; dedupeKey?: string },
): Promise<number> {
  const doomed = await basePrisma.communication.findMany({
    where,
    select: { id: true, conversationId: true },
  });
  if (doomed.length === 0) return 0;

  const removed = await basePrisma.communication.deleteMany({
    where: { id: { in: doomed.map((row) => row.id) } },
  });
  // After the delete, so the recomputation sees the world without these rows.
  for (const conversationId of new Set(doomed.map((row) => row.conversationId).filter((id): id is string => Boolean(id)))) {
    await recomputeConversationDerivedState(conversationId);
  }
  return removed.count;
}
