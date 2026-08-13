import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideActingScope, type ActingScope } from "../src/lib/actingScopeRule";
import { forecastPickers, offeredId } from "../src/lib/forecastPickerScope";

/**
 * A FORECAST PAGE MUST OFFER ONE WORKSPACE'S PEOPLE.
 *
 * #481 scoped the MONEY on /forecast — the open-pipeline total, the persisted
 * snapshot. This is the other half of the same page: its `Team`, `User` and
 * `TeamMember` reads had no tenant predicate of any kind, on `basePrisma`, the
 * documented RLS bypass, and `scope.viewAll` handed every returned row straight
 * to the two dropdowns:
 *
 *     const teams = scope.viewAll ? allTeams : allTeams.filter(…)
 *     if (scope.viewAll) for (const item of allUsers) visibleUserIds.add(item.id)
 *
 * `viewAll` is a WITHIN-workspace permission — "see records that are not yours".
 * Wired to unbounded reads it became a CROSS-workspace one, and every global
 * `owner` has it by default. So the page named other dealers' teams and staff in
 * a filter bar, which is not a leak anybody reads as a leak: a dropdown looks
 * like a dropdown.
 *
 * ── WHY THIS TEST LOOKS LIKE THIS ──────────────────────────────────────────
 *
 * Three things are proved separately because they fail separately:
 *
 *   1. THE RULE. `forecastPickers` is pure and is EXECUTED here, with `viewAll`
 *      true and false, over a fixture containing both workspaces' people. The
 *      rule's guarantee is structural — the workspace boundary is not one of its
 *      arguments — so the test can also feed it the PRE-FIX inputs and show the
 *      exact leak coming back.
 *   2. THE WIRING. The real `listActingTenantTeams` / `listActingTenantStaff` /
 *      `listActingTenantTeamMemberships` / `resolveActingTenantTeam` /
 *      `resolveActingTenantMemberUser` / `getLeadPipeline` run against a fake
 *      database that READS the predicate they emit out of the flattened SQL,
 *      rather than being told what it should be. Enforcement is DORMANT, exactly
 *      as in production, because that is the mode in which the background
 *      resolvers quietly do nothing.
 *   3. THE MUTATIONS. Each scoping change is reverted — the predicate deleted
 *      from the SQL the production code just emitted, or the acting resolver
 *      swapped for the background one — and the assertion that goes red names
 *      the other workspace's user or team.
 *
 * The #458 ratchet cannot stand in for any of this: its heuristic asks whether
 * the word `tenantId` appears in the statement text, so a predicate arriving as
 * an interpolated fragment is invisible to it, and a predicate that is dropped
 * from a statement that mentions tenantId elsewhere is invisible to it too.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

const TENANT_A = "tenant_a_dealer";
const TENANT_B = "tenant_b_dealer";

/* ── the two workspaces ───────────────────────────────────────────────────── */

/**
 * Names, not ids, carry the point: an assertion that goes red has to READ as
 * "workspace A's forecast page is offering Bianca, who works for workspace B".
 */
const USERS = [
  { id: "u_amy", name: "Amy (A Dealer)", email: "amy@a.test", disabledAt: null },
  { id: "u_andre", name: "Andre (A Dealer)", email: "andre@a.test", disabledAt: null },
  { id: "u_ada", name: "Ada (A Dealer, disabled)", email: "ada@a.test", disabledAt: new Date(0) },
  { id: "u_bianca", name: "Bianca (B Dealer)", email: "bianca@b.test", disabledAt: null },
  { id: "u_ben", name: "Ben (B Dealer)", email: "ben@b.test", disabledAt: null },
];

/** `TenantMember` — the only thing that says which workspace a global User works in. */
const TENANT_MEMBERS = [
  { userId: "u_amy", tenantId: TENANT_A },
  { userId: "u_andre", tenantId: TENANT_A },
  { userId: "u_ada", tenantId: TENANT_A },
  { userId: "u_bianca", tenantId: TENANT_B },
  { userId: "u_ben", tenantId: TENANT_B },
];

