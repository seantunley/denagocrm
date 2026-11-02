/**
 * Asks the "the fourth one" evals (evals/daxFollowsReferences.ts) live: seeds a LOCAL test database, asks each
 * scenario's turns in order through askCrm (the real research + answer loop, so the earlier turns and their listed
 * records are read back exactly as in the CRM), scores them, and removes everything it made.
 *
 * NEEDS A LIVE MODEL: the workspace on that database must have its AI connection set up (Settings → AI). Without
 * one it stops with exit code 2. Never anything but a *_test database with NODE_ENV=test (the local sandbox
 * recipe; never the hosted dev database, which holds live mail/WhatsApp credentials).
 *
 *   NODE_ENV=test DATABASE_URL=postgresql://…/denagocrm_x_test \
 *     npx tsx --tsconfig tsconfig.harness.json evals/runFollowsReferencesEval.ts
 *
 * Exit 0: mean score ≥ 70. Exit 1: below. Exit 2: no model connected.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { isCodexConnected } from "../src/lib/codex";
import { askCrm } from "../src/lib/crmAssistant";
import { splitListed } from "../src/lib/assistantListedRules";
import type { PermissionUser } from "../src/lib/permissions";
import { FOLLOW_SCENARIOS, followReport, scoreFollow, type FollowAction, type FollowTurn } from "./daxFollowsReferences";

const SFX = Math.random().toString(36).slice(2, 8);
const T = DEFAULT_TENANT_ID;
const member = (id: string, name: string): PermissionUser => ({ id: `eval-${id}-${SFX}`, name, email: `eval-${id}-${SFX}@example.invalid`, role: "member" });
const rep = member("rep", "Eval Rep");
const donovan = member("donovan", "Donovan Eval");
const manager = member("manager", "Eval Manager");
const REP_ROLE = `eval-rep-role-${SFX}`;
const MANAGER_ROLE = `eval-manager-role-${SFX}`;
const STAGE = `eval-stage-${SFX}`;
const inScope = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
let quoteNo = 800_000_000 + Math.floor(Math.random() * 90_000_000);

function guardEnvironment() {
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

/** Five deals for the rep (Anna with two quotes, newest), two for Donovan; every quote sent and unsigned. */
async function seed() {
  for (const u of [rep, donovan, manager]) await basePrisma.user.create({ data: { id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" } });
  const roles: [string, string[], PermissionUser[]][] = [
    [REP_ROLE, ["leads.view_owned", "contacts.view_owned", "quotes.view_owned", "activities.view"], [rep, donovan]],
    [MANAGER_ROLE, ["leads.view_all", "contacts.view_all", "quotes.view_all", "activities.view"], [manager]],
  ];
  for (const [role, keys, users] of roles) {
    await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "tenantId", "name", "description", "system", "createdAt", "updatedAt") VALUES (${role}, ${T}, ${`${role}`}, 'eval', false, now(), now())`;
    for (const key of keys) await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${role}, ${key}, ${T})`;
    for (const u of users) await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES (gen_random_uuid()::text, ${u.id}, ${role}, ${T})`;
  }
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Eval ${SFX}`}, 900005, '#64748b', 'pipeline_default_retail', 10, false)`;
  const deals: [string, PermissionUser, number, number][] = [
    ["Eli", rep, 21_000_000, 1], ["Dev", rep, 17_500_000, 1], ["Cara", rep, 26_000_000, 1], ["Ben", rep, 19_000_000, 1], ["Anna", rep, 23_500_000, 2],
    ["Pieter", donovan, 31_000_000, 1], ["Sipho", donovan, 15_000_000, 1],
  ];
  let minute = 0;
  for (const [first, owner, cents, quotes] of deals) {
    const contact = await basePrisma.contact.create({ data: { tenantId: T, firstName: first, lastName: `Voorbeeld${SFX}`, ownerId: owner.id, createdById: owner.id }, select: { id: true } });
    const lead = await basePrisma.lead.create({ data: { tenantId: T, title: "Rover XL", name: `${first} Voorbeeld${SFX}`, stageId: STAGE, contactId: contact.id, assignedToId: owner.id, createdById: owner.id, valueCents: cents }, select: { id: true } });
    for (let q = 0; q < quotes; q++) {
      await basePrisma.quote.create({ data: {
        tenantId: T, number: quoteNo++, status: "sent", contactId: contact.id, leadId: lead.id, createdById: owner.id, createdAt: new Date(Date.now() - 86_400_000 + ++minute * 60_000),
        items: { create: [{ tenantId: T, description: "Denago EV Rover XL", qty: 1, unitPriceCents: cents, costCents: Math.round(cents / 2), colorPreference: q ? "Black" : "White" }] },
      } });
    }
  }
}

async function cleanup() {
  const users = [rep.id, donovan.id, manager.id];
  const leads = await basePrisma.lead.findMany({ where: { tenantId: T, stageId: STAGE }, select: { id: true, contactId: true } });
  const leadIds = leads.map((l) => l.id);
  await basePrisma.assistantRun.deleteMany({ where: { tenantId: T, userId: { in: users } } });
  await basePrisma.assistantTurn.deleteMany({ where: { tenantId: T, userId: { in: users } } });
  await basePrisma.activity.deleteMany({ where: { tenantId: T, leadId: { in: leadIds } } });
  await basePrisma.quoteItem.deleteMany({ where: { tenantId: T, quote: { leadId: { in: leadIds } } } });
  await basePrisma.quote.deleteMany({ where: { tenantId: T, leadId: { in: leadIds } } });
  await basePrisma.lead.deleteMany({ where: { tenantId: T, id: { in: leadIds } } });
  await basePrisma.contact.deleteMany({ where: { tenantId: T, id: { in: leads.flatMap((l) => (l.contactId ? [l.contactId] : [])) } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "tenantId" = ${T} AND "id" = ${STAGE}`;
  for (const role of [REP_ROLE, MANAGER_ROLE]) {
    await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "tenantId" = ${T} AND "roleId" = ${role}`;
    await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "tenantId" = ${T} AND "roleId" = ${role}`;
    await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "tenantId" = ${T} AND "id" = ${role}`;
  }
  await basePrisma.user.deleteMany({ where: { id: { in: users } } });
}

/** The restricted-rep case: the second record the last answer listed goes to Donovan before the next question. */
async function reassignSecond(turnId: string | undefined) {
  const turn = turnId ? await basePrisma.assistantTurn.findFirst({ where: { tenantId: T, id: turnId }, select: { state: true } }) : null;
  const second = splitListed(turn?.state).listed[1];
  if (!second) return;
  const leadId = second.kind === "lead" ? second.id : second.kind === "quote" ? (await basePrisma.quote.findFirst({ where: { tenantId: T, id: second.id }, select: { leadId: true } }))?.leadId : null;
  if (leadId) await basePrisma.lead.updateMany({ where: { tenantId: T, id: leadId }, data: { assignedToId: donovan.id } });
}

async function main(): Promise<number> {
  guardEnvironment();
  await seed();
  __setTenantEnforcingForTests(true);
  if (!(await inScope(() => isCodexConnected()))) {
    console.log("NEEDS A LIVE MODEL: this database's workspace has no AI connection, so the scenarios were not asked.");
    return 2;
  }
  const scores = [];
  for (const scenario of FOLLOW_SCENARIOS) {
    const asker = scenario.asker === "rep" ? rep : manager;
    await basePrisma.assistantTurn.deleteMany({ where: { tenantId: T, userId: asker.id } });
    const turns: FollowTurn[] = [];
    let lastTurnId: string | undefined;
    for (const [i, question] of scenario.turns.entries()) {
      if (i === scenario.turns.length - 1 && scenario.between === "reassign-second") await reassignSecond(lastTurnId);
      const result = await inScope(() => askCrm(asker, question, null, { source: "chat" }));
      lastTurnId = result.ok ? result.turnId : undefined;
      const saved = lastTurnId ? await basePrisma.assistantTurn.findFirst({ where: { tenantId: T, id: lastTurnId }, select: { state: true } }) : null;
      turns.push({
        question,
        answer: result.ok ? result.answer : `(failed: ${result.error})`,
        actions: result.ok ? (result.actions as unknown as FollowAction[]) : [],
        listed: splitListed(saved?.state).listed.map((r) => r.label),
      });
    }
    const score = scoreFollow(scenario, turns);
    scores.push(score);
    console.log(`\n${scenario.id}: ${score.score}`);
    turns.forEach((t, i) => console.log(`  turn ${i + 1}: ${t.question}\n    ${t.answer.replace(/\n/g, "\n    ")}\n    listed: ${t.listed.join(" | ") || "—"}\n    actions: ${t.actions.map((a) => `${a.kind} on ${a.leadLabel ?? "?"}`).join(", ") || "—"}`));
  }
  console.log(`\n${followReport(scores)}`);
  return scores.reduce((n, s) => n + s.score, 0) / (scores.length || 1) >= 70 ? 0 : 1;
}

main()
  .then(async (code) => {
    __setTenantEnforcingForTests(null);
    await cleanup();
    await basePrisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.name : "error", error instanceof Error ? error.message : "");
    __setTenantEnforcingForTests(null);
    await cleanup().catch(() => undefined);
    await basePrisma.$disconnect();
    process.exit(1);
  });
