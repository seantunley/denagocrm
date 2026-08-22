import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A ROUTE HANDLER THAT READS THE TENANT SCOPE MUST BIND IT FIRST.
 *
 * ── THE OUTAGE THIS EXISTS TO PREVENT ───────────────────────────────────────
 *
 * `/api/pdf/quote/[id]` 500'd in production for fleet quotes. A route handler
 * renders no layout, so nothing above it establishes the acting workspace —
 * while `loadBillToFleet` reads that scope SYNCHRONOUSLY through
 * `activeTenantPredicate`, and under enforcement a sync read with no scope
 * THROWS rather than returning an empty predicate.
 *
 * Three things made it invisible, and each is why a test rather than care is the
 * answer:
 *
 *   - It fired on a SUBSET of records. `loadBillToFleets` returns early when a
 *     quote names no fleet, so ordinary quote PDFs were fine and it read as a
 *     fleet-feature bug rather than a tenancy one.
 *   - The tenant tests bind scope THEMSELVES and never render a real request, so
 *     they stayed green. That is the 2026-08-12 lockout recorded in
 *     security-rbac-ci.yml, repeating.
 *   - The System Log could not show it: an error caused by having no scope was
 *     filed with `tenantId: null` and the log filters on the viewer's tenant.
 *
 * ── WHY THE IMPORT WALK IS TRANSITIVE ───────────────────────────────────────
 *
 * The route did not mention `activeTenantPredicate`. It imported
 * `loadBillToFleet`, which is two hops from it. A one-hop check would have
 * passed this route on the day it broke, which makes a one-hop check worse than
 * none — it would have said the thing was safe.
 */

const ROOT = process.cwd();
/**
 * EVERY route handler under src/app, not just src/app/api.
 *
 * The handler that caused the outage lives at (print)/quotes/[id]/print/route.ts.
 * An /api-only walk passed it silently - which would have made this guard a
 * reassurance rather than a check, on the one file it was written for.
 */
const APP_DIR = join(ROOT, "src", "app");
const LIB_DIR = join(ROOT, "src", "lib");

/** Establishing an enclosing scope. `enterWith` in a callee does not count — see actingScope.ts. */
const BINDERS = [
  "withActingStaffScope",
  "withStaffConversationScope",
  "withChannelTenantScope",
  "withActingTenantWrite",
  "runInTenantScope",
  "withSystemScope",
  "withTenant",
];

/** The sync reader itself. Everything below is "does this reach it". */
const SYNC_READER = "activeTenantPredicate";

/**
 * Only routes that authenticate a STAFF SESSION are in scope for this guard.
 *
 * withActingStaffScope recovers the workspace FROM the session, so it is the
 * right answer only where there is one. Cron slices, provider webhooks and
 * token-gated public routes have no staff session by definition - actingScope.ts
 * says so outright - and they bind their workspace from the record they act on
 * (inheritedTenantId) or from the endpoint that was called
 * (withChannelTenantScope). Demanding the staff wrapper there would be wrong
 * advice, so they are not asked for it.
 */
const STAFF_AUTH = [
  "requireApiUser",
  "requireApiOwner",
  "getCurrentUser",
  "requireOwner",
  "requirePermission",
  "requireRoute",
  // The record-level gates are staff auth too, and leaving them out is not a
  // theoretical gap: the quote print route authenticates with
  // requireQuoteReadAccess and nothing else, so an earlier version of this list
  // skipped the very route the guard was written for.
  "requireQuoteAccess",
  "requireQuoteReadAccess",
  "requireLeadAccess",
  "requireLeadReadAccess",
  "requireContactAccess",
  "requireContactReadAccess",
  "requireJobCardAccess",
  "requireJobCardReadAccess",
  "requireVehicleAccess",
  "requireVehicleReadAccess",
  "requireDocumentAccess",
  "requireDocumentReadAccess",
  "requireCaseAccess",
  "requireCaseReadAccess",
];

/**
 * Modules excluded from the reachability graph, and why the guard is worth less
 * without this list than with it.
 *
 * These are imported by almost every route. Some of them do contain a scope read
 * somewhere in their surface - `auth` resolves the acting workspace on one path,
 * `permissions` reaches it through a record check - but not on the path a route
 * triggers by calling requireApiUser(). Propagating through them marks every
 * authenticated route as reaching the scope, which is both untrue and useless: a
 * guard that names forty files names none of them.
 *
 * The cost is real and worth stating: a genuine fault whose ONLY path runs
 * through one of these is invisible here. That is the trade for a signal anybody
 * will act on.
 */
const HUBS = new Set([
  "auth",
  "permissions",
  "db",
  "tenantScope",
  "tenantPredicate",
  "tenantGuard",
  "actingTenant",
  "actingScope",
  "errorLog",
  "tenantEnforcement",
  "tenantScopeEntry",
]);

function walk(dir: string, match: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(name)) out.push(full);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8");

