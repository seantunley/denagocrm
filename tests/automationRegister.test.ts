import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATIONS, READY_MADE_JOURNEYS, automationDefault } from "../src/lib/automationRegister";

/*
 * NOTHING RUNS HIDDEN (2026-10-06). A customer got an automatic WhatsApp
 * signing reminder that no screen anywhere mentioned. Every background job and
 * every automatic message to a customer must be on Settings → Automatic jobs &
 * messages (src/lib/automationRegister.ts) — this fails the build otherwise.
 */
const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const rel = `${dir}/${entry}`;
    if (statSync(rel).isDirectory()) return walk(rel);
    return /\.tsx?$/.test(entry) ? [rel] : [];
  });
/** Every shipped source file. */
const SOURCES = walk("src");

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

/*
 * ONE ENGINE FOR AUTOMATIC CUSTOMER MESSAGES (2026-10-06, Sean: "one engine for
 * customer messages, which is journeys"). Review requests, service-due, signing
 * and survey reminders were hard-coded senders with their own switches; they are
 * ready-made journeys now. The build fails if one of them grows a second sender,
 * if a customer message outside journeys isn't a documented exception, or if a
 * ready-made journey could start ON without the owner's prior switch.
 */

/** Customer messages that are NOT journeys, and why — each is part of something a person did. */
const NOT_JOURNEYS = ["signed-copies", "signing-next-signer", "surveys", "campaigns", "chatbot", "inbound-email"];

