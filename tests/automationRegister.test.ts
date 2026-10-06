import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATIONS, automationDefault } from "../src/lib/automationRegister";

/*
 * NOTHING RUNS HIDDEN (2026-10-06). A customer got an automatic WhatsApp
 * signing reminder that no screen anywhere mentioned. Every background job and
 * every automatic message to a customer must be on Settings → Automatic jobs &
 * messages (src/lib/automationRegister.ts) — this fails the build otherwise.
 */
const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("every cron route that runs is on the page", () => {
  const crons = [...read("vercel.json").matchAll(/"path":\s*"(\/api\/cron\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(crons.length >= 10, "read the cron list");
  const registered = new Set(AUTOMATIONS.map((a) => a.cron).filter(Boolean));
  const missing = crons.filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `cron routes not on Settings → Automatic jobs & messages: ${missing.join(", ")}`);
  // …and every cron route file on disk is scheduled (no unscheduled job hiding in the tree).
  const onDisk = readdirSync("src/app/api/cron").filter((d) => statSync(join("src/app/api/cron", d)).isDirectory()).map((d) => `/api/cron/${d}`);
  assert.deepEqual(onDisk.filter((c) => !crons.includes(c)), [], "a cron route exists that vercel.json doesn't schedule — register or remove it");
});

test("every phase of the automations cron, and everything it runs directly, is on the page", () => {
  const route = code("src/app/api/cron/automations/route.ts");
  const phases = [...route.matchAll(/phase\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(phases.length >= 10, "read the phases");
  const registeredPhases = new Set(AUTOMATIONS.flatMap((a) => a.phases ?? []));
  assert.deepEqual(phases.filter((p) => !registeredPhases.has(p)), [], "phases not on the page");
  // `await runSomething(` outside phase(): the route's own helpers excluded.
  const direct = [...route.matchAll(/await (run[A-Z]\w*)\(/g)].map((m) => m[1]).filter((f) => !["runCronPerTenant", "runOperationalQueues"].includes(f));
  const registeredJobs = new Set(AUTOMATIONS.flatMap((a) => a.jobs ?? []));
  assert.deepEqual([...new Set(direct)].filter((f) => !registeredJobs.has(f)), [], "work the cron runs directly that isn't on the page");
});

test("anything that can reach a customer has a switch — off by default — or names where it is switched on", () => {
  for (const a of AUTOMATIONS.filter((x) => x.reaches === "customer")) {
    assert.ok(a.setting || a.managedAt, `${a.key}: no switch and no screen where it's switched on`);
  }
  // Only the owner's explicit decision may default ON (signed copies: 2026-10-06, Sean chose "keep it on").
  const defaultOn = AUTOMATIONS.filter((a) => a.reaches === "customer" && a.setting?.defaultOn).map((a) => a.setting!.key);
  assert.deepEqual(defaultOn, ["SIGNING_SIGNED_COPIES"]);
  assert.equal(automationDefault("REVIEW_REQUESTS_AUTO"), false);
  assert.equal(automationDefault("NOT_A_SWITCH"), false, "an unknown switch is off");
});

test("every switch on the page is actually obeyed by the code it names — none is decorative", () => {
  const where: Record<string, string[]> = {
    SIGNING_AUTO_REMINDERS: ["src/lib/signingReminders.ts", "src/lib/signing/dispatch.ts"],
    SIGNING_SIGNED_COPIES: ["src/lib/signing/complete.ts", "src/lib/signing/recoverCompletions.ts", "src/lib/signing/jobWorker.ts"],
    REVIEW_REQUESTS_AUTO: ["src/lib/reviewRequests.ts"],
    SURVEY_AUTO_REMINDERS: ["src/lib/governedSurveyRuntime.ts"],
    SERVICE_REMINDER_ENABLED: ["src/lib/serviceReminders.ts"],
  };
  const keys = AUTOMATIONS.flatMap((a) => (a.setting ? [a.setting.key] : []));
  assert.deepEqual(keys.filter((k) => !where[k]).sort(), [], "a switch with no known gate — add it here and gate the code");
  for (const [key, files] of Object.entries(where)) for (const f of files) assert.ok(code(f).includes(key), `${key} is not checked in ${f}`);
  // The gates themselves.
  assert.match(code("src/lib/reviewRequests.ts"), /if \(!\(await automationOn\("REVIEW_REQUESTS_AUTO"\)\)\) return false;/);
  assert.match(code("src/lib/governedSurveyRuntime.ts"), /maxReminders: \(await automationOn\("SURVEY_AUTO_REMINDERS", tenantId\)\) \? 1 : 0,/);
  assert.match(code("src/lib/signing/dispatch.ts"), /else if \(next && !next\.viewedAt && \(await automationOn\(SIGNING_AUTO_REMINDERS_KEY, req\.tenantId\)\)\)/, "the re-nudge is a reminder too");
  assert.match(code("src/lib/signing/jobWorker.ts"), /if \(!\(await automationOn\("SIGNING_SIGNED_COPIES", job\.tenantId\)\)\) return;/);
  assert.equal((code("src/lib/signing/complete.ts").match(/automationOn\("SIGNING_SIGNED_COPIES", req\.tenantId\)\)\s*\?\s*await deliverCompletionEmails/g) ?? []).length, 1);
  // The manual "resend signed copies" button is a person's click — not gated.
  assert.doesNotMatch(code("src/app/actions/signhub.ts"), /automationOn/);
});

test("an unset or unreadable switch never messages a customer on a guess", () => {
  const sw = code("src/lib/automationSwitch.ts");
  assert.match(sw, /if \(raw === "true"\) return true;\s*if \(raw === "false"\) return false;\s*return fallback;/);
  assert.match(sw, /catch \(error\) \{\s*if \(fallback\) throw error;\s*return false;\s*\}/);
});

test("the page is in Settings for the owner, switches are owner-only, audited, and only for listed keys", () => {
  assert.match(read("src/lib/settings-navigation.ts"), /key: "automatic", label: "Automatic jobs & messages", href: "\/settings\/automatic"/);
  const page = code("src/app/(app)/settings/automatic/page.tsx");
  assert.match(page, /await requireTenantOwner\(\);/);
  assert.match(page, /AUTOMATIONS\.filter\(\(a\) => a\.reaches === group\.reach\)/, "every entry is listed");
  const action = code("src/app/actions/automationSettings.ts");
  const save = action.slice(action.indexOf("export async function saveAutomationSwitch"));
  assert.match(save, /const user = await requireTenantOwner\(\);/);
  assert.match(save, /const automation = AUTOMATIONS\.find\(\(a\) => a\.setting\?\.key === key\);\s*if \(!automation\?\.setting\) return \{ error:/);
  assert.match(save, /action: "automation\.switched"/);
});

test("forms never pre-tick a customer message", () => {
  assert.match(read("src/components/VehicleForm.tsx"), /name="newDelivery"[^>]*defaultChecked=\{false\}/);
  assert.match(read("src/app/(app)/marketing/surveys/distributions/page.tsx"), /name="maxReminders" min="0" max="3" defaultValue="0"/);
  assert.match(read("src/app/(app)/jobcards/[id]/page.tsx"), /Completing also sends the customer whatever is switched on for completed job cards/);
});
