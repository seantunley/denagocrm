import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(path.join(root, "src/lib/permissions.ts"), "utf8");

function body(name: string, nextName: string): string {
  const start = code.indexOf(`export async function ${name}`);
  const end = code.indexOf(`export async function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return code.slice(start, end);
}

/**
 * WHY THE TENANT IS SPELLED OUT AND NOT SPREAD.
 *
 * These queries first carried the tenant as `...scope` / `${leadTenant}` /
 * `${caseTenant}`, which is identical at runtime — the guard above each one has
 * already narrowed the scope to a real workspace. It is NOT identical to the
 * tenant-access sweep (tests/tenantAccessSweep.ts), which reads the call site
 * and matches a closed list of identifiers that carry a tenant. It cannot see
 * into a spread or a `Prisma.sql` fragment, so every one of these reads counted
 * as an unscoped bypass call and the ratchet failed with seven new findings.
 *
 * The ratchet is deliberately unable to record an increase: `nextBaseline` only
 * lowers, and `ACKNOWLEDGED` may not shadow a key already in the fixture — and
 * all seven keys were already there. So the number cannot go up, by design; the
 * call has to name its tenant. That is what the sweep asks for and it is the
 * clearer form anyway.
 *
 * Keep it literal. Collapsing these back to a spread is a silent regression:
 * the behaviour is unchanged, the ratchet goes red, and the reason is three
 * files away.
 */
const findManyHelpers = [
  ["getAccessibleContactIds", "canAccessContact", "contacts.view_all", "contact"],
  ["getAccessibleQuoteIds", "canAccessQuote", "quotes.view_all", "quote"],
  ["getAccessibleVehicleIds", "canAccessVehicle", "vehicles.view_all", "vehicle"],
  ["getAccessibleJobCardIds", "canAccessJobCard", "jobcards.view_all", "jobCard"],
  ["getAccessibleDocumentIds", "canAccessDocument", "documents.view_all", "document"],
] as const;

for (const [helper, next, permission, model] of findManyHelpers) {
  test(`${helper}: view_all is all of the acting workspace, never platform-global`, () => {
    const src = body(helper, next);
    const scopeAt = src.indexOf("const scope = await actingListScope()");
    const unrestrictedAt = src.indexOf(`permissions.has(\"${permission}\")`);
    assert.ok(scopeAt >= 0 && scopeAt < unrestrictedAt, "resolve tenant before interpreting view_all");
    assert.doesNotMatch(
      src,
      new RegExp(`if \\(permissions === null \\|\\| permissions\\.has\\(\\\"${permission.replace(".", "\\.")}\\\"\\)\\) return null`),
      "view_all must not short-circuit to an unfiltered caller",
    );
    // Was: /if \(!isTenantListScope\(scope\)\) return null;/ — "only a genuinely
    // global scope may return null". That branch is gone, and so is the idea
    // behind it. `null` means UNRESTRICTED to every caller, and an unresolvable
    // session (stale claim, or ambiguous across memberships) is not a licence to
    // read every workspace. actingListScope() now answers null-the-refusal for
    // anything that is not a resolved tenant, and the helper turns that into [].
    assert.match(src, /if \(!scope\) return \[\];/, "an unresolvable scope must deny, never open");
    assert.match(src, new RegExp(`basePrisma\\.${model}\\.findMany`), "tenant view_all must materialise tenant-owned ids");
    assert.match(
      src,
      /where: \{ deletedAt: null, tenantId: scope\.tenantId \}/,
      "the all-ids query must carry the acting tenant, named so the access sweep can see it",
    );
  });
}

test("getAccessibleLeadIds: tenant view_all returns explicit tenant lead ids", () => {
  const src = body("getAccessibleLeadIds", "canAccessLead");
  const scopeAt = src.indexOf("const scope = await actingScopeClass()");
  const unrestrictedAt = src.indexOf('permissions.has("leads.view_all")');
  assert.ok(scopeAt >= 0 && scopeAt < unrestrictedAt);
  assert.doesNotMatch(src, /if \(permissions === null \|\| permissions\.has\("leads\.view_all"\)\) return null/);
  // `[]`, not `null`: null means unrestricted to every caller of this helper.
  assert.match(src, /if \(scope\.mode !== "tenant"\) return \[\];/, "an unresolvable scope must deny, never open");
  assert.match(
    src,
    /SELECT l\."id"[\s\S]*WHERE l\."deletedAt" IS NULL AND l\."tenantId" = \$\{scope\.tenantId\}/,
    "the tenant predicate must be in the statement text, not hidden in a fragment",
  );
});

test("getAccessibleCaseIds: tenant view_all returns explicit tenant case ids", () => {
  const src = body("getAccessibleCaseIds", "canAccessCase");
  const scopeAt = src.indexOf("const scope = await actingScopeClass()");
  const unrestrictedAt = src.indexOf('permissions.has("cases.view_all")');
  assert.ok(scopeAt >= 0 && scopeAt < unrestrictedAt);
  assert.doesNotMatch(src, /if \(permissions === null \|\| permissions\.has\("cases\.view_all"\)\) return null/);
  // `[]`, not `null`: null means unrestricted to every caller of this helper.
  assert.match(src, /if \(scope\.mode !== "tenant"\) return \[\];/, "an unresolvable scope must deny, never open");
  assert.match(
    src,
    /SELECT c\."id" FROM "CustomerCase" c WHERE c\."tenantId" = \$\{scope\.tenantId\}/,
    "the tenant predicate must be in the statement text, not hidden in a fragment",
  );
});
