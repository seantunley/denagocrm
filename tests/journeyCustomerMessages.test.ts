import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";
import type { ModuleSendOutcome } from "../src/lib/journeyTypes";

/*
 * ONE ENGINE FOR AUTOMATIC CUSTOMER MESSAGES (2026-10-06). The review request,
 * service-due, signing and survey reminders are journey triggers + steps now.
 * These run the REAL engine pieces against fakes:
 *
 *   - the step executor hands each module step's record to the module's own
 *     sender, with the run's workspace, and maps what it did onto the trace;
 *   - the scheduler enrols each due record ONCE (the dedupe key holds across
 *     ticks), names the tenant, and keeps the Automotive gate on service_due;
 *   - the contact emitter is Marketing-gated, deduped per occurrence and never
 *     throws into the action that called it;
 *   - the signing sender claims once per signer and releases on failure.
 *
 * No real database client is built: every `db` import is a fake.
 */

const calls: Array<{ fn: string; args: unknown[] }> = [];
let outcome: ModuleSendOutcome = { kind: "sent" };
const sender = (fn: string) => async (...args: unknown[]) => {
  calls.push({ fn, args });
  return outcome;
};

/* ── the scheduler's fakes ──────────────────────────────────────────────── */
const emitted: Array<Record<string, unknown>> = [];
const seenKeys = new Set<string>();
let automotiveOn = true;
const activeJourney = {
  id: "j_ready",
  activeVersion: 1,
  versions: [{
    id: "v1",
    version: 1,
    state: "published",
    triggers: [
      { type: "service_due", config: {} },
      { type: "signing_unsigned", config: { days: 3 } },
      { type: "survey_unanswered", config: { hours: 48 } },
    ],
  }],
};
const moduleQueries: Array<{ fn: string; args: unknown[] }> = [];

/* ── the contact emitter's fakes ───────────────────────────────────────── */
let marketingOn = true;
let emitThrows = false;
const contacts = new Set(["c1"]);
const leads = new Set(["l1"]);

/* ── the signing sender's fakes ────────────────────────────────────────── */
const recipientWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
let claimCount = 1;
let notify = { reachable: true, delivered: true };
let notified: string[] = [];

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: { filename?: string } | undefined, file: string) => (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (from(parent, "src/lib/journeyStepExecutor.ts")) {
    if (request === "./reviewRequests") return { sendReviewRequest: sender("sendReviewRequest") };
    if (request === "./serviceReminders") return { sendServiceDueReminder: sender("sendServiceDueReminder") };
    if (request === "./signingReminders") return { remindSigner: sender("remindSigner") };
    if (request === "./surveyDistributionQueue") return { sendSurveyReminder: sender("sendSurveyReminder") };
  }
  if (from(parent, "src/lib/journeyScheduling.ts")) {
    if (request === "./db") return { prisma: { journey: { findMany: async () => [activeJourney] } } };
    if (request === "./journeyTenant") return { journeyTenantId: () => "tenant_a" };
    if (request === "./journeyEvents") return {
      emitJourneyEvent: async (event: Record<string, unknown>) => {
        if (seenKeys.has(String(event.dedupeKey))) return null; // JourneyEvent.dedupeKey is UNIQUE
        seenKeys.add(String(event.dedupeKey));
        emitted.push(event);
        return { id: `e${emitted.length}` };
      },
    };
    if (request === "./modules/enabled") return { isModuleEnabled: async (id: string) => (id === "automotive" ? automotiveOn : true) };
    if (request === "./serviceReminders") return {
      vehiclesDueForService: async (...args: unknown[]) => {
        moduleQueries.push({ fn: "vehiclesDueForService", args });
        return [{ vehicleId: "v1", contactId: "c1", dueKey: "2026-11-01-nokm", model: "Rover XXL" }];
      },
    };
    if (request === "./signingReminders") return {
      signersAwaitingReminder: async (...args: unknown[]) => {
        moduleQueries.push({ fn: "signersAwaitingReminder", args });
        return [{ recipientId: "r1", requestId: "req1", entityType: "lead", entityId: "l1" }];
      },
    };
    if (request === "./surveyDistributionQueue") return {
      unansweredAutomaticSurveys: async (...args: unknown[]) => {
        moduleQueries.push({ fn: "unansweredAutomaticSurveys", args });
        return [{ responseId: "sr1", contactId: "c1" }];
      },
    };
  }
  if (from(parent, "src/lib/leadJourneyEvents.ts")) {
    if (request === "./db") return { prisma: {
      contact: { findUnique: async ({ where }: { where: { id: string } }) => (contacts.has(where.id) ? { id: where.id } : null) },
      // A lead in this workspace, as the scoped client would return it.
      lead: { findUnique: async ({ where }: { where: { id: string } }) => (leads.has(where.id) ? { id: where.id, stageId: "stage_quoted", updatedAt: new Date("2026-10-12T08:00:00Z") } : null) },
    } };
    if (request === "./modules/enabled") return { isModuleEnabled: async () => marketingOn };
    if (request === "./journeyEvents") return {
      emitJourneyEvent: async (event: Record<string, unknown>) => {
        if (emitThrows) throw new Error("database down");
        emitted.push(event);
        return { id: "e" };
      },
    };
  }
  if (from(parent, "src/lib/signingReminders.ts")) {
    if (request === "@/lib/db") return {
      prisma: {
        signatureRecipient: {
          updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            recipientWrites.push(args);
            return { count: args.data.remindedAt === null ? 1 : claimCount };
          },
        },
      },
    };
    if (request === "@/lib/signing/dispatch") return {
      notifyRecipient: async (id: string, opts: { reminder?: boolean }) => {
        assert.equal(opts.reminder, true, "sent as a reminder, with the signer's own link");
        notified.push(id);
        return notify;
      },
    };
  }
  // Everything else that would reach a database gets an inert client.
  if (request === "./db" || request === "@/lib/db") return { prisma: {}, basePrisma: {} };
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { executeJourneyStep } = require_("../src/lib/journeyStepExecutor.ts") as typeof import("../src/lib/journeyStepExecutor");
const { runScheduledJourneyEnrollments } = require_("../src/lib/journeyScheduling.ts") as typeof import("../src/lib/journeyScheduling");
const { emitContactJourneyEvent, emitQuoteJourneyEvent, emitTestDriveJourneyEvent } = require_("../src/lib/leadJourneyEvents.ts") as typeof import("../src/lib/leadJourneyEvents");
const { remindSigner } = require_("../src/lib/signingReminders.ts") as typeof import("../src/lib/signingReminders");