const TEAMS = [
  { id: "team_a_sales", name: "A Dealer Sales", tenantId: TENANT_A, active: true, deletedAt: null },
  { id: "team_a_service", name: "A Dealer Service", tenantId: TENANT_A, active: true, deletedAt: null },
  { id: "team_a_retired", name: "A Dealer Retired", tenantId: TENANT_A, active: false, deletedAt: null },
  { id: "team_b_sales", name: "B Dealer Sales", tenantId: TENANT_B, active: true, deletedAt: null },
  { id: "team_b_service", name: "B Dealer Service", tenantId: TENANT_B, active: true, deletedAt: null },
  // Owned by NOBODY. Strict equality must exclude it from BOTH workspaces — the
  // same posture pipelineTenantRule.ts and flowTenantScope.ts argue for, and the
  // reason nothing is stranded is measured: migration
  // 20260725160000_tenant_governance_isolation backfilled "Team" and "TeamMember"
  // unconditionally, so a NULL row today was created after it, by an unknown
  // workspace.
  { id: "team_orphan", name: "Unowned Team", tenantId: null, active: true, deletedAt: null },
];

const TEAM_MEMBERSHIPS = [
  { teamId: "team_a_sales", userId: "u_amy", tenantId: TENANT_A },
  { teamId: "team_a_sales", userId: "u_andre", tenantId: TENANT_A },
  { teamId: "team_a_service", userId: "u_andre", tenantId: TENANT_A },
  { teamId: "team_b_sales", userId: "u_bianca", tenantId: TENANT_B },
  { teamId: "team_b_sales", userId: "u_ben", tenantId: TENANT_B },
];

const LEADS = [
  { id: "lead_a1", tenantId: TENANT_A, pipelineId: "pipe_a", stageId: "stage_a1", teamId: "team_a_sales", deletedAt: null },
  { id: "lead_b1", tenantId: TENANT_B, pipelineId: "pipe_b", stageId: "stage_b1", teamId: "team_b_sales", deletedAt: null },
  { id: "lead_orphan", tenantId: null, pipelineId: "pipe_x", stageId: "stage_x", teamId: null, deletedAt: null },
];

/* ── a database that reads the predicate instead of being told it ─────────── */

type Flat = { text: string; values: unknown[] };

function isSql(value: unknown): value is { strings: readonly string[]; values: readonly unknown[] } {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { strings?: unknown }).strings)
    && Array.isArray((value as { values?: unknown }).values);
}

/**
 * Flatten a tagged template the way the Prisma driver does: nested `Prisma.Sql`
 * fragments spliced into the text, every other interpolation a numbered
 * placeholder bound to a value. This is what lets the fake SEE whether a tenant
 * predicate reached the database, and what it bound.
 */
function flatten(strings: readonly string[], values: readonly unknown[]): Flat {
  const out: string[] = [];
  const params: unknown[] = [];
  const walk = (ss: readonly string[], vs: readonly unknown[]) => {
    for (let i = 0; i < ss.length; i += 1) {
      out.push(ss[i]);
      if (i >= vs.length) continue;
      const value = vs[i];
      if (isSql(value)) walk(value.strings, value.values);
      else {
        params.push(value);
        out.push(`$${params.length}`);
      }
    }
  };
  walk(strings, values);
  return { text: out.join("").replace(/\s+/g, " ").trim(), values: params };
}

/** The value a predicate binds, or `undefined` when the predicate is not there at all. */
function bound(flat: Flat, pattern: RegExp): unknown {
  const match = flat.text.match(pattern);
  if (!match) return undefined;
  return flat.values[Number(match[1]) - 1];
}

/** Every statement the code under test issued, in order, flattened. */
const issued: Flat[] = [];

/**
 * THE MUTATION SWITCHES. Each deletes one tenant predicate from the SQL the
 * production code emitted, immediately before the fake evaluates it — the defect
 * reproduced on the real statement with nothing else changed.
 */
