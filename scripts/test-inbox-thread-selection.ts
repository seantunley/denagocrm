/**
 * ONE LOUD CONVERSATION MAY NOT STARVE THE QUIET ONES.
 *
 * The inbox used to take the newest 400 Communication rows and group them into
 * threads afterwards, so thread SELECTION competed with message VOLUME: a single
 * busy conversation could consume the whole slice and every other thread — active
 * or unread — vanished from the queue and from the sidebar badge, silently.
 *
 * Choosing threads first fixes only half of that. If the messages for the chosen
 * threads are then read with ONE `take` across all of them, the budget is still
 * handed out in global recency order and the loud thread eats it again: the quiet
 * threads are selected and then arrive with zero rows, which renders exactly the
 * same empty queue one step later. The limit has to be PER THREAD.
 *
 * A source assertion cannot tell those two apart — both "select threads, then
 * load messages" and both bounded. Only a dataset with a genuinely dominant
 * conversation can, which is what this does: one thread carrying far more recent
 * messages than the whole page budget, alongside quiet threads that must still
 * arrive with their messages and must still be counted as unread.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma, prisma } from "../src/lib/db";
import { loadInboxComms, MESSAGES_PER_THREAD, THREAD_PAGE_SIZE } from "../src/lib/inboxQuery";
import { buildInboxThreads } from "../src/lib/inboxThreads";
import { awaitingReplyCount } from "../src/lib/inboxCount";

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
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = {
  user: `u_inbox_${SFX}`,
  loud: `c_loud_${SFX}`,
  quiet: (n: number) => `c_quiet_${SFX}_${n}`,
};

/** Quiet threads, each with a handful of messages. */
const QUIET_THREADS = 12;
/**
 * Messages in the dominant thread. Comfortably more than the whole page budget
 * (THREAD_PAGE_SIZE * MESSAGES_PER_THREAD), so under a single global `take` it
 * alone would consume every row and leave nothing for anyone else.
 */
const LOUD_MESSAGES = THREAD_PAGE_SIZE * MESSAGES_PER_THREAD + 50;

const contactIds = () => [ids.loud, ...Array.from({ length: QUIET_THREADS }, (_, n) => ids.quiet(n))];

async function seed() {
  await basePrisma.user.create({
    data: {
      id: ids.user,
      name: "Inbox tester",
      email: `${ids.user}@example.test`,
      passwordHash: "x",
      role: "admin",
    },
  });

  for (const contactId of contactIds()) {
    await basePrisma.contact.create({
      data: { id: contactId, firstName: contactId, whatsapp: `27${contactId.slice(-9)}`, createdById: ids.user },
    });
  }

  const now = Date.now();

  // The quiet threads are OLDER than every message in the loud one, so global
  // recency ordering would rank all of their rows last. They are still among the
  // most recently active threads — there are only 13 threads in total — which is
  // exactly the distinction the fix has to preserve.
  const quietRows = [];
  for (let n = 0; n < QUIET_THREADS; n++) {
    for (let m = 0; m < 3; m++) {
      quietRows.push({
        type: "whatsapp",
        // The newest message of each quiet thread is an unopened inbound one, so
        // each is a thread the sidebar badge must count.
        direction: m === 2 ? "inbound" : "outbound",
        readAt: null,
        body: `quiet ${n} message ${m}`,
        occurredAt: new Date(now - 10_000_000 + n * 1000 + m * 100),
        contactId: ids.quiet(n),
        userId: ids.user,
      });
    }
  }
  await basePrisma.communication.createMany({ data: quietRows });

  // The dominant conversation: every message newer than every quiet one.
  const loudRows = Array.from({ length: LOUD_MESSAGES }, (_, m) => ({
    type: "whatsapp",
    direction: m % 2 === 0 ? "inbound" : ("outbound" as string),
    // Read, so the badge count below is exactly the quiet threads and the loud
    // one cannot mask an off-by-one.
    readAt: new Date(now),
    body: `loud ${m}`,
    occurredAt: new Date(now - LOUD_MESSAGES * 100 + m * 100),
    contactId: ids.loud,
    userId: ids.user,
  }));
  await basePrisma.communication.createMany({ data: loudRows });
}

async function cleanup() {
  await basePrisma.communication.deleteMany({ where: { contactId: { in: contactIds() } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: contactIds() } } });
  await basePrisma.user.deleteMany({ where: { id: ids.user } });
}

async function main() {
  guardEnvironment();
  await seed();

  const comms = await loadInboxComms({ contactId: { in: contactIds() } });
  const threads = buildInboxThreads(comms);
  const byContact = new Map(threads.map((thread) => [thread.contactId ?? "", thread]));

  check(
    "every seeded conversation is rendered, not just the loud one",
    threads.length === QUIET_THREADS + 1,
    `expected ${QUIET_THREADS + 1} threads, got ${threads.length}`,
  );

  const starved = Array.from({ length: QUIET_THREADS }, (_, n) => ids.quiet(n)).filter(
    (id) => !byContact.has(id),
  );
  check(
    "no quiet conversation is starved of its messages by the loud one",
    starved.length === 0,
    `${starved.length} of ${QUIET_THREADS} quiet threads came back with no rows`,
  );

  const perThread = new Map<string, number>();
  for (const comm of comms) perThread.set(comm.contactId ?? "", (perThread.get(comm.contactId ?? "") ?? 0) + 1);

  check(
    "the loud conversation is capped at its own per-thread budget",
    perThread.get(ids.loud) === MESSAGES_PER_THREAD,
    `loud thread returned ${perThread.get(ids.loud)} rows, expected ${MESSAGES_PER_THREAD}`,
  );
  check(
    "no conversation exceeds the per-thread budget",
    [...perThread.values()].every((count) => count <= MESSAGES_PER_THREAD),
    JSON.stringify([...perThread.entries()]),
  );

  // Per-thread means the NEWEST of that thread, not an arbitrary slice.
  const loudBodies = comms.filter((c) => c.contactId === ids.loud).map((c) => c.body);
  const expectedNewest = Array.from(
    { length: MESSAGES_PER_THREAD },
    (_, i) => `loud ${LOUD_MESSAGES - 1 - i}`,
  );
  check(
    "a conversation's slice is its newest messages",
    JSON.stringify(loudBodies) === JSON.stringify(expectedNewest),
    `got ${JSON.stringify(loudBodies)}`,
  );

  // And the sidebar badge, which asked the same question through the same slice.
  const unread = await awaitingReplyCount({
    id: ids.user,
    name: "Inbox tester",
    email: `${ids.user}@example.test`,
    role: "owner",
  });
  check(
    "the unread badge counts quiet threads the loud one would have buried",
    unread >= QUIET_THREADS,
    `expected at least ${QUIET_THREADS} unread threads, got ${unread}`,
  );

  // The loud thread's newest message is outbound and read, so it must NOT count —
  // proving the badge is still discriminating and not merely counting threads.
  const loudThread = byContact.get(ids.loud);
  check(
    "the loud thread is not itself counted as unread",
    loudThread ? !loudThread.unread : false,
    `loud thread unread=${loudThread?.unread}`,
  );
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
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await basePrisma.$disconnect();
  });
