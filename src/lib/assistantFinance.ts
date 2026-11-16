import "server-only";
import { canAccessLead, hasPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { ownedWriteTenantId } from "./tenantWrite";
import { dealFinanceHouses, loadDealFinance, loadFinanceDeals } from "./dealFinance";
import { financeStatusLabel, financeStatusShort, isFinanceStatus } from "./dealFinanceRules";
import type { FinanceCard } from "./assistantFinanceRules";
import { johannesburgDateKey } from "./activityDay";

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
      label: `${deal.name} — ${deal.financeHouse}`,
      detail: `${financeStatusShort(deal.status)} since ${johannesburgDateKey(deal.statusAt)}${deal.chase ? ` · ${deal.chase.actionLabel.toLowerCase()}` : ""}`,
      href: `/leads/${deal.leadId}?tab=finance`,
    })),
    data: [
      { total: deals.length, toChase: deals.filter((deal) => deal.chase).length, note: args.all ? "Every financed deal." : "In progress only: not paid out, withdrawn or on a lost deal." },
      ...rows.map((deal) => ({
        leadId: deal.leadId, link: `/leads/${deal.leadId}?tab=finance`, customer: deal.name, deal: deal.leadStatus, owner: deal.ownerName ?? "unassigned",
        financeHouse: deal.financeHouse, reference: deal.reference, status: financeStatusLabel(deal.status), since: johannesburgDateKey(deal.statusAt),
        chase: deal.chase?.detail ?? null,
      })),
    ],
    truncated: deals.length > rows.length,
  };
}

export type FinanceProposal = { leadId: string; status: string; financeHouse?: string; reference?: string; note?: string; reason?: string };

/** The card for a proposal, or why there is none. The lead is one the person may open (checked by the caller). */
export async function financeCard(user: PermissionUser, p: FinanceProposal, lead: { name: string }, id: string, leadLabel: string): Promise<FinanceCard | { problem: string }> {
  if (!(await isModuleEnabled("finance"))) return { problem: "The Finance module is switched off in this workspace." };
  if (!(await hasPermission(user, "leads.edit"))) return { problem: "Your role can't change a deal's finance." };
  if (!isFinanceStatus(p.status)) return { problem: "Where does the finance stand — submitted, approved, declined, paid out?" };
  const tenantId = ownedWriteTenantId();
  const [current, houses] = await Promise.all([
    loadDealFinance(tenantId, p.leadId),
    // Only the finance houses ON THIS DEAL: a deal is financed because one was added to its suppliers. A cash deal isn't.
    dealFinanceHouses(tenantId, p.leadId),
  ]);
  if (houses.length === 0) return { problem: `${lead.name}'s deal isn't on finance — add the finance house to the deal's suppliers (on the deal page) first.` };
  // Named: that one, exactly or by its start. Not named: the deal's own, else the only one on the deal — never a guess.
  const said = p.financeHouse?.trim().toLowerCase();
  const house = said
    ? houses.find((h) => h.name.toLowerCase() === said) ?? (houses.filter((h) => h.name.toLowerCase().startsWith(said)).length === 1 ? houses.find((h) => h.name.toLowerCase().startsWith(said)) : undefined)
    : current ? houses.find((h) => h.id === current.vendorId) : houses.length === 1 ? houses[0] : undefined;
  if (!house) return { problem: said ? `"${p.financeHouse}" isn't a finance house on this deal — on it: ${houses.map((h) => h.name).join(", ")}.` : `Which finance house — ${houses.map((h) => h.name).join(" or ")}?` };
  const reference = p.reference?.trim() || current?.reference || null;
  const note = p.note?.trim() || current?.note || null;
  if (current && current.status === p.status && current.vendorId === house.id && current.reference === reference && current.note === note) {
    return { problem: `${lead.name}'s finance with ${house.name} is already ${financeStatusShort(p.status).toLowerCase()}.` };
  }
  return {
    id, kind: "finance", leadId: p.leadId, leadLabel,
    title: `${lead.name}'s finance: ${financeStatusShort(p.status)}`,
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
  if (!(await hasPermission(user, "leads.edit"))) return { stale: "Your role can't change a deal's finance." };
  const now = await loadDealFinance(ownedWriteTenantId(), card.leadId);
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
