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

**Fixed in this PR** — both sites now log the failure with the jti so it is diagnosable in
the System Log. Deliberately *not* changed: the cookie is still cleared and the redirect
still happens. Leaving someone stuck on a page they cannot log out of would be worse, and
changing the logout contract is a bigger decision than an audit should take unilaterally.

**Still open for a decision:** a failed revocation could additionally bump the user's
`sessionVersion`, which invalidates every session they hold and closes the hole outright.
That logs them out on every device, so it is a product call, not a bug fix.

### 2. Trash purge cannot distinguish "restored" from "database failed"

`src/lib/trash.ts:182, 197, 226` — `.catch(() => ({ count: 0 }))` then `if (count === 0)
continue`.

The guard is deliberate and good: a record restored between the scan and the delete must
not be purged. But a genuine DB failure produces the identical `count: 0`, so a purge that
is failing every night looks exactly like a purge with nothing to do. Blob files are
correctly *kept* in both cases, so nothing is destroyed — the cost is that a persistently
broken purge is undetectable.

**Not fixed** — the correct fix distinguishes the two by catching only the restored case,
which means touching purge semantics. Worth doing, not worth doing blind.

### 3. Competitor lease release is best-effort

`src/lib/competitors.ts:183` — the `finally` that clears `collectingAt` swallows failure.
A lost release leaves the source marked as collecting; whether that self-heals depends on
whether the claim has a timeout. **Unverified** — flagging rather than asserting.

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

These do not throw and never will — they write a *confident, wrong* owner. With one
workspace the guess is always right and the whole class is invisible. With two, a row is
filed under the wrong business and reads as correct to every later query. `actingTenant.ts`
already calls this out as the worse direction, and the acting-scope work has been removing
these rung by rung.

**Not fixed here** — this is the multi-tenancy flip's own workstream, not an audit item.
The thing worth knowing is the number: **twelve**, and they are listed above.

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
