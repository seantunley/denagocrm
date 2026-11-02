/**
 * REAL-DATABASE proof of DAX's `stuck` and `catch_up` lookups (assistantStuckLookup.ts, assistantCatchUpLookup.ts):
 * "why is Anna's deal stuck?" and "catch me up".
 *
 *   npm run test:assistant-stuck     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * A source test shows the guards are written; only real rows in two real workspaces show what they let through,
 * on the SCOPED client with enforcement on:
 *  - stuck, for the salesperson whose deal it is: the reasons in their order — the customer waiting on a reply, the
 *    overdue follow-up, the quote never opened, the quote running out, too long in the stage — each dated and
 *    linked, with the facts behind them and the message that mentions finance; a won deal held up by its deposit;
 *    a lost deal said to be closed;
 *  - another salesperson in the same workspace: nothing of that deal, by id, by name or by the customer's id;
 *  - catch_up, for that salesperson: since their last question (not a scheduled run's), the customer's new
 *    message (not yet answered), a quote opened again by the CUSTOMER (not the approver), a quote signed, a stage
 *    move and a win made by someone else (not their own move), a new lead and a reassignment — and their overdue
 *    and due-today tasks; never another rep's customer, an unassigned deal they cannot open, or the other
 *    workspace's;
 *  - a manager who sees everything: unassigned deals count as theirs, as in the daily brief;
 *  - the OTHER workspace: nothing of A's either way.
 * And that neither lookup writes anything.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates. The model
 * is never called; nobody is contacted.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { stuckLookup } from "../src/lib/assistantStuckLookup";
import { catchUpLookup } from "../src/lib/assistantCatchUpLookup";
import { stamp } from "../src/lib/assistantWhy";
import { citableLinks } from "../src/lib/assistantReply";
import { johannesburgDateKey } from "../src/lib/activityDay";
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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.now();
const ago = (ms: number) => new Date(T0 - ms);
/** Quote numbers are unique across every workspace: random, so no other run's collide. */
const quoteNo = () => 100_000_000 + crypto.randomInt(800_000_000);
const digest = () => crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");