const drop = { team: false, membership: false, lead: false };

/** The `(NULL means unrestricted)` predicate these resolvers emit, as a value. */
const OPTIONAL_TENANT = /\(\$(\d+)::text IS NULL OR "tenantId" = \$\d+\)/;

function tenantOf(flat: Flat, dropped: boolean): { restricted: boolean; tenantId: unknown } {
  if (dropped || !OPTIONAL_TENANT.test(flat.text)) return { restricted: false, tenantId: undefined };
  const value = bound(flat, OPTIONAL_TENANT);
  return { restricted: value != null, tenantId: value };
}

const raw = async (strings: readonly string[], ...values: unknown[]) => {
  const flat = flatten(strings, values);
  issued.push(flat);

  // `listActingTenantStaff` / `resolveActingTenantMemberUser`, tenant branch.
  if (/FROM "TenantMember" m JOIN "User" u/.test(flat.text)) {
    const tenantId = bound(flat, /m\."tenantId" = \$(\d+)/);
    const userId = bound(flat, /m\."userId" = \$(\d+)/);
    assert.match(flat.text, /u\."disabledAt" IS NULL/);
    return USERS.filter((user) => {
      if (user.disabledAt !== null) return false;
      if (userId !== undefined && user.id !== userId) return false;
      const membership = TENANT_MEMBERS.find((m) => m.userId === user.id);
      return membership?.tenantId === tenantId;
    }).map(({ id, name, email }) => ({ id, name, email }));
  }

  // `listTenantStaff` / `resolveTenantMemberUser`, GLOBAL branch — the one the
  // background resolvers take while enforcement is dormant. Modelled faithfully
  // because it is the "reverted" state the mutation tests below drive.
  if (/FROM "User"/.test(flat.text)) {
    const userId = bound(flat, /"id" = \$(\d+)/);
    return USERS.filter((user) => user.disabledAt === null && (userId === undefined || user.id === userId))
      .map(({ id, name, email }) => ({ id, name, email }));
  }

  if (/FROM "Team"/.test(flat.text)) {
    const scope = tenantOf(flat, drop.team);
    const id = bound(flat, /"id" = \$(\d+)/);
    assert.match(flat.text, /"active" = true AND "deletedAt" IS NULL/);
    return TEAMS.filter((team) => {
      if (!team.active || team.deletedAt !== null) return false;
      if (id !== undefined && team.id !== id) return false;
      return !scope.restricted || team.tenantId === scope.tenantId;
    }).map(({ id: teamId, name }) => ({ id: teamId, name }));
  }

  if (/FROM "TeamMember"/.test(flat.text)) {
    const scope = tenantOf(flat, drop.membership);
    return TEAM_MEMBERSHIPS.filter((row) => !scope.restricted || row.tenantId === scope.tenantId)
      .map(({ teamId, userId }) => ({ teamId, userId }));
  }

  if (/FROM "Lead"/.test(flat.text)) {
    const text = drop.lead ? flat.text.replace(/AND "tenantId" = \$\d+/, "") : flat.text;
    const scoped: Flat = { text, values: flat.values };
    const id = bound(scoped, /WHERE "id" = \$(\d+)/);
    const tenantId = bound(scoped, /AND "tenantId" = \$(\d+)/);
    return LEADS.filter((lead) =>
      lead.id === id && lead.deletedAt === null && (tenantId === undefined || lead.tenantId === tenantId))
      .map(({ pipelineId, stageId, teamId }) => ({ pipelineId, stageId, teamId }));
  }

  throw new Error(`the fake database was asked something it does not model: ${flat.text.slice(0, 140)}`);
};

const basePrisma = { $queryRaw: raw, $executeRaw: raw };

/* ── load the real modules against it, with enforcement DORMANT ───────────── */

/** The workspace the SESSION is acting as. Null models a session with no claim. */
let session: string | null = TENANT_A;

