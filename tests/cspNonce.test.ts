import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildCsp, buildCspReportOnly } from "../src/lib/csp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const prod = buildCsp({ nonce: "TESTNONCE", dev: false });
const dev = buildCsp({ nonce: "TESTNONCE", dev: true });
const reportOnly = buildCspReportOnly({ nonce: "TESTNONCE", dev: false });

test("production script-src is nonce-gated with no inline escape hatch", () => {
  // The whole point of the nonce: without this, an injected <script> runs.
  assert.match(prod, /script-src [^;]*'nonce-TESTNONCE'/);
  assert.doesNotMatch(
    prod.match(/script-src [^;]*/)![0],
    /'unsafe-inline'/,
    "'unsafe-inline' in script-src would let any injected script run — the nonce becomes decoration",
  );
  assert.doesNotMatch(
    prod.match(/script-src [^;]*/)![0],
    /'unsafe-eval'/,
    "'unsafe-eval' belongs in development only",
  );
});

test("strict-dynamic is present, because Next loads its chunks from a nonced script", () => {
  // Without it the app boots and then dies as the runtime pulls in chunks.
  assert.match(prod, /script-src [^;]*'strict-dynamic'/);
});

test("development keeps unsafe-eval, production does not", () => {
  // React uses eval in dev to reconstruct server error stacks.
  assert.match(dev.match(/script-src [^;]*/)![0], /'unsafe-eval'/);
  assert.doesNotMatch(prod.match(/script-src [^;]*/)![0], /'unsafe-eval'/);
});

test("style-src stays permissive, deliberately", () => {
  // ~205 React style={{…}} props across 41 files. CSP governs those through
  // style-src-attr, which a nonce cannot cover at all — the strict alternative
  // is not "add a nonce", it is "rewrite 41 files". Documented, not forgotten.
  assert.match(prod, /style-src 'self' 'unsafe-inline'/);
  assert.match(src("src/lib/csp.ts"), /Stays permissive, deliberately/, "and the reason is written down");
});

test("a fresh nonce reaches the policy every time", () => {
  const a = buildCsp({ nonce: "AAA", dev: false });
  const b = buildCsp({ nonce: "BBB", dev: false });
  assert.notEqual(a, b, "the nonce must be interpolated, not baked in");
  assert.match(a, /'nonce-AAA'/);
  assert.match(b, /'nonce-BBB'/);
});

test("the structural directives are enforced", () => {
  for (const directive of [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ]) {
    assert.ok(prod.includes(directive), `the nonce rollout must not drop ${directive}`);
  }
});

test("worker-src is explicit, or strict-dynamic kills the service worker", () => {
  // CSP3 resolves worker-src through child-src → script-src. Falling back to a
  // strict-dynamic script-src would block /sw.js, and no nonce can reach a
  // worker script. This is the kind of thing that only breaks the installed PWA.
  assert.match(prod, /worker-src 'self'/);
});

test("resource directives are REPORT-ONLY, not enforced", () => {
  // They were briefly enforced and that was wrong: this app talks to Open-Meteo,
  // the Google Maps JS API and Vercel Blob straight from the browser, so
  // `connect-src 'self'` would have broken the weather widget, address
  // autocomplete and library uploads in production.
  for (const directive of ["default-src", "connect-src", "img-src", "font-src"]) {
    assert.ok(!prod.includes(directive), `${directive} must not be enforced until it has been exercised`);
    assert.ok(reportOnly.includes(directive), `${directive} belongs in the report-only policy`);
  }
});

test("the report-only policy allows every origin the browser actually reaches", () => {
  // Inventoried from source, not assumed. Each of these is a real client-side
  // dependency; server-side fetches are not subject to CSP and are absent on
  // purpose.
  const required: [string, string][] = [
    ["https://api.open-meteo.com", "ClockWeather / TestDriveWeather"],
    ["https://maps.googleapis.com", "LocationAutocomplete loads the Places SDK"],
    ["https://*.vercel-storage.com", "LibraryUploader uploads direct to Blob"],
    ["https://fonts.gstatic.com", "fonts pulled in by the Maps SDK"],
  ];
  for (const [origin, why] of required) {
    assert.ok(reportOnly.includes(origin), `${origin} must be allowed — ${why}`);
  }
  // Still restrictive where it counts.
  assert.match(reportOnly, /connect-src 'self'/);
  assert.match(reportOnly, /img-src 'self' data: blob:/);
});

test("the proxy sets the nonce on the REQUEST as well as the response", () => {
  // Next extracts the nonce from the request's Content-Security-Policy header
  // during SSR and stamps it onto its own scripts. Response-only means the
  // scripts go out un-nonced and the page blocks itself.
  const code = src("src/proxy.ts");
  assert.match(code, /requestHeaders\.set\("Content-Security-Policy", csp\.value\)/);
  assert.match(code, /requestHeaders\.set\("x-nonce", csp\.nonce\)/);
  assert.match(code, /res\.headers\.set\("Content-Security-Policy", csp\.value\)/);
});

