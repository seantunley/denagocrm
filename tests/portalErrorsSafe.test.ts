import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// The customer portal must never show a customer an unexpected error's text —
// a Postgres error names tables and columns. Deliberate refusals show; anything
// else is logged with a reference and the customer gets a plain fallback.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const live = src("src/app/actions/portalExpansion.ts");

test("no portal catch block hands error.message to the customer", () => {
  assert.doesNotMatch(live, /error instanceof Error \? error\.message/);
  const catches = live.match(/\} catch \(error\) \{\n\s+return portalFailure\(error, "[^"]+"\);/g) ?? [];
  assert.equal(catches.length, 5, "every portal action's catch goes through portalFailure");
});

test("portalFailure shows refusals, logs the rest with a reference", () => {
  const fn = live.slice(live.indexOf("async function portalFailure("), live.indexOf("export async function submitProfileChange("));
  assert.match(fn, /classifyFailure\(error, failureReference\(\)\)/);
  assert.match(fn, /if \(failure\.kind !== "unexpected"\) return \{ error: failure\.message \};/);
  assert.match(fn, /logError\("portal-action", error, failure\.logLine/);
});

test("the dead duplicates in portal.ts stay deleted", () => {
  const old = src("src/app/actions/portal.ts");
  for (const name of ["submitPortalCase", "submitPortalWarrantyClaim", "requestPortalProfileChange", "updatePortalPreferences", "uploadPortalDocument"]) {
    assert.doesNotMatch(old, new RegExp(`export async function ${name}\\(`), name);
  }
  assert.doesNotMatch(old, /throw new Error\(/);
});
