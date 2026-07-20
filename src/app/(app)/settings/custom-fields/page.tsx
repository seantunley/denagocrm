import { requireOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { Button } from "@/components/ui/button";
import ConfirmDelete from "@/components/ConfirmDelete";
import {
  CUSTOM_ENTITIES,
  FIELD_TYPES,
  getFieldDefs,
  type CustomEntity,
  type FieldDef,
} from "@/lib/customFields";
import { saveCustomFieldDef, deleteCustomFieldDef } from "@/app/actions/customFields";

export const dynamic = "force-dynamic";

/**
 * Create/edit form for a single field definition. Reused for the "new field"
 * row (no `def`) and for editing an existing one. Stacks full-width on mobile,
 * two columns from `sm`. The machine key is derived on create and never edited.
 */
function DefForm({ entity, def }: { entity: CustomEntity; def?: FieldDef }) {
  const isNew = !def;
  return (
    <form action={saveCustomFieldDef} className="grid gap-3 sm:grid-cols-2">
      {def && <input type="hidden" name="id" value={def.id} />}
      <input type="hidden" name="entity" value={entity} />

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`label-${def?.id ?? "new"}-${entity}`}>Label</label>
        <input
          id={`label-${def?.id ?? "new"}-${entity}`}
          name="label"
          required
          defaultValue={def?.label ?? ""}
          className="input"
          placeholder="e.g. VAT number"
        />
      </div>

      <div>
        <label className="label" htmlFor={`type-${def?.id ?? "new"}-${entity}`}>Type</label>
        <select
          id={`type-${def?.id ?? "new"}-${entity}`}
          name="type"
          defaultValue={def?.type ?? "text"}
          className="input"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`options-${def?.id ?? "new"}-${entity}`}>Options</label>
        <textarea
          id={`options-${def?.id ?? "new"}-${entity}`}
          name="options"
          rows={3}
          defaultValue={def?.options.join("\n") ?? ""}
          className="input"
          placeholder="For Dropdown fields — one option per line"
        />
      </div>

      <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" name="required" defaultChecked={def?.required ?? false} className="size-4" />
          Required
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          {/* Checkbox submits "on" first (when ticked); the trailing hidden input
              provides an explicit "off" the server action reads when unticked. */}
          <input type="checkbox" name="active" value="on" defaultChecked={def?.active ?? true} className="size-4" />
          <input type="hidden" name="active" value="off" />
          Active
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        {def ? (
          <ConfirmDelete
            action={deleteCustomFieldDef.bind(null, def.id)}
            title={`Delete field “${def.label}”?`}
            description="This removes the field and every value stored against it, for all records of this type. It cannot be undone."
            trigger="Delete"
            triggerClass="btn-danger btn-sm"
            confirmLabel="Delete field"
          />
        ) : (
          <span />
        )}
        <Button type="submit" size="sm">{isNew ? "Add field" : "Save changes"}</Button>
      </div>
    </form>
  );
}

export default async function CustomFieldsSettingsPage() {
  await requireOwner();
  const sections = await Promise.all(
    CUSTOM_ENTITIES.map(async (e) => ({
      entity: e,
      defs: await getFieldDefs(e.id, { includeInactive: true }),
    })),
  );

  return (
    <SettingsWorkspace
      current="custom-fields"
      title="Custom fields"
      description="Add your own fields to core records so the CRM fits how you work. Fields you define here appear on the matching detail pages. Inactive fields are hidden from records but keep their stored values."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        {sections.map(({ entity, defs }) => (
          <SettingsSection
            key={entity.id}
            title={entity.label}
            description={`${defs.length} custom field${defs.length === 1 ? "" : "s"}`}
          >
            <div className="space-y-6">
              {defs.length > 0 && (
                <div className="divide-y divide-border">
                  {defs.map((def) => (
                    <div key={def.id} className="py-4 first:pt-0 last:pb-0">
                      <p className="mb-3 text-xs font-medium text-muted-foreground">
                        <span className="text-foreground">{def.label}</span>
                        {" · "}
                        <code className="text-[11px]">{def.key}</code>
                        {!def.active && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Inactive
                          </span>
                        )}
                      </p>
                      <DefForm entity={entity.id} def={def} />
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl border border-dashed border-border p-4">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  New field
                </p>
                <DefForm entity={entity.id} />
              </div>
            </div>
          </SettingsSection>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
