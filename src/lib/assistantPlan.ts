import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { ownedWriteTenantId } from "./tenantWrite";
import { CRM_CARD_TTL_MS } from "./assistantWhatsAppRules";
import type { ActionCard, ProposedAction } from "./assistantActions";
import {
  RETRY_SAFE_KINDS,
  SEND_KINDS,
  STEP_STALE_MS,
  cardForStep,
  nextStep,
  pdfAlreadySent,
  planStepLists,
  planView,
  readPlan,
  stepStatusFor,
  type PlanProposal,
  type PlanState,
  type PlanStep,
  type PlanView,
} from "./assistantPlanRules";

/*
 * MULTI-STEP PLANS — the database half (the rules are assistantPlanRules.ts).
 *
 * A PLAN IS A JOB SHEET (AssistantTask, kind "plan"): no new table. Its steps —
 * each an ordinary card, already checked and resolved like any other — are kept
 * on the row (`details.plan`), written by the server when DAX proposed it. The
 * browser only ever names the plan by its id; nothing it sends is run.
 *
 * ONE STEP AT A TIME, EACH AT MOST ONCE. Every step owns a claim row in
 * AssistantPendingAction (the same claim/settle columns as a saved card), keyed
 * by the step's own key. Claiming and settling happen under the plan row's lock
 * (SELECT … FOR UPDATE, one callback transaction each); the step itself runs
 * between them, through its card's own server action, holding no lock. So:
 *  - Confirm pressed twice finds the first step claimed ("already running") or
 *    done (skipped) — never runs it again;
 *  - a step that finished is never run again, whatever kind it is;
 *  - a step refused before it wrote anything (`unchanged`) has its claim removed
 *    and runs again on Retry; one that failed part-way runs again only when its
 *    own action carries a confirm key (RETRY_SAFE_KINDS) — a quote is never made twice;
 *  - a claim with no outcome after STEP_STALE_MS was interrupted, and is treated
 *    as failed part-way.
 * Claim rows are never offered anywhere: they are created already confirmed (the
 * Ask page and WhatsApp only read unconfirmed rows), and a released claim is
 * deleted, not reset.
 */

type User = { id: string };
type StepOutcome = { ok: boolean; error?: string; success?: string; href?: string; unchanged?: boolean; resumable?: boolean; quote?: { id: string; number: number } };
export type RunStep = (card: ActionCard) => Promise<StepOutcome>;

