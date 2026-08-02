import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The document scope was consolidated onto one implementation — and the rule it
 * consolidated onto was not tenant-safe.
 *
 * getAccessibleDocumentIds queries through basePrisma, which BYPASSES the RLS
 * extension. It carried no tenant predicate, so whenever a linked-record scope
 * came back unrestricted the `{ contactId: { not: null } }` arm selected
 * contact-linked documents in every tenant. Worse, canAccessDocument answered
 * `ids === null || ids.includes(id)` — so a documents.view_all holder got
 * `true` for ANY id, including one they had merely guessed.
 *
 * Read surfaces mostly re-queried through the scoped client and were saved by
 * RLS. deleteDocument is the one that was not: it writes through the trash
 * helper on basePrisma, so a documents.manage holder could soft-delete another
 * tenant's document by id.
 *
 * These are source guards. A two-tenant behavioural test needs a live database
 * with RLS configured, which this suite does not have — see the PR for what is
 * still owed.
 */

test("the document scope query names its tenant", () => {
  const code = shipped("src/lib/permissions.ts");
  const start = code.indexOf("export async function getAccessibleDocumentIds(");
  assert.notEqual(start, -1, "getAccessibleDocumentIds is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("\nfunction documentTenantWhere", start));
  assert.ok(body.length > 0, "the slice ran backwards");
  assert.match(body, /basePrisma\.document\.findMany/, "still the basePrisma query this guards");
  assert.match(body, /documentTenantWhere\(\)/, "a basePrisma query must carry an explicit tenant predicate");
  assert.match(shipped("src/lib/permissions.ts"), /tenantId: currentTenantScope\(\)\?\.tenantId \?\? null/);
});

test("access to ONE document is decided by resolving that document", () => {
  // `ids === null` means "unrestricted within my tenant", never "unrestricted".
  // Answering from the list alone turned the first into the second.
  const code = shipped("src/lib/permissions.ts");
  const start = code.indexOf("export async function canAccessDocument(");
  const body = code.slice(start, code.indexOf("\nexport async function requireDocumentReadAccess", start));
  assert.match(body, /basePrisma\.document\.findFirst/, "the document itself must be resolved");
  assert.match(body, /documentTenantWhere\(\)/, "…within the active tenant");
  assert.match(body, /if \(!document\) return false;/, "…and a miss is a refusal");
  // The unrestricted short-circuit may remain, but only AFTER the tenant check.
  const tenantCheck = body.indexOf("documentTenantWhere()");
  const shortCircuit = body.indexOf("ids === null");
  assert.ok(
    tenantCheck !== -1 && tenantCheck < shortCircuit,
    `the tenant check must precede the unrestricted short-circuit (${tenantCheck} vs ${shortCircuit})`,
  );
});

test("the soft-delete write carries the tenant, not just the gate", () => {
  // Defence at the write, so a future caller whose gate is wrong cannot reach
  // across tenants anyway. delegate() runs on basePrisma.
  const trash = shipped("src/lib/trash.ts");
  assert.match(trash, /opts\?: \{ tenantId\?: string \| null \}/, "softDeleteRecord must accept a tenant");
  assert.match(trash, /delegate\(model\)\.updateMany\(/, "a conditional write, so a tenant mismatch matches no rows");
  assert.match(trash, /if \(rows\.count === 0\) return null;/, "…and reports the miss instead of pretending");

  const action = shipped("src/app/actions/documents.ts");
  assert.match(action, /tenantId: currentTenantScope\(\)\?\.tenantId \?\? null/, "deleteDocument must pass it");
  assert.match(action, /if \(!doc\) redirect\("\/documents"\)/, "a miss must not fall through");
});

test("a deletion that did not happen is not audited", () => {
  // The audit entry named doc.fileName off the returned row. With the write now
  // able to match nothing, logging before the miss check would record a
  // deletion that never occurred — and crash reading fileName off null.
  const action = shipped("src/app/actions/documents.ts");
  const start = action.indexOf("export async function deleteDocument(");
  const body = action.slice(start, action.indexOf("\nexport async function", start + 1));
  const miss = body.indexOf("if (!doc)");
  const audit = body.indexOf("logAudit({");
  assert.ok(miss !== -1 && miss < audit, `the miss check must precede the audit (${miss} vs ${audit})`);
});
