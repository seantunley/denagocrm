import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decideAssignment,
  normalizeAssigneeId,
  assignmentRefusalMessage,
  resolveAssignment,
  type AssignableCandidate,
} from "../src/lib/assignableUser";
import { ActionRefusal } from "../src/lib/actionFailure";
import { collectAssignedUserIds } from "../src/lib/journeyTypes";

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

/**
 * The same attempt through the REAL composition the actions call.
 *
 * `attempt` above exercises the rule with the lookup done by hand. This one runs
 * `resolveAssignment` — normalise, look up, decide, refuse — which is the actual
 * body of `resolveAssignableUser`, with only the TenantMember join swapped for
 * the stand-in above. That is the difference between checking that the rule is
 * right and checking that the thing the actions call applies it.
 */
const lookupFor = (actingTenantId: string) => async (userId: string) =>
  lookupMember(actingTenantId, userId);

function resolveVia(actingTenantId: string, posted: unknown, label = "owner") {
  return resolveAssignment(posted, label, lookupFor(actingTenantId));
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

// ── The contract as the actions actually call it, EXECUTED ───────────────────
//
// Everything above tests the rule. These test the composition around it — the
// body of `resolveAssignableUser`, with only the database swapped out. They
// exist because of the single most tempting regression in this whole area:
// swallow the refusal, return null, let the save proceed. That change leaves the
// lookup call, the rule call, and every one of the ten call sites looking
// exactly right, so nothing that reads source can see it. Running it can.

for (const { field, label } of FIELDS) {
  test(`${field}: the contract THROWS on a cross-tenant id — it does not return null`, async () => {
    await assert.rejects(
      () => resolveVia(TENANT_A, "u-mallory", label),
      (error: unknown) => {
        assert.ok(error instanceof ActionRefusal, "a refusal must be an ActionRefusal, so the submitter is told why");
        assert.equal((error as ActionRefusal).message, assignmentRefusalMessage(label));
        return true;
      },
      `${field} must refuse, not quietly unassign`,
    );
  });
}

test("the contract returns the MEMBER for a valid id, so the caller can audit the name", async () => {
  const member = await resolveVia(TENANT_A, "u-alice");
  assert.deepEqual(member, { id: "u-alice", name: "Alice" });
});

test("the contract returns null ONLY for a deliberately blank selection", async () => {
  for (const posted of [null, undefined, "", "   ", "\t\n"]) {
    assert.equal(await resolveVia(TENANT_A, posted), null, `${JSON.stringify(posted)} means nobody`);
  }
});

test("refusal and deliberate unassignment are DIFFERENT outcomes, not both null", async () => {
  // The whole argument for throwing. If a refused id came back as null, an
  // attempted cross-tenant assignment and someone choosing "Unassigned" would
  // produce the same write, the same audit line and the same "saved" message.
  assert.equal(await resolveVia(TENANT_A, ""), null, "blank is an allowed no-op");
  await assert.rejects(() => resolveVia(TENANT_A, "u-mallory"), ActionRefusal);
});

test("a disabled member is refused by the contract, not just by the rule", async () => {
  await assert.rejects(() => resolveVia(TENANT_A, "u-dana"), ActionRefusal);
});

test("an id that exists nowhere is refused by the contract", async () => {
  await assert.rejects(() => resolveVia(TENANT_A, "u-nobody"), ActionRefusal);
});

test("with no resolvable tenant the contract refuses everything but blank", async () => {
  // Fail closed: the "closed" scope in tenantActor resolves nobody, so even an
  // id that is valid in its own workspace must not resolve here.
  await assert.rejects(() => resolveVia(TENANT_CLOSED, "u-alice"), ActionRefusal);
  assert.equal(await resolveVia(TENANT_CLOSED, ""), null);
});

test("the contract accepts the same person in their own tenant and refuses them in the other", async () => {
  assert.deepEqual(await resolveVia(TENANT_B, "u-mallory"), { id: "u-mallory", name: "Mallory" });
  await assert.rejects(() => resolveVia(TENANT_A, "u-mallory"), ActionRefusal);
  assert.deepEqual(await resolveVia(TENANT_A, "u-bob"), { id: "u-bob", name: "Bob" });
  await assert.rejects(() => resolveVia(TENANT_B, "u-bob"), ActionRefusal);
});

test("the contract never asks the lookup about a blank id", async () => {
  // A lookup called with "" is a query that cannot mean anything, and a helper
  // that answered it with "some user" would be a cross-tenant assignment with a
  // valid-looking provenance.
  const asked: string[] = [];
  const spy = async (userId: string) => {
    asked.push(userId);
    return lookupMember(TENANT_A, userId);
  };
  await resolveAssignment("", "owner", spy);
  await resolveAssignment(null, "owner", spy);
  assert.deepEqual(asked, [], "blank must short-circuit before the database");
  await resolveAssignment("u-alice", "owner", spy);
  assert.deepEqual(asked, ["u-alice"], "and a real id must be looked up exactly as posted");
});

test("a lookup that answers with somebody ELSE is refused by the contract too", async () => {
  // Belt and braces around the composition, not just the rule: if the join ever
  // fell back to "some member of this tenant", accepting its answer would assign
  // the wrong person while every check above still passed.
  const wrongPerson = async () => ({ id: "u-alice", name: "Alice" });
  await assert.rejects(
    () => resolveAssignment("u-mallory", "owner", wrongPerson),
    ActionRefusal,
    "the resolved member must be the very id that was posted",
  );
});

// ── The shared contract exists, and goes through TenantMember ────────────────

test("resolveAssignableUser is ONE contract, resolved through tenant membership", () => {
  const code = read("src", "lib", "tenantActor.ts");
  assert.match(code, /export async function resolveAssignableUser\s*\(/, "the shared entry point must live in tenantActor");
  assert.match(code, /resolveTenantMemberUser\s*\(/, "it must resolve the id through the TenantMember join");
  // The composition moved DOWN into assignableUser.ts, so what is left here is
  // the entry point handing the real join to it. What it must not do is grow a
  // second body of its own again.
  assert.match(
    code,
    /return resolveAssignment\(raw, label, resolveTenantMemberUser\)/,
    "it must delegate to the executable composition, not re-implement it behind server-only",
  );
  assert.doesNotMatch(
    codeOf(code),
    /decideAssignment\s*\(/,
    "the rule must be applied by resolveAssignment, not a second time here",
  );

  // The rule module stays free of `server-only` so this test can execute it —
  // proven by the import at the top of this file, and pinned here so nobody adds
  // one back and quietly turns these tests into source-matching again.
  const rule = codeOf(read("src", "lib", "assignableUser.ts"));
  assert.doesNotMatch(rule, /import\s+"server-only"/, "assignableUser.ts must stay importable by tests");
  assert.doesNotMatch(rule, /@\/lib\/db|from "\.\/db"/, "the rule must not reach the database");
  assert.match(
    rule,
    /throw new ActionRefusal\(/,
    "a refused assignment must fail with a message, not return null",
  );
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
  // The four that were still on the global table.
  join("src", "app", "(app)", "contacts", "[id]", "page.tsx"),       // activity assignee (contact)
  join("src", "app", "(app)", "leads", "[id]", "page.tsx"),          // lead assignee + activity assignee
  join("src", "app", "(app)", "leads", "new", "page.tsx"),           // lead assignee (create)
  join("src", "app", "(app)", "journeys", "page.tsx"),               // journey "Assign lead" step
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

// ── ONE implementation, not five that happen to agree ────────────────────────
//
// Everything above this line was already true when four more actions each kept
// their own private copy of the membership check. Every copy VALIDATED
// CORRECTLY, which is exactly why they were easy to leave alone — and exactly
// what makes them dangerous: the rule only has to rot in one of them, and the
// four had already drifted in wording, in what they did with a blank id, and in
// whether they threw or returned. quickCreate.ts is the proof that drift is not
// hypothetical. It validated `assignedToId` before delegating to
// scheduleActivity, so the quick-create path was safe while the ordinary path
// through the same action had no check at all.

const CONSOLIDATED = [
  {
    file: join("src", "app", "actions", "leads.ts"),
    what: "Lead.assignedToId",
    call: /resolveAssignableUser\(/,
    // The private copy, by name and by engine.
    gone: [/async function requireAssignableUser\s*\(/, /\bresolveTenantMemberUser\s*\(/],
  },
  {
    file: join("src", "app", "actions", "testDrives.ts"),
    what: "TestDriveBooking.salespersonId",
    call: /resolveAssignableUser\(userId, label\)/,
    gone: [/\bresolveTenantMemberUser\s*\(/],
  },
  {
    file: join("src", "app", "actions", "quickCreate.ts"),
    what: "the quick-create gateway",
    call: /resolveAssignableUser\(formData\.get\(key\), label\)/,
    gone: [/\bresolveTenantMemberUser\s*\(/],
  },
  {
    file: join("src", "app", "actions", "surveyFollowUps.ts"),
    what: "SurveyFollowUp.ownerId",
    call: /resolveAssignableUser\(formData\.get\("ownerId"\), "owner"\)/,
    // The posted value used to be trimmed by hand and written straight into raw
    // SQL, which no tenant guard inspects.
    gone: [/\bresolveTenantMemberUser\s*\(/, /const ownerId = String\(formData\.get\("ownerId"\)/],
  },
  {
    file: join("src", "app", "actions", "activities.ts"),
    what: "Activity.assignedToId",
    call: /resolveAssignableUser\(formData\.get\("assignedToId"\), "team member"\)/,
    // This one had NO check to consolidate — it wrote the posted id directly.
    gone: [/str\(formData, "assignedToId"\)\s*\?\?\s*user\.id/],
  },
  {
    file: join("src", "app", "actions", "journeys.ts"),
    what: "the assign_user journey step",
    call: /resolveAssignableUser\(userId, "team member"\)/,
    gone: [],
  },
] as const;

for (const { file, what, call, gone } of CONSOLIDATED) {
  test(`${file}: ${what} is on the shared contract, with no private copy left`, () => {
    const code = read(file);
    assert.match(code, /from "@\/lib\/tenantActor"/, `${file} must import the shared contract`);
    assert.match(code, call, `${what} must be resolved via resolveAssignableUser`);
    for (const pattern of gone) {
      assert.doesNotMatch(codeOf(code), pattern, `${what} must not keep a second implementation of the rule`);
    }
  });
}

test("no assignment action reaches past the contract to the raw membership lookup", () => {
  // `resolveTenantMemberUser` is the DATABASE half. Calling it directly is how
  // each of the four copies began: it answers "is this person a member" and
  // leaves every caller to invent what to do about the answer — which is the
  // part they all invented differently. Actions go through
  // `resolveAssignableUser`, which pairs the lookup with the shared rule.
  //
  // signing/approvals.ts is the deliberate exception and stays out of this
  // sweep: it resolves a STORED assignee while a cron delivers an approval
  // email, with nobody present to be refused, so "returns null" is the outcome
  // it needs rather than a throw. Listed here so the exemption is a decision
  // somebody made rather than a file nobody checked.
  for (const file of CONSOLIDATED) {
    const code = codeOf(read(file.file));
    assert.doesNotMatch(
      code,
      /\bresolveTenantMemberUser\s*\(/,
      `${file.file} must ask the contract, not the raw lookup`,
    );
  }
});

// ── The differences between the copies that were kept ────────────────────────
//
// Consolidation is only safe if it preserves what each call site actually did.
// These pin the three real differences, so a later tidy-up that flattens them
// has to fail a test rather than quietly change who gets assigned to what.

test("assignLead still REFUSES BY RETURN, not by throw", () => {
  // The kanban board assigns by drag: it awaits the result, checks `ok` and
  // shows `error` in a toast. `resolveAssignableUser` throws, so this one call
  // site catches and converts — and the sentence it converts to is the one the
  // board has always shown. Turning this into a bare throw would surface as the
  // board's generic "Something went wrong" and lose the reason.
  const code = read("src", "app", "actions", "leads.ts");
  const start = code.indexOf("export async function assignLead");
  assert.ok(start > 0, "assignLead must exist");
  const body = code.slice(start, code.indexOf("export async function", start + 1));
  assert.match(body, /resolveAssignableUser\(/, "it must resolve through the shared contract");
  assert.match(body, /\.catch\(\(\) => null\)/, "and convert the throw into the value the board expects");
  assert.match(
    body,
    /if \(!assignee\) return \{ ok: false as const, error: "That team member is no longer available\." \}/,
    "a refusal must still be a returned error, with the wording the toast already showed",
  );
  // The point of the whole exercise: a refusal must not fall through to the
  // update with a null assignee.
  assert.ok(
    body.indexOf("return { ok: false") < body.indexOf("prisma.lead.update"),
    "the refusal must return BEFORE the lead is written",
  );
});

test("assignLead is the ONLY place a refusal is caught, and it converts rather than drops it", () => {
  // Found by mutation testing, which is the only reason it is here: adding
  // `.catch(() => null)` to the lead assignee resolver passed every other test
  // in this file. It is the single most damaging change available in this whole
  // area — a cross-tenant assignee on a lead stops being a refusal and becomes a
  // silent "Unassigned", the save reports success, and the audit trail records
  // nothing about the attempt. It is also, from a distance, indistinguishable
  // from the legitimate catch in assignLead.
  //
  // So the rule is not "never catch", it is "catch only where the refusal is
  // handed on". Every consolidated call site is checked for a swallow, and the
  // one permitted catch has to be the one that returns the refusal to the board.
  // Matched by POSITION, not by text. The first attempt at this test compared
  // the offending line against the permitted one and caught nothing: the swallow
  // inside `resolveLeadAssignee` is character-for-character identical to the
  // legitimate catch in `assignLead`, because both read the same variable with
  // the same label. Where the catch sits is the whole difference.
  const swallow = /resolve(?:AssignableUser|LeadAssignee|ActivityAssignee|Assignment)\s*\([^\n]*?\.catch\s*\(/g;

  for (const { file, what } of CONSOLIDATED) {
    const code = codeOf(read(file));
    // The one function allowed to catch, if this file has it.
    const permittedStart = code.indexOf("export async function assignLead");
    const permittedEnd =
      permittedStart < 0 ? -1 : code.indexOf("export async function", permittedStart + 1);

    for (const match of code.matchAll(swallow)) {
      const at = match.index ?? 0;
      const insidePermitted =
        permittedStart >= 0 && at > permittedStart && (permittedEnd < 0 || at < permittedEnd);
      assert.ok(
        insidePermitted,
        `${what} in ${file} swallows an assignment refusal at offset ${at}. A caught refusal must be `
          + `handed on (as assignLead does), never turned into "nobody" — that makes an attempted `
          + `cross-tenant assignment and a deliberate Unassigned the same save, and reports success.`,
      );
    }
  }

  // And the one that is allowed to catch must still turn it into a refusal.
  const leads = read("src", "app", "actions", "leads.ts");
  const start = leads.indexOf("export async function assignLead");
  const body = leads.slice(start, leads.indexOf("export async function", start + 1));
  assert.match(body, /if \(!assignee\) return \{ ok: false as const/, "the caught refusal must be returned, not dropped");
});

test("resolveLeadAssignee lets the refusal through to the caller", () => {
  // The narrow version of the sweep above, pinned to the helper both lead write
  // paths go through. Blank means unassigned; a NAMED person who is not a member
  // must reach the caller as a throw.
  const code = read("src", "app", "actions", "leads.ts");
  const start = code.indexOf("async function resolveLeadAssignee");
  assert.ok(start > 0, "resolveLeadAssignee must exist");
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.doesNotMatch(
    codeOf(body),
    /\.catch\s*\(/,
    "createLead and updateLead must fail loudly on an unassignable person, not save the lead with nobody on it",
  );
});

test("a test drive still names WHICH of its two people was rejected", () => {
  // Two salespeople on one booking, so a refusal that did not say which field
  // was wrong would be unactionable. The shared contract takes `label` for
  // exactly this, and both labels survive.
  const code = read("src", "app", "actions", "testDrives.ts");
  assert.match(code, /requireAssignableStaff\(salespersonId, "salesperson"\)/);
  assert.match(code, /requireAssignableStaff\(accompanyingSalespersonId, "accompanying salesperson"\)/);
  assert.notEqual(
    assignmentRefusalMessage("salesperson"),
    assignmentRefusalMessage("accompanying salesperson"),
    "the two fields must not produce the same sentence",
  );
});

test("a test drive still refuses a BLANK assignee, where other surfaces allow it", () => {
  // Everywhere else a cleared picker legitimately means "nobody", and the shared
  // contract returns null for it. A booking names a person in both fields, and
  // the copy this replaced threw on a blank id, so the wrapper keeps throwing.
  const code = read("src", "app", "actions", "testDrives.ts");
  const start = code.indexOf("async function requireAssignableStaff");
  assert.ok(start > 0, "requireAssignableStaff must exist");
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.match(body, /if \(!member\) throw new ActionRefusal\(/, "a blank id must still be refused here");
  // And the rule it refuses with is the shared one, not a fifth sentence.
  assert.match(body, /assignmentRefusalMessage\(label\)/);
});

test("the quick-create gateway names the field it is guarding", () => {
  // One shared helper, three different fields behind it. A single sentence for
  // all three would tell somebody their CONTACT OWNER was wrong when what they
  // picked was a lead's team member.
  const code = read("src", "app", "actions", "quickCreate.ts");
  assert.match(code, /requireTenantMember\(formData, "assignedToId", "team member"\)/);
  assert.match(code, /requireTenantMember\(formData, "ownerId", "owner"\)/);
});

// ── The resolved id is what gets written ─────────────────────────────────────

const RESOLVED_WRITES = [
  {
    file: join("src", "app", "actions", "leads.ts"),
    what: "createLead / updateLead",
    // `data` is spread into the update, so the resolved id has to land on it.
    pattern: /data\.assignedToId = await resolveLeadAssignee\(data\.assignedToId\)/,
  },
  {
    file: join("src", "app", "actions", "surveyFollowUps.ts"),
    what: "assignSurveyFollowUp",
    pattern: /const ownerId = owner\?\.id \?\? null/,
  },
  {
    file: join("src", "app", "actions", "activities.ts"),
    what: "scheduleActivity",
    pattern: /const assignedToId = assignee\?\.id \?\? user\.id/,
  },
  {
    file: join("src", "app", "actions", "updateActivity"),
    what: "updateActivity",
    pattern: /const assignedToId = \(await resolveActivityAssignee\(formData\)\)\?\.id \?\? user\.id/,
    readFrom: join("src", "app", "actions", "activities.ts"),
  },
] as const;

for (const entry of RESOLVED_WRITES) {
  test(`${entry.what}: writes the RESOLVED assignee, never the posted one`, () => {
    const code = read("readFrom" in entry ? entry.readFrom : entry.file);
    assert.match(
      code,
      entry.pattern,
      `${entry.what} must persist what the contract returned, so the unvalidated value has no route into the write`,
    );
  });
}

test("scheduleActivity audits the name it validated, not one from a global lookup", () => {
  const code = read("src", "app", "actions", "activities.ts");
  const start = code.indexOf("export async function scheduleActivity");
  assert.ok(start > 0, "scheduleActivity must exist");
  const body = code.slice(start, code.indexOf("async function finishActivity", start));
  assert.doesNotMatch(
    codeOf(body),
    /prisma\.user\.findUnique\s*\(/,
    "the audit line's name must come from the resolved member, not a fresh global User read",
  );
});

// ── Journeys: an assignment that is STORED, not submitted ────────────────────
//
// The other surfaces refuse a bad assignee at the moment somebody posts it. A
// journey saves one and replays it: journeyStepExecutor scopes the LEAD it
// updates but writes `config.userId` unexamined, so a stranger picked once out
// of an unscoped dropdown would be reassigned this workspace's leads on every
// run afterwards, with nobody present to see a refusal.

test("collectAssignedUserIds finds a top-level assign_user step", () => {
  const ids = collectAssignedUserIds({
    startStepId: "a",
    steps: [{ id: "a", type: "assign_user", config: { userId: "u-mallory" } }],
  });
  assert.deepEqual(ids, ["u-mallory"]);
});

test("collectAssignedUserIds finds one NESTED inside a choose branch", () => {
  // The reason the walk is over the raw shape rather than the parsed `steps`
  // array: containers keep their children as plain objects inside `config`, so
  // a top-level-only scan would validate the journey and miss the assignment.
  const ids = collectAssignedUserIds({
    startStepId: "c",
    steps: [
      {
        id: "c",
        type: "choose",
        config: {
          options: [
            {
              conditions: {},
              sequence: [{ id: "n1", type: "assign_user", config: { userId: "u-mallory" } }],
            },
          ],
          default: [{ id: "n2", type: "assign_user", config: { userId: "u-bob" } }],
        },
      },
    ],
  });
  assert.deepEqual(ids.sort(), ["u-bob", "u-mallory"]);
});

test("collectAssignedUserIds finds one nested inside a repeat sequence", () => {
  const ids = collectAssignedUserIds({
    startStepId: "r",
    steps: [
      {
        id: "r",
        type: "repeat",
        config: {
          mode: "count",
          count: 3,
          sequence: [
            {
              id: "r1",
              type: "repeat",
              config: {
                mode: "count",
                count: 2,
                sequence: [{ id: "r2", type: "assign_user", config: { userId: "u-mallory" } }],
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(ids, ["u-mallory"], "depth must not be a way out of the check");
});

test("collectAssignedUserIds ignores steps that assign nobody, and other step types", () => {
  const ids = collectAssignedUserIds({
    startStepId: "a",
    steps: [
      { id: "a", type: "assign_user", config: {} },
      { id: "b", type: "assign_user", config: { userId: "" } },
      { id: "c", type: "assign_user", config: { userId: "   " } },
      { id: "d", type: "send_email", config: { userId: "u-mallory" } },
      { id: "e", type: "assign_user", config: { userId: 42 } },
    ],
  });
  assert.deepEqual(ids, [], "a step that assigns nobody is not an assignment to refuse");
});

test("collectAssignedUserIds reports each person once", () => {
  const ids = collectAssignedUserIds({
    startStepId: "a",
    steps: [
      { id: "a", type: "assign_user", config: { userId: "u-mallory" } },
      { id: "b", type: "assign_user", config: { userId: " u-mallory " } },
    ],
  });
  assert.deepEqual(ids, ["u-mallory"], "the same id twice is one membership question");
});

test("every journey write path checks its assign_user steps", () => {
  const code = read("src", "app", "actions", "journeys.ts");
  assert.match(code, /async function assertStepAssigneesResolve\(/, "the check must exist");
  assert.match(code, /collectAssignedUserIds\(/, "and must walk the definition for assignments");
  for (const fn of ["createJourney", "saveJourneyDraft", "publishJourney"] as const) {
    const start = code.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} must exist`);
    const next = code.indexOf("export async function", start + 1);
    const body = code.slice(start, next === -1 ? undefined : next);
    assert.match(
      body,
      /assertStepAssigneesResolve\(/,
      `${fn} writes or activates a definition, so it must check who that definition assigns to`,
    );
  }
});

// ── The empty staff list is SHOWN, not hidden ────────────────────────────────
//
// A consequence of scoping these lists: empty is now reachable, where a scan of
// every User row on the platform never was. ContactForm renders its owner
// dropdown only for a non-empty list, so the field vanishes — which reads as a
// form that has lost a control rather than a team with nobody in it. The two
// components behind the four pickers fixed here render the field either way.

const EMPTY_STATES = [
  { file: join("src", "components", "LeadForm.tsx"), what: "the lead's Assigned to" },
  { file: join("src", "components", "ActivityPanel.tsx"), what: "the activity assignee" },
] as const;

for (const { file, what } of EMPTY_STATES) {
  test(`${file}: ${what} field stays put when nobody is assignable`, () => {
    const code = read(file);
    assert.doesNotMatch(
      codeOf(code),
      /\{users\.length > 0 && \(/,
      `${what} must not disappear on an empty staff list — a missing control is not an empty state`,
    );
    assert.match(
      code,
      /users\.length === 0 \?/,
      `${what} must render an explicit empty state`,
    );
    assert.match(
      code,
      /<select className="input" disabled/,
      `${what} must be a disabled select with an explanation, not a <select> with no options`,
    );
    // A disabled select submits nothing, which the actions already read as
    // "assign it to me" — so the empty state changes what is SHOWN and not what
    // is SAVED. A `name` on it would start submitting a value that no member
    // backs.
    assert.doesNotMatch(
      code,
      /<select className="input" disabled[^>]*\sname=/,
      "the disabled placeholder must not submit a value",
    );
  });
}

test("the activity edit picker cannot silently reassign to the first person on the list", () => {
  // The second way a scoped list bites: on an edit, the current assignee may no
  // longer be in it. A `defaultValue` matching no option makes the browser
  // select the FIRST one, so an ordinary save would hand the task to whoever
  // sorts first alphabetically — a wrong assignment that looks like a
  // deliberate one.
  const code = read("src", "components", "ActivityPanel.tsx");
  assert.match(
    code,
    /defaultValue=\{users\.some\(\(u\) => u\.id === a\.assignedTo\.id\) \? a\.assignedTo\.id : ""\}/,
    "an assignee who is not in the scoped list must fall back to the blank option, not to users[0]",
  );
});
