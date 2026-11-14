/**
 * REAL-DATABASE proof of DAX's `targets` and `competitors` lookups (assistantTargetsLookup.ts — Sean, 2026-11-14:
 * "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-targets     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - targets: the owner gets the month's targets against the Targets page's own counts (lib/targetProgress) — sales
 *    value in the base currency only, the gap and the percentage; someone with a reports permission gets the same;
 *    someone without one is refused; another workspace gets none of A's targets or counts;
 *  - competitors: the owner gets A's competitors, the changes to review, and with a name its changes and brief;
 *    someone without competitors.view is refused; another workspace never sees A's competitor.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { competitorsLookup, targetsLookup } from "../src/lib/assistantTargetsLookup";
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

// A past month of its own (Target is unique on metric + period across the database): nothing else counts there.
const YEAR = 2010 + crypto.randomInt(9);
const MONTH = 1 + crypto.randomInt(12);
const PERIOD = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
const inMonth = (dayOfMonth: number) => new Date(YEAR, MONTH - 1, dayOfMonth, 12);

type Goal = { goal: string; target: number | string; actual: number; stillNeeded?: number; percent?: number; achieved?: boolean };
type TargetsData = { note?: string; period?: string; goals?: Goal[] };
type CompetitorsData = { note?: string; competitors?: { competitor: string; changesToReview: number }[]; recentChanges?: { summary: string }[]; latestBrief?: { headline: string } | null };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`tgt${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const reportsOnly = user("Reports Only");
  const nothing = user("No Reports");
  const ROLE_REPORTS = crypto.randomUUID();
  const ROLE_NONE = crypto.randomUUID();
  for (const u of [reportsOnly, nothing]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holder] of [
    [ROLE_REPORTS, ["reports.view", "leads.view_owned"], reportsOnly],
    [ROLE_NONE, ["leads.view_owned"], nothing],
  ] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Targets ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
  }

  // A's month: targets of 3 new leads and R1 000 sales; 2 leads made then; won R600 in rands and $500 (not counted).
  await basePrisma.target.createMany({ data: [
    { tenantId: A, metric: "leads", period: PERIOD, value: 3 },
    { tenantId: A, metric: "sales_value", period: PERIOD, value: 100_000 },
  ] });
  const lead = async (name: string, status: string, valueCents: number, currency: string | null) => {
    const row = await basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, status, name: `${name} ${SFX}`, title: "Rover XL", valueCents, currency, createdById: a.ownerUserId, createdAt: inMonth(5) }, select: { id: true } });
    // @updatedAt is set by Prisma on every write; the won rule reads it, so it is put in the month directly.
    await basePrisma.$executeRaw`UPDATE "Lead" SET "updatedAt" = ${inMonth(20)} WHERE "id" = ${row.id}`;
  };
  await lead("Won rand", "won", 60_000, null);
  await lead("Won dollar", "won", 50_000, "USD");

  const comp = await basePrisma.competitor.create({ data: { tenantId: A, name: `Rival Carts ${SFX}`, tier: 1, notes: "Cheaper Rover copy" }, select: { id: true } });
  const source = await basePrisma.competitorSource.create({ data: { tenantId: A, competitorId: comp.id, label: "Pricing page", url: "https://rival.example.invalid/pricing" }, select: { id: true } });
  const snap = await basePrisma.competitorSnapshot.create({ data: { tenantId: A, competitorId: comp.id, sourceId: source.id, contentHash: SFX, cleanText: "x" }, select: { id: true } });
  await basePrisma.competitorChange.create({ data: { tenantId: A, competitorId: comp.id, sourceId: source.id, snapshotId: snap.id, materiality: "important", category: "pricing", summary: `Dropped the XL price ${SFX}` } });
  await basePrisma.competitorBrief.create({ data: { tenantId: A, competitorId: comp.id, headline: `Rival brief ${SFX}`, body: "They are discounting." } });

  const targets = async (tenantId: string, u: PermissionUser) =>
    (await runInTenantScope({ tenantId, system: false }, () => targetsLookup(u, { period: PERIOD }))).data[0] as TargetsData;
  const competitors = async (tenantId: string, u: PermissionUser, name?: string) =>
    (await runInTenantScope({ tenantId, system: false }, () => competitorsLookup(u, name ? { name } : {}))).data[0] as CompetitorsData;
  const goal = (d: TargetsData, label: string) => d.goals?.find((g) => g.goal === label);

  try {
    __setTenantEnforcingForTests(true);

    console.log("\ntargets — the owner");
    const own = await targets(A, ownerA);
    const sales = goal(own, "Sales value");
    check("sales value counts the rand deal only: R600 of R1 000, R400 still needed, 60%", sales?.actual === 600 && sales.target === 1000 && sales.stillNeeded === 400 && sales.percent === 60 && sales.achieved === false, JSON.stringify(sales));
    const leads = goal(own, "New leads");
    check("new leads: 2 of 3 (67%)", leads?.actual === 2 && leads.target === 3 && leads.percent === 67, JSON.stringify(leads));
    check("a goal with no target says not set", goal(own, "Deliveries")?.target === "not set");

    console.log("\ntargets — who may see them");
    const rep = await targets(A, reportsOnly);
    check("someone with a reports permission sees the same business targets", goal(rep, "Sales value")?.actual === 600, JSON.stringify(rep).slice(0, 200));
    check("someone without one is refused", /can't open Targets/.test((await targets(A, nothing)).note ?? ""));
    const other = await targets(b.tenantId, memberB);
    check("another workspace: none of A's targets or counts", goal(other, "Sales value")?.target === "not set" && goal(other, "New leads")?.actual === 0 && !JSON.stringify(other).includes(SFX), JSON.stringify(other).slice(0, 300));

    console.log("\ncompetitors");
    const list = await competitors(A, ownerA);
    const mine = list.competitors?.find((c) => c.competitor === `Rival Carts ${SFX}`);
    check("the owner sees A's competitor with 1 change to review", mine?.changesToReview === 1, JSON.stringify(list).slice(0, 300));
    const one = await competitors(A, ownerA, `Rival Carts ${SFX}`);
    check("by name: its recent change and latest brief", one.recentChanges?.[0]?.summary === `Dropped the XL price ${SFX}` && one.latestBrief?.headline === `Rival brief ${SFX}`, JSON.stringify(one).slice(0, 400));
    check("someone without competitors.view is refused", /can't open competitor intelligence/.test((await competitors(A, reportsOnly)).note ?? ""));
    const fromB = await competitors(b.tenantId, memberB, `Rival Carts ${SFX}`);
    check("another workspace never sees A's competitor", !JSON.stringify(fromB).includes(SFX), JSON.stringify(fromB).slice(0, 200));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.competitor.deleteMany({ where: { tenantId: A, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.target.deleteMany({ where: { tenantId: A, period: PERIOD } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${ROLE_REPORTS}, ${ROLE_NONE})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${reportsOnly.id}, ${nothing.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${reportsOnly.id}, ${nothing.id})`.catch(() => 0);
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
