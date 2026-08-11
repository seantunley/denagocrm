# One root cause behind the #460 blocker and the harness's `Contact` finding

Both trace to a single line. `currentScopeClass()` in `src/lib/tenantWrite.ts`:

```ts
export function currentScopeClass(): ScopeClass {
  if (!tenantEnforcing()) return { mode: "global" }; // dormant — unchanged behaviour
  ...
}
```

**Dormant is mapped to `global`.** Every branch downstream that asks "what scope am
I in?" therefore takes the *no-tenant* path in every environment we currently run —
dev, CI and production. The comment "unchanged behaviour" is accurate and is exactly
the problem: unchanged behaviour means pre-tenancy behaviour.

That single mapping produces three distinct defects.

---

## 1. `withTenantWrite` stamps the founding tenant onto everyone's rows

```ts
export async function withTenantWrite<T>(fn) {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;   // ← dormant ⇒ DEFAULT
  return basePrisma.$transaction((tx) => fn(tx, tenantId));
}
```

`writeTenantId()` returns null while dormant, so **every** caller stamps
`DEFAULT_TENANT_ID` — `tenant_denago_cpt` — no matter which workspace the user is
acting in. `createContact` goes through this helper, which is precisely what the
two-tenant harness observed: *"Contact creation persists `tenant_denago_cpt`
regardless of actor."*

This is the worse failure mode of the two we have been fixing. A NULL owner is
merely invisible after the flip and obvious in an audit. A **convincingly wrong**
owner looks correct, passes every shape-based test, and silently hands one
workspace's contacts to another.

## 2. Assignment membership checks are inert while dormant — the #460 blocker

`resolveTenantMemberUser()` in `src/lib/tenantActor.ts` performs the `TenantMember`
join **only** when the scope class is `tenant`:

```ts
const s = actorScope();
if (s.mode === "closed") return null;
if (s.mode === "tenant") { /* … JOIN TenantMember … */ }
// otherwise: a plain global User lookup
```

So `resolveAssignableUser()` — and therefore `Contact.ownerId`,
`CustomerCase.assignedToId` and `JobCard.technicianId` — validates membership only
*after* enforcement is switched on. Today it validates nothing.

## 3. Staff pickers enumerate the whole platform

`listTenantStaff()` joins `TenantMember` under the same condition, so while dormant
it returns every active `User` on the platform. The pickers moved onto it in #460
and #467 are correct in shape and still global in effect.

---

## Why this kept passing review

Every test for this machinery establishes a tenant scope first, which puts the
scope class into `tenant` mode — the branch that works. Nothing exercised the
branch that actually runs in production. It is the same pattern as the schema
contract passing 4/4 while six tables sat 100% unowned: the tests assert the
enforced future, and the defect lives in the dormant present.

---

## The fix — shape, not patch

**Do not simply flip `currentScopeClass()` to resolve a session tenant while
dormant.** Some background and token paths deliberately depend on the current
`global` semantics, and `withTenantWrite` has callers of both kinds — `botOutbox`
has no session at all, while `createContact` always does. A blanket change would
swap one silent misattribution for another.

The shape that already works elsewhere in this codebase is the acting/inherited
split established by #462 and #464:

- **user-originated** writes resolve the *validated session workspace* while
  dormant and the *enforced scope* once enabled — `actingTenantId()`;
- **runtime/background** writes derive the tenant from the record being acted on —
  `inheritedTenantId(record)`;
- neither invents an owner.

Applied here that means:

1. Give assignment its own acting-workspace resolver rather than changing
   `resolveTenantMemberUser()` globally. Same rule as `actingTenantId()`: session
   tenant while dormant, enforced scope after.
2. Split `withTenantWrite` by caller kind, or require the caller to pass the owner
   it has already resolved. The helper cannot guess correctly for both.
3. Give `listTenantStaff()` the same acting-workspace treatment, so the picker and
   the check agree in **both** modes — a picker fixed without its check is half a
   fix, and a check that is inert while dormant is the other half missing.

Each needs a test that runs with **enforcement dormant** and asserts that a user of
workspace B is refused, and that a row created by B's staff is stored as B's. Every
existing test in this area proves the enforced branch. None proves the branch that
is live today.
