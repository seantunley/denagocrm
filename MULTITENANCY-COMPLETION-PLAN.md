# Multi-Tenancy Completion Plan

**Date:** 2026-07-26
**Verified against:** current working tree (not memory, not PR descriptions) via a full code survey.
**One-line goal:** flip `tenantEnforcing()` from a hard-coded `return false` to *actually enforcing*, safely — fail-closed, RLS as the authoritative boundary under the app guard, verified as a constrained non-owner user of a second tenant.

---

## The single switch everything hangs on

`src/lib/tenantEnforcement.ts` → `tenantEnforcing()` is **hard-coded `false`** regardless of the `TENANT_ENFORCEMENT` env var. Even `TENANT_ENFORCEMENT=enforce` only *observes* (logs), never blocks. This one hook is read by the Prisma `$extends` guard, every scope-entry wrapper, and the login retry path. With it off, every code path is byte-for-byte the pre-tenancy app.

**Completing multi-tenancy = making it safe to turn that hook on.** Everything below is a prerequisite to that flip, in dependency order.

---

## Where it stands today (verified)

**DONE — built, shipped, active now**
- `Tenant` + `TenantMember` + `UserSession.tenantId` tables, seeded/backfilled to `tenant_denago_cpt` ("Denago Cape Town").
- Nullable, additive `tenantId String?` + `@@index` on ~all `schema.prisma` data models, backfilled.
- `TenantApiKey`, `ChannelIdentity` tables + backfill scripts.
- Session carries a `tid` claim; `UserSession.tenantId` stamped at login (`src/lib/auth.ts`).
- Audit logging resolves + stamps `tenantId` on `AuditLog` (`src/lib/audit.ts`).
- Scope-entry wiring present at **every** entry class: staff auth, portal, no-user token pages/routes, API-key routes, webhooks, per-tenant cron fan-out.

**WIRED-BUT-DORMANT — code exists, no-op behind `tenantEnforcing() === false`**
- AsyncLocalStorage scope carrier (`src/lib/tenantScope.ts`) + entry wrappers (`src/lib/tenantScopeEntry.ts`).
- Prisma `$extends` query guard (`src/lib/db.ts` `buildClient()`): would inject `where.tenantId`, stamp `data.tenantId`, refuse nested relation writes — currently returns args untouched.
- `TENANT_ENFORCEMENT` env parsing + `monitor`/`enforce` modes (`enforce` still only observes).

**MISSING / STUBBED — the actual remaining work**
- **Postgres RLS: entirely absent.** No `CREATE POLICY`, no `ENABLE ROW LEVEL SECURITY`, no session var. `tenantEnforcing()` is documented as pinned `false` until this exists.
- **No NOT NULL / FK to `Tenant`** on data-model `tenantId` (columns nullable, no constraint).
- **14 governance/journey models have no `tenantId` AND aren't in `GLOBAL_MODELS`** → under enforcement the opt-out guard would inject `where.tenantId` on a column that doesn't exist and **break every query** to them. The committed contract test reads only `schema.prisma`, so it doesn't catch this.
- **`User.role` is a global field** = cross-tenant superuser risk (flagged in `provisioning.ts`).
- **Tenant activation is deliberately inert** — `createTenant` makes a suspended tenant + disabled owner; there's no way to stand up a usable second tenant yet.
- **No cross-tenant leakage monitor, no integration test** exercising the *real* guarded client under enforcement.
- **Per-tenant uniqueness deferred** (`@@unique([tenantId, number])` on Quote/JobCard, per-tenant AppSetting keys).

---

## The 14 orphan models (the concrete blind spot)

No `tenantId`, not in `GLOBAL_MODELS` — must each be classified before the flip:

- **`governance.prisma`:** `SalesPipeline`, `Team`, `TeamMember`, `Role`, `Permission`, `RolePermission`, `UserRole`, `ForecastSnapshot`, `AuditEvent`
- **`journeys.prisma`:** `Journey`, `JourneyVersion`, `JourneyEvent`, `JourneyRun`, `JourneyStepLog`

`Journey*` are clearly tenant-owned data → need `tenantId`. The RBAC tables' fate depends on the decision below.

---

## Phases (ordered — each gates the next)

