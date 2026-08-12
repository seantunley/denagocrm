import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideActingScope, decideActingOwner } from "../src/lib/actingScopeRule";

/**
 * These tests exist because every OTHER test in this area establishes a tenant
 * scope first, which selects the enforced branch — the branch that already worked.
 * The defect lived in the branch that runs in production: enforcement dormant.
 *
 * So each case below pins `enforcing: false` deliberately. That is the condition
 * under which `withTenantWrite` stamped the founding tenant onto every actor's
 * rows, `resolveTenantMemberUser` skipped its membership join, and
 * `listTenantStaff` returned the whole platform.
 */

const A = "tenant_a";
const B = "tenant_b";
const FOUNDING = "tenant_denago_cpt";

/* ---------------------------------------------------------------- DORMANT */

test("dormant + a session in B acts as B, not the founding tenant", () => {
  const scope = decideActingScope({
    enforcing: false,
    enforcedScope: { mode: "global" }, // what currentScopeClass() says while dormant
    sessionTenantId: B,
  });
  assert.deepEqual(scope, { mode: "tenant", tenantId: B });
});

test("dormant + a session in B stamps B onto the row it creates", () => {
  const owner = decideActingOwner({
    enforcedTenantId: null, // writeTenantId() is null while dormant — the whole bug
    sessionTenantId: B,
    fallbackTenantId: FOUNDING,
  });
  assert.equal(owner, B, "a contact created by B's staff must belong to B");
  assert.notEqual(owner, FOUNDING);
});

test("dormant + NO session stays global — cron and webhooks are unchanged", () => {
  // Background paths deliberately rely on this. They have no actor to resolve,
  // and inventing one is the same defect with the sign flipped.
  const scope = decideActingScope({
    enforcing: false,
    enforcedScope: { mode: "global" },
    sessionTenantId: null,
  });
  assert.deepEqual(scope, { mode: "global" });
});

test("a blank or whitespace session claim is not a workspace", () => {
  for (const blank of ["", "   "]) {
    assert.deepEqual(
      decideActingScope({ enforcing: false, enforcedScope: { mode: "global" }, sessionTenantId: blank }),
      { mode: "global" },
      `"${blank}" must not be treated as a tenant id`,
    );
  }
  assert.equal(
    decideActingOwner({ enforcedTenantId: "  ", sessionTenantId: "   ", fallbackTenantId: FOUNDING }),
    FOUNDING,
  );
});

/* -------------------------------------------------------------- ENFORCING */

test("enforcement is authoritative — a session never widens it", () => {
  // Closed means a chokepoint was missed or propagation was lost. A session must
  // not rescue it; that would turn a fail-closed into a silent wrong answer.
  assert.deepEqual(
    decideActingScope({ enforcing: true, enforcedScope: { mode: "closed" }, sessionTenantId: B }),
    { mode: "closed" },
  );
  assert.deepEqual(
    decideActingScope({ enforcing: true, enforcedScope: { mode: "tenant", tenantId: A }, sessionTenantId: B }),
    { mode: "tenant", tenantId: A },
    "the enforced scope wins over a stale session claim",
  );
});

test("the enforced tenant outranks the session when stamping", () => {
  assert.equal(
    decideActingOwner({ enforcedTenantId: A, sessionTenantId: B, fallbackTenantId: FOUNDING }),
    A,
  );
});

/* ------------------------------------------------------- the wiring itself */

