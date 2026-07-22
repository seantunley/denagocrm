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

### 2.2 `TenantApiKey` — public API key → tenant (hashed)

Replaces the single global `INTAKE_API_KEY` with per-tenant keys, **hashed at rest** (a security upgrade regardless of tenancy).

```prisma
model TenantApiKey {
  id         String    @id @default(cuid())
  tenantId   String
  label      String
  hashedKey  String    @unique   // sha256(key); the raw key is shown ONCE at creation
  prefix     String              // first 8 chars, for display ("dk_live_…")
  scopes     String              // csv: "intake,bookings,service-lookup"
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?
  tenant     Tenant    @relation(fields: [tenantId], references: [id])
  @@index([tenantId])
}
```

`resolveApiKeyTenant(rawKey, scope): Promise<string | null>` — sha256 the header, `findUnique({ hashedKey })`, check `revokedAt == null` and `scope ∈ scopes`, best-effort stamp `lastUsedAt`, return `tenantId`. Constant-time via the unique-hash lookup (no plaintext compare).

### 2.3 Per-channel discriminator (exact payload fields — verified against current routes)

| Channel | `externalId` = | Read from |
|---|---|---|
| WhatsApp | business phone-number id | `entry[].changes[].value.metadata.phone_number_id` |
| Messenger | Facebook Page id | `entry[].id` (DM events); `change.value.page_id` (leadgen) |
| Instagram | IG account id | `entry[].id` |
| Telegram | bot id / path slug | **per-tenant webhook path** — see §2.5 |

### 2.4 Owner-actor resolution

The three `user.findFirst({ role: "owner" })` "pick an actor" calls (`cron/automations:64`, `bookings/route.ts:88`, `imapSync.ts:245`) grab *an* owner globally. `User` is a **global** model, so the guard will **not** auto-scope it — these need an explicit helper:

`resolveTenantOwner(tenantId): Promise<User | null>` — the active `owner` member of that tenant, via `TenantMember` (tenantId + role=owner + not suspended). Every call site above becomes "the owner **of the resolved tenant**", not "any owner".

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
| **C2** | **`TenantApiKey`** + `resolveApiKeyTenant` + chokepoints in intake/bookings/service-lookup; backfill the current `INTAKE_API_KEY` as tenant_denago_cpt's key | +1 table | additive | Low — new table, back-compat key. |
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
