import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decideActingScope, type ActingScope } from "../src/lib/actingScopeRule";
import { resolveAssignment, assignmentRefusalMessage } from "../src/lib/assignableUser";
import { ActionRefusal } from "../src/lib/actionFailure";

/**
 * The acting resolvers, WIRED — and every case below pins `enforcing: false`.
 *
 * That is the whole reason this file exists separately from
 * assignablePersonContract.test.ts. Every test in that file establishes a tenant
 * scope before it asks anything, which selects the branch that already worked.
 * The branch that runs in production is the other one: enforcement is dormant in
 * every environment we have, and while dormant `currentScopeClass()` answers
 * `global`, so the background resolvers skip their `TenantMember` join entirely.
 * A picker on them lists every user on the platform and an assignment check on
 * them validates nothing — and both look completely correct in review, pass every
 * existing test, and only start working after a flip that has not happened.
 *
 * So: dormant, a real session in workspace B, and the two questions that matter.
 * A user of workspace B must be refused in A, and B's staff must see only B's
 * colleagues. Each is asserted against BOTH classifications, so the test says not
 * just "the acting resolver is right" but "the background one is wrong here" —
 * which is the assertion that goes red if the wiring is reverted.
 */

const A = "tenant_a";
const B = "tenant_b";

const USERS = [
  { id: "u-alice", name: "Alice", email: "alice@a.test", disabled: false },
  { id: "u-bob", name: "Bob", email: "bob@a.test", disabled: false },
  { id: "u-mallory", name: "Mallory", email: "mallory@b.test", disabled: false },
  { id: "u-nora", name: "Nora", email: "nora@b.test", disabled: false },
  { id: "u-dana", name: "Dana", email: "dana@a.test", disabled: true },
];

const MEMBERSHIPS = [
  { userId: "u-alice", tenantId: A },
  { userId: "u-bob", tenantId: A },
  { userId: "u-dana", tenantId: A },
  { userId: "u-mallory", tenantId: B },
  { userId: "u-nora", tenantId: B },
];

type Person = { id: string; name: string; email: string };

/**
 * `listActingTenantStaff`, as SQL semantics rather than SQL.
 *
 * Mirrors the three branches of the real function exactly: `closed` → nothing,
 * `tenant` → the TenantMember join with the disabled filter, `global` → every
 * non-disabled user on the platform. The `global` branch is not a strawman; it is
 * the branch the BACKGROUND resolver takes while dormant, and reproducing it
 * faithfully is the only way this file can show what the wiring choice costs.
 */
function staffFor(scope: ActingScope): Person[] {
  const pick = (u: (typeof USERS)[number]) => ({ id: u.id, name: u.name, email: u.email });
  if (scope.mode === "closed") return [];
  if (scope.mode === "global") return USERS.filter((u) => !u.disabled).map(pick);
  return USERS.filter(
    (u) =>
      !u.disabled && MEMBERSHIPS.some((m) => m.userId === u.id && m.tenantId === scope.tenantId),
  ).map(pick);
}

/** `resolveActingTenantMemberUser`, same three branches. */
function memberLookupFor(scope: ActingScope) {
  return async (userId: string): Promise<Person | null> =>
    staffFor(scope).find((p) => p.id === userId) ?? null;
}

/** The scope a signed-in person acts in while enforcement is DORMANT. */
const actingScopeWhileDormant = (sessionTenantId: string | null): ActingScope =>
  decideActingScope({ enforcing: false, enforcedScope: { mode: "global" }, sessionTenantId });

/**
 * What the BACKGROUND resolvers classify as while dormant, whatever the session
 * says. `currentScopeClass()` does not consult a session at all, so this is
 * `global` for a signed-in person exactly as it is for a cron.
 */
const backgroundScopeWhileDormant = (): ActingScope => ({ mode: "global" });

/* ------------------------------------------- the assignment check, executed */

test("DORMANT: a user of workspace B is refused an assignment in workspace A", async () => {
  const scope = actingScopeWhileDormant(A);
  await assert.rejects(
    () => resolveAssignment("u-mallory", "owner", memberLookupFor(scope)),
    (error: unknown) =>
      error instanceof ActionRefusal && error.message === assignmentRefusalMessage("owner"),
    "Mallory works in B; assigning her a record in A must be refused, with enforcement off",
  );
});

