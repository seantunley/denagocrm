import { getActiveTenantId } from "@/lib/auth";
import { getFieldsWithValues, loadLinkChoices, type CustomEntity } from "@/lib/customFields";
import { saveCustomFieldValues } from "@/app/actions/customFields";
import CustomFieldsForm from "./CustomFieldsForm";

/**
 * Self-contained "Custom fields" card for a record's detail page. Renders and
 * saves the workspace's custom fields for one entity + record. Shows nothing
 * when no fields are defined, so it's safe to drop onto every detail page.
 *
 * The markup lives in CustomFieldsForm, which is a client component — the quote
 * editor is a dialog and cannot render an async server component, so both
 * surfaces render the same form rather than two lookalikes.
 */
export default async function CustomFieldsCard({
  entity,
  recordId,
  readOnly = false,
}: {
  entity: CustomEntity;
  recordId: string;
  readOnly?: boolean;
}) {
  // THIS workspace's fields and values, named explicitly (review of #1064). No workspace, no card.
  const tenantId = await getActiveTenantId();
  if (!tenantId) return null;
  const fields = await getFieldsWithValues(entity, recordId, tenantId);
  if (fields.length === 0) return null;
  const links = await loadLinkChoices(fields, tenantId);

  return (
    <CustomFieldsForm
      fields={fields}
      links={links}
      action={saveCustomFieldValues.bind(null, entity, recordId)}
      readOnly={readOnly}
    />
  );
}
