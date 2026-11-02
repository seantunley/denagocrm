/**
 * REAL-DATABASE proof that "the fourth one" is checked again (assistantListed.listedNow): a list DAX showed earlier
 * reaches the next question only as the person may see it NOW.
 *
 *   npm run test:assistant-listed     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 *  - a salesperson who sees only their own deals: the list shows their deal; a deal reassigned away from them since
 *    is an EMPTY place (still numbered, no name), so "the second one" is refused, not acted on or swapped;
 *  - another workspace's deal, even with its real id in the list: never;
 *  - the owner: both of A's deals, never B's.
 * Read-only. SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { listedNow } from "../src/lib/assistantListed";
import { listedBlock, listedRecords, referenceLine, resolveReference, splitListed } from "../src/lib/assistantListedRules";
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

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`lst${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Rep Own");
  const other = user("Rep Other");
  const owner: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ROLE = crypto.randomUUID();
  try {
    for (const u of [rep, other]) {
      await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
      await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
    }
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${A}, ${`Listed rep ${SFX}`}, 'test', false, now())`;
    for (const key of ["leads.view_owned", "contacts.view_owned", "quotes.view_owned"]) {
      await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${A})`;
    }
    for (const u of [rep, other]) {
      await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${ROLE}, ${A})`;
    }
    // No createdById: view_owned also covers deals a person CREATED, so a creator never loses one by reassignment.
    const lead = (name: string) =>
      basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, status: "open", valueCents: 18_000_000, name, title: "Rover XL", assignedToId: rep.id }, select: { id: true } });
    const anna = await lead(`Anna Listed${SFX}`);
    const donovan = await lead(`Donovan Listed${SFX}`);

    // The answer the rep was given, from their own lookup — then Donovan's deal goes to someone else.
    const rows = [anna, donovan].map((l, i) => ({ link: `/leads/${l.id}`, customer: [`Anna Listed${SFX}`, `Donovan Listed${SFX}`][i], lead: "Rover XL" }));
    const saved = { topic: "open deals", listed: [...listedRecords(`1. Anna Listed${SFX}\n2. Donovan Listed${SFX}`, [rows]), { kind: "lead" as const, id: b.rows.leadId, label: "B's deal" }] };
    check("the answer's list is captured in order", saved.listed.map((r) => r.id).join() === [anna.id, donovan.id, b.rows.leadId].join());
    await basePrisma.lead.update({ where: { id: donovan.id }, data: { assignedToId: other.id } });

    __setTenantEnforcingForTests(true);
    const now = (u: PermissionUser) => runInTenantScope({ tenantId: A, system: false }, () => listedNow(u, splitListed(saved).listed));

    console.log("\nthe salesperson, after the reassignment");
    const mine = await now(rep);
    check("their own deal is still #1", mine[0]?.id === anna.id);
    check("the reassigned deal is an empty #2", mine.length === 3 && mine[1] === null, JSON.stringify(mine));
    check("another workspace's deal is never there", mine[2] === null);
    const ref = resolveReference("draft a WhatsApp for the second one", mine)!;
    check("\"the second one\" is refused, not swapped for another", ref.matches.length === 1 && ref.matches[0].slot === null && /never act on it/.test(referenceLine(ref, mine.length)));
    check("the list DAX reads never names the lost deal", !listedBlock(mine, "the second one").includes(`Donovan Listed${SFX}`));

    console.log("\nthe owner");
    const all = await now(owner);
    check("sees both of A's deals", all[0]?.id === anna.id && all[1]?.id === donovan.id, JSON.stringify(all));
    check("…never B's", all[2] === null);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: `Listed${SFX}` } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE}`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${other.id})`.catch(() => 0);
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
