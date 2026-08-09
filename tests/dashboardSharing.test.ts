import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source with CRLF normalised.
 *
 * This repo stores CRLF, so an anchor written with a bare newline silently never
 * matches — which reads as a missing guard rather than a broken test.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

/** …and with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const STORE = "src/lib/dashboard/store.ts";
const ACTION = "src/app/actions/dashboardConfig.ts";
const SCREEN = "src/components/dashboard/DashboardScreen.tsx";
const MIGRATION = "prisma/migrations/20260809120000_dashboard_sharing/migration.sql";

/**
 * OWNER BUILDS, STAFF VIEW.
 *
 * Dashboards were personal — every query scoped to the session user, and the
 * editor carried a comment noting that the first shared dashboard would arrive
 * fully editable by everyone who could open it unless something stopped it.
 * This is that something.
 */

// ── who may publish ─────────────────────────────────────────────────────────

test("only an owner can publish a dashboard", () => {
  const actions = code(ACTION);
  const fn = actions.slice(actions.indexOf("export async function setDashboardShared"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /requireOwner\(\)/, "everyone builds; only an owner publishes");
});

test("an owner can only publish their OWN dashboard", () => {
  // An owner publishing somebody else's private dashboard to the company would
  // be a surprising amount of power behind a toggle, and nobody asked for it.
  const actions = code(ACTION);
  const fn = actions.slice(actions.indexOf("export async function setDashboardShared"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /ownDashboard\(user\.id, slug\)/);
});

test("unpublishing keeps the record of who published", () => {
  // The trail of who exposed something to the whole workspace should not vanish
  // with the flag that did it.
  const actions = code(ACTION);
  const fn = actions.slice(actions.indexOf("export async function setDashboardShared"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  const unpublish = body.slice(body.indexOf(": {"));
  assert.match(unpublish, /sharedAt: null/);
  assert.doesNotMatch(unpublish, /sharedById: null/, "sharedById must survive unpublishing");
});

test("publishing and unpublishing are both audited", () => {
  const actions = code(ACTION);
  const fn = actions.slice(actions.indexOf("export async function setDashboardShared"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.match(body, /logAudit\(/);
  assert.match(body, /dashboard\.shared/);
  assert.match(body, /dashboard\.unshared/);
});

// ── what a viewer gets ──────────────────────────────────────────────────────

test("a shared dashboard renders read-only", () => {
  // Editing it would edit the AUTHOR's copy, for everybody who can see it.
  const screen = code(SCREEN);
  assert.match(screen, /canEdit=\{!dashboard\.shared\}/);
});

test("the viewer is told it is shared, not just denied the controls", () => {
  // A screen with no edit controls and no explanation reads as a permissions bug.
  const root = read("src/components/dashboard/editor/DashboardEditorRoot.tsx");
  assert.match(root, /Shared with you/);
});

test("a viewer's own dashboard wins over a shared one at the same address", () => {
  // Both can legitimately be called "sales". A single OR query would return
  // whichever row the planner reached first, so a person's own screen could be
  // displaced by something published over it — intermittently, which is the
  // worst way for that to behave.
  const store = code(STORE);
  const fn = store.slice(store.indexOf("dashboardBySlug"));
  const body = fn.slice(0, fn.indexOf("parseConfig"));
  const ownAt = body.indexOf("userId: user.id");
  const sharedAt = body.indexOf("sharedAt: { not: null }");
  assert.ok(ownAt !== -1 && sharedAt !== -1, "both lookups must exist");
  assert.ok(ownAt < sharedAt, "the viewer's own dashboard must be looked up first");
});

test("the switcher lists published dashboards alongside your own", () => {
  const store = code(STORE);
  assert.match(store, /OR: \[\{ userId: user\.id \}, \{ sharedAt: \{ not: null \} \}\]/);
  assert.match(store, /shared: row\.userId !== user\.id/, "each entry must know whose it is");
});

// ── what sharing must NOT do ────────────────────────────────────────────────

test("sharing never widens access to data", () => {
  // A shared dashboard is a LAYOUT. Every card re-runs its own permission and
  // module checks against whoever is looking, so two people opening the same
  // dashboard can legitimately see different cards. If this ever stops being
  // true, a published layout becomes a way to read other people's records.
  const renderer = code("src/components/dashboard/cards/builtin.tsx");
  assert.match(renderer, /canSeeCard\(/, "per-viewer card gating must survive");

  const actions = code(ACTION);
  const fn = actions.slice(actions.indexOf("export async function setDashboardShared"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.doesNotMatch(body, /permission|grant|access/i, "publishing must not touch permissions");
});

test("the tenant boundary comes from the scoped client, not this query", () => {
  // "Shared" means shared with this tenant and never beyond it. The scoped
  // prisma client decides that for every model; a hand-written tenantId here
  // would be a second, drifting answer to the same question.
  const store = code(STORE);
  const fn = store.slice(store.indexOf("dashboardsForViewer"));
  const body = fn.slice(0, fn.indexOf("orderBy"));
  assert.doesNotMatch(body, /tenantId/, "the tenant must come from the client's scope");
});

// ── the migration ───────────────────────────────────────────────────────────

test("the migration is additive and inert on application", () => {
  // Nothing becomes visible to anyone until an owner publishes: NULL is private,
  // and every existing row is NULL.
  // Comments stripped, and NOT NULL checked per ADD COLUMN rather than across
  // the whole file: the partial index legitimately contains "IS NOT NULL", which
  // is a predicate, not a column constraint.
  const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "sharedAt"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "sharedById"/);

  for (const statement of sql.split(";")) {
    if (!/ADD COLUMN/i.test(statement)) continue;
    assert.doesNotMatch(
      statement,
      /NOT NULL/i,
      "a NOT NULL column on an existing table needs a default and a backfill",
    );
  }
  assert.doesNotMatch(sql, /DROP |DELETE |UPDATE /i, "additive only");
});

test("the shared lookup is indexed, and only over published rows", () => {
  // The switcher asks this on every page load. Published dashboards are the rare
  // case, so a partial index stays small and keeps writes to private dashboards
  // off it entirely.
  const sql = read(MIGRATION);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "Dashboard_tenantId_sharedAt_idx"/);
  assert.match(sql, /WHERE "sharedAt" IS NOT NULL/);
  // tenantId leads, matching the table's existing indexes — the tenant extension
  // puts it in every where clause, so an index starting elsewhere is unusable.
  assert.match(sql, /\("tenantId", "sharedAt"\)/);
});

test("the sharing columns are on Dashboard, not DashboardLayout", () => {
  // They landed on the wrong model first, because both models have an identical
  // `createdAt` line and the first match won.
  const schema = read("prisma/dashboards.prisma");
  const dashboard = schema.slice(schema.indexOf("model Dashboard {"));
  const body = dashboard.slice(0, dashboard.indexOf("\n}"));
  assert.match(body, /sharedAt/);

  const layout = schema.slice(schema.indexOf("model DashboardLayout {"));
  const layoutBody = layout.slice(0, layout.indexOf("\n}"));
  assert.doesNotMatch(layoutBody, /sharedAt/, "DashboardLayout must not have them");
});
