import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renewalDue, REFRESH_WITHIN_MS, RETRY_MS } from "../src/lib/threadsRenewalRule";
import { AUTOMATIONS } from "../src/lib/automationRegister";

/** Threads connections renew themselves before their 60 days run out (review of #1181). */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-21T12:00:00Z");

test("renewal is due only in the last 7 days, and retried at most every 6 hours", () => {
  assert.equal(renewalDue(now + 30 * DAY, 0, now), "fresh");
  assert.equal(renewalDue(now + REFRESH_WITHIN_MS, 0, now), "fresh", "exactly 7 days out: not yet");
  assert.equal(renewalDue(now + 6 * DAY, 0, now), "due");
  assert.equal(renewalDue(now + 6 * DAY, now - RETRY_MS + 1000, now), "waiting", "tried under 6 hours ago");
  assert.equal(renewalDue(now + 6 * DAY, now - RETRY_MS, now), "due");
  assert.equal(renewalDue(now - DAY, 0, now), "due", "already expired: still tried (and the owner told)");
  assert.equal(renewalDue(Number.NaN, 0, now), "fresh", "no expiry recorded: left alone");
});

test("a failed renewal tells the OWNER once per expiry date; nothing reaches a customer", () => {
  const lib = code("src/lib/threadsRenewal.ts");
  assert.match(lib, /await putWorkspaceSetting\(owner, RENEW_TRIED_KEY, String\(now\)\);\s*await threadsToken\(owner\);/);
  assert.match(lib, /if \(after > expiresAt\) return "renewed";/);
  assert.match(lib, /if \(\(await getWorkspaceSetting\(owner, EXPIRY_WARNED_KEY\)\) !== String\(expiresAt\)\) \{\s*await putWorkspaceSetting\(owner, EXPIRY_WARNED_KEY, String\(expiresAt\)\);/);
  assert.match(lib, /const ownerUser = await resolveTenantActor\(\{ ownerOnly: true \}\);/);
  assert.match(lib, /\{ tenantId: owner, userId: ownerUser\.id \}/, "the owner only, never the whole workspace");
});

test("it runs on the automations cron and is listed on Automatic jobs & messages", () => {
  assert.match(code("src/app/api/cron/automations/route.ts"), /await phase\("threads-token-renewal", \(\) => renewThreadsToken\(\), null\)/);
  const entry = AUTOMATIONS.find((a) => a.key === "threads-token-renewal");
  assert.ok(entry);
  assert.equal(entry!.reaches, "staff");
  assert.deepEqual(entry!.phases, ["threads-token-renewal"]);
});
