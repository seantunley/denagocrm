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
    assert.match(src, /if \(!isTenantListScope\(scope\)\) return null;/, "only a genuinely global scope may return null");
    assert.match(src, new RegExp(`basePrisma\\.${model}\\.findMany`), "tenant view_all must materialise tenant-owned ids");
    assert.match(src, /where: \{ deletedAt: null, \.\.\.scope \}/, "the all-ids query must carry the acting tenant");
  });
}

test("getAccessibleLeadIds: tenant view_all returns explicit tenant lead ids", () => {
  const src = body("getAccessibleLeadIds", "canAccessLead");
  const scopeAt = src.indexOf("const scope = await actingScopeClass()");
  const unrestrictedAt = src.indexOf('permissions.has("leads.view_all")');
  assert.ok(scopeAt >= 0 && scopeAt < unrestrictedAt);
  assert.doesNotMatch(src, /if \(permissions === null \|\| permissions\.has\("leads\.view_all"\)\) return null/);
  assert.match(src, /if \(scope\.mode === "global"\) return null;/);
  assert.match(src, /SELECT l\."id"[\s\S]*WHERE l\."deletedAt" IS NULL \$\{leadTenant\}/);
});

test("getAccessibleCaseIds: tenant view_all returns explicit tenant case ids", () => {
  const src = body("getAccessibleCaseIds", "canAccessCase");
  const scopeAt = src.indexOf("const scope = await actingScopeClass()");
  const unrestrictedAt = src.indexOf('permissions.has("cases.view_all")');
  assert.ok(scopeAt >= 0 && scopeAt < unrestrictedAt);
  assert.doesNotMatch(src, /if \(permissions === null \|\| permissions\.has\("cases\.view_all"\)\) return null/);
  assert.match(src, /if \(scope\.mode === "global"\) return null;/);
  assert.match(src, /SELECT c\."id" FROM "CustomerCase" c WHERE TRUE \$\{caseTenant\}/);
});
