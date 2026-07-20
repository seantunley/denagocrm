import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell, CarFront, FileCheck2, Headphones, LogOut } from "lucide-react";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { markPortalNotificationRead, portalLogout } from "@/app/actions/portal";
import ServiceRequestForm from "@/components/ServiceRequestForm";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";
import { computeWarranty, warrantyLabels, warrantyColors } from "@/lib/warranty";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Eyebrow, MetricCard } from "@/components/visual-system";

export const dynamic = "force-dynamic";

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  href: string | null;
  kind: string;
  readAt: Date | null;
  createdAt: Date;
};
type CaseCountRow = { openCount: bigint };

function deliveryLabel(quote: {
  deliveredAt: Date | null;
  deliveryScheduledFor: Date | null;
  signedAt: Date | null;
  status: string;
}) {
  if (quote.deliveredAt) return `Delivered ${formatDate(quote.deliveredAt)}`;
  if (quote.deliveryScheduledFor) return `Delivery scheduled ${formatDate(quote.deliveryScheduledFor)}`;
  if (quote.signedAt) return "Accepted — preparing fulfilment";
  return quote.status;
}

export default async function PortalHome() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const scope = await requirePortalScope();
  // When the automotive pack is switched off the portal must drop all
  // vehicle/service/warranty UI too, even while the portal itself stays on.
  const automotiveOn = await isModuleEnabled("automotive");

  const [accessibleContacts, fleets, vehicles, quotes, notifications, caseCounts] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: scope.contactIds }, deletedAt: null },
      orderBy: [{ company: "asc" }, { firstName: "asc" }],
    }),
    scope.fleetIds.length
      ? prisma.fleet.findMany({
          where: { id: { in: scope.fleetIds }, deletedAt: null },
          include: { vehicles: { where: { deletedAt: null }, select: { id: true } } },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    prisma.vehicle.findMany({
      where: {
        deletedAt: null,
        OR: [
          { contactId: { in: scope.contactIds } },
          ...(scope.fleetIds.length ? [{ fleetId: { in: scope.fleetIds } }] : []),
        ],
      },
      include: {
        contact: true,
        fleet: true,
        serviceRecords: { orderBy: { serviceDate: "desc" } },
        mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
        warrantyClaims: { orderBy: { claimedAt: "desc" }, take: 3 },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.quote.findMany({
      where: { contactId: { in: scope.contactIds }, deletedAt: null, supersededAt: null },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    basePrisma.$queryRaw<NotificationRow[]>`
      SELECT "id", "title", "body", "href", "kind", "readAt", "createdAt"
      FROM "PortalNotification"
      WHERE "contactId" = ${contact.id}
      ORDER BY "createdAt" DESC LIMIT 20
    `,
    basePrisma.$queryRaw<CaseCountRow[]>`
      SELECT COUNT(*) FILTER (WHERE c."status" NOT IN ('closed', 'cancelled')) AS "openCount"
      FROM "CustomerCase" c
      LEFT JOIN "Vehicle" v ON v."id" = c."vehicleId"
      WHERE c."contactId" = ANY(${scope.contactIds}::text[])
         OR (v."fleetId" IS NOT NULL AND v."fleetId" = ANY(${scope.fleetIds}::text[]))
    `,
  ]);

  const unsignedQuotes = quotes.filter((quote) => quote.signToken && !quote.signedAt && quote.status !== "declined");
  const unreadNotifications = notifications.filter((notification) => !notification.readAt).length;

  return (
    <div className="space-y-10">
      <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-br from-white/[0.055] to-white/[0.025] px-5 py-7 shadow-[0_24px_80px_rgba(0,0,0,.22)] sm:px-8 sm:py-9">
        <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-orange-500/[0.09] blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
        <div>
          <Eyebrow>Your Denago garage</Eyebrow>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Hello, {contact.firstName}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">{automotiveOn ? "Everything about your vehicles, service, warranty, quotes and deliveries—kept together and easy to follow." : "Your quotes, documents and support—kept together and easy to follow."}</p>
        </div>
          <form action={portalLogout}><Button variant="outline" size="sm" className="border-white/10 bg-white/[0.035]"><LogOut className="size-3.5" />Sign out</Button></form>
        </div>
      </div>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {automotiveOn && (
          <MetricCard icon={CarFront} label="Vehicles" value={vehicles.length} detail="In your garage" accent />
        )}
        <MetricCard icon={FileCheck2} label="Quotes to review" value={unsignedQuotes.length} detail={unsignedQuotes.length ? "Awaiting your decision" : "You're up to date"} accent={unsignedQuotes.length > 0} />
        <Link href="/portal/support" className="rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-500/15"><MetricCard icon={Headphones} label="Open support" value={Number(caseCounts[0]?.openCount ?? 0)} detail="View conversations" /></Link>
        <MetricCard icon={Bell} label="Unread updates" value={unreadNotifications} detail={unreadNotifications ? "New since your last visit" : "Nothing new"} />
      </section>

      {(accessibleContacts.length > 1 || fleets.length > 0) && (
        <section className="grid md:grid-cols-2 gap-3">
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Portal access</p>
            <ul className="space-y-2">
              {accessibleContacts.map((item) => (
                <li key={item.id} className="text-sm flex justify-between gap-3">
                  <span>{contactName(item)}{item.company && !item.isCompany ? ` · ${item.company}` : ""}</span>
                  <span className="text-slate-500 capitalize">{scope.roleByContactId.get(item.id) ?? "viewer"}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Fleet accounts</p>
            {fleets.length === 0 ? <p className="text-sm text-slate-400">No fleet accounts linked.</p> : (
              <ul className="space-y-2">
                {fleets.map((fleet) => (
                  <li key={fleet.id} className="text-sm flex justify-between gap-3">
                    <span>{fleet.name}</span>
                    <span className="text-slate-500">{fleet.vehicles.length} carts · {scope.roleByFleetId.get(fleet.id) ?? "viewer"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {notifications.length > 0 && (
        <section className="space-y-3">
          <div><Eyebrow>Latest activity</Eyebrow><h2 className="mt-1 text-lg font-semibold">Notifications</h2></div>
          <div className="card p-0 divide-y divide-border">
            {notifications.map((notification) => (
              <div key={notification.id} className={`px-4 py-3 flex gap-3 ${notification.readAt ? "opacity-70" : ""}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{notification.title}</p>
                  <p className="text-sm text-slate-400">{notification.body}</p>
                  <p className="text-xs text-slate-500 mt-1">{formatDateTime(notification.createdAt)}</p>
                </div>
                <div className="flex gap-2 items-start">
                  {notification.href && <Link href={notification.href} className="btn-secondary btn-sm">Open</Link>}
                  {!notification.readAt && <form action={markPortalNotificationRead.bind(null, notification.id)}><button className="btn-secondary btn-sm">Mark read</button></form>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {automotiveOn && (
      <section className="space-y-3">
        <div><Eyebrow>Your garage</Eyebrow><h2 className="mt-1 text-lg font-semibold">Vehicles, service and warranty</h2></div>
        {vehicles.length === 0 ? (
          <div className="card text-sm text-slate-400">No carts are currently available in your portal.</div>
        ) : vehicles.map((vehicle) => {
          const due = computeDue(vehicle);
          const warranty = computeWarranty(vehicle);
          return (
            <div key={vehicle.id} className="card space-y-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-semibold">{vehicle.model}{vehicle.color ? ` · ${vehicle.color}` : ""}</p>
                  <p className="text-xs text-slate-400">{[vehicle.regNumber, vehicle.vin, vehicle.fleet?.name].filter(Boolean).join(" · ") || "—"}</p>
                  <p className="text-xs text-slate-500 mt-1">Registered to {contactName(vehicle.contact)}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <span className={`badge ${dueColors[due.status]}`}>Service: {dueLabels[due.status]}{due.nextDueDate ? ` · ${formatDate(due.nextDueDate)}` : ""}</span>
                  <span className={`badge ${warrantyColors[warranty.status]}`}>{warrantyLabels[warranty.status]}{warranty.expiryDate ? ` · ${formatDate(warranty.expiryDate)}` : ""}</span>
                </div>
              </div>
              {vehicle.serviceRecords.length > 0 && (
                <div className="border-t border-slate-800 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Recent service history</p>
                  <ul className="space-y-1.5">
                    {vehicle.serviceRecords.slice(0, 5).map((record) => (
                      <li key={record.id} className="text-sm flex justify-between gap-3"><span>{record.summary}</span><span className="text-slate-400 shrink-0">{formatDate(record.serviceDate)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {vehicle.warrantyClaims.length > 0 && (
                <div className="border-t border-slate-800 pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Warranty requests</p>
                  <ul className="space-y-1.5">
                    {vehicle.warrantyClaims.map((claim) => <li key={claim.id} className="text-sm flex justify-between gap-3"><span>{claim.description}</span><span className="text-slate-400">{claim.status}</span></li>)}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </section>
      )}

      {quotes.length > 0 && (
        <section className="space-y-3">
        <div><Eyebrow>Purchases</Eyebrow><h2 className="mt-1 text-lg font-semibold">Quotes and delivery</h2></div>
          <div className="card p-0 divide-y divide-border">
            {quotes.map((quote) => {
              const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
              const canSign = quote.signToken && !quote.signedAt && quote.status !== "declined";
              return (
                <div key={quote.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div><p className="text-sm font-medium">Quote Q-{quote.number}</p><p className="text-xs text-slate-400">{formatZAR(Math.round(total))} · {deliveryLabel(quote)}</p></div>
                  {canSign && <a href={`/sign/quote/${quote.signToken}`} className="btn-primary btn-sm">Review & sign</a>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className={`grid gap-4 ${automotiveOn ? "lg:grid-cols-2" : ""}`}>
        {automotiveOn && (
        <div className="space-y-3">
          <div><Eyebrow>Workshop</Eyebrow><h2 className="mt-1 text-lg font-semibold">Book a service</h2></div>
          <div className="card"><ServiceRequestForm vehicles={vehicles.map((vehicle) => ({ id: vehicle.id, label: `${vehicle.model}${vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}` }))} /></div>
        </div>
        )}
        <div className="card flex flex-col justify-between gap-4">
          <div><h2 className="font-semibold">Need help?</h2><p className="text-sm text-slate-400 mt-2">Open a support, warranty, delivery or document request and track the conversation.</p></div>
          <Link href="/portal/support" className="btn-primary text-center">Open support</Link>
        </div>
      </section>

      <p className="text-xs text-slate-500 text-center">Signed in as {contactName(contact)} · {contact.email}</p>
    </div>
  );
}
