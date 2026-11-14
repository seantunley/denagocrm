/**
 * REAL-DATABASE proof of DAX's `customers` lookup (assistantCustomersLookup.ts) — customers as a list, held to the
 * customers page's own rule (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-customer-lists     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - the owner sees every matching customer in the area; a rep who may open only their own sees only theirs;
 *  - the other workspace sees nothing of A's; someone without customer access is refused;
 *  - the filters work: area, birthday window (in day order), date added, tag, open deal, fleet;
 *  - fleets need the Automotive module and fleets.view — a rep without it can't filter by fleet.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { customersLookup } from "../src/lib/assistantCustomersLookup";
import { customersArgs } from "../src/lib/crmAssistantPlan";
import { nextDays } from "../src/lib/birthdays";
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

type Row = { customer?: string; total?: number; listed?: number; note?: string; area?: string; fleet?: string | null; birthday?: string | null };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`cul${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const B = b.tenantId;
  const AREA = `Constantia${SFX}`;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ownerB: PermissionUser = { id: b.ownerUserId, name: "Harness B owner", email: "", role: "owner" };
  const user = (n: string): PermissionUser => ({ id: crypto.randomUUID(), name: `${n} ${SFX}`, email: `${n.toLowerCase()}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Rep");
  const noCustomers = user("NoCustomers");
  const OWN = crypto.randomUUID();
  const NONE = crypto.randomUUID();
  for (const u of [rep, noCustomers]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holder] of [[OWN, ["contacts.view_owned"], rep], [NONE, ["leads.view_owned"], noCustomers]] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Customer lists ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
  }
  // Automotive on for A (the harness workspaces are removed afterwards).
  await basePrisma.tenant.update({ where: { id: A }, data: { modules: "automation,automotive" } });

  const [today, , , inThree] = nextDays(4);
  const fleet = await basePrisma.fleet.create({ data: { tenantId: A, name: `Pearl Valley ${SFX}` }, select: { id: true } });
  const tag = await basePrisma.tag.create({ data: { tenantId: A, name: `VIP ${SFX}` }, select: { id: true } });
  const contact = (first: string, ownerId: string, extra: Record<string, unknown> = {}, tenantId = A) =>
    basePrisma.contact.create({ data: { tenantId, firstName: first, lastName: SFX, suburb: AREA, ownerId, createdById: ownerId, ...extra }, select: { id: true } });
  // The rep's own: a birthday TODAY, added in October, tagged VIP, with an open deal.
  const repOwn = await contact("Rina", rep.id, { birthDay: today.day, birthMonth: today.month, createdAt: new Date("2026-10-05T10:00:00+02:00"), tags: { connect: { id: tag.id } } });
  await basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, status: "open", name: `Rina ${SFX}`, title: "Rover XL", contactId: repOwn.id, createdById: rep.id, assignedToId: rep.id } });
  // The owner's: a birthday in three days, added in September; and one on the Pearl Valley fleet, added in October.
  await contact("Owen", a.ownerUserId, { birthDay: inThree.day, birthMonth: inThree.month, createdAt: new Date("2026-09-10T10:00:00+02:00") });
  await contact("Fleur", a.ownerUserId, { isCompany: true, fleetId: fleet.id, createdAt: new Date("2026-10-20T10:00:00+02:00") });
  // The REP's own fleet member — the rep has no fleet access, so must never learn it is on a fleet (review of #1103).
  await contact("Fiona", rep.id, { isCompany: true, fleetId: fleet.id, createdAt: new Date("2026-08-01T10:00:00+02:00") });
  // BIRTHDAY RANKING (review of #1103): 505 newer customers with a birthday in five days, and the OLDEST-created
  // customer with a birthday today — it must lead, not be lost behind the newest 500.
  const BULK = `Bulk${SFX}`;
  const inFive = nextDays(6)[5];
  await basePrisma.contact.createMany({
    data: Array.from({ length: 505 }, (_, i) => ({
      tenantId: A, firstName: `B${String(i).padStart(3, "0")}`, lastName: SFX, suburb: BULK, ownerId: a.ownerUserId, createdById: a.ownerUserId,
      birthDay: inFive.day, birthMonth: inFive.month, createdAt: new Date(Date.now() - i * 60_000),
    })),
  });
  await contact("Oldest", a.ownerUserId, { suburb: BULK, birthDay: today.day, birthMonth: today.month, createdAt: new Date("2020-01-01T10:00:00+02:00") });
  // The same area in the OTHER workspace.
  await contact("Other", b.ownerUserId, {}, B);

  const run = (tenantId: string, u: PermissionUser, args: Record<string, unknown>) =>
    runInTenantScope({ tenantId, system: false }, () => customersLookup(u, customersArgs.parse(args)));
  const rows = async (tenantId: string, u: PermissionUser, args: Record<string, unknown>) => (await run(tenantId, u, args)).data as Row[];
  const names = (r: Row[]) => r.slice(1).map((x) => x.customer ?? "");

  try {
    __setTenantEnforcingForTests(true);

    console.log("\nWho sees what");
    const all = await rows(A, ownerA, { area: AREA, limit: 60 });
    check("the owner sees all four in the area", all[0].total === 4 && names(all).length === 4, JSON.stringify(all[0]));
    const mine = await rows(A, rep, { area: AREA, limit: 60 });
    check("a rep who may open only their own sees only theirs", mine[0].total === 2 && JSON.stringify(names(mine).sort()) === JSON.stringify([`Fiona ${SFX}`, `Rina ${SFX}`]), JSON.stringify(names(mine)));
    const other = await rows(B, ownerB, { area: AREA, limit: 60 });
    check("the other workspace sees only its own", other[0].total === 1 && names(other)[0] === `Other ${SFX}`, JSON.stringify(names(other)));
    const refused = await rows(A, noCustomers, { area: AREA });
    check("no customer access: refused", /don't have access to customers/.test(refused[0].note ?? ""), JSON.stringify(refused));

    console.log("\nFilters");
    const birthdays = await rows(A, ownerA, { area: AREA, birthdayWithinDays: 7 });
    check("birthdays this week: both, today's first", JSON.stringify(names(birthdays)) === JSON.stringify([`Rina ${SFX}`, `Owen ${SFX}`]), JSON.stringify(names(birthdays)));
    check("…each with its day and month", birthdays.slice(1).every((r) => typeof r.birthday === "string" && !/\d{4}/.test(r.birthday)));
    const todayOnly = await rows(A, ownerA, { area: AREA, birthdayWithinDays: 0 });
    check("birthdays today: only today's", JSON.stringify(names(todayOnly)) === JSON.stringify([`Rina ${SFX}`]), JSON.stringify(names(todayOnly)));
    const october = await rows(A, ownerA, { area: AREA, createdFrom: "2026-10-01", createdTo: "2026-10-31" });
    check("added in October: two, not September's or August's", october[0].total === 2 && !names(october).includes(`Owen ${SFX}`) && !names(october).includes(`Fiona ${SFX}`), JSON.stringify(names(october)));
    const vip = await rows(A, ownerA, { area: AREA, tag: `VIP ${SFX}` });
    check("by tag", JSON.stringify(names(vip)) === JSON.stringify([`Rina ${SFX}`]));
    const noDeal = await rows(A, ownerA, { area: AREA, openDeal: false });
    check("no open deal: the three without one", noDeal[0].total === 3 && !names(noDeal).includes(`Rina ${SFX}`), JSON.stringify(names(noDeal)));
    const onFleet = await rows(A, ownerA, { fleet: `Pearl Valley ${SFX}`, limit: 60 });
    check("by fleet, named on the row", onFleet[0].total === 2 && onFleet.slice(1).every((r) => r.fleet === `Pearl Valley ${SFX}`), JSON.stringify(onFleet));
    const fleetKind = await rows(A, ownerA, { area: AREA, kind: "fleet" });
    check("kind fleet, with fleet access", fleetKind[0].total === 2, JSON.stringify(names(fleetKind)));

    console.log("\nFleet membership without fleet access");
    const repFleet = await rows(A, rep, { fleet: `Pearl Valley ${SFX}` });
    check("a rep without fleet access can't list by fleet", /don't have access to fleets/.test(repFleet[0].note ?? ""), JSON.stringify(repFleet));
    const repFleetKind = await rows(A, rep, { area: AREA, kind: "fleet" });
    check("…nor by kind fleet", /don't have access to fleets/.test(repFleetKind[0].note ?? ""), JSON.stringify(repFleetKind));
    const repRows = (await run(A, rep, { area: AREA, limit: 60 })).data as (Row & { kind?: string })[];
    const fiona = repRows.find((r) => r.customer === `Fiona ${SFX}`);
    check("their own fleet member is shown as a business, with no fleet named", fiona?.kind === "business" && !("fleet" in (fiona ?? {})), JSON.stringify(fiona));
    check("…and no row says fleet anywhere", !/fleet|Pearl Valley/i.test(JSON.stringify(repRows)), JSON.stringify(repRows));
    const repBusiness = await rows(A, rep, { area: AREA, kind: "business" });
    check("kind business includes their fleet member (leaving it out would give it away)", names(repBusiness).includes(`Fiona ${SFX}`), JSON.stringify(names(repBusiness)));

    console.log("\nBirthdays ranked across every match");
    const ranked = await rows(A, ownerA, { area: BULK, birthdayWithinDays: 7, limit: 5 });
    check("506 match, and the OLDEST-created customer, whose birthday is today, leads", ranked[0].total === 506 && names(ranked)[0] === `Oldest ${SFX}` && names(ranked).length === 5, JSON.stringify({ total: ranked[0].total, first: names(ranked).slice(0, 2) }));
    check("nothing sensitive in a row", !/vatNumber|research|notes/.test(JSON.stringify(all)));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { tenantId: { in: [A, B] }, lastName: SFX } }).catch(() => 0);
    await basePrisma.tag.deleteMany({ where: { id: tag.id } }).catch(() => 0);
    await basePrisma.fleet.deleteMany({ where: { id: fleet.id } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${OWN}, ${NONE})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${noCustomers.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${noCustomers.id})`.catch(() => 0);
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