/**
 * The real acting-scope rule, driven with `enforcing: false` — production today.
 * Not stubbed to a constant: the whole defect class is that `currentScopeClass()`
 * answers `global` in this mode, and the acting rule is what turns a session into
 * a workspace anyway.
 */
const actingScopeClass = async (): Promise<ActingScope> =>
  decideActingScope({ enforcing: false, enforcedScope: { mode: "global" }, sessionTenantId: session });

const tenantActorStubs: Record<string, unknown> = {
  "./db": { basePrisma, prisma: basePrisma },
  "./actingScope": { actingScopeClass },
  // DORMANT — the reason the background resolvers validate nothing today.
  "./tenantWrite": { currentScopeClass: () => ({ mode: "global" as const }), writeTenantId: () => null },
};

const pipelineStubs: Record<string, unknown> = {
  "./db": { basePrisma, prisma: basePrisma },
  "./actingTenant": { actingTenantId: async () => session ?? "tenant_fallback" },
  "./tenantWrite": { currentScopeClass: () => ({ mode: "global" as const }), writeTenantId: () => null },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith("tenantActor.ts") && request in tenantActorStubs) return tenantActorStubs[request];
  if (from.endsWith("pipelines.ts") && request in pipelineStubs) return pipelineStubs[request];
  if (request === "server-only" || request === "client-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const tenantActor = require_("../src/lib/tenantActor.ts") as typeof import("../src/lib/tenantActor");
const pipelines = require_("../src/lib/pipelines.ts") as typeof import("../src/lib/pipelines");

/** Everything one page render loads, for whoever is signed in. */
async function workspaceOf(tenantId: string | null) {
  session = tenantId;
  issued.length = 0;
  const [workspaceTeams, workspaceStaff, workspaceMemberships] = await Promise.all([
    tenantActor.listActingTenantTeams(),
    tenantActor.listActingTenantStaff(),
    tenantActor.listActingTenantTeamMemberships(),
  ]);
  return { workspaceTeams, workspaceStaff, workspaceMemberships };
}

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name).sort();
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
/** Who the membership rows reach, deduplicated — a person may be in two teams. */
const membersOf = (rows: Array<{ userId: string }>) => [...new Set(rows.map((row) => row.userId))].sort();

/** A `leads.view_all` holder — every owner is one, unconditionally. */
const VIEW_ALL = { viewAll: true, userId: "u_amy", teamIds: [] as string[] };
/** A sales manager in one of A's two teams. */
const SCOPED = { viewAll: false, userId: "u_amy", teamIds: ["team_a_sales"] };

/* ── the workspace boundary, in the mode we actually run in ───────────────── */

test("A's staff, teams and memberships are A's", async () => {
  const workspace = await workspaceOf(TENANT_A);

  assert.deepEqual(names(workspace.workspaceTeams), ["A Dealer Sales", "A Dealer Service"]);
  assert.deepEqual(names(workspace.workspaceStaff), ["Amy (A Dealer)", "Andre (A Dealer)"]);
  assert.deepEqual(membersOf(workspace.workspaceMemberships), ["u_amy", "u_andre"]);
  assert.deepEqual(
    workspace.workspaceMemberships.map((row) => row.teamId).sort(),
    ["team_a_sales", "team_a_sales", "team_a_service"],
  );

  // Stated as the property as well as the list: nothing of B's, and nothing
  // unowned, in any of the three.
  assert.ok(!names(workspace.workspaceTeams).includes("B Dealer Sales"));
  assert.ok(!names(workspace.workspaceStaff).includes("Bianca (B Dealer)"));
  assert.ok(!ids(workspace.workspaceTeams).includes("team_orphan"), "an unowned team is nobody's");
});

test("B's staff, teams and memberships are B's", async () => {
  const workspace = await workspaceOf(TENANT_B);

  assert.deepEqual(names(workspace.workspaceTeams), ["B Dealer Sales", "B Dealer Service"]);
  assert.deepEqual(names(workspace.workspaceStaff), ["Ben (B Dealer)", "Bianca (B Dealer)"]);
  assert.deepEqual(membersOf(workspace.workspaceMemberships), ["u_ben", "u_bianca"]);

  // The two workspaces must differ from EACH OTHER, which "everyone sees
  // everything" cannot do.
  assert.ok(!names(workspace.workspaceStaff).includes("Amy (A Dealer)"));
});

