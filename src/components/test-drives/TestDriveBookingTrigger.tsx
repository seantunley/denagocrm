import { Plus } from "lucide-react";
import { createTestDriveBooking } from "@/app/actions/testDrives";
import { contactName } from "@/lib/format";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";

type ContactOption = {
  id: string;
  firstName: string;
  lastName: string | null;
  company: string | null;
  isCompany: boolean;
};

type LeadOption = { id: string; title: string; name: string };
type DemoOption = { id: string; name: string; regNumber: string | null };
type NamedOption = { id: string; name: string };

export function TestDriveBookingTrigger({
  contacts,
  leads,
  demos,
  products,
  staff,
  salespersonId,
  defaultStart,
  defaultEnd,
  compact = false,
}: {
  contacts: ContactOption[];
  leads: LeadOption[];
  demos: DemoOption[];
  products: NamedOption[];
  staff: NamedOption[];
  salespersonId: string;
  defaultStart: string;
  defaultEnd: string;
  compact?: boolean;
}) {
  return (
    <ModalTrigger
      label={<><Plus className="size-4" />{compact ? "Book" : "Book test drive"}</>}
      title="Book a test drive"
      buttonClass={buttonVariants({ size: "sm" })}
    >
      <form action={createTestDriveBooking} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Customer</label>
            <select name="contactId" className="input" required defaultValue="">
              <option value="" disabled>Select customer…</option>
              {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label">Lead</label>
            <select name="leadId" className="input" defaultValue="">
              <option value="">No linked lead</option>
              {leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.title} — {lead.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Branch / location</label>
            <input name="branch" className="input" required placeholder="Cape Town showroom" />
          </div>
          <div>
            <label className="label">Demo vehicle</label>
            <select name="demoVehicleId" className="input" defaultValue="">
              <option value="">Assign later</option>
              {demos.map((demo) => <option key={demo.id} value={demo.id}>{demo.name}{demo.regNumber ? ` · ${demo.regNumber}` : ""}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            <select name="productId" className="input" defaultValue="">
              <option value="">Infer from lead or demo vehicle</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Salesperson</label>
            <select name="salespersonId" className="input" defaultValue={salespersonId}>
              {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Accompanying salesperson</label>
            <select name="accompanyingSalespersonId" className="input" defaultValue="">
              <option value="">None</option>
              {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Start</label>
            <input type="datetime-local" name="scheduledStart" className="input" required defaultValue={defaultStart} />
          </div>
          <div>
            <label className="label">Expected return</label>
            <input type="datetime-local" name="expectedReturnAt" className="input" required defaultValue={defaultEnd} />
          </div>
        </div>
        <button className="btn-primary w-full">Create booking</button>
      </form>
    </ModalTrigger>
  );
}
