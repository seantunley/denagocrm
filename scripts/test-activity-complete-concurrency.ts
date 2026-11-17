/**
 * A follow-up marked DONE carries its note, and is done once (review of #1152).
 *
 *  1. A note that fails to save leaves the activity PLANNED — never done with no record of what happened.
 *  2. Two Confirms of the same follow-up racing: exactly one marks it done and writes one note; the other changes
 *     nothing.
 *
 * Only real transactions on a real database can show either, so this is a script, run by CI (security-rbac-ci.yml)
 * like test-checklist-template-concurrency.ts.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { completePlannedActivity } from "../src/lib/activityComplete";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" - the name must end in _test`);
}

const ids = { tenant: `t_${SFX}`, user: `u_${SFX}`, failing: `act_fail_${SFX}`, racing: `act_race_${SFX}` };
const TAKEN_KEY = `taken_${SFX}`;

async function seed() {
  await basePrisma.tenant.create({ data: { id: ids.tenant, name: `Activity done ${SFX}`, slug: `activity-done-${SFX}`, active: true } });
  await basePrisma.user.create({
    data: { id: ids.user, name: "Done Probe", email: `done-probe-${SFX}@example.test`, passwordHash: "not-a-real-hash", role: "owner", tenantId: ids.tenant },
  });
  for (const id of [ids.failing, ids.racing]) {
    await basePrisma.activity.create({
      data: { id, tenantId: ids.tenant, type: "call", summary: `Follow up ${SFX}`, dueDate: new Date(), assignedToId: ids.user, createdById: ids.user },
    });
  }
  // A note already holding a dedupe key: a second note with the same key fails, as any failed write would.
  await basePrisma.communication.create({ data: { tenantId: ids.tenant, type: "note", body: "earlier", userId: ids.user, dedupeKey: TAKEN_KEY } });
}

async function cleanup() {
  await basePrisma.communication.deleteMany({ where: { tenantId: ids.tenant } });
  await basePrisma.activity.deleteMany({ where: { tenantId: ids.tenant } });
  await basePrisma.user.deleteMany({ where: { id: ids.user } });
  await basePrisma.tenant.deleteMany({ where: { id: ids.tenant } });
}

const note = (body: string) => ({ type: "call", direction: "outbound", subject: "Activity done", body, leadId: null, contactId: null, userId: ids.user });

/**
 * One Done, as finishActivity runs it: its own transaction. Thrown = it failed. `failNote` makes the note write fail
 * the way any failed write would (a dedupe key already taken), through the same transaction.
 */
async function done(id: string, body: string, failNote = false) {
  try {
    return {
      ok: await basePrisma.$transaction((tx) => {
        const communication = failNote
          ? { create: (args: { data: object }) => tx.communication.create({ data: { ...args.data, dedupeKey: TAKEN_KEY } as never }) }
          : tx.communication;
        return completePlannedActivity({ activity: tx.activity, communication }, { id, now: new Date(), tenantId: ids.tenant, note: note(body) });
      }),
    };
  } catch (error) {
    return { ok: false, threw: String(error) };
  }
}

async function main() {
  guardEnvironment();
  await seed();

  // ── 1. A FAILED NOTE ROLLS THE DONE BACK ──
  const failedDone = await done(ids.failing, "Updated Derek. Awaiting Ivan.", true);
  check("a done whose note fails reports failure", !failedDone.ok && "threw" in failedDone);
  const stillPlanned = await basePrisma.activity.findUnique({ where: { id: ids.failing }, select: { status: true, doneAt: true } });
  check("and the activity is still planned, with no done time", stillPlanned?.status === "planned" && stillPlanned.doneAt === null, JSON.stringify(stillPlanned));
  const retried = await done(ids.failing, "Updated Derek. Awaiting Ivan.");
  check("so it can be done again, with its note", retried.ok === true);

  // ── 2. TWO CONFIRMS AT ONCE ──
  const [a, b] = await Promise.all([done(ids.racing, "Confirm A"), done(ids.racing, "Confirm B")]);
  check("exactly one of two racing Confirms marks it done", [a.ok, b.ok].filter(Boolean).length === 1, JSON.stringify([a, b]));
  const notes = await basePrisma.communication.findMany({ where: { tenantId: ids.tenant, body: { in: ["Confirm A", "Confirm B"] } }, select: { body: true } });
  check("and exactly one note is written - the winner's", notes.length === 1 && notes[0].body === (a.ok ? "Confirm A" : "Confirm B"), JSON.stringify(notes));
  const after = await basePrisma.activity.findUnique({ where: { id: ids.racing }, select: { status: true } });
  check("the activity is done", after?.status === "done");
  const late = await done(ids.racing, "Confirm C");
  check("a later Confirm changes nothing", late.ok === false && !("threw" in late));
  check("and writes no note", (await basePrisma.communication.count({ where: { tenantId: ids.tenant, body: "Confirm C" } })) === 0);
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
