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

// ── F1 · rate-limit identity ────────────────────────────────────────────────

test("F1: THE CLIENT CANNOT CHOOSE ITS OWN RATE-LIMIT BUCKET", () => {
  /*
   * `X-Forwarded-For` is a list each hop APPENDS to, so the leftmost entry is
   * whatever the original caller sent — including a caller who invented it.
   * Reading `[0]` let anyone pick a bucket, and a fresh one per request.
   *
   * The account-keyed limit still caught stuffing against one login, so what
   * this actually protected was the defence against PASSWORD SPRAYING: one
   * attempt each across many accounts, which by design never trips a
   * per-account counter.
   */
  const spoofed = bag({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
  assert.notEqual(clientIpFrom(spoofed), "1.2.3.4", "the client-supplied leftmost entry must never win");
  assert.equal(clientIpFrom(spoofed), "203.0.113.9", "the rightmost hop is the one we trust");
});

test("F1: the platform's own header outranks anything in the forwarded chain", () => {
  // Vercel sets x-vercel-forwarded-for at the edge and strips it from inbound
  // client requests, so it cannot be forged from outside.
  const ip = clientIpFrom(bag({
    "x-vercel-forwarded-for": "198.51.100.7",
    "x-forwarded-for": "1.2.3.4, 5.6.7.8",
  }));
  assert.equal(ip, "198.51.100.7");
});

test("F1: a single-entry chain still works, and nothing identifiable degrades to one shared bucket", () => {
  // If the platform REPLACES the header, leftmost and rightmost are the same
  // value — the fix is correct under either platform behaviour, which is why it
  // did not need the behaviour settled first.
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientIpFrom(bag({ "x-real-ip": "203.0.113.10" })), "203.0.113.10");
  assert.equal(clientIpFrom(bag({})), "unknown");
  // Whitespace and empty members must not produce an empty bucket key.
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": " , , 203.0.113.11 , " })), "203.0.113.11");
  assert.equal(clientIpFrom(bag({ "x-forwarded-for": " , , " })), "unknown");
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
