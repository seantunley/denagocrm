import { redirect } from "next/navigation";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { getPortalScope } from "@/lib/portalAccess";
import {
  markPortalNotificationRead,
  portalLogout,
  requestPortalProfileChange,
  submitPortalCase,
  submitPortalWarrantyClaim,
  updatePortalPreferences,
  uploadPortalDocument,
} from "@/app/actions/portal";
import ServiceRequestForm from "@/components/ServiceRequestForm";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";
import { computeWarranty, warrantyLabels, warrantyColors, claimColors } from "@/lib/warranty";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";

export const dynamic = "force-dynamic";

type CaseRow = {
  id: string;
  number: bigint;
  subject: string;
  description: string;
  type: string;
  priority: string;
  status: string;
  vehicleId: string | null;
  vehicleModel: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  href: string | null;
  kind: string;
  readAt: Date | null;
  createdAt: Date;
};

type PreferenceRow = {
  emailServiceUpdates: boolean;
  smsServiceUpdates: boolean;
  emailMarketing: boolean;
};

type ProfileRequestRow = { id: string; changes: unknown; status: string; createdAt: Date };

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
  const scope = await getPortalScope();
  if (!contact || !scope) redirect("/portal/login");

  const [accessibleContacts, fleets, vehicles, quotes, communications, notifications, preferences, profileRequests] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: scope.contactIds }, deletedAt: null },
      orderBy: [{ company: "asc" }, { firstName: "asc" }],
    }),
    prisma.fleet.findMany({
      where: { id: { in: scope.fleetIds }, deletedAt: null },
      include: { vehicles: { where: { deletedAt: null }, select: { id: true } } },
      orderBy: { name: "asc" },
    }),
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
        warrantyClaims: { orderBy: { claimedAt: "desc" } },
        documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.quote.findMany({
      where: { contactId: { in: scope.contactIds }, deletedAt: null, supersededAt: null },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.communication.findMany({
      where: { contactId: { in: scope.contactIds } },
      orderBy: { occurredAt: "desc" },
      take: 30,
    }),
    basePrisma.$queryRaw<NotificationRow[]>`
      SELECT "id", "title", "body", "href", "kind", "readAt", "createdAt"
      FROM "PortalNotification"
      WHERE "contactId" = ${contact.id}
      ORDER BY "createdAt" DESC LIMIT 30
    `,
    basePrisma.$queryRaw<PreferenceRow[]>`
      SELECT "emailServiceUpdates", "smsServiceUpdates", "emailMarketing"
      FROM "PortalPreference" WHERE "contactId" = ${contact.id} LIMIT 1
    `,
    basePrisma.$queryRaw<ProfileRequestRow[]>`
      SELECT "id", "changes", "status", "createdAt"
      FROM "PortalProfileChangeRequest"
      WHERE "contactId" = ${contact.id}
      ORDER BY "createdAt" DESC LIMIT 10
    `,
  ]);

  const vehicleIds = vehicles.map((vehicle) => vehicle.id);
  const quoteIds = quotes.map((quote) => quote.id);
  const [cases, sharedDocuments] = await Promise.all([
    basePrisma.$queryRaw<CaseRow[]>`
      SELECT c."id", c."number", c."subject", c."description", c."type", c."priority", c."status",
        c."vehicleId", v."model" AS "vehicleModel", c."createdAt", c."updatedAt"
      FROM "CustomerCase" c
      LEFT JOIN "Vehicle" v ON v."id" = c."vehicleId"
      WHERE c."contactId" = ANY(${scope.contactIds}::text[])
        OR c."vehicleId" = ANY(${vehicleIds}::text[])
      ORDER BY c."createdAt" DESC LIMIT 50
    `,
    prisma.document.findMany({
      where: {
        deletedAt: null,
        OR: [
          { contactId: { in: scope.contactIds } },
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
          ...(quoteIds.length ? [{ quoteId: { in: quoteIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const pref = preferences[0] ?? {
    emailServiceUpdates: true,
    smsServiceUpdates: true,
    emailMarketing: !contact.marketingOptOut,
  };
  const unread = notifications.filter((item) => !item.readAt).length;

  return (
    <div className="space-y-10">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Hello, {contact.firstName}</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Vehicles, service, warranty, support, quotes and documents in one place.
          </p>
        </div>
        <form action={portalLogout}><button className="btn-secondary btn-sm">Sign out</button></form>
      </div>

      {notifications.length > 0 && (
        <section id="notifications" className="space-y-3">
          <h2 className="font-semibold">Notifications {unread > 0 && <span className="badge bg-orange-500/15 text-orange-300 ml-2">{unread} new</span>}</h2>
          <div className="card p-0 divide-y divide-slate-800">
            {notifications.map((item) => (
              <div key={item.id} className={`px-4 py-3 flex gap-3 ${item.readAt ? "opacity-70" : ""}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-sm text-slate-400">{item.body}</p>
                  <p className="text-xs text-slate-500 mt-1">{formatDateTime(item.createdAt)}</p>
                </div>
                <div className="flex gap-2 items-start">
                  {item.href && <a href={item.href} className="btn-secondary btn-sm">Open</a>}
                  {!item.readAt && <form action={markPortalNotificationRead.bind(null, item.id)}><button className="btn-secondary btn-sm">Mark read</button></form>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section id="access" className="space-y-3">
        <h2 className="font-semibold">Your account access</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">People and organisations</p>
            <ul className="space-y-2">{accessibleContacts.map((item) => (
              <li key={item.id} className="text-sm flex justify-between gap-3"><span>{contactName(item)}{item.company && !item.isCompany ? ` · ${item.company}` : ""}</span><span className="text-slate-500 capitalize">{scope.roleByContactId.get(item.id) ?? "viewer"}</span></li>
            ))}</ul>
          </div>
          <div className="card">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Fleet access</p>
            {fleets.length === 0 ? <p className="text-sm text-slate-400">No fleet accounts linked.</p> : <ul className="space-y-2">{fleets.map((fleet) => <li key={fleet.id} className="text-sm flex justify-between"><span>{fleet.name}</span><span className="text-slate-500">{fleet.vehicles.length} carts · {scope.roleByFleetId.get(fleet.id) ?? "viewer"}</span></li>)}</ul>}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Vehicles, service and warranty</h2>
        {vehicles.length === 0 ? <div className="card text-sm text-slate-400">No carts are currently available in your portal.</div> : vehicles.map((vehicle) => {
          const due = computeDue(vehicle);
          const warranty = computeWarranty(vehicle);
          return <div key={vehicle.id} className="card space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div><p className="font-semibold">{vehicle.model}{vehicle.color ? ` · ${vehicle.color}` : ""}</p><p className="text-xs text-slate-400">{[vehicle.regNumber, vehicle.vin, vehicle.fleet?.name].filter(Boolean).join(" · ") || "—"}</p><p className="text-xs text-slate-500 mt-1">Registered to {contactName(vehicle.contact)}</p></div>
              <div className="flex gap-2 flex-wrap"><span className={`badge ${dueColors[due.status]}`}>Service: {dueLabels[due.status]}{due.nextDueDate ? ` · ${formatDate(due.nextDueDate)}` : ""}</span><span className={`badge ${warrantyColors[warranty.status]}`}>{warrantyLabels[warranty.status]}{warranty.expiryDate ? ` · ${formatDate(warranty.expiryDate)}` : ""}</span></div>
            </div>
            {vehicle.serviceRecords.length > 0 && <div className="border-t border-slate-800 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Service history</p><ul className="space-y-1.5">{vehicle.serviceRecords.slice(0, 8).map((record) => <li key={record.id} className="text-sm flex justify-between gap-3"><span>{record.summary}</span><span className="text-slate-400 shrink-0">{formatDate(record.serviceDate)}</span></li>)}</ul></div>}
            {vehicle.warrantyClaims.length > 0 && <div className="border-t border-slate-800 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Warranty requests</p><ul className="space-y-1.5">{vehicle.warrantyClaims.map((claim) => <li key={claim.id} className="text-sm flex justify-between gap-3"><span>{claim.description}</span><span className={`badge ${claimColors[claim.status] ?? "bg-slate-800 text-slate-400"}`}>{claim.status}</span></li>)}</ul></div>}
          </div>;
        })}
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-3"><h2 className="font-semibold">Book a service</h2><div className="card"><ServiceRequestForm vehicles={vehicles.map((vehicle) => ({ id: vehicle.id, label: vehicle.model + (vehicle.regNumber ? ` (${vehicle.regNumber})` : "") }))} /></div></div>
        <div className="space-y-3"><h2 className="font-semibold">Submit a warranty request</h2><form action={submitPortalWarrantyClaim} className="card space-y-3"><select name="vehicleId" className="input" required><option value="">Choose vehicle</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.model}{vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}</option>)}</select><textarea name="description" className="input min-h-28" required placeholder="Describe the fault, symptoms and when it started." /><button className="btn-primary">Submit warranty request</button></form></div>
      </section>

      {quotes.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Quotes and delivery</h2><div className="card p-0 divide-y divide-slate-800">{quotes.map((quote) => {
        const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
        const canSign = quote.signToken && !quote.signedAt && quote.status !== "declined";
        return <div key={quote.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap"><div><p className="text-sm font-medium">Quote Q-{quote.number}</p><p className="text-xs text-slate-400">{formatZAR(Math.round(total))} · {deliveryLabel(quote)}</p></div>{canSign && <a href={`/sign/quote/${quote.signToken}`} className="btn-primary btn-sm">Review & sign</a>}</div>;
      })}</div></section>}

      <section id="cases" className="space-y-3">
        <h2 className="font-semibold">Support cases</h2>
        <div className="grid lg:grid-cols-2 gap-4">
          <form action={submitPortalCase} className="card space-y-3"><select name="type" className="input"><option value="support">General support</option><option value="service">Service question</option><option value="delivery">Delivery question</option><option value="product">Product question</option></select><select name="vehicleId" className="input"><option value="">No specific vehicle</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.model}{vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}</option>)}</select><input name="subject" className="input" required placeholder="Subject" /><textarea name="description" className="input min-h-28" required placeholder="How can we help?" /><button className="btn-primary">Create support case</button></form>
          <div className="card p-0 divide-y divide-slate-800">{cases.length === 0 ? <p className="p-4 text-sm text-slate-400">No support cases yet.</p> : cases.map((item) => <div key={item.id} className="p-4"><div className="flex justify-between gap-3"><p className="text-sm font-medium">Case #{String(item.number)} · {item.subject}</p><span className="badge bg-slate-800 text-slate-300">{item.status}</span></div><p className="text-sm text-slate-400 mt-1">{item.description}</p><p className="text-xs text-slate-500 mt-2">{item.vehicleModel ?? item.type} · {formatDateTime(item.createdAt)}</p></div>)}</div>
        </div>
      </section>

      <section id="documents" className="space-y-3">
        <h2 className="font-semibold">Documents</h2>
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="card p-0 divide-y divide-slate-800">{sharedDocuments.length === 0 ? <p className="p-4 text-sm text-slate-400">No documents available.</p> : sharedDocuments.map((document) => <a key={document.id} href={`/api/files/${document.id}`} className="block px-4 py-3 hover:bg-slate-800/50"><p className="text-sm font-medium">{document.fileName}</p><p className="text-xs text-slate-500">{document.tag ?? document.mimeType} · {formatDate(document.createdAt)}</p></a>)}</div>
          <form action={uploadPortalDocument} encType="multipart/form-data" className="card space-y-3"><p className="text-sm text-slate-400">Upload proof, photos or supporting documents securely. PDF, JPG, PNG, WebP or text; maximum 10 MB.</p><select name="vehicleId" className="input"><option value="">General account document</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.model}{vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}</option>)}</select><input type="file" name="file" className="input" accept="application/pdf,image/png,image/jpeg,image/webp,text/plain" required /><button className="btn-primary">Upload document</button></form>
        </div>
      </section>

      <section id="profile" className="space-y-3">
        <h2 className="font-semibold">Profile and preferences</h2>
        <div className="grid lg:grid-cols-2 gap-4">
          <form action={requestPortalProfileChange} className="card space-y-3"><p className="text-sm text-slate-400">Submit corrected contact or address information for review.</p><div className="grid grid-cols-2 gap-2"><input name="phone" className="input" defaultValue={contact.phone ?? ""} placeholder="Phone" /><input name="whatsapp" className="input" defaultValue={contact.whatsapp ?? ""} placeholder="WhatsApp" /></div><input name="address" className="input" defaultValue={contact.address ?? ""} placeholder="Street / estate / unit" /><div className="grid grid-cols-2 gap-2"><input name="suburb" className="input" defaultValue={contact.suburb ?? ""} placeholder="Suburb" /><input name="city" className="input" defaultValue={contact.city ?? ""} placeholder="City" /><input name="province" className="input" defaultValue={contact.province ?? ""} placeholder="Province" /><input name="postalCode" className="input" defaultValue={contact.postalCode ?? ""} placeholder="Postal code" /></div><textarea name="note" className="input" placeholder="Optional note" /><button className="btn-primary">Request profile update</button>{profileRequests.length > 0 && <p className="text-xs text-slate-500">Latest request: {profileRequests[0].status} · {formatDateTime(profileRequests[0].createdAt)}</p>}</form>
          <form action={updatePortalPreferences} className="card space-y-4"><p className="text-sm text-slate-400">Choose how Denago Cape Town may contact you.</p><label className="flex gap-2 items-center text-sm"><input type="checkbox" name="emailServiceUpdates" defaultChecked={pref.emailServiceUpdates} />Email service and warranty updates</label><label className="flex gap-2 items-center text-sm"><input type="checkbox" name="smsServiceUpdates" defaultChecked={pref.smsServiceUpdates} />SMS service and warranty updates</label><label className="flex gap-2 items-center text-sm"><input type="checkbox" name="emailMarketing" defaultChecked={pref.emailMarketing} />Marketing emails and offers</label><button className="btn-primary">Save preferences</button></form>
        </div>
      </section>

      {communications.length > 0 && <section className="space-y-3"><h2 className="font-semibold">Recent messages and activity</h2><div className="card p-0 divide-y divide-slate-800">{communications.map((message) => <div key={message.id} className="px-4 py-3"><div className="flex justify-between gap-3"><p className="text-sm font-medium">{message.subject ?? message.type}</p><span className="text-xs text-slate-500">{formatDateTime(message.occurredAt)}</span></div><p className="text-sm text-slate-400 mt-1 whitespace-pre-wrap">{message.body.slice(0, 500)}</p></div>)}</div></section>}

      <p className="text-xs text-slate-500 text-center">Signed in as {contactName(contact)} · {contact.email}</p>
    </div>
  );
}