test("a disabled account is in no picker", async () => {
  const workspace = await workspaceOf(TENANT_A);
  assert.ok(!ids(workspace.workspaceStaff).includes("u_ada"), "a disabled login must not be offered work");
});

/* ── viewAll widens WITHIN a workspace, and only there ────────────────────── */

test("a viewAll user sees every one of A's teams and people, and none of B's", async () => {
  const workspace = await workspaceOf(TENANT_A);
  const pickers = forecastPickers({ ...workspace, scope: VIEW_ALL });

  // Wider than the scoped user below — the permission still does its job…
  assert.deepEqual(names(pickers.teams), ["A Dealer Sales", "A Dealer Service"]);
  assert.deepEqual(names(pickers.users), ["Amy (A Dealer)", "Andre (A Dealer)"]);
  // …and stops at the workspace edge, which is the whole point of this change.
  assert.deepEqual(
    names(pickers.teams).filter((name) => name.startsWith("B Dealer")),
    [],
    "viewAll is a within-workspace permission and must not name another dealer's team",
  );
  assert.deepEqual(
    names(pickers.users).filter((name) => name.includes("B Dealer")),
    [],
    "viewAll is a within-workspace permission and must not name another dealer's staff",
  );
});

test("a scoped user sees their own teams and their teams' people", async () => {
  const workspace = await workspaceOf(TENANT_A);
  const pickers = forecastPickers({ ...workspace, scope: SCOPED });

  assert.deepEqual(names(pickers.teams), ["A Dealer Sales"], "not A Dealer Service — they are not in it");
  assert.deepEqual(names(pickers.users), ["Amy (A Dealer)", "Andre (A Dealer)"]);
});

test("the two axes are independent: B's viewAll owner is still only B's", async () => {
  const workspace = await workspaceOf(TENANT_B);
  const pickers = forecastPickers({ ...workspace, scope: { viewAll: true, userId: "u_bianca", teamIds: [] } });
  assert.deepEqual(names(pickers.teams), ["B Dealer Sales", "B Dealer Service"]);
  assert.deepEqual(names(pickers.users), ["Ben (B Dealer)", "Bianca (B Dealer)"]);
});

test("a query-string id the picker would not have offered is dropped", async () => {
  const workspace = await workspaceOf(TENANT_A);
  const pickers = forecastPickers({ ...workspace, scope: VIEW_ALL });

  assert.equal(offeredId(pickers.teams, "team_b_sales"), null, "?team= must not reach listForecastLeads");
  assert.equal(offeredId(pickers.users, "u_bianca"), null, "?user= must not reach listForecastLeads");
  assert.equal(offeredId(pickers.teams, "team_a_sales"), "team_a_sales");
  assert.equal(offeredId(pickers.users, "u_amy"), "u_amy");
});

/* ── the check behind each picker ─────────────────────────────────────────── */

test("the snapshot action refuses another workspace's team and person", async () => {
  session = TENANT_A;
  assert.equal(await tenantActor.resolveActingTenantTeam("team_b_sales"), null);
  assert.equal(await tenantActor.resolveActingTenantTeam("team_orphan"), null, "an unowned team is nobody's");
  assert.equal(await tenantActor.resolveActingTenantMemberUser("u_bianca"), null);
  assert.equal(await tenantActor.resolveActingTenantMemberUser("u_ada"), null, "a disabled account is not selectable");

  assert.equal((await tenantActor.resolveActingTenantTeam("team_a_sales"))?.name, "A Dealer Sales");
  assert.equal((await tenantActor.resolveActingTenantMemberUser("u_andre"))?.name, "Andre (A Dealer)");
});

