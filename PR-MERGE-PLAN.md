# PR merge plan — the multi-tenancy PR wave

**Status: WIP.** Everything below is either marked **VERIFIED** (I executed it) or **INFERRED** (I read it and reasoned). The dashboard-cluster semantic analysis (§5.3) is still in flight and is marked as such — do not treat that section as complete.

**All SHAs pinned 2026-08-10T20:13Z.** Branch refs are moving under active agents; re-pin before acting.

| PR | branch | tip | base (merge-base with `origin/main`) | ahead | behind |
|---|---|---|---|---|---|
| #459 | `fix/p0-bypass-write-stamping` | `ee9b61ae` | `3c8624c9` | 1 | 1 |
| #458 | `feat/tenant-guard-sweep` | `d002873c` | `3c8624c9` | 1 | 1 |
| #457 | `feat/kanban-pipeline-context` | `be28de74` | `3c8624c9` | 3 | 1 |
| #460 | `fix/assignable-person-contract` | `fbcca532` | `80e7b6c8` | 1 | 0 |
| #461 | `feat/tenant-column-coverage` | `4a7f57b8` | `80e7b6c8` | 1 | 0 |
| #462 | `fix/tenant-stamp-journeys-and-records` | `41b1341a` | `0d01bd81` | 2 | **63** |
| #430 | `claude/red-prs-review-l2k2yv` | `6ba9fea9` | `8932f6a5` | 2 | **373** |
| #397 | `feat/dashboard-sharing` | `83d2cade` | `8932f6a5` | 5 | **373** |
| #429 | `fix/dashboard-drag-reliability` | `01a7f598` | `8932f6a5` | 15 | **373** |
| #428 | `fix/card-height-not-grid-rows` | `71581d58` | `8932f6a5` | 3 | **373** |
| #395 | `feat/dashboard-editor-depth` | `cd21f4cf` | `8932f6a5` | 2 | **373** |

`origin/main` = `80e7b6c87467aee7157ad5536593fc88d0bef58b`.

---

## 0. DO THIS FIRST

1. **`git fetch` and re-pin.** Your local `main` is `0d01bd81`, **63 commits behind `origin/main`** (`80e7b6c8`). Every merge-base calculation done against local `main` is wrong. I made that mistake once in this analysis and had to redo it — anyone reviewing these PRs locally will make it too. **VERIFIED** (`git merge-base --is-ancestor main origin/main` → yes; `git rev-list --count main..origin/main` → 63).
2. **Land the canonical `src/lib/actingTenant.ts`** (this PR). Four open branches each add that file; three add a second copy of a rule that already ships on `main`. Landing the canonical first turns four add/add conflicts into four file deletions. See §2.
3. **There is a PR nobody listed: #430 `claude/red-prs-review-l2k2yv` — "Stamp the tenant on writes that bypass the guard".** It is an earlier attempt at #459 and it conflicts with #459 on both `quotes.ts` and `jobcards.ts`. It also contains work #459 does **not** have. Decide its fate before merging #459. See §5.2.
4. **Do not merge #458 until last.** Its baseline fixture is a strict two-sided equality snapshot: it goes red when tenant safety *improves*. See §5.5.
5. **Five of the branches named in the brief do not exist as committed work** — see §6. Do not plan around them.

---

## 1. TASK 1 — are `decideActingTenant` and `decideBuilderTenant` behaviourally identical?

### **YES. Identical on every input executed. No divergence.** — **VERIFIED BY EXECUTION**

Both bodies reduce to the same expression:

```ts
// src/lib/actingTenantRule.ts  (added by #459, #457, #430 — identical blob 2a0220f0)
export function decideActingTenant(input: {...}): string {
  return input.enforcedTenantId ?? input.sessionTenantId ?? DEFAULT_TENANT_ID;
}

// src/lib/flowTenantScope.ts  (ALREADY ON MAIN since #452)
export function decideBuilderTenant(input: {...}): string {
  return input.enforcedTenantId ?? input.sessionTenantId ?? DEFAULT_TENANT_ID;
}
```

I did not take that on inspection. I executed both against a matrix and compared, with a negative control to prove the harness can see a difference.

**What was executed** (Node 22.22, `node --import tsx --experimental-test-module-mocks --test`):

| suite | cases | result |
|---|---|---|
| pure rules, full cross product of `{null, "", "   ", A, B, DEFAULT}²` | 36 | 0 divergences |
| pure rules, enforcement × session matrix (below) | 24 | 0 divergences |
| adversarial: `undefined`, missing keys, `0`, `false` (`??` vs `\|\|` probe) | 9 | 0 divergences |
| **the real composed `actingTenantId()` bodies**, both branch variants loaded side by side with `writeTenantId` / `getActiveTenantId` module-mocked | 24 | 0 divergences |

The matrix dimensions the brief asked for, and how they were modelled — `tid` staleness and multiple membership are properties of `getActiveTenantId()`, which **both wrappers call identically**; per `src/lib/auth.ts:342-351` it returns `honoredTenantClaim(session.tid, resolveActingTenant(user.id))`, so a stale claim and an ambiguous (2+ active membership) claim both collapse to `null`:

| enforcement | session state | both return |
|---|---|---|
| dormant (`writeTenantId() === null`) | no session (background/cron) | `tenant_denago_cpt` |
| dormant | session, no `tid` (minted pre-claim) | `tenant_denago_cpt` |
| dormant | `tid=A` valid, sole membership A | `tenant_a` |
| dormant | `tid=B` valid, sole membership B | `tenant_b` |
| dormant | `tid=A` **stale** → dropped to null | `tenant_denago_cpt` |
| dormant | `tid=A` **ambiguous** (2nd membership) → dropped | `tenant_denago_cpt` |
| enforcing scope=A | *(all six session states)* | `tenant_a` |
| enforcing scope=B | *(all six)* | `tenant_b` |
| enforcing scope=DEFAULT | *(all six)* | `tenant_denago_cpt` |

"Enforcing with no usable scope" is deliberately **not** a row: `writeTenantId()` throws `TenantScopeError` before either rule is reached (`src/lib/tenantWrite.ts:52-57`), identically for both wrappers.

**Negative control — VERIFIED.** Changing `??` to `||` in `decideActingTenant` made the harness fail immediately and name the inputs, e.g. `enforced="" session=A → decideActingTenant="tenant_a" decideBuilderTenant=""`. Reverted. The equivalence result is therefore a real measurement, not a test that cannot fail.

The probe test is at
`…/scratchpad/ruleEquivalence.test.ts` (not committed — it imports two throwaway probe modules).

### Consequence for merge order

**Because the two rules are behaviourally identical, merging #457/#459 and #462 in either order is SAFE at runtime.** No row will be stamped with a different tenant depending on which landed first. There is no live bug of that kind.

**But the collision is still real and still blocking, for a different reason: a TEST pins the implementation.** See §2.1.

---

## 2. TASK 2 — the canonical implementation

### Recommendation: **`src/lib/actingTenant.ts` delegates to `decideBuilderTenant` from `./flowTenantScope`** (i.e. #462's wiring), with a merged doc comment. **`src/lib/actingTenantRule.ts` is deleted from #459, #457 and #430.**

The canonical file is in this PR.

**Why this one and not `actingTenantRule.ts`:**

1. **`decideBuilderTenant` already ships on `main`.** It landed in #452 (`main`'s head at `0d01bd81`). `actingTenantRule.ts` does not exist on `main`. So adding it does not consolidate a rule — it creates a **second** copy of a rule that already exists, in a repo where three separate branches would each carry that copy. That is precisely the failure the file's own doc comment says it exists to prevent. **VERIFIED** (`git ls-tree origin/main` — `src/lib/flowTenantScope.ts` present, `src/lib/actingTenantRule.ts` absent).
2. **#462 also *removes* the duplicate.** It rewires `src/lib/flowScope.ts:41-48` so `builderTenantId()` becomes `return actingTenantId()` — collapsing `main`'s existing caller onto the shared function. #459/#457/#430 leave `flowScope.ts` calling `decideBuilderTenant` directly, so after they merge there are genuinely **two implementations with two callers**. #462 ends with one. **VERIFIED** by diff.
3. **#462's documentation is materially better** — it explains the dormant-enforcement mechanism, names `scopeArgs` as the same failure, quantifies the production damage, and points at the runtime counterpart (`inheritedTenantId`). #459's `actingTenantRule.ts` has the better *worked example* (`user in workspace B → founding tenant`) and the better *warning* (not for background work). **The canonical file in this PR keeps both.**
4. **Callers: roughly even, so this is not the deciding factor.** #459 has 11 `actingTenantId()` call sites (quotes, job cards), #457 has 5 (pipelines), #462 has 5 (dashboard, dashboardConfig, testDrives, flowScope), #430 has ~8 (helpdesk, portal, privacy, recordSigning, quotes, jobcards). All of them call `actingTenantId()`, none call the rule directly, so the choice of rule module is invisible to every caller.
5. **Fewer files, no new module, compiles against `origin/main` with zero other changes.** **VERIFIED**: `tsc --noEmit` on `origin/main` + the canonical file produces **no error mentioning `actingTenant`, `flowTenantScope` or `flowScope`** (1672 pre-existing errors in this worktree, all `next/*` type-resolution noise from a worktree that has never run `next dev`; the count is unchanged by this file).

**The one honest argument against it**, which the brief anticipated: `flowTenantScope.ts` is flow-builder-specific by name, and it also holds `legacyFlowTenant`, which genuinely *is* flow-specific. Housing the shared rule there is a naming wart.