test("every customer message is a journey, or a documented exception that says why", () => {
  const customer = AUTOMATIONS.filter((a) => a.reaches === "customer");
  assert.ok(customer.some((a) => a.key === "journeys" && a.cron === "/api/cron/journeys"), "the journeys engine is on the page");
  const outside = customer.filter((a) => a.key !== "journeys");
  assert.deepEqual(outside.map((a) => a.key).sort(), [...NOT_JOURNEYS].sort(), "a new customer message outside journeys — make it a journey, or justify it here");
  for (const a of outside) assert.ok(a.notJourney && a.notJourney.length > 20, `${a.key}: says why it isn't a journey`);
  // The four that moved are not on the register as senders any more.
  for (const gone of ["review-requests", "survey-auto-reminders", "service-reminders", "signing-reminders"]) {
    assert.ok(!AUTOMATIONS.some((a) => a.key === gone), `${gone} is a journey now, not a built-in`);
  }
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

test("the ready-made journeys: each replaces one built-in, with steps and triggers the engine knows", async () => {
  const { JOURNEY_STEP_TYPES, JOURNEY_TRIGGERS } = await import("../src/lib/journeyTypes");
  const { parseJourneyTriggers } = await import("../src/lib/journeyTriggers");
  const { SIGNING_EMAILS } = await import("../src/lib/signing/emailTemplates");
  assert.deepEqual(
    READY_MADE_JOURNEYS.map((j) => [j.key, j.priorSwitch]),
    [
      ["review-requests", "REVIEW_REQUESTS_AUTO"],
      ["service-reminders", "SERVICE_REMINDER_ENABLED"],
      ["signing-reminders", "SIGNING_AUTO_REMINDERS"],
      ["survey-reminders", "SURVEY_AUTO_REMINDERS"],
    ],
  );
  for (const j of READY_MADE_JOURNEYS) {
    parseJourneyTriggers(j.triggers); // the strict parser the builder's save uses
    for (const t of j.triggers) assert.ok((JOURNEY_TRIGGERS as readonly string[]).includes(t.type), `${j.key}: ${t.type}`);
    for (const s of j.steps) assert.ok((JOURNEY_STEP_TYPES as readonly string[]).includes(s.type), `${j.key}: ${s.type}`);
    for (const kind of j.messages) assert.ok(kind in SIGNING_EMAILS, `${j.key}: "${kind}" is an editable template`);
  }
});

test("a ready-made journey starts OFF — ON only where the old switch was explicitly on", () => {
  const seed = code("src/lib/readyMadeJourneys.ts");
  assert.match(seed, /status: on \? "active" : "paused",/);
  assert.match(seed, /const on = await priorApproval\(tx, tenantId, def\);/);
  assert.match(seed, /if \(\(await value\(def\.priorSwitch\)\) !== "true"\) return false;/, "unset, \"false\" or anything else is off");
  // Once per workspace, under a lock, marked by a unique AppSetting.
  assert.match(seed, /pg_advisory_xact_lock/);
  assert.match(seed, /if \(marker\) continue;/);
  assert.match(seed, /action: "journey\.ready_made_created"/);
});

test("the old switches gate nothing any more — only the seeding reads them, as a prior approval", () => {
  const old = ["REVIEW_REQUESTS_AUTO", "SURVEY_AUTO_REMINDERS", "SERVICE_REMINDER_ENABLED", "SIGNING_AUTO_REMINDERS"];
  const offenders = SOURCES.filter((rel) => old.some((key) => code(rel).includes(key)));
  assert.deepEqual(
    offenders.sort(),
    ["src/lib/automationRegister.ts", "src/lib/readyMadeJourneys.ts"],
    "a built-in switch is being read outside the register and the seeding",
  );
  // The register gives them to the seeding as `priorSwitch` and to nothing else.
  for (const key of old) assert.ok(!AUTOMATIONS.some((a) => a.setting?.key === key), `${key} is no longer a switch on the page`);
  assert.match(code("src/lib/readyMadeJourneys.ts"), /def\.priorSwitch/);
});

test("each moved message has ONE sender, reached only from a journey step", () => {
  const senders: Record<string, string> = {
    sendReviewRequest: "src/lib/reviewRequests.ts",
    sendServiceDueReminder: "src/lib/serviceReminders.ts",
    remindSigner: "src/lib/signingReminders.ts",
    sendSurveyReminder: "src/lib/surveyDistributionQueue.ts",
  };
  for (const [fn, home] of Object.entries(senders)) {
    const callers = SOURCES.filter((rel) => rel !== home && new RegExp(`\\b${fn}\\b`).test(code(rel)));
    assert.deepEqual(callers, ["src/lib/journeyStepExecutor.ts"], `${fn} is called from outside the journey engine`);
  }
  // The built-in loops are gone, and nothing schedules them.
  for (const [fn, rel] of [["runServiceReminders", "src/lib/serviceReminders.ts"], ["runSignatureRequestReminders", "src/lib/signingReminders.ts"]]) {
    assert.doesNotMatch(code(rel), new RegExp(`function ${fn}\\b`));
    assert.ok(!SOURCES.some((r) => new RegExp(`\\b${fn}\\b`).test(code(r))), `${fn} is still referenced`);
  }
  assert.doesNotMatch(code("src/app/api/cron/automations/route.ts"), /"service-reminders"|"signature-request-reminders"/);
  // Job card completion and a new delivery only TELL the engine.
  assert.match(code("src/app/actions/jobcards.ts"), /emitContactJourneyEvent\("job_completed"/);
  assert.match(code("src/app/actions/vehicles.ts"), /emitContactJourneyEvent\("vehicle_delivered"/);
  // A signing reminder (notifyRecipient as a reminder) is sent by the journey's
  // sender or by a person pressing Resend — nowhere else. The sequential
  // "re-nudge" that sent one by itself is gone.
  const reminderSenders = SOURCES.filter((rel) => /notifyRecipient\([^)]*reminder: true|dispatchRequest\([^)]*reminder: true/.test(code(rel)));
  assert.deepEqual(reminderSenders.sort(), ["src/app/actions/recordSigning.ts", "src/app/actions/signhub.ts", "src/lib/signingReminders.ts"]);
  const next = code("src/lib/signing/dispatch.ts").slice(code("src/lib/signing/dispatch.ts").indexOf("export async function notifyNextInSequence"));
  assert.doesNotMatch(next, /reminder/);
  // An automatic survey is never reminded by the queue.
  assert.match(code("src/lib/surveyDistributionQueue.ts"), /AND COALESCE\(d\."audienceSnapshot"->>'source', ''\) <> 'automation_trigger'\n/);
  assert.match(code("src/lib/governedSurveyRuntime.ts"), /maxReminders: 0,/);
});

test("every switch on the page is actually obeyed by the code it names — none is decorative", () => {
  const where: Record<string, string[]> = {
    SIGNING_SIGNED_COPIES: ["src/lib/signing/complete.ts", "src/lib/signing/recoverCompletions.ts", "src/lib/signing/jobWorker.ts"],
  };
  const keys = AUTOMATIONS.flatMap((a) => (a.setting ? [a.setting.key] : []));
  assert.deepEqual(keys.filter((k) => !where[k]).sort(), [], "a switch with no known gate — add it here and gate the code");
  for (const [key, files] of Object.entries(where)) for (const f of files) assert.ok(code(f).includes(key), `${key} is not checked in ${f}`);
  // The gates themselves.
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
  // Every entry is listed: the journeys engine in its own section, the rest by group.
  assert.match(page, /AUTOMATIONS\.filter\(\(a\) => a\.reaches === group\.reach && a\.key !== engine\.key\)/);
  assert.match(page, /\{row\(engine\)\}/);
  assert.deepEqual([...new Set(AUTOMATIONS.map((a) => a.reaches))].sort(), ["customer", "nobody", "staff"]);
  // "Customer messages are journeys": each ready-made journey, its state, a link to Journeys.
  assert.match(page, /title="Customer messages are journeys"/);
  assert.match(page, /readyMade\.rows\.map\(/);
  assert.match(page, /href="\/journeys"/);
  assert.match(page, /!readyMade\.marketingOn &&/, "says so when journeys can't run");
  const read_ = code("src/app/actions/automationSettings.ts");
  const fn = read_.slice(read_.indexOf("export async function readReadyMadeJourneys"));
  assert.match(fn, /await requireTenantOwner\(\);\s*const tenantId = await actingTenantId\(\);\s*await ensureReadyMadeJourneysQuietly\(tenantId\);/);
  const action = code("src/app/actions/automationSettings.ts");
  const save = action.slice(action.indexOf("export async function saveAutomationSwitch"));
  assert.match(save, /const user = await requireTenantOwner\(\);/);
  assert.match(save, /const automation = AUTOMATIONS\.find\(\(a\) => a\.setting\?\.key === key\);\s*if \(!automation\?\.setting\) return \{ error:/);
  assert.match(save, /action: "automation\.switched"/);
});

test("every customer message can be READ and EDITED from the page — none is hidden or hard-coded", async () => {
  const { SIGNING_EMAILS } = await import("../src/lib/signing/emailTemplates");
  for (const a of AUTOMATIONS.filter((x) => x.reaches === "customer")) {
    assert.ok(a.messages?.length || a.messagesAt, `${a.key}: says nothing about what it sends`);
    for (const kind of a.messages ?? []) assert.ok(kind in SIGNING_EMAILS, `${a.key}: "${kind}" isn't an editable template`);
  }
  // Each opens in its editor, wherever it lives: ?open=<kind> opens that one
  // (lib/customerMessagePlaces.ts; tests/customerMessagePlaces.test.ts).
  assert.match(code("src/components/CustomerMessageEditors.tsx"), /id=\{`template-\$\{kind\}`\} open=\{open === kind\}/);
  assert.match(code("src/app/(app)/settings/automatic/page.tsx"), /href=\{messageEditorHref\(kind as SigningEmailKind\)\}/);
  // The texts that were hard-coded now come from templates.
  const dispatch = code("src/lib/signing/dispatch.ts");
  assert.match(dispatch, /signingWhatsAppText\(opts\?\.reminder \? "reminder_whatsapp" : "invite_whatsapp"/);
  assert.doesNotMatch(dispatch, /Sign here: \$\{url\}/, "no hard-coded WhatsApp wording");
  const queue = code("src/lib/surveyDistributionQueue.ts");
  assert.doesNotMatch(queue, /function inviteText|A quick reminder/, "no hard-coded survey wording");
  assert.match(queue, /tenantEmailContent\(reminder \? "survey_reminder" : "survey_invite"/);
  assert.match(queue, /tenantSmsContent\(reminder \? "survey_reminder_sms" : "survey_invite_sms"/);
});

test("forms never pre-tick a customer message", () => {
  assert.match(read("src/components/VehicleForm.tsx"), /name="newDelivery"[^>]*defaultChecked=\{false\}/);
  assert.match(read("src/app/(app)/marketing/surveys/distributions/page.tsx"), /name="maxReminders" min="0" max="3" defaultValue="0"/);
  assert.match(read("src/app/(app)/jobcards/[id]/page.tsx"), /Completing also sends the customer whatever is switched on for completed job cards/);
});