type Stuck = {
  note?: string;
  deal?: { status: string; link: string };
  reasons?: { rank: number; kind: string; why: string; date?: string; link: string }[];
  stage?: { days: number; limitDays?: number; overTheLimit?: boolean };
  conversation?: { waitingOn: string };
  quote?: { quote: string; sent: string; opened: string } | string;
  nextStep?: { overdue: unknown[]; next: unknown };
  financeMentions?: { text: string }[];
};
type CatchUp = {
  since: string;
  sinceBasis: string;
  items: { when: string; what: string; link: string; by?: string; replied?: string; latest?: string }[];
  tasks: { overdue: number; dueToday: number; list: { summary: string }[] } | string;
};

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`stk${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const repOwn = user("Rep Own");
  const repOther = user("Rep Other");
  const managerA: PermissionUser = { id: a.memberUserId, name: "Harness A member", email: "", role: "member" };
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const managerB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  const ROLE = crypto.randomUUID();
  const name = (first: string) => `${first} Stuck${SFX}`;

  // Two salespeople in A who see only their own deals (and their customers, quotes and diary).
  for (const u of [repOwn, repOther]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
  }
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${A}, ${`Stuck rep ${SFX}`}, 'test', false, now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned", "quotes.view_owned", "activities.view"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${A})`;
  }
  for (const u of [repOwn, repOther]) {
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${ROLE}, ${A})`;
  }

  // A stage with a 14-day limit.
  const quoted = await basePrisma.pipelineStage.create({ data: { tenantId: A, name: `Quoted ${SFX}`, order: 5, pipelineId: a.rows.pipelineId, staleAfterDays: 14 } });
  const stageId = a.rows.stageId;
  const lead = (data: { name: string; title: string; status?: string; stageId?: string; contactId?: string | null; assignedToId: string | null; createdById: string; createdAt?: Date; stageEnteredAt?: Date; lostReason?: string; tenantId?: string }) =>
    basePrisma.lead.create({ data: { tenantId: A, stageId, status: "open", valueCents: 18_000_000, ...data }, select: { id: true } });

  // ── Anna: rep's open deal, stuck for five recorded reasons ──────────────────
  const anna = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Anna", lastName: `Stuck${SFX}`, ownerId: repOwn.id }, select: { id: true } });
  const annaLead = await lead({ name: name("Anna"), title: "Rover XL", stageId: quoted.id, contactId: anna.id, assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(40 * DAY), stageEnteredAt: ago(20 * DAY) });
  const qa = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", leadId: annaLead.id, contactId: anna.id, createdById: repOwn.id, createdAt: ago(7 * DAY), emailedAt: ago(6 * DAY), validUntil: new Date(T0 + 3 * DAY) }, select: { id: true, number: true } });
  const annaChat = await basePrisma.conversation.create({ data: { tenantId: A, channel: "whatsapp", contactId: anna.id, leadId: annaLead.id, lastDirection: "inbound", lastMessageAt: ago(5 * HOUR), lastInboundAt: ago(5 * HOUR) }, select: { id: true } });
  await basePrisma.communication.createMany({ data: [
    // Emailed as a PDF with open-tracking on, and no open seen.
    { tenantId: A, type: "email", direction: "outbound", subject: `Your quote Q-${qa.number}`, body: "Please find your quote attached.", leadId: annaLead.id, contactId: anna.id, userId: repOwn.id, occurredAt: ago(6 * DAY), messageId: `<q-${SFX}@x>`, openToken: digest() },
    { tenantId: A, type: "whatsapp", direction: "inbound", body: "Can I get finance on this?", leadId: annaLead.id, contactId: anna.id, userId: a.ownerUserId, occurredAt: ago(2 * DAY), conversationId: annaChat.id },
    { tenantId: A, type: "whatsapp", direction: "inbound", body: `Is Friday possible for delivery? ${SFX}`, leadId: annaLead.id, contactId: anna.id, userId: a.ownerUserId, occurredAt: ago(5 * HOUR), conversationId: annaChat.id },
  ] });
  await basePrisma.activity.create({ data: { tenantId: A, type: "call", summary: "Call Anna about the quote", dueDate: ago(3 * DAY), leadId: annaLead.id, contactId: anna.id, assignedToId: repOwn.id, createdById: repOwn.id } });

  // ── Ben: rep's WON deal, invoiced, deposit not in ───────────────────────────
  const benLead = await lead({ name: name("Ben"), title: "Nomad", status: "won", assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(30 * DAY) });
  const qb = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "accepted", leadId: benLead.id, createdById: repOwn.id, createdAt: ago(15 * DAY), signedAt: ago(12 * DAY), invoicedAt: ago(10 * DAY) }, select: { number: true } });

  // ── Hana: her quote went out as a SIGNING LINK four days ago; she never opened it ──
  const hana = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Hana", lastName: `Stuck${SFX}`, ownerId: repOwn.id }, select: { id: true } });
  const hanaLead = await lead({ name: name("Hana"), title: "Rover XL", contactId: hana.id, assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(10 * DAY) });
  const qh = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", leadId: hanaLead.id, contactId: hana.id, createdById: repOwn.id, createdAt: ago(5 * DAY) }, select: { id: true, number: true } });
  const hanaRequest = await basePrisma.signatureRequest.create({ data: { tenantId: A, title: `Q-${qh.number}`, status: "sent", sentAt: ago(4 * DAY), quoteId: qh.id }, select: { id: true } });
  await basePrisma.signatureRecipient.create({ data: { tenantId: A, requestId: hanaRequest.id, name: "Hana", email: `hana.${SFX}@customer.invalid`, role: "signer", status: "sent", token: digest() } });

  // ── Lara: rep's LOST deal ──────────────────────────────────────────────────
  await lead({ name: name("Lara"), title: "Rover S", status: "lost", lostReason: "Bought a used cart", assignedToId: repOwn.id, createdById: repOwn.id });

  // ── Cara: the customer back at her quote twice in the window (the approver too — not her) ──
  const cara = await basePrisma.contact.create({ data: { tenantId: A, firstName: "Cara", lastName: `Stuck${SFX}`, ownerId: repOwn.id }, select: { id: true } });
  const caraLead = await lead({ name: name("Cara"), title: "Rover XL", contactId: cara.id, assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(20 * DAY) });
  const qc = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "sent", leadId: caraLead.id, contactId: cara.id, createdById: repOwn.id, createdAt: ago(11 * DAY), viewedAt: ago(5 * DAY) }, select: { id: true, number: true } });
  const request = await basePrisma.signatureRequest.create({ data: { tenantId: A, title: `Q-${qc.number}`, status: "viewed", sentAt: ago(10 * DAY), quoteId: qc.id }, select: { id: true } });
  const caraSigner = await basePrisma.signatureRecipient.create({ data: { tenantId: A, requestId: request.id, name: "Cara", email: `cara.${SFX}@customer.invalid`, role: "signer", status: "viewed", token: digest(), viewedAt: ago(5 * DAY) }, select: { id: true } });
  const approver = await basePrisma.signatureRecipient.create({ data: { tenantId: A, requestId: request.id, name: "Approver", email: `approver.${SFX}@customer.invalid`, role: "approver", status: "viewed", token: digest(), viewedAt: ago(4 * DAY) }, select: { id: true } });
  await basePrisma.signatureView.createMany({ data: [
    { tenantId: A, requestId: request.id, recipientId: caraSigner.id, startedAt: ago(5 * DAY), lastSeenAt: ago(5 * DAY) },
    { tenantId: A, requestId: request.id, recipientId: caraSigner.id, startedAt: ago(20 * HOUR), lastSeenAt: ago(20 * HOUR) },
    { tenantId: A, requestId: request.id, recipientId: caraSigner.id, startedAt: ago(3 * HOUR), lastSeenAt: ago(3 * HOUR) },
    { tenantId: A, requestId: request.id, recipientId: approver.id, startedAt: ago(4 * DAY), lastSeenAt: ago(4 * DAY) },
    { tenantId: A, requestId: request.id, recipientId: approver.id, startedAt: ago(2 * HOUR), lastSeenAt: ago(2 * HOUR) },
  ] });

  // ── Dan: signed in the window, and the CRM marked the deal won ──────────────
  const danLead = await lead({ name: name("Dan"), title: "Nomad", status: "won", assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(25 * DAY) });
  const qd = await basePrisma.quote.create({ data: { tenantId: A, number: quoteNo(), status: "accepted", leadId: danLead.id, createdById: repOwn.id, createdAt: ago(9 * DAY), viewedAt: ago(30 * HOUR), signedAt: ago(10 * HOUR) }, select: { number: true } });

  // ── New and reassigned leads ───────────────────────────────────────────────
  const eveLead = await lead({ name: name("Eve"), title: "Rover S", assignedToId: repOwn.id, createdById: a.ownerUserId, createdAt: ago(4 * HOUR) });
  await lead({ name: name("Self"), title: "Rover S", assignedToId: repOwn.id, createdById: repOwn.id, createdAt: ago(4 * HOUR) });
  const gusLead = await lead({ name: name("Gus"), title: "Fleet order", assignedToId: repOwn.id, createdById: a.ownerUserId, createdAt: ago(20 * DAY) });

  // ── Other people's: another rep's customer, an unassigned deal the rep can't open, workspace B ──
  const oscarLead = await lead({ name: name("Oscar"), title: "Rover XL", assignedToId: repOther.id, createdById: repOther.id, createdAt: ago(10 * DAY) });
  const umaLead = await lead({ name: name("Uma"), title: "Rover XL", assignedToId: null, createdById: a.ownerUserId, createdAt: ago(10 * DAY) });
  const beaLead = await basePrisma.lead.create({ data: { tenantId: b.tenantId, stageId: b.rows.stageId, status: "open", name: name("Bea"), title: "B cart", assignedToId: b.memberUserId, createdById: b.memberUserId, createdAt: ago(10 * DAY) }, select: { id: true } });
  await basePrisma.communication.createMany({ data: [
    { tenantId: A, type: "whatsapp", direction: "inbound", body: `Oscar here ${SFX}`, leadId: oscarLead.id, userId: a.ownerUserId, occurredAt: ago(3 * HOUR) },
    { tenantId: A, type: "whatsapp", direction: "inbound", body: `Uma here ${SFX}`, leadId: umaLead.id, userId: a.ownerUserId, occurredAt: ago(2 * HOUR) },
    { tenantId: b.tenantId, type: "whatsapp", direction: "inbound", body: `B secret ${SFX}`, leadId: beaLead.id, userId: b.ownerUserId, occurredAt: ago(1 * HOUR) },
  ] });

  // ── The audit trail: moves by someone else, by the CRM, and the rep's own ───
  await basePrisma.auditLog.createMany({ data: [
    { tenantId: A, action: "lead.stage_changed", summary: `Moved “Rover XL” to Quoted ${SFX}`, leadId: annaLead.id, userId: a.memberUserId, userName: "Harness A member", createdAt: ago(6 * HOUR) },
    { tenantId: A, action: "lead.stage_changed", summary: `My own move ${SFX}`, leadId: annaLead.id, userId: repOwn.id, userName: repOwn.name, createdAt: ago(7 * HOUR) },
    { tenantId: A, action: "lead.won", summary: `Lead “Nomad” won ${SFX}`, leadId: danLead.id, userId: null, userName: "System", createdAt: ago(10 * HOUR) },
    { tenantId: A, action: "lead.assigned", summary: `Auto-assigned to Rep Own by lead routing ${SFX}`, leadId: eveLead.id, userId: null, userName: "System", createdAt: ago(4 * HOUR) },
    { tenantId: A, action: "lead.assigned", summary: `Assigned lead “Fleet order” to Rep Own ${SFX}`, leadId: gusLead.id, userId: a.memberUserId, userName: "Harness A member", createdAt: ago(8 * HOUR) },
  ] });

  // ── The rep's questions to DAX: the last real one 26 hours ago; a scheduled run since must not count ──
  const lastAsked = ago(26 * HOUR);
  await basePrisma.assistantTurn.createMany({ data: [
    { tenantId: A, userId: repOwn.id, question: "q", answer: "a", source: "chat", createdAt: ago(5 * DAY) },
    { tenantId: A, userId: repOwn.id, question: "q", answer: "a", source: "whatsapp", createdAt: lastAsked },
    { tenantId: A, userId: repOwn.id, question: "q", answer: "a", source: "schedule", createdAt: ago(1 * HOUR) },
  ] });
  // A task due today (just after midnight, so it is today whatever the hour).
  const startOfToday = new Date(`${johannesburgDateKey(new Date(T0))}T00:00:00+02:00`);
  await basePrisma.activity.create({ data: { tenantId: A, type: "todo", summary: `Send Cara the brochure ${SFX}`, dueDate: new Date(startOfToday.getTime() + 60_000), leadId: caraLead.id, assignedToId: repOwn.id, createdById: repOwn.id } });

  const stuck = async (tenantId: string, u: PermissionUser, needle: string) =>
    (await runInTenantScope({ tenantId, system: false }, () => stuckLookup(u, needle))).data[0] as Stuck;
  const catchUp = async (tenantId: string, u: PermissionUser, since?: string) =>
    (await runInTenantScope({ tenantId, system: false }, () => catchUpLookup(u, since))).data[0] as CatchUp;
  const counts = async () => (await basePrisma.$queryRaw<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "Communication") + (SELECT count(*) FROM "AssistantTurn")
      + (SELECT count(*) FROM "Activity") + (SELECT count(*) FROM "Lead") + (SELECT count(*) FROM "Quote") + (SELECT count(*) FROM "SignatureView"))::int AS n`)[0].n;

  try {
    __setTenantEnforcingForTests(true);
    const before = await counts();

    console.log("\nstuck — the salesperson whose deal it is");
    const own = await stuck(A, repOwn, annaLead.id);
    const kinds = own.reasons?.map((r) => r.kind) ?? [];
    check("the five recorded reasons, most pressing first", JSON.stringify(kinds) === JSON.stringify(["customer_waiting", "overdue_task", "quote_unopened", "quote_expiring", "stage_age"]), JSON.stringify(own.reasons));
    const reason = (kind: string) => own.reasons?.find((r) => r.kind === kind);
    check("…the customer waiting: the attention signal's own words, linked to the conversation", /^Customer wrote on WhatsApp \d+h ago and has had no reply$/.test(reason("customer_waiting")?.why ?? "") && reason("customer_waiting")?.link === `/inbox?conversation=${annaChat.id}`, JSON.stringify(reason("customer_waiting")));
    check("…the overdue follow-up, dated", /“Call Anna about the quote” was due 3d ago/.test(reason("overdue_task")?.why ?? "") && reason("overdue_task")?.date === stamp(ago(3 * DAY)));
    check("…the emailed quote: no open of its email detected (never 'she hasn't read it'), linked to it", reason("quote_unopened")?.why === `Q-${qa.number} was emailed 6 days ago (${johannesburgDateKey(ago(6 * DAY))}) and no open of that email has been detected` && reason("quote_unopened")?.link === `/quotes/${qa.id}`, JSON.stringify(reason("quote_unopened")));
    check("…the quote running out", /^Quote Q-\d+ expires in 3 days$/.test(reason("quote_expiring")?.why ?? ""), reason("quote_expiring")?.why);
    check("…and the stage age against the stage's 14-day limit", reason("stage_age")?.why === "In this stage 20 days — past the 14-day mark" && own.stage?.days === 20 && own.stage?.limitDays === 14 && own.stage?.overTheLimit === true, JSON.stringify(own.stage));
    check("a planned (overdue) follow-up is a next step: no 'no next step'", !kinds.includes("no_next_step") && (own.nextStep?.overdue.length ?? 0) === 1);
    check("the customer wrote last: waiting on us, so not 'gone quiet'", /^us/.test(own.conversation?.waitingOn ?? "") && !kinds.includes("customer_quiet"));
    check("the quote facts: emailed then, opening not something the CRM can see for a PDF", typeof own.quote === "object" && own.quote.sent === stamp(ago(6 * DAY)) && /^not recorded — it wasn't sent as a signing link/.test(own.quote.opened), JSON.stringify(own.quote));
    const hanaStuck = await stuck(A, repOwn, hanaLead.id);
    check("a quote sent as a signing link and never opened — said plainly, with the stage's lack of a limit said too",
      JSON.stringify(hanaStuck.reasons?.map((r) => r.kind)) === JSON.stringify(["quote_unopened", "no_next_step", "customer_quiet"]) &&
        hanaStuck.reasons?.[0].why === `Q-${qh.number} went out 4 days ago (${johannesburgDateKey(ago(4 * DAY))}) and the customer hasn't opened it` &&
        typeof hanaStuck.quote === "object" && hanaStuck.quote.opened === "never — the customer hasn't opened the signing link" &&
        /no time limit set/.test(JSON.stringify(hanaStuck.stage)),
      JSON.stringify({ reasons: hanaStuck.reasons, quote: hanaStuck.quote, stage: hanaStuck.stage }));
    check("the message that mentions finance is there to read", own.financeMentions?.some((m) => m.text === "Can I get finance on this?") === true, JSON.stringify(own.financeMentions));
    // The answer cites these links as chips, named by the answer step's own reader (assistantReply.citableLinks).
    const chips = citableLinks(own);
    check("every link is a chip with a name: the deal, the quote, the conversation",
      chips.get(`/leads/${annaLead.id}`) === name("Anna") && chips.get(`/quotes/${qa.id}`) === `Q-${qa.number}` && chips.get(`/inbox?conversation=${annaChat.id}`) === "Inbox conversation" && ![...chips.values()].includes("Open"),
      JSON.stringify([...chips.entries()]));
    check("found by name too", (await stuck(A, repOwn, "Anna")).reasons?.[0]?.kind === "customer_waiting");
    check("…and by the customer's id (the bubble on her page)", (await stuck(A, repOwn, anna.id)).reasons?.length === 5);
    const ben = await stuck(A, repOwn, benLead.id);
    check("a WON deal held up after signing: invoiced, deposit not in (the deliveries board's rule)", ben.deal?.status === "won" && ben.reasons?.length === 1 && ben.reasons[0].kind === "after_signing" && ben.reasons[0].why === `Q-${qb.number} was invoiced on ${johannesburgDateKey(ago(10 * DAY))} and the deposit hasn't been marked paid`, JSON.stringify(ben.reasons));
    check("a LOST deal is closed, not stuck — with the reason given", /lost[\s\S]*"Bought a used cart"[\s\S]*closed, not stuck/.test((await stuck(A, repOwn, name("Lara"))).note ?? ""));
    check("the owner sees the same reasons", JSON.stringify((await stuck(A, ownerA, annaLead.id)).reasons?.map((r) => r.kind)) === JSON.stringify(kinds));

    console.log("\nstuck — another salesperson in the same workspace");
    check("not by id", /No deal you can open/.test((await stuck(A, repOther, annaLead.id)).note ?? ""));
    check("not by name", /No deal you can open/.test((await stuck(A, repOther, "Anna")).note ?? ""));
    check("not by the customer's id", /No deal you can open/.test((await stuck(A, repOther, anna.id)).note ?? ""));
    check("…and the rep can't open the other rep's deal either", /No deal you can open/.test((await stuck(A, repOwn, oscarLead.id)).note ?? ""));

    console.log("\nstuck — the other workspace");
    check("B cannot see A's deal by id", /No deal you can open/.test((await stuck(b.tenantId, managerB, annaLead.id)).note ?? ""));
    check("…nor by name", /No deal you can open/.test((await stuck(b.tenantId, managerB, name("Anna"))).note ?? ""));
    check("A cannot see B's deal", /No deal you can open/.test((await stuck(A, managerA, beaLead.id)).note ?? ""));

    console.log("\ncatch_up — the salesperson");
    const mine = await catchUp(A, repOwn);
    const whats = mine.items.map((i) => i.what);
    const has = (re: RegExp) => mine.items.find((i) => re.test(i.what));
    check("since their last question (WhatsApp) — not the scheduled run after it", mine.since === stamp(lastAsked) && mine.sinceBasis === "their last question to DAX", `${mine.since} / ${mine.sinceBasis}`);
    const annaNews = has(new RegExp(`^Anna Stuck${SFX} wrote a message \\(whatsapp\\)$`));
    check("Anna's new message, its words, and that nobody has answered", annaNews?.latest === `Is Friday possible for delivery? ${SFX}` && annaNews?.replied === "not yet" && annaNews?.link === `/leads/${annaLead.id}`, JSON.stringify(annaNews));
    check("Cara opened her quote again — twice; the approver's visit is not hers", !!has(new RegExp(`^Cara Stuck${SFX} opened Q-${qc.number} again \\(2 times\\)$`)), JSON.stringify(whats));
    check("Dan signed his quote", !!has(new RegExp(`signed Q-${qd.number}$`)));
    const moved = has(new RegExp(`Moved “Rover XL” to Quoted ${SFX}`));
    check("the stage move someone else made, and who", moved?.by === "person: Harness A member", JSON.stringify(moved));
    check("the win the CRM recorded, as automatic", has(new RegExp(`won ${SFX}`))?.by === "automatic: System");
    check("never their own move", !has(new RegExp(`My own move ${SFX}`)));
    check("the new lead given to them, once (not again as its routing)", whats.filter((w) => w.includes(name("Eve"))).length === 1 && !!has(new RegExp(`^New lead for you: ${name("Eve")} — Rover S$`)) && !has(new RegExp(`Auto-assigned to Rep Own by lead routing ${SFX}`)), JSON.stringify(whats));
    check("a lead they made themselves is not news", !whats.some((w) => w.includes(name("Self"))));
    check("an older deal reassigned to them", has(new RegExp(`Assigned lead “Fleet order” to Rep Own ${SFX}`))?.by === "person: Harness A member");
    check("newest first", mine.items.every((item, i) => i === 0 || mine.items[i - 1].when >= item.when));
    check("never another rep's customer, an unassigned deal they can't open, or the other workspace", !JSON.stringify(mine).includes(`Oscar here ${SFX}`) && !JSON.stringify(mine).includes(`Uma here ${SFX}`) && !JSON.stringify(mine).includes(`B secret ${SFX}`));
    check("their tasks now: one overdue, one due today", typeof mine.tasks === "object" && mine.tasks.overdue === 1 && mine.tasks.dueToday === 1, JSON.stringify(mine.tasks));
    check("every item's link is a chip with a name", ![...citableLinks(mine).values()].includes("Open") && citableLinks(mine).get(`/leads/${eveLead.id}`) === name("Eve"), JSON.stringify([...citableLinks(mine).entries()]));
    const fromDay = johannesburgDateKey(ago(3 * DAY));
    const sinceDay = await catchUp(A, repOwn, fromDay);
    check("a day they name replaces it — Anna's two messages since then", sinceDay.sinceBasis === `the start of ${fromDay}, as they asked` && !!sinceDay.items.find((i) => i.what === `Anna Stuck${SFX} wrote 2 messages (whatsapp)`), JSON.stringify(sinceDay.items.map((i) => i.what)));

    console.log("\ncatch_up — the other salesperson, a manager, the other workspace");
    const other = await catchUp(A, repOther);
    check("no earlier question: the last 24 hours", /last 24 hours/.test(other.sinceBasis));
    check("their own customer's message", other.items.some((i) => (i.latest ?? "") === `Oscar here ${SFX}`), JSON.stringify(other.items));
    check("nothing of the other rep's deals", !JSON.stringify(other).includes(name("Anna")) && !JSON.stringify(other).includes(name("Cara")) && !JSON.stringify(other).includes(`Uma here ${SFX}`));
    const manager = await catchUp(A, managerA);
    check("a manager who sees everything: an unassigned deal counts as theirs (the daily brief's rule)", manager.items.some((i) => (i.latest ?? "") === `Uma here ${SFX}`), JSON.stringify(manager.items.map((i) => i.what)));
    check("…but not deals assigned to someone else", !JSON.stringify(manager).includes(`Is Friday possible for delivery? ${SFX}`) && !JSON.stringify(manager).includes(`Oscar here ${SFX}`));
    const bView = await catchUp(b.tenantId, managerB);
    check("B gets its own news", bView.items.some((i) => (i.latest ?? "") === `B secret ${SFX}`));
    check("…and nothing of A's", !/(Anna|Cara|Dan|Eve|Gus|Uma|Oscar) Stuck/.test(JSON.stringify(bView)) && !JSON.stringify(bView).includes(`here ${SFX}`), JSON.stringify(bView.items));

    check("READ-ONLY: nothing was written", (await counts()) === before);
  } finally {
    __setTenantEnforcingForTests(null);
    const tenants = [A, b.tenantId];
    await basePrisma.signatureView.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.signatureRecipient.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.signatureRequest.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.communication.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.conversation.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.assistantTurn.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await teardown(fixture);
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${repOwn.id}, ${repOther.id})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" IN (${repOwn.id}, ${repOther.id})`.catch(() => 0);
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
