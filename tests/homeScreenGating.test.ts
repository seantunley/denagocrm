import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The home screen offers the product's most prominent actions, and every one of
 * them must be gated on the permission its destination enforces.
 *
 * The rule is the house one, stated on the nav that offers these same
 * destinations (components/nav-config.ts): a guard "applies on the page, so this
 * link cannot appear for someone /fleets bounces". It is not a security
 * boundary — the destinations guard themselves — it is the difference between a
 * screen that offers what you can do and one that offers what you cannot.
 *
 * Read as SOURCE rather than imported: these modules pull in `server-only`,
 * `next/headers` and a Prisma client, none of which resolve in a plain
 * node:test process. Same approach as apiAuth.test.ts and cspReporting.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const HOME = "src/components/home/CRMHome.tsx";
const PAGE = "src/app/(app)/page.tsx";

/**
 * Comment-stripped, because this codebase explains its security decisions in
 * prose directly above the code implementing them — so a bare regex scores the
 * EXPLANATION as the control. That is not hypothetical: it is the defect the
 * 2026-09-01 audit's own F3 test shipped with.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

test("stripComments does not credit a gate that is only described", () => {
  assert.equal(/grants\(/.test(stripComments("// grants(access, 'leads.create')")), false);
  assert.equal(/grants\(/.test(stripComments("/** grants(access, x) */")), false);
  assert.equal(/grants\(/.test(stripComments("{grants(access, 'leads.create') && <Link/>}")), true);
});

/**
 * Each entry is [href, the guard the DESTINATION enforces, the gate expected here].
 * Verified against the routes themselves, not guessed:
 *   src/app/(app)/leads/new/page.tsx  → requirePermission("leads.create")
 *   src/app/(app)/calendar/page.tsx   → requireAnyPermission("activities.view", "activities.manage")
 */
const GATED_ACTIONS = [
  { href: "/leads/new", enforces: 'requirePermission("leads.create")', gate: /grants\(access,\s*"leads\.create"\)/ },
  { href: "/calendar", enforces: 'requireAnyPermission("activities.view", "activities.manage")', gate: /seesActivities/ },
] as const;

test("EVERY HOME-SCREEN ACTION IS GATED ON WHAT ITS DESTINATION ENFORCES", () => {
  const code = stripComments(src(HOME));
  for (const { href, enforces, gate } of GATED_ACTIONS) {
    const at = code.indexOf(`href="${href}"`);
    assert.ok(at > 0, `expected a link to ${href} on the home screen`);
    /*
     * Look BACKWARDS from the link for its gate. A JSX conditional renders as
     * `{cond && (<Link href=… />)}`, so the gate precedes the href; searching
     * forwards would find the NEXT action's gate and pass on its neighbour's
     * work. 400 chars covers the conditional and the opening tag without
     * reaching the previous element.
     */
    const window = code.slice(Math.max(0, at - 400), at);
    assert.match(
      window,
      gate,
      `${href} is rendered ungated — its page enforces ${enforces}, so a user without it sees the action and is redirected to /`,
    );
  }
});

test("the gate is the SAME pair the destination enforces, not a near miss", () => {
  // seesActivities must remain exactly /calendar's pair. If someone narrows it
  // to activities.manage the calendar button disappears for viewers who can in
  // fact open it; if they widen it, the button comes back for people it bounces.
  const code = stripComments(src(HOME));
  assert.match(
    code,
    /const seesActivities = grants\(access,\s*"activities\.view",\s*"activities\.manage"\)/,
    "seesActivities must mirror requireAnyPermission('activities.view','activities.manage')",
  );
});

test("a conditional action stays conditional — the custom-dashboard link", () => {
  // This one was already gated before the fix and is the pattern the other two
  // were missing; it is pinned so the fix cannot be "made consistent" by
  // deleting it instead.
  const code = stripComments(src(HOME));
  const at = code.indexOf('href="/d/home"');
  assert.ok(at > 0, "expected the custom dashboard link");
  assert.match(code.slice(Math.max(0, at - 400), at), /hasCustomDashboard/);
});

test("THE HOME PAGE AUTHENTICATES EXPLICITLY, not as a side effect of a data call", () => {
  /*
   * The page previously reached requireUser only THROUGH dashboardBySlug →
   * dashboardViewer. That worked, but it made the guard on the product's landing
   * page an incidental property of a lookup made for another reason: swapping
   * that call for a prop or a different query would have unguarded it silently.
   */
  const code = stripComments(src(PAGE));
  assert.match(code, /await requireUser\(\)/, "the home page must state its own guard");
  assert.match(code, /import \{ requireUser \}/, "…and import it");
});
