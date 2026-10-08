import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const portalSource = readFileSync("src/app/portal/page.tsx", "utf8");
const cronSource = readFileSync("src/app/api/cron/automations/route.ts", "utf8");
const reminderSource = readFileSync("src/lib/signingReminders.ts", "utf8");

test("portal signing links are limited to the authenticated contact email", () => {
  // The property this test protects is unchanged; the implementation it pinned
  // was itself the hole. `equals` + `mode: "insensitive"` compiles to an
  // unescaped ILIKE, so `_`/`%` in the viewer's own stored address matched a
  // DIFFERENT signer on the same quote and handed over their signing token —
  // and plenty of real addresses contain an underscore. The match is now exact
  // and case-folded in JS, which is strictly narrower than what this asserted.
  assert.doesNotMatch(
    portalSource,
    /email:\s*\{\s*equals:\s*contactEmail,\s*mode:\s*"insensitive"\s*\}/,
    "a LIKE match on a signing recipient can hand out someone else's token",
  );
  assert.match(
    portalSource,
    /r\.email\?\.toLowerCase\(\)\s*===\s*viewerEmail/,
    "the signer must be matched exactly",
  );
  assert.doesNotMatch(
    portalSource,
    /find\([\s\S]*?contactEmail[\s\S]*?\?\?\s*request\.recipients\[0\]/,
  );
});

test("the automation cron no longer sends signing reminders — the journey does", () => {
  // One engine for automatic customer messages (2026-10-06): the reminder is the
  // ready-made "Signing reminder" journey, off unless the owner switches it on.
  const cronCode = cronSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(cronCode, /signature-request-reminders|runSignatureRequestReminders|signingReminders/);
  assert.doesNotMatch(reminderSource, /export async function runSignatureRequestReminders|getSetting\(/, "no second, switch-gated sender");
  // The Signing security page shows the journey's state instead of its own switch.
  const page = readFileSync("src/app/(app)/settings/signing-security/page.tsx", "utf8");
  assert.doesNotMatch(page, /SigningRemindersForm/);
  assert.match(page, /readyMade\.rows\.find\(\(row\) => row\.key === "signing-reminders"\)/);
  assert.match(page, /href="\/journeys"/);
});

test("reminders use recipient delivery age and the live dispatch path, once per signer", () => {
  assert.match(reminderSource, /signatureEvent\.groupBy/);
  assert.match(reminderSource, /type:\s*\{\s*in:\s*\["sent",\s*"delivered"\]\s*\}/);
  assert.match(reminderSource, /notifyRecipient\(recipientId,\s*\{\s*reminder:\s*true\s*\}\)/);
  assert.match(reminderSource, /remindedAt:\s*null/);
  assert.doesNotMatch(reminderSource, /signToken|\/sign\/quote/);
  // Every query names the tenant: the sweep runs per workspace from the journeys cron.
  const sweep = reminderSource.slice(reminderSource.indexOf("export async function signersAwaitingReminder"), reminderSource.indexOf("export async function remindSigner"));
  for (const model of ["signatureRecipient", "signatureEvent", "signatureRequest", "quote", "jobCard"]) {
    const at = sweep.indexOf(`prisma.${model}.`);
    assert.ok(at !== -1, `${model} read`);
    assert.match(sweep.slice(at, at + 160), /tenantId/, `${model} read names the tenant`);
  }
});
