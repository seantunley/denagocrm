import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";
import {
  analyzeSource,
  countsByKind,
  findingKey,
  nextBaseline,
  sweep,
  tally,
  tenantOwnedModels,
  type Finding,
} from "./tenantAccessSweep";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, "tests/fixtures/tenant-access-baseline.json");

/**
 * A DEBT RATCHET on tenant access outside the app-layer guard. NOT AN AUDIT, and it
 * must not be quoted as one.
 *
 * WHAT IT DETECTS — statically, by client provenance:
 *   bypass-read / bypass-write   `basePrisma` (or a `tx` from a basePrisma
 *                                transaction, or from withTenantWrite /
 *                                withActingTenantWrite) touching a tenant-owned
 *                                model without naming a tenant in the call's own
 *                                arguments.
 *   bypass-raw                   `basePrisma` raw SQL on a tenant-owned table with no
 *                                tenant predicate. It sets app.bypass_rls, so neither
 *                                the guard nor RLS bounds it.
 *   scoped-raw                   `prisma` raw SQL on a tenant-owned table with no
 *                                tenant predicate. Layer 2b sets app.current_tenant,
 *                                so RLS bounds it — a weaker but real boundary. A
 *                                separate, lower-severity class, deliberately NOT
 *                                lumped in with bypass-raw.
 *   unknown-client               a `tx` / `client` / `db` parameter, or a
 *                                `(a ?? b).x` receiver, whose origin cannot be
 *                                resolved in this file. Counted, because assuming it
 *                                was the guarded client is the failure that would
 *                                make this file useless.
 *   global-user                  a tenant-facing surface enumerating the global
 *                                `User` table instead of listTenantStaff().
 *
 * WHAT IT PROVABLY CANNOT DETECT — none of the below moves this number:
 *   - a forged id in a form post reaching a correctly-scoped query;
 *   - ownerId / assignedToId / technicianId attribution, which is not tenancy;
 *   - blob storage paths, which have no tenant column and no RLS;
 *   - models with no `tenantId` column at all (they are not even in the model set);
 *   - enforcement simply being left off — `tenantEnforcing()` is false in every
 *     environment today, and while it is false EVERY `prisma` call in this codebase
 *     is unscoped, including the ~1,170 the sweep deliberately reports as guarded;
 *   - RLS being bypassed by the connecting role (a BYPASSRLS role makes `scoped-raw`
 *     and every RLS argument here vacuous);
 *   - a tenant named in the arguments but taken from the wrong place — the heuristic
 *     reads that a tenant is mentioned, never that it is the right one.
 *
 * A falling number is a smaller amount of a specific kind of debt. It is not
 * evidence of tenant isolation, and this file must never be cited as such.
 *
 * WHY A RATCHET. There are hundreds today. A test demanding zero would be red on the
 * day it landed and switched off by the end of the week, which is worse than no test.
 * So: a NEW finding fails with its file and line, and a FIXED one also fails, asking
 * for the baseline to be lowered. `UPDATE_TENANT_BASELINE=1` records a deliberate
 * change and — see nextBaseline — is physically unable to record an increase.
 *
 * A new finding that is NOT going to be fixed therefore cannot be recorded by
 * re-running the updater. It has to be written by hand into `ACKNOWLEDGED` below,
 * with the reasoning, where it shows up in review as prose rather than as an integer
 * nobody can distinguish from the inherited debt around it.
 */

const { findings, stats } = sweep(root, GLOBAL_MODELS);
const current = tally(findings);
const stored: Record<string, number> = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : {};

/**
 * DELIBERATE, HAND-WRITTEN ADDITIONS to the baseline — the only way a number may go
 * up, and it is not a machine.
 *
 * The fixture is machine-written and `nextBaseline` can only lower it. That is the
 * whole mechanism, so a genuinely new finding cannot be recorded by re-running the
 * updater, and must not be: `UPDATE_TENANT_BASELINE=1` on a branch that introduced
 * one refuses the entire write.
 *
 * This is the other door and it is deliberately narrow. It is source, so it appears
 * in the diff as prose rather than as one more integer in a 200-line JSON file where
 * no reviewer can tell a deliberate acceptance from the 190 lines of inherited debt
 * around it, and every entry has to say why next to the number it excuses. Three
 * rules keep it from becoming an exemption list, all enforced below:
 *
 *   - it is a CEILING, never a floor. An entry above what the sweep actually finds
 *     is slack a future finding can hide in, so an over-large entry fails.
 *   - it cannot SHADOW the fixture. A key already in the JSON must be ratcheted
 *     there, not overridden here.
 *   - the updater never folds these into the fixture, so the number can never drift
 *     away from the comment that justifies it.
 */
