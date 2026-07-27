# Multi-Tenancy Readiness Audit

**Date:** 2026-07-27
**Scope:** full-codebase audit of `c:/tmp/denagocrm-221` (the tenant-prep branch: governance + journey classification + tenant console + lockout-proofing), answering directly: *"is multi-tenancy actually complete — settings, API keys, every module, email, social media — all tenant-specific?"*

**Bottom line: NO, not yet.** Enforcement is still OFF (`tenantEnforcing()` hard-coded `false`), so nothing leaks *today* — there is only one tenant. This audit is about **readiness for the flip**. Four parallel audits covered inbound routing, API keys/integrations, raw-SQL leaks, and model/settings classification. Real gaps were found in all but one area. Two are quick, safe fixes I can make now. Two are genuine product/architecture decisions that need your call before building.

---

## Scorecard

| Area | Verdict |
|---|---|
| Schema classification (every model global-or-scoped, no crash risk) | ✅ **READY** |
| Lockout-proofing (owner can never be locked out) | ✅ **READY** (built, reviewed, tested) |
| Inbound social/email routing (which tenant does a message belong to) | ⚠️ **GAPS** — Telegram unwired |
| **Outbound integration credentials** (which tenant's account sends the reply) | 🔴 **MAJOR GAP** — architecturally not per-tenant yet |
| Raw-SQL / basePrisma tenant filtering | 🔴 **GAPS** — several real leak/vanish bugs, some fixed, some open |
| RBAC / custom roles | 🔴 **GAP** — roles are global, user-creatable, unscoped |

---

## 1. Inbound routing — mostly ready, one integration unwired

Everything you specifically asked about — **email (IMAP), WhatsApp, Messenger, Instagram DMs, Facebook/Instagram lead ads, signing/survey/approval links, intake/bookings** — correctly resolves a specific owning tenant (via `ChannelIdentity`, a signed token, or a per-tenant API key) and **fails closed** (skips/404s) rather than misrouting to the wrong tenant.

**Gap:** Telegram has no tenant-resolution step at all. It runs on a single global bot token; there's no `ChannelIdentity` mapping for it. It won't misroute a message to the wrong tenant — it will simply break (throw) under enforcement — but it isn't multi-tenant-capable as built. If Telegram matters to the product, it needs the same `ChannelIdentity` treatment as WhatsApp/Messenger, plus a per-tenant bot token (see #2).

**Minor:** unmapped social events are dropped with `console.warn` instead of being logged to the System Log — fine functionally, just harder to diagnose a missed backfill later.

---

## 2. 🔴 Outbound integration credentials — the biggest gap

**This is the one that matters most for what you asked ("messages from social media will go to specific tenant").** Inbound resolution correctly identifies *whose* message it is. But every **outbound send** — the actual reply — reads its credential from `AppSetting`, a global key-value table with **one row per key for the whole install**. There is no way to even store a second tenant's token today.

Affected (all currently global, all need to become per-tenant to be correct for a second dealer):
1. **WhatsApp** access token + phone-number-id
2. **Meta page token** (Messenger + Instagram DM replies, Facebook lead-ads polling)
3. **Telegram** bot token
4. **SMTP** (outbound email account)
5. **IMAP** (inbound email — one mailbox polled for every tenant)
6. **BulkSMS** (SMS/OTP)
7. **Google Reviews** (Place ID is literally tenant-identifying)

**What's already correct:** the intake/bookings/service-lookup API key is genuinely per-tenant (`TenantApiKey`), and that's the pattern the rest need to follow.

**Why this needs your decision, not just a patch:** giving each tenant their own WhatsApp Business number / SMTP account / Google listing is a **product/onboarding decision** (does every dealer bring their own WhatsApp number? their own email domain?), and the fix requires `AppSetting`'s primary key to become composite (`tenantId, key`) instead of `key` alone — a real schema/migration decision, not a one-line change. I have not built this; it should be scoped deliberately.

---

## 3. Raw-SQL / basePrisma tenant-filtering — mixed, several real bugs

The Prisma guard only auto-scopes the guarded `prisma` client — **not raw SQL, not `basePrisma`**. I audited this directly (two background sub-audits hit a session limit partway through; I finished the sweep myself plus a narrower follow-up agent).

### Fixed already (in the tenant-prep branch)
- **`src/lib/audit.ts`** — the `AuditEvent` raw INSERT computed `tenantId` but never included it in the column list, so every governance-audit row would have landed with `tenantId = NULL`. Fixed and verified (column/value alignment checked).

### Found, NOT yet fixed — real findings, ranked by severity

| Severity | Finding | Failure mode |
|---|---|---|
| 🔴 Critical | `src/app/api/audit/export/route.ts` — the audit-log CSV export has **no `tenantId` filter at all** | Any user with `audit.export` downloads every tenant's entire audit trail |
| 🔴 High | `src/app/api/cases/uploads/[id]/route.ts` — authorization uses a permissive ownership check (`true` whenever the caller has `cases.view_all`), then streams the file directly with **no tenant re-check** | A manager in tenant A can fetch tenant B's case attachments by iterating upload IDs |
| 🔴 High | `Team`/`TeamMember` reads and writes in `settings/access/page.tsx` and `accessControl.ts` filter only by `id`, never `tenantId` (even though both models carry the column) | Any staff member with `teams.manage` can view/rename/reassign **every tenant's** sales teams |
| 🟡 Medium | `src/lib/googleReviews.ts` — writes via unscoped `basePrisma`, so rows land with `tenantId = NULL` | Opposite failure mode: under enforcement these rows become invisible to every tenant (silent data loss, not a leak) |
| 🟡 Medium | **Same bug class as the audit.ts fix, unaddressed at wider scope** — `portal.ts`, `portalAdmin.ts`, `portalExpansion.ts`: every raw INSERT for `PortalNotification`, `CustomerCase` (×2 paths), `PortalProfileChangeRequest`, `PortalPreference`, `PortalAccessGrant`, `PortalUpload` omits the model's own `tenantId` column | Every portal-submitted case/upload/notification silently becomes invisible under enforcement — customer complaints would vanish tenant-wide |
| 🟢 Low | `revokePortalAccess(id)` has no ownership check before deactivating a grant | Cross-tenant nuisance (deactivate another tenant's grant by id), not data exposure |
| 🟢 Low | `createPortalCase` assigns to the platform's globally-first-created user instead of the tenant-aware resolver its sibling function already uses | Inconsistent; can assign a case to staff outside its own tenant |
| ℹ️ Noted, not exploitable today | Portal OTP login (`requestPortalOtp`/`verifyPortalOtp`) looks up a contact by email with no tenant disambiguation — harmless with one tenant, a design gap before multi-tenant portal login | — |

**Confirmed safe (the right pattern, worth naming so it's not re-litigated):** ownership-allowlist helpers like `getAccessibleQuoteIds` use unscoped `basePrisma` to compute an ID list, but the actual content read downstream uses the **guarded** `prisma` client — so even a permissive allowlist still fails closed on cross-tenant data. That's true for quotes; it is explicitly **not** true for the case-uploads route above, which is why that one is flagged High.

---

## 4. 🔴 RBAC / custom roles — architecture gap

`Role`/`Permission`/`RolePermission` are classified `GLOBAL_MODELS` on the stated reasoning "one shared permission taxonomy." That's contradicted by what's actually shipped: `settings/access` already lets an admin **create custom roles** and **edit any role's permissions** (`accessControl.ts`), via unscoped raw SQL. Once a second tenant exists:
- Tenant B's admin would see and could edit tenant A's custom roles.
- `Role.name` has a **global** uniqueness constraint — two tenants can't both create a "Sales Manager" role.
- **`getUserPermissions` unions a user's role-permissions across every tenant they belong to**, filtered only by `userId` — a user in two tenants gets the combined privileges of both, regardless of which tenant they're acting in.

**This is a decision, not a bug fix:** either (a) custom roles become tenant-scoped (`tenantId` nullable = system role, non-null = tenant-authored) with per-tenant name uniqueness and a tenant-admin UI, or (b) role management is locked to a platform super-admin until that's built. Your `ROADMAP.md` already flags this exact open question — this audit confirms it's a hard blocker for enforcement, not a someday item.

---

## What I'd recommend, in order

1. **Fix the mechanical bugs now** (same class as the audit.ts fix — additive, safe, no product decision required): the portal raw-INSERT `tenantId` omissions, `googleReviews.ts`, the audit-export filter, the case-uploads re-check, `Team`/`TeamMember` scoping, the two low-severity portal issues. I can do this as a follow-up batch.
2. **Decide the two architecture questions** before either is built: (a) per-tenant integration credentials — which integrations actually need per-tenant accounts for your onboarding model; (b) RBAC — shared role catalogue vs. tenant-authored roles.
3. Only then does a "flip enforcement" conversation make sense — flipping today, even with the lockout-proofing in place, would ship the credential-crossing and audit-export gaps into a live second tenant.

Nothing here is urgent for the **current** single-tenant production — enforcement is off, so none of it is exploitable yet. It's exactly the list that has to close before a second tenant becomes safe.