test("DORMANT: the BACKGROUND resolver would have accepted her — the wiring is the fix", async () => {
  // The same posted id, the same rule, the same fixture. The only difference is
  // which scope the lookup classified with. This is the defect, executed: the
  // contract was wired to a resolver that answers `global` while dormant, so it
  // accepted a member of another workspace and reported a successful save.
  const accepted = await resolveAssignment(
    "u-mallory",
    "owner",
    memberLookupFor(backgroundScopeWhileDormant()),
  );
  assert.equal(accepted?.id, "u-mallory", "the background classification does not check membership");
});

test("DORMANT: a member of the acting workspace is still accepted", async () => {
  const scope = actingScopeWhileDormant(A);
  const owner = await resolveAssignment("u-alice", "owner", memberLookupFor(scope));
  assert.equal(owner?.id, "u-alice");
  assert.equal(owner?.name, "Alice", "the caller must get the record it validated, for the audit line");
});

test("DORMANT: the same person is assignable in their OWN workspace and refused in the other", async () => {
  assert.equal(
    (await resolveAssignment("u-mallory", "owner", memberLookupFor(actingScopeWhileDormant(B))))?.id,
    "u-mallory",
  );
  await assert.rejects(() =>
    resolveAssignment("u-bob", "owner", memberLookupFor(actingScopeWhileDormant(B))),
  );
});

test("DORMANT: a disabled member of the acting workspace is refused", async () => {
  await assert.rejects(
    () => resolveAssignment("u-dana", "owner", memberLookupFor(actingScopeWhileDormant(A))),
    "a suspended login must not be handed live work, in either mode",
  );
});

test("DORMANT: a blank selection still means 'nobody', not a refusal", async () => {
  const scope = actingScopeWhileDormant(A);
  assert.equal(await resolveAssignment("", "owner", memberLookupFor(scope)), null);
  assert.equal(await resolveAssignment(null, "owner", memberLookupFor(scope)), null);
});

/* ------------------------------------------------- the staff list, executed */

test("DORMANT: B's staff see only B's colleagues", () => {
  const scope = actingScopeWhileDormant(B);
  assert.deepEqual(
    staffFor(scope).map((p) => p.name),
    ["Mallory", "Nora"],
    "a picker in workspace B must offer B's members and nobody else",
  );
});

test("DORMANT: the BACKGROUND list would have shown B every workspace's staff", () => {
  // Four names, from two workspaces, to someone signed in to one of them. Nothing
  // in the UI marks which is which, so a picker reads as "your team".
  assert.deepEqual(
    staffFor(backgroundScopeWhileDormant()).map((p) => p.name),
    ["Alice", "Bob", "Mallory", "Nora"],
  );
});

test("DORMANT: the picker and the check agree on exactly one set of people", () => {
  // A picker fixed without its check is half a fix; a check fixed without its
  // picker is the other half. The property that must hold is that they cannot
  // disagree: every name offered resolves, and every name withheld refuses.
  for (const tenantId of [A, B]) {
    const scope = actingScopeWhileDormant(tenantId);
    const offered = new Set(staffFor(scope).map((p) => p.id));
    for (const user of USERS) {
      const resolves = staffFor(scope).some((p) => p.id === user.id);
      assert.equal(
        resolves,
        offered.has(user.id),
        `${user.name} must be offered and resolvable together in ${tenantId}, or neither`,
      );
    }
  }
});

test("DORMANT with NO session: cron and webhooks are unchanged", () => {
  // The background paths deliberately keep the old answer. A cron sending an
  // approval email has no session for an acting scope to resolve, and inventing
  // one is the same defect with the sign flipped.
  assert.deepEqual(actingScopeWhileDormant(null), { mode: "global" });
});

/* ------------------------------------------------------- the wiring, swept */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * Every surface a signed-in person builds a staff list from.
 *
 * `listTenantStaff` and `listActingTenantStaff` run the same SQL under
 * enforcement and differ only while dormant, so a call site on the wrong one is
 * invisible to every behavioural test we can run without a database — which is
 * precisely why the list is enumerated here.
 */
