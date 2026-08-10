import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decideAssignment,
  normalizeAssigneeId,
  assignmentRefusalMessage,
  type AssignableCandidate,
} from "../src/lib/assignableUser";

/**
 * The assignable-person contract.
 *
 * `User` is a GLOBAL model by design — one person can work in several
 * workspaces, so the table is deliberately not tenant-scoped and the db.ts guard
 * adds no filter to it. Membership lives in `TenantMember`. Three assignment
 * surfaces shipped without ever asking the membership question: Contact.ownerId
 * was written straight from the form, CustomerCase.assignedToId checked only
 * that the User row existed, and JobCard.technicianId stored the posted id after
 * authorising the job card. All three would accept a user id belonging to an
 * entirely different tenant.
 *
 * The rule that decides accept-or-refuse is a pure function, so the tests below
 * RUN it rather than matching source text — a rule checked by regex is pinned,
 * not tested, and passes happily while the behaviour it describes rots. Only the
 * WIRING (which action calls it, which picker builds its list) is checked
 * structurally, because those modules are `use server` / `server-only` and
 * cannot be imported outside Next's bundler.
 */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

/**
 * Source with its comments stripped. Every "this must no longer be here" check
 * below runs against CODE — otherwise the comment explaining which call was
 * removed is enough to fail the assertion that it was removed.
 */
const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── The membership boundary, modelled ────────────────────────────────────────
// A stand-in for the TenantMember join in tenantActor.resolveTenantMemberUser:
// an id resolves only when the person is a member of the ACTING tenant, that
// tenant is active, and the account is not disabled. Anything else resolves to
// nobody — which is exactly the input the rule below has to refuse on.

type Member = { userId: string; tenantId: string };

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const TENANT_CLOSED = "tenant-closed";

const USERS = [
  { id: "u-alice", name: "Alice", disabled: false },
  { id: "u-bob", name: "Bob", disabled: false },
  { id: "u-mallory", name: "Mallory", disabled: false },
  { id: "u-dana", name: "Dana", disabled: true },
];

const MEMBERSHIPS: Member[] = [
  { userId: "u-alice", tenantId: TENANT_A },
  { userId: "u-bob", tenantId: TENANT_A },
  { userId: "u-dana", tenantId: TENANT_A },
  // Mallory works somewhere else entirely. She is a perfectly real User row, so
  // "does this user exist" says yes about her — which is why existence was never
  // the right question to ask.
  { userId: "u-mallory", tenantId: TENANT_B },
];

const ACTIVE_TENANTS = new Set([TENANT_A, TENANT_B]);

function lookupMember(actingTenantId: string, userId: string): AssignableCandidate {
  if (!ACTIVE_TENANTS.has(actingTenantId)) return null;
  const isMember = MEMBERSHIPS.some((m) => m.userId === userId && m.tenantId === actingTenantId);
  if (!isMember) return null;
  const user = USERS.find((u) => u.id === userId);
  if (!user || user.disabled) return null;
  return { id: user.id, name: user.name };
}

/** One assignment attempt, end to end: lookup, then the real rule. */
function attempt(actingTenantId: string, posted: unknown, label: string) {
  const id = normalizeAssigneeId(posted);
  const candidate = id === null ? null : lookupMember(actingTenantId, id);
  return decideAssignment(posted, candidate, label);
}

// The three fields from the audit, each with the word that names it to the user.
const FIELDS = [
  { field: "Contact.ownerId", label: "owner" },
  { field: "CustomerCase.assignedToId", label: "agent" },
  { field: "JobCard.technicianId", label: "technician" },
] as const;

// ── The refusal rule, executed ───────────────────────────────────────────────

