# Does `enterWith` propagate in a real Next request?

**Answer: YES. Enforcement will not fail closed on every request. The flip is not blocked by this.**

Measured 2026-08-11 against Next.js 16.2.10 (Turbopack) on a real running dev
server, three ways, all positive.

---

## Why this was asked

PR #468's two-tenant harness reported that `getCurrentUser` leaves **no tenant
scope** in a plain Node process, because `AsyncLocalStorage.enterWith()` does not
propagate out of React's `cache()`. The harness compensates for this and reports
it as its own check.

That mattered enormously, because it is the mechanism the entire staff CRM depends
on. `getCurrentUser()` is wrapped in React `cache()`. It calls
`establishStaffTenantScope()`, which enters the request's tenant scope via
`enterTenantScope()` → `storage.enterWith(scope)`. The doc comment on
`enterTenantScope` is explicit about why it cannot use the safer wrapper:

> For chokepoints that resolve-then-return rather than wrap a callback — e.g.
> `getCurrentUser()`, which resolves the user and returns it, leaving the rest of
> the request to run outside any wrapper.

So if `enterWith` did not survive that return, then under enforcement every staff
request would run with no scope, the db guard would refuse every query, and the
flip would take the site **down** rather than leak.

---

## The experiment

Temporary probes that call `enterTenantScope()` inside a `cache()`d function and
then read `currentTenantScope()` back, on a real request. They touch no database.
Placed under public path prefixes (`/api/bookings/…`, `/signing/…`) so the proxy
would not bounce them.

Each probe also runs a **control**: the same `enterWith` *without* `cache()`, to
separate "`cache()` breaks it" from "`enterWith` never propagates in this runtime".

Note: folders prefixed `_` are private in the App Router and are excluded from
routing — the first attempt 404'd for that reason, not for a scoping reason.

## Results

**1. Route handler** — `/api/bookings/probe-scope`

```json
{ "before": null,
  "insideCached":  { "tenantId": "probe_cached" },
  "afterCached":   { "tenantId": "probe_cached" },
  "verdict": { "cachedPropagates": true, "plainPropagates": true } }
```

**2. Server Component, same component** — `sameComponentPropagates: true`.

**3. Cross-segment — the one that actually matters.** A `layout.tsx` entered the
scope inside a `cache()`d function; the `page.tsx` beneath it read it back:

```json
{ "seenFromPage": { "tenantId": "probe_from_layout" },
  "crossSegmentPropagates": true }
```

A nested child component rendered later also saw the scope the page had entered.

That third case is the real architecture: an authenticated chokepoint establishes
the scope, and a *different* React segment renders and issues the queries. The
first two probes only prove the scope survives an `await`; the third proves it
crosses the segment boundary. All three are positive.

---

## So why does the harness see the opposite?

The harness runs in **plain Node**, with no Next request context and therefore no
React request store behind `cache()`. Outside that context `cache()` does not
behave as it does inside a render — and the harness's observation is an artifact
of that absence, not a property of the application.

**This cuts against the harness, and the harness's own results should be re-read
in that light.** It compensates for a scope-propagation failure that does not
happen in production, which means its enforced pass exercises a scope-entry path
that differs from the one production uses.

What that does and does not invalidate:

- **Still valid.** The enforced-pass failures that concern writes through
  `basePrisma` (Quote, JobCard, TimelinePin) and the two global unique indexes
  that stop a second tenant having a default pipeline. Those are independent of
  how scope was established.
- **Needs re-reading.** Anything in the harness whose result depends on *how* the
  scope was entered. The harness proves the guard refuses unscoped queries; it
  does not prove the real chokepoint establishes a scope, because it replaces that
  chokepoint. This document is now the evidence for that half.
- **Risk to avoid.** Someone reading the harness could conclude `enterWith` is
  broken and "fix" it by restructuring `getCurrentUser`. That would be a change
  with real risk, made against a non-bug. The harness should carry a note saying
  its compensation is a test-harness artifact.

---

## Limits of this finding — stated plainly

- Tested the **mechanism**, not the full enforced path. The probes call
  `enterTenantScope` directly, bypassing the `tenantEnforcing()` early-return that
  makes `establishStaffTenantScope` a no-op today. That is the right test for the
  question that was in doubt, but it is not an end-to-end enforcement test.
- **Server Actions were not tested.** Route handlers and Server Components were.
  A Server Action is a third dispatch path and should be probed before the flip.
- Dev server only (Turbopack). Not verified against a production build, where
  bundling and React's server runtime differ.
- Single Next version: 16.2.10. This is a runtime behaviour, not a documented API
  guarantee — `enterWith` propagating out of `cache()` is not something Next or
  React promises, so a future upgrade could change it silently.

That last point is the one worth acting on. The code already knows it:
`tenantScopeEntry.ts` says "RELIABLE `runInTenantScope`, never `enterWith` after a
guarded bootstrap", and `tenantScope.ts` says "Prefer `runInTenantScope` wherever
you control the enclosing callback." Both are right. `enterWith` works here, but
it works by grace rather than by contract, and nothing in CI would notice if a
Next upgrade broke it.

**Recommendation:** keep `enterWith` (changing it is riskier than leaving it), and
add a cheap regression test that boots a real request and asserts the scope
crosses a layout→page boundary — the probe in this document, made permanent. That
converts a silent, catastrophic upgrade failure into a red test.
