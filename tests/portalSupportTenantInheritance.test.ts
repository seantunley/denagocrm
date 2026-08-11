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

  // The resolver itself: enforced scope first, then the contact, never a default.
  assert.match(portal, /async function portalTenantId\(contactId: string\): Promise<string \| null> \{/);
  assert.match(portal, /SELECT "tenantId" FROM "Contact" WHERE "id" = \$\{contactId\} LIMIT 1/);
  assert.doesNotMatch(portal, /portalTenantId[\s\S]{0,400}DEFAULT_TENANT_ID/, "a portal write must never invent an owner");

  // No write may still read the ambient scope directly.
  const assignments = portal.match(/const tenantId = [^\n;]+;/g) ?? [];
  assert.ok(assignments.length >= 4, `expected the portal write sites, found ${assignments.length}`);
  for (const line of assignments) {
    assert.match(line, /await portalTenantId\(/, `a portal write still resolves its own owner:\n  ${line}`);
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
  // IS NOT DISTINCT FROM, not =, so a legacy pair that are both NULL still matches
  // and staff do not silently lose the ability to clear old tickets.
  assert.doesNotMatch(fn, /WHERE "caseId" = \$\{caseId\} AND "type" = 'customer' AND "readAt" IS NULL`/, "the unqualified update");
});
