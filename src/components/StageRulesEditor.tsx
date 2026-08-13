"use client";

import { useState } from "react";
import {
  MAX_STAGE_CRITERIA,
  STAGE_CRITERION_FIELDS,
  STAGE_CRITERION_KINDS,
  STAGE_CRITERION_LABELS,
  STAGE_GATE_MODES,
  STAGE_GATE_MODE_LABELS,
  STAGE_OPERATOR_LABELS,
  operatorsForField,
  type StageCriteriaGroup,
  type StageCriterionField,
  type StageGateMode,
} from "@/lib/stageGate";
import type { ConditionOperator } from "@/lib/journeyTypes";

/**
 * Author one stage gate: a linear, and-only clause list.
 *
 * NO SECOND FLOW BUILDER. This sits inside the stage's existing `<details>` in
 * Settings → Pipelines and posts through the same `SaveForm` +
 * `editSalesPipelineStage` as every other field on that screen, so it inherits
 * the pending state, the refusal toast and the audit entry rather than growing
 * its own. `useActionState` would match the 18 components that use it elsewhere,
 * and would be the odd one out on THIS page, where consistency inside one screen
 * is worth more.
 *
 * AND-ONLY IN THE EDITOR, `or`/`not`/nesting in the storage. "Cannot enter
 * Proposal without X and Y" is what people mean; `or` in a gate reads
 * ambiguously and is rare. Keeping the stored shape a full condition group costs
 * nothing and leaves the door open — and if a group ever arrives that this
 * editor cannot express, it renders READ-ONLY rather than silently flattening
 * it. Honest degradation beats lossy round-tripping: quietly rewriting somebody's
 * `or` rule as an `and` rule changes what their board enforces without telling
 * them.
 *
 * The field vocabulary, the operator table and the clause cap are all imported
 * from `stageGate.ts`, never restated. `marketingAudiences` is the local example
 * of what restating costs: its client re-declares the field list, the operators
 * and the labels by hand, and they drift.
 */
