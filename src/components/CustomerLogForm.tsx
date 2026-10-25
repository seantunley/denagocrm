import { addCommunication } from "@/app/actions/communications";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import DealField from "@/components/DealField";
import PasteImageInput from "@/components/PasteImageInput";
import type { DealOption } from "@/lib/customerTimeline";
import { NOTE_KINDS } from "@/lib/customerContact";

export default function CustomerLogForm({ contactId, leadId, deals = [], revalidate, mode }: {
  contactId?: string; leadId?: string; deals?: readonly DealOption[]; revalidate: string; mode: "note" | "call";
}) {
  const prefix = `${leadId ? "deal" : "customer"}-${leadId ?? contactId}-${mode}`;
  return (
    <SaveForm action={addCommunication} success={mode === "note" ? "Saved" : "Communication logged"} className="space-y-3">
      {contactId && <input type="hidden" name="contactId" value={contactId} />}
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      <input type="hidden" name="revalidate" value={revalidate} />
      {!leadId && deals.length > 0 && <DealField deals={deals} id={`${prefix}-deal`} />}
      {mode === "note" ? (
        <>
          {/* Sean, 2026-10-18: a note that records a call is contact. Anything but "Internal note" is saved as that
              contact (customerContact.ts counts it); an internal note still isn't. */}
          <div className="sm:max-w-xs">
            <label htmlFor={`${prefix}-kind`} className="label">What was this?</label>
            <select id={`${prefix}-kind`} name="type" className="input" defaultValue="note">
              {NOTE_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </div>
          <input type="hidden" name="direction" value="" />
        </>
      ) : (
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
        <textarea id={`${prefix}-body`} name="body" className="input" rows={3} placeholder={mode === "note" ? `What should your team know about this ${leadId ? "deal" : "customer"}?` : "What was discussed?"} />
      </div>
      <PasteImageInput />
      <div className="flex flex-wrap items-end justify-between gap-3">
        {mode === "note" ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="pin" className="accent-orange-500" />Pin for the team</label> :
          <div><label htmlFor={`${prefix}-when`} className="label">When (defaults to now)</label><input id={`${prefix}-when`} type="datetime-local" name="occurredAt" className="input" /></div>}
        <SaveButton className="btn-primary" pendingLabel="Saving…">{mode === "note" ? "Save note" : "Log communication"}</SaveButton>
      </div>
    </SaveForm>
  );
}
