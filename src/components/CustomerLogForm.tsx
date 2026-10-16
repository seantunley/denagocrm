import { addCommunication } from "@/app/actions/communications";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import DealField from "@/components/DealField";
import PasteImageInput from "@/components/PasteImageInput";
import type { DealOption } from "@/lib/customerTimeline";

export default function CustomerLogForm({ contactId, deals, revalidate, mode }: {
  contactId: string; deals: readonly DealOption[]; revalidate: string; mode: "note" | "call";
}) {
  const prefix = `customer-${mode}`;
  return (
    <SaveForm action={addCommunication} success={mode === "note" ? "Internal note saved" : "Communication logged"} className="space-y-3">
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="revalidate" value={revalidate} />
      {deals.length > 0 && <DealField deals={deals} id={`${prefix}-deal`} />}
      {mode === "note" ? <><input type="hidden" name="type" value="note" /><input type="hidden" name="direction" value="" /></> : (
        <>
          <p className="text-xs text-muted-foreground">Record a conversation that already happened. This does not send a message.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor={`${prefix}-type`} className="label">Type</label><select id={`${prefix}-type`} name="type" className="input" defaultValue="call">
              <option value="call">Call</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="meeting">Meeting</option>
            </select></div>
            <div><label htmlFor={`${prefix}-direction`} className="label">Direction</label><select id={`${prefix}-direction`} name="direction" className="input" defaultValue="outbound">
              <option value="outbound">Outbound</option><option value="inbound">Inbound</option><option value="">Not applicable</option>
            </select></div>
          </div>
          <div><label htmlFor={`${prefix}-subject`} className="label">Subject (optional)</label><input id={`${prefix}-subject`} name="subject" className="input" /></div>
        </>
      )}
      <div>
        <label htmlFor={`${prefix}-body`} className="label">{mode === "note" ? "Internal note · visible to your team" : "Conversation details"}</label>
        <textarea id={`${prefix}-body`} name="body" className="input" rows={3} placeholder={mode === "note" ? "What should your team know about this customer?" : "What was discussed?"} />
      </div>
      <PasteImageInput />
      <div className="flex flex-wrap items-end justify-between gap-3">
        {mode === "note" ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="pin" className="accent-orange-500" />Pin for the team</label> :
          <div><label htmlFor={`${prefix}-when`} className="label">When (defaults to now)</label><input id={`${prefix}-when`} type="datetime-local" name="occurredAt" className="input" /></div>}
        <SaveButton className="btn-primary" pendingLabel="Saving…">{mode === "note" ? "Save internal note" : "Log communication"}</SaveButton>
      </div>
    </SaveForm>
  );
}
