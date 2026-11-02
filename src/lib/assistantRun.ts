import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { inheritedTenantId } from "./tenantWrite";
import type { AssistantResult } from "./crmAssistant";

/**
 * A question asked in chat, as a RUN the browser can come back to.
 *
 * Before this, a connection that dropped while DAX was working left the person
 * with "your answer may still be saved — check the Ask page": the server was
 * still answering, and asking again would have meant a second answer, second
 * learning and second proposed tasks from one click. Now the browser names the
 * run (clientKey) before it sends anything. The first request with that name
 * runs it; any later request with the same name — a retry after a drop, a
 * reconnect — reads the same run instead: its status, the answer so far, and
 * the finished result with its cards. Exactly once, by the unique
 * (tenantId, userId, clientKey) index rather than by hoping.
 *
 * Only the person who asked, in the workspace they asked in, can read their
 * run: every read and write names the workspace and the person explicitly —
 * not left to ambient filtering, which is off when tenant enforcement is — so a
 * key from workspace A, replayed from B by someone in both, finds nothing. The
 * row is swept after a week (automations cron). Timings hold milliseconds per
 * phase, never question text.
 */

export const RUN_KEY = /^[A-Za-z0-9_-]{8,64}$/;
/** A run still "working" after this long died with its function; say so. */
export const RUN_STALE_MS = 6 * 60 * 1000;
/** How often the answer-so-far is written while it streams: a reconnect is a moment behind, not a write per token. */
const PARTIAL_EVERY_MS = 400;

/**
 * "saving": the answer is written and being kept — Stop is refused from here. "stopped": the person stopped it
 * (stopRun) before that, so nothing from it was kept.
 */
export type RunStatus = "accepted" | "planning" | "researching" | "answering" | "saving" | "completed" | "failed" | "stopped";
export type RunView = { status: RunStatus; statusText: string | null; partial: string | null; result: AssistantResult | null };
/** Still working: what Stop can end, and the only states a progress write may touch (a late write never revives a stopped run). */
const STOPPABLE: RunStatus[] = ["accepted", "planning", "researching", "answering"];

export const RUN_LOST: AssistantResult = {
  ok: false,
  error: "That answer was interrupted on the server before it finished — ask again.",
};
export const RUN_STOPPED: AssistantResult = { ok: false, error: "Stopped — nothing from that answer was kept." };

/**
 * Claim the run for this key. `created` false means it already exists — this
 * request must only READ it (a retry or a reconnect), never run it again.
 */
