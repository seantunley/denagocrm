/**
 * REAL-DATABASE proof of what DAX's `why` lookup (assistantWhyLookup.ts) gives
 * whom: "why did Anna's deal move to Lost?", "why did she get that email?",
 * "why did the bot hand her over?".
 *
 * A source test shows the guards are written; only real rows in two real
 * workspaces show who they let through:
 *  - the salesperson whose deal it is: the stage move with WHO made it and the
 *    stage names before → after, the automatic assignment, the email a journey
 *    sent (bounced), the customer's message — but no journey runs (they don't
 *    manage journeys) and no chatbot state (no inbox access);
 *  - another salesperson in the same workspace: nothing, by id or by name;
 *  - a manager with every permission: journey runs and why one stopped, a
 *    journey that did not enrol and why — and the chatbot's handoff reason only
 *    once Automation is switched on; journeys gone once Marketing is off;
 *  - the OTHER workspace: nothing of A's by id or by name, and A nothing of B's.
 * And that it writes nothing.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates. The assistant's model is never called.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { whyLookup } from "../src/lib/assistantWhyLookup";
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

/** A record id shaped like the CRM's own (cuid), so the lookup takes it as an id. */
const cid = () => `c${crypto.randomBytes(12).toString("hex")}`;
type Why = {
  note?: string;
  record?: { stage?: string; lostReason?: string; assignedTo?: string };
  events?: { what: string; cause: string; changed?: string[]; notDelivered?: unknown; steps?: string[]; stoppedBecause?: string }[];
  chatbot?: { handoffReason?: string; nowHeldBy?: string }[];
  notes?: string[];
};

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`why${SFX}`);
  const { a, b } = fixture;
  const ids = { lostStage: cid(), contact: cid(), lead: cid(), leadB: cid(), conversation: cid(), thread: cid(), dmThread: cid(), run: cid(), step: cid(), event: cid(), session: cid() };
  const user = (name: string): PermissionUser => ({ id: crypto.randomUUID(), name, email: `${name.toLowerCase().replace(/\W/g, "")}.${SFX}@harness.invalid`, role: "member" });
  const repOwn = user("Rep Own");
  const repOther = user("Rep Other");
  const managerA: PermissionUser = { id: a.memberUserId, name: "Harness A member", email: "", role: "member" };
  const managerB: PermissionUser = { id: b.memberUserId, name: "Harness B member", email: "", role: "member" };
  // The inbox shows a thread with nobody linked only to someone unrestricted (canAccessConversation).
  const ownerA: PermissionUser = { id: a.ownerUserId, name: "Harness A owner", email: "", role: "owner" };
  const ownerB: PermissionUser = { id: b.ownerUserId, name: "Harness B owner", email: "", role: "owner" };
  const ROLE = crypto.randomUUID();
  const anna = `Anna Why${SFX}`;
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 8, minutes));

  // Two salespeople in A who see only their own deals, and no journeys or inbox.
  for (const u of [repOwn, repOther]) {
    await basePrisma.$executeRaw`INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion") VALUES (${u.id}, ${u.name}, ${u.email}, 'x', 'member', 0)`;
    await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES (${crypto.randomUUID()}, ${a.tenantId}, ${u.id})`;
  }
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt") VALUES (${ROLE}, ${a.tenantId}, ${`Why rep ${SFX}`}, 'test', false, now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned", "quotes.view_owned"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES (${ROLE}, ${key}, ${a.tenantId})`;
  }
  for (const u of [repOwn, repOther]) {
    await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES (${crypto.randomUUID()}, ${u.id}, ${ROLE}, ${a.tenantId})`;
  }

  // Anna's deal in A: moved to Lost by the manager, auto-assigned by lead routing.
  await basePrisma.$executeRaw`INSERT INTO "PipelineStage" ("id","tenantId","name","order","color","pipelineId","defaultProbability","isClosed") VALUES (${ids.lostStage}, ${a.tenantId}, 'Lost stage', 9, '#64748b', ${a.rows.pipelineId}, 0, false)`;
  await basePrisma.$executeRaw`INSERT INTO "Contact" ("id","tenantId","firstName","lastName","whatsapp","ownerId","updatedAt") VALUES (${ids.contact}, ${a.tenantId}, 'Anna', ${`Why${SFX}`}, '082 555 0101', ${repOwn.id}, now())`;
  await basePrisma.$executeRaw`
    INSERT INTO "Lead" ("id","tenantId","title","name","status","stageId","pipelineId","contactId","assignedToId","createdById","lostReason","updatedAt")
    VALUES (${ids.lead}, ${a.tenantId}, 'Rover XL', ${anna}, 'lost', ${ids.lostStage}, ${a.rows.pipelineId}, ${ids.contact}, ${repOwn.id}, ${repOwn.id}, 'Went with a competitor', now())`;
  await basePrisma.$executeRaw`
    INSERT INTO "AuditLog" ("id","action","summary","leadId","contactId","userId","userName","tenantId","createdAt") VALUES
      (${cid()}, 'lead.assigned', 'Auto-assigned to Rep Own by lead routing', ${ids.lead}, ${ids.contact}, NULL, 'System', ${a.tenantId}, ${t(0)}),
      (${cid()}, 'lead.stage_changed', 'Moved “Rover XL” to Lost stage', ${ids.lead}, ${ids.contact}, ${a.memberUserId}, 'Harness A member', ${a.tenantId}, ${t(5)})`;
  await basePrisma.$executeRaw`
    INSERT INTO "AuditEvent" ("id","tenantId","actorUserId","actorName","actorType","eventType","entityType","entityId","summary","beforeJson","afterJson","changedFieldsJson","source","createdAt")
    VALUES (${crypto.randomUUID()}, ${a.tenantId}, ${a.memberUserId}, 'Harness A member', 'user', 'lead.stage_changed', 'Lead', ${ids.lead}, 'Moved',
      ${JSON.stringify({ stageId: a.rows.stageId })}::jsonb, ${JSON.stringify({ stageId: ids.lostStage })}::jsonb, '["stageId"]'::jsonb, 'test', ${t(5)})`;
  await basePrisma.$executeRaw`
    INSERT INTO "Communication" ("id","tenantId","type","direction","subject","body","leadId","contactId","userId","occurredAt","messageId","bouncedAt","bounceReason") VALUES
      (${cid()}, ${a.tenantId}, 'email', 'outbound', 'We miss you', ${"[Journey: Win-back]\n\nHi Anna"}, ${ids.lead}, ${ids.contact}, ${repOwn.id}, ${t(10)}, '<m@x>', ${t(11)}, 'mailbox full'),
      (${cid()}, ${a.tenantId}, 'whatsapp', 'inbound', NULL, 'Can I get finance?', ${ids.lead}, ${ids.contact}, ${a.ownerUserId}, ${t(20)}, NULL, NULL, NULL),
      (${cid()}, ${a.tenantId}, 'whatsapp', 'outbound', '🤖 Assistant → handoff', 'Let me get the team', ${ids.lead}, ${ids.contact}, ${a.ownerUserId}, ${t(21)}, NULL, NULL, NULL)`;
  // A journey run that stopped, and a journey that did not enrol.
  await basePrisma.$executeRaw`
    INSERT INTO "JourneyRun" ("id","tenantId","journeyId","journeyVersionId","status","entityType","entityId","leadId","context","idempotencyKey","lastError","createdAt","updatedAt")
    VALUES (${ids.run}, ${a.tenantId}, ${a.rows.journeyId}, ${a.rows.journeyVersionId}, 'failed', 'lead', ${ids.lead}, ${ids.lead}, '{}'::jsonb, ${`why-${ids.run}`}, 'no marketing consent', ${t(9)}, now())`;
  await basePrisma.$executeRaw`INSERT INTO "JourneyStepLog" ("id","tenantId","runId","path","stepId","stepType","status","note","startedAt") VALUES (${ids.step}, ${a.tenantId}, ${ids.run}, 'send', 'send', 'send_sms', 'skipped', 'quiet hours', ${t(12)})`;
  await basePrisma.$executeRaw`
    INSERT INTO "JourneyEvent" ("id","tenantId","type","entityType","entityId","decisions","dedupeKey","status","updatedAt")
    VALUES (${ids.event}, ${a.tenantId}, 'lead_stage_changed', 'lead', ${ids.lead}, ${JSON.stringify([{ journeyName: "Fleet nurture", enrolled: false, reason: "entry conditions not met" }])}::jsonb, ${`why-${ids.event}`}, 'processed', now())`;
  // The chatbot handed her WhatsApp chat over.
  await basePrisma.$executeRaw`INSERT INTO "Conversation" ("id","tenantId","channel","contactId","leadId","updatedAt") VALUES (${ids.conversation}, ${a.tenantId}, 'whatsapp', ${ids.contact}, ${ids.lead}, now())`;
  await basePrisma.$executeRaw`
    INSERT INTO "BotSession" ("id","tenantId","channel","key","vars","status","ownership","updatedAt","expiresAt")
    VALUES (${ids.session}, ${a.tenantId}, 'whatsapp', '27825550101', ${JSON.stringify({ __handoff_reason: "asked about finance" })}, 'paused', 'ai_handoff', now(), now() + interval '1 day')`;
  // Inbox threads in A with NO customer or deal linked. A post's comment thread
  // (the inbox shows it to anyone with inbox access in the workspace), and a DM
  // thread the bot answered (listed in no inbox — canAccessConversation refuses
  // every unlinked thread).
  await basePrisma.$executeRaw`INSERT INTO "Conversation" ("id","tenantId","channel","externalRef","updatedAt") VALUES (${ids.thread}, ${a.tenantId}, 'comment', ${`facebook:post-${SFX}`}, now())`;
  await basePrisma.$executeRaw`INSERT INTO "Conversation" ("id","tenantId","channel","updatedAt") VALUES (${ids.dmThread}, ${a.tenantId}, 'whatsapp', now())`;
  await basePrisma.$executeRaw`
    INSERT INTO "Communication" ("id","tenantId","type","direction","subject","body","conversationId","userId","occurredAt") VALUES
      (${cid()}, ${a.tenantId}, 'comment', 'inbound', NULL, ${`Do you deliver to Paarl? ${SFX}`}, ${ids.thread}, ${a.ownerUserId}, ${t(30)}),
      (${cid()}, ${a.tenantId}, 'comment', 'outbound', NULL, 'Yes — sent you a DM', ${ids.thread}, ${a.memberUserId}, ${t(31)}),
      (${cid()}, ${a.tenantId}, 'whatsapp', 'outbound', '🤖 Assistant → handoff', ${"Let me get the team\n\n[to +27825550199]"}, ${ids.dmThread}, ${a.ownerUserId}, ${t(32)})`;
  // B's own deal, with its own history.
  await basePrisma.$executeRaw`
    INSERT INTO "Lead" ("id","tenantId","title","name","status","stageId","pipelineId","assignedToId","createdById","updatedAt")
    VALUES (${ids.leadB}, ${b.tenantId}, 'B cart', ${`Bea Why${SFX}`}, 'open', ${b.rows.stageId}, ${b.rows.pipelineId}, ${b.memberUserId}, ${b.memberUserId}, now())`;
  await basePrisma.$executeRaw`INSERT INTO "AuditLog" ("id","action","summary","leadId","userId","userName","tenantId") VALUES (${cid()}, 'lead.updated', ${`B secret ${SFX}`}, ${ids.leadB}, ${b.memberUserId}, 'B member', ${b.tenantId})`;

  const setModules = (modules: string) => basePrisma.$executeRaw`UPDATE "Tenant" SET "modules" = ${modules} WHERE "id" = ${a.tenantId}`;
  const ask = async (tenantId: string, u: PermissionUser, needle: string) =>
    (await runInTenantScope({ tenantId, system: false }, () => whyLookup(u, needle))).data[0] as Why;
  const counts = async () => (await basePrisma.$queryRaw<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "AuditEvent") + (SELECT count(*) FROM "Communication") + (SELECT count(*) FROM "JourneyRun"))::int AS n`)[0].n;

  try {
    __setTenantEnforcingForTests(true);
    const before = await counts();

    console.log("\nThe salesperson whose deal it is");
    const own = await ask(a.tenantId, repOwn, ids.lead);
    const what = (w: Why, re: RegExp) => w.events?.find((e) => re.test(e.what));
    const moved = what(own, /Moved/);
    check("the stage move is there, with the person who made it", moved?.cause === "person: Harness A member", JSON.stringify(moved));
    check("…and the stages before → after in words", moved?.changed?.[0] === "stageId: A stage → Lost stage", JSON.stringify(moved?.changed));
    check("the automatic assignment says it was lead routing, no person", what(own, /Auto-assigned/)?.cause === "automatic: System");
    const email = what(own, /Sent email/);
    check("the email names the journey that sent it, and that it bounced", email?.cause === 'journey "Win-back"' && !!email?.notDelivered, JSON.stringify(email));
    check("the customer's own message is hers", /^the customer/.test(what(own, /Received whatsapp/)?.cause ?? ""));
    check("the bot's handoff reply says it handed over", /handed the chat over/.test(what(own, /Sent whatsapp/)?.cause ?? ""));
    check("the deal's lost reason is on the record", own.record?.lostReason === "Went with a competitor" && own.record?.stage === "Lost stage");
    check("no journey runs for someone who doesn't manage journeys — and it says so", !what(own, /Enrolled in journey/) && !!own.notes?.some((n) => /manage journeys/.test(n)), JSON.stringify(own.notes));
    check("no chatbot state without inbox access", !own.chatbot);
    const byName = await ask(a.tenantId, repOwn, anna);
    check("found by name too", what(byName, /Moved/)?.cause === "person: Harness A member");

    console.log("\nAnother salesperson in the same workspace");
    check("not by id", /No lead, customer, quote or conversation you can open/.test((await ask(a.tenantId, repOther, ids.lead)).note ?? ""));
    check("not by name", !!(await ask(a.tenantId, repOther, anna)).note);
    check("not through the conversation", !!(await ask(a.tenantId, repOther, ids.conversation)).note);

    console.log("\nA manager — journeys with Marketing on, the bot only with Automation on");
    const mgr = await ask(a.tenantId, managerA, ids.lead);
    const run = what(mgr, /Enrolled in journey/);
    check("the journey run, its skipped step and why it stopped", run?.stoppedBecause === "no marketing consent" && !!run?.steps?.some((s) => /send_sms skipped — quiet hours/.test(s)), JSON.stringify(run));
    check("the journey that did not enrol, and why", what(mgr, /"Fleet nurture" did not enrol/)?.cause === "journey rules: entry conditions not met");
    check("Automation is off in this workspace: no chatbot state", !mgr.chatbot);
    await setModules("inbox,marketing,automotive,workshop,reports,automation");
    const withBot = await ask(a.tenantId, managerA, ids.lead);
    check("Automation on: the handoff and its recorded reason", withBot.chatbot?.[0]?.handoffReason === "asked about finance", JSON.stringify(withBot.chatbot));
    const viaConversation = await ask(a.tenantId, managerA, ids.conversation);
    check("…also asked from the inbox conversation", viaConversation.chatbot?.[0]?.handoffReason === "asked about finance");
    await setModules("inbox,automotive,workshop,reports,automation");
    const noMarketing = await ask(a.tenantId, managerA, ids.lead);
    check("Marketing off: no journey runs, no enrolment decisions, no journey note", !what(noMarketing, /journey "|Enrolled/) && !noMarketing.notes, JSON.stringify(noMarketing.notes));
    await setModules("inbox,marketing,automotive,workshop,reports");

    console.log("\nAn inbox thread with no customer or deal linked");
    const thread = await ask(a.tenantId, managerA, ids.thread);
    check("someone with inbox access gets the comment thread's history", thread.events?.length === 2, JSON.stringify(thread));
    check("…the customer's comment, as theirs", /^the customer/.test(what(thread, /Received comment/)?.cause ?? ""));
    check("…and the reply, under the account it was sent from", /Harness A member/.test(what(thread, /Sent comment/)?.cause ?? ""), JSON.stringify(what(thread, /Sent comment/)));
    check("only the thread's own messages — nothing of Anna's deal", !what(thread, /Moved|Sent email|whatsapp/), JSON.stringify(thread.events?.map((e) => e.what)));
    check("the owner too", (await ask(a.tenantId, ownerA, ids.thread)).events?.length === 2);
    check("no inbox access: nothing", !!(await ask(a.tenantId, repOwn, ids.thread)).note);
    check("the other workspace's owner: nothing", !!(await ask(b.tenantId, ownerB, ids.thread)).note);
    check("…nor its member", !!(await ask(b.tenantId, managerB, ids.thread)).note);
    // The inbox lists a DM thread only by its customer or deal, so with neither it is nobody's to read.
    const dm = await ask(a.tenantId, ownerA, ids.dmThread);
    check("a DM thread with nobody linked is listed in no inbox — refused, even to the owner", !!dm.note && !JSON.stringify(dm).includes("27825550199"), JSON.stringify(dm));

    console.log("\nThe other workspace");
    check("B cannot read A's deal by id", !!(await ask(b.tenantId, managerB, ids.lead)).note);
    check("…nor by name", !!(await ask(b.tenantId, managerB, anna)).note);
    check("…nor A's conversation", !!(await ask(b.tenantId, managerB, ids.conversation)).note);
    const aAsksB = await ask(a.tenantId, managerA, ids.leadB);
    check("A cannot read B's deal by id", !!aAsksB.note && !JSON.stringify(aAsksB).includes(`B secret ${SFX}`));
    check("…nor by name", !!(await ask(a.tenantId, managerA, `Bea Why${SFX}`)).note);
    check("B still reads its own", (await ask(b.tenantId, managerB, ids.leadB)).events?.some((e) => e.what === `B secret ${SFX}`) === true);

    check("READ-ONLY: nothing was written", (await counts()) === before);
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.$executeRaw`DELETE FROM "BotSession" WHERE "id" = ${ids.session}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "JourneyEvent" WHERE "id" = ${ids.event}`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Communication" WHERE "conversationId" IN (${ids.thread}, ${ids.dmThread})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Conversation" WHERE "id" IN (${ids.conversation}, ${ids.thread}, ${ids.dmThread})`.catch(() => 0);
    await basePrisma.$executeRaw`DELETE FROM "Communication" WHERE "leadId" IN (${ids.lead}, ${ids.leadB})`.catch(() => 0);
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