const ACKNOWLEDGED: Record<string, number> = {
  /**
   * #466's `createStage` / `moveStage` in src/app/actions/settings.ts. Three reads
   * of PipelineStage on `basePrisma`, and they are NOT the same case as each other.
   *
   * TWO ARE CONTAINED. settings.ts:81 (`aggregate` for the next `order`) and
   * settings.ts:178 (`findMany` of the sibling stages) both run AFTER
   * `requireOwnedPipeline()` and are bounded by the `pipelineId` that gate just
   * proved this workspace owns. They are unscoped on purpose: `PipelineStage`
   * inherits its owner from its parent pipeline, and a guarded read scoped to the
   * ACTING tenant returns nothing whenever the actor's workspace is not the
   * pipeline's — which is order 0, which is a duplicate-key collision on
   * ("pipelineId", "order"). The parent is the boundary here and the gate is where
   * it is applied.
   *
   * ONE IS NOT, AND IS AN OPEN FINDING. settings.ts:151 —
   * `basePrisma.pipelineStage.findUnique({ where: { id }, select: { pipelineId } })`
   * — runs BEFORE `requireOwnedPipeline()`, on an `id` that is a bound server-action
   * argument and therefore forgeable. Its value does not escape (it is used only as
   * the key to the gate that then refuses), but the OUTCOME does: a stage id that
   * exists in another workspace reaches the gate and fails with `throw new Error`,
   * which `asActionResult` renders as a generic message plus a reference, while an
   * id that exists nowhere hits `refuse("That stage no longer exists")` and renders
   * verbatim. Two distinguishable answers is a one-bit cross-workspace existence
   * oracle on stage ids. Narrow — it needs an id you already hold — but real, and
   * the read itself does cross the boundary.
   *
   * Recorded rather than fixed because the fix is a change to #466's production
   * code (bounding the lookup through its parent pipeline in one query, so the gate
   * and the read are the same statement) and this PR changes nothing under src/.
   * It is called out in the PR body so it is picked up rather than absorbed.
   */
  "src/app/actions/settings.ts::bypass-read::PipelineStage": 3,
};

const baseline: Record<string, number> = { ...stored, ...ACKNOWLEDGED };

// The ONLY writer. It cannot raise a number (nextBaseline takes min and refuses on
// any increase), so it is safe here even though module scope runs before assertions —
// the ordering bug that let the previous revision record brand-new violations as
// "the baseline" cannot reproduce.
const update = process.env.UPDATE_TENANT_BASELINE
  ? nextBaseline(baseline, current)
  : null;
if (update?.ok) {
  // Acknowledgements stay in source. Writing them into the fixture would separate
  // each number from the paragraph that justifies it, and the next reader would find
  // a bare integer indistinguishable from inherited debt.
  const written = { ...update.baseline };
  for (const key of Object.keys(ACKNOWLEDGED)) delete written[key];
  writeFileSync(BASELINE, `${JSON.stringify(written, null, 2)}\n`);
}

// One-time creation of a fixture that does not exist yet. Refuses to run when one
// does, so it can never be used to launder an increase into the baseline.
if (process.env.TENANT_BASELINE_BOOTSTRAP && !existsSync(BASELINE)) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
}

const linesFor = (key: string) =>
  findings.filter((f) => findingKey(f) === key).map((f) => `${f.line} (via ${f.via})`).join(", ");

test("no NEW tenant access outside the guard", () => {
  const added: string[] = [];
  for (const [key, count] of Object.entries(current)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) {
      const [file, kind, model] = key.split("::");
      added.push(`${file}  ${kind} on ${model}  (was ${allowed}, now ${count}; lines ${linesFor(key)})`);
    }
  }
  assert.deepEqual(
    added.sort(),
    [],
    "These reach a tenant-owned model on a path the app-layer guard does not cover.\n" +
      "Name the tenant in the call itself (where: { …, tenantId }, data: { …, tenantId },\n" +
      "or an explicit SQL predicate), or move the call to the guarded `prisma` client:\n  " +
      added.join("\n  "),
  );
});

