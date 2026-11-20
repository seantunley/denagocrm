import "server-only";
import { canAccessLead, canAccessQuote, getAccessibleQuoteIds, hasPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { ownedWriteTenantId } from "./tenantWrite";
import { dealFinanceHouses, loadDealFinance, loadFinanceDeals, loadLeadFinances, type LeadQuoteFinance } from "./dealFinance";
import { financeStatusLabel, financeStatusShort, isFinanceStatus } from "./dealFinanceRules";
import type { FinanceCard } from "./assistantFinanceRules";
import { johannesburgDateKey } from "./activityDay";
import { summary } from "./assistant/observationFit";

/**
 * DAX AND FINANCE (Sean, 2026-11-16) — "which deals are waiting on finance?", "WesBank approved Jody". The lookup reads
 * the Finance page's own list (loadFinanceDeals: the deals this person may open); the card moves a deal's finance
 * through the deal's own Save (saveDealFinance: leads.edit, audited, dated). Nothing here contacts anyone, and no
 * applicant documents are read or kept.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
export type FinanceArgs = { customer?: string; status?: string; toChase?: boolean; all?: boolean };

const unavailable = (why: string): Output => ({ rows: [], data: [{ note: why }], truncated: false });

/** The financed deals this person may open: where each stands, since when, and what to chase. */
export async function financeLookup(user: PermissionUser, args: FinanceArgs): Promise<Output> {
  if (!(await isModuleEnabled("finance"))) return unavailable("The Finance module is switched off in this workspace.");
  const now = new Date();
  const wanted = (args.customer ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const deals = (await loadFinanceDeals(user, now, { active: !args.all }))
    .filter((deal) => wanted.every((word) => deal.name.toLowerCase().includes(word)))
    .filter((deal) => !args.status || deal.status === args.status)
    .filter((deal) => !args.toChase || deal.chase);
  const rows = deals.slice(0, 60);
  return {
    rows: rows.map((deal) => ({
      label: `${deal.name}${deal.quoteNumber ? ` · Q-${deal.quoteNumber}` : ""} — ${deal.financeHouse}`,
      detail: `${financeStatusShort(deal.status)} since ${johannesburgDateKey(deal.statusAt)}${deal.chase ? ` · ${deal.chase.actionLabel.toLowerCase()}` : ""}`,
      href: `/leads/${deal.leadId}?tab=finance`,
    })),
    data: [
      summary({ total: deals.length, toChase: deals.filter((deal) => deal.chase).length, note: args.all ? "Every financed deal." : "In progress only: not paid out, withdrawn or on a lost deal." }),
      ...rows.map((deal) => ({
        leadId: deal.leadId, quote: deal.quoteNumber ? `Q-${deal.quoteNumber}` : null, link: `/leads/${deal.leadId}?tab=finance`, customer: deal.name, deal: deal.leadStatus, owner: deal.ownerName ?? "unassigned",
        financeHouse: deal.financeHouse, reference: deal.reference, status: financeStatusLabel(deal.status), since: johannesburgDateKey(deal.statusAt),
        chase: deal.chase?.detail ?? null,
      })),
    ],
    truncated: deals.length > rows.length,
  };
}

export type FinanceProposal = { leadId: string; quote?: string; status: string; financeHouse?: string; reference?: string; note?: string; reason?: string };

/**
 * Which of the deal's quotes the finance is for — finance is per quote. Named ("Q-1045"): that one, if it is on this
 * deal. Not named: the one already financed, else the only quote in play — never a guess between two.
 */
function pickQuote(quotes: LeadQuoteFinance[], said: string | undefined): LeadQuoteFinance | { problem: string } {
  if (quotes.length === 0) return { problem: "There's no quote on this deal yet — finance is kept per quote, so make the quote first." };
  const number = said ? Number(said.replace(/^\s*Q-?\s*/i, "")) : NaN;
  if (said) {
    const named = quotes.find((q) => q.quote.number === number);
    return named ?? { problem: `${said.trim()} isn't a quote on this deal — on it: ${quotes.map((q) => `Q-${q.quote.number}`).join(", ")}.` };
  }
  const live = quotes.filter((q) => q.quote.inPlay);
  const financed = live.filter((q) => q.finance);
  if (financed.length === 1) return financed[0];
  if (financed.length === 0 && live.length === 1) return live[0];
  return { problem: `Which quote's finance — ${(financed.length ? financed : live).map((q) => `Q-${q.quote.number}`).join(" or ")}?` };
}

/** The card for a proposal, or why there is none. The lead is one the person may open (checked by the caller). */
export async function financeCard(user: PermissionUser, p: FinanceProposal, lead: { name: string }, id: string, leadLabel: string): Promise<FinanceCard | { problem: string }> {
  if (!(await isModuleEnabled("finance"))) return { problem: "The Finance module is switched off in this workspace." };
  if (!(await hasPermission(user, "leads.edit"))) return { problem: "Your role can't change a deal's finance." };
  if (!isFinanceStatus(p.status)) return { problem: "Where does the finance stand — submitted, approved, declined, paid out?" };
  const tenantId = ownedWriteTenantId();
  const [quotes, houses] = await Promise.all([
    // Only the quotes this person may see (review of #1150) — never a card about a quote they can't open.
    loadLeadFinances(tenantId, p.leadId, await getAccessibleQuoteIds(user)),
    // Only the finance houses ON THIS DEAL: a deal is financed because one was added to its suppliers. A cash deal isn't.
    dealFinanceHouses(tenantId, p.leadId),
  ]);
  if (houses.length === 0) return { problem: `${lead.name}'s deal isn't on finance — add the finance house to the deal's suppliers (on the deal page) first.` };
  const picked = pickQuote(quotes, p.quote);
  if ("problem" in picked) return picked;
  const { quote, finance: current } = picked;
  if (!current && !quote.inPlay) return { problem: `Q-${quote.number} isn't going ahead — start the finance on the quote that is.` };
  // Named: that one, exactly or by its start. Not named: the deal's own, else the only one on the deal — never a guess.
  const said = p.financeHouse?.trim().toLowerCase();
  const house = said
    ? houses.find((h) => h.name.toLowerCase() === said) ?? (houses.filter((h) => h.name.toLowerCase().startsWith(said)).length === 1 ? houses.find((h) => h.name.toLowerCase().startsWith(said)) : undefined)
    : current ? houses.find((h) => h.id === current.vendorId) : houses.length === 1 ? houses[0] : undefined;
  if (!house) return { problem: said ? `"${p.financeHouse}" isn't a finance house on this deal — on it: ${houses.map((h) => h.name).join(", ")}.` : `Which finance house — ${houses.map((h) => h.name).join(" or ")}?` };
  const reference = p.reference?.trim() || current?.reference || null;
  const note = p.note?.trim() || current?.note || null;
  if (current && current.status === p.status && current.vendorId === house.id && current.reference === reference && current.note === note) {
    return { problem: `${lead.name}'s finance on Q-${quote.number} with ${house.name} is already ${financeStatusShort(p.status).toLowerCase()}.` };
  }
  return {
    id, kind: "finance", leadId: p.leadId, leadLabel,
    title: `${lead.name}'s finance on Q-${quote.number}: ${financeStatusShort(p.status)}`,
    quoteId: quote.id, quoteNumber: quote.number,
    vendorId: house.id, status: p.status, reference, note,
    wasVersion: current?.updatedAt.toISOString() ?? null,
    detail: [
      `Finance house: ${house.name}${reference ? ` · ref ${reference}` : ""}`,
      current ? `Now: ${financeStatusLabel(current.status)} (since ${johannesburgDateKey(current.statusAt)})` : "Not financed yet — this starts it",
      `Becomes: ${financeStatusLabel(p.status)}`,
      ...(note ? [`Note: ${note}`] : []),
      "Nobody is contacted.",
    ].join("\n"),
    ...(p.reason ? { reason: p.reason } : {}),
  };
}

/**
 * Confirm: the deal's own Save, once access and permission are known as yes/no (its guard redirects, which a Confirm
 * on WhatsApp can't follow). `done` when it already stands as the card says; `stale` when it moved since the card.
 */
export async function confirmFinanceCard(user: PermissionUser, card: FinanceCard): Promise<{ done: true } | { stale: string } | { form: FormData }> {
  if (!(await canAccessLead(user, card.leadId))) return { stale: "You can't open that deal any more." };
  if (!(await canAccessQuote(user, card.quoteId))) return { stale: "You can't open that quote any more." };
  if (!(await hasPermission(user, "leads.edit"))) return { stale: "Your role can't change a deal's finance." };
  const now = await loadDealFinance(ownedWriteTenantId(), card.quoteId);
  // Done only when EVERYTHING the card sets already stands — a reference- or note-only card is not done by its status.
  if (now && now.status === card.status && now.vendorId === card.vendorId && now.reference === card.reference && now.note === card.note) return { done: true };
  if ((now?.updatedAt.toISOString() ?? null) !== card.wasVersion) {
    return { stale: "The deal's finance changed since this was proposed — nothing was changed. Ask again to see where it stands." };
  }
  const form = new FormData();
  form.set("vendorId", card.vendorId);
  form.set("status", card.status);
  form.set("reference", card.reference ?? "");
  form.set("note", card.note ?? "");
  // The version the card showed: saveDealFinance refuses if anything moved in between (its compare-and-swap).
  form.set("version", card.wasVersion ?? "");
  return { form };
}
