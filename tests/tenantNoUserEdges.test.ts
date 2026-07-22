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
  { file: "src/app/s/[token]/page.tsx", read: "prisma.surveyResponse.findUnique", resolver: "resolveSurveyResponseTenant" },
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
// lives in submitResponse (lib/surveys.ts), so the action must establish the tenant
// scope before delegating to it.
test("src/app/actions/surveys.ts: public survey submission wraps submitResponse in a tenant scope", () => {
  const code = src("src/app/actions/surveys.ts");
  assert.match(code, /from "@\/lib\/tenantScopeEntry"/, "must import withTokenTenantScope");
  assert.match(code, /from "@\/lib\/tokenTenant"/, "must import resolveSurveyResponseTenant");
  const scopeAt = code.indexOf("withTokenTenantScope(");
  const workAt = code.indexOf("submitResponse(token");
  assert.ok(scopeAt >= 0, "submitSurveyResponse must call withTokenTenantScope");
  assert.ok(workAt >= 0, "submitSurveyResponse must delegate to submitResponse(token, …)");
  assert.ok(
    scopeAt < workAt,
    "submitSurveyResponse must establish the tenant scope before calling submitResponse (else the guarded read inside dead-locks)",
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
  test(`${file}: staff list scoped to the current tenant`, () => {
    assert.match(src(file), /currentTenantUserWhere\s*\(/, `${file} must scope its user list with currentTenantUserWhere`);
  });
}