test("the statements the database runs bind the acting workspace", async () => {
  await workspaceOf(TENANT_B);
  const teamQuery = issued.find((flat) => /FROM "Team"/.test(flat.text));
  const memberQuery = issued.find((flat) => /FROM "TeamMember"/.test(flat.text));
  assert.ok(teamQuery && memberQuery, "the page must actually query teams and memberships");
  assert.equal(bound(teamQuery, OPTIONAL_TENANT), TENANT_B);
  assert.equal(bound(memberQuery, OPTIONAL_TENANT), TENANT_B);
  assert.doesNotMatch(teamQuery.text, /"tenantId" IS NULL OR/, "no unowned-row escape hatch");
});

/* ── getLeadPipeline ──────────────────────────────────────────────────────── */

test("a lead's pipeline resolves only inside the acting workspace", async () => {
  session = TENANT_A;
  assert.deepEqual(await pipelines.getLeadPipeline("lead_a1"), {
    pipelineId: "pipe_a", stageId: "stage_a1", teamId: "team_a_sales",
  });
  // Not "returns the row and the caller refuses" — returns NOTHING, so the
  // cross-pipeline permission decision it feeds is never made from another
  // workspace's data, and the callers treat null as a refusal.
  assert.equal(await pipelines.getLeadPipeline("lead_b1"), null);
  assert.equal(await pipelines.getLeadPipeline("lead_orphan"), null);

  session = TENANT_B;
  assert.equal((await pipelines.getLeadPipeline("lead_b1"))?.pipelineId, "pipe_b");
  assert.equal(await pipelines.getLeadPipeline("lead_a1"), null);
});

/* ── MUTATION: one scoping change reverted at a time ──────────────────────── */

test("MUTATION 1 — without the Team predicate, A's team picker names B Dealer Sales", async () => {
  drop.team = true;
  try {
    const workspace = await workspaceOf(TENANT_A);
    const pickers = forecastPickers({ ...workspace, scope: VIEW_ALL });
    assert.ok(
      names(pickers.teams).includes("B Dealer Sales"),
      "the mutation did not reproduce the defect — the fake stopped filtering for the wrong reason",
    );
    assert.deepEqual(names(pickers.teams), [
      "A Dealer Sales", "A Dealer Service", "B Dealer Sales", "B Dealer Service", "Unowned Team",
    ]);
  } finally {
    drop.team = false;
  }
  const restored = await workspaceOf(TENANT_A);
  assert.deepEqual(names(forecastPickers({ ...restored, scope: VIEW_ALL }).teams), [
    "A Dealer Sales", "A Dealer Service",
  ]);
});

test("MUTATION 2 — without the Team predicate, the snapshot action accepts B Dealer Sales", async () => {
  session = TENANT_A;
  drop.team = true;
  try {
    assert.equal((await tenantActor.resolveActingTenantTeam("team_b_sales"))?.name, "B Dealer Sales");
  } finally {
    drop.team = false;
  }
  assert.equal(await tenantActor.resolveActingTenantTeam("team_b_sales"), null);
});

test("MUTATION 3 — the background staff resolver puts Bianca (B Dealer) in A's owner picker", async () => {
  // The revert here is a WIRING revert, not a deleted predicate: swap
  // `listActingTenantStaff` for `listTenantStaff`, which is what the page had.
  // Both are real. The background one classifies with `currentScopeClass()`,
  // which answers `global` while dormant, so it skips the TenantMember join
  // entirely and lists every user on the platform.
  session = TENANT_A;
  const reverted = await tenantActor.listTenantStaff();
  assert.ok(names(reverted).includes("Bianca (B Dealer)"), "the background resolver is unbounded while dormant");

  const workspace = await workspaceOf(TENANT_A);
  const leaked = forecastPickers({ ...workspace, workspaceStaff: reverted, scope: VIEW_ALL });
  assert.deepEqual(names(leaked.users), [
    "Amy (A Dealer)", "Andre (A Dealer)", "Ben (B Dealer)", "Bianca (B Dealer)",
  ]);

  const fixed = forecastPickers({ ...workspace, scope: VIEW_ALL });
  assert.deepEqual(names(fixed.users), ["Amy (A Dealer)", "Andre (A Dealer)"]);
});