export default function StageRulesEditor({
  direction,
  stageName,
  criteria,
  readOnly,
  defaultMode,
  wouldNotPass,
}: {
  direction: "entry" | "exit";
  stageName: string;
  criteria: StageCriteriaGroup | null;
  /**
   * The stored rule did not parse — a field this build no longer offers, or an
   * operator no longer valid for its type. Shown verbatim and posted NOT AT ALL,
   * so editing another field on the stage cannot destroy it.
   */
  readOnly: boolean;
  defaultMode: StageGateMode;
  /** "N of the M open leads in this stage would not pass this rule today", or null. */
  wouldNotPass?: { failing: number; total: number } | null;
}) {
  const criteriaName = direction === "entry" ? "entryCriteria" : "exitCriteria";
  const modeName = direction === "entry" ? "entryGateMode" : "exitGateMode";

  // A rule this editor must not rewrite: one that did not parse at all, or one
  // whose grouping it cannot express (`or`, `not`, or nesting). Either way it is
  // shown as-is and posted not at all, so saving the stage leaves it alone.
  const unsupported =
    readOnly ||
    (criteria != null &&
      (criteria.logic !== "and" || criteria.conditions.some((c) => "conditions" in (c as object))));

  const [rows, setRows] = useState<Row[]>(() =>
    unsupported || !criteria
      ? []
      : criteria.conditions.map((c) => ({
          field: c.field,
          operator: c.operator,
          value: c.value == null ? "" : String(c.value),
        })),
  );
  const [mode, setMode] = useState<StageGateMode>(defaultMode);

  const serialised = rows.length === 0
      ? ""
      : JSON.stringify({
          logic: "and",
          conditions: rows.map((row) =>
            valueless(row.operator)
              ? { field: row.field, operator: row.operator }
              : { field: row.field, operator: row.operator, value: row.value },
          ),
        });

  return (
    <fieldset className="space-y-2 rounded-lg border border-border/70 p-3 md:col-span-6">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {direction === "entry" ? `When a lead ENTERS ${stageName}` : `When a lead LEAVES ${stageName}`}
      </legend>

      {/* NOT RENDERED when the rule is read-only, and that absence is the signal:
          `editSalesPipelineStage` reads a missing field as "leave this column
          alone". Posting the raw JSON back instead would fail the save-time
          parser and make an unrelated rename impossible. */}
      {!unsupported && <input type="hidden" name={criteriaName} value={serialised} />}

      <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>If the conditions below are not met</span>
        <select
          name={modeName}
          className="input h-8 w-auto py-0 text-xs"
          value={mode}
          onChange={(event) => setMode(event.target.value as StageGateMode)}
        >
          {STAGE_GATE_MODES.map((value) => (
            <option key={value} value={value}>
              {STAGE_GATE_MODE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      {mode === "block" && (
        <p className="text-[11px] leading-4 text-amber-300">
          Only the workspace owner and roles with <strong>Override stage rules</strong> can move a lead
          past this.
        </p>
      )}

      {unsupported ? (
        <>
          <p className="text-[11px] leading-4 text-amber-300">
            {readOnly
              ? "This rule can no longer be read — it names a field or comparison this version does not offer. It is shown here and left untouched when you save; it will refuse moves until it is replaced."
              : "This rule uses grouping this editor cannot show (any-of, none-of, or a nested group). It is kept exactly as saved."}
          </p>
          {criteria && (
            <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-4 text-muted-foreground">
              {JSON.stringify(criteria, null, 2)}
            </pre>
          )}
        </>
      ) : (
        <>
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Condition field"
                className="input h-8 w-auto flex-1 py-0 text-xs"
                value={row.field}
                onChange={(event) => {
                  const field = event.target.value as StageCriterionField;
                  // The operator has to be re-picked with the field: "is at least"
                  // is meaningless on a text field, and leaving a stale one would
                  // post a pair the parser rejects with a message about a
                  // combination the person never deliberately chose.
                  setRows(replace(rows, index, { field, operator: operatorsForField(field)[0], value: "" }));
                }}
              >
                {STAGE_CRITERION_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {STAGE_CRITERION_LABELS[field]}
                  </option>
                ))}
              </select>

              <select
                aria-label="Condition operator"
                className="input h-8 w-auto py-0 text-xs"
                value={row.operator}
                onChange={(event) =>
                  setRows(replace(rows, index, { ...row, operator: event.target.value as ConditionOperator }))
                }
              >
                {operatorsForField(row.field).map((operator) => (
                  <option key={operator} value={operator}>
                    {STAGE_OPERATOR_LABELS[operator]}
                  </option>
                ))}
              </select>

              {!valueless(row.operator) &&
                (STAGE_CRITERION_KINDS[row.field] === "boolean" ? (
                  <select
                    aria-label="Condition value"
                    className="input h-8 w-auto py-0 text-xs"
                    value={row.value || "true"}
                    onChange={(event) => setRows(replace(rows, index, { ...row, value: event.target.value }))}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    aria-label="Condition value"
                    className="input h-8 w-28 py-0 text-xs"
                    type={STAGE_CRITERION_KINDS[row.field] === "number" ? "number" : "text"}
                    value={row.value}
                    onChange={(event) => setRows(replace(rows, index, { ...row, value: event.target.value }))}
                  />
                ))}

              <button
                type="button"
                aria-label="Remove condition"
                className="text-muted-foreground hover:text-red-300"
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={rows.length >= MAX_STAGE_CRITERIA}
              onClick={() =>
                setRows([
                  ...rows,
                  { field: DEFAULT_FIELD, operator: operatorsForField(DEFAULT_FIELD)[0], value: "" },
                ])
              }
            >
              + Add condition
            </button>
            {rows.length === 0 && (
              <span className="text-[11px] text-muted-foreground">No rule — every move is allowed.</span>
            )}
            {/* The single cheapest thing that stops somebody shipping a rule that
                breaks their own board, and the reason "off" exists as a mode. */}
            {rows.length > 0 && wouldNotPass && wouldNotPass.total > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {wouldNotPass.failing} of the {wouldNotPass.total} open lead
                {wouldNotPass.total === 1 ? "" : "s"} in this stage would not pass this rule today.
              </span>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

type Row = { field: StageCriterionField; operator: ConditionOperator; value: string };

/** The field a new clause starts on — the one people reach for first. */
const DEFAULT_FIELD: StageCriterionField = "quote.count";

function valueless(operator: ConditionOperator): boolean {
  return operator === "is_empty" || operator === "is_not_empty";
}

function replace(rows: Row[], index: number, row: Row): Row[] {
  return rows.map((existing, i) => (i === index ? row : existing));
}
