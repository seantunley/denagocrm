/**
 * REAL-DATABASE proof of DAX SPEAKING FIRST (lib/daxBrief openingLineFor, Sean 2026-11-14) — the line a new
 * conversation opens with, from the person's own daily brief.
 *
 *   npm run test:assistant-opening-line     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on, as two sales reps who may open only their own deals:
 *  - a rep's line names their own deal (a Nurture review due today), linked — never the other rep's, never the
 *    other workspace's;
 *  - someone with nothing to say gets no line at all (no "nothing new" filler);
 *  - switched off (their own setting, in this workspace), no line; and the line uses no AI and writes nothing.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { openingLineFor } from "../src/lib/daxBrief";
import { openingLineKey } from "../src/lib/proactiveRules";
import { putWorkspaceSetting } from "../src/lib/settings";
import { johannesburgDateKey } from "../src/lib/activityDay";
import { signFreshSession } from "../src/lib/session";
import type { PermissionUser } from "../src/lib/permissions";
import { runAsSession, type ActingSession } from "./harness/actingSession";
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

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`open${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Open Rep");
  const other = user("Open Other");
  const quiet = user("Open Quiet");
  const people = [rep, other, quiet];
  const ROLE = crypto.randomUUID();
  const today = johannesburgDateKey(new Date());
  const dueToday = new Date(`${today}T09:00:00+02:00`);
  const name = { rep: `Anna Mine${SFX}`, other: `Cara Theirs${SFX}`, b: `Bea Elsewhere${SFX}` };

  try {
    for (const u of people) {
      await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
      await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
    }
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${A}, ${`Opening ${SFX}`}, 'test', false, now())`;
    for (const key of ["leads.view_owned", "quotes.view_owned", "contacts.view_owned", "activities.view"]) {
      await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${A})`;
    }
    for (const u of people) await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${ROLE}, ${A})`;
    // A parked deal whose review day is today, for each rep — and one in the other workspace.
    const parked = (tenantId: string, stageId: string, leadName: string, owner: string) =>
      basePrisma.lead.create({
        data: {
          tenantId, title: "Rover XL", name: leadName, stageId, assignedToId: owner, createdById: owner,
          status: "nurture", nurtureSince: new Date(Date.now() - 60 * 86_400_000), nurtureReason: "timing", nurtureInterest: "Rover XL", nurtureReviewAt: dueToday,
        },
        select: { id: true },
      });
    const mine = await parked(A, a.rows.stageId, name.rep, rep.id);
    await parked(A, a.rows.stageId, name.other, other.id);
    await parked(b.tenantId, b.rows.stageId, name.b, b.memberUserId);

    const session = async (u: PermissionUser): Promise<ActingSession> =>
      ({ cookieValue: await signFreshSession({ id: u.id, name: u.name ?? "", email: u.email ?? "", role: u.role, grants: "", sessionVersion: 0 }, 60, { tid: A }), label: u.name ?? u.id });
    const lineFor = async (u: PermissionUser) => runAsSession(await session(u), () => runInTenantScope({ tenantId: A, system: false }, () => openingLineFor(u)));
    const counts = async () => (await basePrisma.$queryRaw<{ n: number }[]>`SELECT ((SELECT count(*) FROM "AssistantTurn") + (SELECT count(*) FROM "Lead") + (SELECT count(*) FROM "AppSetting"))::int AS n`)[0].n;

    __setTenantEnforcingForTests(true);
    const before = await counts();

    console.log("\nopening line — a rep sees only their own");
    const repLine = await lineFor(rep);
    const said = JSON.stringify(repLine);
    check("the rep's line names their own deal due today", said.includes(name.rep), said);
    check("…linked to it", repLine?.facts.some((f) => f.href === `/leads/${mine.id}` || f.href.startsWith("/leads/nurture")) === true, said);
    check("…never the other rep's", !said.includes(name.other), said);
    check("…never the other workspace's", !said.includes(name.b), said);
    check("at most two facts", (repLine?.facts.length ?? 0) <= 2, said);

    console.log("\nopening line — nothing to say, nothing said");
    check("a rep with nothing due gets no line at all", (await lineFor(quiet)) === null);

    check("READ-ONLY: nothing written, no AI turn", (await counts()) === before);

    console.log("\nopening line — their own switch, in this workspace");
    await putWorkspaceSetting(A, openingLineKey(rep.id), "off");
    check("switched off: no line", (await lineFor(rep)) === null);
    check("…the other rep's line is untouched", JSON.stringify(await lineFor(other)).includes(name.other));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.appSetting.deleteMany({ where: { tenantId: A, key: { in: people.map((u) => openingLineKey(u.id)) } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE}`.catch(() => 0);
    for (const u of people) {
      await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" = ${u.id}`.catch(() => 0);
      await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${u.id}`.catch(() => 0);
    }
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