export async function claimRun(tenantId: string, userId: string, clientKey: string): Promise<{ id: string; created: boolean }> {
  try {
    const run = await prisma.assistantRun.create({
      data: { tenantId, userId, clientKey },
      select: { id: true },
    });
    return { id: run.id, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.assistantRun.findUnique({ where: { tenantId_userId_clientKey: { tenantId, userId, clientKey } }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
    }
    throw error;
  }
}

/** What a reader sees of the person's own run, in this workspace — a run gone quiet for too long reads as failed. */
export async function readRun(tenantId: string, userId: string, clientKey: string, now: Date = new Date()): Promise<RunView | null> {
  const run = await prisma.assistantRun.findUnique({
    where: { tenantId_userId_clientKey: { tenantId, userId, clientKey } },
    select: { tenantId: true, userId: true, status: true, statusText: true, partial: true, result: true, updatedAt: true },
  });
  if (!run || run.tenantId !== tenantId || run.userId !== userId) return null;
  return runView(run, now);
}

/** Pure: a row → what the reader is told. */
export function runView(
  run: { status: string; statusText: string | null; partial: string | null; result: unknown; updatedAt: Date },
  now: Date,
): RunView {
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "stopped";
  if (!terminal && now.getTime() - run.updatedAt.getTime() > RUN_STALE_MS) {
    return { status: "failed", statusText: null, partial: run.partial, result: RUN_LOST };
  }
  return {
    status: run.status as RunStatus,
    statusText: run.statusText,
    partial: run.partial,
    result: terminal ? ((run.result as AssistantResult | null) ?? RUN_LOST) : null,
  };
}

/**
 * The writer the asking request uses while it runs. Status changes are written
 * as they happen; the answer so far at most every PARTIAL_EVERY_MS. A failed
 * write is logged and dropped: the person watching the stream still gets
 * everything — only a reconnect would be a moment behind.
 *
 * STOP. Progress writes touch only a run still working (STOPPABLE), so a late
 * one never brings a stopped run back. `stillWanted` is askCrm's question; its
 * `final` call CLAIMS the run for keeping ("saving") in the same conditional
 * write Stop uses, so exactly one of them wins: stopped first, askCrm writes
 * nothing; claimed first, Stop is refused and the finished answer stands.
 * `finish` never overwrites a stopped run, and says whether it was stopped.
 */
export function runRecorder(id: string, tenantId: string, userId: string) {
  let lastPartial = 0;
  let pending: string | null = null;
  const write = (data: Prisma.AssistantRunUpdateManyMutationInput, status: Prisma.StringFilter<"AssistantRun"> = { in: STOPPABLE }) =>
    prisma.assistantRun.updateMany({ where: { id, tenantId, userId, status }, data }).catch(async (error: unknown) => {
      await logError("assistant-run", "run write failed", error instanceof Error ? error.name : "unknown");
      return null;
    });
  return {
    async stillWanted(final: boolean): Promise<boolean> {
      if (final) {
        // Not claimed because it was stopped: keep nothing — a stopped answer must never leave a card. (A failed
        // write — logged — keeps the answer: Stop's own write would be failing too.)
        const claimed = await write({ status: "saving" });
        return claimed === null || claimed.count === 1;
      }
      const run = await prisma.assistantRun.findFirst({ where: { id, tenantId, userId }, select: { status: true } }).catch(() => null);
      return run?.status !== "stopped";
    },
    phase(status: RunStatus, statusText?: string) {
      void write({ status, ...(statusText ? { statusText } : {}) });
    },
    partial(text: string) {
      pending = text;
      const now = Date.now();
      if (now - lastPartial < PARTIAL_EVERY_MS) return;
      lastPartial = now;
      pending = null;
      void write({ status: "answering", partial: text });
    },
    /** true when the person had stopped it: nothing was written, and the stopped result stands. */
    async finish(result: AssistantResult, timings: Record<string, number>): Promise<boolean> {
      const written = await write({
        status: result.ok ? "completed" : "failed",
        partial: result.ok ? result.answer : pending,
        result: result as unknown as Prisma.InputJsonValue,
        timings,
        finishedAt: new Date(),
      }, { not: "stopped" });
      return written?.count === 0;
    },
  };
}

/**
 * Stop the person's own run, in this workspace, named by its key. "stopped": it
 * was still working (or hadn't arrived yet) and nothing from it will be kept.
 * "finished": too late — it is done or being kept, and its answer stands.
 *
 * A Stop that overtakes its own question (sent before the POST arrived) records
 * the run already stopped, so the question — when it comes — only reads it
 * (claimRun finds it) and never runs.
 */
export async function stopRun(tenantId: string, userId: string, clientKey: string): Promise<"stopped" | "finished"> {
  const data = { status: "stopped", result: RUN_STOPPED as unknown as Prisma.InputJsonValue, finishedAt: new Date() };
  const stop = () => prisma.assistantRun.updateMany({ where: { tenantId, userId, clientKey, status: { in: STOPPABLE } }, data });
  if ((await stop()).count) return "stopped";
  try {
    await prisma.assistantRun.create({ data: { tenantId, userId, clientKey, ...data }, select: { id: true } });
    return "stopped";
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  // It arrived in between: stop it now if it is still working.
  if ((await stop()).count) return "stopped";
  return (await readRun(tenantId, userId, clientKey))?.status === "stopped" ? "stopped" : "finished";
}

/**
 * The owner's speed view: median milliseconds per phase over the last week of
 * runs in this workspace. Numbers only — never what was asked.
 */
export async function runSpeed(days = 7): Promise<{ runs: number; medians: Record<string, number>; byDepth: Record<"quick" | "investigate", Record<string, number>> }> {
  const rows = await prisma.assistantRun.findMany({
    where: { tenantId: inheritedTenantId(), status: "completed", createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { timings: true },
  });
  const list = rows.map((r) => r.timings);
  return { runs: rows.length, medians: medianTimings(list), byDepth: mediansByDepth(list) };
}

/**
 * Pure: the medians for quick questions and for investigations apart (adaptive
 * thinking, assistantDepth) — so "no slower on quick questions" can be checked.
 * Runs from before depth was recorded count in neither.
 */
export function mediansByDepth(list: unknown[]): Record<"quick" | "investigate", Record<string, number>> {
  const depthOf = (t: unknown) => (t && typeof t === "object" ? (t as Record<string, unknown>).depth : undefined);
  return {
    quick: medianTimings(list.filter((t) => depthOf(t) === 0)),
    investigate: medianTimings(list.filter((t) => depthOf(t) === 1)),
  };
}

/** Pure: the median of each phase present, over a list of timing objects. */
export function medianTimings(list: unknown[]): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    for (const [phase, ms] of Object.entries(t as Record<string, unknown>)) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
      by.set(phase, [...(by.get(phase) ?? []), ms]);
    }
  }
  const out: Record<string, number> = {};
  for (const [phase, values] of by) {
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[phase] = Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }
  return out;
}
