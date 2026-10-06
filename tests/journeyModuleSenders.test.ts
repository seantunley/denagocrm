import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/*
 * The review-request and service-due senders, now reached only from a journey
 * step, keep every safety property the built-ins had: the consent gate (and a
 * recorded reason when it refuses), one review ask per customer per 90 days, one
 * service reminder per due-cycle, the editable templates, and the customer's
 * timeline. The REAL senders, against fakes — no switch is read any more: the
 * journey being on is the owner's approval.
 */

const state = {
  verdict: { allowed: true } as { allowed: boolean; reason?: string },
  recentAsk: false,
  logged: false,
  sent: [] as Array<{ to: string; subject: string }>,
  audits: [] as Array<{ action: string; summary: string }>,
  timeline: [] as Array<Record<string, unknown>>,
  logs: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ model: string; where: Record<string, unknown> }>,
  settingsRead: [] as string[],
  // Newest first, as the sender's orderBy asks.
  serviceRecords: [] as Array<{ tenantId: string; serviceDate: Date; km: number | null; nextDueKm: number | null; nextDueDate: Date | null }>,
  mileageLogs: [] as Array<{ tenantId: string; recordedAt: Date; km: number }>,
};

const due = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // due soon
const OWN_SERVICE = { tenantId: "tenant_a", serviceDate: new Date("2026-01-01"), km: null, nextDueKm: null, nextDueDate: due };
const contact = { id: "c1", tenantId: "tenant_a", firstName: "Lisa", lastName: "Moulder", email: "lisa@example.com", phone: null, deletedAt: null };
const prisma = {
  contact: { findFirst: async ({ where }: { where: Record<string, unknown> }) => { state.queries.push({ model: "contact", where }); return contact; } },
  communication: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => { state.queries.push({ model: "communication", where }); return state.recentAsk ? { id: "x" } : null; },
    create: async ({ data }: { data: Record<string, unknown> }) => { state.timeline.push(data); return data; },
  },
  vehicle: {
    // The nested reads behave as the database does with tenant enforcement OFF:
    // a nested `where` is applied, and without one every workspace's rows come back.
    findFirst: async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, { where?: { tenantId?: string } }> }) => {
      state.queries.push({ model: "vehicle", where });
      const scoped = <T extends { tenantId: string }>(rows: T[], key: string) => {
        const tenant = include?.[key]?.where?.tenantId;
        return tenant ? rows.filter((r) => r.tenantId === tenant) : rows;
      };
      return {
        id: "v1", contactId: "c1", model: "Rover XXL", color: null, contact,
        serviceIntervalKm: null, serviceIntervalMonths: null, purchaseDate: null,
        serviceRecords: scoped(state.serviceRecords, "serviceRecords").slice(0, 1),
        mileageLogs: scoped(state.mileageLogs, "mileageLogs").slice(0, 1),
      };
    },
  },
  serviceReminderLog: {
    findUnique: async () => (state.logged ? { id: "l" } : null),
    upsert: async ({ create }: { create: Record<string, unknown> }) => { state.logs.push(create); state.logged = true; return create; },
  },
  emailTemplate: { findFirst: async () => null },
};

