import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  decodeParkedFailure,
  encodeParkedFailure,
  PARKED_FAILURE_TTL_MS,
  reconcileProviderFailure,
  recordProviderFailure,
  sweepParkedFailures,
  type FailureLedger,
  type ProviderFailure,
} from "../src/lib/providerFailure";
import { deliveryLabel } from "../src/lib/messageDelivery";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const WAMID = "wamid.HBgLMjc4MjEyMzQ1NjcVAgARGBI";
const FAILED: ProviderFailure = { providerMessageId: WAMID, failureCode: "outside_window", detail: "131047 Re-engagement message" };

/**
 * One outbox row and the parked-failure store, with the same semantics as the
 * Prisma ledger in botOutbox.ts, plus the worker's commit exactly as
 * deliverClaimed does it: `UPDATE … WHERE status = 'running'` to sent + id, then
 * reconcile.
 */
function world(hooks: { beforePark?: () => Promise<void>; markFailedThrows?: number } = {}) {
  const row = { status: "running", providerMessageId: null as string | null, failureCode: null as string | null };
  const parked = new Map<string, { failure: ProviderFailure; status: "pending" | "completed" | "expired"; parkedAt: Date }>();
  let markWrites = 0;
  let throwsLeft = hooks.markFailedThrows ?? 0;
  const ledger: FailureLedger = {
    async markFailed(f) {
      if (row.providerMessageId !== f.providerMessageId || !["sent", "dead"].includes(row.status)) return 0;
      if (throwsLeft > 0) {
        throwsLeft--;
        throw new Error("connection reset");
      }
      row.status = "dead";
      row.failureCode = f.failureCode;
      markWrites++;
      return 1;
    },
    async park(f) {
      await hooks.beforePark?.();
      if (!parked.has(f.providerMessageId)) parked.set(f.providerMessageId, { failure: f, status: "pending", parkedAt: new Date() });
    },
    async parked(id) {
      const p = parked.get(id);
      return p?.status === "pending" ? p.failure : null;
    },
    async consume(id) {
      const p = parked.get(id);
      if (p) p.status = "completed";
    },
  };
  async function workerCommits(id: string) {
    if (row.status === "running") {
      row.status = "sent";
      row.providerMessageId = id;
    }
    // Best effort, as reconcileParkedFailure is: an error is logged, not thrown.
    await reconcileProviderFailure(ledger, id).catch(() => {});
  }
  /** One cron pass, with the ops retryParkedFailures gives it. */
  async function cronSweep(now = new Date()) {
    const pending = [...parked.entries()]
      .filter(([, p]) => p.status === "pending")
      .sort(([, a], [, b]) => a.parkedAt.getTime() - b.parkedAt.getTime())
      .map(([providerMessageId, p]) => ({ providerMessageId, parkedAt: p.parkedAt }));
    return sweepParkedFailures(
      pending,
      {
        reconcile: (r) => reconcileProviderFailure(ledger, r.providerMessageId),
        expire: async (r) => {
          const p = parked.get(r.providerMessageId);
          if (p?.status === "pending") p.status = "expired";
        },
        onError: async () => {},
      },
      now,
    );
  }
  const label = () => deliveryLabel({ direction: "outbound" }, true, { status: row.status, failureCode: row.failureCode });
  return { row, parked, ledger, workerCommits, cronSweep, label, writes: () => markWrites };
}

test("REGRESSION: failed webhook arrives before the worker persists the wamid → ends Not delivered", async () => {
  const w = world();
  // 1. Meta accepted the send and returned WAMID (the worker holds it, uncommitted).
  // 2. The failed status webhook arrives first.
  await recordProviderFailure(w.ledger, FAILED);
  assert.equal(w.row.status, "running", "nothing to mark yet — the id is not committed");
  assert.equal(w.parked.get(WAMID)?.status, "pending", "the failure is kept, not acked into nothing");
  // 3. The worker persists the wamid.
  await w.workerCommits(WAMID);
  // 4. Final state.
  assert.equal(w.row.status, "dead");
  assert.deepEqual(w.label(), { text: "Not delivered — outside the 24-hour reply window", tone: "failed" });
  assert.equal(w.parked.get(WAMID)?.status, "completed", "the parked record is consumed");
});

