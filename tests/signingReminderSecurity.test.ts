import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const portalSource = readFileSync("src/app/portal/page.tsx", "utf8");
const cronSource = readFileSync("src/app/api/cron/automations/route.ts", "utf8");
const reminderSource = readFileSync("src/lib/signingReminders.ts", "utf8");

test("portal signing links are limited to the authenticated contact email", () => {
  assert.match(
    portalSource,
    /email:\s*\{\s*equals:\s*contactEmail,\s*mode:\s*"insensitive"\s*\}/,
  );
  assert.doesNotMatch(
    portalSource,
    /find\([\s\S]*?contactEmail[\s\S]*?\?\?\s*request\.recipients\[0\]/,
  );
});

test("automation cron runs SignatureRequest reminders", () => {
  assert.match(
    cronSource,
    /runSignatureRequestReminders\(\)/,
  );
});

test("scheduled reminders use recipient delivery age and the live dispatch path", () => {
  assert.match(reminderSource, /signatureEvent\.groupBy/);
  assert.match(reminderSource, /type:\s*\{\s*in:\s*\["sent",\s*"delivered"\]\s*\}/);
  assert.match(reminderSource, /notifyRecipient\(recipient\.id,\s*\{\s*reminder:\s*true\s*\}\)/);
  assert.match(reminderSource, /remindedAt:\s*null/);
  assert.doesNotMatch(reminderSource, /signToken|\/sign\/quote/);
});
