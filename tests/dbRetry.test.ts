import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isTransientDbError, withDbRetry } from "../src/lib/dbRetry";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** No real waiting, and a clock the test drives. */
const harness = () => {
  let clock = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    slept,
    advance: (ms: number) => { clock += ms; },
  };
};

const unreachable = () => Object.assign(new Error("Can't reach database server at `db:5432`"), { code: "P1001" });

test("a cold-start connection failure is retried and the run succeeds", async () => {
  const h = harness();
  let attempts = 0;
  const result = await withDbRetry(
    async () => {
      attempts++;
      if (attempts === 1) throw unreachable();
      return "swept";
    },
    { sleep: h.sleep, now: h.now },
  );
  assert.equal(result, "swept");
  assert.equal(attempts, 2, "should have retried exactly once");
  assert.deepEqual(h.slept, [1500], "first backoff");
});

test("a non-transient error is NOT retried and propagates untouched", async () => {
  const h = harness();
  let attempts = 0;
  const boom = Object.assign(new Error("Unique constraint failed on the fields: (`externalId`)"), { code: "P2002" });
  await assert.rejects(
    () => withDbRetry(async () => { attempts++; throw boom; }, { sleep: h.sleep, now: h.now }),
    (e: unknown) => e === boom,
  );
  assert.equal(attempts, 1, "a constraint violation must not be repeated");
  assert.deepEqual(h.slept, []);
});

test("gives up after the attempt budget and rethrows the real error", async () => {
  const h = harness();
  let attempts = 0;
  await assert.rejects(
    () => withDbRetry(async () => { attempts++; throw unreachable(); }, { sleep: h.sleep, now: h.now }),
    /reach database server/,
  );
  assert.equal(attempts, 3, "default is three attempts");
});

test("does not retry into the platform timeout", async () => {
  const h = harness();
  let attempts = 0;
  // Only 3s of budget left: a retry needs the backoff PLUS room to actually run,
  // so it must report now rather than be killed mid-attempt.
  const deadlineAt = h.now() + 3_000;
  await assert.rejects(
    () => withDbRetry(async () => { attempts++; throw unreachable(); }, { sleep: h.sleep, now: h.now, deadlineAt }),
    /reach database server/,
  );
  assert.equal(attempts, 1, "no time for a second attempt");
  assert.deepEqual(h.slept, [], "and it must not sleep on the way out");
});

test("recognises the connection faults seen in production, not application errors", () => {
  assert.equal(isTransientDbError(unreachable()), true);
  assert.equal(isTransientDbError(new Error("Timed out fetching a new connection from the pool")), true);
  assert.equal(isTransientDbError(Object.assign(new Error("x"), { code: "P1017" })), true);
  assert.equal(isTransientDbError(new Error("there is no unique or exclusion constraint matching")), false);
  assert.equal(isTransientDbError(new Error("Survey distribution queue requires a tenant scope")), false);
  assert.equal(isTransientDbError(null), false);
});

test("every per-tenant cron absorbs a cold start, with a deadline", () => {
  // The fault cost whole runs on ONE route; leaving the siblings unguarded would
  // just move it. Any cron fanning out over tenants must be covered.
  const dir = path.join(root, "src/app/api/cron");
  const perTenant = readdirSync(dir).filter((name) => {
    const file = path.join(dir, name, "route.ts");
    try {
      return readFileSync(file, "utf8").includes("runCronPerTenant(");
    } catch {
      return false;
    }
  });
  assert.ok(perTenant.length >= 3, `expected several per-tenant crons, found ${perTenant.join(", ")}`);
  for (const name of perTenant) {
    const body = readFileSync(path.join(dir, name, "route.ts"), "utf8");
    assert.match(body, /withDbRetry\(/, `${name} cron does not absorb a transient connection failure`);
    assert.match(body, /deadlineAt/, `${name} cron retries without a deadline`);
  }
});