for (const { field, label } of FIELDS) {
  test(`${field}: a user from ANOTHER tenant is refused`, () => {
    const outcome = attempt(TENANT_A, "u-mallory", label);
    assert.equal(outcome.ok, false, `${field} must refuse a user who is not a member of the acting tenant`);
    assert.equal(
      outcome.ok === false && outcome.message,
      assignmentRefusalMessage(label),
      "the refusal must say which field was rejected, in words the submitter can read",
    );
  });

  test(`${field}: a member of the acting tenant is accepted`, () => {
    const outcome = attempt(TENANT_A, "u-alice", label);
    assert.equal(outcome.ok, true, `${field} must accept an active member of the acting tenant`);
    assert.equal(outcome.ok === true && outcome.userId, "u-alice");
  });

  test(`${field}: a refused id does NOT fall through to unassigned`, () => {
    // The tempting fix — coerce anything that fails to resolve to null and save
    // the record anyway — makes an attempted cross-tenant assignment
    // indistinguishable from someone deliberately choosing "Unassigned", and
    // reports a successful save either way.
    const refused = attempt(TENANT_A, "u-mallory", label);
    const blank = attempt(TENANT_A, "", label);
    assert.equal(refused.ok, false, "a cross-tenant id must be refused");
    assert.equal(blank.ok, true, "an empty selection must still be allowed");
    assert.equal(blank.ok === true && blank.userId, null);
    assert.notDeepEqual(refused, blank, "refusal and deliberate unassignment must not be the same outcome");
  });

  test(`${field}: an id that does not exist at all is refused`, () => {
    assert.equal(attempt(TENANT_A, "u-nobody", label).ok, false);
  });

  test(`${field}: a DISABLED member of the acting tenant is refused`, () => {
    // Dana is a member of tenant A, so the join alone would pass her. A disabled
    // account must not be handed live work or notifications.
    assert.equal(attempt(TENANT_A, "u-dana", label).ok, false);
  });

  test(`${field}: with no resolvable tenant, nothing is assignable (fails closed)`, () => {
    // Mirrors the "closed" scope in tenantActor: no tenant, no members, so even
    // an id that is valid elsewhere resolves to nobody here.
    assert.equal(attempt(TENANT_CLOSED, "u-alice", label).ok, false);
    // …but leaving the field blank is still a legitimate no-op.
    assert.equal(attempt(TENANT_CLOSED, "", label).ok, true);
  });
}

test("the same id is accepted in its OWN tenant and refused in the other", () => {
  // The point of the whole contract: identity is not the question, membership of
  // the acting workspace is. Mallory is assignable — just not here.
  assert.equal(attempt(TENANT_B, "u-mallory", "owner").ok, true);
  assert.equal(attempt(TENANT_A, "u-mallory", "owner").ok, false);
  assert.equal(attempt(TENANT_A, "u-bob", "owner").ok, true);
  assert.equal(attempt(TENANT_B, "u-bob", "owner").ok, false);
});

test("blank, absent and whitespace-only selections all mean unassigned", () => {
  for (const posted of [null, undefined, "", "   ", "\t\n"]) {
    const outcome = decideAssignment(posted, null, "owner");
    assert.equal(outcome.ok, true, `${JSON.stringify(posted)} must be treated as "nobody"`);
    assert.equal(outcome.ok === true && outcome.userId, null);
  }
});

test("a submitted id is never trimmed away into a different person", () => {
  // The pickers post plain ids, but a padded value must still resolve to the
  // same person rather than being refused on whitespace alone.
  const outcome = attempt(TENANT_A, "  u-alice  ", "owner");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok === true && outcome.userId, "u-alice");
});

test("a lookup that answers with somebody ELSE is refused, not silently substituted", () => {
  // Belt and braces on the rule itself: if a lookup helper ever fell back to
  // "some user of this tenant" instead of THE user asked for, accepting its
  // answer would assign the wrong person while looking perfectly valid.
  const outcome = decideAssignment("u-mallory", { id: "u-alice", name: "Alice" }, "owner");
  assert.equal(outcome.ok, false, "the resolved candidate must be the very id that was posted");
});

// ── The shared contract exists, and goes through TenantMember ────────────────

