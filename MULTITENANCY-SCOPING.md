# DenagoCRM — Multi-Tenancy Scoping (adapted to this codebase)

Status: **foundation building — see the "Status — PAUSED" section at the bottom for the authoritative current state.** Derived from the pasted SaaS roadmap, adjusted for this codebase (live prod, Prisma dual-client, mature RBAC) and the decisions taken 2026-07-21: **isolation-first substrate**, and **CI is the gate** (Actions billing restored; `test:rbac`/`test:integrity` now run green).

> ⚠️ **Sections 1–5 below predate the build and are now partly stale:** the final naming is **`Tenant` / `tenantId` / `TenantMember`** (not "Organization"), and tenant resolution is **FAIL-CLOSED** — a membership-less user gets `null` (denied), **never** a silent "default to the Denago org" as some sentences below still say. The bottom Status section reflects what actually shipped.

---

## 1. The model decision — resolved as "isolation-first, sharing later"

The business question (Denago dealers sharing a cart catalog vs. arbitrary
unrelated companies) does **not** need to be answered before we start, because the
foundation is identical either way: **every tenant owns its data by default.**

- Core schema: every tenant-owned table gets a non-null `tenantId`, *including*
  products/parts/stock. Full isolation is the safe default and the hardest to leak.
- "Shared catalog" (the Denago OEM→dealer case) is **not** a schema property. It's an
  opt-in relationship layered on later (a parent-OEM tenant owns the catalog; child
  dealer tenants get read access through an explicit, audited sharing table).
- **The only thing that must be decided before PR6** (module data) is whether
  Denago's own dealers share a catalog. Everything before PR6 is model-agnostic.

This is the single most important call and it *unblocks* rather than blocks.

### 1a. Isolation architecture — DECIDED 2026-07-22: **shared DB + Postgres RLS** (not database-per-tenant)

One Postgres database. Tenant-owned tables carry a `tenantId`; **Row-Level Security**
is the fail-closed backstop (`tenantId = current_setting('app.tenant_id')`, set per
request). App-level scoping is the first line; RLS is the net beneath it.

**Why, for this codebase specifically:**
- **Shared stock needs it.** The Denago model is OEM→dealers sharing one cart
  catalog with walled customer data. Shared rows + per-tenant rows live naturally in
  the same tables. DB-per-tenant has no clean home for shared stock (it forces a
  hybrid: a shared catalog DB *plus* per-tenant DBs).
