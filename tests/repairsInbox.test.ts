import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaRepairsSpy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Repairs turns the failures nothing else reports into a list with a button.
 *
 * These are BEHAVIOURAL tests wherever the logic is behaviour. `repairs.ts` and
 * `repairsDetectors.ts` are `server-only` and import a live PrismaClient, so the
 * unit runner cannot load them as shipped — the `server-only` marker package is
 * not installed (Next vendors it behind an RSC export condition) and `./db`
 * builds a real client against DATABASE_URL. Both are swapped by intercepting
 * the module loader and then requiring the real modules through it, which buys
 * the SHIPPED functions running their REAL queries against an in-memory table,
 * rather than reading their source and hoping.
 *
 * Each swap is anchored on the REQUESTING file, so the spy cannot be handed to
 * some unrelated module that happens to import the same path.
 */
process.env.SETTINGS_ENCRYPTION_KEY = "a".repeat(64);

let enabledModules = new Set<string>(["core", "marketing"]);

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: { filename?: string } | undefined) =>
  parent?.filename ? path.basename(parent.filename) : "";
const DB_CONSUMERS = new Set(["repairs.ts", "repairsDetectors.ts", "tenantWrite.ts", "settings.ts"]);

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "./db" && DB_CONSUMERS.has(from(parent))) {
    return { prisma: spy.prisma, basePrisma: spy.basePrisma };
  }
  if (request === "./errorLog" && from(parent) === "repairsDetectors.ts") {
    return { logError: async () => {} };
  }
  if (request === "./modules/enabled" && from(parent) === "repairsDetectors.ts") {
    return { getEnabledModuleIds: async () => enabledModules };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const load = createRequire(import.meta.url);
const repairs = load("../src/lib/repairs.ts") as typeof import("../src/lib/repairs");
const detectors = load("../src/lib/repairsDetectors.ts") as typeof import("../src/lib/repairsDetectors");

/**
 * The tenant every read and write resolves to while enforcement is dormant.
 * Imported rather than spelled out, so the tests follow the founding tenant if
 * it is ever renamed instead of silently asserting against a dead string.
 */
const TENANT = (load("../src/lib/tenant.ts") as typeof import("../src/lib/tenant")).DEFAULT_TENANT_ID;

const report = (
  detector: string,
  issues: Array<Partial<import("../src/lib/repairs").RaisedIssue> & { key: string }>,
  complete = true,
): import("../src/lib/repairs").DetectorReport => ({
  detector,
  complete,
  issues: issues.map((issue) => ({
    severity: "warning" as const,
    title: "t",
    description: "d",
    ...issue,
  })),
});

const issueRow = (over: Record<string, unknown> = {}) => ({
  id: `seeded-${String(over.key ?? "x")}`,
  tenantId: TENANT,
  detector: "det.a",
  key: "det.a:1",
  severity: "warning",
  title: "t",
  description: "d",
  fixRoute: null,
  firstSeenAt: new Date("2026-01-01T00:00:00Z"),
  lastSeenAt: new Date("2026-01-01T00:00:00Z"),
  resolvedAt: null,
  ignoredAt: null,
  ignoredById: null,
  ...over,
});

const ops = () => spy.calls.map((call) => `${call.model}.${call.op}`);

/* ── the reconciliation engine ────────────────────────────────────────── */

test("a workspace with nothing wrong costs one read and no writes at all", async () => {
  // This runs once PER TENANT on every automations tick and finds nothing on
  // almost all of them. One indexed read answers "is anything open?" for EVERY
  // detector at once; a tick that also issued a write would be housekeeping
  // costing more than the thing it keeps.
  spy.reset();
  const result = await repairs.syncRepairIssues([report("det.a", []), report("det.b", [])]);

  assert.deepEqual(result, { raised: 0, refreshed: 0, resolved: 0 });
  assert.deepEqual(ops(), ["repairIssue.findMany"], "the healthy case must be one read and nothing else");
});

test("re-detecting the same problem does not duplicate it", async () => {
  // THE IDEMPOTENCY GUARANTEE. The detectors run every fifteen minutes forever;
  // a registry that appended would have thousands of rows for one broken
  // journey by the end of the week.
  spy.reset();
  const first = await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:1", description: "one" }])]);
  const bornAt = spy.rows("repairIssue")[0].firstSeenAt as Date;
  const second = await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:1", description: "two" }])]);
  const third = await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:1", description: "three" }])]);

  assert.deepEqual(
    [first, second, third].map((r) => `${r.raised}/${r.refreshed}`),
    ["1/0", "0/1", "0/1"],
    "raised once, then re-confirmed",
  );
  assert.equal(spy.rows("repairIssue").length, 1, "one problem is one row, however many times it is seen");
  const [row] = spy.rows("repairIssue");
  assert.equal(row.description, "three", "the wording is refreshed on every re-detection");
  assert.equal(
    (row.firstSeenAt as Date).getTime(),
    bornAt.getTime(),
    "…but first-seen is not, or 'this has been broken since Tuesday' is lost",
  );
  assert.ok((row.lastSeenAt as Date) > bornAt, "last-confirmed moves with every tick");
});

test("a problem that goes away clears itself", async () => {
  // Nobody has to remember to un-raise anything. A detector reports what is
  // TRUE, and an open issue it did not re-raise is a problem that has been
  // fixed — by the person this page told, or by whatever else changed.
  spy.reset({ repairIssue: [issueRow({ key: "det.a:1" })] });
  const result = await repairs.syncRepairIssues([report("det.a", [])]);

  assert.equal(result.resolved, 1);
  assert.ok(spy.rows("repairIssue")[0].resolvedAt instanceof Date, "the row must be resolved, not deleted");
});

test("an incomplete detector may raise but may never clear", async () => {
  // THE ONE THAT MATTERS. "Resolve what I did not re-raise" is only sound if
  // the detector actually looked at everything. A run that bailed early, hit
  // its cap, or ran with a feature pack switched off has an incomplete picture,
  // and clearing from it would mark real, unfixed problems as solved — which is
  // precisely the silence this whole surface exists to end.
  spy.reset({ repairIssue: [issueRow({ key: "det.a:1" })] });
  const result = await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:2" }], false)]);

  assert.equal(result.raised, 1, "an incomplete run may still raise what it did see");
  assert.equal(result.resolved, 0);
  assert.equal(
    spy.rows("repairIssue").find((row) => row.key === "det.a:1")?.resolvedAt,
    null,
    "a partial view must never resolve what it did not look at",
  );
});

test("a detector cannot clear another detector's issues", async () => {
  // Namespacing is not tidiness. Every detector reports in the same call, so a
  // sweep keyed on "not raised this tick" rather than "not raised by ME this
  // tick" would have each detector silently resolving all the others.
  spy.reset({
    repairIssue: [issueRow({ key: "det.a:1", detector: "det.a" }), issueRow({ key: "det.b:1", detector: "det.b" })],
  });
  const result = await repairs.syncRepairIssues([report("det.a", [])]);

  assert.equal(result.resolved, 1);
  assert.equal(
    spy.rows("repairIssue").find((row) => row.detector === "det.b")?.resolvedAt,
    null,
    "det.b did not report at all — its rows must be untouched",
  );
});

test("ignoring a problem that never goes away keeps it hidden", async () => {
  // Otherwise Ignore is a button that does nothing: the next tick would
  // re-raise the same still-true problem and put it straight back on the page.
  spy.reset({ repairIssue: [issueRow({ key: "det.a:1", ignoredAt: new Date("2026-02-01"), ignoredById: "u1" })] });
  await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:1", description: "still broken" }])]);

  const [row] = spy.rows("repairIssue");
  assert.ok(row.ignoredAt instanceof Date, "a dismissal must survive re-confirmation of the SAME ongoing problem");
  assert.equal(row.description, "still broken", "…while the wording is still refreshed");
});

test("an issue that clears and later recurs comes back, dismissal and all", async () => {
  // A dismissal given while a problem existed says nothing about the problem
  // coming BACK, and hiding a recurrence behind a months-old click is how a
  // fixed bug quietly stops being fixed with the page reporting all clear.
  spy.reset({
    repairIssue: [
      issueRow({ key: "det.a:1", resolvedAt: new Date("2026-02-01"), ignoredAt: new Date("2026-01-15"), ignoredById: "u1" }),
    ],
  });
  const result = await repairs.syncRepairIssues([report("det.a", [{ key: "det.a:1" }])]);

  assert.equal(result.raised, 1);
  const [row] = spy.rows("repairIssue");
  assert.equal(row.resolvedAt, null, "the recurrence must reopen the row, not mint a second one");
  assert.equal(row.ignoredAt, null, "and the stale dismissal must not hide it");
  assert.equal(spy.rows("repairIssue").length, 1, "the key is derived from the problem, so it is the same row");
});

test("one detector cannot flood the registry, and a truncated run clears nothing", async () => {
  // A workspace can always be pathological. Five hundred journeys pointing at
  // one deleted template must not be five hundred writes every fifteen minutes
  // on a page nobody could read — and a view that had to be cut short is by
  // definition not the whole picture.
  spy.reset({ repairIssue: [issueRow({ key: "det.a:gone" })] });
  const flood = Array.from({ length: repairs.MAX_ISSUES_PER_DETECTOR + 10 }, (_, i) => ({ key: `det.a:${i}` }));
  const result = await repairs.syncRepairIssues([report("det.a", flood)]);

  assert.equal(result.raised, repairs.MAX_ISSUES_PER_DETECTOR, "the cap bounds the writes");
  assert.equal(
    spy.rows("repairIssue").find((row) => row.key === "det.a:gone")?.resolvedAt,
    null,
    "hitting the cap must revoke `complete`, or a truncated pass resolves everything it never reached",
  );
});

test("the page and the ignore action are scoped to one tenant by hand", async () => {
  // The db.ts tenant guard is DORMANT in every environment today — it only
  // scopes once TENANT_ENFORCEMENT=enforce — so "RepairIssue is a tenant-scoped
  // model" buys nothing yet. The id in the Ignore form is otherwise the whole
  // of the authorization, which is how a document scope leaked before it wrote
  // its predicate by hand.
  spy.reset({
    repairIssue: [
      issueRow({ key: "det.a:mine" }),
      issueRow({ key: "det.a:hidden", ignoredAt: new Date("2026-02-02") }),
      issueRow({ key: "det.a:theirs", tenantId: "someone-else" }),
    ],
  });

  const { open, ignored } = await repairs.listRepairIssues();
  assert.deepEqual(open.map((row) => row.key), ["det.a:mine"], "another tenant's issues are not ours to read");
  assert.deepEqual(
    ignored.map((row) => row.key),
    ["det.a:hidden"],
    "a dismissed issue stays retrievable — an ignore you cannot undo loses real problems to a mis-click",
  );

  assert.equal(
    await repairs.setRepairIssueIgnored("seeded-det.a:theirs", true, "u1"),
    0,
    "an id from another tenant must update nothing",
  );
  assert.equal(await repairs.setRepairIssueIgnored("seeded-det.a:mine", true, "u1"), 1);
});

/* ── the detectors ────────────────────────────────────────────────────── */

test("a template referenced from inside a choose branch is found too", () => {
  // A step list is flat at the top level and nests inside `choose` and `repeat`.
  // A template referenced three levels down is exactly as capable of being
  // deleted as one at the top, and exactly as silent when it is.
  const definition = {
    startStepId: "a",
    steps: [
      { id: "a", type: "send_email", config: { emailTemplateId: "top" } },
      {
        id: "b",
        type: "choose",
        config: {
          branches: [
            { sequence: [{ id: "c", type: "send_email", config: { emailTemplateId: " nested " } }] },
          ],
        },
      },
      { id: "d", type: "send_sms", config: { emailTemplateId: "not-an-email-step" } },
    ],
  };
  assert.deepEqual(
    [...detectors.referencedEmailTemplateIds(definition)].sort(),
    ["nested", "top"],
    "nested steps count, non-send_email steps do not, and the id is trimmed like the executor trims it",
  );
});

test("a journey whose email template was deleted is raised, and clears when it is fixed", async () => {
  // THE ONE THIS PAGE EXISTS FOR. journeyStepExecutor returns
  // `{ status: "skipped", note: "Email skipped: template was deleted" }` — the
  // step does not fail, the run completes, nothing is logged, and nobody in the
  // journey receives the email. There is no other surface in the app that says so.
  const seed = (templates: Array<{ id: string }>, carried: spy.Row[] = []) => ({
    repairIssue: carried,
    journey: [{ id: "j1", name: "Welcome", status: "active", activeVersion: 2 }],
    journeyVersion: [
      {
        journeyId: "j1",
        version: 2,
        state: "published",
        definition: { steps: [{ id: "s", type: "send_email", config: { emailTemplateId: "gone" } }] },
      },
      // An OLDER published version pointing at a different dead template. Runs
      // pinned to it are already in flight and cannot be re-pointed, so it must
      // not produce an issue nobody can act on.
      {
        journeyId: "j1",
        version: 1,
        state: "published",
        definition: { steps: [{ id: "s", type: "send_email", config: { emailTemplateId: "ancient" } }] },
      },
    ],
    emailTemplate: templates,
    journeyRun: [],
    tenantIntegrationCredential: [],
  });

  spy.reset(seed([]));
  await detectors.runRepairsDetectors();
  const raised = spy.rows("repairIssue").filter((row) => row.resolvedAt === null);
  assert.deepEqual(
    raised.map((row) => row.key),
    [`${detectors.JOURNEY_TEMPLATE_DETECTOR}:j1:gone`],
    "only the ACTIVE published version is actionable — the superseded one must not be reported",
  );
  assert.equal(raised[0].severity, "critical");
  assert.equal(raised[0].fixRoute, "/journeys");

  // Now the template exists again. Nobody clicked anything; the detector simply
  // stops reporting it — the row raised above is carried across so it is the
  // SAME row that has to clear.
  spy.reset(seed([{ id: "gone" }], raised.map((row) => ({ ...row }))));
  await detectors.runRepairsDetectors();
  assert.ok(
    spy.rows("repairIssue").every((row) => row.resolvedAt instanceof Date),
    "a fixed problem must clear itself",
  );
});

test("an active journey with nothing published is raised as its own issue", async () => {
  spy.reset({ journey: [{ id: "j2", name: "Nurture", status: "active", activeVersion: null }] });
  await detectors.runRepairsDetectors();

  const keys = spy.rows("repairIssue").map((row) => row.key);
  assert.deepEqual(keys, [`${detectors.JOURNEY_UNPUBLISHED_DETECTOR}:j2`]);
  assert.deepEqual(
    ops().filter((op) => op.startsWith("journeyVersion") || op.startsWith("emailTemplate")),
    [],
    "a journey with no published version costs no version lookup and no template lookup",
  );
});

test("a repeatedly failing journey is one issue whose key never moves", async () => {
  // The COUNT must not be in the key. It changes every tick, and a key that
  // changes is a new issue every tick — one broken journey would become an
  // unbounded pile of rows that Ignore could never keep up with.
  const runs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      journeyId: "j3",
      status: "failed",
      createdAt: new Date(),
    }));
  const base = { journey: [{ id: "j3", name: "Drip", status: "paused", activeVersion: null }] };

  spy.reset({ ...base, journeyRun: runs(4) });
  await detectors.runRepairsDetectors();
  const first = spy.rows("repairIssue").find((row) => row.detector === detectors.JOURNEY_RUNS_FAILING_DETECTOR);
  assert.ok(first, "four failures in the window is over the threshold");
  assert.equal(first.key, `${detectors.JOURNEY_RUNS_FAILING_DETECTOR}:j3`);
  assert.match(String(first.description), /^4 runs/);

  spy.reset({ ...base, journeyRun: runs(9), repairIssue: [{ ...first }] });
  await detectors.runRepairsDetectors();
  const rows = spy.rows("repairIssue").filter((row) => row.detector === detectors.JOURNEY_RUNS_FAILING_DETECTOR);
  assert.equal(rows.length, 1, "a moving count must refresh ONE row, never mint another");
  assert.match(String(rows[0].description), /^9 runs/, "…and the measurement lives in the description");
});

