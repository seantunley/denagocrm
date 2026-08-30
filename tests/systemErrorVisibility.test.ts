import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const runbook = () => src("src/lib/securityRunbook.ts");
const systemLog = () => src("src/app/(app)/settings/page.tsx");
const consoleErrors = () => src("src/app/platform/(console)/errors/page.tsx");
const consoleLayout = () => src("src/app/platform/(console)/layout.tsx");

/*
 * "27 error(s) in the last 7 days. Fix: Review Settings → System Log." — and the
 * System Log was empty.
 *
 * Both halves were behaving as designed. The runbook is an install-wide operator
 * report and counts every error; the System Log filters on the acting tenant and
 * deliberately excludes unattributed ones, because a tenant cannot be told whose
 * an ownerless error is. Every one of those 27 had `tenantId: null`, so the
 * sentence joining the two was simply false — and the errors themselves appeared
 * on no screen in the product at all.
 */

test("THE COUNT IS SPLIT BY WHETHER AN ERROR HAS AN OWNER", () => {
  const body = runbook();
  assert.match(body, /basePrisma\.errorLog\.count\(\{ where: \{ createdAt: \{ gte: errorsSince \} \} \}\)/,
    "the install-wide total stays install-wide");
  assert.match(body, /tenantId: null/, "and is split by attribution");
  assert.match(body, /const workspaceErrors = weekErrors - unattributedErrors;/);
});

test("the advice names a screen that can actually show them", () => {
  const body = runbook();
  // Nothing attributable: saying "Review Settings → System Log" here is the bug.
  assert.match(body, /none belong to a workspace, so Settings → System Log will be empty/);
  assert.match(body, /Platform Console → System errors/);
  // Some of each: both destinations, so neither half is lost. The count is
  // install-wide, so it must never imply every attributed row belongs to the
  // workspace of whichever administrator happens to read the stored run.
  assert.match(body, /Attributed errors are available in each owning workspace's Settings → System Log; system-level errors are in Platform Console → System errors/);
  assert.doesNotMatch(body, /this workspace's errors/);
  // All attributable: name where those rows actually live without pretending
  // the install-wide count belongs to one current workspace.
  assert.match(body, /Attributed errors are available in each owning workspace's Settings → System Log\./);
});

test("the split does not depend on WHO ran the check", () => {
  /*
   * The runbook also runs from cron, and the security page renders the stored
   * run afterwards. Splitting on the ACTING tenant would have made the sentence
   * depend on which caller happened to produce it; splitting on attribution is a
   * property of the rows.
   */
  const body = runbook();
  const check = body.slice(body.indexOf("const errorsSince ="), body.indexOf("const passed ="));
  assert.doesNotMatch(check, /getActiveTenantId|actingTenantId|currentTenantScope/,
    "the stored answer must not vary with the session that triggered it");
});

test("UNATTRIBUTED ERRORS HAVE SOMEWHERE TO BE READ", () => {
  /*
   * They had nowhere. The System Log excludes them by design and its own comment
   * says they are "the platform console's job" — and the console only ever
   * listed errors per tenant, so a production install could hold weeks of
   * failures that no screen would display.
   */
  const page = consoleErrors();
  assert.match(page, /await requirePlatformAdmin\(\);/, "platform-only, re-checked in the page itself");
  assert.match(page, /where: \{ tenantId: null, createdAt: \{ gte: since \} \}/,
    "it must show exactly the errors the System Log cannot");
  assert.match(consoleLayout(), /href="\/platform\/errors"/, "and be reachable from the console nav");
});

test("the console page counts in the database, not from the capped list", () => {
  // Same rule the tenant profile states: a total derived from a truncated list
  // silently under-reports during exactly the storm worth knowing about.
  const page = consoleErrors();
  assert.match(page, /take: MAX_ROWS/);
  assert.match(page, /basePrisma\.errorLog\.count\(\{ where: \{ tenantId: null/);
  assert.match(page, /Showing the most recent \{MAX_ROWS\} of \{total\}/);
});

test("the System Log keeps excluding what it cannot attribute", () => {
  // The fix must not have been "show tenants everyone's errors".
  const page = systemLog();
  assert.match(page, /where: \{ tenantId: logTenantId \}/);
  assert.match(page, /Errors with no tenant/, "the reasoning stays stated where the filter is");
});


test("a capped display does not call its distinct-problem count exact", () => {
  const page = consoleErrors();
  assert.match(page, /Distinct problems\{total > MAX_ROWS \? " · displayed rows" : ""\}/);
  assert.match(page, /the distinct-problem count covers only these displayed rows/);
});
