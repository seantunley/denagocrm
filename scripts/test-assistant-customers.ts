/**
 * REAL-DATABASE proof of how the assistant finds a CUSTOMER to put a note on.
 *
 * A source test can show the query is written a certain way. Only a database
 * with real permission rows can show who it finds for whom:
 *  - a customer with no lead at all;
 *  - a customer who also has a lead (the customer must still be reachable);
 *  - several customers sharing a name;
 *  - somebody else's customer of the same name (never shown);
 *  - a deleted customer (never shown);
 *  - a person who may open customers but NOT leads (not refused).
 * And that nothing identifying beyond a name leaves the database.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates. The assistant's model is never called.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { customersNamed, leadBrief } from "../src/lib/crmAssistant";
import type { PermissionUser } from "../src/lib/permissions";
import { resolveTenantActor } from "../src/lib/tenantActor";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const id = (what: string) => `asst-cust-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const outsider: PermissionUser = { id: id("out"), name: "Outsider", email: `${id("out")}@example.invalid`, role: "member" };
const customersOnly: PermissionUser = { id: id("conly"), name: "Customers Only", email: `${id("conly")}@example.invalid`, role: "member" };
const ROLE = id("role");
const STAND_IN = id("standin");
const STAGE = id("stage");
const C = { noLead: id("c-nolead"), othersSameName: id("c-other"), withLead: id("c-withlead"), twinA: id("c-twin-a"), twinB: id("c-twin-b"), deleted: id("c-deleted"), conly: id("c-conly"), leadNamedDifferently: id("c-diffname") };
const L = { withLead: id("l-withlead"), diffName: id("l-diffname") };
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
type Found = Awaited<ReturnType<typeof customersNamed>>;
const idsOf = (found: Found) => found.map((c) => c.contactId).sort();
type Brief = { note?: string; customers?: Found; customerRecords?: Found; id?: string };
const brief = async (user: PermissionUser, lead: string) => (await scoped(() => leadBrief(user, { lead }))).data[0] as Brief;

async function seed() {
  await basePrisma.user.createMany({
    data: [rep, outsider, customersOnly].map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  // The workspace's STAND-IN account is its oldest active member — the one automated entries are
  // filed under. Created long ago, so it is the oldest whatever else this database holds.
  await basePrisma.user.create({ data: { id: STAND_IN, name: "Oldest Member", email: `${STAND_IN}@example.invalid`, passwordHash: "test", role: "member", modules: "crm", createdAt: new Date("1990-01-01T00:00:00Z") } });
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${`tm-${STAND_IN}`}, ${T}, ${STAND_IN})`;
  // A role with customers but NOT leads: the combination no seeded role has.
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "tenantId", "name", "description", "system", "createdAt", "updatedAt") VALUES (${ROLE}, ${T}, ${`Customers only ${SFX}`}, 'test', false, now(), now())`;
  await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${ROLE}, 'contacts.view_owned', ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${outsider.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${customersOnly.id}, ${ROLE}, ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Assistant customers ${SFX}`}, 900002, '#64748b', 'pipeline_default_retail', 10, false)`;
  const contact = (cid: string, firstName: string, lastName: string, ownerId: string, extra: Record<string, unknown> = {}) =>
    ({ id: cid, tenantId: T, firstName, lastName, ownerId, createdById: ownerId, phone: "082 555 0199", email: `${cid}@example.invalid`, city: "Cape Town", ...extra });
  await basePrisma.contact.createMany({
    data: [
      contact(C.noLead, "Zed", `Uniq${SFX}`, rep.id),
      contact(C.othersSameName, "Zed", `Uniq${SFX}`, outsider.id),
      contact(C.deleted, "Zed", `Uniq${SFX}`, rep.id, { deletedAt: new Date() }),
      contact(C.withLead, "Yan", `Deal${SFX}`, rep.id),
      contact(C.twinA, "Twin", `Same${SFX}`, rep.id, { city: "Paarl" }),
      contact(C.twinB, "Twin", `Same${SFX}`, rep.id, { city: "Worcester" }),
      contact(C.conly, "Solo", `Cust${SFX}`, customersOnly.id),
      contact(C.leadNamedDifferently, "Maria", `Other${SFX}`, rep.id),
    ],
  });
  await basePrisma.lead.createMany({
    data: [
      { id: L.withLead, tenantId: T, title: "Rover XL", name: `Yan Deal${SFX}`, stageId: STAGE, contactId: C.withLead, assignedToId: rep.id, createdById: rep.id },
      // The lead carries a company's name; its customer is a person with another one.
      { id: L.diffName, tenantId: T, title: "Fleet order", name: `Fleetco${SFX}`, stageId: STAGE, contactId: C.leadNamedDifferently, assignedToId: rep.id, createdById: rep.id },
    ],
  });
}

async function cleanup() {
  // Before the users: a message cannot outlive the account it is filed under.
  await basePrisma.communication.deleteMany({ where: { OR: [{ leadId: { in: Object.values(L) } }, { contactId: { in: Object.values(C) } }] } });
  await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(L) } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: Object.values(C) } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${outsider.id}, ${customersOnly.id})`;
  await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE}`;
  await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE}`;
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" = ${STAND_IN}`;
  await basePrisma.user.deleteMany({ where: { id: { in: [rep.id, outsider.id, customersOnly.id, STAND_IN] } } });
}

async function main() {
  guardEnvironment();
  await seed();
  __setTenantEnforcingForTests(true);

  console.log("\nA customer with no lead");
  {
    const found = await scoped(() => customersNamed(rep, `Zed Uniq${SFX}`));
    check("found by full name, across the first-name and last-name columns", idsOf(found).includes(C.noLead), JSON.stringify(idsOf(found)));
    check("somebody else's customer of the same name is not shown", !idsOf(found).includes(C.othersSameName));
    check("a deleted customer of the same name is not shown", !idsOf(found).includes(C.deleted));
    check("exactly the one she can open", found.length === 1, `${found.length}`);
    const b = await brief(rep, `Zed Uniq${SFX}`);
    check("the lookup reports the customer instead of 'nobody matches'", b.customers?.length === 1 && b.customers[0].contactId === C.noLead, b.note);
    check("…and says a note can go on the customer", /customer_note with the contactId/.test(b.note ?? ""));
    check("the other person sees THEIR customer of that name, not hers", idsOf(await scoped(() => customersNamed(outsider, `Zed Uniq${SFX}`))).join() === C.othersSameName);
  }

  console.log("\nA customer who also has a lead");
  {
    const b = await brief(rep, `Yan Deal${SFX}`);
    check("the lead is still what is read in full", b.id === L.withLead, String(b.id));
    check("…and the customer record comes with it, addressable for a customer note", b.customerRecords?.some((c) => c.contactId === C.withLead) === true, JSON.stringify(b.customerRecords));
    const company = await brief(rep, `Fleetco${SFX}`);
    check("a lead found by a company name still yields its customer, whose own name differs", company.customerRecords?.[0]?.contactId === C.leadNamedDifferently, JSON.stringify(company.customerRecords));
  }

  console.log("\nSeveral customers sharing a name");
  {
    const b = await brief(rep, `Twin Same${SFX}`);
    check("both are listed", idsOf(b.customers ?? []).join() === [C.twinA, C.twinB].sort().join(), JSON.stringify(b.customers));
    check("…with something to tell them apart", new Set((b.customers ?? []).map((c) => c.city)).size === 2);
    check("…and the assistant is told to ask which one", /ask which one first/.test(b.note ?? ""));
  }

  console.log("\nA person who may open customers but not leads");
  {
    const b = await brief(customersOnly, `Solo Cust${SFX}`);
    check("is not refused: their customer is found", b.customers?.[0]?.contactId === C.conly, b.note);
    const none = await brief(customersOnly, `Yan Deal${SFX}`);
    check("still sees no lead, and no customer that is not theirs", !none.id && !none.customers?.length && /don't have access to leads/.test(none.note ?? ""), JSON.stringify(none));
  }

  console.log("\nWho did it: the author of each entry on a lead");
  {
    // The account automated entries are filed under, as the application resolves it — whoever that is here.
    const standIn = await scoped(() => resolveTenantActor());
    const when = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const say = (userId: string, body: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
      ({ tenantId: T, leadId: L.withLead, contactId: C.withLead, type: "note", body, userId, occurredAt: when(minutesAgo), ...extra });
    await basePrisma.communication.createMany({
      data: [
        say(outsider.id, `Called her ${SFX}`, 30),
        say(rep.id, `Sent the spec sheet ${SFX}`, 20, { type: "email", direction: "outbound" }),
        // A customer's own WhatsApp: it arrives by itself and is filed under the stand-in account. Nobody on staff wrote it.
        say(STAND_IN, `Is the white one in stock ${SFX}`, 10, { type: "whatsapp", direction: "inbound" }),
        // An INCOMING CALL a colleague logged by hand (Log a call / email / note): the customer rang, the colleague recorded it.
        say(outsider.id, `She rang about colours ${SFX}`, 8, { type: "call", direction: "inbound" }),
        // An incoming email a colleague typed in by hand: under their account, not the stand-in.
        say(outsider.id, `Forwarded her email ${SFX}`, 7, { type: "email", direction: "inbound" }),
        say(STAND_IN, `Thanks for your enquiry ${SFX}`, 5, { type: "whatsapp", direction: "outbound" }),
      ],
    });
    const data = (await scoped(() => leadBrief(rep, { lead: `Yan Deal${SFX}` }))).data[0] as {
      who?: string; createdBy?: string;
      messages: { text: string; from: string; loggedBy?: string }[];
    };
    const message = (needle: string) => data.messages.find((m) => m.text.includes(needle));
    check("the note a colleague logged names that colleague — not the person asking", message("Called her")?.loggedBy === "Outsider", JSON.stringify(message("Called her")));
    check("the asker's own entry names them", message("Sent the spec sheet")?.loggedBy === "Rep", JSON.stringify(message("Sent the spec sheet")));
    const fromCustomer = message("Is the white one in stock");
    check("a customer's own WhatsApp is from the customer, with NO staff author", fromCustomer?.from === "customer" && fromCustomer.loggedBy === undefined, JSON.stringify(fromCustomer));
    const call = message("She rang about colours");
    check("an incoming call a colleague logged is FROM the customer and LOGGED BY that colleague", call?.from === "customer" && call.loggedBy === "Outsider", JSON.stringify(call));
    const typedIn = message("Forwarded her email");
    check("an incoming email a colleague typed in by hand names them too", typedIn?.from === "customer" && typedIn.loggedBy === "Outsider", JSON.stringify(typedIn));
    check("the stand-in account resolves to the workspace's oldest member", standIn?.id === STAND_IN, JSON.stringify(standIn));
    const automatic = message("Thanks for your enquiry");
    check("an entry under the stand-in account is NOT credited to that person as a fact", automatic?.loggedBy === "Oldest Member or an automatic entry", JSON.stringify(automatic));
    check("the rule for reading these fields is sent with the data", /never guess a person from the wording of a note/.test(data.who ?? ""));
    check("the lead's creator is given", typeof data.createdBy === "string" && data.createdBy.startsWith("Rep"), String(data.createdBy));
    check("only names: no staff id or email in what is handed over", !JSON.stringify(data).includes(outsider.id) && !JSON.stringify(data).includes("@example.invalid"));
  }

  console.log("\nWhat leaves the database");
  {
    const found = await scoped(() => customersNamed(rep, `Twin Same${SFX}`));
    const text = JSON.stringify(found);
    check("no phone number and no email address", !text.includes("082 555 0199") && !text.includes("@example.invalid"), text.slice(0, 200));
    check("only the fields needed to tell customers apart", Object.keys(found[0] ?? {}).sort().join() === "city,company,contactId,customerSince,name");
    check("an unknown name finds nobody", (await scoped(() => customersNamed(rep, `Nobody Atall${SFX}`))).length === 0);
  }
}

main()
  .catch((error) => { failed++; console.error("\nUNEXPECTED ERROR", error); })
  .finally(async () => {
    __setTenantEnforcingForTests(null);
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
