# Phase C · Step 2b — No-User Edges

Tenant-scope chokepoints for every request that reaches the DB **without a logged-in staff user**: cron jobs, inbound webhooks, and public-token routes. Under enforcement these have no `getCurrentUser`, so without an explicit chokepoint they'd resolve no tenant and **fail closed** — silently breaking background jobs, inbound messaging, intake, and public signing. This slice gives each one a way to establish the correct tenant scope.

> **Companion to** `PHASE-C-TENANT-GUARD-DESIGN.md`. Same invariants: everything here is **DORMANT** behind `tenantEnforcing()` (hard-`false` today), **back-compat** when off (byte-for-byte the pre-tenancy path), **fail-closed** under enforcement, and nothing flips on until **RLS + composite FKs** are live.

Decision on file (Sean, 2026-07-22): **build the real per-tenant mapping now** — not a single "home tenant" fallback. And: **all document numbers are per-tenant** (tracked separately, Phase C step 5).

---

## 1. The surface (from the full inventory)

Three tenant-derivability buckets:

| Bucket | Routes | How the tenant is found |
|---|---|---|
| **A — token-derivable** | signing/`[token]` (page + POST), signing decline, approvals/`[token]` (page + POST), **survey `/s/[token]` (page + `submitSurveyResponse` action)**, track open/click, unsubscribe, portal uploads/documents, passkey login | The resolved row (`SignatureRecipient`, `ApprovalStep`, `CampaignRecipient`, `SurveyResponse`, portal `Contact`, `Passkey`→`User`) **already carries `tenantId`** (Phase B). Mechanical. **Includes public PAGES and public server ACTIONS, not just `/api` routes** — the first pass missed the survey page + action (caught in review); the full surface is: every non-`(app)`/non-`portal` page and any server action reachable from one. |
| **B — cross-tenant sweeps** | cron: backup, security, trash-purge, errorLog cleanup | Genuinely platform-global → run in **`system`** scope (guard bypass by design). |
| **C — no discriminator in the request** | inbound WhatsApp / Messenger / IG / Telegram; `INTAKE_API_KEY` intake/bookings/service-lookup; per-tenant cron business work; the 3 global `user.findFirst({role:"owner"})` actor picks | **The real work.** Needs an explicit identity→tenant map + per-tenant keys + tenant-scoped actor resolution. |

---

## 2. Resolution model

### 2.1 `ChannelIdentity` — inbound channel → tenant

One row per external channel endpoint we own. The webhook reads the discriminator out of the payload and looks up the tenant.

```prisma
model ChannelIdentity {
  id         String   @id @default(cuid())
  tenantId   String
  channel    String   // "whatsapp" | "messenger" | "instagram" | "telegram"
  externalId String   // see §2.3 — the stable id of OUR endpoint, not the sender
  label      String?  // human note e.g. "Denago main WABA"
  createdAt  DateTime @default(now())
  disabledAt DateTime?
  tenant     Tenant   @relation(fields: [tenantId], references: [id])
  @@unique([channel, externalId])   // one endpoint belongs to exactly one tenant
  @@index([tenantId])
}
```

