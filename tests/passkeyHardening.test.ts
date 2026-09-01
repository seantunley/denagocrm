import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The 2026-09-01 adversarial retest found the passkey flow to be the one part of
 * the authentication surface that had not had the attention the password path
 * had. Four items, none exploitable, all cheap. These pin them.
 *
 * Read as SOURCE, not by importing: every module on this path pulls in
 * `server-only`, `next/headers` and a Prisma client, none of which resolve in a
 * plain node:test process. Source assertions are what the rest of this suite
 * uses for the same reason (see apiAuth.test.ts, cspReporting.test.ts).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const AUTH_VERIFY = "src/app/api/auth/passkey/auth/verify/route.ts";
const AUTH_OPTIONS = "src/app/api/auth/passkey/auth/options/route.ts";
const REG_VERIFY = "src/app/api/auth/passkey/register/verify/route.ts";
const REG_OPTIONS = "src/app/api/auth/passkey/register/options/route.ts";
const WEBAUTHN = "src/lib/webauthn.ts";

/**
 * Comment-stripped, because this codebase explains its security decisions in
 * prose directly above the code that implements them — so a bare regex scores
 * the EXPLANATION of a control as the control itself. That is not hypothetical:
 * it is the defect the previous audit's own F3 test shipped with, and the
 * reason tests/actionAuthGates.ts exports a stripComments of its own.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

test("stripComments does not credit a control that is only described", () => {
  assert.equal(/registerRateLimitAttempt/.test(stripComments("// registerRateLimitAttempt()")), false);
  assert.equal(/registerRateLimitAttempt/.test(stripComments("/** registerRateLimitAttempt */")), false);
  assert.equal(/registerRateLimitAttempt/.test(stripComments("await registerRateLimitAttempt(k, P);")), true);
});

// ── F1: the passkey login path is throttled and failures are recorded ────────

