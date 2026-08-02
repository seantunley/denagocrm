import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A Server Action compiles to a POST endpoint. Next's own guidance is blunt
 * about what that means: "the route is reachable to anyone who can send the same
 * POST. Treat every action as an untrusted entry point", and "render-time gating
 * (only rendering a form on an authenticated page) is not a security boundary"
 * (node_modules/next/dist/docs/01-app/02-guides/server-actions.md, "Security").
 *
 * These tests inventory every exported action in src/app/actions and assert each
 * reaches an authentication/authorization guard on its entry path, and that the
 * owner-only /products and /trash surfaces enforce that themselves rather than
 * leaning on the proxy — which is an optimistic, JWT-only pre-filter that does
 * no database check at all (see 01-app/02-guides/authentication.md,
 * "Optimistic checks with Proxy", and src/lib/session.ts#verifySessionFull).
 */

const ROOT = process.cwd();
const ACTIONS_DIR = join(ROOT, "src", "app", "actions");
const APP_DIR = join(ROOT, "src", "app", "(app)");

// --- comment stripping -----------------------------------------------------
// A guard's own name appears in prose all over this codebase ("every console
// server action re-checks via requirePlatformAdminAction"), so a bare regex over
// the source would score a commented-out or merely-described guard as a real
// one. Blank comments before matching. The `[^:]` lookbehind stand-in keeps
// "https://…" from being read as a line comment.
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

test("stripComments removes guards that are only mentioned in prose", () => {
  assert.equal(/requireOwner\s*\(/.test(stripComments("// await requireOwner();")), false);
  assert.equal(/requireOwner\s*\(/.test(stripComments("/** calls requireOwner() */")), false);
  assert.equal(/requireOwner\s*\(/.test(stripComments("  await requireOwner();")), true);
  // a URL is not a line comment
  assert.match(stripComments('const u = "https://x.dev"; await requireOwner();'), /requireOwner\(\)/);
});

// --- approved guards -------------------------------------------------------
// Calls that actually establish or verify an identity (or an identity-scoped
// record grant). Deliberately EXCLUDES value-validation helpers whose names
// merely start with require/assert/ensure — requireModuleEnabled, requireBooking,
// requireTenantMember, requireAssignableUser, assertUniqueSerial and friends
// check that a *value* is usable, not that the *caller* is allowed.
// The requireCrm/requireWorkshop/requireInbox/requireOperational family is
// deliberately absent: those read the retired per-user module CSV, an
// authorization source RBAC never wrote to. Listing them here would let a new
// action re-adopt it.
const APPROVED_GUARDS = [
  "requireUser", "requireOwner", "requireTenantOwner", "getCurrentUser",
  "requirePermission", "requireAnyPermission", "requireRoute",
  "hasPermission", "hasAnyPermission",
  "requireLeadAccess", "requireLeadReadAccess", "canAccessLead",
  "requireContactAccess", "requireContactReadAccess", "canAccessContact",
  "requireQuoteAccess", "requireQuoteReadAccess", "canAccessQuote",
  "requireVehicleAccess", "requireVehicleReadAccess", "canAccessVehicle",
  "requireJobCardAccess", "requireJobCardReadAccess", "canAccessJobCard",
  "requireDocumentAccess", "requireDocumentReadAccess", "canAccessDocument",
  "requireCaseAccess", "requireCaseReadAccess", "canAccessCase",
  "requireTestDriveManageAccess", "canAccessTestDriveBooking",
  "requirePlatformAdminAction", "requirePlatformAdmin",
  "requirePortalScope", "getPortalContact", "getPortalScope",
  // Signature-request access. resolveSignatureRequestAccess calls
  // requirePermission itself and THEN adds a record check, so an action using it
  // is more strictly guarded than one calling requirePermission directly — but
  // the delegation walk below only follows calls into sibling ACTION modules,
  // not into src/lib, so it cannot see that for itself. Listing them here is the
  // fix; widening the walk to all of src/lib would make an approved-guard list
  // meaningless, since almost everything eventually reaches an auth helper.
  "resolveSignatureRequestAccess", "canAccessSignatureRequest", "canAccessRecipient",
];
const GUARD_CALL = new RegExp(`\\b(?:${APPROVED_GUARDS.join("|")})\\s*\\(`);

// Deliberately reachable without a session. Each entry is `file.ts#exportName`.
const PUBLIC_ACTIONS = new Map<string, string>([
  // The customer portal's OWN login ceremony — it runs before a portal session
  // exists, so it cannot require one. Both steps are rate limited per account
  // and per IP, and both answer generically so they cannot be used to probe
  // which email addresses are customers.
  ["portal.ts#requestPortalOtp", "portal login: issues the OTP, pre-session"],
  ["portal.ts#verifyPortalOtp", "portal login: consumes the OTP, pre-session"],
  // Clears the portal cookie and redirects. Nothing to authorize: the worst an
  // unauthenticated caller achieves is signing nobody out.
  ["portal.ts#portalLogout", "portal logout: only deletes the caller's own cookie"],
  // Public token-gated survey pages (/s is in the proxy's PUBLIC_PATHS). The
  // single-use response token IS the credential; it selects the tenant scope.
  ["surveys.ts#submitSurveyResponse", "public survey response, authorised by its token"],
]);

type Decl = { body: string; exported: boolean; line: number };

/** Every top-level function-ish declaration in a module, keyed by name. */
function readModule(file: string) {
  const raw = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls = new Map<string, Decl>();
  const imports = new Map<string, string>(); // local name -> "otherFile.ts"

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const m = /^(?:@\/app\/actions|\.)\/(\w+)$/.exec(spec);
      const bindings = st.importClause?.namedBindings;
      if (m && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imports.set(el.name.text, `${m[1]}.ts`);
      }
      continue;
    }
    // `getModifiers` only accepts nodes that can carry them; a bare `Statement`
    // is not one, so narrow first rather than casting the check away.
    const modifiers = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    const exported = modifiers.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword);
    const add = (name: ts.Identifier, node: ts.Node | undefined) => {
      if (!node) return;
      decls.set(name.text, {
        body: stripComments(node.getText(sf)),
        exported,
        line: sf.getLineAndCharacterOfPosition(name.getStart(sf)).line + 1,
      });
    };
    if (ts.isFunctionDeclaration(st) && st.name) add(st.name, st.body);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) add(d.name, d.initializer);
      }
    }
  }
  return { decls, imports };
}

