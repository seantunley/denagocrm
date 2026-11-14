/**
 * REAL-DATABASE proof that DAX reads CUSTOM FIELDS only as the person may see them (assistantCustomFieldsLookup.ts —
 * Sean, 2026-11-14: "DAX must have knowledge of those things, permission based").
 *
 *   npm run test:assistant-custom-fields     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - a rep sees the custom fields of THEIR lead, never a colleague's; a filter never lists a lead they can't open;
 *  - a switched-off field, and one "Show only when…" hides for that record, are not shown;
 *  - a link field names the linked customer only when the person may open that customer too;
 *  - the owner sees both leads; the OTHER workspace, with a field of the same name, sees only its own.
 *  - a lookup's rows (withCustomFields) carry them the same way.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { customFieldsFor, customFieldsLookup, withCustomFields } from "../src/lib/assistantCustomFieldsLookup";
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

type Data = Record<string, unknown> & { total?: number; note?: string; fields?: { field: string }[] };

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`cfd${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const B = b.tenantId;
  const rep: PermissionUser = { id: crypto.randomUUID(), name: "Rep Custom", email: `rep.${SFX}@harness.invalid`, role: "member" };
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const memberB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const ROLE = crypto.randomUUID();
  await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${rep.id}, ${rep.name}, ${rep.email}, 'x', 'member', 0)`;
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${rep.id})`;
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${A}, ${`Custom fields ${SFX}`}, 'test', false, now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned", "quotes.view_owned"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${A})`;
  }
  await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${rep.id}, ${ROLE}, ${A})`;
  // Review of #1105: one who may not read leads at all, and one who may but has none yet.
  const noLeads: PermissionUser = { id: crypto.randomUUID(), name: "No Leads", email: `noleads.${SFX}@harness.invalid`, role: "member" };
  const emptyRep: PermissionUser = { id: crypto.randomUUID(), name: "Empty Rep", email: `empty.${SFX}@harness.invalid`, role: "member" };
  const ROLE_NO_LEADS = crypto.randomUUID();
  const ROLE_EMPTY = crypto.randomUUID();
  for (const [u, role, keys] of [[noLeads, ROLE_NO_LEADS, ["contacts.view_owned"]], [emptyRep, ROLE_EMPTY, ["leads.view_owned"]]] as const) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${role}, ${A}, ${`Custom fields ${role.slice(0, 8)} ${SFX}`}, 'test', false, now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${role}, ${key}, ${A})`;
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${role}, ${A})`;
  }

  const lead = (tenantId: string, stageId: string, who: string, name: string) =>
    basePrisma.lead.create({ data: { tenantId, stageId, name: `${name} ${SFX}`, title: "Rover XL", assignedToId: who, createdById: who }, select: { id: true } });
  const repLead = await lead(A, a.rows.stageId, rep.id, "Rep Paarl");
  const repLead2 = await lead(A, a.rows.stageId, rep.id, "Rep Stellenbosch");
  const ownerLead = await lead(A, a.rows.stageId, a.ownerUserId, "Owner Paarl");
  const bLead = await lead(B, b.rows.stageId, b.memberUserId, "B Paarl");
  // The owner's customer: the rep may not open it.
  const ownersCustomer = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Hidden", lastName: `Referrer${SFX}`, ownerId: a.ownerUserId }, select: { id: true } });

  const def = (tenantId: string, key: string, label: string, extra: Record<string, unknown> = {}) =>
    basePrisma.customFieldDef.create({ data: { tenantId, entity: "lead", key: `${key}_${SFX}`, label: `${label} ${SFX}`, type: "text", ...extra }, select: { id: true } });
  const expo = await def(A, "expo", "Expo", { type: "select", options: ["Paarl", "Stellenbosch"] });
  const stand = await def(A, "stand", "Expo stand", { showWhen: { key: `expo_${SFX}`, op: "equals", value: "Paarl" } });
  const old = await def(A, "old", "Old field", { active: false });
  const referred = await def(A, "ref", "Referred by", { type: "link", linkTo: "contact" });
  const expoB = await def(B, "expo", "Expo", { type: "select", options: ["Paarl"] });
  const value = (tenantId: string, defId: string, recordId: string, v: string) => basePrisma.customFieldValue.create({ data: { tenantId, defId, recordId, value: v } });
  await value(A, expo.id, repLead.id, "Paarl");
  await value(A, stand.id, repLead.id, "B12");
  await value(A, old.id, repLead.id, "secret-old");
  await value(A, referred.id, repLead.id, ownersCustomer.id);
  await value(A, expo.id, repLead2.id, "Stellenbosch");
  await value(A, stand.id, repLead2.id, "Z9");
  await value(A, expo.id, ownerLead.id, "Paarl");
  await value(B, expoB.id, bLead.id, "Paarl");

  const L = (label: string) => `${label} ${SFX}`;
  const inA = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: A, system: false }, fn);
  const inB = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: B, system: false }, fn);
  const listed = (out: { data: unknown[] }) => (out.data.slice(1) as { link: string }[]).map((r) => r.link);

  try {
    __setTenantEnforcingForTests(true);

    console.log("\nA rep's own lead, and a colleague's");
    const mine = await inA(() => customFieldsFor(rep, "lead", [repLead.id, repLead2.id, ownerLead.id]));
    const r1 = mine.get(repLead.id) ?? {};
    check("their lead's fields are read", r1[L("Expo")] === "Paarl" && r1[L("Expo stand")] === "B12", JSON.stringify(r1));
    check("NEVER a colleague's lead", !mine.has(ownerLead.id));
    check("a switched-off field is not shown", !(L("Old field") in r1) && !JSON.stringify([...mine.values()]).includes("secret-old"));
    check("a field 'Show only when' hides for that record is not shown", mine.get(repLead2.id)?.[L("Expo")] === "Stellenbosch" && !(L("Expo stand") in (mine.get(repLead2.id) ?? {})), JSON.stringify(mine.get(repLead2.id)));
    check("a link to a customer they may not open: not named", r1[L("Referred by")] === "A record you can't open", r1[L("Referred by")]);
    const owner = await inA(() => customFieldsFor(ownerA, "lead", [repLead.id, ownerLead.id]));
    check("the owner sees both, and the linked customer's name", owner.has(ownerLead.id) && String(owner.get(repLead.id)?.[L("Referred by")]).includes(`Referrer${SFX}`), JSON.stringify(owner.get(repLead.id)));

    console.log("\nA lookup's rows carry them the same way");
    const rows: Record<string, unknown>[] = [{ total: 2 }, { link: `/leads/${repLead.id}` }, { link: `/leads/${ownerLead.id}` }];
    await inA(() => withCustomFields(rep, rows));
    check("the rep's row carries its fields; the colleague's none", (rows[1].customFields as Record<string, string>)?.[L("Expo")] === "Paarl" && !("customFields" in rows[2]), JSON.stringify(rows));

    console.log("\ncustom_fields — a filter never lists what they can't open");
    const byRep = await inA(() => customFieldsLookup(rep, { record: "lead", field: L("Expo"), value: "paarl" }));
    check("the rep: only their Paarl lead", JSON.stringify(listed(byRep)) === JSON.stringify([`/leads/${repLead.id}`]) && (byRep.data[0] as Data).total === 1, JSON.stringify(byRep.data));
    const byOwner = await inA(() => customFieldsLookup(ownerA, { record: "lead", field: L("Expo"), value: "Paarl" }));
    check("the owner: both Paarl leads", listed(byOwner).length === 2 && listed(byOwner).includes(`/leads/${ownerLead.id}`), JSON.stringify(byOwner.data));
    const hidden = await inA(() => customFieldsLookup(ownerA, { record: "lead", field: L("Expo stand") }));
    check("a field hidden by 'Show only when' lists only where it shows", JSON.stringify(listed(hidden)) === JSON.stringify([`/leads/${repLead.id}`]), JSON.stringify(hidden.data));
    const off = await inA(() => customFieldsLookup(ownerA, { record: "lead", field: L("Old field") }));
    check("a switched-off field can't be searched", /No custom field/.test(String((off.data[0] as Data).note)), JSON.stringify(off.data));
    const fields = await inA(() => customFieldsLookup(rep, { record: "lead" }));
    const names = ((fields.data[0] as Data).fields ?? []).map((f) => f.field);
    check("no field named: the fields there are, never a switched-off one", names.includes(L("Expo")) && !names.includes(L("Old field")), JSON.stringify(names));

    console.log("\ncustom_fields — no right to read leads: refused, and nothing about the fields");
    const leak = (out: { data: unknown[] }) => {
      const text = JSON.stringify(out);
      return text.includes(SFX) || /Paarl|Stellenbosch|"fields"|options|shownOnlyWhen/.test(text);
    };
    const schema = await inA(() => customFieldsLookup(noLeads, { record: "lead" }));
    check("the field list: refused, no labels, no options", /You don't have access to leads\./.test(String((schema.data[0] as Data).note)) && !leak(schema), JSON.stringify(schema.data));
    const unknown = await inA(() => customFieldsLookup(noLeads, { record: "lead", field: "nonexistent" }));
    check("an unknown field: refused, with no list of the fields there are", /You don't have access to leads\./.test(String((unknown.data[0] as Data).note)) && !leak(unknown), JSON.stringify(unknown.data));
    const search = await inA(() => customFieldsLookup(noLeads, { record: "lead", field: L("Expo"), value: "Paarl" }));
    check("a search: refused, nothing listed", /You don't have access to leads\./.test(String((search.data[0] as Data).note)) && !leak(search), JSON.stringify(search.data));
    console.log("\ncustom_fields — may read leads but has none yet: the fields, as the lead form shows them; no records");
    const emptySchema = await inA(() => customFieldsLookup(emptyRep, { record: "lead" }));
    check("the field list is shown", ((emptySchema.data[0] as Data).fields ?? []).some((f) => f.field === L("Expo")), JSON.stringify(emptySchema.data));
    const emptySearch = await inA(() => customFieldsLookup(emptyRep, { record: "lead", field: L("Expo"), value: "Paarl" }));
    check("…but a search lists nothing of anyone else's", !JSON.stringify(emptySearch).includes("/leads/"), JSON.stringify(emptySearch.data));

    console.log("\nThe other workspace");
    const other = await inB(() => customFieldsLookup(memberB, { record: "lead", field: L("Expo"), value: "Paarl" }));
    check("only its own lead, never A's", JSON.stringify(listed(other)) === JSON.stringify([`/leads/${bLead.id}`]), JSON.stringify(other.data));
    const otherFor = await inB(() => customFieldsFor(memberB, "lead", [repLead.id, ownerLead.id, bLead.id]));
    check("…and by A's ids, nothing of A's", !otherFor.has(repLead.id) && !otherFor.has(ownerLead.id) && otherFor.has(bLead.id));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.customFieldDef.deleteMany({ where: { key: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { name: { endsWith: SFX } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { id: ownersCustomer.id } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" IN (${ROLE}, ${ROLE_NO_LEADS}, ${ROLE_EMPTY})`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${noLeads.id}, ${emptyRep.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${rep.id}, ${noLeads.id}, ${emptyRep.id})`.catch(() => 0);
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
