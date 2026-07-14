"use client";

import { validateExpression } from "./expr";

/** Example conditions offered as one-click inserts — the record's typed fields. */
const EXAMPLES = [
  'quotation.total > 10000',
  'quotation.lines.length > 0',
  'quotation.discount > 0',
  'customer.hasContact == true',
  'jobcard.status == "completed"',
];

/**
 * Editor field for a Conditional block's expression. Validates live (no eval —
 * see ./expr) and shows the error, plus one-click example conditions. An empty
 * expression always shows the content.
 */
export function ConditionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const error = validateExpression(value ?? "");
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "6px 8px", fontSize: 13, borderRadius: 6, fontFamily: "ui-monospace, monospace",
    border: `1px solid ${error ? "#dc2626" : "var(--puck-color-grey-09, #d1d5db)"}`, boxSizing: "border-box",
  };
  return (
    <div>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. quotation.total > 10000"
        style={inputStyle}
      />
      {error ? (
        <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>⚠ {error}</div>
      ) : (
        <div style={{ fontSize: 11, color: "#16a34a", marginTop: 4 }}>
          {value?.trim() ? "✓ valid — shows only when true" : "Empty = always shows"}
        </div>
      )}
      <select
        value=""
        onChange={(e) => { if (e.target.value) onChange(e.target.value); e.currentTarget.value = ""; }}
        style={{ ...inputStyle, marginTop: 4, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
      >
        <option value="">+ Example condition…</option>
        {EXAMPLES.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
      </select>
    </div>
  );
}
