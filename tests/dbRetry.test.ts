import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isTransientDbError, warmUpDatabase } from "../src/lib/dbRetry";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** No real waiting. */
const harness = () => {
  const slept: number[] = [];
  return { sleep: async (ms: number) => { slept.push(ms); }, slept };
};

const unreachable = () => Object.assign(new Error("Can't reach database server at `db:5432`"), { code: "P1001" });

test("a cold endpoint is woken and the run proceeds", async () => {
  const h = harness();
  let pings = 0;
  const awake = await warmUpDatabase(async () => {
    pings++;
    if (pings < 3) throw unreachable();
    return [{ one: 1 }];
  }, { sleep: h.sleep });
  assert.equal(awake, true);
  assert.equal(pings, 3);
  assert.deepEqual(h.slept, [1000, 2000], "backs off between pings");
});

test("a still-dead database reports false instead of throwing", async () => {
  const h = harness();
  let pings = 0;
  const awake = await warmUpDatabase(async () => { pings++; throw unreachable(); }, { sleep: h.sleep });
  assert.equal(awake, false, "the caller skips the run rather than crashing");
  assert.equal(pings, 3);
});

test("a real database fault is not retried and propagates", async () => {
  const h = harness();
  let pings = 0;
  const boom = Object.assign(new Error("Authentication failed against database server"), { code: "P1000" });
  await assert.rejects(
    () => warmUpDatabase(async () => { pings++; throw boom; }, { sleep: h.sleep }),
    (e: unknown) => e === boom,
  );
  assert.equal(pings, 1, "a credential problem must not be repeated");
});

test("provider network errors are NOT classified as database faults", () => {
  // The cron calls email, HTTP and AI providers. Treating their hiccups as
  // database faults is how a harmless preflight starts misfiring.
  assert.equal(isTransientDbError(new Error("socket hang up")), false);
  assert.equal(isTransientDbError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), false);
  assert.equal(isTransientDbError(new Error("connection reset by peer")), false);
  assert.equal(isTransientDbError(new Error("connection closed")), false);
  assert.equal(isTransientDbError(new Error("fetch failed")), false);
  // …while the real ones still are.
  assert.equal(isTransientDbError(unreachable()), true);
  assert.equal(isTransientDbError(Object.assign(new Error("x"), { code: "P1017" })), true);
  assert.equal(
    isTransientDbError(new Error("Timed out fetching a new connection from the connection pool")),
    true,
  );
  assert.equal(isTransientDbError(new Error("there is no unique or exclusion constraint matching")), false);
  assert.equal(isTransientDbError(null), false);
});

const cronRoutes = () => {
  const dir = path.join(root, "src/app/api/cron");
  return readdirSync(dir)
    .map((name) => ({ name, file: path.join(dir, name, "route.ts") }))
    .filter((r) => {
      try {
        readFileSync(r.file, "utf8");
        return true;
      } catch {
        return false;
      }
    });
};

test("no cron retries its sweep — sweeps send email and must run exactly once", () => {
  for (const { name, file } of cronRoutes()) {
    const body = readFileSync(file, "utf8");
    assert.doesNotMatch(
      body,
      /withDbRetry\s*\(/,
      `${name} wraps work in a retry — a replayed sweep re-sends customer messages`,
    );
    assert.doesNotMatch(
      body,
      /warmUpDatabase\s*\([\s\S]*runCronPerTenant/,
      `${name} appears to retry the sweep itself`,
    );
  }
});

test("every per-tenant cron warms the database up first, and honours the result", () => {
  // The fault cost whole runs on ONE route; leaving the siblings unguarded
  // would just move it.
  const perTenant = cronRoutes().filter(({ file }) => readFileSync(file, "utf8").includes("runCronPerTenant("));
  assert.ok(perTenant.length >= 3, `expected several per-tenant crons, found ${perTenant.length}`);
  for (const { name, file } of perTenant) {
    const body = readFileSync(file, "utf8");
    assert.match(body, /warmUpForCron\(/, `${name} does not warm the database up before sweeping`);
    assert.match(body, /if \(!\(await warmUpForCron\(/, `${name} ignores the warm-up result`);
  }
});

test("the preflight itself only ever runs SELECT 1", () => {
  const body = readFileSync(path.join(root, "src/lib/cronPreflight.ts"), "utf8");
  assert.match(body, /SELECT 1/, "the warm-up query should be trivial");
  // No writes, no sending — repeating it must cost nothing.
  for (const forbidden of ["$executeRaw", "update(", "create(", "delete(", "sendMail", "sendPush"]) {
    assert.ok(!body.includes(forbidden), `the preflight must have no side effects (found ${forbidden})`);
  }
});