**I recommend accepting the wart now and fixing it as a separate rename.** Moving the rule to a neutral module in *this* PR would require editing `flowTenantScope.ts`, `flowScope.ts` and `tests/flowBuilderTenantScope.test.ts` at the same moment four branches are queued against those files — which trades a naming problem for three more conflicts. The follow-up is a pure rename: move `decideBuilderTenant` into `src/lib/actingTenantRule.ts` as `decideActingTenant`, re-export or update the two call sites, update `tests/flowBuilderTenantScope.test.ts`. Do it once the queue is empty. The canonical file's doc comment says so, so the next reader is not left wondering.

### 2.1 Exactly what each branch must change — **do not do this for them**

| branch | required change |
|---|---|
| **#459** `fix/p0-bypass-write-stamping` | **Delete `src/lib/actingTenantRule.ts`.** Replace `src/lib/actingTenant.ts` with the canonical blob from this PR (or drop the file entirely once the canonical has landed). No other change: `tests/bypassWriteStamping.test.ts:106` only asserts `import { actingTenantId } from "@/lib/actingTenant";` in `quotes.ts`/`jobcards.ts`, which still holds. **VERIFIED** by reading the assertion. |
| **#457** `feat/kanban-pipeline-context` | Identical to #459 — same two blobs (`d434e99a`, `2a0220f0`). Delete `actingTenantRule.ts`, drop/replace `actingTenant.ts`. `tests/kanbanPipelineContext.test.ts` asserts only `await actingTenantId()` in `pipelines.ts`. **VERIFIED**. |
| **#430** `claude/red-prs-review-l2k2yv` | Same two blobs again. Delete both. Also needs a rebase (373 behind) and a scope reduction — see §5.2. |
| **#462** `fix/tenant-stamp-journeys-and-records` | **Two changes.** (a) Replace its `src/lib/actingTenant.ts` with the canonical blob — the wiring is the same, only the doc comment differs, so this is cosmetic but it is what makes the four add/adds resolve to *identical content* and therefore merge silently. (b) **`tests/tenantStampBleedRecords.test.ts` — the test named "there is exactly one implementation of the acting-tenant rule" asserts `assert.match(acting, /decideBuilderTenant\(\{/)`.** The canonical file satisfies this today; if the follow-up rename in §2 ever happens, that assertion must move with it. Leave it as-is for now. **VERIFIED**: I ran all three pinned regexes against the canonical file — all PASS. |

**The load-bearing detail for whoever merges second:** #462 is the only branch that pins `actingTenant.ts`'s *implementation*, at `tests/tenantStampBleedRecords.test.ts` and `tests/flowBuilderTenantScope.test.ts`. #459/#457/#430 pin only the *import in their callers*. So:

- **If #459/#457 land first and the add/add is resolved by keeping their file, #462's test suite goes RED** on `assert.match(acting, /decideBuilderTenant\(\{/)` — the file would say `decideActingTenant`. **VERIFIED** by reading both files and the assertion.
- If #462 lands first, keeping its file, #459/#457 stay green but leave `actingTenantRule.ts` as an unimported orphan.

The asymmetry is why the canonical goes in first.

---

## 3. Conflict matrix — **VERIFIED with `git merge-tree --write-tree`**

Method: for each PR, `merge-tree(origin/main, tip)` → a synthetic "main + PR" commit; then `merge-tree` those pairwise. No ref was moved, nothing was merged into `main`, no working tree was touched. #462 was first rebased onto `origin/main` in a private scratch worktree (`scratch/rebase-462` = `184c60f3`) because it does not merge cleanly on its own — see §5.4.

### Each PR against `origin/main`

All ten merge **CLEAN** except **#462**, which conflicts on `src/lib/conversations.ts`. (#430 also merges clean against main on its own.)

### Pairwise — only pairs sharing a file are listed

| pair | shared files | textual |
|---|---|---|
| #459 × #460 | `src/app/actions/jobcards.ts` | **clean** |
| #457 × #459 | `src/lib/actingTenant.ts`, `src/lib/actingTenantRule.ts` | **clean** (identical blobs) |
| #459 × #462 | `src/lib/actingTenant.ts` | **CONFLICT** (add/add) |
| #457 × #462 | `src/lib/actingTenant.ts` | **CONFLICT** (add/add) |
| #430 × #462 | `src/lib/actingTenant.ts` | **CONFLICT** (add/add) |
| #430 × #459 | `quotes.ts`, `jobcards.ts` | **CONFLICT** (both files) |
| #430 × #460 | `helpdesk.ts`, `jobcards.ts` | **clean** |
| #430 × #457 | `actingTenant.ts`, `actingTenantRule.ts` | **clean** (identical blobs) |
| #397 × #462 | `src/app/actions/dashboardConfig.ts` | **CONFLICT** |
| #429 × #462 | `src/app/actions/dashboardConfig.ts` | **clean** — *semantic check needed, §5.3* |
| #397 × #429 | `dashboardConfig.ts`, `DashboardScreen.tsx`, `DashboardEditorRoot.tsx`, `store.ts` | **CONFLICT** in `src/lib/dashboard/store.ts` |
| #428 × #429 | `DashboardCanvas.tsx`, `tests/dashboardCardHeight.test.ts` | **CONFLICT** (both) |
| #395 × #397 | `DashboardEditorRoot.tsx` | **CONFLICT** |
| #395 × #428 | `DashboardCanvas.tsx` | **CONFLICT** |
| #395 × #429 | `DashboardCanvas.tsx`, `DashboardEditorRoot.tsx`, `EditorProvider.tsx`, `tests/dashboardEditor.test.ts` | **clean** — *semantic check needed, §5.3* |