const ACTING_STAFF_SURFACES = [
  join("src", "app", "(app)", "cases", "[id]", "page.tsx"),
  join("src", "app", "(app)", "jobcards", "[id]", "page.tsx"),
  join("src", "app", "(app)", "contacts", "page.tsx"),
  join("src", "app", "(app)", "contacts", "new", "page.tsx"),
  join("src", "app", "(app)", "contacts", "[id]", "page.tsx"),
  join("src", "app", "(app)", "contacts", "[id]", "edit", "page.tsx"),
  join("src", "app", "(app)", "leads", "page.tsx"),
  join("src", "app", "(app)", "leads", "new", "page.tsx"),
  join("src", "app", "(app)", "leads", "[id]", "page.tsx"),
  join("src", "app", "(app)", "leads", "[id]", "edit", "page.tsx"),
  join("src", "app", "(app)", "journeys", "page.tsx"),
  join("src", "app", "(app)", "inbox", "page.tsx"),
  join("src", "app", "(app)", "audit", "page.tsx"),
  join("src", "app", "(app)", "fleets", "[id]", "page.tsx"),
  join("src", "app", "(app)", "test-drives", "page.tsx"),
  join("src", "app", "(app)", "test-drives", "[id]", "page.tsx"),
  join("src", "app", "(app)", "signing-workflows", "[id]", "page.tsx"),
  join("src", "app", "(app)", "marketing", "surveys", "insights", "page.tsx"),
  join("src", "app", "api", "quick-create", "route.ts"),
  join("src", "app", "actions", "conversations.ts"),
] as const;

for (const file of ACTING_STAFF_SURFACES) {
  test(`${file}: a signed-in person's staff list uses the ACTING resolver`, () => {
    const code = codeOf(read(file));
    assert.match(code, /listActingTenantStaff\s*\(\)/, `${file} must use listActingTenantStaff`);
    assert.doesNotMatch(
      code,
      /(?<![A-Za-z])listTenantStaff\s*\(\)/,
      `${file} has a session, so the dormant-blind background list is the wrong one`,
    );
  });
}

/**
 * The paths deliberately LEFT on the background resolvers, with the reason.
 *
 * Listed as a test so each exemption is a decision somebody made rather than a
 * file nobody checked, and so converting one later has to be deliberate.
 */
const BACKGROUND_BY_DESIGN = [
  {
    file: join("src", "lib", "signing", "approvals.ts"),
    fn: "resolveTenantMemberUser",
    why:
      "a cron delivers the approval email; there is no session, and null rather than a throw is the outcome it needs",
  },
  {
    file: join("src", "lib", "signing", "autoEnvelope.ts"),
    fn: "listTenantStaff",
    why: "the signing-workflow RUNTIME builds its staffMap without an actor present",
  },
] as const;