test("every exported server action reaches an auth guard on its entry path", () => {
  const files = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
  assert.ok(files.length > 50, `expected the action modules, found ${files.length}`);

  const modules = new Map(files.map((f) => [f, readModule(join(ACTIONS_DIR, f))]));

  // A declaration is "guarded" when it calls an approved guard itself, or calls
  // another declaration (same module, or imported from a sibling action module)
  // that is guarded. Iterate to a fixpoint so delegation chains resolve —
  // quickCreate.ts, for example, validates then hands off to leads/contacts.
  const guarded = new Set<string>();
  for (const [f, mod] of modules) {
    for (const [name, d] of mod.decls) if (GUARD_CALL.test(d.body)) guarded.add(`${f}#${name}`);
  }
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const [f, mod] of modules) {
      for (const [name, d] of mod.decls) {
        const key = `${f}#${name}`;
        if (guarded.has(key)) continue;
        for (const callee of d.body.matchAll(/\b(\w+)\s*\(/g)) {
          const local = callee[1];
          if (local === name) continue;
          const target = mod.decls.has(local) ? `${f}#${local}`
            : mod.imports.has(local) ? `${mod.imports.get(local)}#${local}`
            : null;
          if (target && guarded.has(target)) { guarded.add(key); changed = true; break; }
        }
      }
    }
    if (!changed) break;
  }

  const offenders: string[] = [];
  const staleAllowlist = new Set(PUBLIC_ACTIONS.keys());
  for (const [f, mod] of modules) {
    for (const [name, d] of mod.decls) {
      if (!d.exported) continue;
      const key = `${f}#${name}`;
      if (PUBLIC_ACTIONS.has(key)) {
        staleAllowlist.delete(key);
        continue;
      }
      if (!guarded.has(key)) offenders.push(`${f}:${d.line} ${name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These exported server actions reach no auth guard. A Server Action is an untrusted POST " +
      "entry point, so add the guard that matches what it exposes — or, if it is genuinely " +
      "public, add it to PUBLIC_ACTIONS with a reason:\n  " + offenders.join("\n  "),
  );
  assert.deepEqual(
    [...staleAllowlist],
    [],
    `PUBLIC_ACTIONS lists exports that no longer exist — prune them: ${[...staleAllowlist].join(", ")}`,
  );
});

test("the bot integration-status actions are owner-gated", () => {
  // Regression for the specific finding: whisperConfigured() and telegramStatus()
  // shipped with no guard at all — every other export in bot.ts calls
  // requireOwner(). Both report whether an integration secret is stored (OpenAI
  // key, Telegram bot token), so their only defence was that the one page that
  // renders them, /chatbot, happens to be proxy-gated. Next's own guidance is
  // that render-time gating is not a security boundary and every Server
  // Function must check for itself.
  const { decls } = readModule(join(ACTIONS_DIR, "bot.ts"));
  for (const name of ["whisperConfigured", "telegramStatus"]) {
    const d = decls.get(name);
    assert.ok(d, `${name} should still exist in bot.ts`);
    assert.match(
      d.body,
      /requireOwner\s*\(/,
      `bot.ts#${name} leaks integration configuration state — it must call requireOwner() first`,
    );
  }
});

