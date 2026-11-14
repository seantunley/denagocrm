/**
 * REAL-DATABASE proof of DAX's `test_drives` lookup (assistantTestDrivesLookup.ts) — held to the /test-drives page's
 * own rule (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-test-drives     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - the owner sees every drive, with who ran it, the outcome and whether the customer bought;
 *  - a rep who may open only their own customers sees their drives — never a colleague's customer — and a won deal
 *    they can't open is never named;
 *  - "didn't buy" (boughtAfter false) leaves out the drive followed by a won deal;
 *  - no activities permission → refused; Automotive off → refused; the other workspace sees nothing of A's;
 *  - no licence number, emergency contact or incident text anywhere in the answer.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { testDrivesLookup, type TestDrivesArgs } from "../src/lib/assistantTestDrivesLookup";
import type { PermissionUser } from "../src/lib/permissions";
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
const ago = (days: number) => new Date(Date.now() - days * DAY);
const LICENCE = `LIC${SFX}`;
const EMERGENCY = `Emergency ${SFX}`;
const INCIDENT = `Incident ${SFX}`;
type Row = { total?: number | string; customer?: string; ranBy?: string; bought?: boolean; wonDeal?: unknown; note?: string; feedback?: string };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`tdr${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Rep Own");
  const colleague = user("Rep Other");
  const noActs = user("No Activities");
  const ROLE_OWN = crypto.randomUUID();
  const ROLE_NO_ACTS = crypto.randomUUID();
  const savedModules = (await basePrisma.tenant.findUnique({ where: { id: A }, select: { modules: true } }))?.modules ?? "";
  // Automotive on for the run, whatever the fixture had (restored in cleanup).
  await basePrisma.tenant.update({ where: { id: A }, data: { modules: [...new Set([...savedModules.split(","), "automotive"])].filter(Boolean).join(",") } });

  for (const u of [rep, colleague, noActs]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holders] of [
    [ROLE_OWN, ["activities.view", "contacts.view_owned", "leads.view_owned"], [rep, colleague]],
    [ROLE_NO_ACTS, ["contacts.view_owned", "leads.view_owned"], [noActs]],
  ] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Test drives ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    for (const h of holders) await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${h.id}, ${role}, ${A})`;
  }

  const contact = (first: string, ownerId: string) =>
    basePrisma.contact.create({ data: { tenantId: A, firstName: first, lastName: `Drive${SFX}`, ownerId }, select: { id: true } });
  const drive = (contactId: string, salespersonId: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
    basePrisma.testDriveBooking.create({
      data: {
        tenantId: A, reference: `TD-${SFX}-${crypto.randomUUID().slice(0, 6)}`, contactId, branch: "Cape Town", salespersonId,
        scheduledStart: ago(daysAgo), expectedReturnAt: new Date(ago(daysAgo).getTime() + 3_600_000), status: "completed",
        driverLicenceNumber: LICENCE, emergencyContactName: EMERGENCY, incidentReport: INCIDENT, ...extra,
      },
      select: { id: true },
    });

  // Anna: the rep's customer. She drove 5 days ago and bought (a won deal the REP may open).
  const anna = await contact("Anna", rep.id);
  await drive(anna.id, rep.id, 5, { salesOutcome: "follow_up", customerFeedback: `Loved the ride ${SFX}` });
  await basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, status: "won", name: `Anna Drive${SFX}`, title: "Rover XL", contactId: anna.id, assignedToId: rep.id, createdById: rep.id, wonAt: ago(2) } });
  // Ben: the rep's customer. He drove 3 days ago and didn't buy.
  const ben = await contact("Ben", rep.id);
  await drive(ben.id, rep.id, 3, { salesOutcome: "undecided" });
  // Cara: the COLLEAGUE's customer, the colleague's drive — never the rep's to see.
  const cara = await contact("Cara", colleague.id);
  await drive(cara.id, colleague.id, 4, { salesOutcome: "no_interest" });
  // Upcoming: the rep's drive with Ben next week.
  await drive(ben.id, rep.id, -7, { status: "booked" });

  const run = (tenantId: string, u: PermissionUser, args: TestDrivesArgs = {}) =>
    runInTenantScope({ tenantId, system: false }, () => testDrivesLookup(u, args));
  const rows = (out: { data: unknown[] }) => out.data as Row[];
  const mine = (r: Row[]) => r.slice(1).filter((x) => x.customer?.endsWith(`Drive${SFX}`));

  try {
    __setTenantEnforcingForTests(true);

    console.log("\ntest_drives — the owner");
    const owner = rows(await run(A, ownerA, { limit: 60 }));
    const names = mine(owner).map((r) => r.customer);
    check("the owner sees every drive: Anna, Ben (twice), Cara", names.filter((n) => n?.startsWith("Ben")).length === 2 && names.some((n) => n?.startsWith("Anna")) && names.some((n) => n?.startsWith("Cara")), JSON.stringify(names));
    const annaRow = mine(owner).find((r) => r.customer?.startsWith("Anna"));
    check("…Anna bought after her drive, with the won deal named", annaRow?.bought === true && Boolean(annaRow?.wonDeal) && annaRow?.ranBy === "Rep Own", JSON.stringify(annaRow));
    check("…her feedback is shown", annaRow?.feedback === `Loved the ride ${SFX}`);
    const notBought = rows(await run(A, ownerA, { boughtAfter: false, to: new Date().toISOString().slice(0, 10), limit: 60 }));
    check("didn't buy: Ben and Cara, never Anna", !mine(notBought).some((r) => r.customer?.startsWith("Anna")) && mine(notBought).some((r) => r.customer?.startsWith("Ben")) && mine(notBought).some((r) => r.customer?.startsWith("Cara")), JSON.stringify(mine(notBought).map((r) => r.customer)));
    const byName = rows(await run(A, ownerA, { customer: "Anna" }));
    check("by customer name: Anna's only", mine(byName).length === 1 && mine(byName)[0].customer?.startsWith("Anna") === true, JSON.stringify(byName));

    console.log("\ntest_drives — a rep who may open only their own customers");
    const repOut = rows(await run(A, rep, { limit: 60 }));
    check("sees their own drives", mine(repOut).some((r) => r.customer?.startsWith("Anna")) && mine(repOut).some((r) => r.customer?.startsWith("Ben")), JSON.stringify(mine(repOut).map((r) => r.customer)));
    check("…never the colleague's customer", !mine(repOut).some((r) => r.customer?.startsWith("Cara")));
    const colleagueOut = rows(await run(A, colleague, { limit: 60 }));
    check("the colleague sees Cara, and Anna's drive is not theirs", mine(colleagueOut).some((r) => r.customer?.startsWith("Cara")) && !mine(colleagueOut).some((r) => r.customer?.startsWith("Anna")));

    console.log("\ntest_drives — refused");
    check("no activities permission: refused", /can't open test drives/.test(String(rows(await run(A, noActs))[0].note)));
    const otherWs = rows(await run(b.tenantId, memberB, { limit: 60 }));
    check("the other workspace sees nothing of A's", !JSON.stringify(otherWs).includes(SFX), JSON.stringify(otherWs[0]));
    check("never the licence number, emergency contact or incident report", ![LICENCE, EMERGENCY, INCIDENT].some((s) => JSON.stringify(owner).includes(s)));
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules.split(",").filter((m) => m && m !== "automotive").join(",") } });
    check("Automotive off: refused", /Automotive module/.test(String(rows(await run(A, ownerA))[0].note)));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules } }).catch(() => 0);
    await basePrisma.testDriveBooking.deleteMany({ where: { tenantId: A, reference: { startsWith: `TD-${SFX}` } } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: `Drive${SFX}` } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { tenantId: A, lastName: `Drive${SFX}` } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${ROLE_OWN}, ${ROLE_NO_ACTS})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" IN (${ROLE_OWN}, ${ROLE_NO_ACTS})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" IN (${ROLE_OWN}, ${ROLE_NO_ACTS})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${colleague.id}, ${noActs.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${colleague.id}, ${noActs.id})`.catch(() => 0);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
