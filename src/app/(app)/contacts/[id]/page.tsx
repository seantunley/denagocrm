import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { deleteContact } from "@/app/actions/contacts";
import CommsTimeline from "@/components/CommsTimeline";
import CustomFieldsCard from "@/components/custom-fields/CustomFieldsCard";
import DocumentsPanel from "@/components/DocumentsPanel";
import ActivityPanel from "@/components/ActivityPanel";
import EmailComposer from "@/components/EmailComposer";
import LeadTimeline from "@/components/LeadTimeline";
import ConfirmDelete from "@/components/ConfirmDelete";
import WhatsAppPanel from "@/components/WhatsAppPanel";
import Tabs from "@/components/Tabs";
import CopyButton from "@/components/CopyButton";
import ResearchButton from "@/components/ResearchButton";
import { isAiConfigured } from "@/lib/ai";
import { ensureReferralCode } from "@/lib/referrals";
import { redeemReferral } from "@/app/actions/referrals";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/lib/auth";
import { contactHealth } from "@/lib/healthData";
import { healthLabels } from "@/lib/health";
import { recordConsent, anonymizeContact } from "@/app/actions/privacy";
import { CONSENT_TYPES } from "@/lib/consent";
import { isSmtpConfigured, renderTemplate, contactVars } from "@/lib/email";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { quotePricing } from "@/lib/pricing";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";