- **One migration path.** We just hardened the single-DB migration runner after a
  live outage (#151 integrity guard, fail-closed). DB-per-tenant multiplies that
  risk by N — every schema change runs against every tenant DB, any one can drift.
- **Vercel + Neon realities.** Per-request routing to a different DB per tenant
  means many connection pools against Neon's connection cap. One pooled connection
  is simple and proven. Provisioning is a row insert, not a DB spin-up; cross-tenant
  admin/reporting is trivial; idle tenants cost nothing extra.
- **RLS ≈ physical isolation for our needs.** Enforced in the database, below the
  app, fail-closed — an app bug can't leak across tenants.

**DB-per-tenant was considered and deferred**, not dismissed: it gives physical
isolation, per-tenant backup/restore, and a cleaner compliance story, and suits a
*few large compliance-heavy* tenants. It's reserved for the graduation path below.

### 1b. Graduation path — moving ONE tenant to its own DB later (future, documented on request)

The shared-DB model is a **superset**: any single tenant can later be "graduated" to
its own physical database **without changing the model for everyone else**. Trigger
cases: an enterprise/compliance contract, data-residency, or a genuine noisy-neighbour.

How (when/if the need arises):
1. Create a dedicated Neon database (branch or new project) for tenant *X*.
2. Copy tenant *X*'s rows into it (`WHERE tenantId = X` per table) — the schema is
   identical, so it's a straight extract/load.
3. Add a **per-tenant connection resolver**: a `tenantId → DATABASE_URL` map; requests
   for *X* use *X*'s DB, everyone else stays on the shared DB. This is the *only* app
   change, and it's small because scoping already flows through the `db.ts` guard.
4. Keep the `tenantId` column + RLS in *X*'s DB — harmless in a single-tenant DB, and
   it keeps the code path identical.
5. **Shared stock stays in the shared/OEM DB**; the graduated tenant reads the catalog
   through the existing sharing mechanism (cross-DB read or a replicated read-only
   catalog). This is the one piece to design at graduation time, not before.

Consequence: **we do not need to pick the extreme now.** Start shared-DB + RLS; keep
the door open to graduate specific tenants without a rewrite.

---

## 2. How this differs from the generic roadmap (codebase-specific)

1. **`tenantDb` = extend the existing Prisma extension, not a new layer.**
   [src/lib/db.ts](src/lib/db.ts) already runs a client extension that injects
   `deletedAt: null` into every query/mutation (`prisma` filtered vs `basePrisma`
   raw). Tenant scoping is the *same mechanism*: inject `tenantId` in the same guard.
   `platformDb` = today's `basePrisma`. This turns roadmap-PR4 from "new DB layer"
   into "add one clause to a proven guard."

2. **Fail closed, from PR4.** A tenant-scoped query with **no** tenant context in
   scope must **throw**, never silently return all rows. This one rule prevents most
   accidental cross-tenant reads while the rest is built.

3. **Live-prod migrations are the risk, so every schema PR is 3 steps + additive:**
   add nullable `tenantId` → backfill to the Denago org → set `NOT NULL` + swap the
   unique index (`Quote.number` global → `@@unique([tenantId, number])`). Never a
   single destructive migration. **Backup before each.** Dropping/re-adding a unique
   index on a populated prod table is where outages live — do it in its own small PR.

4. **RBAC is already mature — treat roadmap-PR5 as the highest-risk item, sequenced
   last-ish and behind a flag.** We just hardened `Role`/`RolePermission`/`UserRole`
   this week; moving roles onto `OrganizationMembership` rewires every
   `requirePermission`/session path. Isolation tests must be green first.

5. **Isolation leaks live in the unauthenticated corners** — public signing/portal/
   OTP tokens and the *global* cron jobs (backup, automations, journeys). These
   resolve records without a logged-in user, so the tenant guard must derive tenant
   from the token/record and fail closed. Don't leave entirely to the end.

6. **Sub-slice the big PRs.** Roadmap-PR3 (11 tables + backfill + unique changes) is
   several small PRs here, grouped by table cluster.

---

## 3. Build order (small PRs, each off `main`, CI-gated)

Legend: **[additive]** = safe/reversible; **[risk]** = touches live unique indexes
or auth — its own PR, backup first.

### Phase A — Foundation (model-agnostic, behavior-preserving)
- **PR1 [additive]** `Organization` + `OrganizationMembership` + `UserSession.organizationId`
  (nullable). Seed **one** org ("Denago Cape Town") for existing data; add all users
  as members; backfill sessions. Add an active-org accessor to the request context
  that **defaults to the Denago org**, so nothing changes behavior. *Outcome: every
  session has a tenant; app runs exactly as before.*
- **PR2 [additive]** Tenant settings + modules: `OrganizationSetting`,
  `OrganizationModule`; change `isModuleEnabled(moduleId)` →
  `isModuleEnabled(orgId, moduleId)` reading the tenant's row (seeded from today's
  global values). Keep three concepts distinct: **plan entitlement** vs **module
  enabled** vs **user permission**.

### Phase B — Data isolation (sub-sliced; each: nullable → backfill → enforce)
- **PR3a [additive→risk]** People: `Contact`, `Lead`, `Activity`, `Communication`.
- **PR3b [additive→risk]** Sales: `Quote` (+ `@@unique([tenantId, number])`),
  `Pipeline`, `PipelineStage`, `Document`.
- **PR3c [additive→risk]** Platform: `AuditLog`, `Team`, `Role`.
- Each PR: add nullable `tenantId`, backfill to Denago org, then a follow-up flips
  `NOT NULL` + swaps unique/index — only after the backfill is confirmed on prod.