const step = (type: string) => ({ id: "s1", type, config: {} }) as Parameters<typeof executeJourneyStep>[0]["step"];
const run = (type: string, event: Record<string, unknown>, tenantId: string | null = "tenant_a") =>
  executeJourneyStep({
    step: step(type),
    context: { event, lead: null, contact: { id: "c1", firstName: "Lisa" } },
    category: "automation",
    journeyName: "Ready-made",
    runId: "run1",
    tenantId,
  });

beforeEach(() => {
  calls.length = 0;
  outcome = { kind: "sent" };
  emitted.length = 0;
  seenKeys.clear();
  moduleQueries.length = 0;
  automotiveOn = true;
  marketingOn = true;
  emitThrows = false;
  recipientWrites.length = 0;
  claimCount = 1;
  notify = { reachable: true, delivered: true };
  notified = [];
});

/* ── steps ─────────────────────────────────────────────────────────────── */

test("each module step hands its record to the module's own sender, with the run's workspace", async () => {
  assert.equal((await run("send_review_request", { type: "job_completed", refText: "the service on your Rover (job card #7)" })).status, "completed");
  assert.equal((await run("send_review_request", { type: "vehicle_delivered", refText: "Rover XXL" })).status, "completed");
  assert.equal((await run("send_service_reminder", { type: "service_due", vehicleId: "v1" })).status, "completed");
  assert.equal((await run("send_signing_reminder", { type: "signing_unsigned", signatureRecipientId: "r1" })).status, "completed");
  assert.equal((await run("send_survey_reminder", { type: "survey_unanswered", surveyResponseId: "sr1" })).status, "completed");
  assert.deepEqual(calls, [
    { fn: "sendReviewRequest", args: ["c1", "service", "the service on your Rover (job card #7)", "tenant_a"] },
    { fn: "sendReviewRequest", args: ["c1", "delivery", "Rover XXL", "tenant_a"] },
    { fn: "sendServiceDueReminder", args: ["v1", "tenant_a"] },
    { fn: "remindSigner", args: ["r1", "tenant_a"] },
    { fn: "sendSurveyReminder", args: ["sr1", "tenant_a"] },
  ]);
});

test("a module step without its trigger's record skips and says which trigger it needs — nothing is sent", async () => {
  for (const type of ["send_service_reminder", "send_signing_reminder", "send_survey_reminder"]) {
    const result = await run(type, { type: "lead_created" });
    assert.equal(result.status, "skipped");
    assert.match(result.note, /needs the “.+” trigger/);
  }
  assert.equal((await run("send_signing_reminder", { signatureRecipientId: "r1" }, null)).status, "skipped", "no workspace, no send");
  assert.deepEqual(calls, []);
});