test("a quiet workspace never asks the failure question properly", async () => {
  // The early out. One indexed count, served by the (tenantId, status,
  // createdAt) index the retention sweep already added; below the threshold
  // nothing else runs.
  spy.reset({ journeyRun: [{ id: "r", journeyId: "j", status: "failed", createdAt: new Date() }] });
  await detectors.runRepairsDetectors();

  assert.deepEqual(
    ops().filter((op) => op.startsWith("journeyRun")),
    ["journeyRun.count"],
    "under the threshold there is nothing worth grouping",
  );
});

test("a credential that no longer decrypts is raised, tenant-scoped, without leaking it", async () => {
  // `getTenantCredentialOverride` swallows a decryption failure and returns
  // null, and `resolveTenantCredential` reads that as "no override" — so the
  // send either goes out on the platform's credentials or silently does not
  // happen. Nothing throws and nothing is logged; the settings page still shows
  // it as configured.
  spy.reset({
    tenantIntegrationCredential: [
      { tenantId: TENANT, key: "WA_ACCESS_TOKEN", value: "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA" },
      { tenantId: TENANT, key: "SMTP_PASS", value: "legacy-clear-text-still-readable" },
      { tenantId: "someone-else", key: "WA_ACCESS_TOKEN", value: "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA" },
    ],
  });
  await detectors.runRepairsDetectors();

  const raised = spy.rows("repairIssue").filter((row) => row.detector === detectors.CREDENTIAL_UNREADABLE_DETECTOR);
  assert.deepEqual(
    raised.map((row) => row.key),
    [`${detectors.CREDENTIAL_UNREADABLE_DETECTOR}:WA_ACCESS_TOKEN`],
    "the unreadable one is raised; a readable one is not; another tenant's is not ours to see",
  );
  // basePrisma BYPASSES the tenant extension, so the predicate has to be written
  // by hand — and it has to be the SAME tenant the issue row is stamped with.
  const read = spy.calls.find((call) => call.model === "tenantIntegrationCredential");
  assert.deepEqual((read?.args.where as { tenantId: string }).tenantId, TENANT);
  assert.equal(raised[0].tenantId, TENANT, "the detector must read and write as one tenant");
  for (const row of raised) {
    assert.doesNotMatch(String(row.description) + String(row.title), /enc:v1:/, "no ciphertext in an issue");
  }
});

