import ModalTrigger from "@/components/Modal";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { markDepositPaid, scheduleDelivery } from "@/app/actions/fulfilment";
import { allocateUnitToDeal } from "@/app/actions/dealSteps";

/**
 * A deal step done ON the deal page (W2-05): the same forms, through the same
 * actions, as the Deliveries board (deposit, delivery) and the stock page
 * (allocate). Those actions check permission, this quote's access and the
 * step's own rules again; the page only offers a form where its rules allow
 * one, and links to the board otherwise.
 */

export function RecordDepositForm({ quoteId, number, currencyLabel, className, label = "Record deposit" }: {
  quoteId: string;
  number: number;
  /** "Amount received (R)" — the quote's own currency. */
  currencyLabel: { placeholder: string; aria: string };
  className: string;
  label?: string;
}) {
  return (
    <ModalTrigger label={label} title={`Deposit — Q-${number}`} buttonClass={className}>
      <SaveForm success="Deposit recorded" resetOnSuccess={false} action={markDepositPaid.bind(null, quoteId)} className="space-y-3">
        <input name="amount" inputMode="decimal" required placeholder={currencyLabel.placeholder} aria-label={currencyLabel.aria} className="input" />
        <div>
          <label className="label" htmlFor={`deposit-proof-${quoteId}`}>Proof of payment</label>
          <input id={`deposit-proof-${quoteId}`} type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
        </div>
        <SaveButton className="btn-primary btn-sm">Deposit paid</SaveButton>
      </SaveForm>
    </ModalTrigger>
  );
}

export function ScheduleDeliveryForm({ quoteId, number, className, label = "Book delivery" }: { quoteId: string; number: number; className: string; label?: string }) {
  return (
    <ModalTrigger label={label} title={`Delivery — Q-${number}`} buttonClass={className}>
      <SaveForm success="Delivery scheduled" resetOnSuccess={false} action={scheduleDelivery.bind(null, quoteId)} className="space-y-3">
        <div>
          <label className="label" htmlFor={`delivery-date-${quoteId}`}>Delivery date</label>
          <input id={`delivery-date-${quoteId}`} type="date" name="date" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor={`delivery-paper-${quoteId}`}>Delivery paperwork (optional)</label>
          <input id={`delivery-paper-${quoteId}`} type="file" name="file" accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
        </div>
        <SaveButton className="btn-primary btn-sm">Schedule delivery</SaveButton>
      </SaveForm>
    </ModalTrigger>
  );
}

/** A unit of a product on the quote, available or reserved for this deal (the page picks them). */
export type AllocatableUnit = { id: string; label: string };

export function AllocateUnitForm({ quoteId, units, className, label = "Allocate" }: { quoteId: string; units: AllocatableUnit[]; className: string; label?: string }) {
  return (
    <ModalTrigger label={label} title="Allocate a unit to this deal" buttonClass={className}>
      <SaveForm success="Unit allocated" resetOnSuccess={false} action={allocateUnitToDeal.bind(null, quoteId)} className="space-y-3">
        <div>
          <label className="label" htmlFor={`unit-${quoteId}`}>Unit</label>
          <select id={`unit-${quoteId}`} name="unitId" className="input" required defaultValue="">
            <option value="" disabled>Choose a unit…</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
          </select>
        </div>
        <SaveButton className="btn-primary btn-sm">Allocate to this deal</SaveButton>
      </SaveForm>
    </ModalTrigger>
  );
}