test("what the module did becomes the trace: skipped says why, quiet hours wait in place, a refusal retries", async () => {
  outcome = { kind: "skipped", reason: "already asked in the last 90 days" };
  const skipped = await run("send_review_request", { type: "job_completed" });
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.note, /already asked in the last 90 days/);

  const until = new Date("2026-10-07T08:00:00Z");
  outcome = { kind: "deferred", reason: "quiet hours", until };
  const held = await run("send_survey_reminder", { surveyResponseId: "sr1" });
  assert.equal(held.status, "waiting");
  assert.equal(held.retryStep, true, "the SAME step runs again, so the message isn't dropped");
  assert.equal(held.nextRunAt, until);

  outcome = { kind: "failed", reason: "the email provider refused it" };
  await assert.rejects(run("send_service_reminder", { vehicleId: "v1" }), /Service reminder not sent: the email provider refused it/);
});

/* ── the scheduled triggers ────────────────────────────────────────────── */

test("each due record is enrolled ONCE — the next tick finds the same records and enrols nobody", async () => {
  assert.equal(await runScheduledJourneyEnrollments(), 3);
  assert.deepEqual(
    emitted.map((e) => [e.type, e.entityType, e.entityId, e.journeyId]),
    [
      ["service_due", "contact", "c1", "j_ready"],
      ["signing_unsigned", "lead", "l1", "j_ready"],
      ["survey_unanswered", "contact", "c1", "j_ready"],
    ],
  );
  assert.deepEqual(emitted[0].payload, { vehicleId: "v1", model: "Rover XXL", dueKey: "2026-11-01-nokm" });
  assert.deepEqual(emitted[1].payload, { signatureRecipientId: "r1", signatureRequestId: "req1", days: 3 });
  assert.deepEqual(emitted[2].payload, { surveyResponseId: "sr1", hours: 48 });
  // The sweeps are asked for THIS workspace, with the trigger's own setting.
  assert.deepEqual(moduleQueries, [
    { fn: "vehiclesDueForService", args: ["tenant_a"] },
    { fn: "signersAwaitingReminder", args: ["tenant_a", 3] },
    { fn: "unansweredAutomaticSurveys", args: ["tenant_a", 48] },
  ]);

  assert.equal(await runScheduledJourneyEnrollments(), 0, "a record already enrolled is not enrolled again");
  assert.equal(emitted.length, 3);
});

test("no Automotive pack, no service-due enrolment — as the built-in job was", async () => {
  automotiveOn = false;
  await runScheduledJourneyEnrollments();
  assert.ok(!emitted.some((e) => e.type === "service_due"));
  assert.ok(!moduleQueries.some((q) => q.fn === "vehiclesDueForService"), "the vehicles aren't even read");
});

/* ── the contact events ────────────────────────────────────────────────── */

test("a completed job card enrols the customer once per completion, through the Marketing gate", async () => {
  await emitContactJourneyEvent("job_completed", "c1", { occurrence: "jobcard:7:2026-10-06T10:00:00.000Z", payload: { jobCardId: "7" } });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].entityType, "contact");
  assert.equal(emitted[0].entityId, "c1");
  assert.equal(emitted[0].dedupeKey, "contact-event:job_completed:c1:jobcard:7:2026-10-06T10:00:00.000Z");

  marketingOn = false;
  await emitContactJourneyEvent("job_completed", "c1", { occurrence: "x" });
  marketingOn = true;
  await emitContactJourneyEvent("vehicle_delivered", "someone-elses-contact", { occurrence: "x" });
  assert.equal(emitted.length, 1, "Marketing off, or a contact not in this workspace: nothing");

  emitThrows = true;
  await emitContactJourneyEvent("vehicle_delivered", "c1", { occurrence: "vehicle:v1" }); // must not reject
});

/* ── quotes and test drives: for the lead when there is one ─────────────── */

