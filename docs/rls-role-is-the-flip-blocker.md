# The database role is the enforcement blocker (audit P2-1)

Verified against production, 2026-08-11, read-only:

```
connected as: { u: "neondb_owner", rolsuper: false, rolbypassrls: true }
TimelinePin RLS: { relrowsecurity: true, relforcerowsecurity: true }
```

Row-level security is **enabled and FORCED** on the table. It does nothing,
because the role the application connects as bypasses RLS entirely.

---

## A correction I need to make

Earlier in this work I told Sean that "Layer 2b" gives raw SQL a boundary: every
query through the scoped `prisma` client runs inside a transaction that issues
`SET LOCAL app.current_tenant`, so `prisma.$queryRaw` is bounded by RLS even
though the Prisma extension cannot rewrite raw SQL.

**The mechanism is real; the conclusion was wrong.** `SET LOCAL app.current_tenant`
is only load-bearing if a policy evaluates it, and no policy ever evaluates for a
`BYPASSRLS` role. So raw SQL through the scoped client has **no effective tenant
boundary in production today**, and will still have none after enforcement is
switched on, because enforcement changes the application layer and not the role.

This was already recorded on 2026-08-06 — RLS enabled and forced on 120 tables
while the app connects as `neondb_owner`, proved at the time with an unset-tenant
read that returned rows. I had that fact and failed to apply it. The consequences
below follow from it.

## What it invalidates

**PR #458's `scoped-raw` category — 14 sites — is misclassified.** It separates
`prisma.$queryRaw` (treated as RLS-bounded, therefore not a violation) from
`basePrisma.$queryRaw` (bypass, therefore a violation). With a BYPASSRLS role
those two are the same thing. The split is the correct *design*; it is just not
true of this deployment yet. Either the role changes, or those 14 move into the
violation count.

**The harness's `TimelinePin` READ failure is real, not an artifact.**
`getTimelinePins` is `prisma.$queryRaw`, so asking for another tenant's activity
id returns their pin — and it keeps returning it under enforcement. That is the
first enforced-pass failure found that the application layer alone cannot fix.

## What it means for the flip

Turning on `TENANT_ENFORCEMENT` scopes the Prisma model operations. It does not
scope raw SQL, because the thing that was supposed to scope raw SQL is switched
off by the role. So the flip delivers **partial** isolation: model queries bounded,
raw SQL unbounded, and the difference invisible from the application.

That is the worst kind of partial, because it looks complete. Every audit, every
contract test and every code review that reasons "raw SQL is covered by RLS" is
reasoning about a policy that never runs.

## The fix, and why it is not a code change

Connect as a role **without** `BYPASSRLS`, with the policies granted to it.
Concretely:

1. Create a restricted application role, grant it the privileges the app needs,
   and confirm `rolbypassrls = false`.
2. Verify every RLS policy names that role, and that `app.current_tenant` /
   `app.bypass_rls` are readable by it.
3. Point `DATABASE_URL` at the restricted role in a preview environment first.
4. Run the two-tenant harness's enforced pass against it. `TimelinePin` READ is
   the canary: it must flip from fail to pass with **no application change**.
5. Only then consider production.

There is an existing branch `chore/rls-app-role` that appears to start this work
— it should be reviewed against these steps rather than restarted.

Step 4 is the one that matters. Until a raw-SQL cross-tenant read is *observed*
being refused, the RLS layer should be treated as decorative — which is what it
has been since it was enabled.

## Status

P2-1 (TenantMember has no RLS) is a subset of this. A missing policy on one table
is moot while no policy on any table evaluates. Fix the role first; the
per-table gaps become meaningful the moment it lands, and not before.

**This is a pre-flip blocker.** Not because enforcement would break anything —
the `enterWith` investigation showed the application layer holds — but because
flipping it would produce a system that reports isolation it does not have.