test("MUTATION 4 — the background assignee resolver accepts Bianca (B Dealer)", async () => {
  session = TENANT_A;
  assert.equal((await tenantActor.resolveTenantMemberUser("u_bianca"))?.name, "Bianca (B Dealer)");
  assert.equal(await tenantActor.resolveActingTenantMemberUser("u_bianca"), null);
});

test("MUTATION 5 — without the TeamMember predicate, A reads B's org chart", async () => {
  drop.membership = true;
  try {
    const workspace = await workspaceOf(TENANT_A);
    assert.deepEqual(membersOf(workspace.workspaceMemberships), ["u_amy", "u_andre", "u_ben", "u_bianca"]);
    // And it is not inert: a scoped manager whose team ids happened to include a
    // B team — or a `listTenantStaff` beside it, which is what the page had —
    // widens straight through it.
    const widened = forecastPickers({
      ...workspace,
      workspaceStaff: await tenantActor.listTenantStaff(),
      scope: { viewAll: false, userId: "u_amy", teamIds: ["team_a_sales", "team_b_sales"] },
    });
    assert.ok(names(widened.users).includes("Bianca (B Dealer)"));
  } finally {
    drop.membership = false;
  }
  const restored = await workspaceOf(TENANT_A);
  assert.deepEqual(membersOf(restored.workspaceMemberships), ["u_amy", "u_andre"]);
});

test("MUTATION 6 — without the Lead predicate, A resolves B's lead", async () => {
  session = TENANT_A;
  drop.lead = true;
  try {
    assert.deepEqual(await pipelines.getLeadPipeline("lead_b1"), {
      pipelineId: "pipe_b", stageId: "stage_b1", teamId: "team_b_sales",
    });
  } finally {
    drop.lead = false;
  }
  assert.equal(await pipelines.getLeadPipeline("lead_b1"), null);
});

/* ── the rule cannot be widened by its own arguments ──────────────────────── */

test("forecastPickers can only ever return a subset of what it was given", async () => {
  const workspace = await workspaceOf(TENANT_A);
  for (const scope of [VIEW_ALL, SCOPED, { viewAll: true, userId: "u_bianca", teamIds: ["team_b_sales"] }]) {
    const pickers = forecastPickers({ ...workspace, scope });
    for (const team of pickers.teams) assert.ok(workspace.workspaceTeams.some((t) => t.id === team.id));
    for (const person of pickers.users) assert.ok(workspace.workspaceStaff.some((s) => s.id === person.id));
  }
  // Including the case that used to be the leak: a foreign actor claiming
  // themselves. `scope.userId` seeds the visible set, but the answer is still
  // filtered against the workspace's staff.
  const foreign = forecastPickers({ ...workspace, scope: { viewAll: false, userId: "u_bianca", teamIds: [] } });
  assert.deepEqual(names(foreign.users), []);
});