// --- /products and /trash must not depend on the proxy ---------------------

function pagesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pagesUnder(p));
    else if (name === "page.tsx" || name === "layout.tsx") out.push(p);
  }
  return out;
}

test("every /products and /trash page and layout enforces owner itself", () => {
  // ROUTE_GATES marks both segments "admin" (owner-only), but that rule is only
  // consulted by the proxy, which reads the role from the JWT and only sees
  // requests whose URL is under those prefixes. The check has to hold at the
  // page too, especially for /trash — it reads every soft-deleted record through
  // basePrisma, which bypasses the RLS extension.
  const segments = [join(APP_DIR, "products"), join(APP_DIR, "trash")];
  const offenders: string[] = [];
  const missingLayouts: string[] = [];
  for (const seg of segments) {
    const files = pagesUnder(seg);
    assert.ok(files.length > 0, `expected pages under ${seg}`);
    // the segment layout is the default-deny net for pages added later
    if (!files.some((f) => f.endsWith("layout.tsx"))) missingLayouts.push(seg.slice(ROOT.length + 1).replace(/\\/g, "/"));
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      if (!/\brequireOwner\s*\(\s*\)/.test(src)) offenders.push(f.slice(ROOT.length + 1).replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These owner-only route files rely on the proxy for authorization instead of checking " +
      "themselves — add `await requireOwner()`:\n  " + offenders.join("\n  "),
  );
  assert.deepEqual(
    missingLayouts,
    [],
    "These owner-only segments need a layout.tsx calling requireOwner() so a page added later " +
      "is denied by default:\n  " + missingLayouts.join("\n  "),
  );
});

test("every /products and /trash server action is owner-gated", () => {
  for (const file of ["products.ts", "trash.ts"]) {
    const { decls } = readModule(join(ACTIONS_DIR, file));
    for (const [name, d] of decls) {
      if (!d.exported) continue;
      assert.match(
        d.body,
        /requireOwner\s*\(/,
        `${file}#${name} touches owner-only data and must check for itself — a Server Action ` +
          "is an untrusted POST entry point, not a function only the page can reach",
      );
    }
  }
});

test("the proxy keeps its owner gate for /products and /trash (defence in depth)", () => {
  // The page-level checks are the real control; the proxy rule stays because it
  // gives the nicer redirect and pre-filters before any page code runs.
  const access = stripComments(readFileSync(join(ROOT, "src", "lib", "routeAccess.ts"), "utf8"));
  for (const prefix of ["/products", "/trash"]) {
    assert.match(
      access,
      new RegExp(`prefix:\\s*"${prefix}",\\s*owner:\\s*true`),
      `ROUTE_RULES must keep the owner-only rule for ${prefix}`,
    );
  }
  assert.match(access, /if \("owner" in rule\) return false;/, "an owner-only route must fail closed for non-owners");

  // …and they must never be treated as public by the proxy.
  const proxy = stripComments(readFileSync(join(ROOT, "src", "proxy.ts"), "utf8"));
  const publicList = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(proxy)?.[1] ?? "";
  assert.ok(publicList.length > 0, "expected to find PUBLIC_PATHS in src/proxy.ts");
  for (const prefix of ["/products", "/trash"]) {
    assert.equal(publicList.includes(`"${prefix}"`), false, `${prefix} must not be in PUBLIC_PATHS`);
  }
});
