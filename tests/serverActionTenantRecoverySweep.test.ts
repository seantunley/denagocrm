import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const shipped = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

function functionBody(code: string, name: string, nextName?: string): string {
  const start = code.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? code.indexOf(`export async function ${nextName}`, start + 1) : -1;
  return code.slice(start, end === -1 ? undefined : end);
}

test("actingTenantId recovers a lost Server Action scope without replacing an existing one", () => {
  const code = shipped("src/lib/actingTenant.ts");
  const start = code.indexOf("export async function actingTenantId");
  assert.notEqual(start, -1);
  const body = code.slice(start);

  assert.match(body, /try\s*\{[\s\S]*?writeTenantId\(\)/,
    "the explicit/enforced scope remains the first authority");
  assert.match(body, /error instanceof TenantScopeError/,
    "only the expected missing-scope refusal may trigger recovery");
  assert.match(body, /currentTenantScope\(\)/,
    "an already-bound closed or system scope must never be replaced");
  assert.match(body, /recoverStaffScopeFromSession\(\)/,
    "a missing Server Action carrier must be recoverable from the validated session");
  assert.match(body, /if \(!recovered\?\.tenantId\) throw error;/,
    "unresolved, revoked and sessionless callers must still fail closed");
  assert.match(body, /return recovered\.tenantId;/,
    "a successfully recovered staff workspace must satisfy awaited actor resolution");
});

test("contact creation no longer synchronously reads tenant scope before its fleet lookup", () => {
  const code = shipped("src/app/actions/contacts.ts");
  const resolveStart = code.indexOf("async function resolveFleet");
  const resolveEnd = code.indexOf("function submittedKind", resolveStart);
  assert.ok(resolveStart >= 0 && resolveEnd > resolveStart);
  const resolver = code.slice(resolveStart, resolveEnd);

  assert.match(resolver, /const tenantId = await actingTenantId\(\);/);
  assert.match(resolver, /where:\s*\{\s*id:\s*fleetId,\s*tenantId\s*\}/);
  assert.doesNotMatch(resolver, /activeTenantPredicate\(/,
    "createContact reaches this helper without an enclosing staff-scope wrapper");
});

test("all fleet mutations resolve their fleet through the recoverable awaited actor", () => {
  const code = shipped("src/app/actions/fleets.ts");
  const helperStart = code.indexOf("async function tenantFleet");
  const helperEnd = code.indexOf("function optional", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = code.slice(helperStart, helperEnd);

  assert.match(helper, /const tenantId = await actingTenantId\(\);/);
  assert.match(helper, /where:\s*\{\s*id,\s*tenantId\s*\}/);
  assert.doesNotMatch(code, /activeTenantPredicate\(/,
    "fleet update/delete/assignment actions must not require caller-frame ALS propagation");

  for (const name of ["updateFleet", "updateFleetBusiness", "deleteFleet", "assignVehicleToFleet"]) {
    assert.match(functionBody(code, name), /tenantFleet\(/,
      `${name} must pass through the tenant-bounded fleet resolver`);
  }
});

test("known synchronous tenant readers in Server Actions remain enclosed", () => {
  const contacts = shipped("src/app/actions/contacts.ts");
  assert.match(functionBody(contacts, "updateContact", "deleteContact"), /withActingStaffScope\(/);

  const ai = shipped("src/app/actions/ai.ts");
  assert.match(functionBody(ai, "researchRecord"), /withActingStaffScope\(/,
    "researchRecord later calls inheritedTenantId synchronously");

  const products = shipped("src/app/actions/products.ts");
  assert.match(functionBody(products, "createProduct", "updateProduct"), /withActingStaffScope\(/,
    "root product creation uses the acting tenant write boundary");

  const library = shipped("src/app/actions/library.ts");
  assert.match(functionBody(library, "registerLibraryDocuments", "registerLibraryVersion"), /withActingStaffScope\(/,
    "the direct library upload path performs ownership checks and tenant writes in one staff scope");

  const portal = shipped("src/app/actions/portalAdmin.ts");
  assert.match(functionBody(portal, "grantPortalAccess", "revokePortalAccess"), /withActingStaffScope\(/,
    "grantPortalAccess evaluates activeTenantPredicate synchronously");

  const quotes = shipped("src/app/actions/quotes.ts");
  for (const name of ["createQuoteForFleet", "saveQuoteDraft", "createQuoteRevision"]) {
    assert.match(functionBody(quotes, name), /withActingStaffScope\(/,
      `${name} reaches synchronous tenant predicates/writes and must bind the whole action`);
  }
});

test("awaited actor callers may stay unwrapped because actingTenantId now owns recovery", () => {
  // These were the other copies of the production photo failure. They do not use
  // a synchronous tenant predicate at the call site; they await actingTenantId and
  // then carry the returned id into their explicit/basePrisma boundary. The class
  // fix belongs in actingTenantId, not in dozens of identical wrappers.
  const files = [
    "src/app/actions/parts.ts",
    "src/app/actions/dashboard.ts",
    "src/app/actions/dashboardConfig.ts",
    "src/app/actions/fulfilment.ts",
    "src/app/actions/jobcards.ts",
    "src/app/actions/quotes.ts",
    "src/app/actions/testDrives.ts",
    "src/lib/pipelines.ts",
  ];
  for (const file of files) {
    assert.match(shipped(file), /actingTenantId\(\)/, `${file} should remain on the shared actor resolver`);
  }
});