test("public pages get a nonce too", () => {
  // The signing and portal pages are the ones most worth protecting, and they
  // return before the auth check. Returning a bare NextResponse.next() there
  // would leave them with no CSP at all.
  const code = src("src/proxy.ts");
  const publicBranch = code.slice(code.indexOf("PUBLIC_PATHS.some("), code.indexOf("const token ="));
  assert.match(publicBranch, /return allow\(req, csp\)/, "public paths must go through the CSP-applying path");
  assert.doesNotMatch(publicBranch, /return NextResponse\.next\(\);/, "a bare next() would ship no policy");
});

test("the root layout forces dynamic rendering — nonces need it", () => {
  // Load-bearing and easy to delete by accident. A prerendered page's HTML is
  // built before any request exists, so its scripts carry no nonce and
  // strict-dynamic blocks them: the page renders and never hydrates.
  //
  // Without this the build prerendered /login and /platform/login — the CSP
  // would have shipped looking correct and stopped anyone signing in. It fails
  // ONLY in a production build, which is why it gets a test rather than trust.
  const layout = src("src/app/layout.tsx");
  assert.match(layout, /export const dynamic = "force-dynamic"/, "removing this breaks login under CSP");
  assert.match(layout, /Nonce-based CSP requires dynamic rendering/, "and the reason is written down");
});

/**
 * Source with comments stripped and whitespace collapsed.
 *
 * Both, for reasons I hit writing these: matching the whole file made the tests
 * below fail on the very comments justifying them, and JSX wraps prose across
 * lines, so `/may have completed/` misses "may have\n    completed".
 */
const shippedText = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

test("the global error page needs no JavaScript", () => {
  // Its scripts are ALWAYS un-nonced: global-error replaces the root layout, so
  // it cannot inherit force-dynamic and the build prerenders it. Anything
  // interactive here is a control that silently does nothing.
  const page = shippedText("src/app/global-error.tsx");
  assert.doesNotMatch(page, /onClick|useState|useEffect/, "no handler will ever fire on this page");
  assert.doesNotMatch(page, /\breset\b/, "a reset() button would be a button that never responds");
  assert.match(page, /href="\/"/, "recovery has to be a plain link");
});

test("the global error page does not promise the write was rolled back", () => {
  // It cannot know. This boundary runs AFTER rendering failed, and a server
  // action may have committed before that — a quote, an upload, a status
  // change. "Your data is safe" invites exactly the retry that duplicates it.
  const page = shippedText("src/app/global-error.tsx");
  assert.doesNotMatch(
    page,
    /data is safe|nothing was saved|no changes were made|was not saved/i,
    "the error boundary has no way to know whether the mutation committed",
  );
  assert.match(page, /may have completed/, "say what is actually true, and tell them to check");
});

test("only one place sets Content-Security-Policy", () => {
  // Two enforced policies intersect: the static one has no nonce, so it would
  // block every script the proxy just authorised.
  const config = src("next.config.ts");
  assert.doesNotMatch(
    config,
    /key: "Content-Security-Policy"/,
    "next.config.ts must not also set a CSP — the proxy owns it",
  );
  assert.match(config, /Content-Security-Policy is NOT set here/, "and says why");
  // The other security headers stay where they were.
  for (const header of ["X-Frame-Options", "Strict-Transport-Security", "Cross-Origin-Opener-Policy"]) {
    assert.ok(config.includes(header), `${header} should remain in next.config.ts`);
  }
});

test("the report-only policy omits directives browsers ignore there", async () => {
  // CSP3 §3.1: upgrade-insecure-requests, frame-ancestors and sandbox describe
  // how to CHANGE a request, and report-only changes nothing — so a browser
  // drops them and warns. Chromium said exactly that on every page load:
  //   "The Content Security Policy directive 'upgrade-insecure-requests' is
  //    ignored when delivered in a report-only policy."
  // A console that cries wolf on every load is a console nobody reads, and this
  // policy exists so its reports GET read.
  const { buildCsp, buildCspReportOnly } = await import("../src/lib/csp");
  const opts = { nonce: "test-nonce", dev: false };
  const reportOnly = buildCspReportOnly(opts);
  const enforced = buildCsp(opts);

  for (const directive of ["upgrade-insecure-requests", "frame-ancestors", "sandbox"]) {
    assert.ok(
      !new RegExp(`(^|;\s*)${directive}\b`).test(reportOnly),
      `${directive} is ignored in a report-only policy — it only produces a console warning`,
    );
  }
  // …and they must still be doing their job where they are honoured.
  assert.match(enforced, /(^|;\s*)upgrade-insecure-requests\b/);
  assert.match(enforced, /(^|;\s*)frame-ancestors\b/);
  // the report-only policy still carries what it exists for: the resource rules
  assert.match(reportOnly, /(^|;\s*)connect-src\b/, "the resource directives are the point of it");
});
