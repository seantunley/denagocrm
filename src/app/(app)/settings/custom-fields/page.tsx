import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import ConfirmDelete from "@/components/ConfirmDelete";
import CustomFieldDefForm from "@/components/custom-fields/CustomFieldDefForm";
import { CUSTOM_ENTITIES, FIELD_TYPES, LINK_TARGETS, getFieldDefs, type FieldDef } from "@/lib/customFields";
import { saveCustomFieldDef, deleteCustomFieldDef } from "@/app/actions/customFields";

export const dynamic = "force-dynamic";

/** "Dropdown · shows when Paying by is Finance" — what a field is, at a glance. */
function summary(def: FieldDef, defs: FieldDef[]): string {
  const parts: string[] = [FIELD_TYPES.find((t) => t.id === def.type)?.label ?? def.type];
  if (def.type === "link" && def.linkTo) parts[0] = `Link to a ${LINK_TARGETS.find((t) => t.id === def.linkTo)?.label.toLowerCase()}`;
  if (def.showWhen) {
    const control = defs.find((d) => d.key === def.showWhen?.key);
    const answer =
      def.showWhen.op === "filled"
        ? "has a value"
        : `${def.showWhen.op === "equals" ? "is" : "is not"} ${control?.type === "checkbox" ? (def.showWhen.value === "true" ? "Yes" : "No") : def.showWhen.value}`;
    parts.push(`shows when ${control?.label ?? def.showWhen.key} ${answer}`);
  }
  return parts.join(" · ");
}

export default async function CustomFieldsSettingsPage() {
  await requireTenantOwner();
  // THIS workspace's fields, named explicitly (review of #1064).
  const tenantId = await getActiveTenantId();
  const sections = await Promise.all(
    CUSTOM_ENTITIES.map(async (e) => ({
      entity: e,
      defs: tenantId ? await getFieldDefs(e.id, { tenantId, includeInactive: true }) : [],
    })),
  );

  return (
    <SettingsWorkspace
      current="custom-fields"
      title="Custom fields"
      description="Add your own fields to core records so the CRM fits how you work. Fields you define here appear on the matching detail pages, and stage rules and journeys can read lead and contact fields. Inactive fields are hidden from records but keep their stored values."
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
                        {" · "}
                        {summary(def, defs)}
                        {!def.active && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Inactive
                          </span>
                        )}
                      </p>
                      <CustomFieldDefForm
                        entity={entity.id}
                        def={def}
                        siblings={defs.filter((d) => d.id !== def.id)}
                        action={saveCustomFieldDef}
                        deleteSlot={
                          <ConfirmDelete
                            action={deleteCustomFieldDef.bind(null, def.id)}
                            title={`Delete field “${def.label}”?`}
                            description="This removes the field and every value stored against it, for all records of this type. It cannot be undone."
                            trigger="Delete"
                            triggerClass="btn-danger btn-sm"
                            confirmLabel="Delete field"
                          />
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl border border-dashed border-border p-4">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  New field
                </p>
                <CustomFieldDefForm entity={entity.id} siblings={defs} action={saveCustomFieldDef} />
              </div>
            </div>
          </SettingsSection>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
