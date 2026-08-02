import { getFieldsWithValues, type CustomEntity } from "@/lib/customFields";
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
  const fields = await getFieldsWithValues(entity, recordId);
  if (fields.length === 0) return null;

  return (
    <CustomFieldsForm
      fields={fields}
      action={saveCustomFieldValues.bind(null, entity, recordId)}
      readOnly={readOnly}
    />
  );
}
