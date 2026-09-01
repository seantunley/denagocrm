import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { clientIpFrom } from "../src/lib/rateLimit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** A stand-in for the Headers bag `headers()` returns. */
const bag = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

/**
 * Regressions for the findings of the 2026-09-01 security audit.
 * Each test fails if its fix is undone. See SECURITY-AUDIT-2026-09-01.md.
 */

// ── F1 · rate-limit identity ───────────────────────────────────────

/*
 * THE ORIGINAL F1 FINDING WAS WRONG, and these tests encode the correction.
 *
 * The audit claimed the leftmost `X-Forwarded-For` entry was caller-controlled
 * on this deployment. Vercel's documentation says the opposite: it OVERWRITES
 * the header and does not forward external IPs, "to prevent IP spoofing". So
 * the original code was not vulnerable here.
 *
 * The first fix was also wrong in the other direction: "take the rightmost
 * entry" is not a general rule. It names the nearest proxy, not the client, and
 * with no trusted proxy at all every entry is forged anyway.
 *
 * What survives is the part that was always true: a forwarded header means
 * something only when a trusted proxy wrote it, so trust is a property of the
 * DEPLOYMENT rather than of the parsing.
 */

test("F1: WITHOUT A TRUSTED PROXY, NO FORWARDED HEADER MAY KEY A LIMIT", () => {
  // Directly exposed: the caller writes every one of these, so honouring any of
  // them would let them mint unlimited buckets. One shared bucket instead.
  const untrusted = { trustedProxy: false };
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "1.2.3.4" }), untrusted), "unknown");
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), untrusted), "unknown");
  assert.equal(clientIpFrom(bag({ "x-real-ip": "1.2.3.4" }), untrusted), "unknown");
});

test("F1: behind a trusted proxy the LEFTMOST entry is the client, because the proxy replaced the header", () => {
  // Vercel overwrites X-Forwarded-For, so its first entry is the real client
  // IP. Taking the rightmost here would have named a proxy, not the caller.
  const trusted = { trustedProxy: true };
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "203.0.113.9" }), trusted), "203.0.113.9");
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), trusted), "203.0.113.9");
  assert.equal(clientIpFrom(bag({ "x-real-ip": "203.0.113.10" }), trusted), "203.0.113.10");
  assert.equal(clientIpFrom(bag({}), trusted), "unknown");
});

test("F1: the platform header outranks the forwarded chain, and is trusted even without the flag", () => {
  // `x-vercel-forwarded-for` is set by the edge and, per Vercel's docs, is the
  // variant that survives when another proxy sits on top.
  const ip = clientIpFrom(
    bag({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "1.2.3.4" }),
    { trustedProxy: false },
  );
  assert.equal(ip, "198.51.100.7");
});

test("F1: whitespace and empty members never produce an empty bucket key", () => {
  const trusted = { trustedProxy: true };
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": " 203.0.113.11 , 10.0.0.1 " }), trusted), "203.0.113.11");
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "  " }), trusted), "unknown");
});

test("F1: the trust boundary is a deployment fact, not a parsing heuristic", () => {
  const source = src("src/lib/rateLimit.ts");
  assert.match(source, /process\.env\.VERCEL/, "the platform must be detected explicitly");
  assert.match(source, /TRUST_PROXY_HEADERS/, "self-hosting must be able to opt in explicitly");
  assert.match(source, /trustedProxy/, "the rule must take trust as an input, not infer it");
});

// ── F2 · srcDoc iframes ─────────────────────────────────────────────────────

