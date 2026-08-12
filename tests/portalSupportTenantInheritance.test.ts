import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Audit P1-5 — portal and support raw writes.
 *
 * Both surfaces wrote through `basePrisma` (the documented RLS bypass) and both
 * resolved the owner from something that is empty or wrong while enforcement is
 * DORMANT, which is every environment we run:
 *
 *   - portal   `currentTenantScope()?.tenantId ?? null` → always null, because no
 *              scope is entered while dormant. Every portal case, notification and
 *              profile-change request landed tenantless.
 *   - helpdesk `writeTenantId() ?? DEFAULT_TENANT_ID` → always the FOUNDING tenant,
 *              regardless of which workspace the case belongs to. Worse than a
 *              null: it looks correct.
 *
 * Neither surface has an acting workspace to resolve. A portal request carries a
 * customer's OTP session, not a staff session; a helpdesk notification belongs to
 * the contact it is about, not to whoever clicked. So the owner must be INHERITED
 * from the parent record in both cases.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
/** Source with comments stripped — a rule must not be satisfied by prose about it. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("every portal write inherits the contact's workspace", () => {
  const portal = code("src/app/actions/portal.ts");

  // The resolver lives in the shared module now — enforced scope first, then the
  // contact, never a default.
  const shared = code("src/lib/portalTenant.ts");
  assert.match(shared, /SELECT "tenantId" FROM "Contact" WHERE "id" = \$\{contactId\} LIMIT 1/);
  assert.doesNotMatch(shared, /DEFAULT_TENANT_ID/, "a portal write must never invent an owner");

  // No write may still read the ambient scope directly.
  const assignments = portal.match(/const tenantId = [^\n;]+;/g) ?? [];
  assert.ok(assignments.length >= 4, `expected the portal write sites, found ${assignments.length}`);
  for (const line of assignments) {
    assert.match(line, /await portalTenantId\(/, `a portal write still resolves its own owner:\n  ${line}`);
  }
});

test("portalExpansion — the LIVE portal surface — inherits too", () => {
  // This file is what the audit actually named, and the first pass of this PR
  // missed it: the search that found portal.ts was truncated by its own `head`,
  // and the visible subset was treated as the whole result.
  //
  // addPortalCaseMessage() is reachable from PortalExpansionForms.tsx, so these
  // are live customer-facing writes, not dead code.
  const exp = code("src/app/actions/portalExpansion.ts");

  // This assertion previously demanded that EVERY site resolve
  // `portalTenantId(contact.id)` — which would have made the correct fix below
  // (a case's children inherit the case) fail the suite. A test that forbids the
  // right answer is worse than no test.
  const assignments = exp.match(/const tenantId = [^\n;]+;/g) ?? [];
  assert.ok(assignments.length >= 5, `expected the portalExpansion write sites, found ${assignments.length}`);
  for (const line of assignments) {
    assert.match(
      line,
      /await (portalTenantId\(contact\.id\)|tenantOfCase\(caseId\))/,
      `a write still resolves its own owner:\n  ${line}`,
    );
  }
  assert.doesNotMatch(exp, /currentTenantScope\(\)/, "no portal write may read the ambient scope");
});

test("the case message names a tenant column at all, and the case update is scoped", () => {
  const exp = code("src/app/actions/portalExpansion.ts");

  // The INSERT previously listed no tenantId column whatsoever, so the row was
  // unowned however the scope resolved — a stronger defect than a null variable.
  assert.match(exp, /INSERT INTO "CustomerCaseMessage" \("id", "tenantId", "caseId", "contactId", "direction", "type", "body"\)/);

  // The UPDATE ran on the bypass client keyed only on a caseId from the form.
  // portalCanAccessCase() is an access check, not a tenant predicate.
  assert.match(exp, /WHERE "id" = \$\{caseId\} AND "tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);

  // And the owner must come from the CASE, not the viewer — the composite FK
  // (tenantId, caseId) -> CustomerCase(tenantId, id) rejects anything else, so
  // stamping the viewer's tenant would make every still-unowned ticket
  // unrepliable.
  assert.match(exp, /const tenantId = await tenantOfCase\(caseId\);/);
});

test("there is ONE portal tenant rule, not one per file", () => {
  // Four independent copies of the acting-tenant rule is how this codebase got
  // into merge trouble; the portal rule is not going to repeat it.
  const shared = code("src/lib/portalTenant.ts");
  assert.match(shared, /export async function portalTenantId\(contactId: string\): Promise<string \| null>/);
  for (const f of ["src/app/actions/portal.ts", "src/app/actions/portalExpansion.ts"]) {
    assert.match(code(f), /from "@\/lib\/portalTenant"/, `${f} must import the shared rule`);
    assert.doesNotMatch(code(f), /async function portalTenantId\(/, `${f} must not define its own copy`);
  }
});

test("helpdesk children inherit their parent, not the actor and not the founding tenant", () => {
  const actions = code("src/app/actions/helpdesk.ts");

  assert.match(actions, /const tenantId = await tenantOfContact\(contactId\);/, "a notification belongs to its contact");
  assert.match(actions, /const tenantId = await tenantOfCase\(caseId\);/, "a timeline event belongs to its case");

  // The exact defect: the dormant-null fallback onto the founding tenant.
  assert.doesNotMatch(actions, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, "the dormant fallback stamps the founding tenant for every workspace");
});

test("marking messages read cannot cross a workspace boundary", () => {
  // caseId comes from the URL and this runs on the bypass client, so an
  // unqualified UPDATE let a forged id clear another workspace's unread signal.
  const lib = code("src/lib/helpdesk.ts");
  const fn = lib.slice(lib.indexOf("export async function markCustomerMessagesRead"));

  assert.match(fn, /FROM "CustomerCase" c/, "the update must join the owning case");
  assert.match(fn, /m\."tenantId" IS NOT DISTINCT FROM c\."tenantId"/, "message and case must agree on the owner");

  // THE POINT, and what the first version of this test missed: child-matches-
  // parent is satisfied by every legitimate row, so on its own it excludes
  // nothing. The update must name the CALLER's workspace. The upstream access
  // check does not supply one — activeTenantPredicate() returns {} while dormant,
  // and an owner gets null from getAccessibleCaseIds().
  assert.match(fn, /const scope = await actingScopeClass\(\);/, "the caller's workspace must be resolved");
  assert.match(fn, /c\."tenantId" IS NULL OR c\."tenantId" = \$\{actingTenantId\}/, "the case must belong to the acting workspace");
  // Stronger than the `=== "closed"` this used to assert. `global` must return
  // too: it is not only a sessionless cron, it is also a signed-in session that
  // could not be resolved to one workspace — stale, or ambiguous across two
  // active memberships. A request with no workspace has no business writing.
  assert.match(fn, /if \(scope\.mode !== "tenant"\) return;/, "anything but a resolved workspace must touch nothing");

  assert.doesNotMatch(fn, /WHERE "caseId" = \$\{caseId\} AND "type" = 'customer' AND "readAt" IS NULL`/, "the unqualified update");
});
