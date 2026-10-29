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
import { customersNamed, findActivities, leadBrief } from "../src/lib/crmAssistant";
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
const C = { noLead: id("c-nolead"), othersSameName: id("c-other"), withLead: id("c-withlead"), twinA: id("c-twin-a"), twinB: id("c-twin-b"), deleted: id("c-deleted"), conly: id("c-conly"), leadNamedDifferently: id("c-diffname"), clive: id("c-clive"), cliveOthers: id("c-clive-other") };
/**
 * Sixty newer look-alikes of the misspelt customer ("Clive Jam" + two letters): more than the fifty most recently
 * changed names the old close-spelling search ever looked at, all sharing its first three letters.
 */
const LOOK_ALIKES = Array.from({ length: 60 }, (_, i) => ({ id: id(`c-alike-${i}`), lastName: `Jam${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}` }));
const L = { withLead: id("l-withlead"), diffName: id("l-diffname") };
const A = { block: id("a-block"), call: id("a-call"), lateBlock: id("a-lateblock"), longLeave: id("a-longleave") };
/** Quotes for the "a customer's quotes" checks: numbers well clear of real ones, three in a row. */
const QUOTE_NO = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const Q = { direct: id("q-direct"), deleted: id("q-deleted"), superseded: id("q-superseded"), conly: id("q-conly") };
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
      // "clive jammim" (Sean, 2026-10-29): the rep's own long-standing customer, and a colleague's of the same name.
      contact(C.clive, "Clive", "Jammine", rep.id),
      contact(C.cliveOthers, "Clive", "Jammine", outsider.id),
      ...LOOK_ALIKES.map((alike) => contact(alike.id, "Clive", alike.lastName, rep.id)),
    ],
  });
  // Long-standing: changed well before every look-alike.
  await basePrisma.$executeRaw`UPDATE "Contact" SET "updatedAt" = '2025-01-01T00:00:00Z' WHERE "id" = ${C.clive}`;
  await basePrisma.lead.createMany({
    data: [
      { id: L.withLead, tenantId: T, title: "Rover XL", name: `Yan Deal${SFX}`, stageId: STAGE, contactId: C.withLead, assignedToId: rep.id, createdById: rep.id },
      // The lead carries a company's name; its customer is a person with another one.
      { id: L.diffName, tenantId: T, title: "Fleet order", name: `Fleetco${SFX}`, stageId: STAGE, contactId: C.leadNamedDifferently, assignedToId: rep.id, createdById: rep.id },
    ],
  });
  // Quotes made for a customer DIRECTLY (no lead): one live, one deleted, one a revision replaced —
  // and one on the customer of somebody who holds no quote permission at all.
  const quote = (qid: string, number: number, contactId: string, createdById: string, extra: Record<string, unknown> = {}) =>
    basePrisma.quote.create({
      data: {
        id: qid, number, tenantId: T, contactId, createdById, status: "draft", ...extra,
        items: { create: [{ tenantId: T, description: "Denago EV Rover XL", qty: 1, unitPriceCents: 23_500_000, costCents: 11_111_100, colorPreference: "White" }] },
        fees: { create: [{ tenantId: T, label: "Delivery Fee", kind: "delivery", amountCents: 500_000 }] },
      },
      select: { id: true },
    });
  await quote(Q.direct, QUOTE_NO, C.twinA, rep.id);
  await quote(Q.deleted, QUOTE_NO + 1, C.twinA, rep.id, { deletedAt: new Date() });
  await quote(Q.superseded, QUOTE_NO + 2, C.twinA, rep.id, { supersededAt: new Date() });
  await quote(Q.conly, QUOTE_NO + 3, C.conly, customersOnly.id);
}

