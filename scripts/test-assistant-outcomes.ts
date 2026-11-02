/**
 * HOW DAX'S SUGGESTIONS WORKED OUT, on a real database (Sean, 2026-11-02: outcome tracking, step 1 — measure and show).
 *
 *   npm run test:assistant-outcomes     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * What the unit test (tests/assistantOutcomes.test.ts) cannot show, through the SCOPED client with enforcement on:
 *  - the real Confirm (runAssistantAction) records the card's kind on its audit event, and the customer's timeline
 *    (AuditLog) gets exactly the line it always had;
 *  - AssistantTurn.proposed is there (the migration is applied) and reads back;
 *  - the counting reads the real records: an inbound message, a signed quote, an accepted quote's audit event, a
 *    real stage move (moveLead's own audit entry), a win (the Lead trigger's wonAt), an entry from before the kind
 *    was recorded;
 *  - another workspace's numbers never appear, either way round;
 *  - a workspace owner whose role sees only their own deals CAN open the page, and is counted only those deals; a
 *    colleague of theirs cannot open it at all.
 *
 * Both workspaces are new on every run, so earlier runs' audit events — append-only, never deleted — are never in
 * scope. Every row this script writes itself is dated from the window's start: a local Postgres that is not on UTC
 * dates its OWN defaults (raw inserts, triggers) hours off this clock, which no verdict here — counted in days —
 * depends on.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates except
 * append-only audit events. The model is never called; nobody is contacted.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { runAssistantAction } from "../src/app/actions/assistant";
import { moveLead } from "../src/app/actions/leads";
import { isTenantOwner } from "../src/lib/auth";
import { listActingTenantStaff } from "../src/lib/tenantActor";
import { assistantOutcomes } from "../src/lib/assistantOutcomes";
import { signFreshSession } from "../src/lib/session";
import { runAsSession, type ActingSession } from "./harness/actingSession";

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

const id = (what: string) => `outc-${what}-${SFX}`;
const T = id("tenant-a");
const T2 = id("tenant-b");
const PIPE = { a: id("pipe-a"), b: id("pipe-b") };
const DAY = 86_400_000;
// The window opens just before anything this run writes.
const t0 = new Date(Date.now() - 2_000);
const at = (days: number) => new Date(t0.getTime() + days * DAY);

const user = (name: string, role = "member"): PermissionUser => ({ id: id(name.toLowerCase()), name: `${name} ${SFX}`, email: `${id(name.toLowerCase())}@example.invalid`, role });
const rep = user("Rep");
const rep2 = user("Rep2");
const boss = user("Boss", "owner"); // sees everything (a person belongs to one workspace: this one)
const boss2 = user("Boss2", "owner"); // …and workspace 2's
const t2owner = user("Owner2"); // owns workspace 2; their role sees only their own deals
const t2rep = user("Rep3");
const USERS = [rep, rep2, boss, boss2, t2owner, t2rep];
const GONE = id("gone"); // someone no longer in the team
const ROLE2 = id("role");
const S = { one: id("s1"), two: id("s2"), three: id("s3"), t2: id("s-t2") };
const C = { anna: id("c-anna"), ben: id("c-ben"), carl: id("c-carl"), dee: id("c-dee"), fay: id("c-fay"), gus: id("c-gus"), hal: id("c-hal"), ivy: id("c-ivy"), jo: id("c-jo"), own2: id("c-own2"), rep2: id("c-rep2") };
const L = { anna: id("l-anna"), ben: id("l-ben"), stage: id("l-stage"), stage2: id("l-stage2"), win: id("l-win"), quote: id("l-quote"), hal: id("l-hal"), meet: id("l-meet"), own2: id("l-own2"), rep2: id("l-rep2") };
const QUOTE = id("quote");
const inT = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
const inT2 = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T2, system: false }, fn);

async function sessionFor(u: PermissionUser, tid: string): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: u.id, name: u.name, email: u.email, role: u.role, grants: "", sessionVersion: 0 }, 60, { tid }), label: u.name };
}

async function seed() {
  await basePrisma.user.createMany({ data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: u.role, modules: "crm" })) });
  // Two new workspaces with the assistant's module; workspace 2 is owned by someone whose role sees only their deals.
  await basePrisma.tenant.create({ data: { id: T, name: `Outcomes A ${SFX}`, slug: T, active: true, modules: "automation" } });
  await basePrisma.tenant.create({ data: { id: T2, name: `Outcomes B ${SFX}`, slug: T2, active: true, modules: "automation", ownerUserId: t2owner.id } });
  for (const [pipeline, tenantId] of [[PIPE.a, T], [PIPE.b, T2]] as const) {
    await basePrisma.$executeRaw`INSERT INTO "SalesPipeline" ("id", "tenantId", "name", "type", "active", "isDefault", "createdAt", "updatedAt")
      VALUES (${pipeline}, ${tenantId}, ${`Sales ${SFX}`}, 'sales', true, true, now(), now())`;
  }
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES
    (${id("tm1")}, ${T}, ${rep.id}), (${id("tm2")}, ${T}, ${rep2.id}), (${id("tm3")}, ${T}, ${boss.id}),
    (${id("tm4")}, ${T2}, ${t2owner.id}), (${id("tm5")}, ${T2}, ${t2rep.id}), (${id("tm6")}, ${T2}, ${boss2.id})`;
  // Workspace 2's role: each person sees only their own deals and customers.
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "tenantId", "name", "description", "system", "createdAt", "updatedAt")
    VALUES (${ROLE2}, ${T2}, ${`Own deals ${SFX}`}, 'test', false, now(), now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${ROLE2}, ${key}, ${T2})`;
  }
  await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
    (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}), (gen_random_uuid()::text, ${rep2.id}, 'role_sales_rep', ${T}),
    (gen_random_uuid()::text, ${t2owner.id}, ${ROLE2}, ${T2}), (gen_random_uuid()::text, ${t2rep.id}, ${ROLE2}, ${T2})`;
  for (const [stage, tenantId, pipeline, order] of [[S.one, T, PIPE.a, 1], [S.two, T, PIPE.a, 2], [S.three, T, PIPE.a, 3], [S.t2, T2, PIPE.b, 1]] as const) {
    await basePrisma.$executeRaw`INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
      VALUES (${stage}, ${tenantId}, ${`Stage ${order} ${SFX}`}, ${order}, '#64748b', ${pipeline}, 10, false)`;
  }
  const contact = (cid: string, tenantId: string, firstName: string, owner: PermissionUser) =>
    ({ id: cid, tenantId, firstName, lastName: `Outc${SFX}`, ownerId: owner.id, createdById: owner.id });
  await basePrisma.contact.createMany({
    data: [
      contact(C.anna, T, "Anna", rep), contact(C.ben, T, "Ben", rep), contact(C.carl, T, "Carl", rep2), contact(C.dee, T, "Dee", rep),
      contact(C.fay, T, "Fay", rep), contact(C.gus, T, "Gus", rep2), contact(C.hal, T, "Hal", rep2), contact(C.ivy, T, "Ivy", rep2),
      contact(C.jo, T, "Jo", rep2), contact(C.own2, T2, "Own", t2owner), contact(C.rep2, T2, "Other", t2rep),
    ],
  });
  const lead = (lid: string, tenantId: string, contactId: string, owner: PermissionUser, stageId = S.one) =>
    ({ id: lid, tenantId, title: "Rover XL", name: `Lead ${lid}`, stageId, contactId, assignedToId: owner.id, createdById: owner.id });
  await basePrisma.lead.createMany({
    data: [
      lead(L.anna, T, C.anna, rep), lead(L.ben, T, C.ben, rep), lead(L.stage, T, C.dee, rep), lead(L.stage2, T, C.fay, rep),
      lead(L.win, T, C.gus, rep2), lead(L.quote, T, C.ivy, rep2), lead(L.hal, T, C.hal, rep2), lead(L.meet, T, C.jo, rep2),
      lead(L.own2, T2, C.own2, t2owner, S.t2), lead(L.rep2, T2, C.rep2, t2rep, S.t2),
    ],
  });
  // What DAX offered — as askCrm records it (assistantOutcomeRules.proposedCards) — at the start of the window.
  const turn = (tenantId: string, u: PermissionUser, proposed: object[]) =>
    basePrisma.assistantTurn.create({ data: { tenantId, userId: u.id, question: "What next?", answer: "Here you go.", proposed, createdAt: t0 } });
  await turn(T, rep, [
    { kind: "note", leadId: L.anna }, { kind: "note", leadId: L.ben }, { kind: "stage", leadId: L.stage }, { kind: "stage", leadId: L.stage2 },
    { kind: "draft_message", leadId: L.anna }, { kind: "follow_up" },
  ]);
  await turn(T, rep2, [
    { kind: "customer_note", contactId: C.carl }, { kind: "assign", leadId: L.win }, { kind: "quote_build", leadId: L.quote },
    { kind: "quote_pdf", contactId: C.hal }, { kind: "meeting", leadId: L.meet },
  ]);
  await turn(T2, t2owner, [{ kind: "note", leadId: L.own2 }]);
  await turn(T2, t2rep, [{ kind: "note", leadId: L.rep2 }, { kind: "block_time" }]);
}

/** A Confirm's audit event as runAssistantAction writes it now (or, without `kind`, as it did before), at the window's start. */
function confirmEvent(tenantId: string, who: { id: string; name: string }, what: string, on: { leadId?: string; contactId?: string }, kind?: string, eventType = "assistant.action_confirmed") {
  return basePrisma.auditEvent.create({
    data: {
      createdAt: t0, tenantId, actorUserId: who.id, actorName: who.name, actorType: "user", eventType,
      entityType: on.leadId ? "Lead" : on.contactId ? "Contact" : null, entityId: on.leadId ?? on.contactId ?? null,
      summary: eventType === "assistant.action_confirmed" ? `Confirmed the assistant's proposal: ${what}` : what,
      ...(kind ? { metadata: { kind } } : {}),
    },
  });
}

