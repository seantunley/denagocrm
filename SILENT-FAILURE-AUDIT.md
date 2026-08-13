# Silent-failure audit — the "succeeds wrongly" class

Every Research bug on 2026-08-13 was the same species: something failed, nothing threw,
a wrong result was saved, and the System Log stayed empty. This audit looks for the rest
of that species.

**Scope:** `src/lib` and `src/app`, every `.ts`/`.tsx`. **345 silent swallows across 116
files** — `catch {}`, `catch (e) {}` with an empty body, `.catch(() => {})`, and
`.catch(() => <fallback>)`.

**The finding up front:** the codebase is in better shape than the raw number suggests.
The overwhelming majority are deliberate best-effort writes with a comment explaining why,
and they are correct. **Two are not, and they are the same defect in two places: logout can
fail to revoke a session and tell you it succeeded.**

---

## Inventory

Classified by what the swallowed statement was attempting (inferred from the preceding
400 characters, so the labels are indicative, not exact).

| Class | Count | Verdict |
|---|---:|---|
| AUTH/TENANT | 100 | Mostly credential decrypts and optional lookups on display paths |
| OTHER | 81 | Parsing, formatting, optional enrichment |
| BOOKKEEPING | 62 | `revalidatePath`, counters, telemetry — correct to swallow |
| WRITE | 58 | Reviewed in full; almost all deliberate (see below) |
| OUTBOUND | 33 | Sends already have retry/queue machinery behind them |
| PARSE | 11 | Benign |

The `WRITE` class is where data loss would live, so I read all of them. The pattern is
consistent and good: a throttled `lastActiveAt` touch, deleting an already-expired row,
releasing a lease, a unique-collision retry, `.catch(() => ({ count: 0 }))` on a purge so
a restored record is skipped rather than destroyed. These are right, and most carry a
comment saying so.

---

## Findings

### 1. Logout can silently fail to revoke the session — BOTH paths

**`src/app/login/actions.ts:240` (staff)** and **`src/lib/platformAuth.ts:159` (platform
admin)**.

```ts
// staff
try {
  if (session?.jti) {
    await basePrisma.userSession.updateMany({ where: { jti: session.jti }, data: { revokedAt: new Date() } });
  }
} catch {}                       // ← revocation failure, swallowed whole
await destroySessionCookie();
redirect("/login");
```

```ts
// platform admin
await basePrisma.platformAdminSession
  .updateMany({ where: { jti: result.payload.jti, revokedAt: null }, data: { revokedAt: new Date() } })
  .catch(() => {});              // ← same
store.delete({ name: PLATFORM_SESSION_COOKIE, path: "/platform" });
```

If the write fails, the cookie is cleared and the user is redirected anyway. **The person
believes they have logged out; the token remains valid server-side until it expires.**
That matters on a shared machine, and it matters if the token was ever copied — which is
precisely the case `platformAuth`'s own doc comment cites as the reason revocation exists:

> *…delete is lost (or the token was copied elsewhere), then clears the cookie.*

Revocation is the real protection, and its failure is the one thing here that is invisible
to the person affected. There is no error, no log, and the UI says "signed out".

**Severity: highest in this audit.** Security-relevant, silent, and affects both roles.

**FIXED.** Both sites log the failure. The staff path additionally **escalates**: if
revoking the one `jti` fails, it bumps the user's `sessionVersion`, which
`getCurrentUser` compares on every request — so every token that user holds, including the
one that could not be revoked, stops validating immediately. That is a bigger hammer, and
it is the right trade on a path that only runs *after a logout has already failed*: being
signed out of your other devices beats believing you signed out while the token stays live.
If the escalation fails too (likely, if the database is unreachable), that is logged as a
distinct message so the System Log separates "we closed the hole" from "the token is still
live".

Still deliberate: the cookie is cleared and the redirect happens regardless. Stranding
someone on a page they cannot leave would be worse.

### 2. Trash purge cannot distinguish "restored" from "database failed"

`src/lib/trash.ts` — `.catch(() => ({ count: 0 }))` then `if (count === 0) continue`.