async function cleanup() {
  // Before the users: a message cannot outlive the account it is filed under.
  await basePrisma.communication.deleteMany({ where: { OR: [{ leadId: { in: Object.values(L) } }, { contactId: { in: Object.values(C) } }] } });
  await basePrisma.activity.deleteMany({ where: { id: { in: Object.values(A) } } });
  // Before the customers and the users: a quote's lines and fees go with it.
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: Object.values(Q) } } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: { in: Object.values(Q) } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: Object.values(Q) } } });
  await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(L) } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: [...Object.values(C), ...LOOK_ALIKES.map((alike) => alike.id)] } } });
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

  console.log("\nA misspelt name: the closest customers are offered, not 'spell it' (Sean, 2026-10-29)");
  {
    type Near = Brief & { closeMatches?: { kind: string; contactId?: string; name: string }[] };
    const b = (await brief(rep, "clive jammim")) as Near;
    const offered = (b.closeMatches ?? []).map((match) => match.contactId);
    check("an older customer behind sixty newer look-alikes is found by a misspelling, closest first", offered[0] === C.clive, JSON.stringify(b.closeMatches?.slice(0, 3)));
    check("…offered as the choice, never 'spell it'", /Did you mean Clive Jammine, or /.test(b.note ?? "") && /do NOT ask them to spell it/.test(b.note ?? ""), b.note);
    check("…at most five", offered.length > 1 && offered.length <= 5, String(offered.length));
    check("a colleague's customer of that very name is never offered", !offered.includes(C.cliveOthers));
    const klive = (await brief(rep, "Klive Jammine")) as Near;
    check("a wrong first letter — which the old search could never match — still finds them", klive.closeMatches?.[0]?.contactId === C.clive, JSON.stringify(klive.closeMatches));
    const nowhere = (await brief(rep, "Zola Mthembu")) as Near;
    check("a name nowhere near anyone is still 'no match', not a wild guess", !nowhere.closeMatches?.length && /No lead or customer you can see matches/.test(nowhere.note ?? ""), JSON.stringify(nowhere));
  }

  console.log("\nA person who may open customers but not leads");
  {
    const b = await brief(customersOnly, `Solo Cust${SFX}`);
    check("is not refused: their customer is found", b.customers?.[0]?.contactId === C.conly, b.note);
    const none = await brief(customersOnly, `Yan Deal${SFX}`);
    check("still sees no lead, and no customer that is not theirs", !none.id && !none.customers?.length && /don't have access to leads/.test(none.note ?? ""), JSON.stringify(none));
  }

  console.log("\nThe calendar: blocked time is on it");
  {
    // "What is in my calendar this week?" came back "nothing" for someone whose Tuesday was blocked.
    const at = (daysAhead: number, hour: number) => new Date(new Date(`${new Date(Date.now() + 2 * 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00+02:00`));
    const item = <E extends { type: string; summary: string; dueDate: Date }>(aid: string, extra: E) => ({ id: aid, tenantId: T, assignedToId: rep.id, createdById: rep.id, status: "planned", ...extra });
    await basePrisma.activity.createMany({
      data: [
        item(A.block, { type: "availability", summary: `Admin ${SFX}`, note: "Paperwork", dueDate: at(2, 9), endDate: at(2, 11), availabilityBlock: true }),
        item(A.call, { type: "call", summary: `Call Yan ${SFX}`, dueDate: at(1, 10), leadId: L.withLead, contactId: C.withLead }),
        item(A.lateBlock, { type: "availability", summary: `Old leave ${SFX}`, note: "Leave", dueDate: at(-3, 9), endDate: at(-3, 17), availabilityBlock: true }),
      ],
    });
    type Row = { summary?: string; type?: string; blockedTime?: boolean; time?: string; until?: string; note?: string };
    const find = async (args: Parameters<typeof findActivities>[1]) => (await scoped(() => findActivities(rep, args))).data as Row[];
    const week = await find({ when: "this_week", assignedTo: "Rep" });
    const blocked = week.find((r) => r.summary === `Admin ${SFX}`);
    check("blocked time shows in the week's calendar", Boolean(blocked), JSON.stringify(week.map((r) => r.summary)));
    check("…as what it is, with its hours", blocked?.type === "blocked time" && blocked.blockedTime === true && blocked.time === "09:00" && blocked.until === "11:00", JSON.stringify(blocked));
    check("…alongside the ordinary activities", week.some((r) => r.summary === `Call Yan ${SFX}` && r.type === "call" && !r.blockedTime));
    const overdue = await find({ when: "overdue", assignedTo: "Rep" });
    check("but time off is never listed as OVERDUE work", !overdue.some((r) => r.summary === `Old leave ${SFX}`), JSON.stringify(overdue.map((r) => r.summary)));
    const toDo = await find({ when: "today_and_overdue", assignedTo: "Rep" });
    check("…nor as something to get done today", !toDo.some((r) => r.blockedTime));
    // Dates given with a work list do not turn it back into a calendar.
    const key = (daysAhead: number) => new Date(Date.now() + 2 * 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
    const overdueDated = await find({ when: "overdue", assignedTo: "Rep", from: key(-5), to: key(-1) });
    check("…also when the overdue question names dates", !overdueDated.some((r) => r.blockedTime), JSON.stringify(overdueDated.map((r) => r.summary)));

    // Leave from two days ago until the day after tomorrow: it began BEFORE the week asked about and runs into it.
    await basePrisma.activity.create({
      data: item(A.longLeave, { type: "availability", summary: `Long leave ${SFX}`, note: "Leave", dueDate: at(-2, 0), endDate: at(3, 0), allDay: true, availabilityBlock: true }),
    });
    type Lasting = Row & { due?: string; overdue?: boolean };
    const during = (await find({ when: "this_week", assignedTo: "Rep" }) as Lasting[]).find((r) => r.summary === `Long leave ${SFX}`);
    check("leave that began before the week and ends inside it is in the week", Boolean(during), JSON.stringify(during));
    check("…with the day it began and its last day, and never as overdue", during?.due === key(-2) && during.until === key(2) && !during.overdue, JSON.stringify(during));
    check("…and in a dated question for a day in the middle of it", (await find({ when: "upcoming", assignedTo: "Rep", from: key(1), to: key(1) })).some((r) => r.summary === `Long leave ${SFX}`));
    check("…but not for a day after it has ended", !(await find({ when: "upcoming", assignedTo: "Rep", from: key(3), to: key(4) })).some((r) => r.summary === `Long leave ${SFX}`));
    check("an ordinary activity is still placed by when it starts", !(await find({ when: "upcoming", assignedTo: "Rep", from: key(2), to: key(4) })).some((r) => r.summary === `Call Yan ${SFX}`));

    const empty = await find({ when: "this_week", assignedTo: "Customers Only" });
    check("an empty calendar says which days it covered, and that blocked time was looked for", empty.length === 1 && /from \w{3},? \d+ \w+ to \w{3},? \d+ \w+/.test(empty[0].note ?? "") && /and no blocked time/.test(empty[0].note ?? ""), JSON.stringify(empty));
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
    // …and their quotes (2026-10-13): a quote made for a customer directly is on no lead, so without this
    // a customer came back as a name and a city, and the quote the person named could not be seen at all.
    check("only the fields needed to tell customers apart, and their quotes", Object.keys(found[0] ?? {}).sort().join() === "city,company,contactId,customerSince,name,quotes");
    check("an unknown name finds nobody", (await scoped(() => customersNamed(rep, `Nobody Atall${SFX}`))).length === 0);
  }

  console.log("\nA customer's quotes");
  {
    const found = await scoped(() => customersNamed(rep, `Twin Same${SFX}`));
    const quotesOf = (contactId: string) => (found.find((c) => c.contactId === contactId)?.quotes ?? []) as { quote: string; status: string; onADeal: boolean; lines: string[]; fees: string[] }[];
    const hers = quotesOf(C.twinA);
    check("a quote made for the customer directly — on no lead — is listed on the customer", hers.length === 1 && hers[0].quote === `Q-${QUOTE_NO}` && hers[0].onADeal === false, JSON.stringify(hers));
    check("with what is on it: the line, its quantity and colour, and the fee by its label", hers[0]?.lines.join() === "1 × Denago EV Rover XL — colour White" && /^Delivery Fee — /.test(hers[0]?.fees[0] ?? ""), JSON.stringify(hers[0]));
    check("a deleted quote and one a revision replaced are not listed", !JSON.stringify(found).includes(`Q-${QUOTE_NO + 1}`) && !JSON.stringify(found).includes(`Q-${QUOTE_NO + 2}`));
    check("the other customer of that name has none", quotesOf(C.twinB).length === 0);
    const text = JSON.stringify(found);
    check("still no phone number and no email address", !text.includes("082 555 0199") && !text.includes("@example.invalid"));
    check("no cost and no price per line — only what is printed on the quote's rows", !/costCents|unitPriceCents|"optional"|"selected"/.test(text));
    // Somebody who may open customers but holds NO quote permission: the customer, and no quotes.
    const own = await scoped(() => customersNamed(customersOnly, `Solo Cust${SFX}`));
    check("without a quote permission the customer is found…", own.length === 1 && own[0].contactId === C.conly, JSON.stringify(idsOf(own)));
    check("…and none of their quotes are handed over", Array.isArray(own[0]?.quotes) && own[0].quotes.length === 0, JSON.stringify(own[0]?.quotes));
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
