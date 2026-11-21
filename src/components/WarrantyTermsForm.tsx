import { SaveForm, SaveButton } from "@/components/SaveForm";
import { MAX_TERMS, termRows, type WarrantyTerm } from "@/lib/warrantyParts";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * Warranty in parts, as rows: a part (from the workspace's own list), how long, and years / months / lifetime. Used on
 * a product (its terms) and a vehicle (its own cover, with the day it starts). Blank rows are ignored when saved.
 */
export default function WarrantyTermsForm({
  action,
  terms,
  parts,
  startsOn,
  submitLabel = "Save warranty",
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  terms: readonly WarrantyTerm[];
  parts: readonly string[];
  /** A vehicle's start day (yyyy-mm-dd), offered for editing; omitted on a product. */
  startsOn?: string;
  submitLabel?: string;
}) {
  const rows = [...termRows(terms), ...Array.from({ length: 2 }, () => ({ part: "", length: "", unit: "years" as const }))].slice(0, MAX_TERMS);
  // A part on the vehicle that has since left the list stays selectable as itself.
  const options = (current: string) => (current && !parts.includes(current) ? [current, ...parts] : parts);
  return (
    <SaveForm action={action} success="Warranty saved" resetOnSuccess={false} className="space-y-3">
      {startsOn !== undefined && (
        <div>
          <label className="label" htmlFor="startsOn">Cover starts</label>
          <input id="startsOn" name="startsOn" type="date" className="input" defaultValue={startsOn} />
        </div>
      )}
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-2">
            <select name={`part_${i}`} defaultValue={row.part} className="input" aria-label={`Part ${i + 1}`}>
              <option value="">— Part —</option>
              {options(row.part).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input name={`length_${i}`} type="number" min={1} defaultValue={row.length} className="input tabular-nums" aria-label={`Length ${i + 1}`} />
            <select name={`unit_${i}`} defaultValue={row.unit} className="input" aria-label={`Years, months or lifetime ${i + 1}`}>
              <option value="years">years</option>
              <option value="months">months</option>
              <option value="lifetime">Lifetime</option>
            </select>
          </div>
        ))}
      </div>
      <SaveButton className="btn-primary btn-sm">{submitLabel}</SaveButton>
    </SaveForm>
  );
}
