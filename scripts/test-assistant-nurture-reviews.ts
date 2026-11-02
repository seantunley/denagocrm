/**
 * NURTURE REVIEWS COME BACK, on a real database (round 2 item 1, Sean 2026-11-02: "Lets do 1, 2 and 3").
 *
 *   npx tsx --tsconfig tsconfig.harness.json scripts/test-assistant-nurture-reviews.ts
 *   (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * Through the SCOPED client with enforcement on, as two sales reps (a constrained role — not an owner):
 *  - the brief lists a parked deal on its review day and one whose review passed (flagged overdue) — for its
 *    salesperson only: the other rep's brief has neither, and a review still to come is in nobody's;
 *  - the reactivate card (the real resolveActions) shows the stage and the next action in full;
 *  - Confirm (the real server action → reactivateNurturedLead) opens the deal in that stage, closes the review task,
 *    adds the next action for the salesperson, and audits it; Confirm again writes nothing;
 *  - a card whose deal changed since, or left Nurture, is refused unchanged; another rep gets no card, and their
 *    Confirm of this rep's card changes nothing.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database or with a file-store key set, and removes every
 * row it creates (except append-only audit events). The model is never called; nobody is contacted.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import type { ActionCard } from "../src/lib/assistantActions";
import { resolveActions } from "../src/lib/crmAssistant";
import { briefForAssistant, loadDaxBrief } from "../src/lib/daxBrief";
import { johannesburgDateKey } from "../src/lib/activityDay";
import { runAssistantAction } from "../src/app/actions/assistant";
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
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_PRIVATE_READ_WRITE_TOKEN) throw new Error("Refusing to run with a file-store key set");
}

const id = (what: string) => `asst-nrev-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const other: PermissionUser = { id: id("other"), name: "Other", email: `${id("other")}@example.invalid`, role: "member" };
const USERS = [rep, other];
const PARKED = id("stage-new");
const CONTACTED = `Contacted ${SFX}`;
const CONTACTED_ID = id("stage-contacted");
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
const DAY = 86_400_000;
const today = johannesburgDateKey(new Date());
const dayAt = (offsetDays: number) => new Date(new Date(`${today}T09:00:00+02:00`).getTime() + offsetDays * DAY);
const L = { overdue: id("l-overdue"), due: id("l-due"), later: id("l-later"), theirs: id("l-theirs") };

async function seed() {
  await basePrisma.user.createMany({ data: USERS.map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })) });
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T})`;
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed") VALUES
      (${PARKED}, ${T}, ${`New ${SFX}`}, 900101, '#64748b', 'pipeline_default_retail', 10, false),
      (${CONTACTED_ID}, ${T}, ${CONTACTED}, 900102, '#64748b', 'pipeline_default_retail', 20, false)`;
  // Four parked deals, each with its review task, as the Nurture form leaves them.
  const parked = [
    { leadId: L.overdue, name: `Werner Kilian${SFX}`, owner: rep.id, reviewAt: dayAt(-3) },
    { leadId: L.due, name: `Anna Due${SFX}`, owner: rep.id, reviewAt: dayAt(0) },
    { leadId: L.later, name: `Ben Later${SFX}`, owner: rep.id, reviewAt: dayAt(10) },
    { leadId: L.theirs, name: `Cara Theirs${SFX}`, owner: other.id, reviewAt: dayAt(-1) },
  ];
  for (const p of parked) {
    await basePrisma.lead.create({
      data: {
        id: p.leadId, tenantId: T, title: "Rover XL", name: p.name, stageId: PARKED, assignedToId: p.owner, createdById: p.owner,
        status: "nurture", nurtureSince: dayAt(-60), nurtureReason: "timing", nurtureInterest: "Rover XL", nurtureTrigger: "When his bonus comes in March", nurtureReviewAt: p.reviewAt,
      },
    });
    const task = await basePrisma.activity.create({
      data: { tenantId: T, leadId: p.leadId, type: "todo", summary: "Review future interest: Rover XL", note: "When his bonus comes in March", dueDate: p.reviewAt, assignedToId: p.owner, createdById: p.owner },
    });
    await basePrisma.lead.update({ where: { id: p.leadId }, data: { nurtureActivityId: task.id } });
  }
}

async function sessionFor(user: PermissionUser): Promise<ActingSession> {
  return { cookieValue: await signFreshSession({ id: user.id, name: user.name ?? "", email: user.email ?? "", role: user.role, grants: "", sessionVersion: 0 }, 60, { tid: T }), label: user.name ?? user.id };
}

async function cleanup() {
  const ids = USERS.map((u) => u.id);
  const leads = Object.values(L);
  await basePrisma.activity.deleteMany({ where: { leadId: { in: leads } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ leadId: { in: leads } }, { userId: { in: ids } }] } });
  await basePrisma.lead.deleteMany({ where: { id: { in: leads } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" IN (${PARKED}, ${CONTACTED_ID})`;
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id})`;
  await basePrisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();
  const repSession = await sessionFor(rep);
  const otherSession = await sessionFor(other);

  console.log("\nThe brief: the review day brings it back — to its salesperson only");
  {
    const mine = await runAsSession(repSession, () => scoped(() => loadDaxBrief(rep)));
    const reviews = mine.nurtureReviews ?? [];
    const overdue = reviews.find((r) => r.leadId === L.overdue);
    const due = reviews.find((r) => r.leadId === L.due);
    check("the rep's brief: the overdue review (3 days, flagged) and today's", overdue?.daysPastReview === 3 && overdue.overdue && due?.daysPastReview === 0 && !due.overdue, JSON.stringify(reviews));
    check("…not a review still to come, nor another rep's", !reviews.some((r) => r.leadId === L.later || r.leadId === L.theirs), JSON.stringify(reviews));
    const item = mine.items.find((i) => i.key === "nurture_review");
    check("one brief line: count, overdue flag, the most overdue named with why, wants and trigger", item?.title === "2 Nurture reviews due (1 overdue)"
      && item.detail === `Werner Kilian${SFX} — Buying later · wants Rover XL · “When his bonus comes in March” · review 3 days overdue` && item.href === "/leads/nurture?due=1", JSON.stringify(item));
    const forDax = briefForAssistant(mine);
    check("DAX's daily_brief carries each, with its link", forDax.nurtureReviews?.find((r) => r.leadId === L.overdue)?.link === `/leads/${L.overdue}` && forDax.nurtureReviews?.find((r) => r.leadId === L.overdue)?.flag === "overdue review", JSON.stringify(forDax.nurtureReviews));
    const theirs = await runAsSession(otherSession, () => scoped(() => loadDaxBrief(other)));
    check("the other rep's brief: only their own parked deal", (theirs.nurtureReviews ?? []).map((r) => r.leadId).join() === L.theirs, JSON.stringify(theirs.nurtureReviews));
  }

  const inTwoDays = johannesburgDateKey(dayAt(2));
  const asked = { type: "reactivate", leadId: L.overdue, stage: CONTACTED, next: "Call Werner at 10:00 about the Rover XL", on: inTwoDays };
  const propose = async (who: PermissionUser, session: ActingSession, proposal: Record<string, unknown>) => {
    const problems: string[] = [];
    const cards = await runAsSession(session, () => scoped(() => resolveActions(who, [proposal as never], problems, null)));
    return { problems, card: cards.find((c): c is Extract<ActionCard, { kind: "reactivate" }> => c.kind === "reactivate") };
  };
  const reactivated = (leadId: string) => basePrisma.auditEvent.count({ where: { entityId: leadId, eventType: "lead.reactivated" } });

  console.log("\nThe reactivate card → Confirm");
  {
    const { card, problems } = await propose(rep, repSession, asked);
    check("the card shows the stage and the next action in full", !!card && card.title === `Reactivate Werner Kilian${SFX}'s deal — back to ${CONTACTED}`
      && card.detail.includes(`Back to: ${CONTACTED}`) && card.detail.includes("Next action: Call Werner at 10:00 about the Rover XL — ") && card.detail.includes("a to-do for Rep")
      && card.detail.includes("Nobody is contacted."), JSON.stringify({ card, problems }));
    const notMine = await propose(other, otherSession, asked);
    check("another rep: no card for a deal they can't open", !notMine.card);
    const stageless = await propose(rep, repSession, { ...asked, stage: "Nurture" });
    check("a stage called Nurture: no card, and it asks which stage", !stageless.card && /which stage should/.test(stageless.problems.join(" ")), stageless.problems.join(" | "));

    // Another rep presses Confirm on this rep's card: their access is checked, nothing changes.
    const forged = await runAsSession(otherSession, () => scoped(() => runAssistantAction(card!)));
    check("another rep confirming it: refused unchanged, still parked", !forged.ok && forged.unchanged === true && (await basePrisma.lead.findUnique({ where: { id: L.overdue } }))?.status === "nurture", JSON.stringify(forged));

    const done = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    const row = await basePrisma.lead.findUnique({ where: { id: L.overdue } });
    const review = await basePrisma.activity.findFirst({ where: { leadId: L.overdue, summary: "Review future interest: Rover XL" } });
    const next = await basePrisma.activity.findMany({ where: { leadId: L.overdue, summary: "Call Werner at 10:00 about the Rover XL" } });
    check("Confirm: open, in that stage, Nurture details cleared", done.ok && row?.status === "open" && row.stageId === CONTACTED_ID && row.nurtureReviewAt === null && row.nurtureReason === null, JSON.stringify({ done, row }));
    check("…the review task closed, the next action a to-do for the salesperson on that day", review?.status === "cancelled" && next.length === 1 && next[0].assignedToId === rep.id && next[0].tenantId === T
      && johannesburgDateKey(next[0].dueDate) === inTwoDays, JSON.stringify({ review, next }));
    check("…audited: reactivated, and confirmed from DAX's card", (await reactivated(L.overdue)) === 1
      && (await basePrisma.auditEvent.count({ where: { entityId: L.overdue, eventType: "assistant.action_confirmed" } })) === 1);
    const again = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    check("Confirm again: says it's done, writes nothing", again.ok && /is back in the pipeline/.test(again.success ?? "") && (await reactivated(L.overdue)) === 1
      && (await basePrisma.activity.count({ where: { leadId: L.overdue, summary: "Call Werner at 10:00 about the Rover XL" } })) === 1
      && (await basePrisma.auditEvent.count({ where: { entityId: L.overdue, eventType: "assistant.action_confirmed" } })) === 1, JSON.stringify(again));
  }

  console.log("\nOut-of-date cards are refused, unchanged");
  {
    const { card } = await propose(rep, repSession, { ...asked, leadId: L.due });
    // Its review day moved after the card was shown (someone re-parked it).
    await basePrisma.lead.update({ where: { id: L.due }, data: { nurtureReviewAt: dayAt(5) } });
    const stale = await runAsSession(repSession, () => scoped(() => runAssistantAction(card!)));
    check("changed since: refused unchanged, still parked", !stale.ok && stale.unchanged === true && /changed since/.test(stale.error ?? "") && (await basePrisma.lead.findUnique({ where: { id: L.due } }))?.status === "nurture", JSON.stringify(stale));
    const fresh = await propose(rep, repSession, { ...asked, leadId: L.due });
    await basePrisma.lead.update({ where: { id: L.due }, data: { status: "lost", lostReason: "Bought elsewhere", lostAt: new Date() } });
    const gone = await runAsSession(repSession, () => scoped(() => runAssistantAction(fresh.card!)));
    check("no longer in Nurture: refused unchanged, still lost", !gone.ok && gone.unchanged === true && /no longer in Nurture/.test(gone.error ?? "") && (await basePrisma.lead.findUnique({ where: { id: L.due } }))?.status === "lost"
      && (await reactivated(L.due)) === 0, JSON.stringify(gone));
    const lost = await propose(rep, repSession, { ...asked, leadId: L.due });
    check("a lost deal: no reactivate card, and it says so", !lost.card && /reopened, not reactivated/.test(lost.problems.join(" ")), lost.problems.join(" | "));
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