test("resolveAssignableUser is ONE contract, resolved through tenant membership", () => {
  const code = read("src", "lib", "tenantActor.ts");
  assert.match(code, /export async function resolveAssignableUser\s*\(/, "the shared entry point must live in tenantActor");
  assert.match(code, /decideAssignment\s*\(/, "it must apply the shared rule rather than a second, private one");
  assert.match(code, /resolveTenantMemberUser\s*\(/, "it must resolve the id through the TenantMember join");
  assert.match(code, /throw new ActionRefusal\(/, "a refused assignment must fail with a message, not return null");

  // The rule module stays free of `server-only` so this test can execute it —
  // proven by the import at the top of this file, and pinned here so nobody adds
  // one back and quietly turns these tests into source-matching again.
  const rule = codeOf(read("src", "lib", "assignableUser.ts"));
  assert.doesNotMatch(rule, /import\s+"server-only"/, "assignableUser.ts must stay importable by tests");
  assert.doesNotMatch(rule, /@\/lib\/db|from "\.\/db"/, "the rule must not reach the database");
});

// ── Every one of the three actions is on the contract ────────────────────────

const ACTIONS = [
  {
    file: join("src", "app", "actions", "contacts.ts"),
    call: /resolveAssignableUser\(formData\.get\("ownerId"\), "owner"\)/,
    what: "Contact.ownerId",
    // The raw form value must no longer be able to reach the write.
    gone: [/ownerId:\s*str\("ownerId"\)/],
  },
  {
    file: join("src", "app", "actions", "helpdesk.ts"),
    call: /resolveAssignableUser\(formData\.get\("assigneeId"\), "agent"\)/,
    what: "CustomerCase.assignedToId",
    // The old check proved only that the global User row existed.
    gone: [/user\.findUnique\(\s*\{\s*where:\s*\{\s*id:\s*assigneeId\s*\}/],
  },
  {
    file: join("src", "app", "actions", "jobcards.ts"),
    call: /resolveAssignableUser\(formData\.get\("technicianId"\), "technician"\)/,
    what: "JobCard.technicianId",
    // The posted id used to be stored verbatim.
    gone: [/const technicianId = String\(formData\.get\("technicianId"\)/],
  },
] as const;

for (const { file, call, what, gone } of ACTIONS) {
  test(`${file}: ${what} is validated through the shared contract`, () => {
    const code = read(file);
    assert.match(code, /from "@\/lib\/tenantActor"/, `${file} must import the shared contract`);
    assert.match(code, call, `${what} must be resolved via resolveAssignableUser`);
    for (const pattern of gone) {
      assert.doesNotMatch(codeOf(code), pattern, `${what} must not keep its unvalidated path`);
    }
  });
}

test("setJobCardTechnician persists the RESOLVED technician, not the posted id", () => {
  const code = read("src", "app", "actions", "jobcards.ts");
  const start = code.indexOf("export async function setJobCardTechnician");
  assert.ok(start > 0, "setJobCardTechnician must exist");
  const body = code.slice(start, code.indexOf("export async function", start + 1));
  assert.match(body, /resolveAssignableUser\(/, "it must resolve the technician");
  assert.match(body, /technicianId: technician\?\.id \?\? null/, "and write what came back, not the form value");
});

test("assignTicket audits the name it actually validated", () => {
  const code = read("src", "app", "actions", "helpdesk.ts");
  const start = code.indexOf("export async function assignTicket");
  assert.ok(start > 0, "assignTicket must exist");
  const body = code.slice(start, code.indexOf("export async function", start + 1));
  assert.match(body, /resolveAssignableUser\(/, "it must resolve the agent");
  assert.match(body, /assignee\?\.id \?\? null/, "the stored id must come from the resolved member");
  assert.doesNotMatch(codeOf(body), /basePrisma\.user\./, "no global User lookup may remain in the assignment path");
});

// ── The pickers do not enumerate global User ─────────────────────────────────
// The action check is the boundary; the picker is the leak. A dropdown built
// from `user.findMany` shows one workspace the names of everyone who works at
// all the others, whether or not the id it posts is later refused.

const PICKERS = [
  join("src", "app", "(app)", "cases", "[id]", "page.tsx"),          // ticket assignee
  join("src", "app", "(app)", "jobcards", "[id]", "page.tsx"),       // job card technician
  join("src", "app", "(app)", "contacts", "new", "page.tsx"),        // contact owner (create)
  join("src", "app", "(app)", "contacts", "page.tsx"),               // contact owner (create dialog)
  join("src", "app", "(app)", "contacts", "[id]", "edit", "page.tsx"), // contact owner (edit)
] as const;

for (const file of PICKERS) {
  test(`${file}: staff list comes from listTenantStaff, not a global User scan`, () => {
    const code = read(file);
    assert.match(code, /listTenantStaff\s*\(\)/, `${file} must build its staff list via listTenantStaff`);
    assert.doesNotMatch(
      codeOf(code),
      /\buser\.findMany\s*\(/,
      `${file} must not enumerate the global User table (it is not tenant-scoped by anything)`,
    );
  });
}