export const PLAN_KIND = "plan";
const lock = (tx: Pick<typeof prisma, "$queryRaw">, tenantId: string, userId: string, taskId: string) =>
  tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "AssistantTask" WHERE "id" = ${taskId} AND "tenantId" = ${tenantId} AND "userId" = ${userId} AND "kind" = ${PLAN_KIND} FOR UPDATE`;
const SELECT = { id: true, title: true, status: true, quoteId: true, details: true } as const;

/**
 * A proposal → the plan's card (and any customer messages as their own Send
 * cards). Each step is resolved by `resolve` — the same checks every loose card
 * goes through (resolveActions) — and whatever did not resolve says why in
 * `problems`. Fewer than two internal steps is no plan: a lone step is an
 * ordinary card.
 */
export async function proposePlan(
  user: User,
  proposal: PlanProposal,
  problems: string[],
  resolve: (proposals: ProposedAction[], problems: string[]) => Promise<ActionCard[]>,
  now = new Date(),
): Promise<ActionCard[]> {
  const steps = proposal.steps;
  // A quote_pdf of the quote this plan builds can't be resolved now — the quote doesn't exist yet. It is filled in when it runs.
  const deferred = (i: number) => {
    const s = steps[i];
    return s.action.type === "quote_pdf" && s.dependsOn !== undefined && steps[s.dependsOn - 1]?.action.type === "quote_build";
  };
  const toResolve = steps.map((s, i) => ({ s, i })).filter(({ i }) => !deferred(i));
  const stepProblems: string[] = [];
  const cards = await resolve(toResolve.map(({ s }) => s.action), stepProblems);
  // resolveActions names each card a<index>-…, its position in what it was given.
  const cardFor = new Map<number, ActionCard>();
  toResolve.forEach(({ i }, k) => {
    const card = cards.find((c) => c.id.startsWith(`a${k}-`));
    if (card) cardFor.set(i, card);
  });
  const unexplained = Math.max(0, toResolve.length - cards.length - stepProblems.length);
  if (unexplained) stepProblems.push(`${unexplained === 1 ? "A step" : `${unexplained} steps`} of the plan could not be set up. Ask again with the exact details.`);
  if (proposal.dropped) stepProblems.push(`${proposal.dropped === 1 ? "A step" : `${proposal.dropped} steps`} of the plan were not valid and were left out.`);

  const internal: { card: ActionCard; fromStep?: number }[] = [];
  const sends: ActionCard[] = [];
  const position = new Map<number, number>(); // original step → its number in the plan
  steps.forEach((s, i) => {
    const source = s.dependsOn !== undefined ? s.dependsOn - 1 : null;
    // What it depends on did not make it into the plan: nor does this.
    if (source !== null && !position.has(source) && !(cardFor.has(source) && SEND_KINDS.has(cardFor.get(source)!.kind))) {
      if (cardFor.has(i) || deferred(i)) stepProblems.push(`Step ${i + 1} was left out: the step it depends on (${source + 1}) could not be set up.`);
      return;
    }
    if (deferred(i)) {
      const from = cardFor.get(source!) as Extract<ActionCard, { kind: "quote_build" }>;
      internal.push({
        card: { id: `p${i}-pdf`, kind: "quote_pdf", leadId: from.leadId, leadLabel: from.leadLabel, quoteId: "", quoteNumber: 0, title: "Send me the PDF of the new quote" },
        fromStep: position.get(source!),
      });
      position.set(i, internal.length);
      return;
    }
    const card = cardFor.get(i);
    if (!card) return;
    // Customer-facing: NEVER bundled. Its own card, with its own Send.
    if (SEND_KINDS.has(card.kind)) { sends.push(card); return; }
    internal.push({ card });
    position.set(i, internal.length);
  });
  problems.push(...stepProblems);
  if (internal.length < 2) return [...internal.map((s) => s.card), ...sends];

  const taskId = `plan_${randomBytes(12).toString("hex")}`;
  const plan: PlanState = {
    v: 1,
    expiresAt: new Date(now.getTime() + CRM_CARD_TTL_MS).toISOString(),
    sends: sends.map((c) => c.title),
    steps: internal.map(({ card, fromStep }, at) => ({
      n: at + 1,
      key: `ps_${randomBytes(16).toString("hex")}`,
      title: card.title,
      // A quote built by a plan belongs to it: the save links the quote to this row in its own transaction, so
      // the plan has one quote, and a Retry gets that quote back (saveQuoteDraft, assistantTaskId).
      card: card.kind === "quote_build" && !card.taskId ? { ...card, taskId } : card,
      ...(fromStep ? { fromStep } : {}),
      status: "waiting",
    })),
  };
  const row = await prisma.assistantTask.create({
    data: {
      id: taskId, tenantId: ownedWriteTenantId(), userId: user.id, kind: PLAN_KIND, title: proposal.title, status: "open",
      details: { plan } as object, steps: planStepLists(plan) as object, nextAction: "Confirm the plan", updatedAt: now,
    },
    select: SELECT,
  });
  const view = planView(row, plan, now);
  return [{ id: `plan-${taskId}`, kind: "plan", title: `Plan: ${proposal.title}`, leadId: null, leadLabel: `${plan.steps.length} steps — one Confirm runs them in order`, plan: view }, ...sends];
}

type Claimed = { step: PlanStep; card: ActionCard; claimedAt: Date };
type Claim = { stop: string } | { claimed: Claimed } | { skipped: true };

/** Under the plan's lock: the next step, claimed — or why nothing runs. */
async function claimNext(user: User, taskId: string, now: Date): Promise<Claim> {
  const tenantId = ownedWriteTenantId();
  return prisma.$transaction(async (tx) => {
    if (!(await lock(tx, tenantId, user.id, taskId)).length) return { stop: "That plan is no longer there." };
    const row = await tx.assistantTask.findFirst({ where: { id: taskId, tenantId, userId: user.id, kind: PLAN_KIND }, select: SELECT });
    const plan = row ? readPlan(row.details) : null;
    if (!row || !plan) return { stop: "That plan is no longer there." };
    const write = (data: Record<string, unknown> = {}) =>
      tx.assistantTask.updateMany({
        where: { id: taskId, tenantId, userId: user.id },
        data: { details: { ...(row.details as object), plan } as object, steps: planStepLists(plan) as object, version: { increment: 1 }, updatedAt: now, ...data },
      });
    const step = nextStep(plan);
    if (!step) {
      if (row.status === "open") await write({ status: "done", closedAt: now, nextAction: null });
      return { stop: "Every step of this plan has already run — nothing was run twice." };
    }
    if (row.status !== "open") return { stop: "This plan was closed, so nothing more runs. Ask again if you still want it." };
    if (new Date(plan.expiresAt).getTime() <= now.getTime()) return { stop: "This plan has expired, so nothing more runs. Ask again if you still want it." };
    const claim = await tx.assistantPendingAction.findFirst({ where: { id: step.key, tenantId, userId: user.id }, select: { confirmedAt: true, completedAt: true, failedAt: true } });
    // Finished, but the plan never heard (the request ended between the step and its note here): it is done.
    if (claim?.completedAt) {
      step.status = "done";
      step.message ??= "Done.";
      await write();
      return { skipped: true };
    }
    if (claim && !claim.failedAt) {
      if (claim.confirmedAt && now.getTime() - claim.confirmedAt.getTime() < STEP_STALE_MS) return { stop: `Step ${step.n} is already running — give it a moment.` };
      // Claimed long ago with no outcome: interrupted part-way. Treated as failed part-way.
      await tx.assistantPendingAction.updateMany({ where: { id: step.key, tenantId, userId: user.id, completedAt: null, failedAt: null }, data: { failedAt: now } });
      step.status = "failed";
      step.message = "It was interrupted part-way.";
    }
    if (claim?.failedAt || step.status === "failed") {
      if (!RETRY_SAFE_KINDS.has(step.card.kind)) {
        await write();
        return { stop: `Step ${step.n} (${step.title}) failed part-way, so it isn't run again — check it, then close this plan and ask again.` };
      }
      // Safe to run again: its own action spends a confirm key, so a second run does nothing twice.
      await tx.assistantPendingAction.deleteMany({ where: { id: step.key, tenantId, userId: user.id } });
    }
    if (pdfAlreadySent(plan, step)) {
      const quote = plan.steps[step.fromStep! - 1].quote;
      step.status = "done";
      step.message = `The PDF of Q-${quote?.number} was sent to you with the quote — not sent twice. It has NOT been sent to the customer.`;
      await write();
      return { skipped: true };
    }
    const card = cardForStep(plan, step);
    if (!card) {
      step.status = "refused";
      step.message = `Step ${step.fromStep} made no quote for this step to use.`;
      await write();
      return { stop: step.message };
    }
    await tx.assistantPendingAction.create({
      data: { id: step.key, tenantId, userId: user.id, card: { kind: "plan_step", taskId, n: step.n }, confirmedAt: now, expiresAt: new Date(plan.expiresAt) },
    });
    step.status = "running";
    delete step.message;
    await write({ nextAction: `Step ${step.n}: ${step.title}` });
    return { claimed: { step, card, claimedAt: now } };
  });
}