test("the baseline only ever goes down", () => {
  // Over the FIXTURE, not the merged view: an acknowledgement that has dropped is a
  // different repair with a different instruction, and pointing the updater at one
  // would never clear it (the updater deliberately does not write them).
  const fixed: string[] = [];
  for (const [key, allowed] of Object.entries(stored)) {
    const count = current[key] ?? 0;
    if (count < allowed) fixed.push(`${key}  (baseline ${allowed}, now ${count})`);
  }
  assert.deepEqual(
    fixed.sort(),
    [],
    "Good news — these are gone. Lower the baseline so they cannot come back:\n" +
      "  UPDATE_TENANT_BASELINE=1 npm run test:unit\n" +
      "(If the whole list is here, the scanner broke rather than the debt being fixed —\n" +
      "check that src/ still parses and that the patterns still match.)\n  " +
      fixed.join("\n  "),
  );
});

test("an acknowledgement is a ceiling, cannot shadow the fixture, and cannot rot", () => {
  const shadowed = Object.keys(ACKNOWLEDGED).filter((key) => key in stored);
  assert.deepEqual(
    shadowed.sort(),
    [],
    "These are already ratcheted in the fixture. Lower them there rather than\n" +
      "overriding them from source, or the two numbers disagree and the higher wins:\n  " +
      shadowed.join("\n  "),
  );

  const slack: string[] = [];
  for (const [key, allowed] of Object.entries(ACKNOWLEDGED)) {
    const count = current[key] ?? 0;
    if (count < allowed) slack.push(`${key}  (acknowledged ${allowed}, now ${count})`);
  }
  assert.deepEqual(
    slack.sort(),
    [],
    "An acknowledgement is a ceiling on a KNOWN set of sites, and these now sit above\n" +
      "what the sweep finds. The gap is room for a new finding to arrive unnoticed.\n" +
      "Lower the number in ACKNOWLEDGED — or delete the entry and its comment if the\n" +
      "sites are gone, which is the outcome it exists to make visible:\n  " +
      slack.join("\n  "),
  );
});

test("UPDATE_TENANT_BASELINE cannot raise the baseline", () => {
  if (!update) return; // not requested on this run
  assert.ok(
    update.ok,
    "Refused to write the baseline: these would have gone UP, which is the one thing a\n" +
      "ratchet may not do. Fix the finding instead of recording it:\n  " +
      (update.ok ? "" : update.increases.join("\n  ")),
  );
});

/* ─────────────────────── the detector, on synthetic input ───────────────────────
 * The previous revision proved the patterns still worked by asserting every category
 * was non-empty against the real codebase — which meant fixing all twelve global-user
 * sites would have FAILED the suite. Exactly backwards. These fixtures prove the
 * classifier instead, and they keep passing as the real debt goes to zero.
 */

const MODELS = new Set(["Quote", "Lead", "Campaign"]);
const APP_FILE = "src/app/(app)/quotes/page.tsx";
const LIB_FILE = "src/lib/quotes.ts";

const kindsOf = (source: string, file = LIB_FILE) =>
  analyzeSource(file, source, MODELS).findings.map((f) => f.kind).sort();

test("guarded client: nothing the guard scopes is reported", () => {
  // findUnique IS scoped under enforcement — scopeArgs routes it through scopeWhere,
  // which adds tenantId to the where via Prisma 6 extendedWhereUnique. The previous
  // revision called 233 of these "unscopable before OR after enforcement" and made it
  // the headline number. It was wrong, and this is the regression test for it.
  assert.deepEqual(kindsOf(`const q = await prisma.quote.findUnique({ where: { id } });`), []);
  assert.deepEqual(kindsOf(`await prisma.quote.findMany({ where: { status: "open" } });`), []);
  assert.deepEqual(kindsOf(`await prisma.lead.create({ data: { name } });`), []);
  assert.deepEqual(kindsOf(`await prisma.quote.delete({ where: { id } });`), []);
});