### Phase 0 — Land #221 · *in flight, blocked on prod DB reconciliation*
#221 ("Cover every prisma schema file in the tenant contract") makes the contract test glob all `prisma/*.prisma` **and** adds `UserRole.tenantId` (unique `(tenantId, userId, roleId)`). It's currently **red at Vercel `apply-migrations`** against the real DB → needs the backup-first governance-migration reconciliation (Sean, hands-on; *not* a code fix). Until this lands, the contract test can't be trusted to cover governance/journey models, so nothing downstream can be verified. **This is the first domino.**

### Phase 1 — Classify the 14 orphan models
Once the contract test globs `*.prisma` (Phase 0), those 14 go **red** and force a decision each: add `tenantId String?` + `@@index` (additive), or add to `GLOBAL_MODELS`. `Journey*` → tenant-scoped. RBAC tables → per Phase 2. Additive migrations only, backfill to `tenant_denago_cpt`.

### Phase 2 — RBAC decision *(gates what the guard must scope — decide early)*
Two forks:
- **(A) Shared global catalogue** — `Role`/`Permission`/`RolePermission` stay `GLOBAL_MODELS`; only `UserRole` is tenant-scoped (already the #221 shape). Smaller, ships now.
- **(B) Tenant-authored custom roles** — `Role` gains a nullable `tenantId` owner (null = system role), `RolePermission` scoped to match, per-tenant name uniqueness, plus a tenant-admin UI. Bigger; a real feature.

**Recommendation:** ship **(A)** now (aligns with #221), defer **(B)** as a later feature. **But regardless of A/B, move `User.role` → a per-tenant membership role on `TenantMember`** — the global `User.role` is a genuine cross-tenant superuser hole and shouldn't survive the flip.

### Phase 3 — Constraints: NOT NULL + FK to `Tenant`
With every tenant-owned model carrying `tenantId` and rows backfilled: (1) assert zero `NULL tenantId` on tenant-scoped tables, (2) migrate columns to `NOT NULL`, (3) add FK → `Tenant`. Additive-safe ordering, **prod backup first**. Structural-integrity layer beneath RLS.

### Phase 4 — RLS (the authoritative boundary)
Per tenant-owned table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, `CREATE POLICY … USING (tenantId = current_setting('app.current_tenant'))`. App sets `app.current_tenant` per transaction from the ALS scope. **Neon/pgbouncer caveat:** pooled connections — use `set_config(..., true)` *inside* the transaction (transaction-scoped), not a session var. Grant an explicit bypass to the system/backup role (backups + `withSystemScope` cross-tenant work must still function). This is what `tenantEnforcing()` is waiting on.

### Phase 5 — Tenant activation flow
Replace the deliberately-inert `createTenant` (suspended tenant + disabled owner) with a real activation: activate tenant, enable owner login, grant modules. Needed to stand up **tenant B** to actually test isolation against.

### Phase 6 — The flip + verification
Change `tenantEnforcing()` to honour `tenantMode() === "enforce"`. Roll out **off → monitor → enforce**, one environment at a time (dev → the flip is the highest-blast-radius change in the app). Before enforce anywhere:
- **Integration test on the real guarded `prisma` client** under enforcement with two tenants — assert cross-tenant read *and* write fail closed (survey confirms none exists today).
- **Cross-tenant leakage monitor** (none exists today).
- **Verify as a constrained non-owner user of tenant B** that tenant A's data is invisible across every surface (leads, quotes, signing, journeys, audit, reports).
- **Per-tenant uniqueness** migrations (`@@unique([tenantId, number])` on Quote/JobCard; per-tenant AppSetting). The `automationEventBridge.ts` number-lookup leak vector from the #200 review closes here.

---

## Standing risk notes
- **prod = live business data since 2026-07-06.** Every migration additive; **backup first**; no destructive ops.
- **Runner drift** (prior incident: a migration marked applied whose SQL never ran) — Phase 3/4 DDL must be verified *actually applied*, not just recorded. Reconcile drift before adding constraints on top.
- **#206 lesson, doubled:** stage the enforcement flip monitor-first, one env at a time, watch each deploy to green. This change can lock every user out if it fails closed on a governance table (exactly the 14-orphan-model trap).
- **CI gap that bit us before:** `next build` + a real 2-tenant enforcement integration test must run in CI, or a build-only / semantic break escapes to the Vercel deploy again.
