import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  campaignLinkHosts,
  configuredRedirectHosts,
  normalizeHost,
  safeRedirectTarget,
} from "../src/lib/trackRedirect";

const clickRoute = readFileSync(
  new URL("../src/app/api/track/c/[token]/route.ts", import.meta.url),
  "utf8",
);
const campaignsLib = readFileSync(new URL("../src/lib/campaigns.ts", import.meta.url), "utf8");

const APP = "crm.example.test";

test("a destination the app does not vouch for is never followed", () => {
  // The finding itself: the click tracker took `?u=` and redirected to any
  // absolute http(s) URL, which made a link on the company's own domain — the
  // shape recipients trust because real campaign mail uses it — land wherever
  // the sender of the link chose.
  assert.equal(safeRedirectTarget("https://evil.example/phish", [APP]), null);
  assert.equal(safeRedirectTarget("http://evil.example/phish", [APP]), null);
  assert.equal(safeRedirectTarget(`https://evil.example/?ref=${APP}`, [APP]), null);
});

test("a destination on a vouched-for host is followed", () => {
  assert.equal(safeRedirectTarget(`https://${APP}/promo`, [APP]), `https://${APP}/promo`);
  assert.equal(
    safeRedirectTarget("https://shop.example/promo", [APP, "shop.example"]),
    "https://shop.example/promo",
  );
  // A full URL is an acceptable allowlist entry too — only its host is used.
  assert.equal(
    safeRedirectTarget("https://shop.example/promo", [`https://${APP}`, "https://shop.example/x"]),
    "https://shop.example/promo",
  );
});

test("nothing is followed when the allowlist is empty", () => {
  // The unknown-token path: no campaign resolved means no vouched host, so the
  // caller gets null and must stay on its own home page.
  assert.equal(safeRedirectTarget("https://evil.example", []), null);
  assert.equal(safeRedirectTarget(`https://${APP}`, []), null);
  assert.equal(safeRedirectTarget(null, [APP]), null);
  assert.equal(safeRedirectTarget("", [APP]), null);
});

test("host confusion tricks that defeat a prefix check are rejected", () => {
  // Every one of these satisfies startsWith("https://" + APP) or looks like the
  // trusted host to a human, and every one resolves to evil.example.
  assert.equal(safeRedirectTarget(`https://${APP}.evil.example/x`, [APP]), null);
  assert.equal(safeRedirectTarget(`https://${APP}@evil.example/x`, [APP]), null);
  assert.equal(safeRedirectTarget(`https://${APP}:pw@evil.example/x`, [APP]), null);
  assert.equal(safeRedirectTarget(`https://${APP}-evil.example/x`, [APP]), null);
  assert.equal(safeRedirectTarget("https:///evil.example/x", [APP]), null);
});

test("protocol-relative and backslash forms are rejected", () => {
  // "//evil.example" and "/\evil.example" both read as same-origin paths to a
  // check that only looks for a leading slash; browsers follow them off-site.
  assert.equal(safeRedirectTarget("//evil.example/x", [APP, "evil.example"]), null);
  assert.equal(safeRedirectTarget("/\\evil.example/x", [APP, "evil.example"]), null);
  assert.equal(safeRedirectTarget("\\\\evil.example/x", [APP, "evil.example"]), null);
  assert.equal(safeRedirectTarget("/promo", [APP]), null);
});

test("non-http schemes never reach a Location header", () => {
  assert.equal(safeRedirectTarget("javascript:alert(1)", [APP, ""]), null);
  assert.equal(safeRedirectTarget("data:text/html,<script>alert(1)</script>", [APP]), null);
  assert.equal(safeRedirectTarget("file:///etc/passwd", [APP]), null);
});

test("host comparison is case- and unicode-normalised on both sides", () => {
  assert.equal(safeRedirectTarget(`https://${APP.toUpperCase()}/x`, [APP]), `https://${APP}/x`);
  assert.equal(safeRedirectTarget(`https://${APP}/x`, [APP.toUpperCase()]), `https://${APP}/x`);
  // Cyrillic "а" — a different host that renders identically to the ASCII one.
  assert.equal(normalizeHost("аpple.com"), "xn--pple-43d.com");
  assert.equal(safeRedirectTarget("https://аpple.com/x", ["apple.com"]), null);
  assert.equal(safeRedirectTarget("https://apple.com/x", ["аpple.com"]), null);
});

