/**
 * REAL-DATABASE proof of LOG A CALL (Sean, 2026-11-14: "Record or dictate a call, and DAX writes the summary, files it
 * and proposes the follow-up").
 *
 *   npm run test:assistant-log-call     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Through the SCOPED client with enforcement on, as two sales reps with only their OWN deals and customers:
 *  - DAX's log_call card (the real resolveActions) writes NOTHING — the call is filed only on Confirm;
 *  - Confirm (the real runAssistantAction → logVoiceDebrief, the Log a call button's own save) files a completed call
 *    on the deal, its notes on the timeline and the follow-up for that rep — in their workspace;
 *  - on a customer with no deal, the same, on the customer;
 *  - a proposal naming no activity is a call; a second Confirm of the same card files nothing more;
 *  - a follow-up that clashes with the rep's leave is refused with NOTHING saved; the same card with the time fixed,
 *    confirmed twice, leaves exactly one call, one timeline note and one follow-up (review of #1117);
 *  - another rep gets no card for this rep's deal or customer, and their Confirm of this rep's card writes nothing;
 *  - the other workspace's customer: no card, and a forged card writes nothing there.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates (except
 * append-only audit events). The model is never called; nobody is contacted.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { resolveActions } from "../src/lib/crmAssistant";
import { runAssistantAction } from "../src/app/actions/assistant";
import { johannesburgDateKey } from "../src/lib/activityDay";
import { signFreshSession } from "../src/lib/session";
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

type CallCard = Extract<ActionCard, { kind: "log_call" }>;

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`call${SFX}`);
  const { a, b } = fixture;
  const A = a.tenantId;
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const rep = user("Call Rep");
  const other = user("Other Rep");
  const ROLE = crypto.randomUUID();
  const sessionFor = async (u: PermissionUser): Promise<ActingSession> =>
    ({ cookieValue: await signFreshSession({ id: u.id, name: u.name ?? "", email: u.email ?? "", role: u.role, grants: "", sessionVersion: 0 }, 60, { tid: A }), label: u.name ?? u.id });

  try {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${A}, ${`Calls ${SFX}`}, 'test', false, now())`;
    for (const key of ["activities.manage", "activities.view", "leads.view_owned", "contacts.view_owned", "contacts.edit"]) {
      await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${A})`;
    }
    for (const u of [rep, other]) {
      await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
      await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${A}, ${u.id})`;
      await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${ROLE}, ${A})`;
    }
    const contact = (first: string, ownerId: string) =>
      basePrisma.contact.create({ data: { tenantId: A, firstName: first, lastName: `Call${SFX}`, ownerId }, select: { id: true } });
    const marcel = await contact("Marcel", rep.id);
    const anna = await contact("Anna", rep.id);
    const petrus = await contact("Petrus", other.id);
    const lead = (name: string, contactId: string, owner: string) =>
      basePrisma.lead.create({ data: { tenantId: A, title: "Rover XL", name, stageId: a.rows.stageId, contactId, assignedToId: owner, createdById: owner }, select: { id: true } });
    const repDeal = await lead(`Marcel Call${SFX}`, marcel.id, rep.id);
    const otherDeal = await lead(`Petrus Call${SFX}`, petrus.id, other.id);

    __setTenantEnforcingForTests(true);
    const repSession = await sessionFor(rep);
    const otherSession = await sessionFor(other);
    const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: A, system: false }, fn);
    const propose = async (who: PermissionUser, session: ActingSession, proposal: Record<string, unknown>) => {
      const problems: string[] = [];
      const cards = await runAsSession(session, () => scoped(() => resolveActions(who, [proposal as never], problems, null)));
      return { problems, card: cards.find((c): c is CallCard => c.kind === "log_call") };
    };
    const written = async () => {
      const [activities, notes] = await Promise.all([
        basePrisma.activity.count({ where: { OR: [{ tenantId: A }, { tenantId: b.tenantId }], summary: { contains: SFX } } }),
        basePrisma.communication.count({ where: { OR: [{ tenantId: A }, { tenantId: b.tenantId }], subject: { contains: SFX } } }),
      ]);
      return activities + notes;
    };
    const inThreeDays = johannesburgDateKey(new Date(Date.now() + 3 * 86_400_000));

    console.log("\nOn the rep's own deal");
    const before = await written();
    const proposal = { type: "log_call", leadId: repDeal.id, summary: `Wants the XL in white ${SFX}`, notes: "• Finance through the bank", nextStep: `Send the finance form ${SFX}`, followUp: inThreeDays };
    const { card, problems } = await propose(rep, repSession, proposal);
    check("a card, showing the notes, the next step and the follow-up", !!card && card.detail.includes("• Finance through the bank") && card.detail.includes("Follow-up call booked:") && card.detail.includes("the customer is not contacted"), JSON.stringify({ card, problems }));
    // REVIEW OF #1117: the proposal names no activity — it is a call (the resolver normalises it, not only the schema).
    check("no activity named: a call", card?.activity === "call" && card.title.startsWith("Log the call:"), JSON.stringify(card));
    check("…and NOTHING is written until Confirm", (await written()) === before, String(await written()));

    // Another rep presses Confirm on this rep's card: their access is checked again, nothing is filed.
    const forged = await runAsSession(otherSession, () => scoped(() => runAssistantAction(card!)));
    check("another rep confirming it: refused, nothing written", !forged.ok && (await written()) === before, JSON.stringify(forged));

    const done = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    const call = await basePrisma.activity.findFirst({ where: { leadId: repDeal.id, type: "call", status: "done" } });
    const followUp = await basePrisma.activity.findFirst({ where: { leadId: repDeal.id, status: "planned", summary: `Send the finance form ${SFX}` } });
    const note = await basePrisma.communication.findFirst({ where: { leadId: repDeal.id, subject: { contains: SFX } } });
    check("Confirm: a completed call on the deal, for the rep, in their workspace", done.ok && call?.summary === `Wants the XL in white ${SFX}` && call.assignedToId === rep.id && call.tenantId === A && call.contactId === marcel.id, JSON.stringify({ done, call }));
    check("…its notes on the timeline, with the next step", !!note && note.body.includes("Finance through the bank") && note.body.includes("Next step:") && note.tenantId === A, JSON.stringify(note));
    check("…and the follow-up booked for the rep on that day", !!followUp && followUp.assignedToId === rep.id && johannesburgDateKey(followUp.dueDate) === inThreeDays && followUp.tenantId === A, JSON.stringify(followUp));
    check("…confirmed from DAX's card, in the audit trail", (await basePrisma.auditEvent.count({ where: { eventType: "assistant.action_confirmed", summary: { contains: "log a call" }, actorUserId: rep.id } })) >= 1);
    const filed = await written();
    const twice = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    check("Confirm the same card again (the answer was lost): ok, and nothing more is filed", twice.ok && (await written()) === filed
      && (await basePrisma.activity.count({ where: { leadId: repDeal.id, type: "call", status: "done" } })) === 1, JSON.stringify(twice));

    console.log("\nA follow-up refused: nothing saved; fixed and saved again: filed once (review of #1117)");
    // The rep is on leave at the agreed time — the clash every booking checks.
    const leaveDay = johannesburgDateKey(new Date(Date.now() + 5 * 86_400_000));
    await basePrisma.activity.create({
      data: { tenantId: A, type: "todo", summary: "On leave", availabilityBlock: true, status: "planned", dueDate: new Date(`${leaveDay}T08:00:00+02:00`), endDate: new Date(`${leaveDay}T17:00:00+02:00`), assignedToId: rep.id, createdById: rep.id },
    });
    const clash = await propose(rep, repSession, { type: "log_call", contactId: marcel.id, summary: `Clash ${SFX}`, notes: `Clash notes ${SFX}`, followUp: `${leaveDay}T10:00` });
    const beforeClash = await written();
    const refused = await runAsSession(repSession, () => scoped(() => runAssistantAction(clash.card!)));
    check("the follow-up clashes: refused, and NOTHING was saved — no call, no note", !refused.ok && /Nothing was saved/.test(refused.error ?? "") && (await written()) === beforeClash, JSON.stringify(refused));
    // The person fixes the time and saves again — the same draft, the same key.
    const fixed: CallCard = { ...clash.card!, followUp: inThreeDays };
    const saved = await runAsSession(repSession, () => scoped(() => runAssistantAction(fixed)));
    const again = await runAsSession(repSession, () => scoped(() => runAssistantAction(fixed)));
    const calls = await basePrisma.activity.count({ where: { contactId: marcel.id, summary: `Clash ${SFX}`, status: "done" } });
    const notes = await basePrisma.communication.count({ where: { contactId: marcel.id, body: { contains: `Clash notes ${SFX}` } } });
    const followUps = await basePrisma.activity.findMany({ where: { contactId: marcel.id, leadId: null, status: "planned", type: "call" }, select: { dueDate: true } });
    check("saved again with the time fixed (and once more): exactly one call, one timeline note, one follow-up on the fixed day", saved.ok && again.ok && calls === 1 && notes === 1
      && followUps.length === 1 && johannesburgDateKey(followUps[0].dueDate) === inThreeDays, JSON.stringify({ saved, again, calls, notes, followUps }));

    console.log("\nOn a customer with no deal");
    const visit = await propose(rep, repSession, { type: "log_call", contactId: anna.id, activity: "meeting", summary: `Showroom visit ${SFX}` });
    check("a card for the customer", !!visit.card && visit.card.leadId === null && visit.card.contactId === anna.id, JSON.stringify(visit));
    const visited = await runAsSession(repSession, () => scoped(() => runAssistantAction(visit.card!)));
    const row = await basePrisma.activity.findFirst({ where: { contactId: anna.id, summary: `Showroom visit ${SFX}` } });
    check("Confirm: a completed visit on the customer, no deal, no follow-up", visited.ok && row?.type === "meeting" && row.status === "done" && row.leadId === null && row.tenantId === A
      && (await basePrisma.activity.count({ where: { contactId: anna.id, status: "planned" } })) === 0, JSON.stringify({ visited, row }));

    console.log("\nAnother rep's deal and customer, and the other workspace");
    const beforeOthers = await written();
    const theirDeal = await propose(rep, repSession, { type: "log_call", leadId: otherDeal.id, summary: `Theirs ${SFX}` });
    check("another rep's deal: no card, and it says why", !theirDeal.card && /can't open it/.test(theirDeal.problems.join(" ")), theirDeal.problems.join(" | "));
    const theirCustomer = await propose(rep, repSession, { type: "log_call", contactId: petrus.id, summary: `Theirs ${SFX}` });
    check("another rep's customer: no card", !theirCustomer.card, theirCustomer.problems.join(" | "));
    const otherWorkspace = await propose(rep, repSession, { type: "log_call", contactId: b.rows.contactId, summary: `B ${SFX}` });
    check("the other workspace's customer: no card", !otherWorkspace.card, otherWorkspace.problems.join(" | "));
    // A card made up by hand for B's customer and for another rep's deal: Confirm checks access itself.
    const freshKey = () => `qk_${crypto.randomBytes(16).toString("hex")}`;
    const forgedB: CallCard = { ...visit.card!, id: "forged-b", contactId: b.rows.contactId, summary: `Forged B ${SFX}`, confirmKey: freshKey() };
    const forgedDeal: CallCard = { ...card!, id: "forged-deal", leadId: otherDeal.id, summary: `Forged deal ${SFX}`, confirmKey: freshKey() };
    const resultB = await runAsSession(repSession, () => scoped(() => runAssistantAction(forgedB)));
    const resultDeal = await runAsSession(repSession, () => scoped(() => runAssistantAction(forgedDeal)));
    check("forged cards: both refused, nothing written anywhere", !resultB.ok && !resultDeal.ok && (await written()) === beforeOthers, JSON.stringify({ resultB, resultDeal }));
    check("…and nothing at all in the other workspace", (await basePrisma.activity.count({ where: { tenantId: b.tenantId, summary: { contains: SFX } } })) === 0);
  } finally {
    __setTenantEnforcingForTests(null);
    const ids = [rep.id, other.id];
    await basePrisma.activity.deleteMany({ where: { OR: [{ assignedToId: { in: ids } }, { createdById: { in: ids } }] } }).catch(() => 0);
    await basePrisma.communication.deleteMany({ where: { userId: { in: ids } } }).catch(() => 0);
    await basePrisma.assistantPendingAction.deleteMany({ where: { userId: { in: ids } } }).catch(() => 0);
    await basePrisma.lead.deleteMany({ where: { tenantId: A, name: { endsWith: `Call${SFX}` } } }).catch(() => 0);
    await basePrisma.contact.deleteMany({ where: { tenantId: A, lastName: `Call${SFX}` } }).catch(() => 0);
    await basePrisma.auditLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE}`.catch(() => 0);
    await teardown(fixture).catch((error) => { failed++; console.error("teardown failed", error); });
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