**#458 and #461 share no file with any other PR.** Their collisions are entirely semantic (§5.5, §5.6).

---

## 4. TASK 4 — recommended merge order

Two independent clusters. They share exactly one file (`src/app/actions/dashboardConfig.ts`, via #462), so the clusters can be worked in parallel by different people — but #462 must land before the dashboard cluster is resolved, or that one file gets resolved twice.

### Order

| # | PR | why this position | action |
|---|---|---|---|
| **0** | **this PR** (canonical `actingTenant.ts` + this plan) | Turns four add/add conflicts into four deletions. Zero behaviour change: the file is byte-equivalent in wiring to #462's, which is byte-equivalent in behaviour to #459's (§1). | merge |
| **1** | **#461** `feat/tenant-column-coverage` | Shares **no file** with any other PR. Pure foundation: 8 DB-only tables get `tenantId` + FORCE RLS. It also bumps the GUC-span count in `tests/migrationIntegrity.test.ts` from 15 to 16 in the same commit, and that assertion is a hard-coded integer — a conflict magnet if anything else adds a GUC migration later. Land it while nothing else touches that file. | **merge** |
| **2** | **#459** `fix/p0-bypass-write-stamping` | The P0. One commit, one behind `origin/main`. Independent of everything except the `actingTenant.ts` file, which step 0 has already settled. | **rebase** onto `origin/main` (1 commit), **delete `src/lib/actingTenantRule.ts` and `src/lib/actingTenant.ts`**, merge |
| **3** | **#457** `feat/kanban-pipeline-context` | Same base, same deletions. Clean against #459 and #460. Its raw `INSERT INTO "PipelineStage" (…, "tenantId")` writes are against **real, existing columns** — verified, not a phantom-column hazard (§5.6). | **rebase**, delete the same two files, merge |
| **4** | **#462** `fix/tenant-stamp-journeys-and-records` | Must come after step 0 so its `actingTenant.ts` is already canonical. Needs a real rebase with a hand-resolved conflict (§5.4). Land it before the dashboard cluster so `dashboardConfig.ts` is stamped once, not twice. | **REBASE — not merge.** 63 behind; `src/lib/conversations.ts` conflict must be resolved by hand, see §5.4 |
| **5** | **#460** `fix/assignable-person-contract` | Already based on `origin/main`. Clean against #459 and #430. Ordered after #459 only because both touch `jobcards.ts` and it is easier to review the second diff against a settled file. | merge |
| **6** | **#430** `claude/red-prs-review-l2k2yv` | Only *after* #459, and only after being cut down to the four files #459 does not cover. See §5.2. | **rebase + reduce scope**, or close |
| **7a** | **#428** `fix/card-height-not-grid-rows` | **First of the cluster.** It deletes the `CARD_ROWS` / `auto-rows` model that #429's `DropMarker` still consumes (§5.3.2). Landing #428 first means #429 is rebased *onto* the new model and its `DropMarker` is fixed once, deliberately. The reverse order means fixing it under conflict pressure, with a test that contradicts itself (§5.3.3). | **rebase**, merge |
| **7b** | **#395** `feat/dashboard-editor-depth` | Compatible with #429 — verified, not assumed (§5.3.4). Conflicts with #428 only at one hunk in `DashboardCanvas.tsx` and with #397 in `DashboardEditorRoot.tsx`. Cheapest to land while the file is still small. | **rebase**, merge |
| **7c** | **#429** `fix/dashboard-drag-reliability` | 15 commits, the largest of the cluster. Must drop `CARD_ROWS` from `DropMarker` and discard its 5-line edit to `tests/dashboardCardHeight.test.ts` (§5.3.2, §5.3.3). | **rebase**, merge |
| **7d** | **#397** `feat/dashboard-sharing` | **Last.** It is the only one that also collides with #462 (`dashboardConfig.ts`), and by then #462 has landed. It must also be fixed to stop re-deriving two rules (§5.3.1) and to add `updatedAt: true` to **both** selects (§5.3.5). | **rebase**, fix `viewerTenantId` + `sharedInTenant`, merge |
| **8** | **#458** `feat/tenant-guard-sweep` | **LAST, unconditionally.** Its baseline is a strict two-sided snapshot: it fails when tenant access *improves*, which is what every PR above does. Merging it early guarantees a red `main` the moment any of #457/#459/#460/#462 lands. It is tests-only, so it has zero conflict surface and costs nothing to defer. | merge, then regenerate the fixture: `UPDATE_TENANT_BASELINE=1 npm run test:unit` |

**Non-tenancy PRs in the queue** that this plan does not cover but which touch the same tree: #456 (`fix/echo-removal-ordering`), #455 (`chore/nanoid-advisory-override`), #453 (dependabot). None share a file with the above. **VERIFIED** only to the extent that they did not appear in the overlap matrix — I did not analyse them.

---

## 5. The collisions in detail

### 5.1 `src/lib/actingTenant.ts` — four branches, two versions — **VERIFIED**

| branch | `actingTenant.ts` blob | `actingTenantRule.ts` blob |
|---|---|---|
| #459 | `d434e99a` | `2a0220f0` |
| #457 | `d434e99a` | `2a0220f0` |
| #430 | `d434e99a` | `2a0220f0` |
| #462 | `a09bc7e3` | — (uses `flowTenantScope`) |

Three identical, one different. Because the three are byte-identical, git merges them **without conflict** (#457 × #459 and #430 × #457 both verified clean) — the conflict only appears when #462 meets any of them. Behaviour: identical (§1). Resolution: §2.1.

### 5.2 #430 vs #459 — **two attempts at the same fix** — **VERIFIED**

Both are titled around stamping bypass writes. They conflict on `src/app/actions/quotes.ts` **and** `src/app/actions/jobcards.ts`.

**#459 is the better and newer one** for the overlapping files: it is based on current `main`, and it goes further than stamping — it puts the tenant predicate on the part-stock *lock, read, reservation aggregate and decrement*, and converts `part.update` to `part.updateMany` + `claimed.count !== 1` so a filtered read in front of an unfiltered update stops being a race.

**But #430 covers four files #459 does not touch at all**, and that work would be lost by simply closing it:

- `src/app/actions/helpdesk.ts` — six sites moved off `writeTenantId() ?? DEFAULT_TENANT_ID`
- `src/app/actions/privacy.ts` — `anonymizeContact`'s consent record
- `src/app/actions/recordSigning.ts` — `startRecordSigning`'s document row
- `src/app/actions/portal.ts` — **and this one is the interesting one.** #430 correctly refuses to use `actingTenantId()` on a customer-portal path, because the viewer is a Contact and not a staff session, and resolves the owner from the Contact row instead. That is the same insight #462 generalises as `inheritedTenantId()`.

**Recommendation:** after #459 lands, rebase #430 onto `main`, **drop `quotes.ts`, `jobcards.ts`, `actingTenant.ts` and `actingTenantRule.ts` from it**, and keep only the four files above. If #462 has also landed by then, rewrite #430's `portal.ts` hunk to call `inheritedTenantId(owner?.tenantId)` rather than hand-rolling the ladder — otherwise that becomes a *fifth* re-derivation of the same rule.

### 5.3 The dashboard cluster — semantic findings

All four are **373 commits behind**. They must be **rebased**, not merged. Findings below are from a full read of each branch's hunks against merge-base `8932f6a5`.

#### 5.3.1 ⚠ `viewerTenant.ts` — #397 is a **FIFTH** copy of the acting-tenant rule

This is the most important dashboard finding, because it is the same defect this whole PR is about.

```ts
// src/lib/dashboard/viewerTenant.ts  — NEW FILE in #397
export async function viewerTenantId(): Promise<string> {
  return writeTenantId() ?? (await getActiveTenantId()) ?? DEFAULT_TENANT_ID;
}
```

That is `decideBuilderTenant` inlined, character for character in effect. Its own doc comment names the duplication and ships it anyway ("Same rule as everywhere else in this codebase…").

**In fairness to its author: `flowTenantScope.ts` did not exist at `8932f6a5`,** so #397 could not have called it. It becomes a duplicate **on rebase**, and a triplicate once #462 lands.

**Required change to #397: `viewerTenantId()` must become `return actingTenantId();`** (from the canonical module). One line.

**And a second, separate duplication in the same PR:** `src/lib/dashboard/sharedScope.ts` re-derives `legacyFlowTenant` (the `tenantId === DEFAULT_TENANT_ID ? include-NULL : strict` rule) with a `sharedAt: { not: null }` spread over it. It should be `{ sharedAt: { not: null }, ...legacyFlowTenant(tenantId) }`. This one matters beyond tidiness: once #462 starts stamping `Dashboard.tenantId` on create, the NULL-tenant population freezes and this becomes a legacy rule with a fixed expiry — **two copies will retire at different times.** `tests/dashboardSharingTenantScope.test.ts` currently pins the duplicate rather than the shared helper, which will keep both copies alive.

#### 5.3.2 #428 × #429 — a genuine design collision in `DashboardCanvas.tsx`

#429's `DropMarker` uses `CARD_ROWS[card.rows ?? 1]` to take the shape of the card it stands in for. **#428 deletes `CARD_ROWS` and the `sm:auto-rows-[minmax(11rem,auto)]` grid that gives it meaning.** Both naive resolutions fail:

- take #428's deletions → `CARD_ROWS` is undefined in `DropMarker` → **build fails**;
- keep `CARD_ROWS` → **#428's own test fails**: `tests/dashboardCardHeight.test.ts` → `test("nothing in the height path imposes a height on a grid row")` asserts `assert.doesNotMatch(code(file), /row-span-\d/)` against `DashboardCanvas.tsx`.

**Resolution:** drop the `CARD_ROWS` line from `DropMarker`, keep `CARD_SPAN` and `style={{ minHeight: height }}`. `height` is `event.active.rect.current.initial?.height` — the *measured* pixel height of the dragged card, which under #428's model already includes the min-height. That fully reproduces what `CARD_ROWS` did on the marker, and arguably better. #429's own comment says the measured height is the primary mechanism; the `CARD_ROWS` line was belt-and-braces for a model that is going away.

#### 5.3.3 `tests/dashboardCardHeight.test.ts` — #428 and #429 are **contradictory**, not co-located

#429's change to this file is 5 lines that exist *solely* to accommodate a second `CARD_ROWS` consumer. #428 **deletes the entire test** that #429 edits, plus four others, and asserts the opposite claim (base asserts `/sm:row-span-2/` **is** present; #428 asserts `/row-span-\d/` **is not**).

**Resolution: take #428's file wholesale, discard #429's 5-line edit** — it is dead once `CARD_ROWS` is gone. Then apply 5.3.2, or #428's grid-row test fails on merged production code even though the test file merged correctly.

#### 5.3.4 #395 × #429 — clean merge, and **genuinely compatible** (checked, not assumed)

The textbook trap did not fire here. #395 adds no reducer and no state; `moveCard`/`liftCard` funnel through #429's single `update` mutator, so they land on #429's `configRef`/save-queue path for free.

**The thing that could have made #395 silently invisible, and does not:** container children are drawn server-side, so a nested move is only visible after `router.refresh()`. `src/lib/dashboard/renderSignature.ts` **recurses into containers and records child order** (`reduced.cards = card.cards.map(c => c.id)`), so the signature changes and the refresh fires. Had it stopped at the top level, #395's entire feature would have been invisible until reload. **Checked and safe.**

Three caveats for the merger:
1. #395 moves `mapCards`/`filterCards` out of `EditorProvider.tsx` into `@/lib/dashboard/cardTree`; #429 still calls them. Post-merge they resolve to the new module — implementations are identical bar an `isContainerCard()` refactor. Safe, but nothing pins it.
2. #429's `if (next === current) return;` no-op guard is defeated by #395's helpers, which always rebuild the top level. Nudging the leftmost card pushes an undo entry and queues a deep-equal write. Not a regression, but it forfeits #429's optimisation. Cheap fix: have `reorderInTree`/`liftFromContainer` return `config` unchanged when no section changed.
3. `tests/dashboardEditor.test.ts` merges clean **and passes** — but `test("card edits reach cards inside containers")` exists on both tips with **different bodies**. Do not deduplicate by name.

**Prop plumbing #429 × #397:** #429 makes `initialUpdatedAt` a **required** prop and adds `key={slug}`; #397 rewrites the same prop list (adds `slug`, `shared`, `isOwner`). Keep `updatedAt={dashboard.updatedAt}` / `initialUpdatedAt={updatedAt}` / `key={slug}` — dropping any is a type error at best, an unfenced write at worst.

#### 5.3.5 `src/lib/dashboard/store.ts` — #397 × #429

#429 adds `updatedAt: true` to **the** `select` in `dashboardBySlug`. #397 splits that function into **two chained `findFirst`s** (own dashboard, then shared). **Both selects need `updatedAt: true`** — applying #429's one-liner to only the first leaves the shared path without it, and `row.updatedAt.toISOString()` is a type error there (runtime `TypeError` if anyone casts past it).

Design question worth deciding deliberately: with both landed, a shared read-only dashboard carries a real `updatedAt` fence and is handed to `DashboardEditorProvider` as `initialUpdatedAt`. #397 sets `canEdit={!dashboard.shared}` so the UI is suppressed, but the provider still mounts a live save queue pointed at someone else's row. `ownDashboard(user.id, slug)` refuses it — correct outcome, wrong mechanism (a refusal toast rather than never arming the queue).

#### 5.3.6 `src/app/actions/dashboardConfig.ts` — the stamping survives, but only by luck of context

**Neither #397 nor #429 introduces a new `create`.** Full inventory: two `prisma.dashboard.create` sites (`createDashboard`, `takeControl`), no `createMany`, no `upsert`, in every version. #397's only new write is an `update` (`setDashboardShared`); #429's rewritten save is `updateMany` + `findUnique` inside a transaction.

**So after all three land, every create is still stamped — conditionally.** #462's inserted `tenantId: await actingTenantId(),` survives an *automatic* rebase because its 3-line context is untouched by #429. It does **not** survive a merger who resolves the `takeControl` conflict by taking #429's version of the function.

**Hand check after the merge: `grep -c actingTenantId src/app/actions/dashboardConfig.ts` must be 2, and `src/app/actions/dashboard.ts` must be 1.** (`dashboard.ts` is uncontested — neither #397 nor #429 touches it.)

**One more #429 × #462 item to verify rather than assert:** #429 introduces the first **interactive** `prisma.$transaction(async (tx) => …)` on the *guarded* client in this file. `src/lib/db.ts` Layer 2 wraps model ops in `withRlsScope`, which builds an **array** `$transaction([setGuc, query()])` on the **outer** client, not on `tx`. Once `tenantEnforcing()` flips, the `SET LOCAL` may land on a different pooled connection than the pinned interactive transaction. Dormant today, so no test will show it. The file's own comment already warns about this shape.

### 5.4 #462 vs `origin/main` — `src/lib/conversations.ts` — **VERIFIED, and the resolution is not obvious**

#462 renames `scopedConversationTenantId()` → `conversationFilterTenantId()` and adds a new `conversationTenantId()` for the **create** path. Meanwhile `main` (in the 63 commits #462 has not seen) rewrote `bumpConversation` to run inside a transaction behind a row lock (`lockAndRecompute`) and **added two more call sites** of the old name.

**The trap:** after the merge there are two orphaned calls to `scopedConversationTenantId()` — a function that no longer exists.

- Resolve by "keep HEAD" → **compile error** (undefined identifier at `conversations.ts:229` and `:248`).
- Resolve by "take theirs" → **silently drops `main`'s row-lock recompute**, reintroducing the concurrency defect that transaction was added to fix.

**Correct resolution (I performed it, in a scratch worktree, and the rebase then completed):** keep `main`'s transactional `lockAndRecompute` body, and rename **all five** call sites to `conversationFilterTenantId()` — not the three #462 knew about. Rebased tip: `184c60f3` in `C:/tmp/dg-recon-scratch` on branch `scratch/rebase-462`. That worktree is mine and disposable; the branch has not been pushed and #462 has not been touched.

### 5.5 #458's ratchet baseline — **it must go LAST** — **VERIFIED**

`tests/tenantAccessSweep.ts` statically analyses every `src/**/*.ts{,x}` file, resolves each Prisma call's client provenance, and emits findings keyed `file::kind::model`. `tests/fixtures/tenant-access-baseline.json` freezes 222 such keys. `tests/tenantAccessRatchet.test.ts` asserts in **both directions**:

- test 1 fails if a count goes **up** (new unguarded access) — expected;
- test 2, "the baseline only ever goes down", fails if a count goes **down**.

So the suite is red until someone re-runs `UPDATE_TENANT_BASELINE=1`. Confirmed by direct reading, the following PRs each drive counts down and would turn `main` red if #458 were already in:

- **#460** — three `global-user::User` keys go 1→0 (`contacts/page.tsx`, `cases/[id]/page.tsx`, `jobcards/[id]/page.tsx` all move to `listTenantStaff()`).
- **#459** — 19 added `tenantId` stamps in `quotes.ts` alone; `bypass-write::Quote` drops from 9.
- **#457** — `pipelines.ts` goes from 14 to 28 `tenantId` mentions.
- **#462** — its entire purpose is stamping the journey/conversation paths.
- **#397 and #461 do NOT break it** — #397 touches no `basePrisma`/raw call; #461's `tenantGuard.ts` diff is 32 lines of *comments only*, and `GLOBAL_MODELS` is unchanged.

### 5.6 Schema and migrations — **VERIFIED, and quieter than feared**

- **`prisma/schema.prisma` is edited by NO branch in this set.** The brief anticipated a collision there; there isn't one. #461 adds a migration only; #397 edits `prisma/dashboards.prisma`. **The branch `fix/pipeline-stage-schema-drift`, which the brief said declares five drifted PipelineStage columns, does not exist as committed work** (§6).
- **No migration-number collision between the PRs.** Only two add migrations: #461 `20260810130000_orphan_table_tenant_coverage`, #397 `20260809120000_dashboard_sharing`. Neither prefix is used on `main` and they do not collide with each other.
- **#397's timestamp sorts *before* 20 migrations already on `main` — and that is benign here.** `scripts/apply-migrations.mjs:66-71` orders by `Number.parseInt` of the prefix, and `main()` at `:827-842` applies the **set difference** `onDisk − recorded`, with no high-water mark. An out-of-order insertion is applied *late*, not skipped and not an error. #397's SQL is three `IF NOT EXISTS` statements on `Dashboard`, which exists long before that point. Benign.
- **⚠ There are already TWO duplicate-prefix pairs on `main` today**, not introduced by any of these PRs: `20260810110000_bot_session_ownership` / `20260810110000_staff_reply_delivery_state`, and `20260810120000_bot_flow_version_retention_fk` / `20260810120000_declared_indexes_that_were_never_created`. The comparator returns 0 for each pair, so their relative order falls back to `readdirSync` order — **filesystem order, which is not deterministic across machines**. Neither pair is interdependent today, so it is latent rather than live. **Worth a separate issue**, given the runner opens no transaction (`:605-609`, deliberate) and every migration is written idempotent precisely because partial application has always been possible.
- **#457 is NOT writing a phantom column.** `PipelineStage.tenantId` (`prisma/schema.prisma:647`, created by `20260722130000_tenant_sales_isolation`) and `SalesPipeline.tenantId` (`prisma/governance.prisma:3`, created by `20260725160000_tenant_governance_isolation`) both exist on `main`. Both nullable, so #457's raw inserts are valid.
- **The `governance.prisma` contract blind spot is already fixed on `main`.** `tests/tenantSchemaContract.test.ts:42-51` globs every `prisma/*.prisma`; #461 additionally adds a positive guard asserting `governance.prisma` is read and that `Permission`, `Role` and `Journey` are visible.
- **One thing to watch on the first deploy after #461:** its migration adds `tenantId` to 8 tables that are **not Prisma models in any `.prisma` file** (`StockLocation`, `StockMovement`, `StockAttachment`, `MarketingJourney{,Version,Enrollment,StepRun}`, `PdfmeTemplate`). That is intentional — they are DB-only tables, registered in a new `DB_ONLY_TABLES` list — but Prisma Client cannot see those columns and `unacknowledgedDrift` may start reporting them. Not a blocker; check the deploy log.

### 5.7 #459 × #460 on `jobcards.ts` — **clean, and semantically clean too** — **VERIFIED**

They edit adjacent regions of the same file but different functions: #459 stamps `tenantId` and guards part-stock claims; #460 replaces a raw posted `technicianId` with `resolveAssignableUser(...)`. Orthogonal. No resolution needed.

---

## 6. Branches in the brief that **do not exist as committed work** — **VERIFIED**

| branch | state |
|---|---|
| `fix/tenant-stamp-audit-trail` | local branch == `main`@`0d01bd81`, **0 commits**. ~30 files modified but **uncommitted** in `C:/tmp/dg-bleed-audit`. Not pushed. |
| `fix/pipeline-stage-schema-drift` | local branch == `main`@`0d01bd81`, **0 commits**, working tree **clean**. No work exists. |
| `fix/drop-null-tenant-fallbacks` | local branch == `main`@`0d01bd81`, **0 commits**, working tree clean. No work exists. |
| `test/two-tenant-harness` | local branch == `main`@`0d01bd81`, **0 commits**. Only untracked files (`scripts/harness/`, `scripts/test-tenant-isolation.ts`, `tsconfig.harness.json`). |
| `fix/assignable-person-remaining` | points at the **same commit as #460** (`fbcca532`), plus 14 uncommitted files in `C:/tmp/dg-assignable2`. Not a separate PR. |

None of these has a remote branch or an open PR. **Do not plan the merge around them**, and be aware that the uncommitted work in `dg-bleed-audit` and `dg-assignable2` will collide with #459/#460/#462 when it *is* committed — `dg-bleed-audit` alone modifies `src/lib/audit.ts`, `src/app/actions/leads.ts`, `src/app/actions/testDrives.ts` and `src/lib/journeyStepExecutor.ts`, all of which #462 also touches.

---

## 7. What I verified vs what I inferred

**Verified by execution:**
- rule equivalence, 93 executed cases + a negative control (§1)
- every merge-base, ahead/behind count and pinned SHA (§0 table)
- every entry in the conflict matrix, via `git merge-tree --write-tree` (§3)
- the #462 rebase and its `conversations.ts` resolution, carried out end-to-end in a scratch worktree (§5.4)
- the canonical file compiles against `origin/main` and satisfies all three of #462's pinned assertions (§2)
- blob-identity of the three `actingTenant.ts` / `actingTenantRule.ts` copies (§5.1)

**Verified by reading (not executed):**
- the ratchet's two-sided assertions and which PRs drive counts down (§5.5) — I did not run `npm run test:unit` against a merged tree
- the migration runner's ordering and set-difference behaviour (§5.6)
- `PipelineStage`/`SalesPipeline` column existence (§5.6)
- #430's scope and overlap (§5.2)

- the whole of §5.3 — every hunk range, the `CARD_ROWS`/`DropMarker` collision, the `renderSignature` recursion, and the full `create`/`createMany`/`upsert` inventory in `dashboardConfig.ts` were read directly on each branch tip
- #397's two re-derived rules (§5.3.1), quoted from the branch

**Inferred, not verified:**
- the ordering *within* the dashboard cluster (§4 steps 7a–7d) — derived from the conflict matrix plus §5.3; the individual conflicts are verified, the sequence is a judgement call
- the `db.ts` Layer-2 interactive-transaction concern in §5.3.6 — flagged from reading `db.ts`'s own warning comment, **not** reproduced
- that #456/#455/#453 are irrelevant — they simply did not appear in the overlap matrix; I did not read them
- nothing here was run against a database. The local `.env` points at production and was not touched.
