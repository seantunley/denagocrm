/**
 * REAL-DATABASE proof of DAX's `parts` and `fleets` lookups (assistantPartsFleetsLookup.ts) — Sean, 2026-11-14: "DAX
 * must have knowledge of those things, permission based".
 *
 *   npm run test:assistant-parts-fleets   (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - parts: a parts viewer sees stock, the low flag and the sell price, NEVER the cost; a parts manager sees the cost;
 *    "low stock" lists only parts at or below their reorder level; no parts access, or Automotive off → refused;
 *  - fleets: the owner sees both open deals and both open job cards (a collected one never counts); a rep with fleet
 *    access but only their OWN deals and job cards sees only theirs counted and named; no fleet access, or Automotive
 *    off → refused; never the fleet's VAT number;
 *  - the other workspace sees only its own part and fleet of the same name.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { fleetsLookup, partsLookup } from "../src/lib/assistantPartsFleetsLookup";
import { fleetsArgs, partsArgs } from "../src/lib/crmAssistantPlan";
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

type PartRow = { part?: string; inStock?: number; low?: boolean; sellPrice?: string; cost?: string; total?: number; note?: string };
type FleetRow = { fleet?: string; openDeals?: number; openJobCards?: number; customers?: number; deals?: { deal: string }[]; jobCards?: { jobCard: string }[]; total?: number; note?: string };
const jobNo = () => 700_000_000 + crypto.randomInt(200_000_000);

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`pfl${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const B = b.tenantId;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ownerB: PermissionUser = { id: b.ownerUserId, name: "Harness B owner", email: "", role: "owner" };
  const user = (n: string): PermissionUser => ({ id: crypto.randomUUID(), name: `${n} ${SFX}`, email: `${n.toLowerCase()}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Rep");
  const manager = user("PartsManager");
  const none = user("NoAccess");
  const roles = { rep: crypto.randomUUID(), manager: crypto.randomUUID(), none: crypto.randomUUID() };
  for (const u of [rep, manager, none]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  for (const [role, keys, holder] of [
    [roles.rep, ["fleets.view", "leads.view_owned", "contacts.view_owned", "jobcards.view_owned", "parts.view"], rep],
    [roles.manager, ["parts.manage"], manager],
    [roles.none, ["leads.view_owned"], none],
  ] as const) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Parts fleets ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
  }
  // Automotive on for both (the harness workspaces are removed afterwards).
  await basePrisma.tenant.updateMany({ where: { id: { in: [A, B] } }, data: { modules: "automation,automotive" } });

  // PARTS: a low one and a healthy one in A; the same name in B, at another price.
  await basePrisma.part.createMany({
    data: [
      { tenantId: A, name: `Brake pads Rover XL ${SFX}`, sku: `BP-${SFX}`, priceCents: 45_000, costCents: 30_000, stockQty: 2, reorderAt: 5, notes: "supplier: secret" },
      { tenantId: A, name: `Seat cover ${SFX}`, priceCents: 120_000, costCents: 80_000, stockQty: 10, reorderAt: 2 },
      { tenantId: B, name: `Brake pads Rover XL ${SFX}`, priceCents: 99_900, costCents: 50_000, stockQty: 7, reorderAt: 1 },
    ],
  });

  // FLEETS: Pearl Valley in A with two members — the rep's and the owner's — each with an open deal and a job card,
  // plus a collected job card that must never count; a fleet of the same name in B.
  const fleet = await basePrisma.fleet.create({ data: { tenantId: A, name: `Pearl Valley ${SFX}`, vatNumber: `VAT${SFX}` }, select: { id: true } });
  await basePrisma.fleet.create({ data: { tenantId: B, name: `Pearl Valley ${SFX}` } });
  const member = (first: string, ownerId: string) =>
    basePrisma.contact.create({ data: { tenantId: A, firstName: first, lastName: SFX, isCompany: true, fleetId: fleet.id, ownerId, createdById: ownerId }, select: { id: true } });
  const repMember = await member("Rina", rep.id);
  const ownerMember = await member("Owen", a.ownerUserId);
  for (const [contactId, by, title] of [[repMember.id, rep.id, "Rep deal"], [ownerMember.id, a.ownerUserId, "Owner deal"]] as const) {
    await basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, status: "open", name: `${title} ${SFX}`, title, contactId, createdById: by, assignedToId: by } });
  }
  await basePrisma.jobCard.createMany({
    data: [
      { tenantId: A, number: jobNo(), status: "repair", description: `Rep job ${SFX}`, contactId: repMember.id },
      { tenantId: A, number: jobNo(), status: "booking", description: `Owner job ${SFX}`, contactId: ownerMember.id },
      { tenantId: A, number: jobNo(), status: "collected", description: `Done job ${SFX}`, contactId: repMember.id },
    ],
  });

  const parts = (tenantId: string, u: PermissionUser, args: Record<string, unknown>) =>
    runInTenantScope({ tenantId, system: false }, () => partsLookup(u, partsArgs.parse(args))).then((o) => o.data as PartRow[]);
  const fleets = (tenantId: string, u: PermissionUser, args: Record<string, unknown>) =>
    runInTenantScope({ tenantId, system: false }, () => fleetsLookup(u, fleetsArgs.parse(args))).then((o) => o.data as FleetRow[]);

  try {
    __setTenantEnforcingForTests(true);

    console.log("\nparts");
    const viewer = await parts(A, rep, { search: `brake pads XL ${SFX}` });
    check("a parts viewer finds the brake pads by every word, with stock and the low flag", viewer[0].total === 1 && viewer[1]?.inStock === 2 && viewer[1]?.low === true && !!viewer[1]?.sellPrice, JSON.stringify(viewer));
    check("…and NEVER the cost", !("cost" in (viewer[1] ?? {})));
    check("…nor the notes", !JSON.stringify(viewer).includes("secret"));
    const managed = await parts(A, manager, { search: `brake pads ${SFX}` });
    check("a parts manager sees the cost", typeof managed[1]?.cost === "string", JSON.stringify(managed[1]));
    const low = await parts(A, rep, { search: SFX, lowStock: true });
    check("low stock: only the part at or below its reorder level", low[0].total === 1 && low[1]?.part === `Brake pads Rover XL ${SFX}`, JSON.stringify(low));
    const refused = await parts(A, none, { search: SFX });
    check("no parts access: refused", /don't have access to parts/.test(refused[0].note ?? ""));
    const other = await parts(B, ownerB, { search: `brake pads ${SFX}` });
    check("the other workspace sees only its own part", other[0].total === 1 && other[1]?.inStock === 7, JSON.stringify(other));

    console.log("\nfleets");
    const all = await fleets(A, ownerA, { fleet: `Pearl Valley ${SFX}` });
    check("the owner: both open deals, both open job cards (the collected one never), both customers", all[1]?.openDeals === 2 && all[1]?.openJobCards === 2 && all[1]?.customers === 2, JSON.stringify(all[1]));
    check("…and never the fleet's VAT number", !JSON.stringify(all).includes(`VAT${SFX}`));
    const mine = await fleets(A, rep, { fleet: `Pearl Valley ${SFX}` });
    check("a rep sees the fleet, with only THEIR deal and job card counted", mine[1]?.openDeals === 1 && mine[1]?.openJobCards === 1 && mine[1]?.customers === 1, JSON.stringify(mine[1]));
    check("…and the owner's deal and job card are never named", !JSON.stringify(mine).includes("Owner deal") && JSON.stringify(mine).includes("Rep deal"));
    const noFleets = await fleets(A, none, {});
    check("no fleet access: refused", /don't have access to fleets/.test(noFleets[0].note ?? ""));
    const otherFleet = await fleets(B, ownerB, { fleet: `Pearl Valley ${SFX}` });
    check("the other workspace: its own fleet only, none of A's deals", otherFleet[0].total === 1 && otherFleet[1]?.openDeals === 0 && otherFleet[1]?.openJobCards === 0, JSON.stringify(otherFleet));

    console.log("\nAutomotive switched off");
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: "automation" } });
    const partsOff = await parts(A, ownerA, { search: SFX });
    const fleetsOff = await fleets(A, ownerA, {});
    check("parts: refused", /switched off/.test(partsOff[0].note ?? ""), JSON.stringify(partsOff));
    check("fleets: refused", /switched off/.test(fleetsOff[0].note ?? ""), JSON.stringify(fleetsOff));
  } finally {
    __setTenantEnforcingForTests(null);
    const tenants = [A, B];
    await basePrisma.jobCard.deleteMany({ where: { tenantId: A, description: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { tenantId: A, lastName: SFX } }).catch(() => 0);
    await basePrisma.part.deleteMany({ where: { tenantId: { in: tenants }, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.fleet.deleteMany({ where: { tenantId: { in: tenants }, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${roles.rep}, ${roles.manager}, ${roles.none})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${manager.id}, ${none.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${manager.id}, ${none.id})`.catch(() => 0);
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
