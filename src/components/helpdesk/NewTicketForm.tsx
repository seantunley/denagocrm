import { SaveForm, SaveButton } from "@/components/SaveForm";
import { TICKET_TYPES, PRIORITIES } from "@/lib/helpdesk-constants";
import { createTicket } from "@/app/actions/helpdesk";

type Option = { id: string; label: string };

/** Capture form for opening a ticket on a customer's behalf. Rendered inside a modal. */
export function NewTicketForm({ contacts, mailboxes }: { contacts: Option[]; mailboxes: Option[] }) {
  return (
    <SaveForm action={createTicket} success="Ticket created" className="card space-y-4">
      <div>
        <label className="label" htmlFor="contactId">Customer *</label>
        <select id="contactId" name="contactId" required defaultValue="" className="input">
          <option value="" disabled>Select a customer…</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="subject">Subject *</label>
        <input id="subject" name="subject" required className="input" placeholder="Short summary of the issue" />
      </div>

      <div>
        <label className="label" htmlFor="description">Description *</label>
        <textarea id="description" name="description" required rows={5} className="input min-h-28 resize-y" placeholder="What does the customer need help with?" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="type">Type</label>
          <select id="type" name="type" defaultValue="support" className="input capitalize">
            {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="priority">Priority</label>
          <select id="priority" name="priority" defaultValue="normal" className="input">
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mailboxId">Mailbox</label>
          <select id="mailboxId" name="mailboxId" defaultValue={mailboxes[0]?.id ?? ""} className="input">
            <option value="">No mailbox</option>
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="assignToMe" defaultChecked /> Assign to me
      </label>

      <SaveButton className="btn-primary w-full" pendingLabel="Creating…">Create ticket</SaveButton>
    </SaveForm>
  );
}