test("bypass-read: basePrisma reads, unless the call names a tenant", () => {
  assert.deepEqual(kindsOf(`await basePrisma.quote.findMany({ where: { status: "open" } });`), ["bypass-read"]);
  assert.deepEqual(kindsOf(`await basePrisma.quote.findUnique({ where: { id } });`), ["bypass-read"]);
  assert.deepEqual(kindsOf(`await basePrisma.quote.findMany({ where: { status: "open", tenantId } });`), []);
});

test("bypass-write: basePrisma writes, unless the call stamps a tenant", () => {
  assert.deepEqual(kindsOf(`await basePrisma.quote.create({ data: { total: 1 } });`), ["bypass-write"]);
  assert.deepEqual(kindsOf(`await basePrisma.quote.update({ where: { id }, data: { total: 1 } });`), ["bypass-write"]);
  assert.deepEqual(kindsOf(`await basePrisma.quote.create({ data: { total: 1, tenantId } });`), []);
});

test("bypass-raw is separated from scoped-raw, because the GUCs are opposites", () => {
  // basePrisma raw sets app.bypass_rls — nothing bounds it.
  assert.deepEqual(kindsOf("await basePrisma.$queryRaw`SELECT id FROM \"Quote\"`;"), ["bypass-raw"]);
  // prisma raw sets app.current_tenant (db.ts Layer 2b) — RLS bounds it. Tracked, but
  // as its own lower-severity class.
  assert.deepEqual(kindsOf("await prisma.$queryRaw`SELECT id FROM \"Quote\"`;"), ["scoped-raw"]);
  // An explicit predicate in the SQL settles it either way.
  assert.deepEqual(
    kindsOf('await basePrisma.$queryRaw`SELECT id FROM "Quote" WHERE "tenantId" = ${tenantId}`;'),
    [],
  );
  // A table with no tenant column is not this sweep's business.
  assert.deepEqual(kindsOf('await basePrisma.$queryRaw`SELECT id FROM "BackupRun"`;'), []);
  // A SQL comment lives inside the template literal, where the JS-level comment
  // masking cannot reach it. It must not be able to excuse the query either.
  assert.deepEqual(
    kindsOf('await basePrisma.$queryRaw`\n  -- scoped by tenantId upstream\n  SELECT id FROM "Quote"`;'),
    ["bypass-raw"],
  );
});

test("raw SQL is still found through a generic and a nested template", () => {
  // `$queryRaw<Array<{ id: string; total: bigint }>>` — semicolons and nested angle
  // brackets in the type argument, and a regex quantifier `{1,6}` inside the SQL.
  const source = [
    'const rows = await basePrisma.$queryRaw<Array<{ id: string; total: bigint }>>(Prisma.sql`',
    '  SELECT "id" FROM "Quote"',
    "  WHERE SUBSTRING(\"ref\" FROM ${`^Q-([0-9]{1,6})$`}) IS NOT NULL",
    "`);",
  ].join("\n");
  assert.deepEqual(kindsOf(source), ["bypass-raw"]);
});

