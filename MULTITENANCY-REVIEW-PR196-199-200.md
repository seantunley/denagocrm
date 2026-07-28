# Multi-Tenancy Review — PRs #196, #199, #200

**Date:** 2026-07-24
**What this file is:** tenant-isolation review of three open PRs, checked against this repo's established conventions (tenantId+index on every tenant-owned model, the opt-out `db.ts` guard, `resolveTenantActor`/`resolveTenantMemberUser` for staff picks, `runCronPerTenant`/`withSystemScope` for background jobs, no unjustified `basePrisma`). Verified against actual code, not PR descriptions.

---

## PR #199 — Surface Marketing Journeys from the Automations page

**No tenant relevance.** One file, +17/-1: adds a UI card + link on the Automations page (`href="/journeys"`), gated by the same `isOwner` check already used elsewhere on that page. No schema, query, or permission changes. Nothing to flag.

---

## PR #196 — Add dedicated test-drive and demo-fleet operations

**Verdict: solid.** Every check passed.

- New models (`DemoVehicle`, `TestDriveBooking`, `TestDriveAsset`) all carry `tenantId String?` + index, matching the `Campaign`/`Quote`/`JobCard` convention — and since the guard is **opt-out** (`isTenantScopedModel` in `tenantGuard.ts` treats anything not explicitly listed as `GLOBAL_MODELS` as tenant-scoped), they're auto-guarded the moment they're queried.
- No global `user.findFirst`/`findMany` — staff pickers use `listTenantStaff()`, assignee validation uses `resolveTenantMemberUser` via a new `requireAssignableStaff` helper, applied to both the primary and accompanying salesperson, on both create and update.
- All reads/writes go through the guarded `prisma` client; the only `basePrisma` calls are inside the pre-existing, already-justified `tenantActor.ts` helpers.
- Record access reuses the same accessible-contact/accessible-lead pattern as leads/quotes/job cards, plus its own `accessibleTestDriveWhere`/`canAccessTestDriveBooking`.
- Soft-delete registration is correct, including correctly **omitting** `TestDriveAsset` (no `deletedAt` column, cascade-deleted with its booking).
- Migrations are additive-only, and — notably — the raw-SQL backfill and the Activity↔booking sync trigger both explicitly propagate `tenantId`, so rows created outside Prisma (by the trigger) still carry the right tenant.

**Two non-tenancy notes for the author** (build risk / functional correctness, not isolation bugs):
- New models live in a sibling `prisma/testdrive.prisma` file — PR itself flags Prisma generation as unverified; confirm `prisma generate` picks it up before stacking more work on it.
- The Activity→booking sync trigger's `ON CONFLICT DO UPDATE` can overwrite app-set fields (branch/salesperson/status) — worth a functional test, not a tenant issue.

---

## PR #200 — Automation platform (stacked on #196)

**Verdict: solid and clearly built with the enforcement flip in mind, with two real narrow gaps and one latent hazard — none of which leak data today.**

The largest surface reviewed: ~18 new side-effecting actions, many new triggers, a cron-driven outbox worker, and Xero/webhook integrations. Strong points:
- All 4 new models (`AutomationOutbox`, `AutomationApprovalRequest`, `StockTransferRequest`, + the Journey tables gaining `tenantId`) follow convention.
- The one pre-existing global `prisma.user.findMany` in the Journeys builder was **removed** and replaced with `listTenantStaff()`.
- Cron work runs inside the existing per-tenant `runCronPerTenant` mechanism — no new plain global sweep.
- No new inbound/public webhook route was added (the webhook action is outbound-only, with real SSRF protections: HTTPS-only, private-range + DNS block, no redirects, timeout).
- Migrations are additive-only.

