import { NO_DEAL, dealChoice, type DealOption } from "@/lib/customerTimeline";

/**
 * "Which deal is this about?" — for anything written from a CUSTOMER's page
 * (an email, a WhatsApp, a logged call or note).
 *
 * A customer can have several deals, and an entry written here used to be filed
 * on the customer alone, invisible on every one of them. Now (lib/customerTimeline):
 *
 *   no open deal   → nothing to choose: it is filed on the customer;
 *   exactly one    → that deal, silently;
 *   more than one  → the person is ASKED, and must answer before it can be sent
 *                    (Sean, 2026-10-12: "it must ask. But only if there is more
 *                    than one deal").
 *
 * Posts `leadId`. The action it posts to checks that the deal really is this
 * customer's (filedOn) — this field is a question, not the rule.
 *
 * No state and no effects, so it renders inside server and client forms alike.
 */
export default function DealField({ deals, id = "deal-field" }: { deals: readonly DealOption[]; id?: string }) {
  const choice = dealChoice(deals);
  if (!choice.ask) return choice.leadId ? <input type="hidden" name="leadId" value={choice.leadId} /> : null;
  return (
    <div data-testid="deal-field">
      <label className="label" htmlFor={id}>Which deal is this about?</label>
      <select id={id} name="leadId" required defaultValue="" className="input">
        <option value="" disabled>Choose a deal…</option>
        {choice.options.map((deal) => (
          <option key={deal.id} value={deal.id}>{deal.label}</option>
        ))}
        <option value={NO_DEAL}>None of these — the customer in general</option>
      </select>
      <p className="mt-1 text-xs text-slate-500">This customer has {choice.options.length} open deals. It is filed on the one you choose, and always on the customer.</p>
    </div>
  );
}
