import { SaveButton, SaveForm } from "@/components/SaveForm";
import { saveDealLifecycle } from "@/app/actions/dealLifecycle";
import { LIFECYCLE_TEMPLATES, type LifecycleTemplate } from "@/lib/dealLifecycle";

/**
 * Settings → Company: the steps a deal goes through here (brief §5). Changing it
 * renames the steps and drops the ones this kind of business does not have; it
 * never changes a deal's records, so switching back restores the old view.
 */
export default function DealLifecycleCard({ current }: { current: LifecycleTemplate }) {
  return (
    <SaveForm action={saveDealLifecycle} resetOnSuccess={false} className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Deal steps</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The steps a deal goes through from quote to handover, as the deal page and the Deals Centre show them. Steps your kind of business does not have — stock, inspection — are left off rather than renamed. Deposit, stock and inspection still only count where the module for them is switched on.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">Deal steps</legend>
        {(Object.keys(LIFECYCLE_TEMPLATES) as LifecycleTemplate[]).map((key) => (
          <label key={key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
            <input type="radio" name="template" value={key} defaultChecked={key === current} className="mt-1" />
            <span>
              <span className="block text-sm font-medium">{LIFECYCLE_TEMPLATES[key].name}</span>
              <span className="block text-xs text-muted-foreground">{LIFECYCLE_TEMPLATES[key].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <SaveButton className="btn-primary btn-sm">Save deal steps</SaveButton>
    </SaveForm>
  );
}
