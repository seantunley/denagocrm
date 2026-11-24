import { SaveButton, SaveForm } from "@/components/SaveForm";
import { setWorkDisposition } from "@/app/actions/myWork";
import { SNOOZE_CHOICES } from "@/lib/myWork/dispositions";

/**
 * A row's "Later" menu on My Work: snooze it off MY list for a while, or — for a
 * suggestion only — dismiss it. Neither touches the record (lib/myWork/dispositions.ts).
 */
export default function WorkItemMenu({ itemKey, dismissable, fingerprint }: { itemKey: string; dismissable: boolean; fingerprint: string }) {
  return (
    <details className="relative inline-block text-left">
      <summary className="btn-secondary btn-sm cursor-pointer list-none" title="Snooze it off your list for a while, or dismiss a suggestion">Later</summary>
      <div className="absolute right-0 z-20 mt-1 w-48 space-y-1 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
        {SNOOZE_CHOICES.map((choice) => (
          <SaveForm key={choice.days} action={setWorkDisposition} success="Snoozed" resetOnSuccess={false}>
            <input type="hidden" name="itemKey" value={itemKey} />
            <input type="hidden" name="choice" value={`snooze:${choice.days}`} />
            <input type="hidden" name="fingerprint" value={fingerprint} />
            <SaveButton className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted">Snooze {choice.label.toLowerCase()}</SaveButton>
          </SaveForm>
        ))}
        {dismissable && (
          <SaveForm action={setWorkDisposition} success="Dismissed" resetOnSuccess={false}>
            <input type="hidden" name="itemKey" value={itemKey} />
            <input type="hidden" name="choice" value="dismiss" />
            <input type="hidden" name="fingerprint" value={fingerprint} />
            <SaveButton className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" title="Not this one. It comes back if its reason changes, or in 30 days.">Dismiss suggestion</SaveButton>
          </SaveForm>
        )}
      </div>
    </details>
  );
}
