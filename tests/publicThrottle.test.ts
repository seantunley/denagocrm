import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Rate limiting for endpoints reachable with no staff session.
 *
 * Only the signing routes were throttled at first — the audit flagged those, I
 * fixed those, and stopped. These tests exist so the next public endpoint has
 * to make a decision about throttling rather than inherit "no" by default.
 */

test("a blocked IP cannot mint more subject rows", () => {
  // The bug this encodes shipped once already, in the signing limiter: the
  // subject key is caller-supplied, so registering it unconditionally let an
  // attacker grow SecurityRateLimit without bound WHILE being told 429.
  // Being blocked has to stop the row being written, not just the work.
  const code = src("src/lib/publicThrottle.ts");
  const ipCheck = code.indexOf("if (!byIp.allowed) return");
  const subjectRegister = code.indexOf("registerRateLimitAttempt(rateLimitKey(`${scope}-subject`");
  assert.ok(ipCheck > 0, "the IP result must be checked on its own");
  assert.ok(subjectRegister > 0, "the subject key must exist");
  assert.ok(ipCheck < subjectRegister, "the IP check must short-circuit BEFORE the subject is registered");
});

test("the IP key is registered on every request that reaches the throttle", () => {
  // Otherwise a caller rotating tokens never accumulates against their address,
  // and the short-circuit above has nothing to fire on.
  const code = src("src/lib/publicThrottle.ts");
  const ipRegister = code.indexOf("registerRateLimitAttempt(rateLimitKey(`${scope}-ip`");
  assert.ok(ipRegister > 0 && ipRegister < code.indexOf("if (!byIp.allowed) return"));
});

test("every public mutating endpoint throttles", () => {
  // Each entry is an endpoint that writes, reachable with no staff session.
  const surfaces: [string, string][] = [
    ["src/app/api/signing/[token]/route.ts", "accepts a signature"],
    ["src/app/api/signing/[token]/decline/route.ts", "declines a signature"],
    ["src/app/api/approvals/[token]/route.ts", "approves or rejects a workflow"],
    ["src/app/actions/surveys.ts", "writes a survey response"],
    ["src/app/api/intake/route.ts", "creates leads"],
    ["src/app/api/bookings/route.ts", "creates bookings"],
    ["src/app/api/bookings/slots/route.ts", "enumerates availability"],
    ["src/app/api/service-lookup/route.ts", "discloses vehicle data"],
    ["src/app/api/service-lookup/verify/route.ts", "verifies an owner"],
  ];
  for (const [rel, what] of surfaces) {
    assert.match(
      src(rel),
      /throttlePublic\(|checkPublicThrottle\(|rateLimitSigning\(/,
      `${rel} ${what} with no session and no throttle`,
    );
  }
});

test("API-key routes throttle BEFORE the key is checked", () => {
  // Throttling only after authentication leaves key-guessing unbounded.
  for (const rel of [
    "src/app/api/intake/route.ts",
    "src/app/api/bookings/route.ts",
    "src/app/api/bookings/slots/route.ts",
    "src/app/api/service-lookup/route.ts",
    "src/app/api/service-lookup/verify/route.ts",
  ]) {
    const code = src(rel);
    const throttleAt = code.indexOf("await throttlePublic(");
    const authAt = code.indexOf("await authenticateIntakeKey(");
    assert.ok(throttleAt > 0, `${rel} must throttle`);
    assert.ok(throttleAt < authAt, `${rel} must throttle before authenticating the key`);
  }
});

test("every endpoint gets its OWN throttle scope", () => {
  // Found by running it: a templating slip gave all five API-key routes the
  // scope "api-", so they shared one bucket and a busy intake integration would
  // have throttled bookings. Not a security hole — an availability one, and
  // invisible to every other check.
  const scoped: [string, string][] = [
    ["src/app/api/intake/route.ts", "api-intake"],
    ["src/app/api/bookings/route.ts", "api-bookings"],
    ["src/app/api/bookings/slots/route.ts", "api-bookings-slots"],
    ["src/app/api/service-lookup/route.ts", "api-service-lookup"],
    ["src/app/api/service-lookup/verify/route.ts", "api-service-lookup-verify"],
    ["src/app/api/approvals/[token]/route.ts", "approvals"],
    ["src/app/actions/surveys.ts", "survey-submit"],
  ];
  const seen = new Set<string>();
  for (const [rel, scope] of scoped) {
    assert.ok(
      src(rel).includes(`"${scope}"`),
      `${rel} must throttle under the scope "${scope}"`,
    );
    assert.ok(!seen.has(scope), `"${scope}" is used twice — separate endpoints must not share a bucket`);
    seen.add(scope);
  }
});

test("throttling is implemented once, not per endpoint", () => {
  // The signing limiter had its own copy and that is where the ordering bug
  // lived. It now delegates, so there is a single place to get this right.
  const signing = src("src/lib/signing/throttle.ts");
  assert.match(signing, /throttlePublic\("signing", token, SIGNING_POLICY\)/);
  assert.doesNotMatch(signing, /registerRateLimitAttempt/, "no second implementation of the ordering rule");
});

test("a throttled survey respondent is not told their link is dead", () => {
  // The link is fine; they are just early. "No longer valid" makes someone
  // abandon a survey they were willing to finish.
  const form = src("src/components/SurveyForm.tsx");
  // Assert the branch and its message together — a window after the match runs
  // straight into the `else` that DOES say "no longer valid".
  assert.match(
    form,
    /error === "rate_limited"\)\s*setError\("Too many attempts/,
    "a throttled respondent must get a wait-and-retry message, not a dead-link one",
  );
});

test("open-tracking and unsubscribe are deliberately NOT throttled", () => {
  // Recorded so it reads as a decision rather than an oversight:
  //   track      — Gmail's image proxy fetches opens for a whole campaign from
  //                a handful of Google IPs, so IP throttling would break open
  //                tracking wholesale, to prevent inflated counts.
  //   unsubscribe — mail clients prefetch links, and blocking a legitimate
  //                opt-out is a compliance problem far worse than the abuse.
  const note = src("src/lib/publicThrottle.ts");
  assert.match(note, /NOT throttled on purpose/, "the exclusions must be written down where the helper is");
});

test("the throttle degrades when there is no request to read an IP from", () => {
  // headers() THROWS outside a request scope. Once the public endpoints started
  // throttling, that turned "we cannot see who this is" into "the route
  // explodes" — the tenant-guard suite invokes route handlers directly and the
  // whole CI run died on it. A rate limiter must never be the thing that fails
  // a request.
  const code = src("src/lib/rateLimit.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  const fn = code.slice(code.indexOf("export async function getRequestIp"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /try \{/, "reading the IP must not be able to throw");
  assert.match(body, /catch \{\s*return "unknown";\s*\}/, "…it degrades to the shared unknown bucket");
});