test("switching the marketing pack off clears the journey issues instead of stranding them", async () => {
  // With the pack disabled /journeys is unreachable, so an issue whose Fix
  // button leads nowhere is worse than no issue. Empty-AND-complete is the
  // difference between clearing those rows and freezing them forever.
  spy.reset({
    repairIssue: [issueRow({ key: `${detectors.JOURNEY_TEMPLATE_DETECTOR}:j1:gone`, detector: detectors.JOURNEY_TEMPLATE_DETECTOR })],
    journey: [{ id: "j1", name: "Welcome", status: "active", activeVersion: null }],
  });
  enabledModules = new Set(["core"]);
  try {
    await detectors.runRepairsDetectors();
  } finally {
    enabledModules = new Set(["core", "marketing"]);
  }

  assert.ok(spy.rows("repairIssue")[0].resolvedAt instanceof Date, "the rows must clear");
  assert.deepEqual(ops().filter((op) => op.startsWith("journey")), [], "and no journey query may run at all");
});

/* ── schema, migration and gating contracts ───────────────────────────── */

test("the registry table sorts after everything it depends on", () => {
  // scripts/apply-migrations.mjs orders by `Number.parseInt(name, 10)`, NOT
  // lexicographically, so `81_foo` sorts as 81 and every timestamped migration
  // sorts as a 14-digit number. A numerically-prefixed name here would run
  // before half the schema exists.
  const dir = path.join(root, "prisma/migrations");
  const order = (name: string) => Number.parseInt(name, 10);
  const names = readdirSync(dir).filter((n) => existsSync(path.join(dir, n, "migration.sql")));

  const creator = names.find((n) =>
    /CREATE TABLE[^;]*"RepairIssue"/.test(readFileSync(path.join(dir, n, "migration.sql"), "utf8")),
  );
  assert.ok(creator, "no migration creates RepairIssue");
  assert.ok(order(creator!) > 20260803120000, `${creator} must sort after the latest migration on main`);

  const tooEarly = names.filter(
    (n) =>
      n !== creator &&
      order(n) < order(creator!) &&
      /"RepairIssue"/.test(readFileSync(path.join(dir, n, "migration.sql"), "utf8")),
  );
  assert.deepEqual(tooEarly, [], "these touch RepairIssue but sort before it is created");
});