test("a test drive enrols the LEAD when the booking has one, the customer when it has not — once per booking and stage", async () => {
  const withLead = { id: "td1", reference: "TD-1001", leadId: "l1", contactId: "c1" };
  await emitTestDriveJourneyEvent("test_drive_booked", withLead);
  assert.equal(emitted.length, 1, "one event, not one for the lead and another for the customer");
  assert.equal(emitted[0].type, "test_drive_booked");
  assert.equal(emitted[0].entityType, "lead");
  assert.equal(emitted[0].entityId, "l1");
  assert.equal(emitted[0].dedupeKey, "lead-event:test_drive_booked:l1:test-drive:td1:test_drive_booked");
  assert.deepEqual(emitted[0].payload, { testDriveId: "td1", testDriveReference: "TD-1001", stageId: "stage_quoted" });

  // Completed carries what the salesperson recorded (kept on the event; no step branches on it yet).
  await emitTestDriveJourneyEvent("test_drive_completed", withLead, { outcome: "follow_up" });
  assert.equal((emitted[1].payload as { outcome?: string }).outcome, "follow_up");
  assert.notEqual(emitted[1].dedupeKey, emitted[0].dedupeKey, "booked and completed are two events on one booking");

  // A walk-in with no lead: the customer is who the journey is for.
  await emitTestDriveJourneyEvent("test_drive_no_show", { id: "td2", reference: "TD-1002", leadId: null, contactId: "c1" });
  assert.equal(emitted[2].entityType, "contact");
  assert.equal(emitted[2].dedupeKey, "contact-event:test_drive_no_show:c1:test-drive:td2:test_drive_no_show");

  // Somebody else's lead reads as missing through the scoped client: nothing.
  await emitTestDriveJourneyEvent("test_drive_booked", { id: "td3", reference: "TD-1003", leadId: "another-workspaces-lead", contactId: "c1" });
  assert.equal(emitted.length, 3);
});

test("a quote sent or opened enrols its lead (or its customer), keyed so a second sending is a second event", async () => {
  const quote = { id: "q1", number: 1022, leadId: "l1", contactId: "c1" };
  await emitQuoteJourneyEvent("quote_sent", quote, "sent:request:r1");
  await emitQuoteJourneyEvent("quote_sent", quote, "sent:request:r2");
  await emitQuoteJourneyEvent("quote_opened", quote, "opened");
  assert.deepEqual(emitted.map((e) => e.dedupeKey), [
    "lead-event:quote_sent:l1:quote:q1:sent:request:r1",
    "lead-event:quote_sent:l1:quote:q1:sent:request:r2",
    "lead-event:quote_opened:l1:quote:q1:opened",
  ]);
  assert.deepEqual(emitted[0].payload, { quoteId: "q1", quoteNumber: 1022, stageId: "stage_quoted" });

  await emitQuoteJourneyEvent("quote_sent", { id: "q2", number: 1023, leadId: null, contactId: "c1" }, "sent:1");
  assert.equal(emitted[3].entityType, "contact");
  // No lead and no customer: nobody to enrol, and no error.
  await emitQuoteJourneyEvent("quote_sent", { id: "q3", number: 1024, leadId: null, contactId: null }, "sent:1");
  assert.equal(emitted.length, 4);

  marketingOn = false;
  await emitQuoteJourneyEvent("quote_opened", quote, "opened");
  assert.equal(emitted.length, 4, "Marketing off: nothing is written");
  marketingOn = true;
  emitThrows = true;
  await emitQuoteJourneyEvent("quote_opened", quote, "opened"); // must not reject into the send or the view
  await emitTestDriveJourneyEvent("test_drive_completed", { id: "td1", reference: "TD-1001", leadId: "l1", contactId: "c1" });
});

/* ── the signing sender ────────────────────────────────────────────────── */

test("a signing reminder is claimed once per signer, in the run's workspace", async () => {
  assert.deepEqual(await remindSigner("r1", "tenant_a"), { kind: "sent" });
  const claim = recipientWrites[0];
  assert.equal(claim.where.tenantId, "tenant_a");
  assert.equal(claim.where.remindedAt, null, "never reminded before");
  assert.deepEqual(claim.where.status, { in: ["sent", "viewed"] }, "only a signer who hasn't signed");
  assert.deepEqual(notified, ["r1"]);

  claimCount = 0; // already reminded, signed, or the request closed
  assert.equal((await remindSigner("r1", "tenant_a")).kind, "skipped");
  assert.deepEqual(notified, ["r1"], "no second reminder");
});

test("a reminder nothing accepted releases the claim, so the retry may send it", async () => {
  notify = { reachable: true, delivered: false };
  assert.equal((await remindSigner("r1", "tenant_a")).kind, "failed");
  assert.equal(recipientWrites.at(-1)!.data.remindedAt, null, "claim released");

  notify = { reachable: false, delivered: false };
  assert.equal((await remindSigner("r2", "tenant_a")).kind, "skipped", "no email or WhatsApp: nothing to retry");
  assert.equal(recipientWrites.at(-1)!.data.remindedAt, null);
});