`resolveChannelTenant(channel, externalId): Promise<string | null>` — `findUnique` on the composite key, `disabledAt: null`. Returns `tenantId` or null. Uses `basePrisma` (it's an infra lookup that runs *before* any scope exists — same pattern as `resolvePortalTenant`).

### 2.2 `TenantApiKey` — public API key → tenant (hashed) — ✅ built (C2)

Replaces the single global `INTAKE_API_KEY` with per-tenant keys, **hashed at rest** (a security upgrade regardless of tenancy). Scalar `tenantId` (no FK), matching the Phase B additive convention — resolution is app-layer and a dangling key just fails to resolve.

```prisma
model TenantApiKey {
  id         String    @id @default(cuid())
  tenantId   String
  label      String
  hashedKey  String    @unique   // sha256(key); the raw key is shown ONCE at creation
  prefix     String              // first chars, for display
  scopes     String    @default("intake,bookings,service-lookup") // csv
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?
  @@index([tenantId])
}
```

`resolveApiKeyTenant(rawKey, scope)` (`src/lib/apiKeys.ts`) — sha256 the header, look up by `hashedKey` (**raw SQL** via basePrisma — trusted infra resolved *before* a scope exists, same boundary as the token resolvers), **JOIN `Tenant` and require `active = true`** (a key for a suspended tenant, or a dangling key after tenant deletion, must not authenticate), reject revoked / out-of-scope, best-effort `lastUsedAt`, return `tenantId`. `authenticateIntakeKey(rawKey, scope)` wraps it: per-tenant key → its tenant; under enforcement only per-tenant keys; **dormant back-compat** accepts the legacy global `INTAKE_API_KEY` (tenantId null) so intake keeps working before the backfill. Each route authenticates then `establishTenantScopeFromId(auth.tenantId)` **before** the module check (which reads tenant-owned settings). Migration `78_tenant_api_keys` (additive table only); backfill of the current global key = `scripts/backfill-tenant-api-keys.ts` (enforcement-prep, not on deploy).

**Establishing scope is not enough — the routes' UNGUARDED paths had to be closed too (review round 2).** Authenticating and calling `establishTenantScopeFromId` only scopes the *guarded* `prisma` client. Three code paths in these routes bypass it and were leaking cross-tenant under enforcement; all three now derive the tenant from the shared classifier and stamp/filter/namespace explicitly:

- **Booking write transaction** (`bookings/route.ts`, `bookingSlots.ts`): the whole booking runs in `basePrisma.$transaction` for the slot row-lock, which the guard does **not** touch. `claimSlotCapacity(tx, dt, capacity, tenantId)` now namespaces **both** the advisory lock and the `activity.count` by tenant (one tenant no longer consumes/locks another's slot, and the count agrees with the scoped `getDayAvailability`), and the `Contact` / `JobCard` / `Activity` creates are each stamped with the write tenant. `reserveSlot` (staff/bot path) does the same. The tenant comes from `writeTenantId()` — a concrete id under enforcement, `null` (unstamped, single-namespace, byte-for-byte legacy) when dormant/system, and a **throw** when closed.
- **Service OTP** (`service-lookup` + `verify`): `OtpChallenge` is a **global** model keyed by VIN. `serviceOtpKey(vin)` folds the authenticated tenant into the `key` (`t:<tenantId>:<vin>`), so issue / flood-count / invalidate / verify / consume are all per-tenant — a code for tenant A's VIN can't rate-limit, invalidate, or be verified by tenant B (dormant → bare VIN, legacy-compatible).
- **Push delivery** (`push.ts`): `PushSubscription` is a **global** model. `sendPushToAll` now selects recipients via `pushRecipientsForCurrentScope()` — under enforcement only devices of **active, non-disabled members of the current tenant** (join through `TenantMember` → active `Tenant`); dormant/system → all devices; closed → **nobody**. This fixes every one of the ~17 `sendPushToAll` callers at once, so a tenant-A lead/booking never notifies tenant B.

Shared plumbing: `src/lib/tenantWrite.ts` — `currentScopeClass()` (the single global/tenant/closed classifier, now also used by `tenantActor.ts`) and `writeTenantId()` (stamp value, or throw when closed). Behavioural coverage for all three lands in `scripts/test-tenant-guard.ts` (per-tenant slot capacity, cross-tenant OTP invisibility + flood isolation, per-tenant/disabled/system/closed push selection); structural wiring in `tests/tenantNoUserEdges.test.ts`.

**Deferred — per-tenant document numbering.** The "all document numbers are per-tenant" decision (invoices/quotes/job-cards/POs/etc.) is **not** delivered here. It requires swapping the global `@unique` on each `number` column for `@@unique([tenantId, number])` (a constraint change that must preserve uniqueness for today's `tenantId = null` prod rows — Postgres treats NULLs as distinct, so a naive composite unique would *weaken* the current global guarantee). That belongs with the tenant-scoped-**uniqueness** step (a hard co-requisite of the enforcement flip), bundled with the allocator changes and its own migration — **not** split half-done into this PR. Job cards created by the booking route are stamped with `tenantId` and keep their globally-unique sequential number for now (safe under enforcement; only leaks cross-tenant volume, which the numbering slice closes).

### 2.3 Per-channel discriminator (exact payload fields — verified against current routes)

| Channel | `externalId` = | Read from |
|---|---|---|
| WhatsApp | business phone-number id | `entry[].changes[].value.metadata.phone_number_id` |
| Messenger | Facebook Page id | `entry[].id` (DM events); `change.value.page_id` (leadgen) |
| Instagram | IG account id | `entry[].id` |
| Telegram | bot id / path slug | **per-tenant webhook path** — see §2.5 |

### 2.4 Actor resolution — `resolveTenantActor` (full inventory)

Many "pick a user for a system-generated record" call sites use `prisma.user.findFirst({ orderBy: { createdAt: "asc" } })` (or the first `role:"owner"`). `User` is a **global** model, so the guard does **not** scope these — the pick can belong to *another* tenant and then be **stamped onto this tenant's row or emailed this tenant's document**. Fix: `resolveTenantActor({ ownerOnly? })` (`src/lib/tenantActor.ts`) — under enforcement, an active member of the CURRENT tenant scope via `TenantMember` (`tenant.active`, owner-preferred when asked); dormant/system/no-scope → the unchanged global pick.

Full inventory (`grep user.findFirst`) — **22 sites**, classified by which slice establishes their tenant scope:

| Slice | Call sites | Record affected |
|---|---|---|
| **C1 (fixed here)** | `surveys.ts:275` (submitResponse), `signing/complete.ts:93`, `signing/approvals.ts:21` | `Communication.userId`, `Document.uploadedById`, owner approval **email** |
| **C3 (channel)** | `whatsapp.ts:263`, `messenger.ts:254/314`, `bot.ts:115`, `flowRun.ts:139`, `flowActions.ts:44`, `bookings/route.ts:88` | inbound message/lead attribution |
| **C4 (cron/queues)** | `automations.ts:35`, `journeyStepExecutor.ts:48`, `lifecycleJourneys.ts:23`, `serviceReminders.ts:29/109`, `reviewRequests.ts:50`, `signingReminders.ts:28`, `imapSync.ts:245`, `surveys.ts:93` (deliverInvite), `cron/automations/route.ts:64` | queue/reminder attribution |
| **staff/portal (already scoped)** | `actions/warranty.ts:89`, `actions/portal.ts:33` | swap to `resolveTenantActor` during C4 cleanup |

> Only the **C1** rows are reachable from the public no-user token surfaces and are fixed in this slice; each of the others is closed by swapping to the same `resolveTenantActor` when its slice establishes the tenant scope (a mechanical follow-up, not a redesign). The earlier "three owner picks" note was wrong — this table is the source of truth.

The automation/push fan-out that C1 signing-completion triggers (`advanceAfterSignature` → automations) reaches the **C4** picks above; those run with the tenant scope C4 establishes and use the same resolver — tracked here so they aren't dropped.

**Explicit staff assignees (approval workflow).** Beyond "pick *an* actor", an approval step can name a SPECIFIC staff user (`ApprovalStep.assigneeUserId`), and `notifyApprover` emails them the document title + approval token. `User` being global, an unscoped `user.findUnique` there would happily return a cross-tenant/stale user — and the workflow editor's staff picker (`signing-workflows/[id]/page.tsx`) + the runtime `staffMap` (`autoEnvelope.ts`) would let tenant A persist tenant B's user id in the first place. Fixed with two more `tenantActor` helpers:
- `resolveTenantMemberUser(userId)` — returns the user only if they're an active member of the current tenant; **fails closed** (null → no email) under enforcement otherwise. Used by `resolveApprover`.
- `listTenantStaff()` — the active members eligible as an assignee. Applied to both staff pickers so a cross-tenant id can't be offered or persisted.

`resolveApprover` branches on the assignee **type** first, so a malformed/legacy `staff` step with a null/unresolved id — or an `owner` with no resolvable owner — **fails closed** (no email) under enforcement rather than leaking to a stored address.

**Disabled accounts.** `disabledAt`/`role` are real `User` columns but are deliberately NOT in the Prisma model — they're the authoritative security state read via raw SQL (`userSecurity.ts`). So all of `tenantActor` uses **raw-SQL `TenantMember` joins** filtering `u."disabledAt" IS NULL` (and `role` for owners), in **every** mode — a token approval needs no login, so a disabled account must never be picked, listed, or emailed a live token.

**Scope modes (fail closed).** `tenantActor` classifies the scope explicitly via `actorScope()` — it does NOT collapse "run globally" with "no scope" into one nullable check (which would let a missed chokepoint leak global users under enforcement, unlike the guarded Prisma client that throws). The four cases: **global** (dormant, or an explicit trusted `system` scope) → global pick; **tenant** (enforcing + concrete tenant) → member query; **closed** (enforcing + no scope, or a `{ tenantId: null, system: false }` scope) → resolve nothing (`null` / `[]`), so `resolveApprover` returns no email.

### 2.5 Telegram — the one genuine config gap

Telegram has a single global bot + `TELEGRAM_WEBHOOK_SECRET`; the update payload carries no "which bot" discriminator. Per-tenant Telegram means a **bot per tenant**, each with its own webhook path + secret:

- New route shape `/api/webhooks/telegram/[endpoint]` where `endpoint` is an opaque per-`ChannelIdentity` slug; the existing `/api/webhooks/telegram` stays as tenant_denago_cpt's endpoint (back-compat) until migrated.
- Secret compared per-identity, not against one global setting.

Lower priority than WhatsApp/Meta (Telegram is the least-used channel); can be its own slice or deferred. **Flagged as an open item, not built in the first mapping slice.**

---

## 3. The chokepoint pattern — `withTokenTenantScope`

> **Review lesson (C1):** the tenant MUST be derived through a trusted pre-scope
> lookup BEFORE any guarded query. A first draft called the scope-setter *after*
> the guarded `findUnique` that resolves the row — under enforcement that first
> read has no scope and throws `TenantScopeError`, dead-locking the whole route
> (a "scope-before-bootstrap" deadlock). The scope-setter must never follow a
> guarded bootstrap read, and `enterWith` must not be relied on after one.

The portal pattern generalised into one helper (`withTokenTenantScope`, in
`tenantScopeEntry.ts`), used by **both** the page and its mutation route so the
read and write surfaces share one derivation and can't drift:

```ts
return withTokenTenantScope(
  () => resolveSignRecipientTenant(token),   // trusted basePrisma lookup: tenantId only
  () => handleSign(token, req),              // guarded re-read + full op, run INSIDE the scope
  () => new Response("Not found", { status: 404 }),  // fail closed (enforcing + unknown/untenanted)
);
```

- **Off (dormant):** skips the trusted lookup and runs the handler directly — byte-for-byte the pre-tenancy path, zero ALS overhead, no extra query.
- **Enforcing:** runs the narrow `basePrisma` resolver (tenantId only, the single trusted boundary crossed before a scope exists); if it can't resolve a tenant it returns `onFailClosed()` **without** running the handler; otherwise it runs the handler inside `runInTenantScope({ tenantId, system:false }, …)` so the guarded re-read succeeds. The scope reverts when the handler returns.

Meaningful-response routes fail closed with a clean status; **best-effort tracking** records nothing and still delivers the pixel/redirect; **unsubscribe** (a compliance action) shows its success message *only* when the opt-out actually committed. For sweeps (bucket B) the body is wrapped in `withSystemScope(...)`; per-tenant cron work (bucket C) is a `withTenant(t, …)` loop — see §4. Channel/API-key slices (C2/C3) reuse `withTokenTenantScope` with their own resolvers (`resolveChannelTenant`, `resolveApiKeyTenant`).

---

## 4. Cron strategy

| Cron | Strategy |
|---|---|
| `backup`, `security` | `withSystemScope` — whole-DB export, platform maintenance. |
| trash purge, errorLog cleanup (inside backup/automations) | `withSystemScope`. |
| `journeys`, `automations` (business queues), `competitor-watch`, google-reviews, campaign/survey/lifecycle queues | **per-tenant loop** under enforcement: `for (const t of activeTenants) await withTenant(t, () => runSliceForTenant(t))`; today (`!tenantEnforcing()`) run the existing global sweep unchanged. |
| inbound email (`syncInboundEmail` inside automations) | per **`SupportMailbox`**, run in that mailbox's `tenantId` scope (derivable — Phase B stamped it). |

The per-tenant-loop branch is **dead code until the flip** — scaffolded now, exercised in the enforcement PR. `resolveTenantOwner` replaces the global owner pick inside each per-tenant slice.

---

## 5. Explicitly OUT of scope (a later product surface)

Per-tenant channel **configuration** — each dealer connecting *their own* Meta app / WABA / Page / bot / SMTP, with their own secrets — is a real admin surface (a "Channels" settings area per tenant) and a **product feature**, not part of the dormant substrate. Today all channel config lives in global `AppSetting` and stays there; the mapping tables above just **attribute inbound to a tenant**. When a second dealer actually onboards with their own number, that's when per-tenant config gets built. This slice does **not** move `META_APP_SECRET` et al. per-tenant.

---

## 6. Slice sequence (each = one small, dormant, individually-reviewed PR)

| # | Slice | Schema? | Migration? | Risk |
|---|---|---|---|---|
| **C1** ✅ | **Token-derivable surfaces** — `withTokenTenantScope` + a shared per-type resolver across the signing/approval **pages + routes**, the **survey `/s/[token]` page + `submitSurveyResponse` action**, tracking, unsubscribe. Portal (via `getPortalContact` #167) and passkey (self-scopes via `createSessionCookie`; `Passkey` is global) already covered. Verified: the only other non-`(app)` pages are `messages/*` (staff `requireUser`), `doc-editor` (`requireOwner`), `login` (no tenant reads). | none | none | **Lowest** — dormant no-ops, no DB change. Derive-before-guarded-read; integration-tested. |
| **C2** ✅ | **`TenantApiKey`** + `resolveApiKeyTenant`/`authenticateIntakeKey` + chokepoints in intake/bookings/bookings-slots/service-lookup/service-lookup-verify (auth→scope before the module check; bookings actor via `resolveTenantActor`); migration `78`; backfill script (enforcement-prep). **Round 2:** closed the routes' unguarded paths — per-tenant slot capacity + stamped booking rows, tenant-namespaced service OTP (`serviceOtpKey`), tenant-scoped push delivery (`pushRecipientsForCurrentScope`); shared `tenantWrite.ts` classifier; behavioural + structural tests. | +1 table | additive (`78`) | Low — new table, dormant back-compat key. Migration HELD for Sean's backup-first merge. |
| **C3** | **`ChannelIdentity`** + `resolveChannelTenant` + chokepoints in whatsapp/meta webhooks; backfill current phone-number-id + page id → tenant_denago_cpt | +1 table | additive | Low-med — new table, backfill must be exact or (enforcing only) inbound 404s. |
| **C4** | **Cron scoping** — `withSystemScope` for backup/security; per-tenant-loop scaffold + `resolveTenantOwner` for journeys/automations/competitor-watch | none | none | Med — touches the engines (dormant branch only). |
| **C5** | **Telegram per-tenant** (§2.5) — per-tenant path + secret | reuses ChannelIdentity | route add | Low (least-used) — can defer. |

Recommended order: **C1 → C2 → C3 → C4** (C5 deferred). C1 needs no migration and can ship immediately; C2/C3 each carry one additive table + a backfill that must run **before** any enforcement flip.

---

## 7. Migration + backfill (prod)

Standing rules: additive only, **backup first**, PR + Sean-merge (never self-deploy).

- **C2 backfill:** insert one `TenantApiKey` for tenant_denago_cpt whose `hashedKey = sha256(current INTAKE_API_KEY)` → the existing embed key keeps working *and* now resolves to a tenant. Verify a real intake POST still 201s.
- **C3 backfill:** insert `ChannelIdentity` rows for the live WhatsApp `phone_number_id`, the Meta Page id, (and IG id if used) → tenant_denago_cpt. Verify against the actual values in prod settings before writing. Under enforcement an unmapped channel 404s, so this backfill is a **hard prerequisite** to any flip — same gate as RLS/composite FKs.
- All backfills are idempotent upserts on the `@@unique` keys.

---

## 8. Open items for Sean

1. **Approve the two table shapes** (`ChannelIdentity`, `TenantApiKey`) before I write the migrations.
2. **Telegram (C5):** build per-tenant now, or defer until a second dealer needs it? (Recommend defer.)
3. **Lead order:** I recommend shipping **C1** first (zero schema, zero migration, pure dormant no-op) to lock the pattern, then C2/C3. Confirm.
4. **Per-tenant document numbering + tenant-scoped uniqueness** (the "all document numbers per tenant" decision): its own slice, a **hard co-requisite of the enforcement flip**, needing a `@@unique([tenantId, number])` migration per numbered model that *preserves* today's global uniqueness for `tenantId = null` rows (NULLs are distinct in a Postgres unique index) + the allocator changes. Your hands-on migration — flag when to schedule it. Until then C2 stamps job cards with their tenant but keeps globally-unique sequential numbers.
5. **HTTP-level booking test** (non-blocking C2 follow-up): assert the *persisted* tenant IDs on `Contact`/`JobCard`/`Activity` by invoking the real `bookings` POST end-to-end, replacing the current structural + `claimSlotCapacity`-level coverage. **Blocked on the `AppSetting.tenantId` slice**: under enforcement the route's `getSlotConfig()` → `getSetting()` reads `AppSetting` through the guarded client, and `AppSetting` has no `tenantId` column, so `scopeWhere` injects a `where.tenantId` against a non-existent column and the route 500s before the transaction. Land `AppSetting.tenantId` first, then this test (and the routes themselves) can run enforcement-on.
