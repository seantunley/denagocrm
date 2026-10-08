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

export type RunStatus = "accepted" | "planning" | "researching" | "answering" | "completed" | "failed";
export type RunView = { status: RunStatus; statusText: string | null; partial: string | null; result: AssistantResult | null };

export const RUN_LOST: AssistantResult = {
  ok: false,
  error: "That answer was interrupted on the server before it finished — ask again.",
};

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
  const terminal = run.status === "completed" || run.status === "failed";
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
 */
export function runRecorder(id: string, tenantId: string, userId: string) {
  let lastPartial = 0;
  let pending: string | null = null;
  const write = (data: Prisma.AssistantRunUpdateManyMutationInput) =>
    prisma.assistantRun.updateMany({ where: { id, tenantId, userId }, data }).catch(async (error: unknown) => {
      await logError("assistant-run", "run write failed", error instanceof Error ? error.name : "unknown");
    });
  return {
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
    async finish(result: AssistantResult, timings: Record<string, number>) {
      await write({
        status: result.ok ? "completed" : "failed",
        partial: result.ok ? result.answer : pending,
        result: result as unknown as Prisma.InputJsonValue,
        timings,
        finishedAt: new Date(),
      });
    },
  };
}

/**
 * The owner's speed view: median milliseconds per phase over the last week of
 * runs in this workspace. Numbers only — never what was asked.
 */
export async function runSpeed(days = 7): Promise<{ runs: number; medians: Record<string, number> }> {
  const rows = await prisma.assistantRun.findMany({
    where: { tenantId: inheritedTenantId(), status: "completed", createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { timings: true },
  });
  return { runs: rows.length, medians: medianTimings(rows.map((r) => r.timings)) };
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
