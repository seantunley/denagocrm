# Next Steps — Multi-Tenancy (continue here on any machine)

**Last updated:** 2026-07-27. This file is committed to git specifically so it survives a machine switch — check it out, read this, and you have full context.

---

## Where things stand, in one sentence

Multi-tenancy is **built and PR'd but not merged**: every table is classified, the owner can never be locked out, several real cross-tenant bugs were found and fixed, per-tenant integration credentials exist as infrastructure, custom roles are tenant-authored, and Postgres RLS is staged (dormant). **Nothing is enforced yet** — `tenantEnforcing()` is still hard-coded `false`, so production behaves exactly as it did before any of this started. The remaining work is: merge the PRs, then build the actual enforcement flip (session-var wiring + RLS tightening + monitor-mode rollout), which is deliberately **not** done yet — it's the one genuinely high-risk step left.

---

## Open PRs — READ THE OVERLAP NOTE FIRST

| PR | Branch | Base | Status |
|---|---|---|---|
| **#227** | `fix/tenant-governance-auditevent-backfill` | `main` | ✅ Ready. The main bundle — see contents below. 394/394 tests, `tsc` clean. |
| **#228** | `feat/rls-scaffolding` | `#227`'s branch (stacked) | ✅ Ready. RLS scaffolding, dormant (see its own section below). |
| **#230** | `feat/tenant-credential-overrides-ui` | `#227`'s branch (stacked) | ✅ Ready. Tenant-facing settings UI for the per-tenant credential overrides added in #227. 402/402 tests, `tsc` clean, reviewed. |
| **#221** | `fix/tenant-contract-glob` | `main` | ⚠️ **Superseded by #227** (which branched from and extended it). Do not merge separately — **close this once #227 merges**, or the same commits will conflict. |
| **#226** | `feat/tenant-admin-ui` | `main` | ⚠️ **Superseded by #227** (which merged this branch in). Do not merge separately — **close this once #227 merges**. |

