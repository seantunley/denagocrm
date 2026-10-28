import Link from "next/link";
import { CircleDollarSign, ReceiptText } from "lucide-react";
import ModalTrigger from "@/components/Modal";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { Surface } from "@/components/visual-system";
import { recordQuotePayment, voidQuotePayment } from "@/app/actions/quotePayments";
import {
  PAYMENT_METHODS,
  invoiceTotalCents,
  paymentMethodLabel,
  receivedCents,
  type StatementPayment,
  type StatementQuote,
} from "@/lib/accountStatement";
import { formatDate, formatZAR } from "@/lib/format";

export type DealPayment = StatementPayment & {
  note: string | null;
  createdByName: string;
  voidedByName: string | null;
  voidReason: string | null;
};

/**
 * The money on one deal: invoice total, the deposit as recorded on the
 * deliveries board, every later payment, and what is still owing — the same
 * arithmetic the customer statement prints (lib/accountStatement.ts).
 */
export default function DealPayments({
  quote,
  payments,
  canRecord,
  statementHref,
  today,
}: {
  quote: StatementQuote;
  payments: DealPayment[];
  /** deliveries.manage — the same grant that records the deposit. */
  canRecord: boolean;
  statementHref: string | null;
  /** YYYY-MM-DD in the workspace's time zone, for the date field's default. */
  today: string;
}) {
  const total = invoiceTotalCents(quote);
  const paid = receivedCents(quote, payments);
  const owing = total - paid;
  const depositWithoutAmount = Boolean(quote.depositPaidAt) && quote.depositPaidCents == null;

  return (
    <Surface className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Money</p>
          <h2 className="mt-1 text-base font-semibold">Payments</h2>
        </div>
        <CircleDollarSign className="size-5 text-muted-foreground" />
      </div>

      <div className="mt-4 divide-y divide-border/70 text-sm">
        <div className="flex justify-between gap-4 py-2.5">
          <span className="font-medium">Invoice total</span>
          <span className="font-semibold tabular-nums">{formatZAR(total)}</span>
        </div>
        {quote.depositPaidAt && (
          <div className="flex justify-between gap-4 py-2.5">
            <span>
              Deposit received <span className="text-xs text-muted-foreground">· {formatDate(quote.depositPaidAt)}</span>
            </span>
            <span className="tabular-nums">{depositWithoutAmount ? "Amount not recorded" : `−${formatZAR(quote.depositPaidCents ?? 0)}`}</span>
          </div>
        )}
        {payments.map((payment) => (
          <div key={payment.id} className="flex items-start justify-between gap-4 py-2.5">
            <div className={payment.voidedAt ? "min-w-0 text-muted-foreground line-through" : "min-w-0"}>
              <p>
                Payment <span className="text-xs text-muted-foreground">· {formatDate(payment.receivedAt)} · {paymentMethodLabel(payment.method)}{payment.reference ? ` · ${payment.reference}` : ""}</span>
              </p>
              <p className="text-xs text-muted-foreground">Recorded by {payment.createdByName}{payment.note ? ` — ${payment.note}` : ""}</p>
              {payment.voidedAt && (
                <p className="text-xs text-muted-foreground no-underline">
                  Voided {formatDate(payment.voidedAt)}{payment.voidedByName ? ` by ${payment.voidedByName}` : ""} — {payment.voidReason}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className={payment.voidedAt ? "tabular-nums text-muted-foreground line-through" : "tabular-nums"}>−{formatZAR(payment.amountCents)}</span>
              {canRecord && !payment.voidedAt && (
                <ModalTrigger label="Void" title="Void this payment" buttonClass="text-xs text-primary hover:underline">
                  <SaveForm success="Payment voided" action={voidQuotePayment.bind(null, quote.id, payment.id)} className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {formatZAR(payment.amountCents)} received {formatDate(payment.receivedAt)}. It stays on the record, marked void, and stops counting toward the balance.
                    </p>
                    <label className="label" htmlFor={`void-${payment.id}`}>Reason</label>
                    <input id={`void-${payment.id}`} name="reason" required minLength={3} className="input" placeholder="e.g. Captured twice" />
                    <SaveButton className="btn-primary btn-sm">Void payment</SaveButton>
                  </SaveForm>
                </ModalTrigger>
              )}
            </div>
          </div>
        ))}
        <div className="flex justify-between gap-4 py-3">
          <span className="font-semibold">{owing < 0 ? "In credit" : "Still owing"}</span>
          <span className="text-lg font-semibold tabular-nums">{formatZAR(Math.abs(owing))}</span>
        </div>
      </div>

      {depositWithoutAmount && (
        <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs text-amber-200">
          The deposit was marked received without an amount, so it isn&apos;t deducted. Enter it with “Correct deposit” on the deliveries board.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {canRecord && owing > 0 && (
          <ModalTrigger label="Record payment" title="Record a payment" buttonClass="btn-primary btn-sm">
            <SaveForm success="Payment recorded" action={recordQuotePayment.bind(null, quote.id)} className="space-y-3">
              {!quote.depositPaidAt && (
                <p className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                  Taking the deposit? Record it with “Deposit paid” on the deliveries board instead, so delivery readiness updates too.
                </p>
              )}
              <p className="text-sm text-muted-foreground">{formatZAR(owing)} is still owing on this invoice.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="payment-amount">Amount received (R)</label>
                  <input id="payment-amount" name="amount" inputMode="decimal" required className="input" placeholder="0.00" />
                </div>
                <div>
                  <label className="label" htmlFor="payment-date">Date received</label>
                  <input id="payment-date" name="receivedAt" type="date" required max={today} defaultValue={today} className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="payment-method">Method</label>
                  <select id="payment-method" name="method" required defaultValue="eft" className="input">
                    {Object.entries(PAYMENT_METHODS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="payment-reference">Reference</label>
                  <input id="payment-reference" name="reference" maxLength={120} className="input" placeholder="Bank reference" />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="payment-note">Note</label>
                <input id="payment-note" name="note" maxLength={500} className="input" placeholder="Optional" />
              </div>
              <SaveButton className="btn-primary btn-sm">Record payment</SaveButton>
            </SaveForm>
          </ModalTrigger>
        )}
        {statementHref && (
          <Link href={statementHref} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">
            <ReceiptText className="size-4" />
            Customer statement
          </Link>
        )}
      </div>
    </Surface>
  );
}