test("a failure arriving AFTER the wamid is persisted marks the row directly and parks nothing", async () => {
  const w = world();
  await w.workerCommits(WAMID);
  assert.equal(w.label()?.text, "Sent ✓");
  await recordProviderFailure(w.ledger, FAILED);
  assert.equal(w.row.status, "dead");
  assert.equal(w.parked.size, 0);
});

test("the interleaving in between: webhook misses, worker commits and finds nothing, webhook parks → re-check applies it", async () => {
  // The worker commits and runs its reconcile in the gap between the webhook's
  // miss and its park — so the worker finds nothing parked.
  const w: ReturnType<typeof world> = world({ beforePark: async () => w.workerCommits(WAMID) });
  await recordProviderFailure(w.ledger, FAILED);
  assert.equal(w.row.status, "dead");
  assert.equal(w.parked.get(WAMID)?.status, "completed");
});

test("a duplicate failed webhook is idempotent, in either order", async () => {
  const late = world();
  await late.workerCommits(WAMID);
  await recordProviderFailure(late.ledger, FAILED);
  await recordProviderFailure(late.ledger, FAILED);
  assert.equal(late.row.status, "dead");
  assert.equal(late.parked.size, 0, "a redelivery re-marks its dead row instead of parking a stray record");

  const early = world();
  await recordProviderFailure(early.ledger, FAILED);
  await recordProviderFailure(early.ledger, FAILED);
  assert.equal(early.parked.size, 1, "parked once, keyed by the wamid");
  await early.workerCommits(WAMID);
  await recordProviderFailure(early.ledger, FAILED);
  assert.equal(early.row.status, "dead");
  assert.equal(early.parked.get(WAMID)?.status, "completed");
});

test("a failure for a wamid no outbox row will ever hold stays parked and touches nothing", async () => {
  const w = world();
  await w.workerCommits(WAMID);
  await recordProviderFailure(w.ledger, { ...FAILED, providerMessageId: "wamid.someone-else" });
  assert.equal(w.row.status, "sent");
  assert.equal(w.writes(), 0);
});

test("REGRESSION: the worker's reconcile throws once after the wamid is persisted → the next cron sweep applies it", async () => {
  const w = world({ markFailedThrows: 1 });
  await recordProviderFailure(w.ledger, FAILED); // early: parked
  await w.workerCommits(WAMID); // commits the id; its reconcile throws and is swallowed
  assert.equal(w.row.status, "sent", "the gap: parked failure, row says sent");
  assert.equal(w.parked.get(WAMID)?.status, "pending");
  const run = await w.cronSweep();
  assert.deepEqual(run, { applied: 1, expired: 0 });
  assert.equal(w.row.status, "dead");
  assert.equal(w.label()?.text, "Not delivered — outside the 24-hour reply window");
  assert.equal(w.parked.get(WAMID)?.status, "completed");
  // Idempotent: a second (or concurrent) pass finds nothing pending.
  assert.deepEqual(await w.cronSweep(), { applied: 0, expired: 0 });
  assert.equal(w.row.status, "dead");
});

test("a sweep error leaves the record pending for the next pass", async () => {
  const w = world({ markFailedThrows: 2 });
  await recordProviderFailure(w.ledger, FAILED);
  await w.workerCommits(WAMID); // throw #1
  assert.deepEqual(await w.cronSweep(), { applied: 0, expired: 0 }); // throw #2
  assert.equal(w.parked.get(WAMID)?.status, "pending");
  assert.deepEqual(await w.cronSweep(), { applied: 1, expired: 0 });
  assert.equal(w.row.status, "dead");
});