/**
 * The file with its import lines removed.
 *
 * A binder must be CALLED, not merely imported. Mutation testing caught this:
 * deleting the withActingStaffScope(...) call while leaving its import in place
 * still satisfied a plain substring check, so the guard passed on a route that
 * had just been un-fixed. An import is not a binding.
 */
function withoutImports(source: string): string {
  const NEWLINE = String.fromCharCode(10);
  return source
    .split(NEWLINE)
    .filter((line) => !line.trimStart().startsWith("import "))
    .join(NEWLINE);
}

/** Path separator on Windows, built from its code point so no escape can be mangled. */
const WINDOWS_SEP = String.fromCharCode(92);

/**
 * The module name a path refers to, without its extension.
 *
 * Split on BOTH separators rather than matched with a regex. An escaped
 * backslash inside a character class is exactly the kind of thing that survives
 * review and then silently matches nothing on Windows - which is what happened
 * here: the walk found all 387 library files and keyed none of them, so the
 * reachability set came back empty and the guard passed while the route it was
 * written for sat unwrapped.
 */
function baseName(file: string): string {
  const withoutExt = file.replace(/[.]tsx?$/, "");
  const parts = withoutExt.split(WINDOWS_SEP).join("/").split("/");
  return parts[parts.length - 1];
}

/** Local module specifiers a file imports, as bare lib names. */
function libImports(source: string): string[] {
  const names: string[] = [];
  for (const [, spec] of source.matchAll(/from\s+"(@\/lib\/[^"]+|\.\.?\/[^"]+)"/g)) {
    names.push(spec.replace(/^@\/lib\//, "").replace(/^.*\//, ""));
  }
  return names;
}

/**
 * Every lib module that reaches `activeTenantPredicate`, directly or through
 * another lib. Computed to a fixpoint so a helper three hops away still counts.
 */
function libsReachingReader(): Set<string> {
  const files = walk(LIB_DIR, (f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  const sources = new Map<string, string>();
  for (const f of files) sources.set(baseName(f), read(f));

  const reaching = new Set<string>();
  for (const [name, src] of sources) {
    if (HUBS.has(name)) continue;
    if (src.includes(SYNC_READER)) reaching.add(name);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, src] of sources) {
      if (reaching.has(name) || HUBS.has(name)) continue;
      if (libImports(src).some((dep) => reaching.has(dep))) {
        reaching.add(name);
        changed = true;
      }
    }
  }
  return reaching;
}

test("every API route that can reach the tenant scope binds it first", () => {
  const reaching = libsReachingReader();
  const routes = walk(APP_DIR, (f) => f === "route.ts" || f === "route.tsx");
  assert.ok(routes.length > 0, "no API routes found — the walk is broken, not the app");

  const offenders: string[] = [];
  for (const file of routes) {
    const src = read(file);
    const body = withoutImports(src);
    if (BINDERS.some((binder) => body.includes(binder + "("))) continue;
    if (!STAFF_AUTH.some((fn) => src.includes(fn))) continue;

    const touches =
      src.includes(SYNC_READER) || libImports(src).some((dep) => reaching.has(dep));
    if (!touches) continue;

    const rel = file.slice(ROOT.length + 1).split(WINDOWS_SEP).join("/");
    const why = src.includes(SYNC_READER)
      ? SYNC_READER
      : libImports(src).filter((dep) => reaching.has(dep)).join(", ");
    offenders.push(`${rel}  (reaches: ${why})`);
  }

  assert.deepEqual(
    offenders,
    [],
    "These route handlers can reach the tenant scope but never bind it. Under " +
      "TENANT_ENFORCEMENT=enforce that is a 500 with nothing in the System Log. " +
      "Wrap the handler body in withActingStaffScope — an enclosing frame, not a " +
      "call inside a helper:\n  " + offenders.join("\n  "),
  );
});

test("the reachability walk actually finds the route that caused the outage", () => {
  /*
   * A guard whose analysis silently returns nothing passes forever, and this one
   * did exactly that twice while being written: once because a mangled backslash
   * made the basename extraction match nothing on Windows, and once because the
   * walk only scanned src/app/api while the broken handler lives under
   * src/app/(print). Both times the first test was green and proved nothing.
   *
   * So this pins the analysis against the real case rather than trusting it.
   */
  const reaching = libsReachingReader();
  assert.ok(reaching.has("quoteBillTo"), "quoteBillTo reads the scope directly and must be detected");
  assert.ok(reaching.size >= 5, `expected several reaching libs, found ${reaching.size}`);

  const printRoute = join(APP_DIR, "(print)", "quotes", "[id]", "print", "route.ts");
  assert.ok(existsSync(printRoute), "the route this guard was written for has moved");

  const src = read(printRoute);
  assert.ok(
    libImports(src).some((dep) => reaching.has(dep)),
    "the print route must still be SEEN to reach the scope - otherwise this guard proves nothing",
  );
  assert.ok(
    BINDERS.some((b) => withoutImports(src).includes(b + "(")),
    "and it must still bind the workspace, or the outage is back",
  );
});
