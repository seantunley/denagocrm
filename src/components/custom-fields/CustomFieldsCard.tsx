import { getFieldsWithValues, type CustomEntity, type FieldDef } from "@/lib/customFields";
import { saveCustomFieldValues } from "@/app/actions/customFields";
import { Button } from "@/components/ui/button";

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
 * Self-contained "Custom fields" card for a record's detail page. Renders and
 * saves the workspace's custom fields for one entity + record. Shows nothing
 * when no fields are defined, so it's safe to drop onto every detail page.
 */
export default async function CustomFieldsCard({
  entity,
  recordId,
}: {
  entity: CustomEntity;
  recordId: string;
}) {
  const fields = await getFieldsWithValues(entity, recordId);
  if (fields.length === 0) return null;

  return (
    <form
      action={saveCustomFieldValues.bind(null, entity, recordId)}
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
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
        <Button type="submit" size="sm">Save custom fields</Button>
      </div>
    </form>
  );
}
