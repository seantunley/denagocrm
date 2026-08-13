# Research on a contact: `contact access check: this request has no resolvable workspace`

Status as of 2026-08-13 10:10 UTC. Production, `POST /contacts/cmracq4kv0001jy044cg8mv5j`.

## Why this has gone in circles

Four PRs (#513, #517, #518, #519) have shipped against this failure. Every one of them
was validated the same way: **merge, deploy, wait for the next production click.** None of
them was ever reproduced first. So each fix was a hypothesis, and the only test was Sean
clicking Research again.

That is the loop. It is not that the fixes were careless — #517 in particular found and
fixed a real defect — it is that nothing in the repo executes a **Server Action against a
production build**, which is the exact combination that fails.

## What is now PROVEN (not inferred)

**1. #519 was live when it failed.** This was the open question and it is settled:

| event | time (UTC) |
|---|---|
| #519 (`fec542b1`) deployment created | 09:48:37 |
| #519 **READY** (Vercel API `ready`) | **09:51:41** |
| failure logged | **09:52:02** |
| failure logged | **09:52:39** |

Both failures are *after* the #519 build went live. #519 did not fix it.

**2. Enforcement is ON.** `TENANT_ENFORCEMENT=enforce` in production (confirmed by Sean —
the Vercel API returns `sensitive` vars as empty, so it cannot be read programmatically).
This matters because it selects which half of `actingScopeClass()` runs.

**3. The session and the data are clean.** Ruled out by direct query against prod:

- `sean@tunley.co.za` is `role=owner` with **exactly one** active membership
  (`tenant_denago_cpt`, `active=true`). So `resolveActingTenant` → a sole tenant, and
  `honoredTenantClaim` has something to honour.
- The live session (`created 05:15:31Z`, `lastActive 09:51:54Z` — the one that clicked)
  carries `tenantId=tenant_denago_cpt`, not null, not revoked.
- The contact exists and is owned by that tenant.

So this is **not** a stale/ambiguous/tenantless session. There is a workspace to resolve.

**4. It fails at the FIRST guard**, not after the AI call. The stack is
`actingRecordPredicate ← canAccessContact ← requireContactAccess`, which is
[ai.ts:166](src/app/actions/ai.ts#L166) — before `aiResearch` is ever called.

**5. The owner escape hatch is NOT firing on renders.** Under enforcement,
[layout.tsx:28](src/app/(app)/layout.tsx#L28) redirects an owner with no scope to
`/platform/tenants`. Sean loads contact pages normally, so on a GET the scope *does*
resolve. Whatever breaks, breaks on the POST.

## Theories tested and KILLED

Recording these so nobody re-runs them.

- **"`enterWith` doesn't survive an `await` back to the caller."** Tested directly on
  Node 22.22.1 (the deployed runtime): it *does* propagate. The callee-enters/caller-reads
  shape works. I had started a fix on this premise and reverted it.
- **"The recovery query fails closed under RLS."** No — `basePrisma` unconditionally sets
  `app.bypass_rls='on'` ([db.ts:193](src/lib/db.ts#L193)), so `resolveActingTenant` reads fine
  with no scope.
- **"`TENANT_ENFORCEMENT` is empty, so the `if (enforcing && …)` recovery never runs."**
  I claimed this from the Vercel API and it was **wrong** — `sensitive` vars always return
  empty (`CRON_SECRET` reads as empty too, and `DATABASE_URL` came back as ciphertext).
  Corrected by Sean: it is `enforce`.

## What is left, and it is now narrow

Inside that one POST, both of these are true at the same time:

1. `requireAnyPermission` at [ai.ts:155](src/app/actions/ai.ts#L155) **succeeded** — so
   `getCurrentUser()` returned a user, so `established.ok` was true.
2. `actingScopeClass()` a few lines later saw **no tenant scope**.

Two ways that can happen:

- **(a) `established.scope` was null.** `decideStaffTenantScope` has an owner escape hatch
  that returns `{ok: true, enterTenantId: null}` — success *with no scope*. `getCurrentUser`
  then enters nothing, and `restoreStaffScopeFromSession` returns that same `ok: true`
  while establishing nothing, so #519's recovery reports success and is inert.
  Weakened by finding 5, but not eliminated for the POST path.
- **(b) The scope resolves but does not reach `actingScopeClass` in a Server Action.**
  In an action, React `cache()` has no request store, so #513's holder is never filled and
  **ALS is the only carrier left**. Plain Node propagates correctly (killed theory 1), but
  Next's action runtime + React `cache()` is not plain Node.

Both are fixable, and the fixes differ. Guessing between them is how we got four PRs.

## The actual gap: nothing tests this path

`scripts/test-enforced-render.ts` (#515) already does the hard 90%: boots a **real
`next build` + `next start`** with `TENANT_ENFORCEMENT=enforce`, seeds a tenant + owner,
mints a real session cookie, and asserts on the server's own stderr. It tests `GET /`.

It has never been pointed at a **Server Action POST**, which is the failing shape.

## RESOLVED — mechanism proven, fix verified

`scripts/test-action-tenant-scope.ts` (new, `npm run test:action-scope`) reproduces the
production failure locally against a real production build under `enforce`, then goes
green with the fix. The staged progression is the proof — each build moved the failure
one layer down, which is what showed the real shape:

| build | result |
|---|---|
| #519 as shipped | `contact access check: this request has no resolvable workspace` ← **production, reproduced** |
| + `actingScopeClass` binds the recovered scope | `No tenant scope established for Contact` |
| + db-guard point-of-use recovery | `No tenant scope established for AppSetting` |
| + action-level scope binding | **PASS** |

**The mechanism.** In a Server Action there is no React request store, so #513's
request-keyed holder — the carrier a page render depends on — is never filled. That
leaves AsyncLocalStorage, and `enterWith` inside a callee **does not reach the frame
that called it**. Measured, with the recovery resolving correctly:

```
restore: tid=action_5580 role=owner ok=true scope={"tenantId":"action_5580"}
after recovery: class={"mode":"closed"} ambient=null
```

The right workspace, resolved and entered, and gone one line later in the caller.

So every fix in this chain established the scope *below* the code that needed it, and
each one correctly fixed exactly the reader it touched. #519 additionally keyed its
recovery on `ok`, which the owner escape hatch returns as `true` while establishing no
scope at all — so it reported success and was inert.

Note the isolated-Node check that "refuted" this earlier was a false negative: plain
Node 22 *does* propagate `enterWith` across an `await`. Next's action runtime does not.
Only the production-build reproduction settled it.

**The fix**, in three parts:

1. `src/lib/scopeRecovery.ts` — the recovery, extracted and now returning the **scope**
   rather than `ok`, shared by both call sites.
2. `actingScopeClass` binds the recovered scope in its own context before re-reading;
   the db guard recovers at point of use and binds with `runInTenantScope`.
3. `withActingStaffScope` — binds the acting workspace around a **whole** action, an
   enclosing frame that propagates downward. `researchRecord` now uses it.

None of it can widen access: every path runs only where there is currently **no** scope,
which is a hard refusal today, so the choice is the session's own workspace or an error.

## Still open

**Other Server Actions are not yet wrapped.** `researchRecord` is fixed and the db-guard
recovery covers guarded *queries* elsewhere, but synchronous scope readers —
`settingsOwnerTenantId` is the one this hunt hit — still refuse in any unwrapped action.
Any action touching tenant-scoped data can fail the same way under enforcement. The
mechanism is now understood and `test:action-scope` is the pattern for proving each one,
so that sweep is mechanical rather than exploratory.

## Original plan (kept for the record)

1. Extend the #515 harness to POST the `researchRecord` action to `/contacts/<id>` with a
   real signed cookie against a production build. This reproduces or refutes (a) vs (b)
   with certainty — locally, touching nothing in production.
2. Fix whichever it is, and prove it by that test going red → green.
3. Open a PR (not a deploy) with the harness *and* the fix, so the next regression here is
   caught by CI rather than by Sean clicking Research.

Blocker for step 1: the harness requires a disposable `*_test` database and there is no
local Postgres or Docker on this machine. `npm run harness:install-postgres`
(`embedded-postgres`, ~130 MB, deliberately not a dependency) covers it.

## Meanwhile

Enforcement is what makes this path fail. `TENANT_ENFORCEMENT=off` (or `monitor`) in Vercel
restores Research immediately and is the documented rollback — the same lever used after the
2026-08-12 lockout. That is Sean's call, not something to do automatically.
