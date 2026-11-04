import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { requireRoute } from "@/lib/permissions";
import { getSetting } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Surface } from "@/components/visual-system";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { FLOW_SHARED_VALUES_KEY, SHARED_VALUE_LIMIT, parseSharedValues } from "@/lib/flowSharedValues";
import { addSharedValue, deleteSharedValue, updateSharedValue } from "@/app/actions/flowSharedValues";

export const dynamic = "force-dynamic";

/**
 * Flows → Shared values (lib/flowSharedValues.ts): {{business_phone}}, {{website}}… set once, used in any message of
 * any flow, read fresh on every message — so changing the phone number is one edit, with no republishing. Owner only.
 */
export default async function FlowSharedValuesPage() {
  await requireRoute("/bot-builder");
  await requireTenantOwner();
  const values = parseSharedValues(await getSetting(FLOW_SHARED_VALUES_KEY));

  return (
    <div className="space-y-3">
      <PageHeader
        title="Shared values"
        description="Set something once — your phone number, opening hours, website — and use it in any chatbot message as {{name}}. Change it here and every flow uses the new value from the next message, without publishing again."
        className="border-b border-border/80 pb-3"
      >
        <Link href="/bot-builder" className="btn-secondary btn-sm min-h-11 sm:min-h-9"><ArrowLeft className="size-4" />Flow library</Link>
      </PageHeader>

      <Surface className="p-4">
        {values.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared values yet. Add one below — e.g. <code>business_phone</code>.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {values.map((v) => (
              <li key={v.name} className="grid gap-2 py-3 sm:grid-cols-[14rem_1fr_auto] sm:items-start">
                <p className="pt-2 font-mono text-sm text-sky-300">{`{{${v.name}}}`}</p>
                <SaveForm action={updateSharedValue.bind(null, v.name)} success="Saved" className="flex gap-2">
                  <label className="sr-only" htmlFor={`value-${v.name}`}>Value of {v.name}</label>
                  <input id={`value-${v.name}`} name="value" className="input flex-1" defaultValue={v.value} maxLength={500} required />
                  <SaveButton className="btn-secondary btn-sm min-h-11 sm:min-h-9">Save</SaveButton>
                </SaveForm>
                <ConfirmActionDialog
                  trigger={<button type="button" className="btn-secondary btn-sm min-h-11 text-red-300 sm:min-h-9">Delete</button>}
                  title={`Delete {{${v.name}}}?`}
                  description="Messages that use it will show nothing in its place until you add it again or change those messages."
                  confirmLabel="Delete shared value"
                  destructive
                  success="Deleted"
                  onConfirm={deleteSharedValue.bind(null, v.name)}
                />
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {values.length < SHARED_VALUE_LIMIT && (
        <Surface className="p-4">
          <h2 className="font-semibold">Add a shared value</h2>
          <SaveForm action={addSharedValue} success="Shared value saved" className="mt-3 grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
            <div><label className="label" htmlFor="sv-name">Name</label><input id="sv-name" name="name" className="input font-mono" required maxLength={40} pattern="[a-z][a-z0-9_]{1,39}" placeholder="business_phone" /></div>
            <div><label className="label" htmlFor="sv-value">Value</label><input id="sv-value" name="value" className="input" required maxLength={500} placeholder="021 555 0100" /></div>
            <SaveButton className="btn-primary btn-sm min-h-11 sm:min-h-9">Add</SaveButton>
          </SaveForm>
          <p className="mt-2 text-xs text-muted-foreground">Lowercase letters, numbers and _ only. Names the chatbot fills in itself — like name, phone, greeting — can&apos;t be used. Values are visible to anyone who edits flows, so never put a password or API key here (those go in Connections).</p>
        </Surface>
      )}
    </div>
  );
}
