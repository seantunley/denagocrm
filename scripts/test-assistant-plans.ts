/**
 * DAX MULTI-STEP PLANS on a real database (roadmap Phase 3, 2026-10-26).
 *
 *   npm run test:assistant-plans     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * What a source test cannot show, all through the SCOPED client with enforcement on:
 *  - a plan is proposed from real cards (resolveActions): its internal steps kept on the server, the customer
 *    email left out as its own Send card, a module-gated step left out with why;
 *  - one Confirm (the real server action) runs the steps in order through each card's own action — the quote,
 *    its PDF (not sent twice), the reminder; Confirm again runs nothing twice;
 *  - Confirm pressed twice AT ONCE, and a request that died part-way followed by Confirm twice at once:
 *    one quote, one reminder;
 *  - a step refused for want of permission, and a product taken off sale mid-plan: the plan stops there and
 *    says so, nothing later runs, and Retry after the fix carries on without making anything twice;
 *  - a step of a kind with no confirm key that was interrupted is NOT run again;
 *  - somebody else's plan, another workspace's, an expired or a closed plan: nothing runs.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates
 * (except append-only audit events). The model is never called; nobody is contacted.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { parsePlan, type PlanState } from "../src/lib/assistantPlanRules";
import { continuePlan, plansForAskPage, proposePlan, readPlanView, type RunStep } from "../src/lib/assistantPlan";
import { openTasks, setTaskStatus, tasksForAskPage } from "../src/lib/assistantTask";
import { resolveActions } from "../src/lib/crmAssistant";
import { runAssistantAction } from "../src/app/actions/assistant";
import { runAssistantPlan } from "../src/app/actions/assistantPlans";
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

const id = (what: string) => `asst-plan-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const other: PermissionUser = { id: id("other"), name: "Other", email: `${id("other")}@example.invalid`, role: "member" };
// A NON-OWNER whose role can quote but cannot schedule activities.
const limited: PermissionUser = { id: id("limited"), name: "Limited", email: `${id("limited")}@example.invalid`, role: "member" };
const USERS = [rep, other, limited];
const C = { anna: id("c-anna") };
const L = { anna: id("l-anna") };
const P = { rover: id("p-rover") };
const STAGE = id("stage");
const ROLE = id("role");
const OTHER_TENANT = id("tenant");
const PRODUCT = `Plan Rover XL ${SFX}`;
const scoped = <R>(fn: () => Promise<R>, tenantId = T) => runInTenantScope({ tenantId, system: false }, fn);

/** "YYYY-MM-DDT10:00" two days ahead, South African wall-clock — a follow-up time resolveActions accepts. */
const friday = (() => {
  const d = new Date(Date.now() + 2 * 86_400_000 + 2 * 3_600_000);
  return `${d.toISOString().slice(0, 10)}T10:00`;
})();