test("normalizeHost refuses values that are not hosts", () => {
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("   "), null);
  assert.equal(normalizeHost("EXAMPLE.com"), "example.com");
  assert.equal(normalizeHost("https://example.com/a/b?c=d"), "example.com");
  assert.equal(normalizeHost("example.com:8443"), "example.com");
});

test("vouched hosts come from the owning campaign's own stored body", () => {
  const body = [
    '<p>Hi {{first_name}}</p>',
    '<a href="https://shop.example/e-bikes">Shop</a>',
    '<a href="https://SUPPORT.example/help?ref={{name}}">Help</a>',
    "<a href=\"/relative/page\">Relative</a>",
    "<a href='https://single.example/x'>Single quoted</a>",
  ].join("");
  assert.deepEqual(campaignLinkHosts(body), ["shop.example", "support.example"]);
  assert.deepEqual(campaignLinkHosts(null), []);
  assert.deepEqual(campaignLinkHosts(""), []);
  // Only hosts the campaign actually linked to are honoured.
  assert.equal(
    safeRedirectTarget("https://shop.example/e-bikes", campaignLinkHosts(body)),
    "https://shop.example/e-bikes",
  );
  assert.equal(safeRedirectTarget("https://evil.example/x", campaignLinkHosts(body)), null);
});

test("the operator allowlist is empty unless configured", () => {
  const previous = process.env.CAMPAIGN_LINK_HOSTS;
  try {
    delete process.env.CAMPAIGN_LINK_HOSTS;
    assert.deepEqual(configuredRedirectHosts(), []);
    process.env.CAMPAIGN_LINK_HOSTS = " shop.example , , partner.example ";
    assert.deepEqual(configuredRedirectHosts(), ["shop.example", "partner.example"]);
  } finally {
    if (previous === undefined) delete process.env.CAMPAIGN_LINK_HOSTS;
    else process.env.CAMPAIGN_LINK_HOSTS = previous;
  }
});

test("the click route never seeds its redirect from the query string", () => {
  // The vulnerable line was:
  //   let redirectUrl = /^https?:\/\//i.test(target) ? target : appBaseUrl();
  // an anchored prefix test on the RAW string that says nothing about the host,
  // applied before any token lookup. The route cannot be exercised in a unit
  // test (server-only prisma + next/server imports), so this is asserted on the
  // source, as the other security tests in this directory do.
  assert.doesNotMatch(clickRoute, /let\s+redirectUrl\s*=\s*\/\^https\?/);
  assert.doesNotMatch(clickRoute, /redirectUrl\s*=\s*target\b/);
  assert.match(clickRoute, /let\s+redirectUrl\s*=\s*appBaseUrl\(\);/);
  assert.match(clickRoute, /safeRedirectTarget\(\s*target,/);
});

test("the click route resolves its destination only after the token validates", () => {
  const recipientGuard = clickRoute.indexOf("if (!recipient) return;");
  const campaignGuard = clickRoute.indexOf("if (!campaign) return;");
  const destination = clickRoute.indexOf("safeRedirectTarget(");
  const redirect = clickRoute.indexOf("NextResponse.redirect(");
  assert.ok(recipientGuard > 0, "route must still bail on an unknown token");
  assert.ok(
    destination > recipientGuard && destination > campaignGuard,
    "destination must be resolved after the recipient and campaign are found",
  );
  assert.ok(redirect > destination, "the redirect must come after the destination check");
  // No vouched destination means no redirect and no click recorded.
  assert.match(clickRoute, /if\s*\(!destination\)\s*return;/);
});

test("the link rewriter and the allowlist share one pattern", () => {
  // Otherwise the two drift and a link the rewriter turned into a tracking URL
  // is no longer recoverable from the stored body — or worse, the reverse.
  assert.match(campaignsLib, /trackedLinkPattern\(\)/);
  assert.doesNotMatch(campaignsLib, /replace\(\s*\/href="/);
});