**Recommended merge order:** `#227` first (into `main` — this is a real prod deploy; its migrations are additive/idempotent and the governance ones were already reconciled directly against prod earlier, so it should be a no-op there, but treat it like any other prod deploy: merge, then watch the Vercel build to green before doing anything else). Then `#228` and `#230` (both rebase onto `main` automatically once #227 merges, since both are stacked on its branch — merge them in either order, each is independent of the other). Then close `#221` and `#226`.

**Standing rule, unchanged:** never merge to `main` without Sean's explicit go — merging to `main` deploys to prod (`crm.denagocpt.co.za`, live business data). If picking this up mid-session and unsure whether Sean already gave that go, ask again rather than assume a prior "continue" covers a specific merge.

---

## What's IN #227 (the foundation bundle)

1. **Governance classification** — `SalesPipeline`/`Team`/`TeamMember`/`UserRole`/`ForecastSnapshot`/`AuditEvent` get `tenantId`. `UserRole` gets a tenant-aware surrogate PK. *(These two migrations were already applied directly to prod earlier tonight — backup taken first, root cause was `AuditEvent`'s append-only trigger blocking the backfill `UPDATE`, fixed by disabling/re-enabling that trigger around the one statement. `#227`'s migrations match what's already on prod, so this part of the deploy is a no-op.)*
2. **Journey classification** — `Journey*` models get `tenantId`. This cleared the schema contract's last `PENDING` entry — **every model is now explicitly global or tenant-scoped**, verified by `tests/tenantSchemaContract.test.ts`.
3. **Standalone platform console** at `/platform/tenants` — deliberately outside the CRM's `(app)` route group, owner-only. Lets you create a tenant (always created **inert**: suspended, owner disabled, no modules — cannot log in) and manage membership. Activation is refused until `tenantEnforcing()` is true.
4. **Lockout-proofing** — the founding tenant (`tenant_denago_cpt`) can never be suspended (enforced at the source, not gated). At login, under enforcement, the global `owner` self-heals founding-tenant membership and always resolves a session (falls back to the founding tenant rather than failing). If an owner still somehow has no active tenant scope, they get a **no-scope** (never system-scope) session that lands them on `/platform/tenants` instead of a broken CRM shell — CRM data reads still fail closed, only the console works.
5. **Raw-SQL readiness fixes** — real bugs found by a 4-part audit and fixed:
   - Audit-log CSV export had no tenant filter (would have exported every tenant's data).
   - A case-upload file route let a permissive `view_all` holder fetch another tenant's attachment by ID.
   - `Team`/`TeamMember` staff UI/actions were unscoped.
   - `googleReviews.ts` wrote via unscoped `basePrisma` (rows would go invisible under enforcement).
   - Nine portal actions (notifications, cases, warranty claims, profile changes, preferences, access grants) computed a tenant context but never wrote it to the INSERT — same defect class as a bug found in `audit.ts`'s `AuditEvent` insert, all fixed.
   - `getUserPermissions` unioned a user's permissions across every tenant they belong to instead of scoping to the active one.
6. **Per-tenant integration credentials** — new `TenantIntegrationCredential` table + `resolveTenantCredential(tenantId, key)` (in `src/lib/settings.ts`). Prefers a tenant's own override, falls back to the existing global `AppSetting` row. **With zero override rows (true today), every call site is byte-for-byte identical to before** — ships with no behavior change. Wired into WhatsApp, Messenger/Instagram, Telegram (credential only — see gap below), SMTP, IMAP, BulkSMS, Google Reviews.
7. **Tenant-authored custom roles** (per Sean's explicit decision 2026-07-27) — `Role`/`RolePermission` get a nullable `tenantId` (`null` = system/shared role, unaffected; non-null = one tenant's own). Name uniqueness needed two **hand-written partial unique indexes** (system names unique among themselves, tenant names unique per tenant) since Prisma can't express a partial index and a naive composite unique would let two system roles collide on `NULL`. `createRole` stamps the caller's tenant; editing a role or assigning it is scoped to the caller's own tenant (system roles stay editable by everyone) once enforcement is on.

**Known gaps intentionally NOT closed in #227** (tracked, not forgotten):
- **Telegram has no inbound tenant routing** — no `ChannelIdentity` mapping exists for it (unlike WhatsApp/Messenger/Instagram). Its credential resolver is wired, but a message can't yet be attributed to a specific tenant. Needs the same `ChannelIdentity` treatment as the other channels if Telegram matters for multi-tenant use.
- **Per-tenant credential settings UI** — the resolver + write-side (`putTenantCredential`) exist; the actual settings page for a tenant admin to set their own override is a separate PR (see below).

---

## What's IN #228 (RLS scaffolding) — READ THIS BEFORE TOUCHING RLS AGAIN

Enables Postgres Row-Level Security on all 120 tenant-scoped tables (generated programmatically from the schema, verified against prod's real table names) with a **permissive placeholder policy** (`USING (true)`), and deliberately **without** `FORCE ROW LEVEL SECURITY`.

**Why this is safe:** Postgres exempts a table's *owning* role from RLS unless `FORCE` is also applied, and the app's DB connection is that owning role — so `ENABLE` alone is a genuine no-op today. Even if `FORCE` were added carelessly later, the policy still allows every row until tightened.

**Why this is NOT real enforcement, and what's still needed, in order:**
1. The app must `SET` a session-local Postgres variable (e.g. `app.current_tenant`) at the start of every request/transaction, from the existing `AsyncLocalStorage` scope (`src/lib/tenantScope.ts`). **Nothing sets this today** — this is real work, not yet started.
2. A verified bypass path for legitimate cross-tenant system/cron work (`withSystemScope`, backups) — e.g. a dedicated Postgres role with `BYPASSRLS`.
3. Each placeholder policy tightened from `USING (true)` to a real `tenantId`-matching predicate.
4. Only then: `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, per table.
5. Roll out 1–4 **monitor-mode first, against a throwaway/dev database with two real tenants seeded** — prove cross-tenant reads/writes fail closed — before ever touching prod.

**Critical distinction from everything else in this project:** RLS is NOT gated by `tenantEnforcing()`. That flag is an application-layer concept; Postgres has no idea it exists. RLS needs its own separate off/monitor/enforce discipline, built from scratch, before `FORCE` is ever added anywhere near prod.

---

## Per-tenant credential settings UI — done, PR #230

A new dedicated settings page (`/settings/integration-overrides`, NOT the existing 1412-line global settings monolith — confirmed zero diff on that file) letting a tenant's own owner set/clear their own override for each of the 7 integration credentials, using their own active tenant (no tenant-picker needed — it's always "my tenant", resolved server-side via `getActiveTenantId()`). Owner-gated at both the page and both server actions (actions are POST-reachable directly). Never renders a decrypted secret back to the browser — only an "override set / using platform default" boolean. 402/402 tests, `tsc` clean, reviewed line-by-line before pushing.

---

## The actual enforcement flip — NOT started, here's the real shape of it

This is the one piece of real, unstarted work, and it's the highest-risk step in the whole project. In order:

1. **Wire the session variable.** Every request/transaction needs to `SET LOCAL app.current_tenant = '<id>'` (or similar) from the ALS scope in `tenantScope.ts`, so RLS policies (once tightened) have something to check against. This likely means hooking into the Prisma `$extends` layer in `src/lib/db.ts` (the same place the app-layer guard already lives) so every query issues the `SET LOCAL` first, inside the same transaction/connection.
2. **Tighten the RLS policies** from `USING (true)` to `USING ("tenantId" = current_setting('app.current_tenant', true))` (exact form needs care around NULL handling for genuinely-global historic rows, and the bypass path below).
3. **Bypass path for system/cron work** — `withSystemScope` callers (backups, cross-tenant cron slices) need a way to see everything. Likely a dedicated Postgres role with `BYPASSRLS` used only for those code paths, not the app's normal connection.
4. **Change `tenantEnforcing()`** (`src/lib/tenantEnforcement.ts`) to actually honor `tenantMode()` instead of hard-returning `false`.
5. **Test with two real tenants** on a throwaway/dev database first. Verify: cross-tenant reads return nothing, cross-tenant writes fail, the owner lockout-proofing actually works (suspend a tenant, confirm the owner still logs in and lands on `/platform/tenants`, confirm they see zero CRM data with no scope), inbound social/email routing still lands on the right tenant, integration credential overrides actually get used.
6. **Roll out `off → monitor → enforce`**, one environment at a time, watching each deploy — same discipline used for every merge tonight (one thing at a time, watch it go green before the next). This is a fundamentally higher-blast-radius change than anything merged so far: it can lock out every user if a governance table trips the guard unexpectedly (exactly the class of bug the journey-model gap was, back when it was still `PENDING`).
7. **Only after monitor-mode has run clean for a real stretch** does `enforce` mode — and `FORCE ROW LEVEL SECURITY` — become reasonable to turn on in prod.

None of this is built. Don't assume any part of it exists without checking `tenantEnforcement.ts` and `db.ts` directly first.

---

## Reference documents in this repo

- `MULTITENANCY-READINESS-AUDIT.md` — the full 4-part audit (inbound routing, raw-SQL leaks, model/settings classification, integration credentials) that everything in #227 was built to close.
- `MULTITENANCY-COMPLETION-PLAN.md` — an earlier, higher-level phase plan (Phase 0–6), written before the audit; still useful context for the overall shape but the audit doc is the more precise, current source of truth for what's actually done vs. open.
- `MULTITENANCY-REVIEW-PR196-199-200.md` — historical review of earlier tenant-isolation PRs, superseded by the above but kept for context on the `assign_team`/`Team` tenantId decisions it documents.

## Standing constraints that still apply, always

- Local `.env` = **production** database. Read-only unless doing a deliberate, backup-first, additive migration.
- Never merge to `main` or flip `tenantEnforcing()` without Sean's explicit go, given in the moment — a prior "continue" does not cover a specific merge/flip unless it clearly said so.
- Merge one thing at a time, watch its prod deploy go green, before starting the next.
- If a migration fails at `apply-migrations` against a real DB, stop and diagnose — don't cascade further merges on top of a broken one (this happened once already tonight with `#221`'s `AuditEvent` trigger issue; the fix pattern — diagnose the exact Postgres error, fix the migration, re-verify against a read-only check first — is documented in the #227 PR description).