async function seed() {
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Plan test ${SFX}`, slug: `plan-test-${SFX}` } });
  await basePrisma.user.createMany({ data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })) });
  // The limited role: everything a sales rep has, except scheduling activities.
  await basePrisma.role.create({ data: { id: ROLE, tenantId: T, name: `Plan limited ${SFX}` } });
  await basePrisma.$executeRaw`
    INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
    SELECT ${ROLE}, "permissionKey", ${T} FROM "RolePermission" WHERE "roleId" = 'role_sales_rep' AND "permissionKey" <> 'activities.manage'`;
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${limited.id}, ${ROLE}, ${T})`;
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id}), (${id("tm-limited")}, ${T}, ${limited.id})`;
  // Anna is looked after by BOTH rep and limited (owner rep; the deal shared by assignment below per test).
  await basePrisma.contact.create({ data: { id: C.anna, tenantId: T, firstName: "Anna", lastName: `Plan${SFX}`, email: `anna-${SFX}@example.invalid`, ownerId: rep.id, createdById: rep.id } });
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Plans ${SFX}`}, 900003, '#64748b', 'pipeline_default_retail', 10, false)`;
  await basePrisma.lead.create({ data: { id: L.anna, tenantId: T, title: "Rover XL", name: `Anna Plan${SFX}`, email: `anna-${SFX}@example.invalid`, stageId: STAGE, contactId: C.anna, assignedToId: rep.id, createdById: rep.id } });
  await basePrisma.product.create({
    data: { id: P.rover, tenantId: T, name: PRODUCT, basePriceCents: 23_500_000, colors: { create: [{ tenantId: T, name: "White" }] } },
  });
}

async function sessionFor(user: PermissionUser): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: user.id, name: user.name ?? "", email: user.email ?? "", role: user.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: user.name ?? user.id };
}

async function cleanup() {
  const ids = USERS.map((u) => u.id);
  await basePrisma.assistantTask.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.assistantPendingAction.deleteMany({ where: { userId: { in: ids } } });
  await basePrisma.activity.deleteMany({ where: { OR: [{ leadId: L.anna }, { createdById: { in: ids } }] } });
  const quotes = (await basePrisma.quote.findMany({ where: { createdById: { in: ids } }, select: { id: true } })).map((q) => q.id);
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: quotes } } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: { in: quotes } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: quotes } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: C.anna }, { leadId: L.anna }, { userId: { in: ids } }] } });
  await basePrisma.lead.deleteMany({ where: { id: L.anna } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.productColor.deleteMany({ where: { productId: P.rover } });
  await basePrisma.product.deleteMany({ where: { id: P.rover } });
  await basePrisma.contact.deleteMany({ where: { id: C.anna } });
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id}, ${limited.id})`;
  await basePrisma.role.deleteMany({ where: { id: ROLE } });
  await basePrisma.user.deleteMany({ where: { id: { in: ids } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
}

const quoteStep = { type: "quote_build", contactId: C.anna, lines: [{ productId: P.rover, qty: 1, colour: "White" }] };
const followStep = { type: "follow_up", leadId: L.anna, when: friday, activity: "call", summary: `Call Anna ${SFX}` };
const emailStep = { type: "draft_message", leadId: L.anna, channel: "email", subject: "Your quote", body: "Hi Anna, your quote is attached." };

/** A plan proposed for `user`, as askCrm does it: each step through the real resolveActions. */
async function propose(user: PermissionUser, steps: unknown[], title = `Plan ${SFX}`) {
  const proposal = parsePlan({ title, steps })!;
  const problems: string[] = [];
  const cards = await scoped(() => proposePlan(user, proposal, problems, (ps, pr) => resolveActions(user, ps, pr, null)));
  const plan = cards.find((c): c is Extract<ActionCard, { kind: "plan" }> => c.kind === "plan");
  return { cards, plan, problems, taskId: plan?.plan.taskId ?? "" };
}
const counts = async () => ({
  quotes: await basePrisma.quote.count({ where: { createdById: { in: USERS.map((u) => u.id) }, deletedAt: null } }),
  followUps: await basePrisma.activity.count({ where: { leadId: L.anna, summary: `Call Anna ${SFX}` } }),
});
const stored = async (taskId: string) => (await basePrisma.assistantTask.findUnique({ where: { id: taskId } }))?.details as { plan: PlanState } | undefined;
const real = (): RunStep => (card) => runAssistantAction(card);

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();
  const repSession = await sessionFor(rep);
  const limitedSession = await sessionFor(limited);
  const asRep = <R>(fn: () => Promise<R>) => runAsSession(repSession, () => scoped(fn));

  console.log("\nProposing: one card, the email its own Send");
  let taskId = "";
  {
    const { cards, plan, problems, taskId: tid } = await propose(rep, [quoteStep, { type: "quote_pdf", dependsOn: 1 }, emailStep, followStep]);
    taskId = tid;
    check("one plan card, with the three internal steps in order", plan?.plan.steps.map((s) => s.title.split(" ")[0]).join(",") === "Create,Send,Call", JSON.stringify({ steps: plan?.plan.steps, problems }));
    const sends = cards.filter((c) => c.kind === "draft_message");
    check("the customer email is NOT a step — it comes back as its own Send card", sends.length === 1 && plan?.plan.sends.length === 1 && !plan.plan.steps.some((s) => /Email/.test(s.title)));
    const row = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    check("kept on the server as a job sheet of kind plan, the person's own", row?.kind === "plan" && row.userId === rep.id && row.tenantId === T && row.status === "open");
    const p = await stored(taskId);
    check("the plan's quote belongs to the plan (one plan, one quote)", p?.plan.steps[0].card.kind === "quote_build" && (p.plan.steps[0].card as { taskId?: string }).taskId === taskId);
    check("the PDF step reads the quote from step 1", p?.plan.steps[1].fromStep === 1);
    check("not a job sheet in front of the answer step, nor in the job-sheet list", (await scoped(() => openTasks(rep))).every((t) => t.id !== taskId) && (await scoped(() => tasksForAskPage(rep.id))).every((t) => t.id !== taskId));
    check("…but on the Ask page's plan list, waiting for Confirm", (await scoped(() => plansForAskPage(rep.id))).find((v) => v.taskId === taskId)?.status === "waiting");
    check("nothing has run yet", (await counts()).quotes === 0 && (await counts()).followUps === 0);
  }

  console.log("\nModule-gated and unresolvable steps are left out, and say why");
  {
    await scoped(async () => {
      await basePrisma.appSetting.upsert({ where: { tenantId_key: { tenantId: T, key: "DISABLED_MODULES" } }, update: { value: "automotive" }, create: { tenantId: T, key: "DISABLED_MODULES", value: "automotive" } });
    });
    const gated = await propose(rep, [followStep, { type: "job_card", vehicleId: id("vehicle"), description: "Brakes" }, { type: "note", leadId: L.anna, text: "Plan note" }]);
    await basePrisma.appSetting.deleteMany({ where: { tenantId: T, key: "DISABLED_MODULES" } });
    check("Automotive off: the job card is left out of the plan, and the person is told", gated.plan?.plan.steps.length === 2 && gated.problems.some((p) => /Automotive module/.test(p)), JSON.stringify(gated.problems));
    const lone = await propose(rep, [followStep, { type: "quote_pdf", quote: "Q-999999" }]);
    check("one internal step left is no plan — just its card", !lone.plan && lone.cards.length === 1 && lone.problems.some((p) => /Q-999999/.test(p)), JSON.stringify(lone));
    const orphan = await propose(rep, [{ type: "quote_build", contactId: id("nobody"), lines: [{ productId: P.rover, qty: 1 }] }, { type: "quote_pdf", dependsOn: 1 }, followStep, { type: "note", leadId: L.anna, text: "n" }]);
    check("a step whose source could not be set up is left out with it", orphan.plan?.plan.steps.length === 2 && orphan.problems.some((p) => /depends on \(1\)/.test(p)), JSON.stringify(orphan.problems));
    // A step that waits on the customer message (directly, or through another step) would run on Confirm before
    // anything was sent: it is not in the plan, and the person is told to ask after sending (review of #923).
    const afterEmail = await propose(rep, [quoteStep, emailStep, { ...followStep, dependsOn: 2 }, { type: "note", leadId: L.anna, text: "after the follow-up", dependsOn: 3 }, { type: "note", leadId: L.anna, text: "independent" }]);
    const titles = afterEmail.plan?.plan.steps.map((s) => s.title) ?? [];
    check("a step depending on the customer message — and one depending on THAT — is left out of the plan",
      titles.length === 2 && !titles.some((t) => /Call Anna/.test(t)) && afterEmail.problems.filter((p) => /after you've sent the message/.test(p)).length === 2,
      JSON.stringify({ titles, problems: afterEmail.problems }));
    check("…the message is still its own Send card", afterEmail.cards.filter((c) => c.kind === "draft_message").length === 1 && afterEmail.plan?.plan.sends.length === 1);
    for (const t of [gated.taskId, orphan.taskId, afterEmail.taskId]) if (t) await basePrisma.assistantTask.delete({ where: { id: t } });
  }

  console.log("\nIsolation: somebody else's plan, another workspace");
  {
    const otherSession = await sessionFor(other);
    const forged = await runAsSession(otherSession, () => runAssistantPlan(taskId));
    check("another person in the same workspace confirming this plan's id runs nothing", !forged.ok && forged.plan === null && /no longer there/.test(forged.message) && (await counts()).quotes === 0, JSON.stringify(forged));
    const there = await scoped(() => continuePlan(rep, taskId, real()), OTHER_TENANT);
    check("the same person acting in another workspace runs nothing", !there.ok && there.plan === null && (await counts()).quotes === 0);
  }

  console.log("\nOne Confirm runs it all — then Confirm again runs nothing twice");
  let quoteId = "";
  {
    const result = await runAsSession(repSession, () => runAssistantPlan(taskId));
    const after = await counts();
    check("every step ran: one quote, one reminder", result.ok && result.plan?.status === "done" && after.quotes === 1 && after.followUps === 1, JSON.stringify({ result, after }));
    const row = await basePrisma.assistantTask.findUnique({ where: { id: taskId } });
    quoteId = row?.quoteId ?? "";
    check("the quote is linked to the plan in its own save, and the plan is done", Boolean(quoteId) && row?.status === "done" && row.closedAt !== null);
    const pdfs = await basePrisma.assistantTurn.count({ where: { userId: rep.id, quoteId, source: "quote_pdf" } });
    check("the PDF went once — with the quote, not again by the PDF step", pdfs === 1 && /not sent twice/.test(result.plan?.steps[1].message ?? ""), `${pdfs} ${result.plan?.steps[1].message}`);
    const claims = await basePrisma.assistantPendingAction.findMany({ where: { id: { in: (await stored(taskId))!.plan.steps.map((s) => s.key) } }, select: { completedAt: true, confirmedAt: true } });
    check("each step that ran holds a completed claim — none waiting to be offered anywhere", claims.length === 2 && claims.every((c) => c.completedAt && c.confirmedAt));
    const sent = await basePrisma.communication.count({ where: { contactId: C.anna } });
    check("the customer was not contacted — nothing on their timeline; the email waits on its own Send", sent === 0, String(sent));
    const again = await runAsSession(repSession, () => runAssistantPlan(taskId));
    check("Confirm again: nothing runs twice", again.ok && /nothing was run twice/.test(again.message) && JSON.stringify(await counts()) === JSON.stringify(after), JSON.stringify(again));
  }

  console.log("\nConfirm pressed twice at once");
  {
    const before = await counts();
    const { taskId: twice } = await propose(rep, [quoteStep, followStep]);
    const both = await Promise.all([asRep(() => continuePlan(rep, twice, real())), asRep(() => continuePlan(rep, twice, real()))]);
    const after = await counts();
    check("one quote and one reminder, however the two interleave", after.quotes === before.quotes + 1 && after.followUps === before.followUps + 1, JSON.stringify({ before, after, both: both.map((b) => b.message) }));
    check("…one press ran the plan; the other found it running or already run", both.filter((b) => /already (running|run)/.test(b.message)).length >= 1, JSON.stringify(both.map((b) => b.message)));
    check("…and the plan is done", (await scoped(() => readPlanView(rep, twice)))?.status === "done");
  }

  console.log("\nInterrupted part-way, then Confirm twice at once");
  {
    const before = await counts();
    const { taskId: cut } = await propose(rep, [quoteStep, followStep]);
    // Step 1 runs for real; then the request "dies" before the plan hears: the state that leaves is a claim
    // with no outcome, the step still marked running — and the quote (with its spent key) already made.
    await asRep(() => continuePlan(rep, cut, async (card) => {
      const done = await runAssistantAction(card);
      throw Object.assign(new Error("simulated"), { done });
    }));
    const p = (await stored(cut))!;
    const s1 = p.plan.steps[0];
    const stale = new Date(Date.now() - 11 * 60_000);
    await basePrisma.assistantPendingAction.update({ where: { id: s1.key }, data: { completedAt: null, failedAt: null, confirmedAt: stale } });
    s1.status = "running";
    s1.claimedAt = stale.toISOString();
    delete s1.message;
    await basePrisma.assistantTask.update({ where: { id: cut }, data: { details: p as object } });
    check("the quote was made before the interruption", (await counts()).quotes === before.quotes + 1);
    const shown = (await scoped(() => plansForAskPage(rep.id))).find((v) => v.taskId === cut);
    check("the Ask page shows it INTERRUPTED at step 1, with Retry — not 'running' forever", shown?.status === "interrupted" && shown.canRun && /^Interrupted at step 1/.test(shown.summary), JSON.stringify(shown));
    // A claim that is still fresh is a step still running: nothing else touches it.
    await basePrisma.assistantPendingAction.update({ where: { id: s1.key }, data: { confirmedAt: new Date() } });
    const busy = await asRep(() => continuePlan(rep, cut, real()));
    check("a fresh claim reads as still running — nothing runs", /already running/.test(busy.message) && (await counts()).followUps === before.followUps, busy.message);
    await basePrisma.assistantPendingAction.update({ where: { id: s1.key }, data: { confirmedAt: new Date(Date.now() - 11 * 60_000) } });
    const both = await Promise.all([asRep(() => continuePlan(rep, cut, real())), asRep(() => continuePlan(rep, cut, real()))]);
    const after = await counts();
    check("Retry twice at once after the interruption: still ONE quote, and ONE reminder", after.quotes === before.quotes + 1 && after.followUps === before.followUps + 1, JSON.stringify({ before, after, both: both.map((b) => b.message) }));
    const view = await scoped(() => readPlanView(rep, cut));
    check("…the plan finishes, holding the quote it made the first time", view?.status === "done" && Boolean(view.quoteId));
  }

  console.log("\nA stalled worker finishing AFTER a Retry took its step over cannot overwrite the Retry (review of #923)");
  {
    const before = await counts();
    const { taskId: raced } = await propose(rep, [quoteStep, followStep]);
    // The original worker claims step 1, makes the quote, then stalls before it settles.
    let reached!: () => void;
    let release!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const late = asRep(() => continuePlan(rep, raced, async (card) => {
      const result = await runAssistantAction(card);
      reached();
      await gate;
      return result;
    }));
    await atGate;
    // Eleven minutes on, the claim looks interrupted: a Retry re-claims step 1 and settles it (the quote it finds
    // is the same one — its confirm key), then runs step 2.
    const later = () => new Date(Date.now() + 11 * 60_000);
    const retry = await asRep(() => continuePlan(rep, raced, real(), later));
    const afterRetry = (await stored(raced))!.plan.steps[0];
    check("the Retry took the step over and finished the plan", retry.plan?.status === "done" && /nothing was made twice/.test(afterRetry.message ?? ""), JSON.stringify({ msg: retry.message, step: afterRetry.message }));
    // Now the stalled worker finishes and tries to settle with its own (old) claim.
    release();
    const lateResult = await late;
    const final = (await stored(raced))!.plan;
    check("the late worker's claim matches nothing: its result is discarded and it goes no further", /taken over by a newer Retry/.test(lateResult.message), lateResult.message);
    check("the plan still shows the Retry's result for step 1, not the late worker's", final.steps[0].message === afterRetry.message && final.steps[0].claimedAt === afterRetry.claimedAt && final.steps.every((s) => s.status === "done"), JSON.stringify(final.steps.map((s) => [s.status, s.message])));
    const after = await counts();
    check("…and there is ONE quote and ONE reminder", after.quotes === before.quotes + 1 && after.followUps === before.followUps + 1, JSON.stringify({ before, after }));
    const claim = await basePrisma.assistantPendingAction.findUnique({ where: { id: final.steps[0].key } });
    check("the step's claim is the Retry's, completed", Boolean(claim?.completedAt) && claim!.confirmedAt!.toISOString() === afterRetry.claimedAt);
  }

  console.log("\nAn interrupted step with no confirm key is never run again");
  {
    const before = await counts();
    const { taskId: noted } = await propose(rep, [followStep, { type: "note", leadId: L.anna, text: `Plan note ${SFX}` }]);
    const p = (await stored(noted))!;
    const s1 = p.plan.steps[0];
    await basePrisma.assistantPendingAction.create({ data: { id: s1.key, tenantId: T, userId: rep.id, card: { kind: "plan_step" }, confirmedAt: new Date(Date.now() - 11 * 60_000), expiresAt: new Date(p.plan.expiresAt) } });
    s1.status = "running";
    await basePrisma.assistantTask.update({ where: { id: noted }, data: { details: p as object } });
    const result = await asRep(() => continuePlan(rep, noted, real()));
    check("the follow-up is not tried again — how far it got is unknown", !result.ok && /isn't run again/.test(result.message) && (await counts()).followUps === before.followUps, result.message);
    check("…and the plan shows it, with no Retry", result.plan?.status === "paused" && result.plan.canRun === false && result.plan.steps[1].status === "waiting");
  }

  console.log("\nNo permission for one step (a non-owner whose role can't schedule activities)");
  {
    await basePrisma.lead.update({ where: { id: L.anna }, data: { assignedToId: limited.id } });
    await basePrisma.contact.update({ where: { id: C.anna }, data: { ownerId: limited.id } });
    const before = await counts();
    const { taskId: limitedPlan, plan } = await propose(limited, [quoteStep, followStep]);
    check("the plan is offered to them (both steps resolve)", plan?.plan.steps.length === 2, JSON.stringify(plan));
    const result = await runAsSession(limitedSession, () => runAssistantPlan(limitedPlan));
    const after = await counts();
    check("step 1 ran (the quote), step 2 was refused by the activity action's own check", after.quotes === before.quotes + 1 && after.followUps === before.followUps, JSON.stringify({ result, before, after }));
    check("the plan stops at step 2 and says so — never 'done'", !result.ok && result.plan?.status === "paused" && /step 2/i.test(result.message) && result.plan.steps[1].status !== "done", JSON.stringify(result));
    const again = await runAsSession(limitedSession, () => runAssistantPlan(limitedPlan));
    check("Retry makes no second quote", (await counts()).quotes === after.quotes, again.message);
    await basePrisma.lead.update({ where: { id: L.anna }, data: { assignedToId: rep.id } });
    await basePrisma.contact.update({ where: { id: C.anna }, data: { ownerId: rep.id } });
  }

  console.log("\nStock unavailable mid-plan");
  {
    const before = await counts();
    const { taskId: stock } = await propose(rep, [followStep, quoteStep]);
    await basePrisma.product.update({ where: { id: P.rover }, data: { active: false } });
    const result = await runAsSession(repSession, () => runAssistantPlan(stock));
    let after = await counts();
    check("the reminder ran; the quote step was refused before anything was written", after.followUps === before.followUps + 1 && after.quotes === before.quotes, JSON.stringify({ result, before, after }));
    check("the plan is paused at step 2, with the reason, and offers Retry", result.plan?.status === "paused" && result.plan.canRun && /catalogue changed/i.test(result.plan.summary), JSON.stringify(result.plan));
    const claim = await basePrisma.assistantPendingAction.count({ where: { id: (await stored(stock))!.plan.steps[1].key } });
    check("the refused step's claim is released (nothing was written)", claim === 0);
    await basePrisma.product.update({ where: { id: P.rover }, data: { active: true } });
    const retry = await runAsSession(repSession, () => runAssistantPlan(stock));
    after = await counts();
    check("back on sale, Retry carries on from step 2: one quote, the reminder not repeated", retry.ok && after.quotes === before.quotes + 1 && after.followUps === before.followUps + 1, JSON.stringify({ retry, after }));
  }

  console.log("\nExpired and closed plans run nothing");
  {
    const before = await counts();
    const { taskId: old } = await propose(rep, [followStep, { type: "note", leadId: L.anna, text: "n" }]);
    const p = (await stored(old))!;
    p.plan.expiresAt = new Date(Date.now() - 1000).toISOString();
    await basePrisma.assistantTask.update({ where: { id: old }, data: { details: p as object } });
    const expired = await asRep(() => continuePlan(rep, old, real()));
    check("expired: nothing runs, and the Ask page says so", /expired/.test(expired.message) && expired.plan?.status === "expired" && (await counts()).followUps === before.followUps, expired.message);
    const { taskId: shut } = await propose(rep, [followStep, { type: "note", leadId: L.anna, text: "n" }]);
    await scoped(() => setTaskStatus(rep.id, shut, "closed"));
    const closed = await asRep(() => continuePlan(rep, shut, real()));
    check("closed (Close on the Ask page): nothing runs", /closed/.test(closed.message) && closed.plan?.status === "closed" && (await counts()).followUps === before.followUps, closed.message);
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
