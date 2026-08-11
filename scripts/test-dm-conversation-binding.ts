/**
 * REAL-DATABASE proof that a DM thread resolves to the RIGHT conversation.
 *
 * `sendDmReply` now reads the delivery channel off the stored Conversation and
 * refuses without one, because a channel the browser posts is a channel anyone
 * with inbox.reply can choose: for a customer with both a Messenger PSID and an
 * Instagram id, either value is plausible and the audit trail records whichever
 * was picked. That only helps if the id the reply box carries is the right one.
 *
 * The source tests can see that the resolver is called and that the collaboration
 * loader no longer derives the join itself. They cannot see any of what follows:
 *
 *   - that a thread with no conversation gets one CREATED, so the PWA's reply box
 *     is enabled rather than permanently disabled;
 *   - that rendering the page twice does not create a second one;
 *   - that a contact on BOTH platforms gets two conversations, one per channel,
 *     and each thread resolves to its own — the whole point of the change;
 *   - that WhatsApp threads are left alone;
 *   - that the collaboration loader and the resolver agree, thread for thread,
 *     which is what stops the notes panel and the reply box addressing different
 *     conversations.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { conversationIdsForThreads } from "../src/lib/inboxConversations";
import { collaborationForThreads } from "../src/lib/inboxCollaboration";
import type { ThreadIdentity } from "../src/lib/inboxThreads";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Refusing to run outside NODE_ENV=test");
  }
  // The database name must SAY it is a test database. This script writes and
  // deletes rows; "probably not production" is not good enough.
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = {
  /** Reachable on Messenger AND Instagram — the customer the old code got wrong. */
  dual: `c_dual_${SFX}`,
  /** WhatsApp only, to show nothing is created for a channel that does not need it. */
  wa: `c_wa_${SFX}`,
};

async function seed() {
  await basePrisma.contact.createMany({
    data: [
      {
        id: ids.dual,
        firstName: "Dual",
        lastName: `Identity ${SFX}`,
        messengerPsid: `psid_${SFX}`,
        instagramId: `igid_${SFX}`,
      },
      { id: ids.wa, firstName: "WhatsApp", lastName: `Only ${SFX}`, whatsapp: `2799${SFX.slice(0, 7)}` },
    ],
  });
}

async function cleanup() {
  const contactIds = [ids.dual, ids.wa];
  await basePrisma.conversationNote.deleteMany({ where: { conversation: { contactId: { in: contactIds } } } });
  await basePrisma.conversationDraft.deleteMany({ where: { conversation: { contactId: { in: contactIds } } } });
  await basePrisma.communication.deleteMany({ where: { contactId: { in: contactIds } } });
  await basePrisma.conversation.deleteMany({ where: { contactId: { in: contactIds } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: contactIds } } });
}

const thread = (contactId: string, channel: string): ThreadIdentity => ({ contactId, leadId: null, channel });

async function conversationsFor(contactId: string) {
  return basePrisma.conversation.findMany({
    where: { contactId },
    select: { id: true, channel: true, lastMessageAt: true, status: true },
    orderBy: { lastMessageAt: "desc" },
  });
}