const RESEARCH_SUBJECT = "🔎 AI research";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const [automotiveOn, marketingOn] = await Promise.all([
    isModuleEnabled("automotive"),
    isModuleEnabled("marketing"),
  ]);
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } },
      leads: { where: { deletedAt: null }, include: { stage: true, product: true }, orderBy: { createdAt: "desc" } },
      communications: { include: { user: true }, orderBy: { occurredAt: "desc" } },
      documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      // Quotes are shown ALONGSIDE the files in the Documents tab. Previously the
      // tab listed only Document rows, so a quote only appeared once somebody had
      // generated or uploaded a PDF for it — and an accepted, signed quote with no
      // generated PDF looked as though it had disappeared.
      quotes: {
        where: { deletedAt: null },
        include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
        orderBy: { createdAt: "desc" },
      },
      activities: { include: { assignedTo: true }, orderBy: { dueDate: "asc" } },
      consentRecords: { orderBy: { createdAt: "desc" } },
      researchNotes: { orderBy: { createdAt: "desc" } },
      tags: true,
      owner: true,
      createdBy: true,
    },
  });
  if (!contact) notFound();
  // Document.quoteId is a bare column with no Prisma relation, so the quote's
  // paperwork has to be fetched separately — the same way the deliveries board
  // does it. Fetching BY QUOTE rather than by contact matters: a signed PDF or an
  // uploaded invoice is always linked to its quote, but not always to the
  // contact, so a contact-only query silently misses them.
  const quoteDocuments = contact.quotes.length
    ? await prisma.document.findMany({
        where: { quoteId: { in: contact.quotes.map((quote) => quote.id) }, deletedAt: null },
        include: { uploadedBy: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  // Every quote becomes a heading; its paperwork nests underneath. The quote is
  // listed even with nothing filed against it, because "no PDF yet" is not the
  // same as "no quote" — which is how an accepted quote came to look deleted.
  const quoteGroups = contact.quotes.map((quote) => ({
    id: quote.id,
    number: quote.number,
    status: quote.status,
    signed: quote.signedAt != null,
    superseded: quote.supersededAt != null,
    // What the customer actually pays — fees and delivery included, which is
    // why the query above loads them. #261 wraps this exact call as
    // payableTotalCents(); collapse this to that helper once it lands.
    totalCents: quotePricing(quote.items, quote.fees, {
      taxInclusive: quote.taxInclusive,
      depositType: quote.depositType,
      depositValue: quote.depositValue,
    }).totalCents,
    createdAt: quote.createdAt,
    documents: quoteDocuments.filter((document) => document.quoteId === quote.id),
  }));
  // Anything filed against a quote is shown under that quote, so it must not be
  // listed a second time here — fulfilment uploads carry BOTH quoteId and
  // contactId.
  const looseDocuments = contact.documents.filter((document) => document.quoteId == null);
  const [users, templates, smtpConfigured, waConfigured, history, libraryDocuments] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    isSmtpConfigured(),
    isWhatsAppConfigured(),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { contactId: contact.id },
          { leadId: { in: (await prisma.lead.findMany({ where: { contactId: contact.id }, select: { id: true } })).map((l) => l.id) } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.libraryDocument.findMany({
      orderBy: { name: "asc" },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    }),
  ]);
  const referralCode = marketingOn ? await ensureReferralCode(contact.id) : "";
  const [referralsMade, referredIn] = marketingOn
    ? await Promise.all([
        prisma.referral.findMany({
          where: { referrerId: contact.id },
          include: { lead: true, contact: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.referral.findFirst({
          where: { OR: [{ contactId: contact.id }, { lead: { contactId: contact.id } }] },
          include: { referrer: true },
        }),
      ])
    : [[], null];
  const libraryDocs = libraryDocuments
    .filter((d) => d.versions[0])
    .map((d) => ({ id: d.versions[0].id, label: `${d.name} (v${d.versions[0].version})` }));
  const vars = contactVars(contact);
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    name: t.name,
    subject: renderTemplate(t.subject, vars),
    body: renderTemplate(t.body, vars),
  }));
  const path = `/contacts/${contact.id}`;
  const aiOn = await isAiConfigured();

  // Research is stored on the contact itself (Research tab). Legacy research
  // notes (pre-migration) are still filtered out of the comms timeline.
  const comms = contact.communications.filter((c) => c.subject !== RESEARCH_SUBJECT);
  const health = await contactHealth(contact.id);

  return (
    <EntityDetailShell
      backHref="/contacts"
      backLabel="Contacts"
      eyebrow={contact.isCompany ? "Company account" : "Customer profile"}
      title={contactName(contact)}
      status={<StatusPill tone={health.tier === "healthy" ? "success" : health.tier === "at_risk" ? "danger" : "warning"}>{healthLabels[health.tier]} · {health.score}</StatusPill>}
      description={[contact.email, contact.phone, contact.city].filter(Boolean).join(" · ") || "No contact details recorded"}
      meta={`${contact.owner ? `Owner: ${contact.owner.name}` : "No owner assigned"} · added${contact.createdBy ? ` by ${contact.createdBy.name}` : ""} at ${formatDateTime(contact.createdAt)}`}
      facts={[
        ...(automotiveOn ? [{ label: "Vehicles", value: contact.vehicles.length }] : []),
        { label: "Open leads", value: contact.leads.filter((lead) => lead.status === "open").length },
        { label: "Activities", value: contact.activities.filter((activity) => activity.status === "planned").length },
        { label: "Documents", value: looseDocuments.length + quoteDocuments.length },
      ]}
      actions={<>
          <Link href={`/contacts/${contact.id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <ConfirmDelete
            action={deleteContact.bind(null, contact.id)}
            title={`Delete contact ${contactName(contact)}?`}
            description={`The contact moves to the Trash and can be restored for 60 days.${automotiveOn ? " Their vehicles and job cards stay in place." : ""}`}
          />
        </>}
    >

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-w-0">
          <Tabs
            tabs={[
              {
                key: "details",
                label: "Details",
                content: (
                  <div className="space-y-6">
                  <div className="card">
                    <h2 className="font-semibold mb-3">Details</h2>
                    <dl className="space-y-2 text-sm max-w-xl">
                      {[
                        ["Email", contact.email],
                        ["Phone", contact.phone],
                        ["WhatsApp", contact.whatsapp],
                        [
                          "Address",
                          [contact.address, contact.suburb, contact.city, contact.province, contact.postalCode]
                            .filter(Boolean)
                            .join(", ") || null,
                        ],
                        ["Source", contact.source],
                        ["Added", formatDate(contact.createdAt)],
                      ]
                        .filter(([, value]) => value)
                        .map(([label, value]) => (
                          <div key={label as string} className="flex justify-between gap-4">
                            <dt className="text-slate-400 shrink-0">{label}</dt>
                            <dd className="text-right font-medium">{value as string}</dd>
                          </div>
                        ))}
                    </dl>
                    {contact.notes && (
                      <p className="text-sm text-slate-400 mt-3 pt-3 border-t border-slate-800 whitespace-pre-wrap">
                        {contact.notes}
                      </p>
                    )}
                  </div>
                  <CustomFieldsCard entity="contact" recordId={contact.id} />
                  </div>
                ),
              },
              {
                key: "activities",
                label: "Activities",
                count: contact.activities.filter((a) => a.status === "planned").length,
                content: (
                  <ActivityPanel
                    activities={contact.activities}
                    users={users}
                    currentUserId={user.id}
                    contactId={contact.id}
                    revalidate={path}
                  />
                ),
              },
              ...(automotiveOn ? [{
                key: "vehicles",
                label: "Vehicles",
                count: contact.vehicles.length,
                content: (
                  <div className="card">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-semibold">Vehicles</h2>
                      <Link
                        href={`/vehicles/new?contactId=${contact.id}`}
                        className="btn-secondary btn-sm"
                      >
                        + Add
                      </Link>
                    </div>
                    {contact.vehicles.length === 0 ? (
                      <p className="text-sm text-slate-400">No vehicles registered.</p>
                    ) : (
                      <ul className="space-y-2">
                        {contact.vehicles.map((v) => {
                          const due = computeDue(v);
                          return (
                            <li key={v.id} className="flex items-center gap-2">
                              <Link
                                href={`/vehicles/${v.id}`}
                                className="text-sm font-medium text-orange-400 hover:underline flex-1"
                              >
                                {v.model}
                                {v.color ? ` (${v.color})` : ""}
                              </Link>
                              <span className={`badge ${dueColors[due.status]}`}>
                                {dueLabels[due.status]}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ),
              }] : []),
              {
                key: "leads",
                label: "Leads",
                count: contact.leads.length,
                content: (
                  <div className="card">
                    <h2 className="font-semibold mb-3">Leads</h2>
                    {contact.leads.length === 0 ? (
                      <p className="text-sm text-slate-400">No leads linked.</p>
                    ) : (
                      <ul className="space-y-2">
                        {contact.leads.map((l) => (
                          <li key={l.id} className="flex items-center gap-2">
                            <Link
                              href={`/leads/${l.id}`}
                              className="text-sm font-medium text-orange-400 hover:underline flex-1 truncate"
                            >
                              {l.title}
                            </Link>
                            <span className="text-xs text-slate-400">{formatZAR(l.valueCents)}</span>
                            <span
                              className={`badge ${
                                l.status === "won"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : l.status === "lost"
                                  ? "bg-red-500/15 text-red-300"
                                  : "bg-slate-800 text-slate-400"
                              }`}
                            >
                              {l.status === "open" ? l.stage.name : l.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              },
              {
                key: "comms",
                label: "Communications",
                count: comms.length,
                content: (
                  <>
                    <EmailComposer
                      defaultTo={contact.email ?? ""}
                      templates={renderedTemplates}
                      smtpConfigured={smtpConfigured}
                      contactId={contact.id}
                      revalidate={path}
                      libraryDocs={libraryDocs}
                      aiConfigured={aiOn}
                    />
                    <WhatsAppPanel
                      phone={contact.whatsapp ?? contact.phone}
                      contactId={contact.id}
                      configured={waConfigured}
                      revalidate={path}
                      messages={comms
                        .filter((c) => c.type === "whatsapp")
                        .slice()
                        .reverse()
                        .map((c) => ({
                          id: c.id,
                          direction: c.direction,
                          body: c.body,
                          occurredAt: c.occurredAt.toISOString(),
                          userName: c.user.name,
                        }))}
                    />
                    <CommsTimeline
                      communications={comms}
                      contactId={contact.id}
                      revalidate={path}
                    />
                  </>
                ),
              },
              {
                key: "research",
                label: "Research",
                count: contact.researchNotes.length,
                content: (
                  <div className="card space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="font-semibold">🔎 AI research</h2>
                      <ResearchButton contactId={contact.id} configured={aiOn} />
                    </div>
                    {contact.researchNotes.length === 0 ? (
                      <p className="text-sm text-slate-400">
                        No research yet. Use the Research button to generate a briefing on this
                        customer and the company behind the email.
                      </p>
                    ) : (
                      <ul className="space-y-4">
                        {contact.researchNotes.map((r) => (
                          <li
                            key={r.id}
                            className="border-t border-slate-800 pt-4 first:border-0 first:pt-0"
                          >
                            <p className="text-xs text-slate-500 mb-1.5">
                              {formatDateTime(r.createdAt)}
                            </p>
                            <p className="text-sm whitespace-pre-wrap leading-relaxed text-slate-200">
                              {r.body}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              },
              ...(marketingOn ? [{
                key: "referrals",
                label: "Referrals",
                count: referralsMade.length,
                content: (
                  <>
                    <div className="card max-w-xl">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                        {contact.firstName}&apos;s referral code
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="text-xl font-semibold tracking-[-0.025em] tracking-widest text-orange-400 bg-slate-800 rounded-lg px-4 py-2">
                          {referralCode}
                        </code>
                        <CopyButton text={referralCode} />
                        <a
                          href={`https://wa.me/?text=${encodeURIComponent(
                            `Use my referral code ${referralCode} when you enquire at Denago Cape Town (denagocpt.co.za) and mention my name — ${contactName(contact)}`
                          )}`}
                          target="_blank"
                          className="btn-secondary btn-sm"
                        >
                          💬 Share
                        </a>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        New leads captured with this code are tracked below. The fee becomes due
                        when the referred deal is won.
                      </p>
                      {referredIn && (
                        <p className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-800">
                          👤 This customer was referred by{" "}
                          <Link
                            href={`/contacts/${referredIn.referrerId}`}
                            className="text-orange-400 hover:underline"
                          >
                            {contactName(referredIn.referrer)}
                          </Link>
                        </p>
                      )}
                    </div>

                    <div className="card p-0 max-w-xl">
                      {referralsMade.length === 0 ? (
                        <p className="text-sm text-slate-400 p-5">
                          No referrals yet — share the code above.
                        </p>
                      ) : (
                        <ul className="divide-y divide-slate-800">
                          {referralsMade.map((r) => (
                            <li key={r.id} className="px-4 py-3">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                                  {r.lead ? (
                                    <Link
                                      href={`/leads/${r.lead.id}`}
                                      className="text-orange-400 hover:underline"
                                    >
                                      {r.lead.name}
                                    </Link>
                                  ) : r.contact ? (
                                    <Link
                                      href={`/contacts/${r.contact.id}`}
                                      className="text-orange-400 hover:underline"
                                    >
                                      {contactName(r.contact)}
                                    </Link>
                                  ) : (
                                    "Referred lead"
                                  )}
                                  <span className="text-xs text-slate-500">
                                    {" "}· {formatDate(r.createdAt)}
                                  </span>
                                </span>
                                <span
                                  className={`badge ${
                                    r.status === "redeemed"
                                      ? "bg-emerald-500/15 text-emerald-300"
                                      : r.status === "earned"
                                      ? "bg-amber-500/15 text-amber-300"
                                      : "bg-slate-800 text-slate-300"
                                  }`}
                                >
                                  {r.status === "earned" ? "fee due" : r.status}
                                </span>
                              </div>
                              {r.status === "earned" && (
                                <SaveForm
                                  // The FORM is converted but redeemReferral is not:
                                  // it also has a form on the referrals page, and an
                                  // action may only be converted alongside every one
                                  // of its call sites. This direction is safe — the
                                  // action still throws and SaveForm reports a
                                  // generic failure instead of losing the page.
                                  success="Referral redeemed"
                                  action={redeemReferral.bind(null, r.id)}
                                  className="flex items-center gap-1.5 mt-2"
                                >
                                  <input
                                    name="note"
                                    required
                                    className="input btn-sm flex-1 text-xs"
                                    placeholder="What was given? e.g. R1,000 service voucher"
                                  />
                                  <SaveButton pendingLabel="Redeeming…" className="btn-primary btn-sm">
                                    Redeem
                                  </SaveButton>
                                </SaveForm>
                              )}
                              {r.redeemedNote && (
                                <p className="text-xs text-slate-500 mt-1">🎁 {r.redeemedNote}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ),
              }] : []),
              {
                key: "documents",
                label: "Documents",
                count: looseDocuments.length + quoteDocuments.length,
                content: (
                  <DocumentsPanel
                    documents={looseDocuments}
                    quoteGroups={quoteGroups}
                    contactId={contact.id}
                    revalidate={path}
                  />
                ),
              },
              {
                key: "privacy",
                label: "Privacy",
                content: (
                  <div className="space-y-4">
                    <div className="card">
                      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                        <h2 className="font-semibold">Consent & data (POPIA)</h2>
                        <a
                          href={`/api/contacts/${contact.id}/export`}
                          className="btn-secondary btn-sm"
                          download
                        >
                          ⬇ Export data
                        </a>
                      </div>
                      <SaveForm
                        success="Consent recorded"
                        action={recordConsent.bind(null, contact.id)}
                        className="flex flex-wrap items-end gap-2 mb-4"
                      >
                        <div>
                          <label className="label">Consent</label>
                          <select name="type" className="input !w-auto">
                            {CONSENT_TYPES.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="label">Status</label>
                          <select name="granted" className="input !w-auto" defaultValue="granted">
                            <option value="granted">Granted</option>
                            <option value="withdrawn">Withdrawn</option>
                          </select>
                        </div>
                        <input name="source" className="input !w-32" placeholder="Source" defaultValue="admin" />
                        <SaveButton pendingLabel="Recording…" className="btn-primary btn-sm">
                          Record
                        </SaveButton>
                      </SaveForm>
                      {contact.consentRecords.length === 0 ? (
                        <p className="text-sm text-slate-400">No consent recorded yet.</p>
                      ) : (
                        <ul className="divide-y divide-slate-800 text-sm">
                          {contact.consentRecords.map((r) => (
                            <li key={r.id} className="py-1.5 flex items-center gap-3">
                              <span
                                className={`badge ${r.granted ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}
                              >
                                {r.granted ? "Granted" : "Withdrawn"}
                              </span>
                              <span className="flex-1 capitalize">{r.type.replace("_", " ")}</span>
                              <span className="text-xs text-slate-500">{r.source}</span>
                              <span className="text-xs text-slate-400">{formatDateTime(r.createdAt)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {user.role === "owner" && (
                      <div className="card border-red-900/50">
                        <h2 className="font-semibold mb-1 text-red-300">Right to erasure</h2>
                        <p className="text-xs text-slate-400 mb-3">
                          Redacts personal identifiers from this contact and their leads, withdraws
                          consent and moves them to Trash. Vehicles, job cards and safety records are
                          kept (de-identified) for warranty and legal reasons.
                        </p>
                        <ConfirmDelete
                          action={anonymizeContact.bind(null, contact.id)}
                          trigger="Erase personal data"
                          title="Erase this person's personal data?"
                          description="This redacts their name and contact details everywhere and cannot be undone. Continue only on a valid POPIA erasure request."
                        />
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>

        <LeadTimeline
          contactId={contact.id}
          revalidate={path}
          audit={history}
          communications={comms}
          activities={contact.activities}
          creationNote={
            contact.notes
              ? {
                  text: contact.notes,
                  when: contact.createdAt,
                  who: contact.createdBy?.name ?? "System",
                }
              : null
          }
        />
      </div>
    </EntityDetailShell>
  );
}
