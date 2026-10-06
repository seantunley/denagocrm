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

test("automation cron runs SignatureRequest reminders", () => {
  // Invoked through the budget-aware phase() helper rather than called inline,
  // so this now asserts BOTH that the cron runs it and that it is subject to the
  // route deadline like every other side-effecting queue.
  assert.match(
    cronSource,
    /phase\(\s*"signature-request-reminders",\s*runSignatureRequestReminders/,
  );
});

test("automatic signing reminders are OFF unless the owner switches them on", () => {
  // A reminder is a message to a customer nobody pressed Send on; it went out to
  // every signer by default, with no setting anywhere in the app.
  assert.match(reminderSource, /export const SIGNING_AUTO_REMINDERS_KEY = "SIGNING_AUTO_REMINDERS";/);
  assert.match(reminderSource, /return \(await getSetting\(SIGNING_AUTO_REMINDERS_KEY\)\.catch\(\(\) => null\)\) === "true";/, "unset or unreadable = off");
  const run = reminderSource.slice(reminderSource.indexOf("export async function runSignatureRequestReminders"));
  assert.match(run, /^export async function runSignatureRequestReminders\(\): Promise<number> \{\s*if \(!\(await signingAutoRemindersOn\(\)\)\) return 0;/, "checked before anything is read or sent");
  const action = readFileSync("src/app/actions/signingSecuritySettings.ts", "utf8");
  const save = action.slice(action.indexOf("export async function saveSigningAutoReminders"));
  assert.match(save, /const user = await requireTenantOwner\(\);/);
  assert.match(save, /action: "signing\.auto_reminders_changed"/);
  assert.match(readFileSync("src/app/(app)/settings/signing-security/page.tsx", "utf8"), /<SigningRemindersForm initial=\{autoReminders\} \/>/);
});

test("scheduled reminders use recipient delivery age and the live dispatch path", () => {
  assert.match(reminderSource, /signatureEvent\.groupBy/);
  assert.match(reminderSource, /type:\s*\{\s*in:\s*\["sent",\s*"delivered"\]\s*\}/);
  assert.match(reminderSource, /notifyRecipient\(recipient\.id,\s*\{\s*reminder:\s*true\s*\}\)/);
  assert.match(reminderSource, /remindedAt:\s*null/);
  assert.doesNotMatch(reminderSource, /signToken|\/sign\/quote/);
});
