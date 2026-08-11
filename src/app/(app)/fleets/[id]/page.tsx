import Link from "next/link";
import { notFound } from "next/navigation";
import { hasAnyPermission, requireRoute } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { computeWarranty, warrantyColors, warrantyLabels } from "@/lib/warranty";
import { isModuleEnabled } from "@/lib/modules/enabled";
import {
  updateFleet,
  updateFleetBusiness,
  deleteFleet,
  assignVehicleToFleet,
  removeVehicleFromFleet,
} from "@/app/actions/fleets";
import { createQuoteForFleet } from "@/app/actions/quotes";
import { payableTotalCents } from "@/lib/pricing";
import { DEFAULT_FLEET_TYPE, FLEET_TYPES, FLEET_TYPE_LABELS, fleetTypeLabel } from "@/lib/fleetTypes";
import { latestConsentPerMember, loadFleetRollup } from "@/lib/fleetRollup";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import ActivityPanel from "@/components/ActivityPanel";
import CommsTimeline from "@/components/CommsTimeline";
import ConfirmDelete from "@/components/ConfirmDelete";
import DocumentsPanel from "@/components/DocumentsPanel";
import Tabs from "@/components/Tabs";
import { SaveForm, SaveButton } from "@/components/SaveForm";

export const dynamic = "force-dynamic";