const stubs: Record<string, unknown> = {
  "./db": { prisma, basePrisma: prisma },
  "./customerRecordTenant": { customerRecordTenantId: async () => "tenant_a" },
  "./tenantActor": { resolveTenantActor: async () => ({ id: "user_1" }) },
  "./settings": {
    resolveTenantCredential: async (_t: string, key: string) => (key === "GOOGLE_PLACE_ID" ? "place_1" : null),
    getSetting: async (key: string) => { state.settingsRead.push(key); return null; },
    getRegionalSettings: async () => ({}),
  },
  "./email": {
    sendEmail: async (m: { to: string; subject: string }) => { state.sent.push(m); return { ok: true }; },
    renderTemplate: (s: string) => s,
  },
  "./sms": { sendSms: async () => ({ ok: true }) },
  "./audit": { logAudit: async (e: { action: string; summary: string }) => { state.audits.push(e); } },
  "./companyProfile": { getCompanyProfile: async () => ({ name: "Acme" }), companyTeamSignoff: () => "The Acme team" },
  "./signing/signingEmail": {
    tenantEmailContent: async (kind: string) => ({ subject: `[${kind}]`, text: kind, html: "<p/>" }),
    tenantSmsContent: async (kind: string) => kind,
  },
  "./communicationPolicy": {
    canContactPerson: async () => state.verdict,
    describeBlockedReason: (reason?: string) => reason ?? "not contactable",
    firstAllowedChannel: async () => ({ allowed: false }),
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  const file = (parent?.filename ?? "").replace(/\\/g, "/");
  if ((file.endsWith("src/lib/reviewRequests.ts") || file.endsWith("src/lib/serviceReminders.ts")) && request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { sendReviewRequest } = require_("../src/lib/reviewRequests.ts") as typeof import("../src/lib/reviewRequests");
const { sendServiceDueReminder } = require_("../src/lib/serviceReminders.ts") as typeof import("../src/lib/serviceReminders");

beforeEach(() => {
  state.verdict = { allowed: true };
  state.recentAsk = false;
  state.logged = false;
  state.sent = [];
  state.audits = [];
  state.timeline = [];
  state.logs = [];
  state.queries = [];
  state.settingsRead = [];
  state.serviceRecords = [OWN_SERVICE];
  state.mileageLogs = [];
});

test("review request: sent in the editable template, on the timeline, every lookup in the run's workspace", async () => {
  assert.deepEqual(await sendReviewRequest("c1", "service", "the service on your Rover", "tenant_a"), { kind: "sent" });
  assert.deepEqual(state.sent.map((m) => m.subject), ["[review_service]"]);
  assert.equal(state.timeline.length, 1);
  assert.ok(state.queries.every((q) => q.where.tenantId === "tenant_a"));
  assert.ok(!state.settingsRead.some((key) => key.includes("REVIEW")), "no switch: the journey being on is the approval");
});

test("review request: an opted-out customer gets nothing, and the refusal is recorded", async () => {
  state.verdict = { allowed: false, reason: "marketing_opt_out" };
  assert.deepEqual(await sendReviewRequest("c1", "delivery", "Rover XXL", "tenant_a"), { kind: "skipped", reason: "marketing_opt_out" });
  assert.deepEqual(state.sent, []);
  assert.equal(state.audits[0].action, "communication.suppressed");
});

test("review request: never twice in 90 days", async () => {
  state.recentAsk = true;
  assert.equal((await sendReviewRequest("c1", "service", "x", "tenant_a")).kind, "skipped");
  assert.deepEqual(state.sent, []);
});

test("service reminder: once per due-cycle — logged, on the timeline, then skipped", async () => {
  assert.deepEqual(await sendServiceDueReminder("v1", "tenant_a"), { kind: "sent" });
  assert.deepEqual(state.sent.map((m) => m.subject), ["[service_reminder]"], "the editable template when none is picked");
  assert.equal(state.logs.length, 1);
  assert.equal(state.timeline.length, 1);
  assert.equal(state.queries.find((q) => q.model === "vehicle")?.where.tenantId, "tenant_a");

  assert.equal((await sendServiceDueReminder("v1", "tenant_a")).kind, "skipped", "already reminded for this service");
  assert.equal(state.sent.length, 1);
  assert.ok(!state.settingsRead.includes("SERVICE_REMINDER_ENABLED"), "no switch: the journey being on is the approval");
});

test("service reminder: another workspace's newer service or mileage row can't change what is sent (#787 review)", async () => {
  // Tenant enforcement off, and a mis-stamped row from tenant_b on this vehicle
  // that is NEWER than ours — read unscoped, it would be "the latest service"
  // and say the next one isn't due for a year, so the reminder would be skipped.
  state.serviceRecords = [
    { tenantId: "tenant_b", serviceDate: new Date(), km: null, nextDueKm: null, nextDueDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    OWN_SERVICE,
  ];
  state.mileageLogs = [{ tenantId: "tenant_b", recordedAt: new Date(), km: 999_999 }];
  assert.deepEqual(await sendServiceDueReminder("v1", "tenant_a"), { kind: "sent" }, "decided on tenant_a's own history only");
  assert.equal(state.sent.length, 1);
});

test("service reminder: the due scan and the sender read the vehicle's history the same, tenant-scoped way", () => {
  const src = readFileSync(new URL("../src/lib/serviceReminders.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const dueVehicleInclude = \(tenantId: string\) => \(\{\s*contact: true,\s*serviceRecords: \{ where: \{ tenantId \}, orderBy: \{ serviceDate: "desc" as const \}, take: 1 \},\s*mileageLogs: \{ where: \{ tenantId \}, orderBy: \{ recordedAt: "desc" as const \}, take: 1 \},/);
  assert.equal((src.match(/include: dueVehicleInclude\(tenantId\)/g) ?? []).length, 2, "the scan and the sender");
  // …and the Service Due page's manual Remind button, in the vehicle's own workspace.
  assert.match(src, /include: dueVehicleInclude\(owner\.tenantId\)/);
  assert.doesNotMatch(src, /serviceRecords: \{ orderBy|mileageLogs: \{ orderBy/, "no unscoped nested read left");
});

test("service reminder: a customer who switched reminders off gets nothing, recorded once against the cycle", async () => {
  state.verdict = { allowed: false, reason: "consent_withdrawn" };
  assert.equal((await sendServiceDueReminder("v1", "tenant_a")).kind, "skipped");
  assert.deepEqual(state.sent, []);
  assert.equal(state.logs.length, 1, "the cycle is closed, so it isn't audited every tick");
  assert.equal(state.audits[0].action, "communication.suppressed");
});
