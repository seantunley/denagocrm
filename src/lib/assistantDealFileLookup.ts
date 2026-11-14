import "server-only";
import { basePrisma, prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { loadDealFile, vendorPurchaseOrders } from "./dealFileData";
import { missingSupplierPapers } from "./supplierDigest";
import { vendorKindLabel } from "./vendors";
import { contactName } from "./format";

/**
 * THE DEAL FILE AND THE SUPPLIERS, for DAX (Sean, 2026-11-14: "DAX must have knowledge of those things, permission
 * based"). Each is held to its PAGE's own rule and reads through the page's own loader:
 *  - deal_file: the deal page — quote access (quotes.view_all / view_owned, then only quotes this person may open)
 *    and loadDealFile, the one loader behind the deal page and its ZIP, so DAX can never tick differently;
 *  - suppliers: Settings → Suppliers — the Suppliers module on and the workspace's OWNER only (the page is
 *    requireTenantOwner); "what's missing" is the weekly digest's own rule (missingSupplierPapers), narrowed to the
 *    deals this person may open. No bank or payment reference is ever read.
 * The workspace is named in every query of its own. Nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const unavailable = (why: string): Output => ({ rows: [], data: [{ note: why }], truncated: false });
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const clip = (s: string | null | undefined, max: number) => {
  const text = (s ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });

/* ── deal_file ───────────────────────────────────────────────────────────── */

/** Quotes searched to tell deals apart, at most; past it, the person narrows. */
const DEAL_MATCH_CEILING = 1000;
/** Deals listed to choose from, at most; more than this, only the count is said. */
const DEAL_CANDIDATES = 6;

export async function dealFileLookup(user: PermissionUser, args: { deal: string }): Promise<Output> {
  if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) return unavailable("This person can't open deals (no quote access).");
  const quoteIds = await getAccessibleQuoteIds(user);
  if (quoteIds !== null && quoteIds.length === 0) return unavailable("There are no deals this person may open.");
  const tenantId = ownedWriteTenantId();
  const number = /^\s*Q-?(\d{2,})\s*$/i.exec(args.deal);
  const words = args.deal.split(/\s+/).filter(Boolean).slice(0, 4);
  const found = await prisma.quote.findMany({
    where: {
      tenantId,
      deletedAt: null,
      // AND, never spread: what was asked for must never replace the access filter.
      AND: [
        ...(quoteIds === null ? [] : [{ id: { in: quoteIds } }]),
        number
          ? { number: Number(number[1]) }
          : {
              OR: [
                { contact: { AND: words.map((w) => ({ OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }] })) } },
                { lead: { AND: words.map((w) => ({ OR: [{ name: fuzzy(w) }, { title: fuzzy(w) }] })) } },
              ],
            },
      ],
    },
    orderBy: { createdAt: "desc" },
    // EVERY matching quote (review of #1104: the 20 newest left an older, delivered deal out without a word), only
    // what tells deals apart. The ceiling guards a one-word search; past it, they narrow.
    take: DEAL_MATCH_CEILING + 1,
    select: { id: true, leadId: true, number: true, createdAt: true },
  });
  if (!found.length) return unavailable(`No deal this person may open matches "${args.deal}".`);
  if (found.length > DEAL_MATCH_CEILING) return unavailable(`More than ${DEAL_MATCH_CEILING} quotes match "${args.deal}" — ask for the Q-number or the customer's full name.`);
  // One deal = one lead (all its quotes), or a quote with no lead — each shown by its NEWEST quote.
  const deals = new Map<string, (typeof found)[number]>();
  for (const q of found) if (!deals.has(q.leadId ?? q.id)) deals.set(q.leadId ?? q.id, q);
  if (deals.size > DEAL_CANDIDATES) {
    return unavailable(`${deals.size} deals match "${args.deal}" — ask which one, by its Q-number or the customer's full name. (Not listed: a few of them would look like all of them.)`);
  }
  const named = await prisma.quote.findMany({
    where: { tenantId, id: { in: [...deals.values()].map((q) => q.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, leadId: true, contact: { select: { firstName: true, lastName: true, company: true } }, lead: { select: { name: true, title: true } } },
  });
  const who = (q: (typeof named)[number]) => q.contact?.company || (q.contact ? contactName(q.contact) : "") || q.lead?.name || `Q-${q.number}`;
  if (named.length > 1) {
    return {
      rows: [],
      truncated: false,
      data: [{ note: `${named.length} deals match — ask which one.`, deals: named.map((q) => ({ quote: `Q-${q.number}`, customer: who(q), deal: q.lead?.title ?? null })) }],
    };
  }
  const quote = named[0];
  if (!quote) return unavailable(`No deal this person may open matches "${args.deal}".`);
  // The deal page's own loader: only the quotes on this deal this person may open, the current version of each paper.
  const file = await loadDealFile({ id: quote.id, leadId: quote.leadId }, user);
  const link = `/deals/${quote.id}`;
  const byType = new Map<string, string[]>();
  for (const doc of file.documents) {
    const type = doc.tag ?? "not labelled";
    byType.set(type, [...(byType.get(type) ?? []), clip(doc.fileName, 60)]);
  }
  const missing = file.checklist.filter((item) => !item.done);
  return {
    truncated: false,
    rows: [{ label: `Deal file — ${who(quote)}`, detail: `${missing.length} missing of ${file.checklist.length}`, href: link }],
    data: [{
      deal: quote.lead?.title ?? `Q-${quote.number}`,
      customer: who(quote),
      link,
      quotes: file.dealQuotes.map((q) => ({ quote: `Q-${q.number}`, status: q.status, replaced: Boolean(q.supersededAt), delivered: day(q.deliveredAt) })),
      checklist: file.checklist.map((item) => ({ item: item.label, done: item.done, detail: clip(item.detail, 140) })),
      missing: missing.map((item) => item.label),
      papersOnFile: [...byType].map(([type, files]) => ({ type, count: files.length, files: files.slice(0, 5) })),
      signing: file.signatures.map((s) => ({ title: clip(s.title, 80), status: s.status, sent: day(s.sentAt), completed: day(s.completedAt) })),
      handoverPhotos: file.handoverPhotos.length,
      // The Suppliers module off: no supplier is named, and supplier papers are asked for by type alone.
      ...(file.suppliersOn
        ? {
            suppliers: file.declaredVendors.map((v) => ({ supplier: v.name, kind: vendorKindLabel(v.kind) })),
            missingFromSuppliers: missing.filter((item) => item.supplier?.vendorId).map((item) => item.label),
          }
        : {}),
    }],
  };
}

/* ── suppliers ───────────────────────────────────────────────────────────── */

/** As Settings → Suppliers decides it (requireTenantOwner): an install owner, or this workspace's owner. */
async function isWorkspaceOwner(user: PermissionUser, tenantId: string): Promise<boolean> {
  if (user.role === "owner") return true;
  return (await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { ownerUserId: true } }))?.ownerUserId === user.id;
}

