import { Landmark } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { StatusPill, Surface } from "@/components/visual-system";
import { saveDealFinance } from "@/app/actions/dealFinance";
import { FINANCE_STATUSES, financeChase, financeStatusShort, financeTone } from "@/lib/dealFinanceRules";
import { formatDate } from "@/lib/format";

type Finance = { status: string; statusAt: Date; updatedAt: Date; reference: string | null; note: string | null; vendorId: string; vendor: { name: string } };

/**
 * A QUOTE's finance through an outside finance house (Sean, 2026-11-16): where it stands, since when, and what to
 * chase. Per quote — a deal can carry several and only one is accepted. On the lead's Finance tab (one per quote) and
 * on the deal page. No applicant documents are taken — they stay with the finance house.
 */
export default function DealFinancePanel({ quote, finance, financeHouses, canEdit, now }: {
  /** inPlay: false for a cancelled, declined or replaced quote — its finance is kept but counts for nothing. */
  quote: { id: string; number: number; inPlay: boolean };
  finance: Finance | null;
  financeHouses: { id: string; name: string }[];
  canEdit: boolean;
  now: Date;
}) {
  const chase = finance && quote.inPlay ? financeChase({ status: finance.status, statusAt: finance.statusAt, financeHouse: finance.vendor.name, reference: finance.reference }, now) : null;
  const field = (name: string) => `finance-${name}-${quote.number}`;
  return (
    <Surface className="p-5" id={`finance-q${quote.number}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Landmark className="size-5 text-muted-foreground" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Finance · Q-{quote.number}</p>
            <h2 className="mt-0.5 text-base font-semibold">{finance ? finance.vendor.name : "Not started yet"}</h2>
          </div>
        </div>
        {finance && <StatusPill tone={financeTone(finance.status)}>{financeStatusShort(finance.status)} since {formatDate(finance.statusAt)}</StatusPill>}
      </div>
      {!quote.inPlay && (
        <p className="mt-2 text-sm text-muted-foreground">Q-{quote.number} is no longer going ahead, so this finance is kept on file but isn&apos;t chased and holds nothing back.</p>
      )}
      {finance?.reference && <p className="mt-2 text-sm text-muted-foreground">Reference: <span className="font-medium text-foreground">{finance.reference}</span></p>}
      {finance?.note && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{finance.note}</p>}
      {chase && <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{chase.detail}. {chase.actionLabel}, then update the status below.</p>}

      {canEdit && financeHouses.length > 0 && (quote.inPlay || finance) && (
        <SaveForm action={saveDealFinance.bind(null, quote.id)} success="Finance saved" resetOnSuccess={false} className="mt-4 grid gap-3 sm:grid-cols-2">
          {/* The version this form shows: a save over a newer one is refused (saveDealFinance). Server-rendered, never written by script. */}
          <input type="hidden" name="version" value={finance?.updatedAt.toISOString() ?? ""} />
          <div>
            <label className="label" htmlFor={field("house")}>Finance house</label>
            <select id={field("house")} name="vendorId" required defaultValue={finance?.vendorId ?? (financeHouses.length === 1 ? financeHouses[0].id : "")} className="input">
              <option value="" disabled>Choose…</option>
              {financeHouses.map((house) => <option key={house.id} value={house.id}>{house.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={field("status")}>Where it stands</label>
            <select id={field("status")} name="status" required defaultValue={finance?.status ?? "docs_outstanding"} className="input">
              {FINANCE_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={field("reference")}>Their reference</label>
            <input id={field("reference")} name="reference" defaultValue={finance?.reference ?? ""} maxLength={80} className="input" placeholder="Application number" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor={field("note")}>What they said</label>
            <textarea id={field("note")} name="note" defaultValue={finance?.note ?? ""} maxLength={1000} rows={2} className="input" placeholder="e.g. Approved subject to a 10% deposit" />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Keep the customer&apos;s ID, payslips and bank statements with the finance house — don&apos;t upload them here.
            File the approval letter and payout confirmation on the deal.
          </p>
          <div className="sm:col-span-2"><SaveButton className="btn-primary btn-sm">{finance ? "Save" : "Start finance"}</SaveButton></div>
        </SaveForm>
      )}
      {/* Shown only on a deal with a finance record whose finance house was taken off the deal's suppliers. */}
      {canEdit && financeHouses.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {finance?.vendor.name ?? "The finance house"} is no longer on this deal&apos;s suppliers — add it back to update the finance.
        </p>
      )}
    </Surface>
  );
}
