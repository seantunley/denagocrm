import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("historic node labels come from immutable published definitions, not the mutable draft", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /FROM "BotFlowVersion"/);
  /*
   * `createdAt` — the column BotFlowVersion actually has.
   *
   * This assertion pinned `publishedAt`, which the table has never had, so it
   * was holding a query Postgres rejected outright: `42703: column
   * "publishedAt" does not exist`, on every call, verified against production.
   * The test passed the whole time because it only ever read the SOURCE STRING;
   * a raw query's columns are never checked against the database by anything in
   * the type system or the test suite.
   *
   * Pinned again rather than loosened, because the point of the test is
   * unchanged — the report reads the IMMUTABLE published snapshot, not the
   * mutable draft — and a literal is what proves the read still targets
   * BotFlowVersion's own columns.
   */
  assert.match(code, /SELECT "id", "version", "createdAt", "definition"/);
  // Scoped to the SQL, not the file: `publishedAt` is still a perfectly good
  // FIELD on the exported report — a row is the publication — it is just not a
  // COLUMN. Asserting over the whole source would forbid the public name too.
  const sql = code.slice(code.indexOf('SELECT "id", "version"'), code.indexOf("ORDER BY \"version\" DESC"));
  assert.doesNotMatch(sql, /"publishedAt"/, "BotFlowVersion has no such column — see 42703");
  assert.doesNotMatch(code, /botFlow\.findUnique[\s\S]+definition/);
  assert.match(code, /The mutable draft is not[\s\S]+used to label historic nodes/);
});

test("analytics reporting uses explicit tenant predicates for bypassed raw reads", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  assert.ok((code.match(/"tenantId" = \$\{tenantId\}/g) ?? []).length >= 2);
  assert.match(code, /"flowId" = \$\{flowId\}/);
});

test("drop-off is only calculated for deterministic waiting-node interactions", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /node\?\.type === "choice" \|\| node\?\.type === "capture" \|\| node\?\.type === "captureFile" \|\| node\?\.type === "slots"/);
  assert.match(code, /dropOff: interactive \? Math\.max\(reached - \(interacted \?\? 0\), 0\) : null/);
  assert.match(code, /progressionRate: interactive && reached > 0/);
});

test("report surface is explicit about the current analytics scope", () => {
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(page, /Selected-version funnel/);
  assert.match(page, /Reach is a recorded visit to a waiting node/);
  // One-shot automatic graphs are now counted, so the surface must say they are
  // included rather than carrying the old "not counted yet" caveat.
  assert.match(page, /automatic one-shot graphs/);
  assert.match(page, /stateful guided conversations/);
});

test("report includes channel, completion, handoff and node funnel views", () => {
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(page, /Channel performance/);
  assert.match(page, /Completed/);
  assert.match(page, /Handed off/);
  assert.match(page, /Progressed/);
  assert.match(page, /Drop-off/);
});

test("report filters immutable versions by bounded date range and channel", () => {
  const report = src("src/lib/botFlowAnalyticsReport.ts");
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(report, /normalizeBotAnalyticsFilters/);
  assert.match(report, /AND "occurredAt" >= \$\{filters\.occurredFrom\}/);
  assert.match(report, /AND "channel" = \$\{filters\.channel\}/);
  assert.match(page, /Published version/);
  assert.match(page, /All channels/);
  assert.match(page, /Last \{days\} days/);
  assert.match(page, /Date boundaries use UTC calendar days/);
});

test("report adds daily trend, CRM outcomes, and zero-safe version comparison", () => {
  const report = src("src/lib/botFlowAnalyticsReport.ts");
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(report, /date_trunc\('day', "occurredAt"\)/);
  assert.match(report, /"metadata" ->> 'action'/);
  assert.match(report, /LEFT JOIN "BotFlowEvent" e/);
  assert.match(report, /COUNT\(e\."id"\)/);
  assert.match(page, /Daily trend/);
  assert.match(page, /CRM outcomes/);
  assert.match(page, /Version comparison/);
});

test("version comparison scopes both sides of its join to the current tenant", () => {
  const report = src("src/lib/botFlowAnalyticsReport.ts");
  const comparison = report.slice(report.indexOf('FROM "BotFlowVersion" v'));
  assert.match(comparison, /e\."tenantId" = \$\{tenantId\}/);
  assert.match(comparison, /v\."tenantId" = \$\{tenantId\}/);
  assert.match(comparison, /v\."flowId" = \$\{flowId\}/);
});