/* ── no /forecast read is left on a global or dormant scope ───────────────── */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("the forecast page has no unbounded Team, User or TeamMember statement left", () => {
  const page = strip(src("src/app/(app)/forecast/page.tsx"));

  assert.doesNotMatch(page, /FROM "Team"/, "the team picker must come from listActingTenantTeams");
  assert.doesNotMatch(page, /FROM "User"/, "the owner picker must come from listActingTenantStaff");
  assert.doesNotMatch(page, /FROM "TeamMember"/, "memberships must come from listActingTenantTeamMemberships");

  assert.match(page, /listActingTenantTeams\(\)/);
  assert.match(page, /listActingTenantStaff\(\)/);
  assert.match(page, /listActingTenantTeamMemberships\(\)/);

  // The BACKGROUND resolvers are inert while dormant. On a page a signed-in
  // person is looking at, they are the defect — and the swap is a one-word edit
  // that changes nothing visible, which is why it needs an assertion of its own.
  // MUTATION 3 above executes both and shows what this one costs: Bianca (B
  // Dealer) in workspace A's owner dropdown.
  assert.doesNotMatch(page, /\blistTenantStaff\b/,
    "listTenantStaff skips the TenantMember join while dormant — this lists Bianca (B Dealer) to workspace A");
  assert.doesNotMatch(page, /\bresolveTenantMemberUser\b/,
    "resolveTenantMemberUser validates nothing while dormant — it accepts Bianca (B Dealer) from workspace A");

  // The `viewAll` combination is the pure rule, not a re-derivation.
  assert.match(page, /forecastPickers\(/);
});

test("the snapshot action validates the ids its pickers offered", () => {
  const actions = strip(src("src/app/actions/pipelines.ts"));
  assert.match(actions, /resolveActingTenantTeam\(requestedTeamId\)/);
  assert.match(actions, /resolveActingTenantMemberUser\(requestedUserId\)/);
  assert.doesNotMatch(actions, /\bresolveTenantMemberUser\b/, "the dormant-inert resolver must not come back");
  // The workspace check must not be reachable only through the visibility one.
  const workspaceCheck = actions.indexOf("resolveActingTenantTeam(requestedTeamId)");
  const visibilityCheck = actions.indexOf("if (!scope.viewAll)");
  assert.ok(workspaceCheck > 0 && visibilityCheck > workspaceCheck,
    "the workspace check must run before, and independently of, the viewAll check");
});

test("getLeadPipeline is off the dormant filter, and its callers refuse a null", () => {
  const lib = strip(src("src/lib/pipelines.ts"));
  const from = lib.indexOf("export async function getLeadPipeline");
  assert.ok(from > 0);
  const fn = lib.slice(from, lib.indexOf("export async function createPipeline"));
  assert.doesNotMatch(fn, /tenantFilter\('/, "tenantFilter is Prisma.empty while dormant");
  assert.match(fn, /const scope = await pipelineTenantFilter\(\);/);

  // EVERY caller, counted — not "at least one matches". Three call it, and
  // `moveLeadToTestDrive` already refused, so an assertion that merely finds a
  // guard somewhere in the file would stay green with the other two removed.
  const leads = strip(src("src/app/actions/leads.ts"));
  const calls = [...leads.matchAll(/await getLeadPipeline\(/g)];
  const guarded = [...leads.matchAll(/const (\w+) = await getLeadPipeline\(\w+\);\s*\n\s*if \(!\1\)/g)];
  // 3 → 4 with `moveLeadWithContact`, the customer-link stage remedy. The number
  // is the ratchet; the equality below is the actual rule, and it is what proves
  // the new caller guards its null rather than falling through.
  assert.equal(calls.length, 4, "a new caller of getLeadPipeline needs a null guard too");
  assert.equal(guarded.length, calls.length,
    "a null now means 'not this workspace's lead' — every caller must refuse, not fall through");
  // A null must not silently satisfy the permission it feeds.
  assert.doesNotMatch(leads, /if \(beforePipeline && beforePipeline\.pipelineId/);
  assert.doesNotMatch(leads, /if \(currentScope && currentScope\.pipelineId/);
});

test("both forecast pickers survive an empty list as a disabled field", () => {
  // Hiding a picker when its list went empty is what produced a silent
  // reassignment once already: the control vanishes, the form posts nothing, and
  // "nothing" is a value. Rendered disabled, it says why — and where blank is NOT
  // a no-op, the current value rides along in a hidden input.
  const page = src("src/app/(app)/forecast/page.tsx");
  assert.match(page, /teams\.length === 0 \? \(\s*<select className="input" disabled/);
  assert.match(page, /users\.length === 0 \? \(\s*<select className="input" disabled/);
  assert.match(page, /<select className="input" disabled defaultValue="">\s*<option value="">No teams in this workspace<\/option>\s*<\/select>\s*<input type="hidden" name="teamId"/);
});