/** Under the plan's lock: what the step did, on its claim row and on the plan. */
async function settle(user: User, taskId: string, claimed: Claimed, outcome: StepOutcome, now: Date): Promise<void> {
  const tenantId = ownedWriteTenantId();
  const status = stepStatusFor(outcome);
  await prisma.$transaction(async (tx) => {
    // The plan's lock first, as claimNext takes it — the same order everywhere, so two can never deadlock.
    const locked = (await lock(tx, tenantId, user.id, taskId)).length > 0;
    // Guarded on THIS claim, so nothing a later attempt did is undone by this one finishing.
    const mine = { id: claimed.step.key, tenantId, userId: user.id, confirmedAt: claimed.claimedAt, completedAt: null, failedAt: null };
    if (status === "done") await tx.assistantPendingAction.updateMany({ where: mine, data: { completedAt: now } });
    else if (status === "failed") await tx.assistantPendingAction.updateMany({ where: mine, data: { failedAt: now } });
    // Refused before anything was written: the claim goes, so Retry can claim the step again.
    else await tx.assistantPendingAction.deleteMany({ where: mine });
    if (!locked) return;
    const row = await tx.assistantTask.findFirst({ where: { id: taskId, tenantId, userId: user.id, kind: PLAN_KIND }, select: SELECT });
    const plan = row ? readPlan(row.details) : null;
    const step = plan?.steps.find((s) => s.n === claimed.step.n);
    if (!row || !plan || !step) return;
    step.status = status;
    step.message = (outcome.ok ? outcome.success : outcome.error) ?? (outcome.ok ? "Done." : "It didn't work.");
    if (outcome.href) step.href = outcome.href;
    if (outcome.quote) step.quote = { id: outcome.quote.id, number: outcome.quote.number };
    const finished = !nextStep(plan);
    await tx.assistantTask.updateMany({
      where: { id: taskId, tenantId, userId: user.id },
      data: {
        details: { ...(row.details as object), plan } as object, steps: planStepLists(plan) as object,
        version: { increment: 1 }, updatedAt: now,
        ...(finished ? { status: "done", closedAt: now, nextAction: null } : status === "done" ? {} : { nextAction: `Paused at step ${step.n} — Retry or Close` }),
      },
    });
  });
}

