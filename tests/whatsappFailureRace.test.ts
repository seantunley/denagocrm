import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  decodeParkedFailure,
  encodeParkedFailure,
  reconcileProviderFailure,
  recordProviderFailure,
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
function world(hooks: { beforePark?: () => Promise<void> } = {}) {
  const row = { status: "running", providerMessageId: null as string | null, failureCode: null as string | null };
  const parked = new Map<string, { failure: ProviderFailure; status: "pending" | "completed" }>();
  let markWrites = 0;
  const ledger: FailureLedger = {
    async markFailed(f) {
      if (row.providerMessageId !== f.providerMessageId || !["sent", "dead"].includes(row.status)) return 0;
      row.status = "dead";
      row.failureCode = f.failureCode;
      markWrites++;
      return 1;
    },
    async park(f) {
      await hooks.beforePark?.();
      if (!parked.has(f.providerMessageId)) parked.set(f.providerMessageId, { failure: f, status: "pending" });
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
    await reconcileProviderFailure(ledger, id);
  }
  const label = () => deliveryLabel({ direction: "outbound" }, true, { status: row.status, failureCode: row.failureCode });
  return { row, parked, ledger, workerCommits, label, writes: () => markWrites };
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
