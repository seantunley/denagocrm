# The owner boundary (P2-5), and what has to be true before the flip (P2-2)

## Part 1 — `role: "owner"` is a platform superuser, and every workspace owner will have it

`User.role` is a **global** column. It has no tenant dimension, and it
short-circuits the entire permission system:

| where | what an owner gets |
|---|---|
| `permissions.ts:65` | every permission in `PERMISSIONS` |
| `permissions.ts:70`, `:76` | `true` for any check |
| `permissions.ts:184` — `scopePermissions` | **`null`: no RBAC scope narrowing at all** |
| `auth.ts:202` | under enforcement, forced membership of the **founding tenant** |
| `resolveLoginTenant` | under enforcement, falls back to the **founding tenant** |

`requireOwner` guards **49 files**. `requireTenantOwner` guards **9**.

So when a second workspace is provisioned and its administrator is made the owner
of that workspace — which is the obvious, natural thing to do — they receive a
flag that means *platform operator*. They get every permission, no record-scope
narrowing, forced membership of workspace A, and a login that resolves to
workspace A.

**Making someone the owner of workspace B makes them an owner of workspace A.**

That is not a leak in a query. It is the access model: one boolean is being asked
to mean two different things — "runs this platform" and "administers this
workspace" — and only the first is implemented.

There is an OWNER ESCAPE HATCH in `establishStaffTenantScope` that is deliberate
and correctly documented: under enforcement, an owner with no resolvable tenant
proceeds with **no scope at all** so the platform console keeps working, while
every tenant-scoped query fails closed. That is sound for a platform operator. It
is the wrong behaviour for a workspace owner, and today they are the same person.

### The fix, in shape

1. `User.role = "owner"` keeps ONE meaning: platform operator. There should be
   very few, and `PlatformAdmin` may already be the better home for them.
2. Workspace ownership moves onto `TenantMember` as a per-tenant role. "Owner of
   B" then cannot say anything about A, structurally.
3. Triage the 49 `requireOwner` call sites. Most are workspace administration and
   want `requireTenantOwner`. A handful are genuinely platform-level. #397's
   review already found one of these by hand — publishing a dashboard to your own
   workspace was gated on the global flag, so a provisioned owner of B could not
   publish their own dashboard.
4. `scopePermissions` must stop returning `null` for a workspace owner. Full
   permissions **within a workspace** is a different statement from no scope at
   all, and the current code cannot express the difference.

This is a design change, not a patch, and it should not be attempted in the same
pass as the remediation PRs. But it must land before a second workspace is
provisioned, because provisioning one is what turns it from latent into live.

---

## Part 2 — the pre-flip sequence

Enforcement is config-gated (`tenantEnforcing()`), which the audit lists as P2-2.
The gate is not the problem; the problem is what is true on either side of it.
Ordered by what blocks what:

### Must be true before the flip

1. **The database role must stop bypassing RLS.** Production connects as
   `neondb_owner` with `rolbypassrls = true`, so no policy on any table ever
   evaluates. Raw SQL through the scoped client is therefore unbounded, and
   flipping enforcement does not change that — it scopes Prisma model operations
   only. See `rls-role-is-the-flip-blocker.md`. **The canary is `TimelinePin`
   READ in the two-tenant harness: it must go from fail to pass with no
   application change.**
2. **The harness's enforced pass must be green**, and its remaining 26 uncovered
   checks understood rather than merely counted.
3. **The writers must stop producing wrong owners.** Mostly landed across
   #459/#462/#470/#471/#473, but two bot-stack sites are deliberately unconverted
   and blocked on `withChannelTenantScope` binding while dormant.
4. **The unowned rows must be backfilled** — 44 from genuinely broken writers,
   plus the legacy remainder. Backfilling before the writers are fixed just resets
   a counter.
5. **Tables with no `tenantId` column must be resolved** (#461), and the ones that
   exist only in production must become reproducible from the repository.

### Must be decided, not fixed

- `Organization` / `OrganizationMembership`: drop them. They are fossils of the
  renamed `tenant_foundation` migration, not a second concept.
- The dead settings stage form: delete or revive (#466 recommends delete).
- The owner boundary above: before a second workspace, not before the flip.

### The flip itself

Per environment, and **not** as a single switch: preview first, with the harness
green against the restricted role, then production. The `enterWith` investigation
confirmed the application layer propagates scope correctly through route
handlers, Server Components and across a layout→page boundary, so the flip will
not fail closed on every request — that risk is retired.

### What "green" must not mean

Three separate layers have reported success in this codebase while doing nothing:
RLS enabled and forced on 120 tables under a bypassing role; a schema contract
passing 4/4 while six tables sat 100% unowned; and enforcement dormant, which
makes scoped and unscoped queries indistinguishable in dev, in CI and in
single-tenant production.

The two-tenant harness is the only instrument that has produced a falsifiable
result. Sign-off should rest on its enforced pass and on nothing else.