async function cleanup() {
  const users = USERS.map((u) => u.id);
  const leads = Object.values(L);
  const contacts = Object.values(C);
  await basePrisma.communication.deleteMany({ where: { OR: [{ contactId: { in: contacts } }, { leadId: { in: leads } }, { userId: { in: users } }] } });
  await basePrisma.quote.deleteMany({ where: { id: QUOTE } });
  await basePrisma.activity.deleteMany({ where: { leadId: { in: leads } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: { in: contacts } }, { leadId: { in: leads } }, { userId: { in: users } }] } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.lead.deleteMany({ where: { id: { in: leads } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: contacts } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" IN (${S.one}, ${S.two}, ${S.three}, ${S.t2})`;
  await basePrisma.$executeRaw`DELETE FROM "SalesPipeline" WHERE "id" IN (${PIPE.a}, ${PIPE.b})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${rep2.id}, ${t2owner.id}, ${t2rep.id})`;
  await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE2}`;
  await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE2}`;
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${rep2.id}, ${boss.id}, ${boss2.id}, ${t2owner.id}, ${t2rep.id})`;
  await basePrisma.tenant.deleteMany({ where: { id: { in: [T, T2] } } });
  await basePrisma.user.deleteMany({ where: { id: { in: users } } });
}

const families = (summary: Awaited<ReturnType<typeof assistantOutcomes>>) =>
  Object.fromEntries((summary?.families ?? []).map((f) => [f.key, [f.suggested, f.confirmed, f.after.happened, f.after.judged, f.after.pending]]));
const people = (summary: Awaited<ReturnType<typeof assistantOutcomes>>) =>
  (summary?.people ?? []).map((p) => [p.userId, p.suggested, p.confirmed, p.replied.happened, p.replied.judged, p.replied.pending]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();
  const [repSession, rep2Session, bossInT, bossInT2, ownerSession, t2repSession] = await Promise.all([
    sessionFor(rep, T), sessionFor(rep2, T), sessionFor(boss, T), sessionFor(boss2, T2), sessionFor(t2owner, T2), sessionFor(t2rep, T2),
  ]);
  const confirmAs = (session: ActingSession, card: ActionCard) => runAsSession(session, () => inT(() => runAssistantAction(card)));

  console.log("\nThe real Confirm records the card's kind — and nothing more on the customer's timeline");
  {
    const note = (leadId: string, label: string): ActionCard => ({ id: `a0-${leadId}`, kind: "note", leadId, leadLabel: label, title: `Add a note to ${label}`, text: "Wants it in black." });
    const stage = (leadId: string): ActionCard => ({ id: `a0-${leadId}`, kind: "stage", leadId, leadLabel: "Deal", title: "Move to the next stage", stageId: S.two, fromStageId: S.one });
    const results = [
      await confirmAs(repSession, note(L.anna, "Anna")),
      await confirmAs(repSession, note(L.ben, "Ben")),
      await confirmAs(rep2Session, { id: `a0-${C.carl}`, kind: "customer_note", contactId: C.carl, leadId: null, leadLabel: "Carl", title: "Note on Carl", text: "Prefers email." }),
      await confirmAs(repSession, stage(L.stage)),
      await confirmAs(repSession, stage(L.stage2)),
    ];
    check("five real Confirms go through", results.every((r) => r.ok), JSON.stringify(results));
    const events = await basePrisma.auditEvent.findMany({
      where: { eventType: "assistant.action_confirmed", entityId: { in: [L.anna, L.ben, C.carl, L.stage, L.stage2] } },
      select: { tenantId: true, entityId: true, metadata: true },
    });
    const kindOf = (entityId: string) => events.filter((e) => e.entityId === entityId).map((e) => (e.metadata as { kind?: string } | null)?.kind);
    check("each audit event carries its card's kind, in this workspace",
      events.length === 5 && events.every((e) => e.tenantId === T) && same(kindOf(L.anna), ["note"]) && same(kindOf(C.carl), ["customer_note"]) && same(kindOf(L.stage), ["stage"]),
      JSON.stringify(events));
    const timeline = await basePrisma.auditLog.findMany({ where: { leadId: L.anna, action: "assistant.action_confirmed" }, select: { summary: true } });
    check("the customer's timeline line is exactly as before", same(timeline.map((t) => t.summary), ["Confirmed the assistant's proposal: add a note"]), JSON.stringify(timeline));
    // After its Confirm, the deal moves on again — through the real board action.
    const moved = await runAsSession(repSession, () => inT(() => moveLead(L.stage, S.three)));
    check("a later real stage move (to a later stage)", moved.ok, JSON.stringify(moved));
  }

  console.log("\nThe rest, as runAssistantAction and the CRM write them");
  {
    await confirmEvent(T, rep, "Sent a WhatsApp the assistant drafted, after reviewing it", { leadId: L.anna }, undefined, "assistant.draft_sent");
    await confirmEvent(T, rep2, `give the lead to ${rep.name}`, { leadId: L.win }, "assign");
    await confirmEvent(T, rep2, "create draft quote Q-1", { leadId: L.quote }, "quote_build");
    await confirmEvent(T, rep2, "send me the PDF of quote Q-2", { contactId: C.hal }, "quote_pdf");
    await confirmEvent(T, rep2, "book a meeting", { leadId: L.meet }); // from before the kind was recorded: read from its words
    await confirmEvent(T, { id: GONE, name: "Former" }, "block time on their own calendar", {}, "block_time");
    // What happened after.
    await basePrisma.communication.createMany({
      data: [
        { tenantId: T, contactId: C.anna, userId: rep.id, type: "whatsapp", direction: "inbound", body: "Yes please", occurredAt: at(1) },
        { tenantId: T, contactId: C.ben, leadId: L.ben, userId: rep.id, type: "email", direction: "inbound", body: "Sorry for the delay", occurredAt: at(4) },
        { tenantId: T, contactId: C.carl, userId: rep2.id, type: "call", direction: "inbound", body: "Called back", occurredAt: at(2) },
        // An internal note is never the customer replying.
        { tenantId: T, contactId: C.jo, leadId: L.meet, userId: rep2.id, type: "note", direction: "inbound", body: "Note to self", occurredAt: at(1) },
      ],
    });
    await basePrisma.lead.update({ where: { id: L.win }, data: { status: "won" } }); // the trigger dates the win
    await basePrisma.quote.create({ data: { id: QUOTE, number: 800_000 + Math.floor(Math.random() * 99_000), tenantId: T, status: "accepted", contactId: C.ivy, leadId: L.quote, createdById: rep2.id, signedAt: at(2) } });
    await basePrisma.auditEvent.create({ data: { createdAt: at(0.5), tenantId: T, actorName: "Hal", actorType: "customer", eventType: "quote.accepted", entityType: "Lead", entityId: L.hal, summary: "Quote Q-2 accepted" } });
    const won = await basePrisma.lead.findUnique({ where: { id: L.win }, select: { wonAt: true } });
    check("the win is dated by the database", won?.wonAt instanceof Date);
    // Workspace 2.
    await confirmEvent(T2, t2owner, "add a note", { leadId: L.own2 }, "note");
    await confirmEvent(T2, t2rep, "add a note", { leadId: L.rep2 }, "note");
    await confirmEvent(T2, t2rep, "block time on their own calendar", {}, "block_time");
    await basePrisma.communication.createMany({ data: [{ tenantId: T2, contactId: C.rep2, userId: t2rep.id, type: "whatsapp", direction: "inbound", body: "Thanks", occurredAt: at(1) }] });
  }

  const outcomes = (session: ActingSession, viewer: PermissionUser, tenantId: string, now: Date) =>
    runAsSession(session, () => runInTenantScope({ tenantId, system: false }, async () => {
      const staff = await listActingTenantStaff();
      return assistantOutcomes(tenantId, viewer, new Set(staff.map((s) => s.id)), { days: 15, now });
    }));

  console.log("\nAn owner who sees everything, 15 days on");
  {
    const result = await outcomes(bossInT, boss, T, at(15));
    check("counted from the first answer that recorded its cards", result?.since.getTime() === t0.getTime(), String(result?.since));
    const expected = {
      follow_ups: [1, 0, 0, 0, 0],
      messages: [1, 1, 1, 1, 0], // the reply came a day after the message was sent
      notes: [3, 3, 2, 3, 0], // Anna and Carl replied in time; Ben after four days
      stage: [3, 3, 2, 3, 0], // moved on again, and won; the other only moved by its own Confirm
      quotes: [2, 2, 2, 2, 0], // signed; accepted (on Hal's deal, for a card on Hal)
      meetings: [1, 1, 0, 1, 0], // an older entry, read from its words; a note is not a reply
      other: [0, 1, 0, 0, 0],
    };
    check("by kind: suggested, confirmed, and what happened after", same(families(result), expected), JSON.stringify(families(result)));
    check("by person: the busier first, anyone no longer in the team last", same(people(result), [
      [rep.id, 6, 5, 2, 3, 0],
      [rep2.id, 5, 5, 1, 2, 0],
      [null, 0, 1, 0, 0, 0],
    ]), JSON.stringify(people(result)));
    check("nothing of workspace 2 is in it", !JSON.stringify(result).includes(t2owner.id) && !JSON.stringify(result).includes(t2rep.id));
    const early = await outcomes(bossInT, boss, T, at(2));
    check("two days on, nothing is judged yet — too recent to tell", same(families(early).notes, [3, 3, 0, 0, 3]) && same(families(early).quotes, [2, 2, 0, 0, 2]), JSON.stringify(families(early)));
  }

  console.log("\nWorkspace 2: an owner whose role sees only their own deals");
  {
    check("they can open the page", await runAsSession(ownerSession, () => inT2(() => isTenantOwner())));
    check("…their colleague cannot", !(await runAsSession(t2repSession, () => inT2(() => isTenantOwner()))));
    check("…nor can a rep in the first workspace", !(await runAsSession(repSession, () => inT(() => isTenantOwner()))));
    const mine = await outcomes(ownerSession, t2owner, T2, at(15));
    check("counted only on their own deal (and cards on no record)", same(families(mine), {
      follow_ups: [0, 0, 0, 0, 0], messages: [0, 0, 0, 0, 0], notes: [1, 1, 0, 1, 0], stage: [0, 0, 0, 0, 0],
      quotes: [0, 0, 0, 0, 0], meetings: [0, 0, 0, 0, 0], other: [1, 1, 0, 0, 0],
    }), JSON.stringify(families(mine)));
    const byId = (rows: ReturnType<typeof people>) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    check("…per person likewise: their colleague's note is not counted, their calendar block is",
      same(byId(people(mine)), byId([[t2owner.id, 1, 1, 0, 1, 0], [t2rep.id, 1, 1, 0, 0, 0]])), JSON.stringify(people(mine)));
    const all = await outcomes(bossInT2, boss2, T2, at(15));
    check("someone who sees every deal there gets both", same(families(all).notes, [2, 2, 1, 2, 0]) && same(families(all).other, [1, 1, 0, 0, 0]), JSON.stringify(families(all)));
    check("…and nothing of the first workspace", !JSON.stringify(all).includes(rep.id) && !JSON.stringify(all).includes(rep2.id) && families(all).quotes[1] === 0);
  }

  console.log("\nWhat is kept of an offered card");
  {
    const turn = await basePrisma.assistantTurn.findFirst({ where: { tenantId: T, userId: rep2.id }, select: { proposed: true } });
    check("ids and kinds only", same(turn?.proposed, [
      { kind: "customer_note", contactId: C.carl }, { kind: "assign", leadId: L.win }, { kind: "quote_build", leadId: L.quote },
      { kind: "quote_pdf", contactId: C.hal }, { kind: "meeting", leadId: L.meet },
    ]), JSON.stringify(turn));
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
