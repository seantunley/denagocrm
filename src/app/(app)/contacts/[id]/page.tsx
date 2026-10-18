import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { deleteContact } from "@/app/actions/contacts";
import CustomerComposer from "@/components/CustomerComposer";
import CustomerLogForm from "@/components/CustomerLogForm";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Mail, Phone, MoreHorizontal, Info, CalendarDays } from "lucide-react";
import SecureLinksPanel from "@/components/SecureLinksPanel";
import CustomFieldsCard from "@/components/custom-fields/CustomFieldsCard";
import DocumentsPanel from "@/components/DocumentsPanel";
import PortalUploadsList, { type PortalUploadRow } from "@/components/PortalUploadsList";
import ActivityPanel from "@/components/ActivityPanel";
import EmailComposer from "@/components/EmailComposer";
import { customerTimelineWhere, type DealOption } from "@/lib/customerTimeline";
import { composerQuotes } from "@/lib/composerQuotes";
import { composerReplyToDefault } from "@/lib/replyToDefault";
import LeadTimeline from "@/components/LeadTimeline";
import { auditDetailFor } from "@/lib/auditDetailQuery";
import ConfirmDelete from "@/components/ConfirmDelete";
import { QuickCreateButton } from "@/components/QuickCreateButton";
import WhatsAppPanel from "@/components/WhatsAppPanel";
import Tabs, { TabLink } from "@/components/Tabs";
import CopyButton from "@/components/CopyButton";
import ResearchTabPanel from "@/components/ResearchTabPanel";
import { isAiConfigured, isResearchConfigured } from "@/lib/ai";
import { ensureReferralCode } from "@/lib/referrals";
import { getCompanyProfile } from "@/lib/companyProfile";
import { redeemReferral } from "@/app/actions/referrals";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/lib/auth";
import { CUSTOMER_RECORD_WRITE_PERMISSIONS, getAccessibleLeadIds, getAccessibleQuoteIds, hasAnyPermission, hasPermission } from "@/lib/permissions";
import { customerHistoryWhere, viewableDealIds } from "@/lib/customerHistory";
import { contactHealth } from "@/lib/healthData";
import { healthLabels } from "@/lib/health";
import { recordConsent, anonymizeContact } from "@/app/actions/privacy";
import { CONSENT_TYPES } from "@/lib/consent";
import { brandForTenant, teamSignoff } from "@/lib/tenantBrand";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { getActiveTenantId, isTenantOwner } from "@/lib/auth";
import { isSmtpConfigured, renderTemplate, contactVars } from "@/lib/email";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";

const RESEARCH_SUBJECT = "🔎 AI research";