test("tx provenance decides, not the identifier `tx`", () => {
  const body = `await tx.quote.update({ where: { id }, data: { total: 1 } });`;
  // From the guarded client: the extension still applies, so this is scoped.
  assert.deepEqual(kindsOf(`await prisma.$transaction(async (tx) => { ${body} });`), []);
  // From the bypass client: nothing scopes it.
  assert.deepEqual(kindsOf(`await basePrisma.$transaction(async (tx) => { ${body} });`), ["bypass-write"]);
  // withTenantWrite hands back a tenantId precisely because it does NOT stamp for you.
  assert.deepEqual(kindsOf(`await withTenantWrite(async (tx, tenantId) => { ${body} });`), ["bypass-write"]);
  assert.deepEqual(
    kindsOf(
      "await withTenantWrite(async (tx, tenantId) => { await tx.quote.update({ where: { id, tenantId }, data: { total: 1 } }); });",
    ),
    [],
  );
  // withActingTenantWrite (#473) opens on basePrisma too — it resolves a different
  // ANSWER for the tenantId (the acting workspace, not the founding tenant), which is
  // not a different client. Before it was recognised, every call site fell through to
  // `unknown-client`: fail-closed, so nothing was hidden, but the wrong category and
  // it moved two sites off their real `bypass-write` entries.
  assert.deepEqual(kindsOf(`await withActingTenantWrite(async (tx, tenantId) => { ${body} });`), ["bypass-write"]);
  assert.deepEqual(
    kindsOf(
      "await withActingTenantWrite(async (tx, tenantId) => { await tx.quote.update({ where: { id, tenantId }, data: { total: 1 } }); });",
    ),
    [],
  );
  // …including with an explicit type argument, which is how fleets.ts calls it. The
  // old fixed-offset `indexOf("(")` lands INSIDE `<{ id: string }>` on this shape.
  assert.deepEqual(
    kindsOf("const f = await withActingTenantWrite<{ id: string }>((tx, tenantId) => tx.quote.create({ data: { total: 1 } }));"),
    ["bypass-write"],
  );
  // The helper's own declaration is not a call site and must bind no `tx`.
  assert.deepEqual(
    kindsOf(
      "export async function withActingTenantWrite<T>(fn: (tx: any, tenantId: string) => Promise<T>): Promise<T> { return null as never; }\n" +
        `export async function apply(tx: TenantWriteTx) { ${body} }`,
    ),
    ["unknown-client"],
  );
  // Provenance we cannot see: a tx handed in from another file. Fail closed.
  assert.deepEqual(kindsOf(`export async function apply(tx: TenantWriteTx) { ${body} }`), ["unknown-client"]);
  // …and a receiver that is an expression rather than a name.
  assert.deepEqual(
    kindsOf('await (tx ?? basePrisma).$queryRaw`SELECT id FROM "Quote"`;'),
    ["unknown-client"],
  );
  // The INNERMOST transaction wins.
  assert.deepEqual(
    kindsOf(`await prisma.$transaction(async (outer) => { await basePrisma.$transaction(async (tx) => { ${body} }); });`),
    ["bypass-write"],
  );
});

test("a comment or a string cannot excuse a call", () => {
  // The old heuristic scanned 400-600 characters INCLUDING comments, so a nearby
  // mention of tenantId made an unscoped write disappear from the report. A false
  // negative that produces green CI is the most dangerous direction there is.
  assert.deepEqual(
    kindsOf(`// safe: tenantId is applied upstream\nawait basePrisma.quote.create({ data: { total: 1 } });`),
    ["bypass-write"],
  );
  assert.deepEqual(
    kindsOf(`/* tenantId */\nawait basePrisma.quote.findMany({ where: { status: "open" } });`),
    ["bypass-read"],
  );
  assert.deepEqual(
    kindsOf(`await basePrisma.quote.create({ data: { note: "tenantId is handled" } });`),
    ["bypass-write"],
  );
  // And a tenant named in the NEXT call must not exempt this one.
  assert.deepEqual(
    kindsOf(
      `await basePrisma.quote.create({ data: { total: 1 } });\nawait basePrisma.lead.create({ data: { tenantId } });`,
    ),
    ["bypass-write"],
  );
});

test("global-user only fires on tenant-facing surfaces", () => {
  const call = `const staff = await prisma.user.findMany({ orderBy: { name: "asc" } });`;
  assert.deepEqual(kindsOf(call, APP_FILE), ["global-user"]);
  assert.deepEqual(kindsOf(call, "src/app/platform/(console)/tenants/page.tsx"), []);
  assert.deepEqual(
    kindsOf(`await prisma.user.findMany({ where: { memberships: { some: { tenantId } } } });`, APP_FILE),
    [],
  );
});

test("a stray apostrophe in JSX does not blind the scanner", () => {
  // Masking string literals is what stops a comment from excusing a call; if it ran
  // away at an apostrophe in JSX prose it would silently swallow the rest of the file.
  const source = [
    "export default function Page() {",
    "  const rows = await basePrisma.quote.findMany({ where: { status: \"open\" } });",
    "  return <p>Don't worry about the quote</p>;",
    "}",
    "async function more() { await basePrisma.lead.create({ data: { name } }); }",
  ].join("\n");
  assert.deepEqual(kindsOf(source, APP_FILE), ["bypass-read", "bypass-write"]);
});

