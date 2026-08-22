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

test("the async tenant predicate recovers only a genuinely missing request scope", () => {
  const code = shipped("src/lib/tenantPredicate.ts");
  const body = functionBody(code, "recoverableActiveTenantPredicate");

  assert.match(body, /return activeTenantPredicate\(context\);/,
    "existing scopes and dormant mode must keep the original rule");
  assert.match(body, /error instanceof TenantScopeError/);
  assert.match(body, /currentTenantScope\(\)/,
    "a deliberately bound null/system scope must not be replaced");
  assert.match(body, /recoverStaffScopeFromSession\(\)/);
  assert.match(body, /if \(!recovered\?\.tenantId\) throw error;/,
    "sessionless/unresolved helpers still fail closed with their original context");
  assert.match(body, /return \{ tenantId: recovered\.tenantId \};/);
});

test("known-tenant public requests use an enclosing callback scope, not enter-and-return", () => {
  const entry = shipped("src/lib/tenantScopeEntry.ts");
  const body = entry.slice(entry.indexOf("export function withTenantScopeFromId"));
  assert.match(body, /if \(!tenantEnforcing\(\)\) return fn\(\);/,
    "dormant compatibility must stay unchanged");
  assert.match(body, /return runInTenantScope\(\{ tenantId, system: false \}, fn\);/,
    "enforcement needs a real enclosing async frame");

  const routes = [
    "src/app/api/intake/route.ts",
    "src/app/api/bookings/route.ts",
    "src/app/api/bookings/slots/route.ts",
    "src/app/api/service-lookup/route.ts",
    "src/app/api/service-lookup/verify/route.ts",
  ];
  for (const file of routes) {
    const code = shipped(file);
    const authAt = code.indexOf("authenticateIntakeKey(");
    const scopeAt = code.indexOf("withTenantScopeFromId(auth.tenantId");
    assert.ok(authAt >= 0 && scopeAt > authAt,
      `${file} must derive the tenant from the authenticated API key before binding it`);
    assert.doesNotMatch(code, /establishTenantScopeFromId\(/,
      `${file} must not rely on a callee enterWith surviving after the helper returns`);
  }
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

test("async request helpers do not strand a recovered action at the next synchronous predicate", () => {
  const directory = shipped("src/lib/fleetDirectory.ts");
  assert.match(functionBody(directory, "fleetPicker"), /await recoverableActiveTenantPredicate\("fleet picker"\)/,
    "the quick-create API and contact pages share this helper");

  const billTo = shipped("src/lib/quoteBillTo.ts");
  assert.match(
    functionBody(billTo, "loadBillToFleets", "loadBillToFleet"),
    /await recoverableActiveTenantPredicate\("quote bill-to fleet"\)/,
    "fulfilment/quote actions and PDF route handlers must not fail after actor recovery",
  );
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
