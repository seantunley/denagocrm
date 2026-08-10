# Stage criteria and the Attention Centre

**Status:** design proposal, nothing built.
**Date:** 2026-08-10
**Baseline:** assumes PR #457 (`feat/kanban-pipeline-context`) has landed. That branch adds `src/lib/kanbanRules.ts`, per-stage `staleAfterDays` on the board, owner-filter-by-id, optimistic-move rollback, and `pipelineTenantFilter()` in `src/lib/pipelines.ts`. Several decisions below build directly on those and do not make sense without them.

Two features, deliberately written together because the second one is the honest home for the first one's leftovers:

- **Part 1** — per-stage entry and exit criteria, authored by the user. "A lead cannot enter Proposal without a quote attached."
- **Part 2** — the Attention Centre, replacing the boolean `attentionOnly` filter in `KanbanBoard.tsx`.

---

## 0. What already exists (read this before disagreeing with anything below)

The proposal reuses five things rather than inventing them. Each is load-bearing.

| Thing | Where | Why it matters here |
| --- | --- | --- |
| A pure, import-free condition language | `src/lib/journeyTypes.ts` (**zero imports**, 1117 lines) | `JourneyConditionGroup`, `ConditionOperator` (11 ops), `parseConditionGroup`, `evaluateConditions`, `explainConditions`, `valueAtPath`. Already imported by `JourneyBuilder.tsx` (client) *and* `journeyEngineShared.ts` (server). |
| The precedent for borrowing that vocabulary | `src/lib/dashboard/conditions.ts` | Its only import is `import type { ConditionOperator } from "@/lib/journeyTypes"`, with a comment arguing that a second, subtly-different operator set is "the specific failure this codebase keeps consolidating away from". Shares operators, keeps its own **field** vocabulary. That is exactly the split we want. |
| The pure board-rules module | `src/lib/kanbanRules.ts` (PR #457) | `isStale(ageDays, staleAfterDays)`, `matchesOwnerFilter(assignedToId, owner)`, `DEFAULT_STALE_DAYS`. Exists specifically so a test can *execute* board rules that `KanbanBoard.tsx` cannot be imported for. |
| Stage-entry timestamp and per-stage staleness | `Lead.stageEnteredAt` (`schema.prisma:685`, non-null, defaulted); `PipelineStage.staleAfterDays` (**Postgres only** — added in migration 52, never added to the Prisma model) | Part 2's cheapest signal is already recorded. `staleAfterDays` needs a schema-alignment add, not an `ALTER`. |
| `PipelineStage` tenancy | `tenantId String?`, `@@index([tenantId])`, `@@unique([tenantId, id])`, composite FK `Lead(tenantId, stageId)`, RLS policy from `20260727130000_rls_enforce` | Anything stored **as a column on this table** inherits all of it. Anything stored in a new table has to re-earn every one. See §1.1. |

And one thing to *not* copy: `src/lib/marketingAudiences.ts` imports `node:crypto` and `./db`, so `AudienceWorkspace.tsx` re-declares `AudienceRule`, `AudienceGroup`, the field list and the operator labels **by hand**. That is the failure mode this whole design is arranged to avoid.

---

# PART 1 — Stage entry and exit criteria

## 1.1 Data model: JSON columns on `PipelineStage`

**Recommendation: two `Json?` columns and two mode columns on `PipelineStage`. No new table.**

```prisma
model PipelineStage {
  id          String  @id @default(cuid())
  name        String
  order       Int
  color       String  @default("#64748b")
  entryAction String?

  /// JourneyConditionGroup — must hold for a lead to ENTER this stage.
  /// NULL = no gate. evaluateConditions(null, …) returns true, so NULL can never block.
  entryCriteria Json?
  /// JourneyConditionGroup — must hold for a lead to LEAVE this stage (forward only).
  exitCriteria  Json?
  /// StageGateMode: off | warn | reason | block. Defaults to "off" so nothing changes on deploy.
  entryGateMode String @default("off")
  exitGateMode  String @default("off")

  // Multi-tenancy (Phase B — additive/inert): owning tenant. See Contact.tenantId.
  tenantId String?

  // Schema-drift alignment: these columns have existed in Postgres since
  // migration 52 and were never surfaced to Prisma. Adding them here is a
  // model-only change — see 20260728180000_schema_drift_alignment for precedent.
  pipelineId         String
  defaultProbability Int     @default(10)
  staleAfterDays     Int?
  isClosed           Boolean @default(false)
  closedStatus       String?

  leads Lead[]

  @@index([tenantId])
  @@unique([tenantId, id])
}
```

**Why JSON and not a `PipelineStageCriterion` table.**

1. **Tenancy comes free, and that is the entire point.** A column on `PipelineStage` inherits its `tenantId`, its index, its `@@unique([tenantId, id])`, its composite FK, and its RLS policy. A new table has to declare `tenantId`, get an index, get a `@@unique([tenantId, id])` if anything will composite-FK to it, and — the one everybody forgets — get its own `<Table>_tenant_isolation` policy block in the migration. The prod audit found **27 tables with no RLS because they were added after the enforce migration**. A criteria table is a 28th candidate; a JSON column cannot be.
2. **Criteria are never queried across stages.** "Which stages require a quote?" is not a query anyone runs; criteria are always read with the stage that owns them, by `listPipelineStages(pipelineId)`, which is already tenant-filtered. That is the textbook case for a document column.
3. **It is the house pattern.** `BotFlow.definition`, `SignWorkflow.graphJson`, `JourneyVersion.{triggers,entryConditions,definition}`, `Segment.ruleTree`, `MarketingAudienceVersion.ruleTree` are all rule documents in one column. `prisma/journeys.prisma:43-61` carries the canonical justification.

**Trade-off accepted:** you cannot write SQL against an individual criterion, and you cannot FK a criterion to, say, a custom-field id. The first is fine. The second is handled by making the field vocabulary a **closed allow-list** (`STAGE_CRITERION_FIELDS`), exactly as `CONDITION_FIELDS` does for journeys — there are no ids to dangle because the author can only pick from a fixed list.

**Mode is per-gate, not per-clause.** Under `or`, "which clause failed" is not a well-formed question, so hanging a severity off individual clauses would be incoherent precisely where the group logic earns its keep. You get one severity per direction per stage. If someone genuinely wants "quote is a hard block, decision-maker is a warning" on the same stage, that is a second pair of columns later (`entryCriteriaWarn Json?`) and is purely additive. **I am not confident this limit will hold forever** — it is the first thing I expect to be asked for. It is still the right v1.

**Migration.** One migration, `20260810120000_stage_gates`. Four `ADD COLUMN`s (all nullable or defaulted, so no table rewrite of consequence) plus the Prisma-side drift alignment for the migration-52 columns, which requires no SQL at all. No new table, therefore no new RLS policy block.

## 1.2 How a criterion is expressed

Reuse `JourneyConditionGroup` verbatim as the **storage and evaluation** shape. Define a new **field** vocabulary. This is the `dashboard/conditions.ts` split, applied a second time.

The hard part is that the interesting criteria are not lead columns. "Has a quote attached" and "has a decision-maker contact" are derived facts. So the design needs a **fact snapshot**: a flat, serialisable record built server-side per lead, which the pure evaluator dot-walks via `valueAtPath`. This is the same seam journeys already use — `journeyContext.ts` (imports prisma) builds the context; `journeyTypes.ts` (pure) evaluates against it.

```ts
// src/lib/stageGate.ts
// PURE. One type-only import from a module that itself has zero imports, so this
// is safe to import from KanbanBoard.tsx. Same rule as dashboard/conditions.ts.
import {
  evaluateConditions,
  explainConditions,
  parseConditionGroup,
  type ConditionOperator,
  type JourneyConditionGroup,
} from "@/lib/journeyTypes";

export const STAGE_GATE_MODES = ["off", "warn", "reason", "block"] as const;
export type StageGateMode = (typeof STAGE_GATE_MODES)[number];

/**
 * Closed allow-list of dot-paths into StageGateFacts. Closed by NAME, not by
 * namespace: a criterion naming a field that no longer exists must be a save-time
 * error, not a clause that silently evaluates to undefined and blocks the board.
 */
export const STAGE_CRITERION_FIELDS = [
  "lead.valueCents", "lead.assignedToId", "lead.productId",
  "lead.expectedCloseDate", "lead.email", "lead.phone", "lead.source",
  "quote.count", "quote.sentCount", "quote.acceptedCount", "quote.latestStatus",
  "contact.linked", "contact.decisionMakerCount", "contact.email", "contact.phone",
  "activity.plannedCount", "activity.overdueCount",
  "signature.completedCount", "signature.pendingCount",
  "stage.ageDays",
] as const;
export type StageCriterionField = (typeof STAGE_CRITERION_FIELDS)[number];

/** Labels live beside the list. Two copies of labels drift; journeyTypes says so explicitly. */
export const STAGE_CRITERION_LABELS: Record<StageCriterionField, string> = {
  "quote.count": "Quotes attached",
  "contact.decisionMakerCount": "Decision-maker contacts",
  // …
};

/** What the evaluator reads. Flat, JSON-safe, and identical on both sides. */
export type StageGateFacts = {
  lead: { valueCents: number; assignedToId: string | null; productId: string | null;
          expectedCloseDate: string | null; email: string | null; phone: string | null; source: string };
  quote: { count: number; sentCount: number; acceptedCount: number; latestStatus: string | null };
  contact: { linked: boolean; decisionMakerCount: number; email: string | null; phone: string | null };
  activity: { plannedCount: number; overdueCount: number };
  signature: { completedCount: number; pendingCount: number };
  stage: { ageDays: number };
};

export type StageGate = {
  mode: StageGateMode;
  criteria: JourneyConditionGroup | null;
};

export type UnmetCriterion = {
  field: string; operator: ConditionOperator; expected: unknown; actual: unknown;
};

export type StageGateVerdict = {
  /** May the move proceed at all? */
  allowed: boolean;
  /** Must the caller supply an override reason for it to proceed? */
  requiresReason: boolean;
  /** Which gate produced the verdict — the message says "leave Qualification" vs "enter Proposal". */
  direction: "entry" | "exit" | null;
  mode: StageGateMode;
  unmet: UnmetCriterion[];
};

/**
 * THE decision for one move. Pure: the board and the server action call this
 * same function, and any disagreement between them is a disagreement about
 * FACTS, never about rules.
 *
 * Gates fire on TRANSITION ONLY, and only FORWARD. See §1.5.
 */
export function evaluateStageMove(input: {
  from: { stageId: string; order: number; exit: StageGate } | null;
  to: { stageId: string; order: number; entry: StageGate };
  samePipeline: boolean;
  facts: StageGateFacts;
  canOverride: boolean;
}): StageGateVerdict;

/** One sentence per failed clause. Used by the drag tooltip AND the server refusal. */
export function describeUnmet(unmet: UnmetCriterion): string;

/** Save-time validator. Throws with a human message, like parseConditionGroup. */
export function parseStageCriteria(value: unknown): JourneyConditionGroup | null;

/** Mode parser. Unknown value → "off": an unreadable mode must never become a block. */
export function parseStageGateMode(value: unknown): StageGateMode;
```

**Unknown fields fail at parse, unknown operators fail at parse.** `parseStageCriteria` wraps `parseConditionGroup` and then re-checks every leaf against `STAGE_CRITERION_FIELDS`. Journeys reject at parse; dashboard conditions fail closed at evaluation; docbuilder expressions fail *open*. Pick one and say which — **we reject at parse, and at evaluation an unresolvable field is treated as `undefined`, which under `is_not_empty` fails the clause.** That is fail-closed at eval, which for a gate means "blocks the move". That direction is only tolerable because parse-time rejection makes it near-unreachable; if it ever fires it is a bug, and a blocked board is a loud bug rather than a silent one.

## 1.3 Why both sides are required

The client check and the server check are **not** redundant, and neither can be dropped.

**The client check alone is not a control.** `moveLead` is a server action with a stable, guessable id; anything that can POST to it moves the lead. The board's drag affordance is a hint. This codebase already makes exactly this argument for permissions: `BoardPermissions.canChangeStage` greys the context-menu item, and `requireLeadAccess(leadId, "leads.change_stage")` is the actual boundary. Three more reasons specific to gates:

- The board has **three** paths into `requestMove` — pointer drag, the "Move to stage" context submenu, and the keyboard sensor. A check bolted onto the drop handler misses two of them.
- A tab open across a deploy holds criteria from before the last save. This repo has a memory of exactly that failure shape ("stale tab after deploy").
- The client's facts are a snapshot taken when the page rendered. A quote deleted in another tab thirty seconds ago is not in it.

**The server check alone is a bad product.** The user drags, the card animates across the board, the server refuses, the card snaps back. PR #457 makes that rollback *correct*, but a correct rollback is still a failed interaction and a toast. Greying the column before the drag turns a refusal into a non-event.

**How they stay in agreement.** One function, two data sources:

- The leads page loader builds `Map<leadId, StageGateFacts>` alongside the aggregates it already computes, and ships it on each `KanbanLead`. The board calls `evaluateStageMove` in `onDragStart` for every column, greys the ones returning `allowed: false`, and shows `describeUnmet(...)` in the column header while dragging.
- `moveLead` re-derives facts **fresh, server-side, for that one lead** and calls the same function. It never reads a fact from the request. The client's snapshot is a rendering input, not an argument.

That is the whole contract: **the client and the server run the same rules on different data, and only the server's data is authoritative.**

## 1.4 Severity, override, and audit

Four modes, one per gate:

| Mode | Behaviour |
| --- | --- |
| `off` | Criteria stored, not enforced. The board shows them as a hint on the column ("Proposal expects: a quote"), nothing is blocked. **This is the default and the on-ramp** — you author a rule, watch it for a week, then turn it up. |
| `warn` | The move proceeds. A toast names the unmet criteria. The move is audited with `metadata.gateUnmet`. |
| `reason` | The move opens a dialog demanding a typed reason (min 10 chars), modelled on the existing `LeadOutcomeDialog` lost-reason input. The reason is required by the *server*, not just the dialog. |
| `block` | Refused. A holder of the override permission gets the `reason` path instead of a refusal. |

**Who can override:** a new permission key `leads.override_stage_rules`, appended to the `PERMISSIONS` tuple in `src/lib/permissions.ts`. Note the consequence and design for it: a brand-new key is granted to nobody, so on the day it ships a `block` stage is unbypassable for every non-owner. Tenant owners already bypass permission checks (the `/leads` page comment documents `null` from `getAccessibleLeadIds` as "owner or `leads.view_all`"), so an owner is never locked out of their own board. The settings UI should say, next to the `block` option, "only the owner and roles with *Override stage rules* can move a lead past this."

**Action shape.** `moveLead` currently returns `void` and throws. **This is already a live bug in PR #457**: the board's new rollback does `error instanceof Error ? error.message : …`, and Next replaces a thrown server-action message with an opaque digest in production. The rollback toast will read `aBc123` on prod. Converting to the house pattern fixes it and is a prerequisite for gates, because a gate refusal *is* an expected refusal:

```ts
// src/app/actions/leads.ts
export async function moveLead(
  leadId: string,
  stageId: string,
  options?: { overrideReason?: string },
): Promise<ActionResult & { gate?: StageGateVerdict }> {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.change_stage");
    // …existing pipeline-permission and closed-stage checks…
    const verdict = evaluateStageMove({
      from, to, samePipeline,
      facts: await stageGateFactsForLead(leadId),
      canOverride: await hasPermission(user, "leads.override_stage_rules"),
    });
    if (!verdict.allowed) {
      return { error: refusalSentence(verdict), gate: verdict };
    }
    if (verdict.requiresReason && !options?.overrideReason?.trim()) {
      return { gate: verdict }; // the client opens the reason dialog
    }
    // …the existing update + audit…
  });
}
```

`ActionResult` is `{ error?, success?, redirectTo? }`; the `& { gate? }` intersection is additive and `SaveForm` ignores unknown keys, so nothing else changes. Returning the verdict means the client opens the reason dialog because the *server* asked it to, not because the client independently concluded it should.

**Audit.** This codebase audits everything, and an unrecorded override is worse than a refused move.

| Event | Call | Action |
| --- | --- | --- |
| Clean move | `logAuditStrict` | `lead.stage_changed` (unchanged) |
| `warn` with unmet clauses | `logAuditStrict` | `lead.stage_changed`, `metadata: { gateUnmet }` |
| Override with reason | `logAuditStrict` | `lead.stage_gate_overridden`, `summary: 'Moved "X" into Proposal without a quote — reason: "…"'`, `before/after: { stageId }`, `metadata: { direction, mode, unmet, reason }` |
| Refused | `logAudit` (best-effort) | `lead.stage_gate_blocked` |
| Criteria edited | `logAuditStrict` | existing `pipeline.stage_updated`, with the criteria in `before`/`after` |

Use `logAuditStrict` for the first three because it routes through `writeAudit` → `AuditEvent`, which is the only model with `entityType`/`entityId`/`beforeJson`/`afterJson`/`metadata` and whose DB triggers reject UPDATE and DELETE. `AuditLog` has none of those fields. Refusals are best-effort and will be noisy if someone drags repeatedly — **accepted, because a refusal log is how you find out a rule is wrong**, and `AuditEvent` is already append-only and indexed on `(entityType, entityId, createdAt)`.

## 1.5 Migration and compatibility — the rule that stops cards being stranded

**Gates evaluate on TRANSITION, never on RESIDENCY.** A lead already sitting in Proposal is never re-checked, never badged illegal, never blocked from staying. The gate is a function of a *move*, not of a *state*. That one sentence is the whole compatibility story, and it should be a comment in `stageGate.ts`.

Corollaries, each of which is a real decision:

- **Every existing stage ships with `entryGateMode = 'off'`, `exitGateMode = 'off'`, criteria `NULL`.** `evaluateConditions(null, …)` already returns `true` ("an empty group is *no filter* and passes"), so a NULL gate is structurally incapable of blocking. Zero behaviour change on deploy.
- **Gates fire forward only** — target `order` > current `order`. Dragging a card *back* is a correction, and blocking a correction is how you get people editing the database by hand.
- **`markWon` and `markLost` never run gates.** Closing a deal is always allowed, in both directions. A dead deal that cannot be marked lost is the worst possible outcome of this feature.
- **Cross-pipeline moves run the target's entry gate only.** "You may not leave Qualification without X" is a statement about *this* process; moving the deal to a different process is not the transition the author was describing.
- **Editing a rule cannot strand anyone**, because residency is never evaluated. The stranded-card problem reappears in exactly one place — a card sitting in a stage it would no longer qualify to enter — and that is a **signal in Part 2** (`stage_criteria_unmet`), weighted like any other. It nudges. It never traps.
- **A preview at authoring time.** The settings page renders, per stage with a non-empty gate, "N of the M open leads in this stage would not pass this rule today". One aggregate per gated stage. This is the single cheapest thing that stops someone shipping a rule that breaks their own board, and it is why `off` exists as a mode.

## 1.6 Authoring UI — no second flow builder

**Recommendation: a linear, `and`-only clause list inside the existing `<details>` stage editor** in `src/app/(app)/settings/pipelines/page.tsx`. No canvas, no React Flow, no dnd. One new client component:

```
When a lead ENTERS this stage                    [ Warn ▾ ]   ← off | warn | ask for a reason | block
  ┌──────────────────────┬───────────────┬──────────────┐
  │ Quotes attached    ▾ │ is at least ▾ │ 1            │  ✕
  ├──────────────────────┼───────────────┼──────────────┤
  │ Decision-maker …   ▾ │ is not empty ▾│              │  ✕
  └──────────────────────┴───────────────┴──────────────┘
  + Add condition                    3 of 14 leads in Proposal would not pass today

When a lead LEAVES this stage                    [ Off ▾ ]
  + Add condition
```

- Three controls per row: field `<select>` from `STAGE_CRITERION_FIELDS` (labelled from `STAGE_CRITERION_LABELS`), operator `<select>` filtered by the field's type, value input typed by the field.
- Max 5 clauses per gate. Journeys allow 30 per group; a *gate* with 30 clauses is a bug report waiting to happen.
- Submitted as ordinary `FormData` through the existing `SaveForm` + `editSalesPipelineStage`, which already carries pending state, refusal toasts and audit. The component serialises to `entryCriteria=<json>` in a hidden input; the action runs `parseStageCriteria` before storing. **Not `useActionState`** — the pipelines settings page is uniformly `SaveForm`, and consistency inside one screen beats matching the 18 components elsewhere that use `useActionState`.

**Why `and`-only in the editor when the storage supports `or`/`not`/nesting.** "Cannot enter Proposal without X and Y" is what people mean. `or` in a gate ("needs a quote *or* a signed order") is rare and reads ambiguously. Keeping the storage format as full `JourneyConditionGroup` costs nothing and leaves the door open. If a stored group ever contains `or`, `not`, or nesting — hand-edited JSON, or a future editor — the settings page renders it **read-only with an explanatory line**, rather than silently flattening it into something the author did not write. Honest degradation over lossy round-tripping.

**Trade-off accepted:** a power user cannot express `or` through the UI in v1. The mitigation is that the data model can already hold it, so adding a group toggle later is an editor change, not a migration.

## 1.7 Tenancy — what to be careful about

Most of this is free (§1.1), but three things are not:

1. **The facts loader must use the guarded client.** `stageGateFactsFor()` reads Quote, Activity, Contact and SignatureRequest. It uses `prisma` from `@/lib/db`, never `basePrisma`. `basePrisma` is the documented RLS bypass and is precisely how `SalesPipeline` ended up with no tenant boundary from any direction — PR #457's own comment spells out that making a pipeline default in one workspace cleared the default in every other one.
2. **`listPipelineStages` already applies `tenantFilter('"tenantId"')`.** Add the four columns to its `SELECT` and to `PipelineStageRow`. Nothing else in `pipelines.ts` changes; `updatePipelineStage` already calls `writeTenantId()` and filters by scope.
3. **The move must verify the target stage belongs to the acting tenant.** `getPipelineStage(stageId)` is tenant-filtered, so `validateOpenStage` already returns null for a foreign stage — but that is a property of a helper, not an asserted invariant. Add the test.

**Tests to ship with it** (following the reason `kanbanRules.ts` exists — a rule you cannot execute is a rule you cannot assert):

- `tests/stageGate.test.ts` — executes the pure module. Every mode, forward vs backward, cross-pipeline, `markWon`, NULL criteria, unknown field at parse.
- `tests/stageGateTenantScope.test.ts` — a lead in tenant A cannot be moved into a stage owned by tenant B, mirroring the acceptance gate `tests/kanbanPipelineContext.test.ts` already sets.
- A guard test asserting the board and the action reach the *same* `evaluateStageMove`, not two copies.

---

# PART 2 — The Attention Centre

Today the whole feature is one line in `KanbanBoard.tsx`:

```ts
const needsAttention =
  !attentionOnly || lead.noNextStep || lead.nextStep?.overdue || isStale(lead.ageDays, stage.staleAfterDays);
```

A boolean can only answer "is this card interesting". It cannot rank, cannot say *why*, and — because it is a filter — it hides everything else, which destroys the board's spatial meaning at the moment you most want context.

## 2.1 The signal model

Nine candidate signals. Each returns zero or more `AttentionSignal`s with a fixed weight and a human `detail` string.

| Signal | Source | Cost |
| --- | --- | --- |
| `unanswered_inbound` | `Conversation.lastDirection = 'inbound'` and `lastMessageAt` older than N hours | **Cheapest strong signal in the schema.** `@@index([lastDirection, lastMessageAt])` already exists; the model comment calls this "the only cheap way to ask *is anyone waiting on us?*" |
| `overdue_task` | `Activity` `status='planned' AND dueDate < now` | Needs a new index (§2.4) |
| `quote_expiring` | `Quote` `status='sent'`, `signedAt` null, `supersededAt` null, `validUntil` inside N days. `quoteExpired()` already exists in `src/lib/quoteExpiry.ts` | Needs a new index |
| `no_next_step` | no planned `Activity` — already computed as `noNextStep` on the card and already the `needs-attention` dashboard card's query | Free |
| `stage_age` | `Lead.stageEnteredAt` vs the stage's `staleAfterDays`, i.e. the existing `isStale` | Free |
| `gone_quiet` | `leadIdle.lastEngagementAt` semantics — latest of row/communication/activity/quote, with the quote-pending and future-follow-up suppressions already implemented | **5 queries per lead today.** Deferred |
| `stage_criteria_unmet` | Part 1's `entryCriteria` re-evaluated against today's facts for the lead's *current* stage | Depends on Part 1 |
| `signature_stalled` | `SignatureRequest` in `sent/viewed/in_progress` older than N days, or `recoveryExhaustedAt` set (the schema literally calls that "the durable *this needs a person* flag") | Two hops — no `leadId`, only `quoteId → Quote.leadId` |
| `unassigned` | `assignedToId` null on an open lead past its first day | Free |

**Weights: fixed, in a pure module, not user-configurable in v1.**

```ts
// src/lib/attention/score.ts — PURE, importable from KanbanBoard.tsx
export const ATTENTION_WEIGHTS: Record<AttentionSignalKind, number> = {
  unanswered_inbound: 40,   // a person is literally waiting
  overdue_task: 30,         // we promised a date and missed it
  quote_expiring: 25,       // a deadline with money on it
  no_next_step: 20,         // nothing will happen unless someone acts
  stage_age: 20,
  gone_quiet: 15,
  stage_criteria_unmet: 10,
  signature_stalled: 10,
  unassigned: 5,
};

export type AttentionSignal = {
  kind: AttentionSignalKind;
  weight: number;
  /** Rendered verbatim: "Quote Q-1042 expires tomorrow". This is the product. */
  detail: string;
  since?: string;
};

/** Sum, capped at 100. Deliberately not multiplicative — see below. */
export function scoreAttention(signals: AttentionSignal[]): number;
export function attentionBand(score: number): "none" | "watch" | "act" | "urgent";
/** The board's toggle predicate. Replaces the inline boolean so both surfaces agree. */
export function needsAttention(signals: AttentionSignal[]): boolean;
```

**Deal value does not go into the score.** Rank by `(score desc, valueCents desc)` instead. A multiplicative value term makes the number unexplainable — "why is this 63?" — and the entire reason for replacing a boolean is that the answer becomes legible. Keeping value as a *tiebreak* gets the ordering you want without making the number a black box. **Trade-off accepted:** a R2m deal with one signal sorts below a R40k deal with three. That is arguably wrong, and it is the second thing I expect to be argued about. It is still better than an unexplainable score.

**Suppression:** one nullable column, `Lead.attentionSnoozedUntil DateTime?`, and a snooze action, audited. Precedent exists — `CustomerCase.snoozedUntil`. A signal you have already acknowledged must stop shouting or the list stops being read.

## 2.2 Computed on read. No stored score in v1.

**Recommendation: compute per request, one query per signal family, joined in memory by `leadId`.**

The concrete argument:

- **Realistic row counts.** Every query is tenant- and permission-scoped, so the working set is *this tenant's open leads*, which is hundreds. Denago today is low thousands of leads with a few hundred open. Even at a SaaS target of 200 tenants × 500 open leads, no single request ever sees more than one tenant's slice. Five signal queries, each a single indexed `findMany`/`groupBy` over ≤ ~500 ids, plus O(n) JS, is **cheaper than the leads board is today** — that page already runs two `DISTINCT ON` raw queries, a quote lookup, a signature lookup, a timeline-pin query and a pinned-note join.
- **A stored score has no honest invalidation story.** The score changes when an Activity is created, completed or re-dated; when a Quote is sent, signed, superseded or expires; when a Communication arrives from a *webhook*; when a stage's `staleAfterDays` or criteria are edited; and — fatally — **when nothing happens at all**, because `stage_age` and `quote_expiring` are functions of the clock. A clock-driven score is stale the moment it is written. Keeping it fresh means a cron rewriting every open lead every 15 minutes: continuous write amplification across the entire open pipeline, against Neon, forever, to save five indexed reads per page view.
- Wrap the loader in React's `cache()` the way `src/lib/dashboard/data.ts` wraps `leadWhere`/`quoteWhere`, so the page header's count and the list body share one execution.

**When I would revisit this** — say it now so the decision is revisitable rather than religious: (a) a tenant crosses roughly 10k open leads, or (b) a cross-tenant digest job needs to rank without a session. At that point the fix is a materialised view or a partial index, and only then a denormalised column with a cron. Not before.

## 2.3 The surface: one page at `/leads/attention`

**Recommendation: a separate page.** Reached from the board's "Needs attention" button (which becomes a link *and* keeps its filter behaviour, both driven by the same predicate) and from the existing `needs-attention` dashboard card's action.

Why not the others:

- **A filter** is the thing being replaced. It cannot rank, cannot explain, and hides the cards you are not looking at.
- **A side panel** competes for horizontal space on a board that is already a horizontally-scrolling strip of `w-[min(88vw,22rem)]` columns. On a laptop it costs a whole column. It also implies "context for the board", when the list is cross-stage by nature.
- **A daily digest** is a *delivery channel* for this data, not a surface. It needs the ranking to exist first. `src/lib/email.ts` and `src/lib/push.ts` are both already there; add it on top of the same loader in v2.
- **A page** gets its own URL to bookmark and link, its own guard (mirroring `/leads`'s `requireAnyPermission("leads.view_all", "leads.view_owned")`), and room for reasons. It also fits the workspace-shell direction the repo is currently standardising on.

```
┌ Attention ───────────────────────────────────────────────────────────────┐
│ 17 leads need you · R2.4m at risk           [Mine ▾] [All signals ▾]      │
├──────────────────────────────────────────────────────────────────────────┤
│ ⬤82  Sipho Ndlovu · Proposal · R240 000              [Open] [Snooze ▾]   │
│      ⚠ Waiting on us 3 days — inbound WhatsApp unanswered                │
│      ⚠ Quote Q-1042 expires tomorrow                                     │
│      ⚠ 11 days in Proposal (stage limit 7)                               │
├──────────────────────────────────────────────────────────────────────────┤
│ ⬤55  Bayside Lodge fleet · Qualification · R1.1m     [Open] [Snooze ▾]   │
│      ⚠ No next step scheduled                                            │
│      ⚠ Missing decision-maker contact — required to enter Proposal       │
└──────────────────────────────────────────────────────────────────────────┘
```

The score is a sort key rendered as a pill. **The reason list is the product.** A number with no reasons is a boolean with extra steps.

On the board itself, the change is small: the amber "N days in stage" pill becomes a band-coloured attention pill on cards above threshold, linking to the row. Both surfaces call `needsAttention(signals)` from the same pure module, so they can never disagree.

## 2.4 Per-tenant, per-user, no N+1

- **Per-tenant:** every signal query goes through the guarded `prisma` client. Never `basePrisma`. Worth stating loudly because `pipelines.ts` is the counter-example living in the same feature area.
- **Per-user:** reuse `getAccessibleLeadIds(user)` — the exact helper `/leads`, `/leads/list`, `/leads/closed` and the dashboard's `leadWhere()` already use, with its documented contract (`null` = unrestricted, `[]` must become `in: []`, an impossible match, not an absent filter). Do not write a second scope resolver.
- **No N+1:** one query per signal family over the already-scoped id set, then an in-memory join.

```ts
// src/lib/attention/signals.ts  — server-only. The impure half of the seam.
export async function collectAttentionSignals(input: {
  leadIds: string[];                       // already permission-scoped
  now: Date;
  stages: Map<string, { staleAfterDays: number | null }>;
}): Promise<Map<string, AttentionSignal[]>>;
```

Chunk `leadIds` at ~1000 for the `IN` list. Related latent issue worth fixing while in here: `src/app/(app)/leads/page.tsx` builds `Prisma.join(leadIds)` with no bound, which is fine at a few hundred and is not fine at ten thousand.

New indexes, in the same migration as Part 1:

```sql
CREATE INDEX "Activity_tenant_status_due_idx"      ON "Activity"("tenantId","status","dueDate");
CREATE INDEX "Quote_tenant_status_validuntil_idx"  ON "Quote"("tenantId","status","validUntil");
CREATE INDEX "Lead_tenant_status_stageentered_idx" ON "Lead"("tenantId","status","stageEnteredAt");
```

`Conversation` is already covered by `@@index([lastDirection, lastMessageAt])` and friends. Precedent for the shape: `survey-operations.prisma` already carries `@@index([tenantId, status, dueAt])` for a work queue.

## 2.5 v1 versus deliberately deferred

**v1 ships:**

- Five signals: `unanswered_inbound`, `overdue_task`, `quote_expiring`, `no_next_step`, `stage_age`. All five are one indexed query against fields that already exist.
- Fixed weights in a pure module; score capped at 100; value as tiebreak only.
- Computed on read, wrapped in `cache()`.
- `/leads/attention`, ranked, with per-row reasons.
- The board toggle and card pill re-pointed at the same pure predicate.
- `Lead.attentionSnoozedUntil` + an audited snooze action.
- Three indexes.

**Deferred, with the reason:**

- `gone_quiet` — the logic in `leadIdle.ts` is correct and hard-won (it suppresses on a pending quote and on a future planned follow-up), but it is five queries *per lead*. It needs a batched rewrite, which is its own piece of work. Do not reimplement it inline; that logic was lifted verbatim out of the retired automation engine for a reason.
- `stage_criteria_unmet` — lands the release after Part 1. This is the signal that makes the two features one feature.
- `signature_stalled` — weakest signal, and needs the `SignatureRequest → Quote → Lead` hop.
- **Per-tenant configurable weights.** Real demand unproven, and it doubles the configuration surface. When it comes it is a JSON blob on `Tenant` or an `AppSetting` key read by the same pure scorer — no schema churn.
- **Stored score + cron.** Trigger conditions named in §2.2.
- **Daily digest** (email/push) over the same loader.
- **Team rollup** ("my team's attention") — needs `Lead.teamId` surfaced to Prisma first; it exists in Postgres only.

---

## Open questions I do not have a confident answer to

1. **Per-gate severity may not survive contact with users.** "Quote is mandatory, decision-maker is advisory" on one stage is a reasonable thing to want, and §1.1's answer (a second column later) is a guess at how often it will be asked for.
2. **Whether `stage_age` should use `staleAfterDays` or its own per-stage SLA.** They mean nearly the same thing and `staleAfterDays` already exists, so v1 reuses it — but "stale" (a board badge) and "breached SLA" (an escalation) may want to diverge, and merging them now makes that harder later.
3. **The value-as-tiebreak decision.** I believe the explainability argument, but I have not tested it against how a sales manager actually reads the list.
4. **Whether refusal auditing is worth its volume.** It is the only way to learn a rule is wrong, and it is also the easiest thing in this design to turn into log spam.
