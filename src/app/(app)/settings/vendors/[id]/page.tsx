import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenantOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { StatusPill, Surface } from "@/components/visual-system";
import ConfirmDelete from "@/components/ConfirmDelete";
import VendorFields from "@/components/VendorFields";
import { saveVendor, deleteVendor } from "@/app/actions/vendors";
import { vendorKindLabel } from "@/lib/vendors";
import { SUPPLIER_DOCUMENT_TYPES } from "@/lib/dealFile";
import { vendorPurchaseOrders } from "@/lib/dealFileData";
import { contactName, formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * One supplier: its details, every deal it is on with what is still outstanding from it, its documents and its
 * purchase orders. Owner only, like the list.
 */
export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTenantOwner();
  const tenantId = await actingTenantId();
  const vendor = await prisma.vendor.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!vendor) notFound();

  const [links, documents, orders] = await Promise.all([
    prisma.dealVendor.findMany({ where: { tenantId, vendorId: id }, select: { leadId: true, quoteId: true } }),
    prisma.document.findMany({
      where: { tenantId, vendorId: id, deletedAt: null, replacedById: null },
      select: { id: true, fileName: true, tag: true, quoteId: true, createdAt: true, uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    vendorPurchaseOrders(tenantId, id),
  ]);

  // Its deals: declared on the deal, or named on a document filed there. A deal is its lead (every quote on it),
  // or a quote with no lead.
  const leadIds = links.flatMap((link) => (link.leadId ? [link.leadId] : []));
  const quoteIds = [...links.flatMap((link) => (link.quoteId ? [link.quoteId] : [])), ...documents.flatMap((doc) => (doc.quoteId ? [doc.quoteId] : []))];
  const quotes = leadIds.length || quoteIds.length
    ? await prisma.quote.findMany({
        where: { tenantId, deletedAt: null, OR: [{ leadId: { in: leadIds } }, { id: { in: quoteIds } }] },
        select: {
          id: true, number: true, status: true, leadId: true, supersededAt: true, createdAt: true,
          lead: { select: { name: true, title: true } },
          contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  // A deal named only through one of its quotes still gathers all of that lead's quotes.
  const moreLeadIds = [...new Set(quotes.flatMap((quote) => (quote.leadId && !leadIds.includes(quote.leadId) ? [quote.leadId] : [])))];
  const siblings = moreLeadIds.length
    ? await prisma.quote.findMany({
        where: { tenantId, deletedAt: null, leadId: { in: moreLeadIds }, NOT: { id: { in: quotes.map((quote) => quote.id) } } },
        select: { id: true, number: true, status: true, leadId: true, supersededAt: true, createdAt: true, lead: { select: { name: true, title: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
      })
    : [];
  const groups = new Map<string, typeof quotes>();
  for (const quote of [...quotes, ...siblings]) {
    const key = quote.leadId ?? quote.id;
    groups.set(key, [...(groups.get(key) ?? []), quote]);
  }
  const deals = [...groups.values()].map((dealQuotes) => {
    const sorted = [...dealQuotes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const open = sorted.find((quote) => !quote.supersededAt) ?? sorted[0];
    const ids = new Set(sorted.map((quote) => quote.id));
    const filed = documents.filter((doc) => doc.quoteId && ids.has(doc.quoteId));
    const missing = SUPPLIER_DOCUMENT_TYPES.filter((type) => !filed.some((doc) => (doc.tag ?? "").toLowerCase() === type.toLowerCase()));
    const who = open.contact ? contactName(open.contact) : open.lead?.name ?? open.lead?.title ?? "Customer";
    return { href: `/deals/${open.id}`, label: `Q-${open.number} · ${who}`, status: open.status, missing, filed: filed.length };
  });
  const outstanding = deals.filter((deal) => deal.missing.length > 0);
  const quoteNumber = new Map([...quotes, ...siblings].map((quote) => [quote.id, quote.number]));

  return (
    <SettingsWorkspace current="vendors" title={vendor.name} description={`${vendorKindLabel(vendor.kind)} · Settings → Suppliers`} groups={SETTINGS_NAV_GROUPS}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <Surface className="p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Deals</h2>
              <StatusPill tone={outstanding.length ? "warning" : "success"}>{outstanding.length ? `${outstanding.length} waiting on papers` : "Nothing outstanding"}</StatusPill>
            </div>
            {deals.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Not on any deal yet. Add it on a deal&apos;s page, under Suppliers on this deal.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/70">
                {[...outstanding, ...deals.filter((deal) => !deal.missing.length)].map((deal) => (
                  <li key={deal.href}>
                    <Link href={deal.href} className="flex flex-wrap items-center gap-3 rounded-lg px-1 py-2 text-sm hover:bg-muted/30">
                      <span className="min-w-0 flex-1 truncate font-medium">{deal.label}</span>
                      <span className="text-xs text-muted-foreground">{deal.missing.length ? `Missing: ${deal.missing.join(", ")}` : "All three on file"}</span>
                      <StatusPill tone="neutral">{deal.status}</StatusPill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface className="p-4">
            <h2 className="font-semibold">Documents</h2>
            {documents.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None filed yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/70">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <a href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">{doc.tag ?? doc.fileName}</a>
                    <span className="text-xs text-muted-foreground">
                      {[doc.tag ? doc.fileName : null, doc.quoteId && quoteNumber.has(doc.quoteId) ? `Q-${quoteNumber.get(doc.quoteId)}` : null, formatDate(doc.createdAt), doc.uploadedBy.name].filter(Boolean).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface className="p-4">
            <h2 className="font-semibold">Purchase orders</h2>
            {orders.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border/70">
                {orders.map((order) => (
                  <li key={order.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{order.reference || "No reference"}</span>
                    <span className="text-xs text-muted-foreground">
                      {[`${order._count.units} unit${order._count.units === 1 ? "" : "s"}`, `ordered ${formatDate(order.orderedAt)}`, order.expectedAt ? `due ${formatDate(order.expectedAt)}` : null].filter(Boolean).join(" · ")}
                    </span>
                    <StatusPill tone={order.status === "received" ? "success" : order.status === "cancelled" ? "neutral" : "info"}>{order.status.replaceAll("_", " ")}</StatusPill>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">Received on the <Link href="/stock" className="underline">Stock page</Link>.</p>
          </Surface>
        </div>

        <Surface className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Details</h2>
            <ConfirmDelete
              action={deleteVendor.bind(null, vendor.id)}
              title={`Delete supplier “${vendor.name}”?`}
              description="It moves to the Trash and can be restored. Its documents, orders and deals keep naming it."
              triggerClass="btn-secondary btn-sm text-red-300"
            />
          </div>
          <SaveForm action={saveVendor.bind(null, vendor.id)} success="Supplier saved" resetOnSuccess={false} className="mt-3 grid gap-3">
            <VendorFields vendor={vendor} />
            <SaveButton className="btn-primary btn-sm">Save</SaveButton>
          </SaveForm>
          <p className="mt-3 text-xs text-muted-foreground"><Link href="/settings/vendors" className="underline">All suppliers</Link></p>
        </Surface>
      </div>
    </SettingsWorkspace>
  );
}