test("every query the registry issues has an index, and the table has an RLS policy", () => {
  const migration = src("prisma/migrations/20260804100000_repairs_issue_registry/migration.sql");
  const schema = src("prisma/repairs.prisma");

  // Identity — the whole idempotency guarantee.
  assert.match(migration, /CREATE UNIQUE INDEX[^;]*ON "RepairIssue"\("tenantId", "key"\)/);
  assert.match(schema, /@@unique\(\[tenantId, key\]\)/);
  // The auto-clear sweep and the page read, both once per tenant.
  assert.match(migration, /CREATE INDEX[^;]*ON "RepairIssue"\("tenantId", "detector", "resolvedAt"\)/);
  assert.match(migration, /CREATE INDEX[^;]*ON "RepairIssue"\("tenantId", "resolvedAt", "lastSeenAt"\)/);
  assert.match(schema, /@@index\(\[tenantId, detector, resolvedAt\]\)/);
  assert.match(schema, /@@index\(\[tenantId, resolvedAt, lastSeenAt\]\)/);
  // tenantId LEADS every one of them: the sweep runs inside a per-tenant cron
  // slice, so a detector-leading index makes the busiest workspace set the cost
  // of the quietest one's tick.
  assert.doesNotMatch(schema, /@@index\(\[(?:detector|resolvedAt|lastSeenAt)/, "tenantId must lead every index");

  // FORCE RLS has been live since 20260727130000. A table added afterwards
  // without a policy has no DB-layer boundary at all.
  assert.match(migration, /ALTER TABLE "RepairIssue" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY "RepairIssue_tenant_isolation"/);
  assert.match(migration, /ALTER TABLE "RepairIssue" FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(
    migration.replace(/^\s*--.*$/gm, ""),
    /tenantId" IS NULL/,
    "there is no such thing as a shared repair issue — the column is NOT NULL for that reason",
  );

  // CONCURRENTLY cannot run inside Prisma's per-migration transaction; using it
  // would not trade a lock for availability, it would ship no index at all.
  assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ""), /CONCURRENTLY/);
});

test("/repairs is gated once, in the shared route table", () => {
  const rules = shipped("src/lib/routeAccess.ts");
  assert.match(rules, /\{ prefix: "\/repairs", owner: true \}/, "the edge rule must exist");
  for (const file of ["src/app/(app)/repairs/page.tsx", "src/app/(app)/repairs/layout.tsx"]) {
    assert.match(shipped(file), /requireOwner\(\)/, `${file} must apply the same rule the proxy applies`);
  }
  // A server action is reachable by a direct POST, so the page guard is not the
  // boundary. Both mutations restate it.
  const actions = shipped("src/app/actions/repairs.ts");
  assert.equal(
    (actions.match(/await requireOwner\(\)/g) ?? []).length,
    2,
    "every action must gate itself, not rely on the page",
  );
  assert.doesNotMatch(
    actions,
    /resolvedAt:\s*new Date\(\)/,
    "there is no human 'resolve' — only a detector may retract its own claim",
  );
});

test("the detectors run last on the cron, after everything that sends", () => {
  // Housekeeping must never win against sending. A tick that spent its last
  // seconds noticing a problem instead of delivering a message would be the
  // wrong trade every time.
  const route = shipped("src/app/api/cron/automations/route.ts");
  const repairsPhase = route.indexOf('phase("repairs-detectors"');
  assert.notEqual(repairsPhase, -1, "the detectors must run on the per-tenant cron");
  for (const sender of ['phase("campaign-queue"', 'phase("survey-distribution-queue"', 'phase("imap-sync"']) {
    const at = route.indexOf(sender);
    assert.notEqual(at, -1, `${sender} is gone — was it renamed?`);
    assert.ok(at < repairsPhase, `${sender} must run before the detectors (sender ${at}, repairs ${repairsPhase})`);
  }
  // Through `phase`, so it inherits the budget reserve rather than running
  // unconditionally at the edge of the deadline.
  assert.match(route, /await phase\("repairs-detectors", runRepairsDetectors/);
});
