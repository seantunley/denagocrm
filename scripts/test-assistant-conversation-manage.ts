/**
 * REAL-DATABASE proof of searching, renaming and deleting DAX conversations (assistantConversation.ts,
 * actions/assistantConversations.ts; Sean, 2026-11-14: "no search across past conversations, and no rename or delete").
 *
 *   npm run test:assistant-conversation-manage     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - search finds the person's OWN conversations by title and by what was said in them — never a colleague's (not even
 *    for the workspace owner), never another workspace's, never a deleted one;
 *  - the rename/delete writes (keyed as the actions key them: id + workspace + person) change nothing of a colleague's
 *    or of another workspace's;
 *  - a deleted conversation is gone from the list, can't be picked or continued, and its exchanges are gone from what
 *    DAX recalls (liveTurnsWhere), while turns in no conversation stay; restored, it is back;
 *  - deleted over 60 days ago, the nightly purge removes it and its exchanges; a recent one stays.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import { basePrisma, prisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import {
  currentConversation, deletedConversations, liveTurnsWhere, pickConversation, recentConversations, searchConversations,
} from "../src/lib/assistantConversation";
import { purgeTrash } from "../src/lib/trash";
import { seedTwoTenants, teardown } from "./harness/seed";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const DAY = 86_400_000;

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`cvm${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const me = { tenantId: A, userId: a.memberUserId };
  const owner = { tenantId: A, userId: a.ownerUserId };
  const other = { tenantId: b.tenantId, userId: b.memberUserId };
  const inA = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: A, system: false }, fn);
  const convIds: string[] = [];

  const conversation = async (who: { tenantId: string; userId: string }, title: string, said: string, opts: { deletedAt?: Date; updatedAt?: Date } = {}) => {
    const c = await basePrisma.assistantConversation.create({
      data: { tenantId: who.tenantId, userId: who.userId, title: `${title} ${SFX}`, ...opts },
      select: { id: true },
    });
    convIds.push(c.id);
    await basePrisma.assistantTurn.create({
      data: { tenantId: who.tenantId, userId: who.userId, conversationId: c.id, source: "chat", question: `What about ${said}?`, answer: `${said} is waiting on the deposit.` },
    });
    return c.id;
  };

  try {
    // Mine: one named for Anna, one where a Rover was only SAID. A colleague's (the owner's) and another workspace's
    // with the same words. A deleted one of mine, recent; and one deleted 61 days ago.
    const anna = await conversation(me, "Anna quote", `Kumquat${SFX}`);
    const rover = await conversation(me, "Monday follow-ups", `Rover${SFX}`);
    const owners = await conversation(owner, "Anna quote", `Kumquat${SFX}`);
    const othersWs = await conversation(other, "Anna quote", `Kumquat${SFX}`);
    const gone = await conversation(me, "Deleted chat", `Kumquat${SFX}`, { deletedAt: new Date() });
    const old = await conversation(me, "Old deleted", `Ancient${SFX}`, { deletedAt: new Date(Date.now() - 61 * DAY) });
    // A turn in no conversation (from before conversations): never dropped by the deleted-conversation filter.
    const loose = await basePrisma.assistantTurn.create({
      data: { tenantId: A, userId: me.userId, source: "chat", question: `Loose ${SFX}?`, answer: "Yes." },
      select: { id: true },
    });

    __setTenantEnforcingForTests(true);

    console.log("\nsearch — my own, live conversations only");
    const byTitle = await inA(() => searchConversations(me, `anna quote ${SFX}`));
    check("by title, any case: mine", byTitle.length === 1 && byTitle[0].id === anna, JSON.stringify(byTitle.map((c) => c.id)));
    const bySaid = await inA(() => searchConversations(me, `rover${SFX}`));
    check("by what was said: that conversation, with the words around it", bySaid.length === 1 && bySaid[0].id === rover && /Rover/.test(bySaid[0].snippet ?? ""), JSON.stringify(bySaid));
    const word = await inA(() => searchConversations(me, `Kumquat${SFX}`));
    const ids = word.map((c) => c.id);
    check("never the owner's, another workspace's or a deleted one", ids.length === 1 && ids[0] === anna, JSON.stringify(ids));
    check("the owner searching sees their own only", (await inA(() => searchConversations(owner, `Kumquat${SFX}`))).every((c) => c.id === owners));
    check("one letter searches nothing", (await inA(() => searchConversations(me, "a"))).length === 0);

    console.log("\nrename / delete — keyed by id + workspace + person, as the actions write");
    const write = (who: { tenantId: string; userId: string }, id: string) =>
      inA(() => prisma.assistantConversation.updateMany({ where: { id, tenantId: who.tenantId, userId: who.userId, deletedAt: null }, data: { title: `Hijacked ${SFX}` } }));
    check("a colleague's conversation: nothing changed", (await write(me, owners)).count === 0);
    check("another workspace's, by id: nothing changed", (await write(me, othersWs)).count === 0 && (await write(other, othersWs)).count === 0);
    check("a deleted one can't be renamed", (await write(me, gone)).count === 0);
    const titles = await basePrisma.assistantConversation.findMany({ where: { id: { in: [owners, othersWs, gone] } }, select: { title: true } });
    check("…their titles are untouched", titles.every((t) => !t.title.startsWith("Hijacked")));

    console.log("\na deleted conversation is gone — from the list, the picker and DAX's memory");
    const list = await inA(() => recentConversations(me, 100));
    check("not in the list", !list.some((c) => c.id === gone) && list.some((c) => c.id === anna));
    const picked = await inA(() => pickConversation(me, { requested: gone }));
    convIds.push(picked.id);
    check("asking in it by id starts elsewhere, never continues it", picked.id !== gone);
    check("not the current one either", (await inA(() => currentConversation(me, null))) !== gone);
    const live = await inA(() => liveTurnsWhere(A, me.userId));
    const remembered = await inA(() => prisma.assistantTurn.findMany({ where: { tenantId: A, userId: me.userId, AND: [live] }, select: { id: true, conversationId: true } }));
    check("its exchanges are not among what DAX may recall", !remembered.some((t) => t.conversationId === gone || t.conversationId === old));
    check("…while a turn in no conversation stays", remembered.some((t) => t.id === loose.id));
    const recall = await inA(() => prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AssistantTurn" WHERE "tenantId" = ${A} AND "userId" = ${me.userId}
        AND NOT EXISTS (SELECT 1 FROM "AssistantConversation" c WHERE c."id" = "AssistantTurn"."conversationId" AND c."deletedAt" IS NOT NULL)`);
    check("recall's own SQL filter agrees", recall.length === remembered.length && recall.some((t) => t.id === loose.id), `${recall.length} vs ${remembered.length}`);
    const trash = await inA(() => deletedConversations(me));
    check("Recently deleted lists it — not the one past 60 days", trash.some((c) => c.id === gone) && !trash.some((c) => c.id === old));
    check("…and never a colleague's", (await inA(() => deletedConversations(owner))).length === 0);

    console.log("\nrestore");
    await inA(() => prisma.assistantConversation.updateMany({ where: { id: gone, tenantId: A, userId: me.userId, deletedAt: { not: null } }, data: { deletedAt: null } }));
    check("back in the list and in search", (await inA(() => recentConversations(me, 100))).some((c) => c.id === gone) && (await inA(() => searchConversations(me, `Deleted chat ${SFX}`))).length === 1);

    console.log("\nthe nightly purge, after 60 days");
    __setTenantEnforcingForTests(null);
    await purgeTrash();
    const left = await basePrisma.assistantConversation.findMany({ where: { id: { in: [old, gone] } }, select: { id: true } });
    check("the one deleted 61 days ago is gone; the restored one stays", left.length === 1 && left[0].id === gone, JSON.stringify(left));
    check("…and its exchanges went with it", (await basePrisma.assistantTurn.count({ where: { conversationId: old } })) === 0);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.assistantTurn.deleteMany({ where: { OR: [{ conversationId: { in: convIds } }, { question: { contains: SFX } }] } }).catch(() => 0);
    await basePrisma.assistantConversation.deleteMany({ where: { id: { in: convIds } } }).catch(() => 0);
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