test("BOTH HALVES OF THE PASSKEY CEREMONY ARE RATE LIMITED", () => {
  // Both are in PUBLIC_PATHS, so both are reachable by anyone with no session.
  // Before this, neither had any limiter and there was no proxy-level one either.
  for (const file of [AUTH_VERIFY, AUTH_OPTIONS]) {
    const code = stripComments(src(file));
    assert.match(code, /PASSKEY_POLICY/, `${file} must use the passkey policy`);
    assert.match(code, /getRequestIp\s*\(/, `${file} must key the limit on the caller`);
    assert.match(code, /registerRateLimitAttempt\s*\(/, `${file} must record attempts`);
  }
});

test("VERIFY REFUSES BEFORE IT DOES THE WORK — the limit gates, it does not merely count", () => {
  const code = stripComments(src(AUTH_VERIFY));
  assert.match(code, /checkRateLimit\s*\(/, "must consult the limit");
  assert.match(code, /status:\s*429/, "must refuse with 429 when blocked");
  // The gate has to precede the database lookup, or the throttle bounds nothing
  // that costs anything.
  assert.ok(
    code.indexOf("checkRateLimit") < code.indexOf("prisma.passkey.findUnique"),
    "the rate-limit gate must run BEFORE the passkey lookup",
  );
});

test("A FAILED PASSKEY ATTEMPT IS RECORDED — the monitoring half of the finding", () => {
  /*
   * The more valuable half. `/login` throttles AND calls recordFailedLogin; this
   * route logged `passkey.login` on success only, so a sustained campaign against
   * it left no trace anywhere while the same campaign against /login left two.
   */
  const code = stripComments(src(AUTH_VERIFY));
  assert.match(code, /passkey\.login_failed/, "failures must be auditable");
  // Every rejection routes through one exit, so a later early-return cannot
  // silently skip the accounting again.
  const fails = [...code.matchAll(/await fail\(/g)].length;
  assert.ok(fails >= 5, `expected every rejection to route through fail(); saw ${fails}`);
});

test("a successful sign-in does not leave the staffer throttled", () => {
  // Failure-counting, LOGIN_POLICY's pattern: an ordinary user never accumulates.
  // Without this an office behind one NAT would ratchet toward a shared block.
  const code = stripComments(src(AUTH_VERIFY));
  assert.match(code, /clearRateLimit\s*\(/, "success must clear the counter");
});

test("the policy is sized for a SHARED office IP, not for one person", () => {
  // Constrained-user check: this bucket is per-IP and staff sit behind one NAT,
  // so a LOGIN_POLICY-shaped limit of 5 would lock out colleagues who did
  // nothing. Assert it is meaningfully more generous than the per-account one.
  const code = src("src/lib/rateLimit.ts");
  const block = code.slice(code.indexOf("export const PASSKEY_POLICY"));
  const limit = Number(block.match(/limit:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(limit), "PASSKEY_POLICY must declare a limit");
  assert.ok(limit >= 20, `a per-IP passkey limit of ${limit} would lock out a shared office`);
});

// ── F2: key separation ───────────────────────────────────────────────────────

test("THE CHALLENGE COOKIE IS NOT SIGNED WITH THE SESSION KEY ITSELF", () => {
  /*
   * The same key-separation issue lib/domainCheck.ts already fixed with HKDF in
   * the previous audit, which simply did not reach this file. Not exploitable
   * while the claim shapes differ — which is the objection: the safety came
   * from the payload shape, so it expires the day somebody adds a claim.
   */
  const code = stripComments(src(WEBAUTHN));
  assert.match(code, /hkdfSync/, "the signing key must be derived, not reused");
  assert.match(code, /denago:webauthn-challenge:v1/, "…with a purpose-specific info string");
  // The raw secret must never be the key material handed to sign()/jwtVerify().
  assert.doesNotMatch(
    code,
    /TextEncoder\(\)\.encode\(process\.env\.SESSION_SECRET/,
    "SESSION_SECRET must not be used directly as the signing key",
  );
});

test("a missing secret behaves like the session layer: throw in production", () => {
  // The previous version fell back to the dev secret silently even in
  // production. Unreachable in practice (session.ts throws first on any real
  // deployment) — but this file should not be the one that makes it reachable.
  const code = stripComments(src(WEBAUTHN));
  assert.match(code, /NODE_ENV === "production"/);
  assert.match(code, /throw new Error/);
});

// ── F3: ceremony binding ─────────────────────────────────────────────────────

test("REGISTRATION AND AUTHENTICATION CHALLENGES ARE NOT INTERCHANGEABLE", () => {
  /*
   * They share one cookie and one key. register/verify was bound by `uid`;
   * auth/verify was bound by nothing and accepted a registration challenge.
   * No attack survived — verifyAuthenticationResponse rejects an attestation's
   * shape — but that is a third-party library's input validation standing in
   * for an access control decision.
   */
  const lib = stripComments(src(WEBAUTHN));
  assert.match(lib, /payload\.pur !== purpose/, "readChallenge must enforce the purpose");
  assert.match(lib, /pur:\s*purpose/, "stashChallenge must stamp the purpose");

  // And each route must name the ceremony it is actually completing.
  assert.match(stripComments(src(AUTH_VERIFY)), /readChallenge\("auth"\)/);
  assert.match(stripComments(src(AUTH_OPTIONS)), /stashChallenge\("auth"/);
  assert.match(stripComments(src(REG_VERIFY)), /readChallenge\("reg"\)/);
  assert.match(stripComments(src(REG_OPTIONS)), /stashChallenge\("reg"/);
});

test("register/verify still binds the challenge to the signed-in user", () => {
  // The purpose check ADDS to the uid check; it must not have replaced it.
  const code = stripComments(src(REG_VERIFY));
  assert.match(code, /stashed\.uid !== user\.id/, "the uid binding must survive");
  assert.match(code, /requireUser\s*\(/, "registration is not a public ceremony");
});

// ── F4: a disabled account is refused, not 500 ───────────────────────────────

test("A DISABLED ACCOUNT IS REFUSED CLEANLY, AND STILL REFUSED", () => {
  /*
   * createSessionCookie throws for a disabled user (lib/auth.ts) and that call
   * was uncaught here, so an offboarded staffer with a valid passkey got an
   * unhandled 500. It failed CLOSED — no session — so this is error surface,
   * not a way in. The important half of this test is the second assertion:
   * catching the throw must not become "handle it by continuing".
   */
  const code = stripComments(src(AUTH_VERIFY));
  const call = code.indexOf("createSessionCookie");
  assert.ok(call > 0, "the route must still mint the session through createSessionCookie");
  const after = code.slice(call);
  assert.match(after, /catch/, "the disabled-user throw must be caught");
  assert.match(after, /status:\s*403|await fail\(/, "…and answered with a refusal");
});

test("the route does NOT reimplement the disabled/sessionVersion checks", () => {
  /*
   * Deliberate. Those live in one place (createSessionCookie refuses to mint,
   * and the session read re-checks disabledAt AND sessionVersion on every
   * request thereafter). A second copy here would be a second thing to keep
   * correct, and the retest's withdrawn finding was precisely the mistake of
   * reading this route in isolation and concluding the check was missing.
   */
  const code = stripComments(src(AUTH_VERIFY));
  assert.doesNotMatch(code, /disabledAt/, "the disabled check belongs to the session layer");
});