**Gap 1 — `assign_team` action** (`journeyPlatformActions.ts:3352-3377`): every sibling assignee action (`assign_user`, `escalate`, etc.) validates the target via `resolveTenantMemberUser`/`resolveTenantActor`. `assign_team` doesn't — it reads `Team.managerId`/`TeamMember` and writes straight to `lead.assignedToId`/`contact.ownerId` with no membership check. Compounding this: `Team`/`TeamMember` have **no `tenantId` column at all**, yet the opt-out guard treats them as tenant-scoped. Today this is harmless (dormant) and it **fails closed** under enforcement (the query would crash, not leak) — but it's the one action that skipped the discipline the rest of the PR applied, and the new team-picker in the Journeys builder is unscoped. Needs: either add `tenantId` to `Team`/`TeamMember` or add them to `GLOBAL_MODELS`, plus a membership check in `assign_team`.

**Gap 2 — `setPortalAccess`** (`journeyPlatformActions.ts:3430-3457`): accepts a caller-supplied `viewerContactId`/`targetId` from step config and inserts a grant without confirming those contacts belong to the acting tenant. The row is tagged with the correct `tenantId` (so a read-side filter contains exposure), but a misconfigured or hostile journey step could reference an arbitrary contact id. Low severity (owner-authored config), but it's the one write here trusting a caller-supplied id without a scoped re-read.

**Latent hazard, not a bug yet** — `automationEventBridge.ts` enriches audit events with `quote.findUnique({ where: { number } })` / `jobCard.findUnique({ where: { number } })` on the **unguarded** `basePrisma` transaction. Safe only because `Quote.number`/`JobCard.number` are still globally unique. The schema already documents a planned `@@unique([tenantId, number])` migration (per-tenant document numbering, decided earlier in this project) — when that lands, this number-based lookup becomes a cross-tenant leak vector. Flag as a required follow-up alongside that migration, not urgent now.

**Minor, non-tenancy**: `validateAutomationWebhookUrl` resolves DNS for SSRF validation, then `fetch` resolves independently — a DNS-rebinding TOCTOU window. Worth fixing, unrelated to tenant isolation.

---

## Recommended action

- #196: no blocking issues, safe to merge as a base for #200.
- #200: request the `assign_team` fix (add tenant-member validation + resolve the `Team`/`TeamMember` tenantId gap) and a `setPortalAccess` contact-ownership check before merge; track the audit-bridge number-lookup as a required follow-up tied to the per-tenant document-numbering migration.

**✅ Fixed directly on PR #200's branch (commit `a8b9ef7`, PR comment posted):**
- `assign_team` now validates the resolved assignee via `resolveTenantMemberUser` before writing, matching every sibling action.
- `Team`/`TeamMember` added to `GLOBAL_MODELS` (correct classification today — no `tenantId` column, not tenant-partitioned).
- `setPortalAccess` now validates `viewerContactId`/`targetId` belong to the acting tenant before minting a grant.
- **Bonus finding while fixing this**: `tenantSchemaContract.test.ts` (the activation-safety contract) only ever read `prisma/schema.prisma`, silently missing every model in the multi-file schema fragments (`governance.prisma`, `journeys.prisma`, `testdrive.prisma`) — exactly how `Team`/`TeamMember`'s missing `tenantId` went undetected. Fixed to read all `prisma/*.prisma` files, which surfaced 7 more pre-existing, never-classified models (`Role`, `Permission`, `RolePermission`, `UserRole`, `SalesPipeline`, `ForecastSnapshot`, `AuditEvent`) — parked in `PENDING`, not silently decided, same pattern `AppSetting` went through.
- Not fixed (pre-existing, unrelated, confirmed via before/after diff not introduced by this fix): ~9 typecheck errors on the branch (stale `.next/dev/types` route-validator cache, a few null/undefined and nonexistent-field mismatches in `journeys.ts`/`journeyEvents.ts`/`journeyScheduling.ts`/`testDriveMetrics.ts`). Still need addressing before merge, by whoever owns the rest of that PR.
- The audit-bridge number-lookup hazard (`automationEventBridge.ts`) was **not** fixed — it's not actionable yet (tied to a migration that hasn't landed) and remains a tracked follow-up.
