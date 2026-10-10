import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A route handler that asks what the caller may do must first say which
 * workspace it is asking in.
 *
 * Under tenant enforcement a role assignment counts only in the workspace being
 * acted in, and the permission lookup reads that workspace from the ambient
 * scope. A page gets one from the layout above it. A ROUTE HANDLER has nothing
 * above it, and the scope `getCurrentUser()` enters does not reach the frame
 * that called it — so a handler written as
 *
 *     const user = await getCurrentUser();
 *     if (!(await hasPermission(user, "stock.view"))) return forbidden;
 *
 * looked up the user's roles in no workspace, found none, and refused. Owners
 * skip the lookup, so it worked for whoever wrote it and for whoever tested it.
 *
 * Eleven handlers were like this, the document download (/api/files) among
 * them: a member of staff who was not an owner could not open a document, a
 * job-card photo, a library file or the stock report, on records their role
 * allowed. Nothing errored; the answer was simply Forbidden.
 *
 * `withActingStaffScope` binds a real enclosing frame, which is the one shape
 * that propagates to everything the handler calls. It never widens: an existing
 * scope wins, and with no staff session it runs the handler bare.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const rel = (abs: string) => abs.slice(root.length + 1).split(path.sep).join("/");
const routeHandlers = walk(path.join(root, "src", "app"))
  .filter((file) => /[\\/]route\.tsx?$/.test(file))
  .map(rel)
  .sort();

/** Anything that turns "this user" into "what this user may do". Each one reads the workspace from the ambient scope. */
const READS_PERMISSIONS =
  /\b(hasPermission|hasAnyPermission|requirePermission|requireAnyPermission|requireRoute|getUserPermissionList|getUserPermissions|canAccess[A-Z]\w*|require[A-Z]\w*Access|getAccessible\w+Ids)\(/g;

/** The ways a handler may come to be running inside a workspace. */
const BINDS_WORKSPACE =
  /\b(withActingStaffScope|withStaffConversationScope|withActingTenantWrite|runInTenantScope|withTokenTenantScope|withTenant|withSystemScope|runCronPerTenant)\b/;

test("the scan is looking at the real route handlers", () => {
  assert.ok(routeHandlers.length >= 60, `only ${routeHandlers.length} route handlers found — has src/app moved?`);
  assert.ok(routeHandlers.includes("src/app/api/files/[id]/route.ts"));
  // A handler known to read permissions and known to bind: if the patterns stop
  // matching it, the test below would pass by seeing nothing.
  const known = shipped("src/app/(print)/quotes/[id]/print/route.ts");
  assert.ok([...known.matchAll(READS_PERMISSIONS)].length > 0 && BINDS_WORKSPACE.test(known));
});

test("every route handler that reads the caller's permissions binds the acting workspace", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of routeHandlers) {
    const source = shipped(file);
    const reads = [...new Set([...source.matchAll(READS_PERMISSIONS)].map((match) => match[1]))];
    if (reads.length === 0) continue;
    checked += 1;
    if (!BINDS_WORKSPACE.test(source)) offenders.push(`${file} (${reads.join(", ")})`);
  }
  assert.ok(checked >= 20, `only ${checked} permission-reading handlers found — the pattern has stopped matching`);
  assert.deepEqual(
    offenders,
    [],
    "these handlers ask what the caller may do without saying in which workspace, so they refuse every non-owner under " +
      "enforcement — wrap the handler: `return withActingStaffScope(() => handleGet(...))`",
  );
});

/** The eleven that were refusing staff. Each exported handler is now only the binding. */
const WAS_REFUSING_STAFF = [
  "src/app/api/audit/export/route.ts",
  "src/app/api/cases/uploads/[id]/route.ts",
  "src/app/api/doc-editor/[id]/export/route.ts",
  "src/app/api/export/ads-conversions/route.ts",
  "src/app/api/files/[id]/route.ts",
  "src/app/api/jobcard-photo/[id]/route.ts",
  "src/app/api/library/[id]/route.ts",
  "src/app/api/pdf/doc-editor/[id]/route.ts",
  "src/app/api/pdf/doc-instance/[id]/route.ts",
  "src/app/api/pdf/stock-report/route.tsx",
  "src/app/api/test-drives/assets/[id]/route.ts",
];

test("in each handler that was refusing staff, the binding encloses ALL of it", () => {
  for (const file of WAS_REFUSING_STAFF) {
    const source = shipped(file);
    const start = source.indexOf("export async function GET(");
    assert.notEqual(start, -1, `${file}: no exported GET`);
    const exported = source.slice(start, source.indexOf("\n}", start) + 2);
    // Nothing but the binding: a check made before it would run in no workspace.
    assert.match(
      exported.replace(/\s+/g, " "),
      /^export async function GET\([^)]*\) \{ return withActingStaffScope\(\(\) => handleGet\([^)]*\)\); \}$/,
      `${file}: the exported handler must do nothing except bind the workspace and call handleGet`,
    );
    assert.match(source, /\nasync function handleGet\(/, `${file}: handleGet must not be exported — the bound GET is the only way in`);
    assert.equal(source.match(/export async function /g)?.length, 1, `${file}: one exported handler`);
  }
});

test("the wrapper cannot hand a caller a workspace they did not arrive with", () => {
  const source = shipped("src/lib/actingScope.ts");
  const start = source.indexOf("export async function withActingStaffScope");
  const body = source.slice(start, source.indexOf("\n}", start));
  // An existing scope wins; no resolvable staff session means the handler runs
  // bare — which is what keeps the portal branch of /api/files on the portal's
  // own session, and an anonymous caller at 401.
  assert.match(body, /if \(currentTenantScope\(\)\) return fn\(\);/);
  assert.match(body, /if \(!recovered\) return fn\(\);/);
  assert.match(body, /return runInTenantScope\(recovered, fn\);/);
});