/** See the lead page: the Research button's action can run 50–80 seconds. */
export const maxDuration = 300;

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const user = await requireUser();
  const isOwner = await isTenantOwner();
  // Same default as the lead page — this person plus the mailbox IMAP reads, so a
  // reply lands in their inbox AND on this record. Never throws.
  const replyToDefault = await composerReplyToDefault(user.email);
  const [automotiveOn, marketingOn, canCancelQuotes, canDuplicateQuotes, canCreateLead, canBookTestDrive, canOpenJobCard] = await Promise.all([
    isModuleEnabled("automotive"),
    isModuleEnabled("marketing"),
    hasPermission(user, "quotes.change_status"),
    hasPermission(user, "quotes.create"),
    hasPermission(user, "leads.create"),
    hasPermission(user, "activities.manage"),
    hasPermission(user, "jobcards.manage"),
  ]);
  const canCreateQuote = canDuplicateQuotes;
  const [canEditContact, canDeleteContact, canWriteRecord, canReplyWhatsApp] = await Promise.all([
    hasPermission(user, "contacts.edit"), hasPermission(user, "contacts.delete"),
    // What sendEmailAction and addCommunication require, and what sendWhatsAppMessage requires (review of #894).
    hasAnyPermission(user, ...CUSTOMER_RECORD_WRITE_PERMISSIONS), hasPermission(user, "inbox.reply"),
  ]);
  // THE QUOTES THIS VIEWER MAY OPEN — not every quote on the customer. Opening a customer is not permission to
  // read their quotations: the sidebar's latest quote (number, status, value), the Documents tab and the email
  // composer's quote buttons all read `contact.quotes`, so it is narrowed here, once (review of #891).
  // `null`: workspace-wide quote access, nothing to narrow.
  const quoteIds = (await hasPermission(user, "quotes.view_all")) ? null : await getAccessibleQuoteIds(user);
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } },
      leads: { where: { deletedAt: null }, include: { stage: true, product: true, createdBy: true }, orderBy: { createdAt: "desc" } },
      documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      // Quotes are shown ALONGSIDE the files in the Documents tab. Previously the
      // tab listed only Document rows, so a quote only appeared once somebody had
      // generated or uploaded a PDF for it — and an accepted, signed quote with no
      // generated PDF looked as though it had disappeared.
      quotes: {
        where: { deletedAt: null, ...(quoteIds ? { id: { in: quoteIds } } : {}) },
        include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
        orderBy: { createdAt: "desc" },
      },
      consentRecords: { orderBy: { createdAt: "desc" } },
      researchNotes: { orderBy: { createdAt: "desc" } },
      tags: true,
      owner: true,
      createdBy: true,
    },
  });
  if (!contact) notFound();
  // ONE TIMELINE (lib/customerTimeline.ts): everything filed on this customer AND
  // everything filed on any of their deals — a call logged on the deal, a quote
  // emailed from it. They used to show only on the deal's own page. A deal this
  // person may not open contributes nothing.
  const accessibleLeadIds = await getAccessibleLeadIds(user);
  const myDeals = contact.leads.filter((deal) => accessibleLeadIds === null || accessibleLeadIds.includes(deal.id));
  const timelineWhere = customerTimelineWhere(contact.id, myDeals.map((deal) => deal.id));
  const [timelineComms, activities] = await Promise.all([
    prisma.communication.findMany({ where: timelineWhere, include: { user: true }, orderBy: { occurredAt: "desc" } }),
    prisma.activity.findMany({
      where: timelineWhere,
      include: {
        assignedTo: true,
        attendees: { select: { userId: true, user: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { dueDate: "asc" },
    }),
  ]);
  const dealTitle = new Map(myDeals.map((deal) => [deal.id, deal.title]));
  // What is being written from here is about WHICH deal? None open: the customer.
  // One: that one. More than one: the form asks (dealChoice).
  const openDeals: DealOption[] = myDeals.filter((deal) => deal.status === "open").map((deal) => ({ id: deal.id, label: deal.title }));
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
    // why the query above loads them.
    totalCents: payableTotalCents(quote),
    createdAt: quote.createdAt,
    documents: quoteDocuments.filter((document) => document.quoteId === quote.id),
  }));
  // Anything filed against a quote is shown under that quote, so it must not be
  // listed a second time here — fulfilment uploads carry BOTH quoteId and
  // contactId.
  const looseDocuments = contact.documents.filter((document) => document.quoteId == null);
  const [users, templates, smtpConfigured, waConfigured, history, libraryDocuments] = await Promise.all([
    // The activity-assignee picker in the Activities tab. `User` is a global
    // model, so `prisma.user.findMany` is scoped by nothing — the dropdown
    // listed every user on the platform, and the action behind it wrote the
    // posted id with no membership check at all (see activities.ts).
    listActingTenantStaff(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    isSmtpConfigured(),
    isWhatsAppConfigured(),
    // THE HISTORY OF THIS CUSTOMER AND OF THEIR DEALS — the deals THIS PERSON MAY
    // OPEN (lib/customerHistory.ts). It used to take every deal of the customer,
    // and every entry naming the customer whatever deal it was also about, so
    // someone who may open the customer but not one of their deals read that
    // deal's audit trail here: stage moves, quotes, who did what.
    prisma.auditLog.findMany({
      where: customerHistoryWhere(
        contact.id,
        viewableDealIds(
          (await prisma.lead.findMany({ where: { contactId: contact.id }, select: { id: true } })).map((l) => l.id),
          await getAccessibleLeadIds(user),
        ),
      ),
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.libraryDocument.findMany({
      orderBy: { name: "asc" },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    }),
  ]);
  // What the customer has told us about being contacted — the same inputs the
  // send gate (communicationPolicy) reads, so staff see why a message was held.
  const [portalPref, unsubscribes] = await Promise.all([
    prisma.portalPreference.findUnique({ where: { contactId: contact.id } }),
    prisma.campaignRecipient.findMany({
      where: { contactId: contact.id, unsubscribedAt: { not: null } },
      select: { id: true, unsubscribedAt: true, campaign: { select: { name: true } } },
      orderBy: { unsubscribedAt: "desc" },
    }),
  ]);
  // Files the customer sent through the portal (gap audit #30) — the ones on no
  // case had no staff screen anywhere. Guarded client, so tenant-scoped.
  const [portalUploadRows, canReviewUploads] = await Promise.all([
    prisma.portalUpload.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, fileName: true, sizeBytes: true, createdAt: true, status: true, caseId: true },
    }),
    hasPermission(user, "documents.manage"),
  ]);
  const uploadCaseIds = [...new Set(portalUploadRows.map((row) => row.caseId).filter((caseId): caseId is string => Boolean(caseId)))];
  const uploadCases = uploadCaseIds.length
    ? await prisma.customerCase.findMany({ where: { id: { in: uploadCaseIds } }, select: { id: true, number: true } })
    : [];
  const portalUploads: PortalUploadRow[] = portalUploadRows.map((row) => {
    const linkedCase = uploadCases.find((item) => item.id === row.caseId);
    return { ...row, caseLabel: linkedCase ? `Case C-${linkedCase.number}` : null };
  });
  const referralCode = marketingOn ? await ensureReferralCode(contact.id) : "";
  // The share text names THIS workspace (Settings → Company), not Denago.
  const company = marketingOn ? await getCompanyProfile() : null;
  const referralWhere = company ? `${company.name}${company.website ? ` (${company.website})` : ""}` : "";
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
    .map((d) => ({ id: d.versions[0].id, label: `${d.name} (v${d.versions[0].version})`, fileName: d.versions[0].fileName, sizeBytes: d.versions[0].sizeBytes }));
  const vars = contactVars(contact, teamSignoff(await brandForTenant(await getActiveTenantId())));
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    name: t.name,
    subject: renderTemplate(t.subject, vars),
    body: renderTemplate(t.body, vars),
  }));
  const path = `/contacts/${contact.id}`;
  const aiOn = await isAiConfigured();
  // Research also runs on a connected ChatGPT subscription, which the email
  // draft check (aiOn) does not use.
  const researchOn = await isResearchConfigured();

  // Research is stored on the contact itself (Research tab). Legacy research
  // notes (pre-migration) are still filtered out of the comms timeline.
  const comms = timelineComms
    .filter((c) => c.subject !== RESEARCH_SUBJECT)
    // Said which deal it belongs to, when it is a deal's entry.
    .map((c) => (c.leadId && dealTitle.has(c.leadId) ? { ...c, ownerLabel: `Deal: ${dealTitle.get(c.leadId)}` } : c));
  const health = await contactHealth(contact.id);
  const nextActivity = activities.find((activity) => activity.status === "planned");
  const visibleOpenDeals = myDeals.filter((deal) => deal.status === "open");
  const context = <>
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="size-4 text-muted-foreground" />Next action</h2>
      {nextActivity ? <>
        <p className="text-sm font-medium">{nextActivity.summary}</p>
        <p className={`mt-1 text-xs ${nextActivity.dueDate < new Date() ? "text-amber-400" : "text-muted-foreground"}`}>{nextActivity.dueDate < new Date() ? "Overdue · " : ""}{formatDateTime(nextActivity.dueDate)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{nextActivity.assignedTo?.name ?? "Unassigned"}</p>
        {nextActivity.note && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{nextActivity.note}</p>}
      </> : <p className="text-sm text-muted-foreground">No follow-up scheduled.</p>}
      <TabLink tab="activities" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">{nextActivity ? "Manage activities" : "Schedule an activity"}</TabLink>
    </section>
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">Open deals <span className="ml-1 text-xs text-muted-foreground">{visibleOpenDeals.length}</span></h2>
      {visibleOpenDeals.length === 0 ? <p className="text-sm text-muted-foreground">No open deals.</p> : <ul className="divide-y divide-border">{visibleOpenDeals.map((deal) => <li key={deal.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
        <Link href={`/leads/${deal.id}`} className="block break-words text-sm font-medium hover:text-primary">{deal.title}</Link>
        {deal.product && <p className="text-xs text-muted-foreground">{deal.product.name}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">{deal.stage.name}</span><span>{formatZAR(deal.valueCents)}</span></div>
      </li>)}</ul>}
      {contact.quotes.length > 0 && <div className="mt-4 border-t border-border pt-3"><p className="text-xs text-muted-foreground">Latest quote</p><TabLink tab="documents" className="mt-1 block text-left text-sm hover:text-primary">Q-{contact.quotes[0].number} · {contact.quotes[0].status}</TabLink><p className="mt-1 text-xs text-muted-foreground">{formatZAR(payableTotalCents(contact.quotes[0]))}</p></div>}
    </section>
    <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Secure links</summary><div className="mt-3"><SecureLinksPanel contactId={contact.id} /></div></details>
  </>;


  return (
    <EntityDetailShell
      backHref="/contacts"
      backLabel="Contacts"
      eyebrow={contact.isCompany ? "Company account" : "Customer profile"}
      title={contactName(contact)}
      status={<Popover><PopoverTrigger asChild><button type="button" className="inline-flex items-center gap-1 rounded-md focus-visible:ring-2 focus-visible:ring-primary" aria-label="Explain customer health score"><StatusPill tone={health.tier === "healthy" || health.tier === "vip" ? "success" : health.tier === "at_risk" ? "danger" : "warning"}>{healthLabels[health.tier]} · {health.score}/100</StatusPill><Info className="size-3.5 text-muted-foreground" /></button></PopoverTrigger><PopoverContent><h2 className="text-sm font-semibold">Customer health · {health.score}/100</h2><p className="mt-2 text-xs text-muted-foreground">A relationship score based on ownership, service, contact recency, feedback, referrals and open issues.</p><ul className="mt-2 space-y-1 text-xs">{health.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></PopoverContent></Popover>}
      description={<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {contact.email && <a href={`mailto:${contact.email}`} className="inline-flex min-w-0 items-center gap-1.5 break-all hover:text-primary"><Mail className="size-3.5 shrink-0" />{contact.email}</a>}
        {contact.phone && <a href={`tel:${contact.phone}`} className="inline-flex items-center gap-1.5 hover:text-primary"><Phone className="size-3.5" />{contact.phone}</a>}
        {contact.city && <span>{contact.city}</span>}
        {!contact.email && !contact.phone && !contact.city && "No contact details recorded"}
      </div>}
      meta={<div className="flex flex-wrap items-center gap-x-3 gap-y-1">{contact.owner ? <span>Owner: {contact.owner.name}</span> : canEditContact ? <Link href={`${path}/edit`} className="font-medium text-primary hover:underline">Assign owner</Link> : <span>No owner assigned</span>}<span>Added {formatDate(contact.createdAt)}{contact.createdBy ? ` by ${contact.createdBy.name}` : ""}</span></div>}
      actions={<>
          {/* Start the next thing for THIS customer from their own page (gap audit
              #24) — each pre-filled with them, and only for staff allowed to. */}
          {canCreateQuote && (
            <QuickCreateButton kind="quote" defaults={{ contactId: contact.id }} className="btn-primary">
              New quote
            </QuickCreateButton>
          )}
          {automotiveOn && canBookTestDrive && (
            <Link href={`/test-drives?book=1&contactId=${contact.id}`} className="btn-secondary">
              Book test drive
            </Link>
          )}
          <Popover><PopoverTrigger asChild><button type="button" className="btn-secondary" aria-label="More customer actions"><MoreHorizontal className="size-4" />More</button></PopoverTrigger><PopoverContent align="end" className="flex w-56 flex-col gap-2 p-2">
          {canCreateLead && (
            <QuickCreateButton kind="lead" defaults={{ contactId: contact.id, contactLabel: contactName(contact) }} className="btn-secondary">
              New lead
            </QuickCreateButton>
          )}
          {automotiveOn && canOpenJobCard && contact.vehicles.length > 0 && (
            <QuickCreateButton
              kind="jobcard"
              // One vehicle → it's pre-selected; several → staff pick which.
              defaults={contact.vehicles.length === 1 ? { vehicleId: contact.vehicles[0].id } : {}}
              className="btn-secondary"
            >
              New job card
            </QuickCreateButton>
          )}
          {canEditContact && <Link href={`/contacts/${contact.id}/edit`} className="btn-secondary">
            Edit customer
          </Link>}
          {canDeleteContact && <ConfirmDelete
            triggerClass="btn-secondary text-red-400"
            action={deleteContact.bind(null, contact.id)}
            title={`Delete contact ${contactName(contact)}?`}
            description={`The contact moves to the Trash and can be restored for 60 days.${automotiveOn ? " Their vehicles and job cards stay in place." : ""}`}
          />}
          </PopoverContent></Popover>
        </>}
    >

      <div>
        <div className="min-w-0">
          <Tabs
            // Not keyed on ?tab: a key change rebuilds every panel and loses what is being typed (TabLink switches in place).
            initialKey={tab ?? "comms"}
            overflowKeys={["research", "referrals", "privacy"]}
            tabs={[
              {
                key: "comms",
                label: "Communications",
                count: comms.length,
                content: (
        <LeadTimeline
          // Each channel only for someone the server lets use it (review of #894): a view-only member saw them all.
          workspace={{ context, replyable: canWriteRecord, composer: <CustomerComposer email={canWriteRecord && <EmailComposer key={contact.id} compactTrigger
                      defaultTo={contact.email ?? ""}
                      templates={renderedTemplates}
                      smtpConfigured={smtpConfigured}
                      contactId={contact.id}
                      deals={openDeals}
                      revalidate={path}
                      libraryDocs={libraryDocs}
                      quotes={composerQuotes(contact.quotes, canCancelQuotes, (company ?? (await getCompanyProfile())).name)}
                      aiConfigured={aiOn}
                      defaultReplyTo={replyToDefault}
                    />} whatsapp={canReplyWhatsApp && <WhatsAppPanel composerOnly phone={contact.whatsapp ?? contact.phone} contactId={contact.id} deals={openDeals} configured={waConfigured} revalidate={path} messages={[]} />} note={canWriteRecord && <CustomerLogForm mode="note" contactId={contact.id} deals={openDeals} revalidate={path} />} call={canWriteRecord && <CustomerLogForm mode="call" contactId={contact.id} deals={openDeals} revalidate={path} />} /> }}
          contactId={contact.id}
          revalidate={path}
          audit={history}
          auditDetail={await auditDetailFor(history)}
          communications={comms}
          activities={activities}
          creationNote={
            contact.notes
              ? {
                  text: contact.notes,
                  when: contact.createdAt,
                  who: contact.createdBy?.name ?? "System",
                }
              : null
          }
          notesFromLeadId={contact.notesFromLeadId}
          leadNotes={myDeals
            .filter((lead) => lead.notes?.trim())
            .map((lead) => ({
              leadId: lead.id,
              title: lead.title,
              text: lead.notes!,
              when: lead.createdAt,
              who: lead.createdBy?.name ?? `via ${lead.source}`,
            }))}
        />
                ),
              },
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
                count: activities.filter((a) => a.status === "planned").length,
                content: (
                  <ActivityPanel
                    activities={activities}
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
                label: "Deals",
                count: myDeals.length,
                content: (
                  <div className="card">
                    <h2 className="font-semibold mb-3">Leads</h2>
                    {myDeals.length === 0 ? (
                      <p className="text-sm text-slate-400">No leads linked.</p>
                    ) : (
                      <ul className="space-y-2">
                        {myDeals.map((l) => (
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
                key: "research",
                label: "Research",
                count: contact.researchNotes.length,
                content: (
                  <ResearchTabPanel
                    notes={contact.researchNotes}
                    contactId={contact.id}
                    configured={researchOn}
                    subjectLabel="customer"
                  />
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
                            `Use my referral code ${referralCode} when you enquire at ${referralWhere} and mention my name — ${contactName(contact)}`
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
                count: looseDocuments.length + quoteDocuments.length + portalUploads.length,
                content: (
                  <div className="space-y-4">
                    {portalUploads.length > 0 && (
                      <div className="card">
                        <h2 className="mb-2 font-semibold">From the customer portal</h2>
                        <PortalUploadsList uploads={portalUploads} canReview={canReviewUploads} />
                      </div>
                    )}
                    <DocumentsPanel
                      documents={looseDocuments}
                      quoteGroups={quoteGroups}
                      quoteActions={{ canCancel: canCancelQuotes, canDuplicate: canDuplicateQuotes }}
                      contactId={contact.id}
                      revalidate={path}
                    />
                  </div>
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
                      <div className="mb-4 text-sm">
                        <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Communication preferences</h3>
                        <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
                          {[
                            ["Marketing", !contact.marketingOptOut],
                            ["Email service reminders (portal)", portalPref ? portalPref.serviceReminders && portalPref.emailServiceUpdates : true],
                            ["SMS service updates (portal)", portalPref ? portalPref.smsServiceUpdates : true],
                            ["Marketing emails (portal)", portalPref ? portalPref.marketingEmail && portalPref.emailMarketing : true],
                            ["Portal notifications", portalPref ? portalPref.portalNotifications : true],
                          ].map(([label, on]) => (
                            <li key={String(label)} className="flex items-center justify-between gap-2">
                              <span>{label}</span>
                              <span className={`badge ${on ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                                {on ? "On" : "Off"}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs text-slate-500 mt-1">
                          {portalPref
                            ? `Portal preferences last changed ${formatDateTime(portalPref.updatedAt)}.`
                            : "Never changed in the portal (defaults apply)."}
                        </p>
                        {unsubscribes.length > 0 && (
                          <ul className="mt-2 text-xs text-slate-400 space-y-0.5">
                            {unsubscribes.map((u) => (
                              <li key={u.id}>
                                Unsubscribed via email link — {u.campaign.name} · {formatDateTime(u.unsubscribedAt!)}
                              </li>
                            ))}
                          </ul>
                        )}
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

                    {/* The workspace's owner — anonymizeContact checks isTenantOwner(). */}
                    {isOwner && (
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


      </div>
    </EntityDetailShell>
  );
}
