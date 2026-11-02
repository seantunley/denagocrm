"use client";

import { CONDITION_FIELDS } from "@/lib/journeyTypes";
import { emptyGroup, isRecord, type ConditionGroup } from "@/lib/journeyBuilderDefinition";

/**
 * One editor for every condition group a journey holds — a Condition step, "Wait until true", a Choose branch and a
 * Repeat while/until. Groups nest (up to MAX_DEPTH here), so anything the parser accepts can be edited instead of
 * being carried as JSON.
 */

const MAX_DEPTH = 3;
const LOGIC = [
  { value: "and", label: "All of these" },
  { value: "or", label: "Any of these" },
  { value: "not", label: "None of these" },
];
const OPERATORS = [
  ["equals", "equals"], ["not_equals", "does not equal"], ["contains", "contains"], ["not_contains", "does not contain"],
  ["greater_than", "is more than"], ["greater_or_equal", "is at least"], ["less_than", "is less than"], ["less_or_equal", "is at most"],
  ["in", "is one of (comma list)"], ["is_empty", "is empty"], ["is_not_empty", "is not empty"],
] as const;
const FIELD_LABELS: Partial<Record<string, string>> = {
  "lead.source": "Lead source", "lead.status": "Lead status", "lead.valueCents": "Lead value (cents)", "lead.quantity": "Lead quantity",
  "lead.stageId": "Lead stage ID", "lead.productId": "Lead product ID", "lead.assignedToId": "Lead owner ID", "lead.email": "Lead email",
  "lead.phone": "Lead phone", "contact.source": "Customer source", "contact.province": "Customer province",
  "contact.marketingOptOut": "Customer opted out of marketing", "contact.email": "Customer email", "contact.phone": "Customer phone",
  "contact.hasVehicle": "Customer has a vehicle", "contact.tags": "Customer tag ID", "event.type": "What enrolled them",
  "event.triggerId": "Trigger ID that enrolled them", "repeat.index": "Loop: round number", "repeat.item": "Loop: current item",
  "repeat.first": "Loop: first round", "repeat.last": "Loop: last round",
};
const VARIABLE = "__variable";

function asGroup(value: unknown): ConditionGroup {
  return isRecord(value) && Array.isArray(value.conditions) ? { logic: typeof value.logic === "string" ? value.logic : "and", conditions: value.conditions } : emptyGroup();
}

export default function JourneyConditionGroupEditor({ value, onChange, depth = 0 }: { value: unknown; onChange: (group: ConditionGroup) => void; depth?: number }) {
  const group = asGroup(value);
  const setAt = (index: number, entry: unknown) => onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? entry : c)) });
  const removeAt = (index: number) => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });

  return (
    <div className={depth ? "rounded-lg border border-slate-700/70 p-2 space-y-2" : "space-y-2"}>
      <select className="input h-9 w-auto" aria-label="Match" value={group.logic ?? "and"} onChange={(e) => onChange({ ...group, logic: e.target.value })}>
        {LOGIC.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>
      {group.conditions.map((entry, index) =>
        isRecord(entry) && Array.isArray(entry.conditions) ? (
          <div key={index} className="flex gap-2 items-start">
            <div className="flex-1"><JourneyConditionGroupEditor value={entry} onChange={(next) => setAt(index, next)} depth={depth + 1} /></div>
            <button type="button" className="text-xs text-red-400 px-2 py-2" onClick={() => removeAt(index)}>Remove</button>
          </div>
        ) : (
          <Clause key={index} clause={isRecord(entry) ? entry : {}} onChange={(next) => setAt(index, next)} onRemove={() => removeAt(index)} />
        ),
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, { field: "lead.source", operator: "equals", value: "" }] })}>+ Condition</button>
        {depth < MAX_DEPTH && <button type="button" className="btn-secondary btn-sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, emptyGroup()] })}>+ Group</button>}
      </div>
    </div>
  );
}

function Clause({ clause, onChange, onRemove }: { clause: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; onRemove: () => void }) {
  const field = String(clause.field ?? "");
  const operator = String(clause.operator ?? "equals");
  const isVariable = field.startsWith("vars.");
  const known = (CONDITION_FIELDS as readonly string[]).includes(field);
  const noValue = operator === "is_empty" || operator === "is_not_empty";
  return (
    <div className="grid md:grid-cols-[1.4fr_1fr_1.4fr_auto] gap-2 items-start">
      <div className="space-y-1">
        <select className="input" aria-label="Field" value={isVariable ? VARIABLE : field} onChange={(e) => onChange({ ...clause, field: e.target.value === VARIABLE ? "vars." : e.target.value })}>
          {!known && !isVariable && <option value={field}>{field || "Choose a field"}</option>}
          {CONDITION_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f] ?? f}</option>)}
          <option value={VARIABLE}>A journey variable…</option>
        </select>
        {isVariable && <input className="input" aria-label="Variable name" placeholder="variable name" value={field.slice(5)} onChange={(e) => onChange({ ...clause, field: `vars.${e.target.value.trim()}` })} />}
      </div>
      <select className="input" aria-label="Operator" value={operator} onChange={(e) => onChange({ ...clause, operator: e.target.value })}>
        {OPERATORS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {noValue ? <span /> : <input className="input" aria-label="Value" placeholder="Value" value={clause.value == null ? "" : String(clause.value)} onChange={(e) => onChange({ ...clause, value: e.target.value })} />}
      <button type="button" className="text-xs text-red-400 px-2 py-2" onClick={onRemove}>Remove</button>
    </div>
  );
}