### Phase C — Enforcement
- **PR4 [risk]** Tenant-scoped DB access: extend the db.ts guard to inject `tenantId`
  from request context; **fail closed** when absent. `platformDb` (= basePrisma) is
  the only escape hatch, allowed for: migrations, provisioning, support admin,
  cross-tenant platform reporting. Everything tenant-facing switches to the guarded
  client. **This is the PR the isolation tests must cover exhaustively.**

### Phase D — Roles, modules, infra
- **PR5 [risk]** Roles/permissions move `User` → `OrganizationMembership` (a person =
  owner in A, salesperson in B). Deprecate `User.role` / `User.modules`. Flagged,
  isolation-green first.
- **PR6** Tenant-scope module tables (automotive/workshop, stock/commerce, help desk,
  inbox, marketing, portal, automation, signing workflows). **← the Denago-dealer
  shared-catalog decision lands here.**
- **PR7** Infra isolation: storage paths (`tenants/{id}/…`), per-tenant integration
  credentials (email/WhatsApp/Meta/Google/Telegram/Sage), webhooks, cron (iterate
  per tenant), search, AI memory, audit, public signing/portal tokens.
- **PR8** Postgres RLS as the final net: `SET LOCAL app.tenant_id` per request;
  policies enforce `tenantId = current_setting('app.tenant_id')`. App scoping first,
  RLS as backstop — never the first line.

Only after Phase A–D + isolation tests green: signup, trials, billing, suspension,
custom domains, white-label.

---

## 4. Safety gate (now automated — this is new as of today)

CI (`.github/workflows/security-rbac-ci.yml`) spins up a **disposable Postgres**,
applies migrations, seeds, then runs typecheck/lint/unit + governance + `test:security`
+ `test:rbac` + `test:integrity`. It never touches prod. As of PR #135 all of it is
green.

Add **`scripts/test-tenant-isolation.ts`** (a new `test:tenant` step) that seeds
**Tenant A** + **Tenant B** and asserts Tenant A canNOT, for every surface:
list B's records · fetch B by guessed id · update/delete B · link its records to B
parents · find B via search · download B's files · process B's jobs · use B's public
tokens. This suite is the definition of done and gates every Phase B+ PR.

**Definition of done:** the existing Denago business runs as Tenant A, a synthetic
Tenant B runs in the same DB, and automated tests prove neither can read, change,
search, download, or process the other's data.

---

## 5. Immediate next step

**PR1** — additive, behavior-preserving. Nothing about it depends on the deferred
catalog decision. Once approved I implement: schema models + a 3-part additive
migration (create tables → seed Denago org + memberships → backfill
`UserSession.organizationId`), the org-context accessor defaulting to Denago, and an
isolation-test skeleton. Backup taken before the migration lands on prod.

---

## 6. Where tenants get set up — provisioning & admin levels (current, 2026-07-21)

Creating a tenant is a surface we have **not** built yet. It splits into two admin
levels that must stay distinct:

- **Tenant admin** — today's `/settings` (owner-gated, scoped *within* a tenant):
  users, pipelines, integrations. A dealer-owner lives here.
- **Platform / operator admin** — a NEW surface that sits *above* tenants: create /
  suspend tenants, assign plan + modules, invite a tenant's first owner,
  support-impersonate, cross-tenant reporting. This is the SaaS operator (Denago-as-
  vendor), NOT a tenant role. It runs on `platformDb` (the unscoped `basePrisma`
  escape hatch) and is gated by a **platform-superadmin** flag that is NOT a
  `TenantMember` — otherwise a dealer-owner could mint tenants. Tenant *creation*
  lives here.

**Three horizons:**
1. **Now / near-term — a provisioning helper + CLI.** Extend `src/lib/provisioning.ts`
   with `createTenant({ name, slug, ownerEmail })` (Tenant + first owner-membership +
   default modules/settings, transactional) and a `scripts/create-tenant.ts` wrapper.
   This is how we stand up **Tenant B** for the isolation suite and onboard the first
   real dealer by hand — no UI, no auth risk, runs against the dev branch. It is the
   SINGLE source of truth the future UI and the isolation tests both call.