The guard is deliberate and good: a record restored between the scan and the delete must
not be purged. But a genuine DB failure produced the identical `count: 0`, so a purge
failing every night looked exactly like a purge with nothing to do. Nothing is destroyed
either way — the guard keeps the row and its blobs — so the cost was that the retention
window quietly stopped being enforced with no way to notice.

**FIXED.** A `purgeDelete` helper logs the failure and returns 0, so `count === 0` now
means only "restored", which is what the code always assumed it meant. The sweep continues
past a bad row rather than aborting the nightly pass. The **scan** was guarded the same way
(`.catch(() => [])`, making a failed read look like "nothing is due") and is now logged too.

One thing this surfaced, worth recording: the ratchet in `tenantAccessRatchet.test.ts`
immediately flagged two *new* bypass-writes on `Document` and `LibraryDocument`. They are
not new — the old chained `.catch()` shape hid them from the detector, and the same sweep's
sibling writes (`CustomerCase`, `PortalUpload`, `CustomFieldValue`) were already
acknowledged. They are baselined rather than restructured away, because `purgeTrash` is the
documented platform-wide sweep and a cross-tenant write there is correct by design.

### 3. Competitor lease release — VERIFIED, not a bug

`src/lib/competitors.ts:183`. Checked rather than left flagged: the claim is
`OR: [{ collectingAt: null }, { collectingAt: { lt: leaseCutoff } }]` with a
**10-minute** cutoff, so a lost release is reclaimed on the next run. The swallow is
correct as written. No change.

### 4. The wrong-tenant fallback class — inert today, live at tenant #2

Twelve live sites resolve `writeTenantId() ?? DEFAULT_TENANT_ID` (or equivalent):

```
src/lib/botFlowAnalytics.ts:89,128   src/lib/botFlowAnalyticsReport.ts:87
src/lib/flowTenantScope.ts:153       src/lib/googleReviews.ts:98
src/lib/journeyTenant.ts:48          src/lib/leadCreate.ts:56
src/lib/messenger.ts:465             src/lib/repairs.ts:93
src/lib/settings.ts:428              src/lib/statistics.ts:374
src/lib/tenantWrite.ts:116
```

**The exposure is narrower than the count suggests, and I had it wrong in the first draft
of this report.** `writeTenantId()` does not simply return null on failure:

```ts
export function writeTenantId(): string | null {
  const s = currentScopeClass();
  if (s.mode === "closed") throw new TenantScopeError(...);   // ← does not reach the ??
  return s.mode === "tenant" ? s.tenantId : null;             // ← null only for `global`
}
```

So with enforcement ON — which is where production is now — a bound tenant scope returns
the real tenant and the `??` never fires, and a *missing* scope throws rather than
defaulting. The fallback is reachable only under `global`, which under enforcement means a
**deliberate system scope**: cron slices, sweeps, trusted cross-tenant work. Several of
those paths run inside `runCronPerTenant`, which binds a real per-tenant scope, so the
fallback never fires there either.

What is left is genuinely narrow: system-scoped background work that writes a tenant-owned
row without inheriting an owner from the record it is acting on. Still wrong at two
workspaces, still invisible at one — but it is not, as the first draft implied, sitting
under ordinary user writes.

**Not fixed here, deliberately.** Converting these to throws would turn silent-wrong into
loud-failure in live background paths for zero benefit at one workspace, and today already
demonstrated how fragile scope resolution is in non-render contexts. Converting them to
inherit needs a parent record and per-site knowledge of the calling context. That is the
multi-tenancy workstream — the phase the project notes already flag as needing hands-on
review — not something to bulk-edit off the back of an audit.

---

## What this audit did not cover

Stated plainly so the number is not mistaken for completeness:

- **Only empty/no-op catches.** A `catch` that logs the wrong thing, or handles one error
  type and swallows the rest, is not detected.
- **Classification is keyword-based** on the preceding 400 characters. The `WRITE` class I
  read in full; `AUTH/TENANT` (100 sites) I sampled, not exhausted.
- **No runtime evidence.** Everything here is read from source. Finding 3 is explicitly
  unverified.
- **`?? null` / `|| []` fallbacks are out of scope** — a much larger class of "returns an
  empty result on failure", and the same species of problem.