test("line numbers survive masking", () => {
  const source = ["// a comment", "", "await basePrisma.quote.create({ data: {} });"].join("\n");
  const only = analyzeSource(LIB_FILE, source, MODELS).findings[0] as Finding;
  assert.equal(only.line, 3);
  assert.equal(only.via, "basePrisma");
});

/* ───────────────────────────── the ratchet mechanism ──────────────────────────── */

test("nextBaseline refuses every increase and names it", () => {
  const grew = nextBaseline({ "a.ts::bypass-read::Quote": 2 }, { "a.ts::bypass-read::Quote": 3 });
  assert.equal(grew.ok, false);
  assert.match(grew.ok ? "" : grew.increases.join(), /a\.ts::bypass-read::Quote.*allowed 2, now 3/);

  const brandNew = nextBaseline({}, { "b.ts::bypass-write::Lead": 1 });
  assert.equal(brandNew.ok, false, "a finding with no baseline entry is an increase, not a new normal");

  // Even mixed with a decrease elsewhere, the whole write is refused.
  const mixed = nextBaseline(
    { "a.ts::bypass-read::Quote": 5, "b.ts::bypass-write::Lead": 1 },
    { "a.ts::bypass-read::Quote": 1, "b.ts::bypass-write::Lead": 2 },
  );
  assert.equal(mixed.ok, false);
});

test("nextBaseline lowers, and drops entries that reached zero", () => {
  const result = nextBaseline(
    { "a.ts::bypass-read::Quote": 5, "b.ts::bypass-write::Lead": 2, "c.ts::scoped-raw::Campaign": 1 },
    { "a.ts::bypass-read::Quote": 3, "b.ts::bypass-write::Lead": 2 },
  );
  assert.ok(result.ok);
  assert.deepEqual(result.ok ? result.baseline : {}, {
    "a.ts::bypass-read::Quote": 3,
    "b.ts::bypass-write::Lead": 2,
  });
  // min(), so no entry can grow even if it is called with the arguments reversed.
  const reversed = nextBaseline({ "a.ts::bypass-read::Quote": 3 }, { "a.ts::bypass-read::Quote": 3 });
  assert.deepEqual(reversed.ok ? reversed.baseline : {}, { "a.ts::bypass-read::Quote": 3 });
});

test("the sweep is reading the schema and the source tree", () => {
  // Not a debt assertion — these hold whether the count is 300 or 0.
  const models = tenantOwnedModels(root, GLOBAL_MODELS);
  assert.ok(models.size > 100, `expected the tenant-owned model set, got ${models.size}`);
  assert.ok(models.has("Lead") && models.has("Quote") && models.has("SalesPipeline"));
  for (const global of ["User", "Tenant", "Permission", "BackupRun"]) {
    assert.ok(!models.has(global), `${global} is global by design and must not be swept`);
  }
  assert.ok(stats.files > 500, `expected the source tree, walked ${stats.files} files`);
  assert.ok(stats.guardedModelOps > 500, "found almost no guarded model ops — the scanner is not parsing src/");
});

test("the sweep source has no smuggled control characters", () => {
  // Not paranoia. An earlier revision of tenantAccessSweep.ts was written through a
  // shell heredoc, which turned a `\b` into a literal 0x08 byte; two patterns could
  // then never match, the count for both read zero, and the suite looked green.
  const source = readFileSync(path.join(root, "tests/tenantAccessSweep.ts"), "latin1");
  const bad = [...source].map((c, i) => [c.charCodeAt(0), i]).filter(([code]) => code < 9 || (code > 13 && code < 32));
  assert.deepEqual(bad, [], `control bytes in the sweep source at ${JSON.stringify(bad.slice(0, 5))}`);
});

test("summary", () => {
  // Printed so a reviewer sees the shape of the debt without opening the fixture.
  const byKind = countsByKind(findings);
  console.log(
    `  tenant-access sweep: ${findings.length} findings over ${stats.files} files ` +
      `(${stats.guardedModelOps} guarded model ops not reported)\n  ` +
      Object.entries(byKind)
        .sort(([, a], [, b]) => b - a)
        .map(([k, n]) => `${k}=${n}`)
        .join("  "),
  );
});