2. **Then — a platform-admin area** (`/platform` or `/admin/tenants`,
   platform-superadmin gated). Same `createTenant` underneath, plus suspend/reactivate
   (`Tenant.active` — already honoured by the fail-closed `resolveActingTenant`) and
   plan/module assignment. Lands around PR2 / PR6, once enforcement makes it safe.
3. **Much later — self-service signup.** Public flow that creates a tenant + owner.
   Deferred until AFTER isolation is proven (alongside billing/trials).

**Connects to work already in flight:** `createTenant` sets up a tenant's *first*
owner; inviting *additional* users into an existing tenant is the add-membership
/ invitation flow the review flagged (needed before the 2nd real tenant). Tenant
suspension is free once `active` toggling has an admin surface.

**Recommended first post-merge step:** build `createTenant` + `scripts/create-tenant.ts`.
It's tiny, safe (additive, no auth path), and it is the prerequisite for the
Tenant-A-vs-Tenant-B isolation suite — the safety gate for all of Phase B.

**Before tenant-administration endpoints ship (deferred from #137 review, notes 1 & 3):**
- Replace the provisioning-only `FOR UPDATE` with ONE shared locking protocol (advisory
  lock, or lock the owner/tenant `User`/`Tenant` row) used across BOTH provisioning
  and membership/tenant mutation — `FOR UPDATE` doesn't lock absent rows, so it can't
  serialise a *new* membership being added or a tenant being *activated*.
- Add a real **two-transaction lock test** proving a concurrent suspension / membership
  deletion actually blocks and is re-evaluated (current tests prove outcomes + rollback
  structure, not live blocking).

---

## Status — PAUSED 2026-07-21 (awaiting reviews)

**Open PRs (all CI-green unless noted):**
- **Security sweep — ALL MERGED to `main` 2026-07-21** (#130 case-upload IDOR · #131 research IDOR *[review defect fixed: contact write requires `contacts.edit`, links only the lead's own contact]* · #132 Telegram webhook fail-closed · #133 opt-out/push scoping · #134 library route parity · #135 CI `server-only` fix). Done + deployed.
- **Multi-tenancy PR1 = #136** — tenant foundation: `Tenant` / `TenantMember` / `UserSession.tenantId`; migration `20260721130000_tenant_foundation` (seeds `tenant_denago_cpt`, backfills users+sessions); `pickActiveTenant` fail-closed; unit + integrity invariants. Re-reviewed after the fail-closed correction. Green.
- **Multi-tenancy PR1b = #137** — provisioning: `createUser` grants a `TenantMember` in the owner's tenant (transactional); `getActiveTenantId`; "every user has a tenant" invariant. **Stacked on #136.** Green.

**Decisions locked:**
- Isolation-first substrate; shared-catalog deferred to PR6.
- Naming: `Tenant` / `tenantId` / `TenantMember`. Founding tenant id `tenant_denago_cpt` ("Denago Cape Town").
- Fail-closed: no membership ⇒ `null` tenant ⇒ denied. `DEFAULT_TENANT_ID` is **provisioning-only**, never a resolver fallback.
- Safety gate is CI (billing restored) — DB rbac/integrity suites run on every PR; the tenant invariants live in `scripts/test-integrity.ts`.

**Next when resuming (after #136 → #137 merge):**
- **First (non-auth, safe): `createTenant` helper + `scripts/create-tenant.ts`** — see §6. Enables standing up Tenant B and writing the Tenant-A-vs-B isolation suite (the Phase-B safety gate). Do this first.
- **PR1c (sensitive auth, deferred):** wire the active tenant into the session/JWT at login and **reject / route membership-less users to provisioning**. On a settled foundation only.
- Then, in order: **PR2** tenant-scoped settings/modules (`isModuleEnabled(tenantId, …)`) → **Phase B** `tenantId` on data models (sub-sliced 3a/3b/3c, each nullable→backfill→enforce, backup first) → **PR4** extend the `db.ts` guard to inject `tenantId`, fail-closed → **PR5** roles→membership → **PR6** module data + the shared-catalog decision → **PR7** infra isolation → **PR8** Postgres RLS.

**Merge order:** security PRs any order; multi-tenancy **#136 then #137**. #136/#137 read no tenant yet, so both are behaviour-preserving.