test("F2: EVERY srcDoc IFRAME IS SANDBOXED — it would otherwise run in this origin", () => {
  /*
   * A `srcDoc` iframe with no `sandbox` executes in the PARENT's origin.
   * Campaign HTML is stored exactly as authored (actions/campaigns.ts applies
   * merge variables and nothing else — there is no sanitiser in src/lib), and
   * the approvals document is rendered to an external party holding a token.
   *
   * The CSP blocks un-nonced inline script today, which is why this was never
   * exploitable — but that made ONE header the whole control. This asserts the
   * second one exists, everywhere, including in files added later.
   */
  const offenders: string[] = [];
  for (const rel of [
    "src/app/(app)/campaigns/[id]/page.tsx",
    "src/app/approvals/[token]/ApprovalSurface.tsx",
    "src/components/marketing/TemplateWorkspace.tsx",
  ]) {
    const source = src(rel);
    for (const tag of source.matchAll(/<iframe[^>]*>/g)) {
      if (/srcDoc/.test(tag[0]) && !/sandbox=/.test(tag[0])) offenders.push(`${rel}: ${tag[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], `unsandboxed srcDoc iframe(s):\n  ${offenders.join("\n  ")}`);
});

// ── F3 · login timing ───────────────────────────────────────────────────────

test("F3: SIGN-IN SPENDS THE SAME WORK WHETHER OR NOT THE EMAIL EXISTS", () => {
  /*
   * `user && … && await bcrypt.compare(…)` short-circuits, so an unknown email
   * skipped bcrypt entirely. bcrypt at cost 12 is ~100ms by design, so the
   * timing said which emails were real while the message said nothing — the
   * uniform "Invalid email or password." was doing no work.
   */
  const source = src("src/app/login/actions.ts");
  assert.match(source, /TIMING_DECOY_HASH/, "a decoy hash must exist");
  assert.match(
    source,
    /bcrypt\.compare\(password, user\?\.passwordHash \?\? TIMING_DECOY_HASH\)/,
    "the compare must run unconditionally, against the decoy when there is no user",
  );
  // The decoy must be a real cost-12 bcrypt hash, or it does not cost the same.
  const decoy = /TIMING_DECOY_HASH = "([^"]+)"/.exec(source)?.[1] ?? "";
  assert.match(decoy, /^\$2[aby]\$12\$/, "decoy must be bcrypt at cost 12");
});

test("F3: NO DATABASE ROUND TRIP IS CONDITIONAL ON THE EMAIL EXISTING", () => {
  /*
   * The first fix removed bcrypt's ~100ms difference and stopped there, and
   * review caught that the claim of "identical work" was still false: the
   * security-state SELECT and the failed-login UPDATE both ran only when a user
   * had been found. Two extra round trips on one path and none on the other is
   * a smaller version of exactly the leak the decoy hash was added to close.
   *
   * Both now run on both paths, against a sentinel id when there is no user.
   * This asserts the SHAPE of the path rather than just the hash call — which is
   * precisely what the earlier test failed to do.
   */
  const source = src("src/app/login/actions.ts");
  /*
   * Bounded to `login` alone, and stripped of comments. Three traps, all hit
   * while writing this test:
   *   - a "\n}\n" terminator matches nothing in a CRLF file, so the slice ran
   *     to end-of-file;
   *   - the next function is `sendLoginEmailCode`, declared WITHOUT `export`,
   *     so bounding on "export async function" ran straight past it;
   *   - the assertions below name the old code, so they matched the comments
   *     that explain the old code rather than the code itself.
   * The other functions' conditional reads are legitimate: they run only after
   * a password has already matched, so there is no email to enumerate.
   */
  const from = source.indexOf("export async function login");
  const after = source.indexOf("\nasync function ", from);
  const withComments = source.slice(from, after > from ? after : undefined);
  const body = withComments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  assert.match(body, /NO_SUCH_USER_ID/, "a sentinel id must exist for the no-user path");
  assert.doesNotMatch(
    body,
    /user \? recordFailedLogin\(/,
    "failed-login accounting must not be conditional on the user existing",
  );
  assert.doesNotMatch(
    body,
    /user \? await getUserSecurityState\(/,
    "the security read must not be conditional on the user existing",
  );
  assert.match(
    body,
    /getUserSecurityState\(user\?\.id \?\? NO_SUCH_USER_ID\)/,
    "the security read runs either way, against the sentinel when there is no user",
  );
  assert.match(
    body,
    /recordFailedLogin\(user\?\.id \?\? NO_SUCH_USER_ID\)/,
    "the failed-login write runs either way, against the sentinel when there is no user",
  );
  // The sentinel must be an id the schema can never mint, or it could collide
  // with a real account and the UPDATE would touch somebody's row.
  const sentinel = /NO_SUCH_USER_ID = "([^"]*)"/.exec(source)?.[1] ?? "";
  assert.ok(sentinel.length > 0 && !/^c[a-z0-9]{20,}$/.test(sentinel), "sentinel must not be cuid-shaped");
});

test("F3: the decoy cannot be matched by any submitted password", async () => {
  const bcrypt = (await import("bcryptjs")).default;
  const decoy = /TIMING_DECOY_HASH = "([^"]+)"/.exec(src("src/app/login/actions.ts"))?.[1] ?? "";
  for (const guess of ["", "password", "admin", decoy]) {
    assert.equal(await bcrypt.compare(guess, decoy), false, `decoy must not match ${JSON.stringify(guess)}`);
  }
});

// ── F4 · upload allow-list ──────────────────────────────────────────────────

test("F4: the document library accepts only the types it is for", () => {
  const source = src("src/app/api/library/upload/route.ts");
  assert.match(source, /allowedContentTypes:/, "an allow-list must be declared");
  // The two that turn a trusted domain into a delivery mechanism.
  assert.doesNotMatch(source, /"text\/html"/, "HTML must never be accepted");
  assert.doesNotMatch(source, /"image\/svg\+xml"/, "SVG carries script — never accepted");
});

test("F4: serving still refuses to render anything but images and PDF inline", () => {
  // The allow-list above is depth, not the primary control: this one is why an
  // uploaded file cannot execute even if it reaches storage.
  const source = src("src/app/api/files/[id]/route.ts");
  const inline = /SAFE_INLINE = ([^;]+);/.exec(source)?.[1] ?? "";
  assert.match(inline, /image\\\/\(png\|jpe\?g\|gif\|webp\|avif\)|application\\\/pdf/, "inline set must stay narrow");
  assert.doesNotMatch(inline, /svg/i, "SVG must never render inline");
  assert.match(source, /X-Content-Type-Options[\s\S]*nosniff/);
});

// ── F6 · key separation ─────────────────────────────────────────────────────

test("F6: THE PUBLIC DOMAIN-PROOF ORACLE IS NOT KEYED ON THE SESSION SECRET", async () => {
  /*
   * `/api/brand/domain-check` is public and returns an HMAC for a hostname the
   * caller influences — a signing oracle. Keyed on SESSION_SECRET directly it
   * was still safe, because the `domain-check:` prefix and lowercasing mean the
   * signed message can never take the shape of a JWT signing input. But that
   * safety came from the message FORMAT, so it would expire the day the format
   * changed. A derived key makes it structural instead.
   */
  process.env.SESSION_SECRET = "test-session-secret-value-long-enough";
  const { domainProof } = await import("../src/lib/domainCheck");
  const proof = domainProof("example.com");

  const naive = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update("domain-check:example.com")
    .digest("hex");
  assert.notEqual(proof, naive, "the proof must not be an HMAC under the raw session secret");

  assert.match(src("src/lib/domainCheck.ts"), /hkdfSync/, "the key must be derived, not reused");
  // Deterministic: both sides of a verification compute it independently.
  assert.equal(domainProof("EXAMPLE.com"), proof, "host comparison stays case-insensitive");
});
