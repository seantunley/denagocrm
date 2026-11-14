/**
 * REAL-DATABASE proof of DAX's deal_file and suppliers lookups (assistantDealFileLookup.ts — Sean, 2026-11-14:
 * "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-deal-file     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - the owner: the deal's checklist, what is missing, the supplier on it and its missing papers — by customer name
 *    and by Q-number; suppliers lists the supplier, its deals missing papers, and never its payment reference;
 *  - a member with deals but no quote access: refused; a salesperson with quote access but not to this deal: nothing;
 *    a non-owner asking for suppliers: refused;
 *  - the Suppliers module off: no supplier on the deal file, and suppliers says it is switched off;
 *  - the other workspace: none of A's deal, and only its own suppliers.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { dealFileLookup, suppliersLookup } from "../src/lib/assistantDealFileLookup";
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

type Data = Record<string, unknown> & { note?: string };
const first = (out: { data: unknown[] }) => out.data[0] as Data;

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`adf${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ownerB: PermissionUser = { id: b.ownerUserId, name: "Harness B owner", email: "", role: "owner" };
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const noQuotes = user("Deals No Quotes");
  const otherRep = user("Other Rep");
  const NO_QUOTES = crypto.randomUUID();
  const QUOTES_OWNED = crypto.randomUUID();
  const number = 900_000_000 + crypto.randomInt(90_000_000);
  const savedModules = (await basePrisma.tenant.findUnique({ where: { id: A }, select: { modules: true } }))?.modules ?? "";

  try {
    for (const u of [noQuotes, otherRep]) {
      await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
      await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
    }
    for (const [role, keys, holder] of [
      [NO_QUOTES, ["leads.view_all", "contacts.view_all"], noQuotes],
      [QUOTES_OWNED, ["leads.view_owned", "contacts.view_owned", "quotes.view_owned"], otherRep],
    ] as const) {
      await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Deal file ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
      for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
      await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${holder.id}, ${role}, ${A})`;
    }
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: [...new Set([...savedModules.split(","), "suppliers"])].filter(Boolean).join(",") } });

    // A's deal: Oak Consult's lead, an accepted quote, and a supplier on the deal with none of its papers in yet.
    const contact = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Olive", lastName: `Oak${SFX}`, company: `Oak Consult ${SFX}`, ownerId: a.ownerUserId }, select: { id: true } });
    const lead = await basePrisma.lead.create({ data: { tenantId: A, stageId: a.rows.stageId, name: `Oak Consult ${SFX}`, title: "Rover XL", contactId: contact.id, createdById: a.ownerUserId, assignedToId: a.ownerUserId }, select: { id: true } });
    const quote = await basePrisma.quote.create({ data: { tenantId: A, number, status: "accepted", leadId: lead.id, contactId: contact.id, createdById: a.ownerUserId }, select: { id: true } });
    const vendor = await basePrisma.vendor.create({ data: { tenantId: A, name: `Denago OEM ${SFX}`, kind: "oem", paymentReference: `SECRETREF${SFX}`, email: `oem.${SFX}@supplier.invalid` }, select: { id: true } });
    await basePrisma.dealVendor.create({ data: { tenantId: A, leadId: lead.id, vendorId: vendor.id } });
    await basePrisma.vendor.create({ data: { tenantId: b.tenantId, name: `Bravo OEM ${SFX}`, kind: "oem" } });
    // The other salesperson's OWN deal: their access list is not empty, so asking for Oak's deal really runs the
    // filtered query (an empty list returns before it — and would prove nothing).
    await basePrisma.quote.create({ data: { tenantId: A, number: number + 1, status: "sent", createdById: otherRep.id } });

    const inA = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: A, system: false }, fn);
    const inB = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: b.tenantId, system: false }, fn);
    __setTenantEnforcingForTests(true);

    console.log("\ndeal_file — the owner");
    const byName = first(await inA(() => dealFileLookup(ownerA, { deal: `Oak Consult ${SFX}` })));
    const missing = (byName.missing as string[]) ?? [];
    check("the deal's checklist comes back, with what is missing", Array.isArray(byName.checklist) && missing.length > 0 && byName.link === `/deals/${quote.id}`, JSON.stringify(byName).slice(0, 300));
    check("…the supplier on the deal", JSON.stringify(byName.suppliers).includes(`Denago OEM ${SFX}`), JSON.stringify(byName.suppliers));
    check("…and which of its papers are missing", ((byName.missingFromSuppliers as string[]) ?? []).length > 0, JSON.stringify(byName.missingFromSuppliers));
    const byNumber = first(await inA(() => dealFileLookup(ownerA, { deal: `Q-${number}` })));
    check("by its Q-number, the same deal", byNumber.link === `/deals/${quote.id}`, JSON.stringify(byNumber).slice(0, 200));

    console.log("\ndeal_file — who may not");
    const refused = first(await inA(() => dealFileLookup(noQuotes, { deal: `Q-${number}` })));
    check("deals but no quote access: refused", /can't open deals/.test(refused.note ?? ""), refused.note);
    const notTheirs = first(await inA(() => dealFileLookup(otherRep, { deal: `Q-${number}` })));
    check("quote access, but not to this deal: nothing", /No deal this person may open/.test(notTheirs.note ?? ""), notTheirs.note);
    const theirOwn = first(await inA(() => dealFileLookup(otherRep, { deal: `Q-${number + 1}` })));
    check("…while their own deal opens", theirOwn.link !== undefined && !JSON.stringify(theirOwn).includes(`Oak Consult ${SFX}`), JSON.stringify(theirOwn).slice(0, 200));
    const otherWs = first(await inB(() => dealFileLookup(ownerB, { deal: `Q-${number}` })));
    check("the other workspace's owner, by Q-number: nothing", /No deal/.test(otherWs.note ?? "") && !JSON.stringify(otherWs).includes(`Oak Consult ${SFX}`), otherWs.note);

    console.log("\nsuppliers");
    const all = first(await inA(() => suppliersLookup(ownerA, { supplier: `Denago OEM ${SFX}` })));
    check("the owner sees the supplier", JSON.stringify(all.suppliers).includes(`Denago OEM ${SFX}`), JSON.stringify(all).slice(0, 300));
    check("…and the deal still missing its papers (the digest's rule)", JSON.stringify(all.dealsMissingSupplierPapers).includes(`Q-${number}`), JSON.stringify(all.dealsMissingSupplierPapers));
    check("…never its payment reference", !JSON.stringify(all).includes("SECRETREF"));
    const rep = first(await inA(() => suppliersLookup(otherRep, {})));
    check("not the owner: refused", /Only the workspace owner/.test(rep.note ?? ""), rep.note);
    const b2 = first(await inB(() => suppliersLookup(ownerB, {})));
    check("the other workspace's owner: only its own supplier", JSON.stringify(b2.suppliers).includes(`Bravo OEM ${SFX}`) && !JSON.stringify(b2).includes(`Denago OEM ${SFX}`), JSON.stringify(b2).slice(0, 200));

    console.log("\nSuppliers module off");
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules.split(",").filter((m) => m && m !== "suppliers").join(",") } });
    const off = first(await inA(() => dealFileLookup(ownerA, { deal: `Q-${number}` })));
    check("the deal file names no supplier", !("suppliers" in off) && !("missingFromSuppliers" in off) && !JSON.stringify(off).includes(`Denago OEM ${SFX}`), JSON.stringify(off).slice(0, 300));
    const offSuppliers = first(await inA(() => suppliersLookup(ownerA, {})));
    check("suppliers says it is switched off", /switched off/.test(offSuppliers.note ?? ""), offSuppliers.note);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.tenant.update({ where: { id: A }, data: { modules: savedModules } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${NO_QUOTES}, ${QUOTES_OWNED})`.catch(() => 0);
    const tenants = [A, b.tenantId];
    await basePrisma.dealVendor.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.vendor.deleteMany({ where: { tenantId: { in: tenants }, name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.quote.deleteMany({ where: { tenantId: A, number: { in: [number, number + 1] } } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: `Oak Consult ${SFX}` } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { tenantId: A, lastName: `Oak${SFX}` } }).catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${noQuotes.id}, ${otherRep.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${noQuotes.id}, ${otherRep.id})`.catch(() => 0);
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
