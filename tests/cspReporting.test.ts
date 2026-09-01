import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCsp, buildCspReportOnly, CSP_REPORT_PATH } from "../src/lib/csp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const options = { nonce: "test-nonce", dev: false };

/**
 * An OWASP ZAP scan (2026-09-01) flagged the enforced CSP for omitting the
 * resource directives. It is right — they sit in a Report-Only policy that,
 * until now, reported to NOBODY. These pin the collection half.
 */

test("BOTH POLICIES SAY WHERE VIOLATIONS GO — report-only that reports nowhere is decoration", () => {
  /*
   * Without `report-uri`, a Report-Only policy writes a console line per
   * visitor and discards it. The question that policy exists to answer —
   * "would enforcing these directives break the site?" — then has no data, and
   * this app has already broken once by enforcing them on inventory alone.
   */
  for (const [name, policy] of [["enforced", buildCsp(options)], ["report-only", buildCspReportOnly(options)]] as const) {
    assert.match(policy, new RegExp(`report-uri ${CSP_REPORT_PATH}`), `${name} must name a report-uri`);
    assert.match(policy, /report-to csp-endpoint/, `${name} must name a report-to group`);
  }
});

test("the report-to group is declared by a Reporting-Endpoints header, or report-to is inert", () => {
  const proxy = src("src/proxy.ts");
  assert.match(proxy, /Reporting-Endpoints/, "the header must be set");
  assert.match(proxy, /csp-endpoint="\$\{CSP_REPORT_PATH\}"/, "the group name must match the directive");
});

test("THE COLLECTOR IS REACHABLE WITHOUT A SESSION — reports carry no credentials", () => {
  // A browser posts violations unauthenticated, and the ones worth seeing happen
  // on /login where there is no session at all. If the proxy gated this path,
  // the endpoint would exist and collect nothing.
  const proxy = src("src/proxy.ts");
  const publicPaths = proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("]", proxy.indexOf("const PUBLIC_PATHS")));
  assert.match(publicPaths, /"\/api\/csp-report"/, "the collector must be a public path");
});

test("a public write endpoint is bounded on every axis", () => {
  const route = src("src/app/api/csp-report/route.ts");
  // Read as text and size-checked BEFORE parsing — the parse is the thing a
  // hostile body would exploit.
  assert.match(route, /request\.text\(\)/);
  assert.match(route, /MAX_BODY_BYTES/);
  assert.ok(
    route.indexOf("MAX_BODY_BYTES") < route.indexOf("JSON.parse"),
    "the size cap must be applied before JSON.parse",
  );
  assert.match(route, /registerRateLimitAttempt/, "must be rate limited");
  assert.match(route, /getRequestIp/, "…keyed on the caller");
  assert.doesNotMatch(route, /export async function GET/, "POST only");
});

test("it never tells a reporter anything — always 204", () => {
  const route = src("src/app/api/csp-report/route.ts");
  const statuses = [...route.matchAll(/status:\s*(\d+)/g)].map((m) => m[1]);
  assert.ok(statuses.length > 0, "the route must return explicit statuses");
  assert.deepEqual([...new Set(statuses)], ["204"], "throttled, malformed and accepted must be indistinguishable");
});

test("X-POWERED-BY IS NOT ANNOUNCED", () => {
  // Free to remove, and it hands a scanner the framework's CVE list.
  assert.match(src("next.config.ts"), /poweredByHeader:\s*false/);
});
