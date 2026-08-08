/**
 * CONCURRENT proof that two people cannot silently overwrite each other's reply
 * draft.
 *
 * The pure tests cannot detect this class of bug. Every individual call to
 * draftCollision is correct; the defect lived entirely in the gap between reading
 * the draft and writing it:
 *
 *   Sean                        Jane
 *   ─────                       ────
 *   read → no draft
 *                               read → no draft
 *   collision? no
 *                               collision? no
 *   upsert Sean's draft
 *                               upsert Jane's draft   ← wins, nobody warned
 *
 * Only two real writes racing on a real database can show it, which is why this
 * is a script and not a unit test. Same shape as
 * test-platform-admin-concurrency.ts.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { claimConversationDraft } from "../src/lib/conversationDraftStore";
import { DRAFT_COLLISION_WINDOW_MS } from "../src/lib/conversationDraft";

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
  userA: `u_a_${SFX}`,
  userB: `u_b_${SFX}`,
  contact: `c_${SFX}`,
  conversation: `conv_${SFX}`,
};

async function seed() {
  await basePrisma.user.createMany({
    data: [
      { id: ids.userA, name: "Sean", email: `sean.${SFX}@example.test`, passwordHash: "x", role: "sales" },
      { id: ids.userB, name: "Jane", email: `jane.${SFX}@example.test`, passwordHash: "x", role: "sales" },
    ],
  });
  await basePrisma.contact.create({
    data: { id: ids.contact, firstName: "Cust", createdById: ids.userA },
  });
  await basePrisma.conversation.create({
    data: { id: ids.conversation, channel: "whatsapp", contactId: ids.contact },
  });
}

async function cleanup() {
  await basePrisma.conversationDraft.deleteMany({ where: { conversationId: ids.conversation } });
  await basePrisma.conversation.deleteMany({ where: { id: ids.conversation } });
  await basePrisma.contact.deleteMany({ where: { id: ids.contact } });
  await basePrisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB] } } });
}

async function currentDraft() {
  return basePrisma.conversationDraft.findUnique({
    where: { conversationId: ids.conversation },
    select: { ownerId: true, body: true },
  });
}

async function main() {
  guardEnvironment();
  await seed();

  // ── 1. THE RACE ───────────────────────────────────────────────────────────
  //
  // Both claims are issued without awaiting the first, so they reach the database
  // together. Exactly one must win, and the loser must be TOLD.
  const [first, second] = await Promise.all([
    claimConversationDraft(ids.conversation, ids.userA, "Sean's reply"),
    claimConversationDraft(ids.conversation, ids.userB, "Jane's reply"),
  ]);

  const winners = [first, second].filter((r) => r.ok).length;
  check("exactly one concurrent claim succeeds", winners === 1, `${winners} succeeded`);
  check("the loser is told there is a collision", [first, second].some((r) => !r.ok));

  const afterRace = await currentDraft();
  const winnerId = first.ok ? ids.userA : ids.userB;
  check(
    "the stored draft belongs to the claim that won",
    afterRace?.ownerId === winnerId,
    `stored owner ${afterRace?.ownerId}, expected ${winnerId}`,
  );
  check(
    "the stored body is the winner's, not a mix",
    afterRace?.body === (first.ok ? "Sean's reply" : "Jane's reply"),
    `stored body ${JSON.stringify(afterRace?.body)}`,
  );

  // ── 2. THE OWNER MAY KEEP TYPING ──────────────────────────────────────────
  const again = await claimConversationDraft(ids.conversation, winnerId, "more text");
  check("the owner can update their own draft", again.ok);
  check("and the update is stored", (await currentDraft())?.body === "more text");

  // ── 3. THE LOSER IS STILL REFUSED ─────────────────────────────────────────
  const loserId = winnerId === ids.userA ? ids.userB : ids.userA;
  const refused = await claimConversationDraft(ids.conversation, loserId, "sneaking in");
  check("a colleague is refused while the draft is fresh", !refused.ok);
  check("and nothing they sent was written", (await currentDraft())?.body === "more text");
  if (!refused.ok) {
    const expected = winnerId === ids.userA ? "Sean" : "Jane";
    check("the refusal names the current owner", refused.collision.ownerName === expected, refused.collision.ownerName);
  }

  // ── 4. A STALE DRAFT IS TAKEABLE ──────────────────────────────────────────
  //
  // Aged past the window using the DATABASE clock, the same clock the claim
  // compares against — ageing it with the app's clock would test nothing about
  // how the statement actually decides.
  await basePrisma.$executeRaw`
    UPDATE "ConversationDraft"
       SET "updatedAt" = now() - make_interval(secs => ${DRAFT_COLLISION_WINDOW_MS / 1000 + 60})
     WHERE "conversationId" = ${ids.conversation}
  `;
  const takeover = await claimConversationDraft(ids.conversation, loserId, "taking over");
  check("an abandoned draft can be taken over", takeover.ok);
  check("and the new owner holds it", (await currentDraft())?.ownerId === loserId);

  // ── 5. CONCURRENT TAKEOVER OF A STALE DRAFT ───────────────────────────────
  //
  // The nastier version: the draft is stale, so BOTH callers are entitled to it.
  // One statement each still means one winner, not a merged body.
  await basePrisma.$executeRaw`
    UPDATE "ConversationDraft"
       SET "updatedAt" = now() - make_interval(secs => ${DRAFT_COLLISION_WINDOW_MS / 1000 + 60})
     WHERE "conversationId" = ${ids.conversation}
  `;
  const [ta, tb] = await Promise.all([
    claimConversationDraft(ids.conversation, ids.userA, "A takeover"),
    claimConversationDraft(ids.conversation, ids.userB, "B takeover"),
  ]);
  const staleWinners = [ta, tb].filter((r) => r.ok).length;
  check("a stale draft is claimed by exactly one of two racers", staleWinners === 1, `${staleWinners} succeeded`);
  const finalDraft = await currentDraft();
  check(
    "the final body is one racer's whole text",
    finalDraft?.body === "A takeover" || finalDraft?.body === "B takeover",
    JSON.stringify(finalDraft?.body),
  );

  // ── 6. ONE ROW, ALWAYS ────────────────────────────────────────────────────
  const count = await basePrisma.conversationDraft.count({ where: { conversationId: ids.conversation } });
  check("a conversation never accumulates more than one draft", count === 1, `${count} rows`);
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