export async function suppliersLookup(user: PermissionUser, args: { supplier?: string; missing?: boolean; orders?: boolean }): Promise<Output> {
  if (!(await isModuleEnabled("suppliers"))) return unavailable("Suppliers are switched off in this workspace.");
  const tenantId = ownedWriteTenantId();
  if (!(await isWorkspaceOwner(user, tenantId))) return unavailable("Only the workspace owner can see suppliers (as on Settings → Suppliers).");
  const vendors = await prisma.vendor.findMany({
    where: { tenantId, deletedAt: null, ...(args.supplier ? { name: fuzzy(args.supplier) } : {}) },
    orderBy: { name: "asc" },
    take: 25,
    // No bank details or payment reference: name, kind, how to reach them, terms, and what is on file.
    select: {
      id: true, name: true, kind: true, phone: true, email: true, paymentTerms: true,
      _count: { select: { documents: { where: { deletedAt: null } }, deals: true, purchaseOrders: { where: { deletedAt: null } } } },
    },
  });
  if (args.supplier && !vendors.length) return unavailable(`No supplier matches "${args.supplier}".`);
  const named = args.supplier ? vendors.slice(0, 3) : [];
  const orders = args.orders || named.length
    ? await Promise.all((args.orders && !args.supplier ? vendors.slice(0, 5) : named).map(async (v) => ({
        supplier: v.name,
        orders: (await vendorPurchaseOrders(tenantId, v.id)).slice(0, 10).map((o) => ({
          reference: o.reference, status: o.status, ordered: day(o.orderedAt), expected: day(o.expectedAt), units: o._count.units,
        })),
      })))
    : [];
  let missing: { quote: string; customer: string; link: string; missing: string[] }[] | undefined;
  if (args.missing || named.length) {
    // The weekly digest's own rule, narrowed to the deals this person may open — and to the supplier asked about.
    const open = await getAccessibleQuoteIds(user);
    const names = named.map((v) => v.name.toLowerCase());
    missing = (await missingSupplierPapers(tenantId))
      .filter((d) => open === null || open.includes(d.href.split("/").pop() ?? ""))
      .map((d) => ({ quote: `Q-${d.quoteNumber}`, customer: d.customer, link: d.href, missing: names.length ? d.missing.filter((m) => names.some((n) => m.toLowerCase().includes(n))) : d.missing }))
      .filter((d) => d.missing.length)
      .slice(0, 25);
  }
  return {
    truncated: vendors.length === 25,
    rows: vendors.slice(0, 10).map((v) => ({ label: v.name, detail: `${vendorKindLabel(v.kind)} · ${v._count.deals} deal(s) · ${v._count.purchaseOrders} order(s)`, href: "/settings/vendors" })),
    data: [{
      suppliers: vendors.map((v) => ({
        supplier: v.name, kind: vendorKindLabel(v.kind), phone: v.phone, email: v.email, paymentTerms: v.paymentTerms,
        deals: v._count.deals, papersOnFile: v._count.documents, purchaseOrders: v._count.purchaseOrders,
      })),
      ...(orders.length ? { orders } : {}),
      ...(missing ? { dealsMissingSupplierPapers: missing } : {}),
    }],
  };
}
