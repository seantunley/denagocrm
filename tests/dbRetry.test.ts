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
    assert.match(body, /if \(!\w*[Bb]udget\.ok\)/, `${name} ignores the warm-up result`);
  }
});

test("the warm-up stops retrying when its own deadline is spent", async () => {
  // A connection attempt does NOT fail instantly — a P1002 TLS timeout can hang
  // for seconds. Three attempts plus backoff must not eat the sweep's budget.
  let clock = 1_000_000;
  let pings = 0;
  const awake = await warmUpDatabase(
    async () => {
      pings++;
      clock += 9_000; // each attempt hangs for nine seconds before failing
      throw unreachable();
    },
    {
      deadlineAt: clock + 15_000,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    },
  );
  assert.equal(awake, false);
  assert.equal(pings, 2, "stopped once another ping would exceed the warm-up budget");
});

test("every cron gives the sweep only the budget that survived the warm-up", () => {
  for (const { name, file } of cronRoutes()) {
    const body = readFileSync(file, "utf8");
    if (!body.includes("runCronPerTenant(")) continue;
    // The sweep must be handed the REMAINING budget, never a fresh constant —
    // warm-up time is real wall-clock inside the same platform limit.
    assert.match(
      body,
      /maxRuntimeMs: \w*[Bb]udget\.remainingMs/,
      `${name} starts a full-length sweep regardless of how long waking the database took`,
    );
    assert.match(body, /routeBudgetMs:/, `${name} declares no route budget for the warm-up to spend from`);
    assert.doesNotMatch(body, /maxRuntimeMs: \d/, `${name} still passes a hard-coded sweep budget`);
  }
});

test("dormant mode gets a REAL deadline, not an infinite one", () => {
  // Dormant is the mode every deployment actually runs in. It used to hand the
  // slice `deadlineAt: null`, so shouldStop() was permanently false and
  // maxRuntimeMs was silently ignored — the budget existed on paper only.
  const body = readFileSync(path.join(root, "src/lib/tenantCron.ts"), "utf8");
  assert.match(body, /dormantDeadlineAt/, "dormant mode must compute a deadline");
  assert.doesNotMatch(
    body,
    /slice\(null, sliceContext\(null, null,/,
    "dormant mode must not pass a null deadline",
  );
  assert.match(
    body,
    /sliceContext\(null, dormantDeadlineAt,/,
    "the dormant slice must receive that deadline",
  );
});

test("every side-effecting cron slice can stop cooperatively", () => {
  // The runner cannot cancel work already in flight, so a slice that ignores its
  // context cannot respect the deadline at all — it just runs until the platform
  // kills it, possibly mid-send.
  for (const { name, file } of cronRoutes()) {
    const body = readFileSync(file, "utf8");
    if (!body.includes("runCronPerTenant(")) continue;
    assert.match(
      body,
      /runCronPerTenant\(async \([^)]*budget[^)]*\)/,
      `${name} discards the slice context, so its queues cannot stop`,
    );
    assert.match(
      body,
      /budget\.shouldStop\(/,
      `${name} never checks the remaining budget between phases`,
    );
  }
});

test("a warm-up that succeeds too late skips the sweep rather than racing the timeout", () => {
  const body = readFileSync(path.join(root, "src/lib/cronPreflight.ts"), "utf8");
  assert.match(body, /insufficient-budget/, "there must be a distinct too-late outcome");
  assert.match(
    body,
    /remainingMs < options\.minStartBudgetMs/,
    "and it must be decided on the remaining budget",
  );
});

test("the preflight itself only ever runs SELECT 1", () => {
  const body = readFileSync(path.join(root, "src/lib/cronPreflight.ts"), "utf8");
  assert.match(body, /SELECT 1/, "the warm-up query should be trivial");
  // No writes, no sending — repeating it must cost nothing.
  for (const forbidden of ["$executeRaw", "update(", "create(", "delete(", "sendMail", "sendPush"]) {
    assert.ok(!body.includes(forbidden), `the preflight must have no side effects (found ${forbidden})`);
  }
});

/**
 * Prisma's interactive-transaction defaults (maxWait 2s, timeout 5s) assume the
 * database is next door. Against the hosted one a round trip is 300–700ms, and
 * the business transactions take 7–10 of them — so createQuoteRevision and
 * saveQuoteDraft failed with P2028 intermittently, AFTER the user had done the
 * work. Set once on the client, so every transaction in the app benefits rather
 * than the two that happened to be reported.
 */
test("interactive transactions are given a ceiling this database can meet", () => {
  const db = readFileSync(path.join(root, "src/lib/db.ts"), "utf8");
  const at = db.indexOf("new PrismaClient({");
  assert.ok(at > 0, "the client must configure transactions, not take the 5s default");
  const ctor = db.slice(at, db.indexOf("});", at));
  assert.match(ctor, /transactionOptions:/);
  assert.match(ctor, /maxWait: txMs\("PRISMA_TX_MAX_WAIT_MS", 10_000\)/);
  assert.match(ctor, /timeout: txMs\("PRISMA_TX_TIMEOUT_MS", 20_000\)/);

  // One construction point, so both the scoped and bypass clients inherit it —
  // configuring only one would leave half the app on the old default.
  assert.equal((db.match(/new PrismaClient\(/g) ?? []).length, 1, "there must be exactly one client construction");
  assert.match(db, /buildBypassClient\(_rawPrisma\)/);
  assert.match(db, /buildClient\(_rawPrisma\)/);
});

test("a bad override falls back rather than disabling the ceiling", () => {
  // An unset, empty, zero or non-numeric env var must not produce NaN — Prisma
  // would take that as "no timeout at all".
  const db = readFileSync(path.join(root, "src/lib/db.ts"), "utf8");
  const fn = db.slice(db.indexOf("const txMs ="), db.indexOf("const _rawPrisma"));
  assert.match(fn, /Number\.isFinite\(raw\) && raw > 0 \? raw : fallback/);
});