test("createContact writes through the acting helper, not the dormant one", () => {
  // The rule being right is worthless if the caller does not use it. This is the
  // exact site the two-tenant harness caught persisting tenant_denago_cpt
  // regardless of actor.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "src/app/actions/contacts.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /withActingTenantWrite\(async \(tx, tenantId\) => \{/, "contact create must resolve the acting workspace");
  assert.doesNotMatch(code, /\bwithTenantWrite\(/, "no contact write may use the dormant-null helper");
  // Tags on an EXISTING contact belong to that contact, not to whoever edits it.
  assert.match(code, /const tenantId = contact\.tenantId \?\? actingTenantId;/);
});

/* ------------------------------------------- the rest of the converted callers */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Source with comments stripped, so a mention in prose can never satisfy a check. */
function stripped(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every USER-ORIGINATED write that #470 left on the dormant-null helper.
 *
 * Source-text assertions, and deliberately so: the defect is which HELPER a call
 * site reaches for, and that is a fact about the file. Executing these would mean
 * standing up Prisma, a session and two tenants to observe a value that
 * `decideActingOwner` — tested above, by execution — already pins. What no
 * executed test can catch is a caller that computes the right answer and then
 * writes through the wrong helper, which is exactly what happened.
 */
const CONVERTED: Array<{ file: string; why: string }> = [
  { file: "src/app/actions/contacts.ts", why: "contacts.create — the site the two-tenant harness caught" },
  { file: "src/app/actions/fleets.ts", why: "fleets.manage — createFleet" },
  { file: "src/app/actions/products.ts", why: "requireOwner — createProduct + its colours" },
  { file: "src/app/actions/library.ts", why: "library.manage — document upload and new versions" },
  { file: "src/app/actions/helpdesk.ts", why: "cases.create / cases.reply — tickets and replies" },
  { file: "src/app/actions/journeys.ts", why: "journeys.manage — createJourney and template install" },
];

for (const { file, why } of CONVERTED) {
  test(`${file} writes through the acting helper (${why})`, () => {
    const code = stripped(file);
    // `[<(]` because fleets.ts states the generic rather than inferring it —
    // `withActingTenantWrite<{ id: string }>((tx, tenantId) => …)`.
    assert.match(
      code,
      /withActingTenantWrite[<(]/,
      "a signed-in person triggered this, so the owner is the acting workspace",
    );
    assert.doesNotMatch(
      code,
      /\bwithTenantWrite[<(]/,
      "withTenantWrite resolves writeTenantId() ?? DEFAULT_TENANT_ID, and writeTenantId() " +
        "is null while enforcement is dormant — so it stamps the FOUNDING tenant on every " +
        "actor's rows. A convincingly wrong owner passes every shape-based test.",
    );
  });
}

/**
 * WHERE A WRITE HAS A PARENT, THE CHILD INHERITS THE PARENT'S TENANT.
 *
 * Not the actor's. An admin acting in another workspace's record must not re-own
 * its children — #470 established this for contact tags and the #459 review raised
 * the same invariant for saveQuoteDraft. `?? actingTenantId` is the legacy clause:
 * these parent columns are still nullable, so an unstamped parent falls back to the
 * acting workspace rather than writing a tenantless child.
 */
const INHERITS_PARENT: Array<{ file: string; expression: RegExp; child: string; parent: string }> = [
  {
    file: "src/app/actions/contacts.ts",
    expression: /const tenantId = contact\.tenantId \?\? actingTenantId;/,
    child: "tag links",
    parent: "the contact being edited",
  },
  {
    file: "src/app/actions/library.ts",
    expression: /const tenantId = document\.tenantId \?\? actingTenantId;/,
    child: "a new version",
    parent: "the library document it revises",
  },
  {
    file: "src/app/actions/helpdesk.ts",
    expression: /const tenantId = contact\?\.tenantId \?\? actingTenantId;/,
    child: "a ticket",
    parent: "the customer it is about",
  },
  {
    file: "src/app/actions/helpdesk.ts",
    expression: /const tenantId = item\.tenantId \?\? actingTenantId;/,
    child: "a staff reply",
    parent: "the ticket it answers",
  },
];

for (const { file, expression, child, parent } of INHERITS_PARENT) {
  test(`${child} inherit(s) the tenant of ${parent}`, () => {
    assert.match(
      stripped(file),
      expression,
      `${child} must take the owner of ${parent}, never the actor's workspace`,
    );
  });
}

test("the ticket reply can actually read its parent's owner", () => {
  // The inheritance above is only as good as the SELECT behind it. Dropping
  // `tenantId` from loadCase would leave `item.tenantId` undefined, the `??` would
  // swallow it silently, and every reply would quietly go back to the actor's
  // workspace — the defect restored with the fix still in place.
  const code = stripped("src/app/actions/helpdesk.ts");
  const load = code.slice(code.indexOf("async function loadCase"));
  assert.match(load.slice(0, 400), /tenantId: true/, "loadCase must select the tenant it is trusted for");
});

test("installJourneyTemplates reads and writes the SAME workspace", () => {
  // The existence check was unscoped while the write was not. Once the founding
  // tenant held the templates, every other workspace matched `exists` and installed
  // nothing — the button reported success and did nothing. A scoped write with an
  // unscoped read is the same disagreement, on the read side.
  const code = stripped("src/app/actions/journeys.ts");
  const install = code.slice(code.indexOf("export async function installJourneyTemplates"));
  assert.match(install, /const ownScope = await journeyScope\(\);/, "the acting workspace must be resolved");
  const scopeAt = install.indexOf("journeyScope()");
  const findAt = install.indexOf("prisma.journey.findFirst");
  assert.ok(scopeAt > -1 && findAt > scopeAt, "the scope must be resolved before the check that uses it");
  // RESOLVING it is not USING it. The first version of this test asserted only that
  // `journeyScope()` was called, which a `where` clause that never spread the result
  // satisfied just as happily — the unscoped read survived the check that existed to
  // catch it. Assert the predicate reaches the query.
  const query = install.slice(findAt, install.indexOf("if (exists) continue;"));
  assert.match(query, /\.\.\.ownScope/, "the resolved scope must be spread into the dedupe query itself");
});

/**
 * THE SITES THAT WERE ENTANGLED, AND MOVED TOGETHER.
 *
 * This replaces the pin #473 left here. The bot stack resolves ONE tenant for both
 * halves of a conversation: staff writes (`enqueueStaffReply`,
 * `pauseBotConversation`) and the runtime/drain reads that have to see them
 * (`outboxTenantId`, `botStillOwnsTx`, `claimOldest`) were all
 * `writeTenantId() ?? DEFAULT_TENANT_ID`. They agreed because they were wrong
 * together, and converting either half alone writes a reply — or a takeover — into
 * a workspace nothing reads.
 *
 * They now resolve ONE expression, `botConversationTenantId`. The assertion is
 * therefore the mirror image of the old pin: every one of these files must go
 * through it, and NONE of them may reach for a second answer. `withTenantWrite`
 * would put the dormant-null value back, and `withActingTenantWrite` would answer
 * the staff half differently from the runtime half — the two ways this comes apart.
 */
const BOT_CONVERSATION_FILES = [
  "src/lib/botOutbox.ts",
  "src/lib/botOutboxWrite.ts",
  "src/lib/botConversationControl.ts",
  "src/lib/botInboundEvent.ts",
  "src/lib/botSessionStore.ts",
  "src/lib/flowRun.ts",
  "src/lib/flowSession.ts",
  "src/lib/flowScope.ts",
];

test("every bot conversation site resolves ONE workspace expression", () => {
  for (const file of BOT_CONVERSATION_FILES) {
    const source = stripped(file);
    assert.match(
      source,
      /botConversationTenantId|withBotConversationWrite/,
      `${file} must resolve the shared bot-conversation workspace, not a private answer`,
    );
    assert.doesNotMatch(
      source,
      /\bwithTenantWrite\(/,
      `${file} would restore the dormant-null founding tenant its siblings no longer use`,
    );
    assert.doesNotMatch(
      source,
      /withActingTenantWrite\(/,
      `${file} would answer the staff half differently from the runtime half`,
    );
  }
});

test("the shared expression is the ambient ladder, not a fourth copy of the rule", () => {
  // Rung 2 of `inheritedTenantId` is `currentTenantScope()?.tenantId` — the channel
  // scope at a webhook, the acting workspace at the inbox, the row's own tenant on
  // the drain. Re-deriving it here would be a rule that exists twice, which is a
  // rule that gets fixed once.
  const botTenant = stripped("src/lib/botTenant.ts");
  assert.match(botTenant, /return inheritedTenantId\(null\);/);
  assert.doesNotMatch(botTenant, /DEFAULT_TENANT_ID/, "the founding fallback belongs to the ladder, not to a copy of it");
});

test("the staff half binds its workspace and never replaces one that outranks it", () => {
  const actingScope = stripped("src/lib/actingScope.ts");
  const start = actingScope.indexOf("export async function withStaffConversationScope");
  assert.ok(start > -1, "withStaffConversationScope is missing");
  const body = actingScope.slice(start, actingScope.indexOf("export async function withActingTenantWrite"));
  // An enforced scope, a webhook scope or a cron slice all outrank a session.
  assert.match(body, /if \(currentTenantScope\(\)\) return fn\(\);/, "an existing scope must win");
  assert.match(body, /runInTenantScope\(\{ tenantId, system: false \}/, "and it is never a system scope");
});

test("publishFlowSnapshot resolves its own tenant and must not start shadowing it", () => {
  // Already correct before this change: withTenantWrite is used for the TRANSACTION
  // only, and the tenant comes from builderTenantId() — the same ladder the acting
  // scope applies. Binding the callback's second parameter would silently reinstate
  // the dormant-null value over a correctly resolved one.
  const publishing = stripped("src/lib/flowPublishing.ts");
  const publish = publishing.slice(publishing.indexOf("export async function publishFlowSnapshot"));
  assert.match(publish, /const tenantId = await builderTenantId\(\);/);
  assert.match(publish, /withTenantWrite\(async \(tx\) =>/, "the transaction client only");
  assert.doesNotMatch(publish, /withTenantWrite\(async \(tx, tenantId\)/, "never shadow the resolved tenant");
});

test("the acting resolvers exist and classify with the acting scope", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const actor = readFileSync(path.join(root, "src/lib/tenantActor.ts"), "utf8");

  for (const fn of ["resolveActingTenantMemberUser", "listActingTenantStaff"]) {
    const start = actor.indexOf(`export async function ${fn}`);
    assert.ok(start > -1, `${fn} is missing`);
    // To the end of the function, not a fixed 400-character window. The window
    // measured comment length as much as code: adding an explanatory note above
    // the query pushed the TenantMember join out of range and failed this for a
    // reason that had nothing to do with the rule.
    const end = actor.indexOf("\n}", start);
    assert.ok(end > start, `${fn}: could not find the end of the function`);
    const body = actor.slice(start, end);
    assert.match(body, /await actingScopeClass\(\)/, `${fn} must classify with the acting scope`);
    assert.match(body, /TenantMember/, `${fn} must join TenantMember in tenant mode`);
    // The whole point of the acting variants: an unresolvable session is a
    // refusal, never the platform-wide fallback the background variants keep.
    assert.match(
      body,
      /if \(s\.mode !== "tenant"\) return (null|\[\]);/,
      `${fn} must refuse anything that is not a resolved workspace`,
    );
  }

  // The originals must be LEFT ALONE — background and token paths rely on them.
  assert.match(actor, /const actorScope = currentScopeClass;/, "the background resolvers must keep their semantics");
});
