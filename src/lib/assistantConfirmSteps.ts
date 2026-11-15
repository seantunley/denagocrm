import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { claimInterrupted } from "./assistantPlanRules";
import { confirmReply, type ConfirmOutcome, type StepResult } from "./assistantConfirmStepsRules";

export { confirmReply, type ConfirmOutcome, type StepResult } from "./assistantConfirmStepsRules";

/**
 * A CONFIRM CARD THAT WRITES IN STEPS — saved once, resumed, reported as it is (risk assessment 2026-11-15, Phase 1:
 * "a step fails part-way, the reply misreports it, and a repeat Confirm doesn't finish the job").
 *
 * Each step owns a claim row in AssistantPendingAction, `<card key>:<step>` — the same claim/settle columns as the
 * card keys (assistantConfirmKey) and plan steps (assistantPlan): created already claimed, COMPLETED with what it did,
 * DELETED when it is to run again. So a Confirm pressed again:
 *  - skips every step already done, and says what each did (never runs one twice);
 *  - runs a step whose last try THREW again — an infrastructure error, logged by name only — so every step MUST be
 *    safe to run twice: one transaction, or keyed (its own confirm key), or checking the record first;
 *  - waits while another Confirm holds a step, and takes it over once that claim is STEP_STALE_MS old (the request
 *    died part-way: claimInterrupted, the plan runner's own rule).
 * A step that comes back `refused` wrote nothing: its claim goes, and Confirm can run it again. One that comes back
 * `unsure` may have written part of its work: it is never run again (completed as unsure) and the reply says so.
 *
 * The claim rows are `forCrm: true` with a claim time always set, so nothing that lists cards waiting for a Confirm
 * (the Ask page, WhatsApp's "yes to all" and its waiting list) ever reads one.
 */
const KEPT_MS = 35 * 24 * 60 * 60 * 1000;

export type ConfirmStep = { name: string; label: string; run: () => Promise<StepResult> };

let failOnce: string | null = null;
/** Tests: the next run of the step with this name throws, once — a database blip part-way through a card. */
export function __failConfirmStepOnceForTests(name: string | null) {
  failOnce = name;
}

type Claim = { state: "claimed"; at: Date } | { state: "done"; result: StepResult } | { state: "busy" };

async function claim(tenantId: string, userId: string, id: string, label: string): Promise<Claim> {
  const at = new Date();
  try {
    await basePrisma.assistantPendingAction.create({
      data: { id, tenantId, userId, forCrm: true, card: { kind: "confirm_step", what: label }, confirmedAt: at, expiresAt: new Date(at.getTime() + KEPT_MS) },
    });
    return { state: "claimed", at };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  // This workspace's and this person's row only (a bypass client: the predicate is the boundary).
  const row = await basePrisma.assistantPendingAction.findFirst({ where: { id, tenantId, userId }, select: { confirmedAt: true, completedAt: true, card: true } });
  if (!row) return { state: "busy" };
  if (row.completedAt) {
    const result = (row.card as { result?: StepResult } | null)?.result;
    return { state: "done", result: result && typeof result === "object" ? result : { done: label } };
  }
  if (!claimInterrupted(row.confirmedAt, at)) return { state: "busy" };
  // Interrupted part-way: taken over — only the claim we READ, so two takeovers can't both win.
  const taken = await basePrisma.assistantPendingAction.updateMany({
    where: { id, tenantId, userId, confirmedAt: row.confirmedAt, completedAt: null },
    data: { confirmedAt: at },
  });
  return taken.count === 1 ? { state: "claimed", at } : { state: "busy" };
}

/** Guarded on THIS claim: a later Confirm that took the step over is never overwritten by this one finishing. */
const mine = (tenantId: string, userId: string, id: string, at: Date) => ({ id, tenantId, userId, confirmedAt: at, completedAt: null });

export async function runConfirmSteps(tenantId: string, userId: string, key: string, steps: ConfirmStep[]): Promise<ConfirmOutcome> {
  const done: string[] = [];
  let fresh = false;
  for (const step of steps) {
    const id = `${key}:${step.name}`;
    const c = await claim(tenantId, userId, id, step.label);
    if (c.state === "busy") return { kind: "busy", done };
    if (c.state === "done") {
      if ("unsure" in c.result) return { kind: "partly", done, notDone: { label: step.label, why: c.result.unsure, retry: false } };
      if ("done" in c.result) done.push(c.result.done);
      continue;
    }
    let result: StepResult;
    try {
      if (failOnce === step.name) {
        failOnce = null;
        throw new Error("forced step failure (tests)");
      }
      result = await step.run();
    } catch (error) {
      // A guard's redirect is a refusal by the CRM's own door, not a blip: thrown on, as every other card does.
      const redirect = typeof error === "object" && error !== null && String((error as { digest?: unknown }).digest ?? "").startsWith("NEXT_");
      await basePrisma.assistantPendingAction.deleteMany({ where: mine(tenantId, userId, id, c.at) }).catch(() => {});
      if (redirect) throw error;
      await logError("assistant-confirm", `confirm step "${step.name}" threw`, error instanceof Error ? error.name : "unknown").catch(() => {});
      return { kind: "retry", done, failed: step.label };
    }
    if ("refused" in result) {
      await basePrisma.assistantPendingAction.deleteMany({ where: mine(tenantId, userId, id, c.at) });
      return done.length ? { kind: "partly", done, notDone: { label: step.label, why: result.refused, retry: true } } : { kind: "refused", why: result.refused };
    }
    const settled = await basePrisma.assistantPendingAction.updateMany({
      where: mine(tenantId, userId, id, c.at),
      data: { completedAt: new Date(), card: { kind: "confirm_step", what: step.label, result } },
    });
    // Taken over meanwhile (this one ran past STEP_STALE_MS): the other Confirm owns the step now.
    if (settled.count !== 1) return { kind: "busy", done };
    fresh = true;
    if ("unsure" in result) return { kind: "partly", done, notDone: { label: step.label, why: result.unsure, retry: false } };
    done.push(result.done);
  }
  return { kind: fresh ? "saved" : "already", done };
}
