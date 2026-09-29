# Adversarial security retest — 2026-09-01

**Brief:** "Assume you did not write this codebase. Check for security. Try to break it."
**Stance:** outsider. Nothing was taken on trust because a comment said it was safe.
**Scope:** the code as it stands on `main` at `dc4fd5e5` (#623 merged).
**What was NOT run:** every DB-touching script in `validate:security`. Local `.env`
points at **production**; `test:rls-restricted`, `test:tenant-e2e` and friends were
deliberately skipped rather than pointed at live business data.

**Verdict: I could not break it.** Four small hardening items, all in the passkey
flow, none of them exploitable today. Three of my own hypotheses died under
verification — that section is the honest part of this report and is kept in full.

---

## 1. Findings

All four are in the WebAuthn/passkey flow, which is the one part of the
authentication surface that has not had the same attention as the password path.
None is remotely triggerable into a compromise today. Severity: **low**.

### F1 — The passkey login path has no rate limiting at all

`src/app/api/auth/passkey/auth/verify/route.ts`
`src/app/api/auth/passkey/auth/options/route.ts`

Verified: zero `rateLimit` references in either route, and no proxy-level limiter
(`src/proxy.ts` has none). Both are in `PUBLIC_PATHS`, so they are reachable
unauthenticated by anyone.

Compare the password path (`src/app/login/actions.ts`), which does all of this:

| Control | Password login | Passkey login |
|---|---|---|
| Per-account rate limit | yes | **no** |
| Per-IP rate limit | yes | **no** |
| Failed-attempt accounting | `recordFailedLogin` | **no** |
| Audit trail on failure | yes | **no** (success only) |

This is **not** a credential-brute-force hole: forging an assertion needs the
private key, so guessing gains nothing. Two real consequences remain:

1. **Unauthenticated work amplification.** Each `auth/options` call runs
   challenge generation and sets a signed cookie; each `auth/verify` call runs an
   indexed DB lookup plus signature verification. Unbounded, free, no session.
2. **A blind spot in the record.** `logAudit({action: "passkey.login"})` fires on
   success only. A sustained campaign against the passkey endpoint leaves no
   trace anywhere, while the same campaign against `/login` is both throttled and
   recorded. That asymmetry is the part worth fixing — it is a monitoring gap, not
   just a throttling one.

**Suggested fix:** reuse `rateLimitKey`/`registerRateLimitAttempt` keyed on IP for
both routes, and log failed verifications.

### F2 — The WebAuthn challenge cookie is signed with raw `SESSION_SECRET`

`src/lib/webauthn.ts`

```ts
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret-local-only");
```

This is the **same key-separation issue** that was found and fixed in
`src/lib/domainCheck.ts` during the previous audit, where it was replaced with an
HKDF-derived `proofKey()`. That fix did not get applied here.

Not exploitable today: the challenge JWT carries `{ch, uid}` and a session token
carries `{sub, sv, jti, tid}`, and `verifySession` requires `sub`, so neither
verifies as the other. The objection is that "not exploitable" rests entirely on
the current claim shapes — one added claim on either side turns key reuse into a
cross-context forgery. The codebase has already adopted the right pattern
elsewhere; this call site should match it.

**Suggested fix:** derive a purpose-scoped key via the existing HKDF helper, as
`domainCheck.ts` does.

### F3 — Registration and authentication share one challenge cookie

`src/lib/webauthn.ts` — both ceremonies use `denago_wa_chal` and the same key.
Registration stashes `{ch, uid}`; authentication stashes `{ch}` only.

`register/verify` is bound (`stashed.uid !== user.id` → reject). `auth/verify` is
**not** — it accepts any challenge cookie, including one minted by a registration
ceremony.

I tried to build an attack from this and could not: a registration response is an
attestation object, and `verifyAuthenticationResponse` rejects that shape before
anything security-relevant happens. So this is a missing defence-in-depth binding,
not a live hole.

**Suggested fix:** stash a `purpose` claim (`"reg"` / `"auth"`) and require it to
match in each verifier. Two lines, removes the reasoning dependency entirely.

### F4 — Unhandled throw on the passkey path for a disabled user (robustness)

`createSessionCookie` throws `"User is disabled or no longer exists"`
(`src/lib/auth.ts:238`). In `auth/verify` that call sits outside any try/catch, so
a disabled user presenting a valid passkey gets an unhandled 500 rather than a
clean refusal.

**This fails closed** — no session is issued — so it is a robustness and
error-surface issue, not a vulnerability. Worth a tidy catch returning 400.

---

## 2. What I got wrong

Three hypotheses I pursued as likely findings and then had to withdraw. Recorded
because an audit that hides its own error rate is worth less than none, and
because in each case the code was right and I was wrong.

### Withdrawn — "a disabled user can still log in with a passkey"

The passkey route genuinely does not check `disabledAt`, and on that basis this
looked like an offboarding bypass. It is not, and I should have checked before
believing it. **Two independent layers already contain it:**

- `createSessionCookie` itself refuses (`src/lib/auth.ts:238`) — no cookie is ever
  minted.
- The session read rejects disabled users **and** stale `sessionVersion` on every
  request (`src/lib/auth.ts:66-67`).

The second is the stronger result and it settles a broader question: `getCurrentUser`
re-reads the user **fresh from the database** on every request rather than trusting
the signed cookie. So role demotion and account disablement take effect on the very
next request. The `user.role === "owner"` short-circuit in `hasPermission` — which
would be the single most dangerous line in the codebase if `role` came from the
cookie — is safe because it does not.

### Withdrawn — "`portalCanAccessCase` is missing its soft-delete check"

`portalCanAccessQuote` and `portalCanAccessVehicle` both filter `deletedAt IS NULL`;
`portalCanAccessCase` does not. That asymmetry looked like an oversight letting
customers reach trashed cases.

`CustomerCase` **has no `deletedAt` column**. Cases are `resolved`/`closed`, never
soft-deleted. There is nothing to filter and the asymmetry is correct.

### Withdrawn — "Host-derived WebAuthn rpID is spoofable"

`rpConfig()` derives `rpID` and `expectedOrigin` from the `Host` header, which is
normally a serious anti-pattern — the verifier echoing back an attacker-controlled
value as the thing it "expects".

It does not yield an attack here. The security anchor in WebAuthn is that the
**browser** writes the true origin into `clientDataJSON` and the authenticator signs
over it. An attacker spoofing `Host` on a direct HTTP request still cannot produce
a signature over the challenge without the private key. Deriving rpID per-request is
also deliberate — it is what makes passkeys work across per-tenant domains.

### Two more that were my tooling, not the code

Logged so nobody re-runs them and takes fright:

- **"0 RLS policies exist."** A shell glob (`prisma/migrations/*/*.sql`) silently
  failed to expand. There are 164. Re-run with `find`.
- **"56 server actions are unguarded."** My regex could not see guards reached
  through delegation or a local wrapper. The repo's own
  `tests/actionAuthGates.test.ts` does this properly with the TypeScript AST and
  follows the entry path. All 56 were false positives.

---

## 3. What I attacked and found solid

Not a checklist of things I skimmed — these are the places I actively tried to
break and could not.

**Tenant isolation (RLS).** 164 tables each carry `ENABLE` + `FORCE` + a policy of
the correct fail-closed shape:
`bypass_rls='on' OR "tenantId" = current_setting('app.current_tenant', true)`.
`current_setting(...,true)` returns NULL when unset and `"tenantId" = NULL` matches
nothing, so a missing GUC yields **zero rows, not all rows**. I looked specifically
for a permissive `USING (true)` and there is none. Exactly one table with a
`tenantId` has no policy — `TenantMember` — and that is a documented, correct
exemption: it is the table that answers "which tenant is this user in?" on the
login path, before any scope exists, so a policy on it would be circular. It is
already pinned in `tests/rlsPolicyCoverage.test.ts` under `NO_POLICY_BY_DESIGN`.

**The `basePrisma` bypass surface.** 203 call sites, each of which turns RLS off and
must re-impose tenancy by hand — the sharpest target in the codebase. I extracted
all 58 record operations and isolated the 18 with no tenant predicate in the call.
Every one is either genuinely platform-scope (`platformAdmin` keyed on `actor.id`
from the session) or performs an explicit ownership check in the preceding
statement — e.g. `verifyTenantDomainAction` fetches the domain, tests
`domain.tenantId !== tenantId`, and only then mutates.

**The permission engine.** Fail-closed by construction: `RBAC_UNAVAILABLE` and
`RBAC_INITIALIZED` sentinels mean an unreadable or unseeded RBAC state **denies**
rather than defaulting open — the failure mode this class of bug usually has.

**Portal (external, untrusted users).** OTP verification caps at 5 attempts via an
atomic `updateMany` gate, consumes the challenge atomically before minting a
session, invalidates prior codes under a `pg_advisory_xact_lock`, and rate-limits
per account and per IP. Every action taking a client-supplied id
(`addPortalCaseMessage`, `uploadPortalFile`, `createPortalCase`) checks
`portalCanAccessCase`/`Contact`/`Vehicle` first; the rest derive the contact from
the session, not the request.

**File access.** Both upload routes authorize the **record**, not just the module,
and `api/cases/uploads/[id]` additionally re-asserts tenant ownership and verifies
the blob belongs to the record. Its header documents the exact IDOR it replaced.

**Public token routes (signing, approvals, tracking).** Tokens are 224-bit
(`randomBytes(28)`), stored **SHA-256 hashed**, and looked up by hash — no query
anywhere matches a readable secret, so database disclosure yields nothing usable.
`timingSafeEqual` is used consistently across webhooks, cron, TOTP and domain-check,
with a shared `secretCompare.ts` helper.

**Proxy path matching.** `pathname === p || pathname.startsWith(p + "/")` — no
prefix-confusion bypass (`/loginfoo` does not match `/login`).

**Dependencies.** `npm audit --omit=dev`: 0 critical, 3 high — all the same
`deepmerge-ts` stack-exhaustion advisory reached only via `@prisma/config`, i.e. the
Prisma CLI at build time. Not reachable by an attacker at runtime.

**Test suite.** 4048 unit tests, 4047 pass, 0 fail, 1 skipped.

---

## 4. Honest limits of this pass

- **Static and local only.** No probing of the running production deployment.
- **No live cross-tenant proof.** The strongest possible evidence for the isolation
  claims is a second tenant trying to read the first under the restricted role.
  That harness exists (`test:rls-restricted`, `test:tenant-e2e`) and was **not** run,
  because the only database reachable from here is production.
- **Role-to-role authorization remains partly unproven.** Same gap the previous
  audit declared. `actionAuthGates.test.ts` proves a guard is *reached*; proving the
  guard is the *correct* one for each action needs a route-policy manifest, and that
  is still a follow-up.
- **The passkey findings are unexploited by construction.** I argued each to a dead
  end rather than demonstrating a working attack, which is the correct outcome but
  is weaker evidence than a proof-of-concept would be.

## 5. Recommendation

Nothing here is urgent and nothing warrants an emergency change. F1 (rate limit +
log failed passkey attempts) is the one with real operational value, because it
closes a monitoring blind spot rather than only a throttling one. F2 and F3 are
cheap consistency fixes that make the passkey flow match patterns the codebase has
already adopted elsewhere.

No code was changed in this pass — this is an assessment. Say the word and I will
open a PR for F1–F4.
