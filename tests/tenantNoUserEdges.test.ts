import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Phase C step 2b — structural guard for the no-user token surfaces (public
// signing + approval PAGES and their mutation ROUTES, campaign tracking, and
// unsubscribe). These carry no staff session, so under enforcement they must
// derive their tenant from a narrow trusted lookup BEFORE any guarded query and
// run the guarded work inside that scope. The original bug shipped the scope
// establishment AFTER the first guarded read — a scope-before-bootstrap deadlock.
//
// This test encodes the anti-deadlock invariant directly: in every file the
// `withTokenTenantScope(` call must appear BEFORE the guarded token read, both the
// shared scope helper and the shared resolver must be imported, and page + route
// for a given token type must use the SAME resolver so they can't drift. Runtime
// behaviour (derivation, fail-closed, cross-tenant isolation, opt-out commit) is
// proven by scripts/test-tenant-guard.ts against the real extended Prisma client.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// file → { guarded token read, shared resolver } for the whole read+write surface.
const SURFACE = [
  { file: "src/app/signing/[token]/page.tsx", read: "prisma.signatureRecipient.findUnique", resolver: "resolveSignRecipientTenant" },
  { file: "src/app/api/signing/[token]/route.ts", read: "prisma.signatureRecipient.findUnique", resolver: "resolveSignRecipientTenant" },
  { file: "src/app/api/signing/[token]/decline/route.ts", read: "prisma.signatureRecipient.findUnique", resolver: "resolveSignRecipientTenant" },
  { file: "src/app/approvals/[token]/page.tsx", read: "prisma.approvalStep.findUnique", resolver: "resolveApprovalStepTenant" },
  { file: "src/app/api/approvals/[token]/route.ts", read: "prisma.approvalStep.findUnique", resolver: "resolveApprovalStepTenant" },
  { file: "src/app/api/track/o/[token]/route.ts", read: "prisma.campaignRecipient.findUnique", resolver: "resolveCampaignRecipientTenant" },
  { file: "src/app/api/track/c/[token]/route.ts", read: "prisma.campaignRecipient.findUnique", resolver: "resolveCampaignRecipientTenant" },
  { file: "src/app/api/unsubscribe/[token]/route.ts", read: "prisma.campaignRecipient.findUnique", resolver: "resolveCampaignRecipientTenant" },
  // The survey page's guarded read is encapsulated in loadFrozenSurveyResponse()
  // (a scope-guarded raw query that fails closed via tenantFromScope), so the
  // "read" marker here is that call site — it must still appear inside, i.e.
  // after, the withTokenTenantScope() wrapper.
  { file: "src/app/s/[token]/page.tsx", read: "loadFrozenSurveyResponse(", resolver: "resolveSurveyResponseTenant" },
] as const;

for (const { file, read, resolver } of SURFACE) {
  test(`${file}: derives tenant via the shared helper + resolver`, () => {
    const code = src(file);
    assert.match(code, /from "@\/lib\/tenantScopeEntry"/, `${file} must import from tenantScopeEntry`);
    assert.match(code, /withTokenTenantScope\s*\(/, `${file} must call withTokenTenantScope`);
    assert.match(code, /from "@\/lib\/tokenTenant"/, `${file} must import the shared resolver`);
    assert.ok(code.includes(resolver), `${file} must use ${resolver} (shared page/route derivation)`);
  });

  test(`${file}: establishes scope BEFORE the guarded token read (no deadlock)`, () => {
    const code = src(file);
    const scopeAt = code.indexOf("withTokenTenantScope(");
    const readAt = code.indexOf(read);
    assert.ok(scopeAt >= 0, `${file} must call withTokenTenantScope`);
    assert.ok(readAt >= 0, `${file} must perform the guarded token read (${read})`);
    assert.ok(
      scopeAt < readAt,
      `${file}: withTokenTenantScope must appear before the guarded read (else the read dead-locks with no scope)`,
    );
  });
}

// The public survey SUBMISSION is a server action (not a route): the guarded read
// lives in submitFrozenSurveyResponse (lib/governedSurveyRuntime.ts), so the action
// must establish the tenant scope before delegating to it.
test("src/app/actions/surveys.ts: public survey submission wraps submitFrozenSurveyResponse in a tenant scope", () => {
  const code = src("src/app/actions/surveys.ts");
  assert.match(code, /from "@\/lib\/tenantScopeEntry"/, "must import withTokenTenantScope");
  assert.match(code, /from "@\/lib\/tokenTenant"/, "must import resolveSurveyResponseTenant");
  const scopeAt = code.indexOf("withTokenTenantScope(");
  const workAt = code.indexOf("submitFrozenSurveyResponse(token");
  assert.ok(scopeAt >= 0, "submitSurveyResponse must call withTokenTenantScope");
  assert.ok(workAt >= 0, "submitSurveyResponse must delegate to submitFrozenSurveyResponse(token, …)");
  assert.ok(
    scopeAt < workAt,
    "submitSurveyResponse must establish the tenant scope before calling submitFrozenSurveyResponse (else the guarded read inside dead-locks)",
  );
});

// C1-reachable "pick an actor for a system-generated record" sites must use the
// tenant-aware resolver, not a global `user.findFirst` — else a public tenant-A
// operation stamps/emails a user from another tenant. (Other actor picks are
// C4-owned; see PHASE-C-NO-USER-EDGES-DESIGN.md §2.4.)
const ACTOR_SITES = [
  "src/lib/surveys.ts",             // submitResponse → Communication.userId
  "src/lib/signing/complete.ts",    // Document.uploadedById fallback
  "src/lib/signing/approvals.ts",   // owner approval notification recipient
] as const;

for (const file of ACTOR_SITES) {
  test(`${file}: C1-reachable actor pick uses the tenant-aware resolveTenantActor`, () => {
    assert.match(src(file), /resolveTenantActor\s*\(/, `${file} must resolve the actor via resolveTenantActor`);
  });
}

// Explicit STAFF assignees (approval steps) must be validated against current-tenant
// membership, and the pickers that populate them scoped to the tenant — else a
// workflow can persist another tenant's user id and notifyApprover emails them.
test("src/lib/signing/approvals.ts: staff assignee validated via resolveTenantMemberUser + fail closed", () => {
  const code = src("src/lib/signing/approvals.ts");
  assert.match(code, /resolveTenantMemberUser\s*\(/, "staff assignee must resolve via resolveTenantMemberUser");
  assert.match(code, /tenantEnforcing\(\)/, "must fail closed under enforcement when not a member");
  assert.match(code, /email:\s*null/, "fail-closed branch must return a null email (no notification)");
});

const STAFF_PICKERS = [
  "src/app/(app)/signing-workflows/[id]/page.tsx",
  "src/lib/signing/autoEnvelope.ts",
] as const;
for (const file of STAFF_PICKERS) {
  test(`${file}: staff list scoped to the current tenant (active, non-disabled members)`, () => {
    assert.match(src(file), /listTenantStaff\s*\(/, `${file} must build its staff list via listTenantStaff`);
  });
}

// Phase C step 2b (C2) — the public X-Api-Key routes must authenticate via the
// per-tenant key resolver and establish the caller's tenant scope BEFORE any guarded
// read (incl. the module check, which reads tenant-owned settings). The legacy
// global-key compare must be gone.
const API_KEY_ROUTES = [
  "src/app/api/intake/route.ts",
  "src/app/api/bookings/route.ts",
  "src/app/api/bookings/slots/route.ts",
  "src/app/api/service-lookup/route.ts",
  "src/app/api/service-lookup/verify/route.ts",
] as const;
for (const file of API_KEY_ROUTES) {
  test(`${file}: authenticates via authenticateIntakeKey + establishes tenant scope first`, () => {
    const code = src(file);
    assert.match(code, /authenticateIntakeKey\s*\(/, `${file} must authenticate via authenticateIntakeKey`);
    assert.match(code, /establishTenantScopeFromId\s*\(/, `${file} must establish the tenant scope`);
    assert.doesNotMatch(code, /getSetting\(\s*["']INTAKE_API_KEY["']\s*\)/, `${file} must not do the legacy global-key compare`);
    const scopeAt = code.indexOf("establishTenantScopeFromId(");
    const moduleAt = code.indexOf('isModuleEnabled("automotive")');
    if (moduleAt >= 0) {
      assert.ok(scopeAt >= 0 && scopeAt < moduleAt, `${file}: scope must be established before the module check`);
    }
  });
}

// Phase C step 2b (C2, review round 2) — the booking WRITE runs on basePrisma (row
// lock), which the db.ts guard does NOT scope, so the route must derive the write
// tenant via writeTenantId() and stamp it onto every row + hand it to the slot claim.
test("src/app/api/bookings/route.ts: stamps the write tenant + namespaces slot capacity", () => {
  const code = src("src/app/api/bookings/route.ts");
  assert.match(code, /from "@\/lib\/tenantWrite"/, "must import writeTenantId");
  assert.match(code, /const\s+writeTid\s*=\s*writeTenantId\(\)/, "must resolve the write tenant once");
  // the resolved tenant is threaded into the slot capacity claim (per-tenant slots)
  assert.match(code, /claimSlotCapacity\([^)]*writeTid/, "must pass the write tenant to claimSlotCapacity");
  // every tenant-owned create is stamped (contact, job card, activity → 3 sites)
  const stamps = code.match(/tenantId:\s*writeTid/g) ?? [];
  assert.ok(stamps.length >= 3, `every created row must be stamped with the tenant (found ${stamps.length}, expected ≥3)`);
});

// claimSlotCapacity/reserveSlot run on basePrisma → must take an explicit tenant and
// namespace BOTH the advisory lock and the count by it (else one tenant consumes
// another's capacity and the count disagrees with the scoped getDayAvailability).
test("src/lib/bookingSlots.ts: slot capacity is namespaced by an explicit tenant", () => {
  const code = src("src/lib/bookingSlots.ts");
  assert.match(code, /from "@\/lib\/tenantWrite"|from "\.\/tenantWrite"/, "must import writeTenantId");
  assert.match(code, /claimSlotCapacity\([\s\S]*?tenantId:\s*string\s*\|\s*null/, "claimSlotCapacity must take an explicit tenantId");
  assert.match(code, /slot:\$\{tenantId\}/, "the advisory lock must be namespaced by tenant");
  assert.match(code, /reserveSlot[\s\S]*?writeTenantId\(\)/, "reserveSlot must resolve + stamp the write tenant");
});

// OtpChallenge is a GLOBAL model keyed by VIN — under enforcement the service-lookup
// routes must namespace the challenge key by tenant (serviceOtpKey), never a bare VIN.
const OTP_ROUTES = [
  "src/app/api/service-lookup/route.ts",
  "src/app/api/service-lookup/verify/route.ts",
] as const;
for (const file of OTP_ROUTES) {
  test(`${file}: OTP challenge key is tenant-namespaced via serviceOtpKey`, () => {
    const code = src(file);
    assert.match(code, /serviceOtpKey\s*\(/, `${file} must derive the challenge key via serviceOtpKey`);
    assert.doesNotMatch(code, /key:\s*vin\b/, `${file} must not key the challenge on a bare VIN`);
  });
}

// sendPushToAll must select recipients by the current tenant scope, not an unfiltered
// findMany over the global PushSubscription table (which would leak a tenant's lead /
// booking names to every other tenant's devices).
test("src/lib/push.ts: sendPushToAll delivers only to the current tenant's devices", () => {
  const code = src("src/lib/push.ts");
  assert.match(code, /pushRecipientsForCurrentScope\s*\(/, "must select recipients via pushRecipientsForCurrentScope");
  assert.match(code, /const\s+subs\s*=\s*await\s+pushRecipientsForCurrentScope\(\)/, "sendPushToAll must use the scoped recipient list");
  assert.doesNotMatch(code, /prisma\.pushSubscription\.findMany\(\s*\)/, "must not do an unfiltered findMany() in the send path");
});

// Phase C step 2b (C3) — inbound webhooks carry no session; under enforcement they
// must resolve the tenant from the channel discriminator (OUR endpoint id) via
// withChannelTenantScope BEFORE any guarded DB work. The discriminator is per-EVENT,
// so the scope wraps each event inside the entry/change loop.
const CHANNEL_WEBHOOKS = [
  { file: "src/app/api/webhooks/whatsapp/route.ts", firstWork: "recordInboundWhatsApp", discriminator: /phone_number_id/ },
  { file: "src/app/api/webhooks/meta/route.ts", firstWork: "recordInboundDm", discriminator: /entry\.id/ },
] as const;
for (const { file, firstWork, discriminator } of CHANNEL_WEBHOOKS) {
  test(`${file}: establishes the channel tenant scope BEFORE the guarded work`, () => {
    const code = src(file);
    assert.match(code, /withChannelTenantScope\s*\(/, `${file} must call withChannelTenantScope`);
    assert.match(code, discriminator, `${file} must read its channel discriminator`);
    const scopeAt = code.indexOf("withChannelTenantScope(");
    assert.ok(scopeAt >= 0, `${file} must call withChannelTenantScope`);
    // The guarded work must be CALLED at/after the scope opens (searching from
    // scopeAt skips the import occurrence, which always precedes it).
    assert.ok(
      code.indexOf(firstWork, scopeAt) !== -1,
      `${file}: the guarded work (${firstWork}) must run inside/after the channel scope`,
    );
  });
}

// The meta route's leadgen path must create the lead INSIDE the (messenger/page_id)
// channel scope — else a Lead Ads submission lands unscoped under enforcement.
test("src/app/api/webhooks/meta/route.ts: leadgen createIntakeLead runs inside the messenger channel scope", () => {
  const code = src("src/app/api/webhooks/meta/route.ts");
  assert.match(code, /page_id/, "leadgen must read the page_id discriminator");
  const scopeAt = code.indexOf('withChannelTenantScope("messenger"');
  assert.ok(scopeAt >= 0, "leadgen must open a messenger channel scope");
  assert.ok(
    code.indexOf("createIntakeLead", scopeAt) !== -1,
    "createIntakeLead must run inside the messenger channel scope",
  );
});

// C3 review blocker 1 — the receive-side signature config (install-global) is read
// BEFORE the per-event chokepoint, so under enforcement it must go through a trusted
// system scope, not a bare (tenant-scoped) AppSetting read the guard would throw on.
for (const file of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/meta/route.ts"] as const) {
  test(`${file}: receive-side signature config is read via validateInSystemScope`, () => {
    const code = src(file);
    assert.match(code, /validateInSystemScope\(\s*\(\)\s*=>\s*getSetting\("META_APP_SECRET"\)\s*\)/, `${file} must read META_APP_SECRET in a system scope`);
    assert.match(code, /validateInSystemScope\(\s*\(\)\s*=>\s*getSetting\("META_VERIFY_TOKEN"\)\s*\)/, `${file} must read META_VERIFY_TOKEN in a system scope`);
  });
}

// C3 actor-pick sites must attribute inbound records via the tenant-aware resolver
// (channel scope), not the global oldest-user pick — else a tenant-A inbound message
// is stamped with another tenant's user. (§2.4)
const C3_ACTOR_SITES = [
  "src/lib/whatsapp.ts",
  "src/lib/messenger.ts",
  "src/lib/bot.ts",
  "src/lib/flowRun.ts",
  "src/lib/flowActions.ts",
] as const;
for (const file of C3_ACTOR_SITES) {
  test(`${file}: inbound actor pick uses resolveTenantActor (not the global oldest-user pick)`, () => {
    const code = src(file);
    assert.match(code, /resolveTenantActor\s*\(/, `${file} must resolve the actor via resolveTenantActor`);
    assert.doesNotMatch(
      code,
      /user\.findFirst\(\s*\{\s*orderBy:\s*\{\s*createdAt:\s*"asc"\s*\}\s*\}\s*\)/,
      `${file} must not keep the global oldest-user pick`,
    );
  });
}

// Phase C step 2b (C4) — cron scoping. Background jobs carry NO staff session, so
// under enforcement they resolve no tenant and every guarded query fails closed.
// Platform-global sweeps (backup, security) run in a trusted SYSTEM scope (guard
// bypass); the per-tenant business queues (journeys, automations, competitor-watch)
// run once per active tenant via runCronPerTenant. All dormant today.

// Whole-DB / platform-maintenance crons must wrap their work in withSystemScope,
// with the scope opening BEFORE the cross-tenant read (else the guarded reads
// inside fail closed under enforcement with no principal).
const SYSTEM_SCOPE_CRONS = [
  { file: "src/app/api/cron/backup/route.ts", work: "exportAllData(" },
  { file: "src/app/api/cron/security/route.ts", work: "runSecurityChecks(" },
] as const;
for (const { file, work } of SYSTEM_SCOPE_CRONS) {
  test(`${file}: platform sweep runs inside withSystemScope`, () => {
    const code = src(file);
    assert.match(code, /from "@\/lib\/tenantScopeEntry"/, `${file} must import from tenantScopeEntry`);
    assert.match(code, /withSystemScope\s*\(/, `${file} must call withSystemScope`);
    const scopeAt = code.indexOf("withSystemScope(");
    const workAt = code.indexOf(work);
    assert.ok(scopeAt >= 0 && workAt >= 0, `${file} must call withSystemScope and ${work}`);
    assert.ok(scopeAt < workAt, `${file}: withSystemScope must open before the platform sweep (${work})`);
  });
}

// Per-tenant business crons must run their slice through runCronPerTenant: dormant →
// one global sweep (unchanged), enforcing → one scoped run per active tenant.
const PER_TENANT_CRONS = [
  "src/app/api/cron/journeys/route.ts",
  "src/app/api/cron/automations/route.ts",
  "src/app/api/cron/competitor-watch/route.ts",
] as const;
for (const file of PER_TENANT_CRONS) {
  test(`${file}: business queue runs per-tenant via runCronPerTenant`, () => {
    const code = src(file);
    assert.match(code, /from "@\/lib\/tenantCron"/, `${file} must import from tenantCron`);
    assert.match(code, /runCronPerTenant\s*\(/, `${file} must run its slice via runCronPerTenant`);
  });
}

// The automations cron mixes per-tenant queues with platform-global maintenance
// (health + backup watchdog + ErrorLog retention). That maintenance must run ONCE
// in the system scope — NOT inside the per-tenant loop (ErrorLog is a global model;
// looping would repeat the same global delete per tenant).
test("src/app/api/cron/automations/route.ts: global ErrorLog cleanup runs in withSystemScope, invoked after the per-tenant loop and never suppressed by a tenant failure", () => {
  const code = src("src/app/api/cron/automations/route.ts");
  assert.match(code, /withSystemScope\s*\(/, "global maintenance must run in withSystemScope");
  // The maintenance is invoked AFTER the per-tenant fan-out (its call, not the
  // helper's definition, is what runs late), and it lives in a `finally` so a
  // failed tenant loop or tenant-enumeration error cannot skip it.
  const loopAt = code.indexOf("runCronPerTenant(");
  const maintCallAt = code.indexOf("runGlobalMaintenance()", loopAt);
  const sysAt = code.indexOf("withSystemScope(");
  const purgeAt = code.search(/errorLog\s*\n?\s*\.deleteMany|errorLog\s*\.deleteMany/);
  assert.ok(loopAt >= 0 && maintCallAt > loopAt, "runGlobalMaintenance() must be invoked after the per-tenant loop");
  assert.match(code, /finally\s*\{[\s\S]*runGlobalMaintenance\(\)/, "maintenance must run in a finally so a failed tenant loop can't skip it");
  assert.ok(purgeAt >= 0 && sysAt >= 0 && purgeAt > sysAt, "the ErrorLog purge must sit inside the withSystemScope block");
});

// C4 actor-pick sites (cron/queue + staff/portal cleanup, §2.4) attribute
// system-generated records via the tenant-aware resolver, not a global oldest-user
// pick — else a per-tenant queue stamps another tenant's user onto the record.
const C4_ACTOR_SITES = [
  "src/lib/automations.ts",
  "src/lib/journeyStepExecutor.ts",
  "src/lib/lifecycleJourneys.ts",
  "src/lib/serviceReminders.ts",
  "src/lib/reviewRequests.ts",
  "src/lib/imapSync.ts",
  "src/lib/surveys.ts",
  "src/app/actions/warranty.ts",
  "src/app/actions/portal.ts",
  "src/app/api/cron/automations/route.ts",
] as const;
for (const file of C4_ACTOR_SITES) {
  test(`${file}: cron/queue actor pick uses resolveTenantActor (not the global oldest-user pick)`, () => {
    const code = src(file);
    assert.match(code, /resolveTenantActor\s*\(/, `${file} must resolve the actor via resolveTenantActor`);
    assert.doesNotMatch(
      code,
      /user\.findFirst\(\s*\{\s*orderBy:\s*\{\s*createdAt:\s*"asc"\s*\}\s*\}\s*\)/,
      `${file} must not keep the global oldest-user pick`,
    );
  });
}