async function main() {
  guardEnvironment();
  await cleanup();
  await seed();

  const messengerThread = thread(ids.dual, "messenger");
  const instagramThread = thread(ids.dual, "instagram");
  const whatsappThread = thread(ids.wa, "whatsapp");
  const all = [messengerThread, instagramThread, whatsappThread];

  // ── 1. A DM THREAD WITH NO CONVERSATION GETS ONE ──────────────────────────
  //
  // This is the /messages case. Before the change the PWA resolved nothing, so
  // making the id mandatory would have disabled replying there outright.
  check("no conversations exist to start with", (await conversationsFor(ids.dual)).length === 0);
  const first = await conversationIdsForThreads(all);
  const messengerId = first.get("c:" + ids.dual + ":messenger");
  const instagramId = first.get("c:" + ids.dual + ":instagram");
  check("the Messenger thread resolves to a conversation", Boolean(messengerId));
  check("the Instagram thread resolves to a conversation", Boolean(instagramId));

  // ── 2. ONE PER CHANNEL, AND EACH SAYS WHICH CHANNEL IT IS ─────────────────
  //
  // The defect this PR closes: one customer, two platforms. If both threads
  // resolved to the same row, the Instagram reply would be delivered on whatever
  // channel that row happened to name.
  check("the two DM threads resolve to DIFFERENT conversations", Boolean(messengerId) && messengerId !== instagramId);
  const rows = await conversationsFor(ids.dual);
  const byId = new Map(rows.map((row) => [row.id, row]));
  check("the Messenger thread's conversation is a messenger one", byId.get(messengerId ?? "")?.channel === "messenger", byId.get(messengerId ?? "")?.channel);
  check("the Instagram thread's conversation is an instagram one", byId.get(instagramId ?? "")?.channel === "instagram", byId.get(instagramId ?? "")?.channel);

  // ── 3. WHATSAPP IS LEFT ALONE ─────────────────────────────────────────────
  //
  // Its reply path addresses a phone number the server re-reads from the contact,
  // so a conversation created on sight would be a write with no reader.
  check("no conversation is created for a WhatsApp thread", (await conversationsFor(ids.wa)).length === 0);
  check("and the resolver reports none for it", !first.has("c:" + ids.wa + ":whatsapp"));

  // ── 4. RENDERING AGAIN DOES NOT CREATE MORE ───────────────────────────────
  //
  // The inbox auto-refreshes every 30 seconds. A resolver that created on every
  // render would fill the table and, worse, hand each render a different id.
  const second = await conversationIdsForThreads(all);
  check("a second render returns the SAME Messenger conversation", second.get("c:" + ids.dual + ":messenger") === messengerId);
  check("a second render returns the SAME Instagram conversation", second.get("c:" + ids.dual + ":instagram") === instagramId);
  check("and creates nothing new", (await conversationsFor(ids.dual)).length === 2, String((await conversationsFor(ids.dual)).length));

  // ── 5. THE NEWEST CONVERSATION ON A CHANNEL WINS ──────────────────────────
  //
  // A contact can accumulate several on one channel — a closed one and a live
  // one. The reply box must address the live one, and the notes panel must
  // address the same row, or a staff member reads one thread and replies on
  // another.
  await basePrisma.conversation.update({
    where: { id: messengerId },
    data: { status: "closed", lastMessageAt: new Date(Date.now() - 90 * 24 * 3600_000) },
  });
  const newer = await basePrisma.conversation.create({
    data: { channel: "messenger", contactId: ids.dual, lastMessageAt: new Date() },
    select: { id: true },
  });
  const third = await conversationIdsForThreads(all);
  check("the newest conversation on the channel wins", third.get("c:" + ids.dual + ":messenger") === newer.id, third.get("c:" + ids.dual + ":messenger"));
  check("and the stale one is not resurrected as a second answer", third.get("c:" + ids.dual + ":instagram") === instagramId);

  // ── 6. THE COLLABORATION PANEL POINTS AT THE SAME ROW ─────────────────────
  //
  // Two derivations of "which conversation is this thread" is how the notes
  // panel and the send action came to disagree. They now share one function;
  // this is the assertion that they actually agree in practice.
  const collaboration = await collaborationForThreads(all);
  check(
    "the collaboration payload names the same Messenger conversation",
    collaboration.get("c:" + ids.dual + ":messenger")?.conversationId === newer.id,
    collaboration.get("c:" + ids.dual + ":messenger")?.conversationId,
  );
  check(
    "and the same Instagram conversation",
    collaboration.get("c:" + ids.dual + ":instagram")?.conversationId === instagramId,
    collaboration.get("c:" + ids.dual + ":instagram")?.conversationId,
  );

  // ── 7. THE LOOKUP THE ACTION MAKES ────────────────────────────────────────
  //
  // `sendDmReply` re-reads the conversation keyed by BOTH ids before it trusts
  // the channel. A conversation id belonging to someone else must select nothing
  // rather than a channel.
  const foreign = await basePrisma.conversation.create({
    data: { channel: "instagram", contactId: ids.wa, lastMessageAt: new Date() },
    select: { id: true },
  });
  const crossed = await basePrisma.conversation.findFirst({
    where: { id: foreign.id, contactId: ids.dual },
    select: { channel: true },
  });
  check("another customer's conversation cannot be read for this one", crossed === null);
  const own = await basePrisma.conversation.findFirst({
    where: { id: instagramId, contactId: ids.dual },
    select: { channel: true },
  });
  check("the thread's own conversation still resolves, and names instagram", own?.channel === "instagram", own?.channel);
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