/** A step's own action threw: a guard's redirect is a refusal before anything was written; anything else is unknown. */
const isRefusal = (error: unknown) =>
  typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");

/**
 * Confirm (and Retry): run the plan's steps in order from the first not done,
 * stopping at the first that fails or is refused. `run` is the card's own action
 * (runAssistantAction) — the plan adds no permission of its own.
 */
export async function continuePlan(user: User, taskId: string, run: RunStep, clock = () => new Date()): Promise<{ ok: boolean; message: string; plan: PlanView | null }> {
  let message = "";
  let ran = 0;
  for (let guard = 0; guard < 20; guard++) {
    const claim = await claimNext(user, String(taskId), clock());
    if ("stop" in claim) {
      message = claim.stop;
      break;
    }
    if ("skipped" in claim) continue;
    ran++;
    let outcome: StepOutcome;
    try {
      outcome = await run(claim.claimed.card);
    } catch (error) {
      if (!isRefusal(error)) await logError("assistant-plan", "a plan step threw", error instanceof Error ? error.name : "unknown").catch(() => {});
      outcome = isRefusal(error) ? { ok: false, unchanged: true, error: "You don't have permission for this step." } : { ok: false, error: "It stopped with an error part-way." };
    }
    await settle(user, String(taskId), claim.claimed, outcome, clock());
    if (!outcome.ok) {
      message = `Stopped at step ${claim.claimed.step.n} (${claim.claimed.step.title}): ${outcome.error ?? "it didn't work."}`;
      break;
    }
  }
  const plan = await readPlanView(user, String(taskId), clock());
  const done = plan?.status === "done";
  return { ok: done, message: done && ran > 0 ? "Every step ran." : message, plan };
}

/** The plan as the person sees it now — their own, in the workspace they act in. */
export async function readPlanView(user: User, taskId: string, now = new Date()): Promise<PlanView | null> {
  const row = await prisma.assistantTask.findFirst({ where: { id: taskId, tenantId: ownedWriteTenantId(), userId: user.id, kind: PLAN_KIND }, select: SELECT });
  const plan = row ? readPlan(row.details) : null;
  return row && plan ? planView(row, plan, now) : null;
}

/** The Ask page: the person's plans from the last 30 days, newest first. */
export async function plansForAskPage(userId: string, now = new Date()): Promise<PlanView[]> {
  const rows = await prisma.assistantTask.findMany({
    where: { tenantId: ownedWriteTenantId(), userId, kind: PLAN_KIND, updatedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: SELECT,
  });
  return rows.flatMap((row) => {
    const plan = readPlan(row.details);
    return plan ? [planView(row, plan, now)] : [];
  });
}