export default async function FleetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Same guard as the fleets list and as every fleet server action:
  // routeAccess.ts gives `/fleets` anyOf ["fleets.view", "fleets.manage"]. This
  // page is a fleet screen, so it is guarded like one — not owner-only (which
  // would hide a customer account from the staff who work it) and not merely
  // signed-in (which is no guard at all).
  const user = await requireRoute("/fleets");
  const { id } = await params;
  // Referrals are a marketing-module surface on the contact page and stay one
  // here, so the tab and its query disappear together when the module is off.
  //
  // `canCreateContacts` gates the "+ Contact" button on the Contacts tab. Reaching
  // this page needs fleets.view/fleets.manage; CREATING a contact needs
  // contacts.create, which is a different grant that a fleet viewer need not hold.
  // Offering the button to everyone reproduces the exact defect an open PR is
  // fixing elsewhere in this app — a link rendered on one permission, leading
  // somewhere guarded by another, whose only outcome is a bounce.
  const [marketingOn, canCreateContacts, canCreateQuotes] = await Promise.all([
    isModuleEnabled("marketing"),
    hasAnyPermission(user, "contacts.create"),
    // Same reasoning as canCreateContacts: reaching this page needs fleets.view,
    // raising a quote needs quotes.create, and they are different grants.
    hasAnyPermission(user, "quotes.create"),
  ]);

  // EVERY query on this page names the tenant. The db.ts guard scopes nothing
  // while enforcement is off — the state production runs in — so a lookup by id
  // alone would resolve another workspace's fleet from a guessed URL, and the
  // aggregated tabs below would then pool that workspace's customers,
  // activities, leads, messages and documents onto the page. Strict equality: a
  // legacy NULL-tenant row is un-owned and matching it would reopen the hole the
  // moment enforcement is switched on. findFirst rather than findUnique because
  // the predicate is a plain filter alongside the id, not part of a unique key.
  const tenant = activeTenantPredicate("Fleet detail");
  const fleet = await prisma.fleet.findFirst({
    where: { id, ...tenant },
    include: {
      vehicles: {
        include: {
          contact: true,
          serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
          mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
        },
        orderBy: { model: "asc" },
      },
    },
  });
  if (!fleet) notFound();

  const [rollup, contacts, unassigned, staff] = await Promise.all([
    // The fleet's MEMBERS and every record they carry — the union that makes
    // this page "the same records as a contact". One helper so the tenant
    // predicate is stated once for all eight queries instead of eight times.
    loadFleetRollup(prisma, fleet.id, { includeReferrals: marketingOn }),
    prisma.contact.findMany({
      where: { deletedAt: null, ...tenant },
      select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
      orderBy: { firstName: "asc" },
      take: 500,
    }),
    prisma.vehicle.findMany({
      where: { fleetId: null, ...tenant },
      include: { contact: true },
      orderBy: { model: "asc" },
      take: 500,
    }),
    listActingTenantStaff(),
  ]);

  const { members, activities, leads, communications, researchNotes, referrals, documents, quotes } = rollup;
  // Attribution for every aggregated row. A pooled feed with no "whose?" cannot
  // be acted on — it is a list of things that happened to nobody in particular.
  const nameOf = new Map(members.map((member) => [member.id, contactName(member)]));
  const labelFor = (contactId: string | null) => (contactId ? nameOf.get(contactId) ?? null : null);

  const primary = fleet.contactId ? contacts.find((c) => c.id === fleet.contactId) : null;
  // Who a new quote is addressed to. The manager if there is one, otherwise the
  // first member — createQuoteForFleet requires one or the other and re-checks
  // it server-side, so this only decides which valid option the button offers.
  const quoteRecipient = members.find((member) => member.id === fleet.contactId) ?? members[0] ?? null;
  const consent = latestConsentPerMember(rollup.consentRecords);

  const dues = fleet.vehicles.map((v) => computeDue(v));
  const dueCount = dues.filter((d) => d.status === "overdue" || d.status === "due_soon").length;
  const inWarranty = fleet.vehicles.filter((v) => computeWarranty(v).status === "active").length;
  const plannedCount = activities.filter((activity) => activity.status === "planned").length;
  const path = `/fleets/${fleet.id}`;

  const businessDetails: [string, string | null][] = [
    ["Registration number", fleet.registrationNumber],
    ["VAT number", fleet.vatNumber],
    ["Billing email", fleet.billingEmail],
    ["Billing phone", fleet.billingPhone],
    [
      "Address",
      [fleet.address, fleet.suburb, fleet.city, fleet.province, fleet.postalCode]
        .filter(Boolean)
        .join(", ") || null,
    ],
  ];
  const hasBusinessDetails = businessDetails.some(([, value]) => value);

  /** Said on every aggregate tab that is empty only because nobody is linked yet. */
  const noMembersYet = members.length === 0;
  const emptyBecause = (nothingFiled: string) =>
    noMembersYet ? "Link contacts to this fleet to see their records here." : nothingFiled;

  return (
    <EntityDetailShell
      backHref="/fleets"
      backLabel="Fleets"
      eyebrow="Fleet account"
      title={fleet.name}
      status={
        fleet.type ? <StatusPill tone="info">{fleetTypeLabel(fleet.type)}</StatusPill> : undefined
      }
      description={
        primary ? (
          <>
            Primary contact:{" "}
            <Link href={`/contacts/${primary.id}`} className="text-primary hover:underline">
              {contactName(primary)}
            </Link>
          </>
        ) : (
          "No primary contact assigned"
        )
      }
      meta={
        [
          fleet.registrationNumber ? `Reg ${fleet.registrationNumber}` : null,
          fleet.vatNumber ? `VAT ${fleet.vatNumber}` : null,
          `added ${formatDateTime(fleet.createdAt)}`,
        ]
          .filter(Boolean)
          .join(" · ")
      }
      facts={[
        { label: "Vehicles", value: fleet.vehicles.length },
        { label: "Contacts", value: members.length },
        { label: "Due for service", value: dueCount },
        { label: "In warranty", value: inWarranty },
      ]}
      actions={
        <ConfirmDelete
          action={deleteFleet.bind(null, fleet.id)}
          title={`Delete fleet ${fleet.name}?`}
          description="The fleet moves to the Trash. Its carts and contacts are kept — they simply stop being linked to it."
        />
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Carts</p>
          <p className="text-3xl font-bold mt-1">{fleet.vehicles.length}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Due for service</p>
          <p className="text-3xl font-bold mt-1 text-amber-300">{dueCount}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">In warranty</p>
          <p className="text-3xl font-bold mt-1 text-emerald-300">{inWarranty}</p>
        </div>
      </div>

      {/*
        The SAME tab set a contact has — Details, Activities, Vehicles, Leads,
        Communications, Research, Referrals, Documents, Privacy — plus Contacts,
        which is the one a fleet has and a person does not. Every tab after
        Details is the union of the linked contacts' records; the fleet itself
        owns only its business details and its carts.

        These panels are all READ-ONLY roll-ups. A new activity, message,
        document or research note belongs to a person, and this page is not one:
        filing it here would attach it to nothing. The create forms are therefore
        dropped rather than pointed at an arbitrary member, and each tab says
        where to go instead.
      */}
      <Tabs
        tabs={[
          {
            key: "details",
            label: "Details",
            content: (
              <div className="grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-4">
                  <div className="card">
                    <h2 className="font-semibold mb-3">Business details</h2>
                    {hasBusinessDetails ? (
                      <dl className="space-y-2 text-sm max-w-xl">
                        {businessDetails
                          .filter(([, value]) => value)
                          .map(([label, value]) => (
                            <div key={label} className="flex justify-between gap-4">
                              <dt className="text-slate-400 shrink-0">{label}</dt>
                              <dd className="text-right font-medium">{value}</dd>
                            </div>
                          ))}
                      </dl>
                    ) : (
                      <p className="text-sm text-slate-400">
                        No business details captured yet. A fleet is the entity a quote or invoice is
                        addressed to — its registration, VAT and billing address belong here rather
                        than on the manager&apos;s personal contact record.
                      </p>
                    )}
                    <form
                      action={updateFleetBusiness.bind(null, fleet.id)}
                      className="mt-4 grid gap-2 sm:grid-cols-2 border-t border-slate-800 pt-4"
                    >
                      <div>
                        <label className="label">Registration number</label>
                        <input name="registrationNumber" className="input" defaultValue={fleet.registrationNumber ?? ""} placeholder="e.g. 2019/123456/07" />
                      </div>
                      <div>
                        <label className="label">VAT number</label>
                        <input name="vatNumber" className="input" defaultValue={fleet.vatNumber ?? ""} placeholder="e.g. 4123456789" />
                      </div>
                      <div>
                        <label className="label">Billing email</label>
                        <input name="billingEmail" type="email" className="input" defaultValue={fleet.billingEmail ?? ""} placeholder="accounts@example.com" />
                      </div>
                      <div>
                        <label className="label">Billing phone</label>
                        <input name="billingPhone" type="tel" className="input" defaultValue={fleet.billingPhone ?? ""} />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="label">Street address</label>
                        <input name="address" className="input" defaultValue={fleet.address ?? ""} placeholder="e.g. 12 Fairway Drive" />
                      </div>
                      <div>
                        <label className="label">Suburb</label>
                        <input name="suburb" className="input" defaultValue={fleet.suburb ?? ""} />
                      </div>
                      <div>
                        <label className="label">City / town</label>
                        <input name="city" className="input" defaultValue={fleet.city ?? ""} />
                      </div>
                      <div>
                        <label className="label">Province</label>
                        <input name="province" className="input" defaultValue={fleet.province ?? ""} />
                      </div>
                      <div>
                        <label className="label">Postal code</label>
                        <input name="postalCode" className="input" inputMode="numeric" defaultValue={fleet.postalCode ?? ""} />
                      </div>
                      <div className="sm:col-span-2">
                        <button className="btn-secondary btn-sm">Save business details</button>
                      </div>
                    </form>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="card">
                    <h2 className="font-semibold mb-3">Fleet details</h2>
                    <form action={updateFleet.bind(null, fleet.id)} className="space-y-2">
                      <input name="name" className="input" defaultValue={fleet.name} />
                      <select name="type" className="input" defaultValue={fleet.type ?? DEFAULT_FLEET_TYPE}>
                        {FLEET_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {FLEET_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                      <select name="contactId" className="input" defaultValue={fleet.contactId ?? ""}>
                        <option value="">Primary contact (optional)…</option>
                        {contacts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {contactName(c)}
                          </option>
                        ))}
                      </select>
                      <textarea name="notes" className="input" rows={2} defaultValue={fleet.notes ?? ""} placeholder="Notes" />
                      <button className="btn-secondary btn-sm">Save</button>
                    </form>
                    <p className="mt-2 text-xs text-muted-foreground">
                      The primary contact is the fleet manager — the one person you phone. Everyone
                      covered by the account is on the Contacts tab.
                    </p>
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "contacts",
            label: "Contacts",
            count: members.length,
            content: (
              <div className="card p-0 overflow-x-auto">
                <div className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <h2 className="font-semibold">Fleet contacts</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Everyone linked to this fleet. Add one by creating a contact of type
                      &ldquo;Fleet&rdquo; and choosing this account.
                    </p>
                  </div>
                  {canCreateContacts && (
                    <Link href="/contacts/new" className="btn-secondary btn-sm shrink-0">+ Contact</Link>
                  )}
                </div>
                {noMembersYet ? (
                  <p className="px-4 pb-5 text-sm text-slate-400">
                    No contacts linked to this fleet yet.
                  </p>
                ) : (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Contact</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th>Owner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>
                            <Link href={`/contacts/${member.id}`} className="font-medium text-orange-400 hover:underline">
                              {contactName(member)}
                            </Link>
                            {member.id === fleet.contactId && (
                              <span className="ml-2 align-middle"><StatusPill tone="info">Primary</StatusPill></span>
                            )}
                          </td>
                          <td className="text-slate-400">{member.email ?? "—"}</td>
                          <td className="text-slate-400">{member.phone ?? "—"}</td>
                          <td className="text-slate-400">{member.owner?.name ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ),
          },
          {
            key: "activities",
            label: "Activities",
            count: plannedCount,
            content: (
              <div className="space-y-3">
                <ActivityPanel
                  activities={activities.map((activity) => ({
                    id: activity.id,
                    type: activity.type,
                    category: activity.category,
                    summary: activity.summary,
                    note: activity.note,
                    location: activity.location,
                    dueDate: activity.dueDate,
                    status: activity.status,
                    assignedTo: activity.assignedTo,
                    contactLabel: labelFor(activity.contactId),
                  }))}
                  users={staff}
                  currentUserId={user.id}
                  revalidate={path}
                  hideCreate
                />
                <p className="text-xs text-muted-foreground">
                  Activities for every contact linked to this fleet. Schedule new ones from the
                  contact they concern.
                </p>
              </div>
            ),
          },
          {
            key: "vehicles",
            label: "Vehicles",
            count: fleet.vehicles.length,
            content: (
              <div className="grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-4">
                  {/* FLEET-OWNED carts only (Vehicle.fleetId), which is how the
                      business thinks about a fleet: the estate's own carts, the
                      ones it is invoiced for and whose service is its problem. A
                      member's personally-owned cart stays on that person's
                      contact page — pooling the two would silently put private
                      vehicles onto the account's service and warranty counts. */}
                  <div className="card p-0 overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Cart</th>
                          <th>Owner / contact</th>
                          <th>Service</th>
                          <th>Warranty</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleet.vehicles.length === 0 && (
                          <tr>
                            <td colSpan={5} className="text-center text-slate-400 py-8">
                              No carts in this fleet yet — add some on the right.
                            </td>
                          </tr>
                        )}
                        {fleet.vehicles.map((v) => {
                          const due = computeDue(v);
                          const w = computeWarranty(v);
                          return (
                            <tr key={v.id}>
                              <td>
                                <Link href={`/vehicles/${v.id}`} className="text-orange-400 hover:underline font-medium">
                                  {v.model}
                                </Link>
                                {v.regNumber && <span className="text-slate-500 text-xs ml-1">{v.regNumber}</span>}
                              </td>
                              <td>{contactName(v.contact)}</td>
                              <td>
                                <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                              </td>
                              <td>
                                <span className={`badge ${warrantyColors[w.status]}`}>{warrantyLabels[w.status]}</span>
                              </td>
                              <td className="text-right">
                                <form action={removeVehicleFromFleet.bind(null, v.id, fleet.id)}>
                                  <button className="text-xs text-red-400 hover:text-red-300">Remove</button>
                                </form>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="card">
                    <h2 className="font-semibold mb-3">Add a cart</h2>
                    <form action={assignVehicleToFleet.bind(null, fleet.id)} className="flex gap-2">
                      <select name="vehicleId" className="input flex-1" required defaultValue="">
                        <option value="" disabled>
                          Select a cart…
                        </option>
                        {unassigned.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.model} — {contactName(v.contact)}
                          </option>
                        ))}
                      </select>
                      <button className="btn-primary btn-sm">Add</button>
                    </form>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Only carts not already in a fleet are listed. Carts owned privately by a fleet
                      contact stay on that contact.
                    </p>
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "leads",
            label: "Leads",
            count: leads.length,
            content: (
              <div className="card">
                <h2 className="font-semibold mb-3">Leads across this fleet</h2>
                {leads.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    {emptyBecause("No leads linked to this fleet's contacts.")}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {leads.map((lead) => (
                      <li key={lead.id} className="flex items-center gap-2">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="text-sm font-medium text-orange-400 hover:underline flex-1 truncate"
                        >
                          {lead.title}
                        </Link>
                        <span className="text-xs text-slate-500 truncate max-w-[9rem]">
                          {labelFor(lead.contactId) ?? ""}
                        </span>
                        <span className="text-xs text-slate-400">{formatZAR(lead.valueCents)}</span>
                        <span
                          className={`badge ${
                            lead.status === "won"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : lead.status === "lost"
                              ? "bg-red-500/15 text-red-300"
                              : "bg-slate-800 text-slate-400"
                          }`}
                        >
                          {lead.status === "open" ? lead.stage.name : lead.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          },
          {
            key: "quotes",
            label: "Quotes",
            count: quotes.length,
            content: (
              <div className="card p-0 overflow-x-auto">
                <div className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <h2 className="font-semibold">Quotes for this account</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Quotes billed to {fleet.name} — addressed to the account, with its
                      registration and VAT numbers — plus quotes filed against its contacts.
                    </p>
                  </div>
                  {/*
                    Gated on the pair the action itself enforces: quotes.create,
                    and a contact to address the quote to. Offering the button
                    without either is a control whose only outcome is a refusal —
                    the nav/guard disagreement this codebase has been removing
                    everywhere else.
                  */}
                  {canCreateQuotes && quoteRecipient && (
                    // SaveForm, not a bare <form>: createQuoteForFleet returns its
                    // refusals as VALUES rather than throwing, because Next replaces
                    // a thrown server-action message with an opaque digest in
                    // production — and "add them to the fleet first" is the whole
                    // point of that message. It also navigates on the returned
                    // redirectTo instead of inferring success from a throw.
                    <SaveForm success="Quote created" resetOnSuccess={false} action={createQuoteForFleet}>
                      <input type="hidden" name="fleetId" value={fleet.id} />
                      <input type="hidden" name="contactId" value={quoteRecipient.id} />
                      <SaveButton className="btn-secondary btn-sm shrink-0">+ Quote</SaveButton>
                    </SaveForm>
                  )}
                </div>
                {quotes.length === 0 ? (
                  <p className="px-4 pb-5 text-sm text-slate-400">
                    {canCreateQuotes && !quoteRecipient
                      ? "Link a contact to this fleet first — a quote is addressed to a person at the account."
                      : "No quotes for this account yet."}
                  </p>
                ) : (
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Quote</th>
                        <th>Billed to</th>
                        <th>Attention</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>Raised</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map((quote) => (
                        <tr key={quote.id}>
                          <td>
                            <Link href={`/quotes/${quote.id}`} className="font-medium text-orange-400 hover:underline">
                              Q-{quote.number}
                            </Link>
                          </td>
                          {/* The distinction the column exists to make: a quote
                              billed TO the account, versus one that belongs to a
                              person who happens to work there. */}
                          <td className="text-slate-400">
                            {quote.fleetId === fleet.id ? fleet.name : labelFor(quote.contactId) ?? "—"}
                          </td>
                          <td className="text-slate-400">{labelFor(quote.contactId) ?? "—"}</td>
                          <td className="text-slate-400">{formatZAR(payableTotalCents(quote))}</td>
                          <td>
                            <StatusPill
                              tone={
                                quote.status === "accepted"
                                  ? "success"
                                  : quote.status === "declined"
                                    ? "danger"
                                    : quote.status === "sent"
                                      ? "info"
                                      : "neutral"
                              }
                            >
                              {quote.status}
                            </StatusPill>
                          </td>
                          <td className="text-slate-400">{formatDate(quote.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ),
          },
          {
            key: "comms",
            label: "Communications",
            count: communications.length,
            content: (
              <div className="space-y-3">
                <CommsTimeline
                  communications={communications.map((communication) => ({
                    ...communication,
                    ownerLabel: labelFor(communication.contactId),
                  }))}
                  revalidate={path}
                  hideCreate
                  emptyText={emptyBecause("No communications logged with this fleet's contacts.")}
                />
                <p className="text-xs text-muted-foreground">
                  Every call, email and message with anyone at this fleet. Send or log a new one
                  from the contact it concerns — an email needs a person to address it to.
                </p>
              </div>
            ),
          },
          {
            key: "research",
            label: "Research",
            count: researchNotes.length,
            content: (
              <div className="card space-y-4">
                <h2 className="font-semibold">🔎 AI research</h2>
                {researchNotes.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    {emptyBecause(
                      "No research yet. Generate a briefing from a contact's own page and it appears here.",
                    )}
                  </p>
                ) : (
                  <ul className="space-y-4">
                    {researchNotes.map((note) => (
                      <li key={note.id} className="border-t border-slate-800 pt-4 first:border-0 first:pt-0">
                        <p className="text-xs text-slate-500 mb-1.5">
                          {formatDateTime(note.createdAt)}
                          {labelFor(note.contactId) ? ` · ${labelFor(note.contactId)}` : ""}
                        </p>
                        <p className="text-sm whitespace-pre-wrap leading-relaxed text-slate-200">
                          {note.body}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          },
          // Marketing off → no tab and no query, exactly as on the contact page.
          ...(marketingOn
            ? [
                {
                  key: "referrals",
                  label: "Referrals",
                  count: referrals.length,
                  content: (
                    <div className="card p-0">
                      <div className="p-4">
                        <h2 className="font-semibold">Referrals from this fleet</h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Everyone this fleet&apos;s contacts have referred. A referral code belongs
                          to a person, so share or redeem one from their own page.
                        </p>
                      </div>
                      {referrals.length === 0 ? (
                        <p className="px-4 pb-5 text-sm text-slate-400">
                          {emptyBecause("Nobody at this fleet has referred anyone yet.")}
                        </p>
                      ) : (
                        <ul className="divide-y divide-slate-800">
                          {referrals.map((referral) => (
                            <li key={referral.id} className="px-4 py-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                                  {referral.lead ? (
                                    <Link href={`/leads/${referral.lead.id}`} className="text-orange-400 hover:underline">
                                      {referral.lead.name}
                                    </Link>
                                  ) : referral.contact ? (
                                    <Link href={`/contacts/${referral.contact.id}`} className="text-orange-400 hover:underline">
                                      {contactName(referral.contact)}
                                    </Link>
                                  ) : (
                                    "Referred lead"
                                  )}
                                  <span className="text-xs text-slate-500">
                                    {" "}· {formatDate(referral.createdAt)} · referred by{" "}
                                    {nameOf.get(referral.referrerId) ?? "a fleet contact"}
                                  </span>
                                </span>
                                <span
                                  className={`badge ${
                                    referral.status === "redeemed"
                                      ? "bg-emerald-500/15 text-emerald-300"
                                      : referral.status === "earned"
                                      ? "bg-amber-500/15 text-amber-300"
                                      : "bg-slate-800 text-slate-300"
                                  }`}
                                >
                                  {referral.status === "earned" ? "fee due" : referral.status}
                                </span>
                              </div>
                              {referral.redeemedNote && (
                                <p className="text-xs text-slate-500 mt-1">🎁 {referral.redeemedNote}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ),
                },
              ]
            : []),
          {
            key: "documents",
            label: "Documents",
            count: documents.length,
            content: (
              <div className="space-y-3">
                <DocumentsPanel
                  documents={documents.map((document) => ({
                    id: document.id,
                    fileName: document.fileName,
                    sizeBytes: document.sizeBytes,
                    createdAt: document.createdAt,
                    tag: document.tag,
                    uploadedBy: document.uploadedBy,
                    ownerLabel: labelFor(document.contactId),
                  }))}
                  revalidate={path}
                  hideUpload
                  emptyText={emptyBecause("No documents filed against this fleet's contacts.")}
                />
                <p className="text-xs text-muted-foreground">
                  Paperwork filed against every contact linked to this fleet. Upload from the
                  contact it belongs to.
                </p>
              </div>
            ),
          },
          {
            key: "privacy",
            label: "Privacy",
            content: (
              <div className="card">
                <h2 className="font-semibold mb-1">Consent &amp; data (POPIA)</h2>
                <p className="text-xs text-slate-400 mb-4">
                  The CURRENT consent position of everyone at this fleet — the latest decision per
                  person per type, because consent is an append-only log and an older
                  &ldquo;granted&rdquo; row sitting under a withdrawal would read as permission that
                  no longer exists. Record or withdraw consent on the person&apos;s own page; so is
                  erasure, which is a decision about one human being and never about an account.
                </p>
                {noMembersYet ? (
                  <p className="text-sm text-slate-400">
                    Link contacts to this fleet to see their consent position here.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800 text-sm">
                    {members.map((member) => {
                      const mine = consent.filter((record) => record.contactId === member.id);
                      return (
                        <li key={member.id} className="py-2.5 flex items-start gap-3 flex-wrap">
                          <Link
                            href={`/contacts/${member.id}`}
                            className="flex-1 min-w-[10rem] font-medium text-orange-400 hover:underline"
                          >
                            {contactName(member)}
                          </Link>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {mine.length === 0 ? (
                              <span className="text-xs text-slate-500">No consent recorded</span>
                            ) : (
                              mine.map((record) => (
                                <span
                                  key={record.id}
                                  title={`${record.source ?? "unknown source"} · ${formatDate(record.createdAt)}`}
                                  className={`badge ${
                                    record.granted
                                      ? "bg-emerald-500/15 text-emerald-300"
                                      : "bg-red-500/15 text-red-300"
                                  }`}
                                >
                                  {record.type.replace("_", " ")}
                                  {record.granted ? " ✓" : " ✕"}
                                </span>
                              ))
                            )}
                          </span>
                          {user.role === "owner" && (
                            // Owner-only because the export endpoint is
                            // owner-only (requireApiOwner). Offering it to
                            // anyone else is offering a button whose one
                            // outcome is a 403.
                            <a
                              href={`/api/contacts/${member.id}/export`}
                              className="btn-secondary btn-sm shrink-0"
                              download
                            >
                              ⬇ Export
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ),
          },
        ]}
      />
    </EntityDetailShell>
  );
}