test("an unmatched parked failure stays pending, then expires after the TTL", async () => {
  const w = world();
  await recordProviderFailure(w.ledger, { ...FAILED, providerMessageId: "wamid.legacy-bot" });
  const parkedAt = w.parked.get("wamid.legacy-bot")!.parkedAt.getTime();
  assert.deepEqual(await w.cronSweep(new Date(parkedAt + PARKED_FAILURE_TTL_MS - 1)), { applied: 0, expired: 0 });
  assert.equal(w.parked.get("wamid.legacy-bot")?.status, "pending");
  assert.deepEqual(await w.cronSweep(new Date(parkedAt + PARKED_FAILURE_TTL_MS)), { applied: 0, expired: 1 });
  assert.equal(w.parked.get("wamid.legacy-bot")?.status, "expired");
  assert.deepEqual(await w.cronSweep(new Date(parkedAt + 2 * PARKED_FAILURE_TTL_MS)), { applied: 0, expired: 0 }, "expired is final");
  assert.equal(PARKED_FAILURE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("the sweep stops when the cron budget runs out", async () => {
  let calls = 0;
  const rows = [1, 2, 3].map((i) => ({ providerMessageId: `wamid.${i}`, parkedAt: new Date() }));
  await sweepParkedFailures(rows, {
    reconcile: async () => (calls++, 0),
    expire: async () => {},
    onError: async () => {},
    shouldStop: () => calls >= 2,
  });
  assert.equal(calls, 2);
});

test("wiring: the outbox cron runs the parked-failure retry, bounded, oldest first, per-tenant scoped", () => {
  const outbox = src("src/lib/botOutbox.ts");
  const flush = outbox.slice(outbox.indexOf("export async function flushBotOutbox("));
  assert.match(flush, /await retryParkedFailures\(Math\.min\(limit, 25\), scope, budget\)/);
  const sweep = outbox.slice(outbox.indexOf("async function retryParkedFailures"), outbox.indexOf("export async function flushBotOutbox("));
  assert.match(sweep, /where: \{ \.\.\.scope, channel: \{ endsWith: PARKED_FAILURE_SUFFIX \}, status: "pending" \}/);
  assert.match(sweep, /orderBy: \{ createdAt: "asc" \},\s*take: limit/);
  assert.match(sweep, /runInTenantScope\(\{ tenantId: row\.tenantId, system: false \}/);
  assert.match(sweep, /where: \{ id: row\.id, tenantId: row\.tenantId, status: "pending" \},\s*data: \{ status: "expired"/);
});

test("the parked payload round-trips through the text column", () => {
  assert.deepEqual(decodeParkedFailure(WAMID, encodeParkedFailure(FAILED)), FAILED);
  assert.equal(decodeParkedFailure(WAMID, "not json").failureCode, "provider_error");
});

test("wiring: the worker reconciles right after committing the id, on BOTH commit paths", () => {
  const outbox = src("src/lib/botOutbox.ts");
  const deliver = outbox.slice(outbox.indexOf("async function deliverClaimed"), outbox.indexOf("async function stampProviderMessageId"));
  const commits = [...deliver.matchAll(/data: \{ status: "sent"[^\n]*providerMessageId: result\.providerMessageId/g)].map((m) => m.index!);
  const reconciles = [...deliver.matchAll(/await reconcileParkedFailure\(row\.channel, result\.providerMessageId\)/g)].map((m) => m.index!);
  assert.equal(commits.length, 2, "the normal commit and the superseded-lease commit");
  assert.equal(reconciles.length, 2);
  for (const [i, at] of reconciles.entries()) assert.ok(at > commits[i], "reconcile only after the id is committed");
  // Parked in the existing tenant-scoped provider-event ledger, never a new table.
  const ledger = outbox.slice(outbox.indexOf("function failureLedger"), outbox.indexOf("export async function applyProviderFailure"));
  assert.match(ledger, /prisma\.botInboundEvent\.upsert\(/);
  assert.match(ledger, /const parkChannel = `\$\{channel\}:failed`/);
  assert.match(ledger, /status: \{ in: \["sent", "dead"\] \}/);
  assert.match(outbox, /return recordProviderFailure\(failureLedger\(channel\), failure\)/);
});