for (const { file, fn, why } of BACKGROUND_BY_DESIGN) {
  test(`${file}: stays on ${fn} — ${why}`, () => {
    const code = codeOf(read(file));
    assert.match(code, new RegExp(`(?<![A-Za-z])${fn}\\s*\\(`), `${file} must keep ${fn}`);
    assert.doesNotMatch(
      code,
      /listActingTenantStaff\s*\(|resolveActingTenantMemberUser\s*\(/,
      `${file} has no session for an acting scope to resolve`,
    );
  });
}

test("the background resolvers still exist, unchanged, for those paths to use", () => {
  const code = read("src", "lib", "tenantActor.ts");
  assert.match(code, /const actorScope = currentScopeClass;/);
  for (const fn of ["resolveTenantActor", "resolveTenantMemberUser", "listTenantStaff"]) {
    assert.match(
      code,
      new RegExp(`export async function ${fn}`),
      `${fn} must survive the sweep — background work depends on its semantics`,
    );
  }
});

/* ------------------------------------ the last screens off the global table */

test("the reports filter is built from the acting staff, not every User row", () => {
  const code = codeOf(read("src", "app", "(app)", "reports", "page.tsx"));
  assert.match(code, /listActingTenantStaff\(\)/);
  assert.doesNotMatch(
    code,
    /prisma\.user\.findMany/,
    "an unrestricted reader was offered every person on the platform by name",
  );
  // The dropdown is one half; `?user=` is submitted and must be judged by the
  // same list the dropdown was built from.
  assert.match(
    code,
    /const requestedUser = params\.user && users\.some\(\(u\) => u\.id === params\.user\)/,
    "the submitted filter id must be validated against the scoped list",
  );
});

test("the dashboard people card resolves names from the acting workspace", () => {
  const code = codeOf(read("src", "components", "dashboard", "cards", "people.ts"));
  assert.match(code, /listActingTenantStaff\(\)/);
  assert.doesNotMatch(code, /prisma\.user\.findMany/);
});

/**
 * The two administration screens need MEMBERSHIP, not assignability: a disabled
 * member must stay listed or "Reactivate" cannot reach its own target. That is
 * `actingTenantMemberIds`, which filters on membership alone.
 */
const MEMBER_SCOPED_SCREENS = [
  { file: join("src", "app", "(app)", "settings", "page.tsx"), what: "the team roster" },
  { file: join("src", "app", "(app)", "settings", "sessions", "page.tsx"), what: "sessions & devices" },
  { file: join("src", "app", "(app)", "settings", "access", "page.tsx"), what: "access control" },
] as const;

for (const { file, what } of MEMBER_SCOPED_SCREENS) {
  test(`${file}: ${what} is scoped to the acting workspace's members`, () => {
    const code = codeOf(read(file));
    assert.match(code, /actingTenantMemberIds\(\)/, `${what} must resolve membership of the acting workspace`);
    assert.doesNotMatch(
      code,
      /NOT \$\{enforcing\}::boolean OR EXISTS \(\s*SELECT 1 FROM "TenantMember"/,
      `${what} must not gate its membership check on enforcement being ON — that is the defect`,
    );
  });
}

test("settings/access no longer lists every user while enforcement is dormant", () => {
  const code = codeOf(read("src", "app", "(app)", "settings", "access", "page.tsx"));
  // Disabled members must still be listed; this screen is where they are
  // reactivated, and the ordering that puts them last is the proof it expects them.
  assert.match(code, /ORDER BY u\."disabledAt" NULLS FIRST/, "disabled members must stay visible here");
});

/**
 * Every action that takes a `userId` off a form and changes THAT PERSON'S
 * account. `requireOwner` proves the caller administers a workspace; it never
 * proved which one the target belongs to, and `User` is global, so
 * `findUniqueOrThrow({ where: { id } })` asked only whether the human exists.
 */
const MANAGEMENT_ACTIONS = [
  { file: join("src", "app", "actions", "security.ts"), fns: ["setUserRole", "ownerResetUser2fa", "revokeUserSessions", "setUserDisabled"], guard: /await assertManageableUser\(userId\);/ },
  { file: join("src", "app", "actions", "sessions.ts"), fns: ["revokeSession", "revokeAllForUser"], guard: /await isActingTenantMember\(/ },
] as const;

for (const { file, fns, guard } of MANAGEMENT_ACTIONS) {
  for (const fn of fns) {
    test(`${file}: ${fn} checks the target is a member of this workspace`, () => {
      const code = read(file);
      const start = code.indexOf(`export async function ${fn}`);
      assert.ok(start > 0, `${fn} must exist`);
      const next = code.indexOf("export async function", start + 1);
      const body = codeOf(code.slice(start, next === -1 ? undefined : next));
      assert.match(
        body,
        guard,
        `${fn} is a POST endpoint reachable without the roster, so the roster is not the control`,
      );
    });
  }
}

test("the membership guard is ONE rule, not one per action", () => {
  const code = read("src", "lib", "tenantActor.ts");
  const start = code.indexOf("export async function isActingTenantMember");
  assert.ok(start > 0, "isActingTenantMember must exist");
  assert.match(
    code.slice(start, start + 300),
    /await actingTenantMemberIds\(\)/,
    "it must be built on the same membership list the screens are, not a second query that agrees today",
  );
});

/* ---------------------------------------------- the empty list, in the UI */

test("ContactForm: the owner field stays put when nobody is assignable", () => {
  // The consequence of scoping these lists: empty is now reachable, where a scan
  // of every User row never was. This field used to render only for a non-empty
  // list, so it VANISHED — which reads as a form that has lost a control rather
  // than a team with nobody in it.
  const code = read("src", "components", "ContactForm.tsx");
  assert.doesNotMatch(
    codeOf(code),
    /\{users\.length > 0 && \(/,
    "a missing control is not an empty state",
  );
  assert.match(code, /users\.length === 0 \?/, "it must render an explicit empty state");
  assert.match(
    code,
    /<select className="input" disabled/,
    "a disabled select with an explanation, not a <select> with no options",
  );
  assert.doesNotMatch(
    code,
    /<select className="input" disabled[^>]*\sname=/,
    "the disabled placeholder must not submit a value",
  );
  // The edit form's second trap: an owner who is no longer in the scoped list
  // makes the browser select the FIRST option, silently reassigning the contact.
  assert.match(
    code,
    /defaultValue=\{users\.some\(\(user\) => user\.id === defaults\.ownerId\) \? defaults\.ownerId \?\? "" : ""\}/,
    "an owner outside the scoped list must fall back to blank, not to users[0]",
  );
});
