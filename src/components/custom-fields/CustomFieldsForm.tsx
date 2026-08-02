"use client";

import { SaveForm, SaveButton } from "@/components/SaveForm";
import { displayValue, type FieldDef, type FieldWithValue } from "@/lib/customFields-helpers";
import type { ActionResult } from "@/lib/actionResultTypes";

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

function Field({ def, value }: { def: FieldDef; value: string | null }) {
  const name = `cf_${def.id}`;
  const common = { id: name, name, className: inputCls, required: def.required };
  switch (def.type) {
    case "textarea":
      return <textarea {...common} rows={3} defaultValue={value ?? ""} />;
    case "number":
      return <input {...common} type="number" step="any" defaultValue={value ?? ""} />;
    case "date":
      return <input {...common} type="date" defaultValue={value ?? ""} />;
    case "url":
      return <input {...common} type="url" placeholder="https://…" defaultValue={value ?? ""} />;
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input id={name} name={name} type="checkbox" defaultChecked={value === "true"} className="size-4" />
          <span className="text-muted-foreground">Yes</span>
        </label>
      );
    case "select":
      return (
        <select {...common} defaultValue={value ?? ""}>
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    default:
      return <input {...common} type="text" defaultValue={value ?? ""} />;
  }
}

/**
 * The custom-fields card, rendered from already-loaded field data.
 *
 * Split out of CustomFieldsCard so the quote EDITOR can show the same card. The
 * card is an async server component that reads the values itself, which a
 * client dialog cannot render — and the editor may not even have a record to
 * read when it opens. Both surfaces now render this, so the two can't drift.
 *
 * Types and displayValue come from customFields-helpers, which is deliberately
 * free of the `server-only` and Prisma imports that customFields.ts carries.
 */
export default function CustomFieldsForm({
  fields,
  action,
  readOnly = false,
  className = "rounded-xl border border-border bg-card p-4 shadow-sm",
}: {
  fields: FieldWithValue[];
  /** Bound saveCustomFieldValues(entity, recordId). Unused when readOnly. */
  action: (formData: FormData) => Promise<ActionResult | void>;
  readOnly?: boolean;
  className?: string;
}) {
  if (fields.length === 0) return null;

  if (readOnly) {
    return (
      <div className={className}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Custom fields
        </p>
        <div className="space-y-3">
          {fields.map(({ def, value }) => (
            <div key={def.id}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{def.label}</label>
              <p className="text-sm">{displayValue(def, value)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <SaveForm
      action={action}
      success="Custom fields saved"
      resetOnSuccess={false}
      closeModalOnSuccess={false}
      className={className}
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Custom fields
      </p>
      <div className="space-y-3">
        {fields.map(({ def, value }) => (
          <div key={def.id}>
            <label htmlFor={`cf_${def.id}`} className="mb-1 block text-xs font-medium text-muted-foreground">
              {def.label}
              {def.required && <span className="text-destructive"> *</span>}
            </label>
            <Field def={def} value={value} />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <SaveButton pendingLabel="Saving…" className="btn-secondary btn-sm">Save custom fields</SaveButton>
      </div>
    </SaveForm>
  );
}
