import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  markWon,
  markLost,
  reopenLead,
  deleteLead,
  linkLeadToContact,
  updateLead,
} from "@/app/actions/leads";
import LeadForm from "@/components/LeadForm";
import { createQuoteFromLead } from "@/app/actions/quotes";
import CommsTimeline from "@/components/CommsTimeline";
import ActivityPanel from "@/components/ActivityPanel";
import EmailComposer from "@/components/EmailComposer";
import LeadTimeline from "@/components/LeadTimeline";
import { auditDetailFor } from "@/lib/auditDetailQuery";
import ConfirmDelete from "@/components/ConfirmDelete";
import CustomFieldsCard from "@/components/custom-fields/CustomFieldsCard";
import MarkLeadViewed from "@/components/MarkLeadViewed";
import WhatsAppPanel from "@/components/WhatsAppPanel";
import Tabs from "@/components/Tabs";
import ModalTrigger from "@/components/Modal";
import ResearchButton from "@/components/ResearchButton";
import { isAiConfigured } from "@/lib/ai";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { requireUser } from "@/lib/auth";
import { listTenantStaff } from "@/lib/tenantActor";
import { brandForTenant, teamSignoff } from "@/lib/tenantBrand";
import { getActiveTenantId } from "@/lib/auth";
import { isSmtpConfigured, renderTemplate, leadVars } from "@/lib/email";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import { leadAttribution, isAdClick } from "@/lib/attribution";
import { Car, Check, FileText } from "lucide-react";

const RESEARCH_SUBJECT = "🔎 AI research";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; schedule?: string }>;
}) {
  const { id } = await params;
  const { tab, schedule } = await searchParams;
  const user = await requireUser();
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      stage: true,
      product: true,
      contact: true,
      assignedTo: true,
      createdBy: true,
      communications: { include: { user: true }, orderBy: { occurredAt: "desc" } },
      activities: { include: { assignedTo: true }, orderBy: { dueDate: "asc" } },
      quotes: { where: { deletedAt: null }, include: { items: true, fees: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "desc" } },
      researchNotes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!lead) notFound();
  const automotiveOn = await isModuleEnabled("automotive");
  const alreadyViewed = !!lead.viewedAt;
  const [contacts, users, templates, smtpConfigured, audit, waConfigured, libraryDocuments, products, stages] = await Promise.all([
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    // Feeds BOTH pickers on this page — the lead's "Assigned to" in the edit
    // modal and the activity assignee in the Activities tab. `User` is a global
    // model, so `prisma.user.findMany` was listing every user on the platform in
    // both of them.
    listTenantStaff(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    isSmtpConfigured(),
    prisma.auditLog.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    isWhatsAppConfigured(),
    prisma.libraryDocument.findMany({
      orderBy: { name: "asc" },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
  ]);
  const libraryDocs = libraryDocuments
    .filter((d) => d.versions[0])
    .map((d) => ({ id: d.versions[0].id, label: `${d.name} (v${d.versions[0].version})` }));
  const vars = leadVars(lead, teamSignoff(await brandForTenant(await getActiveTenantId())));
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    name: t.name,
    subject: renderTemplate(t.subject, vars),
    body: renderTemplate(t.body, vars),
  }));
  const path = `/leads/${lead.id}`;
  const aiOn = await isAiConfigured();

  // Research is stored on the lead itself (Research tab). Legacy research
  // notes (pre-migration) are still filtered out of the comms timeline.
  const comms = lead.communications.filter((c) => c.subject !== RESEARCH_SUBJECT);

  // Marketing attribution the website captured with the enquiry (ad click / UTMs).
  const attribution = leadAttribution(lead.raw);
  const fromAd = isAdClick(attribution);

  return (
    <>
      <MarkLeadViewed leadId={lead.id} viewed={alreadyViewed} />
      <EntityDetailShell
        backHref="/leads"
        backLabel="Leads"
        eyebrow="Sales opportunity"
        title={lead.title}
        status={<StatusPill tone={lead.status === "won" ? "success" : lead.status === "lost" ? "danger" : "info"}>{lead.status === "open" ? lead.stage.name : lead.status}</StatusPill>}
        description={`${lead.name} · ${lead.source}`}
        meta={`Added ${formatDate(lead.createdAt)}${lead.assignedTo ? ` · Owner: ${lead.assignedTo.name}` : " · Unassigned"}`}
        facts={[
          { label: "Estimated value", value: lead.valueCents ? formatZAR(lead.valueCents) : "Not set" },
          { label: "Product", value: lead.product?.name || "Not selected" },
          { label: "Activities", value: lead.activities.filter((activity) => activity.status === "planned").length },
          { label: "Quotes", value: lead.quotes.length },
        ]}
        actions={<>
          {lead.status === "open" && (
            <>
              <SaveForm success="Quote created" resetOnSuccess={false} action={createQuoteFromLead.bind(null, lead.id)}>
                <SaveButton className="btn-primary"><FileText className="size-4" />Create quote</SaveButton>
              </SaveForm>
              <SaveForm success="Marked won" resetOnSuccess={false} action={markWon.bind(null, lead.id)}>
                <SaveButton className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  <Check className="size-4" />Mark won
                </SaveButton>
              </SaveForm>
              <ModalTrigger
                label="Mark lost"
                title={`Why was “${lead.title}” lost?`}
                buttonClass="btn-danger"
              >
                <SaveForm success="Marked lost" resetOnSuccess={false} action={markLost.bind(null, lead.id)} className="card space-y-4">
                  <div>
                    <label className="label">Reason lost *</label>
                    <input
                      name="lostReason"
                      className="input"
                      required
                      autoFocus
                      placeholder="e.g. Bought elsewhere · too expensive · no response"
                    />
                  </div>
                  <SaveButton className="btn-danger">Mark lost</SaveButton>
                </SaveForm>
              </ModalTrigger>
            </>
          )}
          {lead.status !== "open" && (
            <SaveForm success="Lead reopened" resetOnSuccess={false} action={reopenLead.bind(null, lead.id)}>
              <SaveButton className="btn-secondary">Reopen</SaveButton>
            </SaveForm>
          )}
          <Link
            href={`/leads/${lead.id}/indemnity`}
            target="_blank"
            className="btn-secondary"
            title="Print a test-drive indemnity for this customer to sign"
          >
            <Car className="size-4" />Indemnity
          </Link>
          <ConfirmDelete
            action={deleteLead.bind(null, lead.id)}
            title={`Delete lead “${lead.title}”?`}
            description="The lead moves to the Trash and can be restored for 60 days."
          />
        </>}
      >

      {automotiveOn && lead.status === "won" && (
        <div className="card bg-emerald-500/10 border-emerald-500/30 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-emerald-300">
            🎉 Deal won{lead.contact ? ` — customer: ${contactName(lead.contact)}` : ""}.
            Register the vehicle to start tracking services.
          </p>
          <Link
            href={`/vehicles/new?contactId=${lead.contactId ?? ""}&productId=${
              lead.productId ?? ""
            }&color=${encodeURIComponent(lead.color ?? "")}`}
            className="btn-primary btn-sm"
          >
            + Register vehicle
          </Link>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-w-0">
          <Tabs
            initialKey={tab}
            tabs={[
              {
                key: "details",
                label: "Details",
                content: (
                  <>
                    <div className="card">
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="font-semibold">Details</h2>
                        <ModalTrigger
                          label="✎ Edit details"
                          title={`Edit “${lead.title}”`}
                          buttonClass="btn-secondary btn-sm"
                        >
                          <LeadForm
                            action={updateLead.bind(null, lead.id)}
                            products={products.map((p) => ({
                              id: p.id,
                              name: p.name,
                              basePriceCents: p.basePriceCents,
                              colors: p.colors.map((c) => c.name),
                            }))}
                            stages={stages.map((s) => ({ id: s.id, name: s.name }))}
                            contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
                            users={users.map((u) => ({ id: u.id, name: u.name }))}
                            defaults={lead}
                            submitLabel="Save changes"
                          />
                        </ModalTrigger>
                      </div>
                      <dl className="space-y-2 text-sm max-w-xl">
                        {[
                          ["Customer", lead.name],
                          ["Email", lead.email],
                          ["Phone", lead.phone],
                          ["Product", lead.product?.name],
                          ["Colour", lead.color],
                          ["Quantity", lead.quantity > 1 ? String(lead.quantity) : null],
                          ["Value", lead.valueCents ? formatZAR(lead.valueCents) : null],
                          ["Assigned to", lead.assignedTo?.name],
                          ["Source", lead.source],
                          ["Lost reason", lead.lostReason],
                        ].map(([label, value]) =>
                          value ? (
                            <div key={label as string} className="flex justify-between gap-4">
                              <dt className="text-slate-400 shrink-0">{label}</dt>
                              <dd className="text-right font-medium">{value as string}</dd>
                            </div>
                          ) : null
                        )}
                      </dl>
                    </div>

                    {attribution && (
                      <div className="card">
                        <div className="flex items-center justify-between mb-3">
                          <h2 className="font-semibold">Marketing origin</h2>
                          {fromAd && (
                            <span className="badge bg-blue-500/15 text-blue-300">Google Ads click</span>
                          )}
                        </div>
                        <dl className="space-y-2 text-sm max-w-xl">
                          {[
                            ["Source", attribution.utm_source],
                            ["Medium", attribution.utm_medium],
                            ["Campaign", attribution.utm_campaign],
                            ["Keyword", attribution.utm_term],
                            ["Ad variant", attribution.utm_content],
                            ["Landing page", attribution.landingPage],
                            ["Referrer", attribution.referrer],
                            ["Captured", attribution.capturedAt ? formatDateTime(new Date(attribution.capturedAt)) : null],
                          ].map(([label, value]) =>
                            value ? (
                              <div key={label as string} className="flex justify-between gap-4">
                                <dt className="text-slate-400 shrink-0">{label}</dt>
                                <dd className="text-right font-medium break-all">{value as string}</dd>
                              </div>
                            ) : null
                          )}
                          {attribution.gclid && (
                            <div className="flex justify-between gap-4">
                              <dt className="text-slate-400 shrink-0">GCLID</dt>
                              <dd
                                className="text-right font-mono text-xs text-slate-500 break-all"
                                title="Google click ID — used by the Ads conversion export when this lead is won"
                              >
                                {attribution.gclid}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </div>
                    )}

                    {lead.raw && (
                      <details className="card">
                        <summary className="font-semibold cursor-pointer text-sm">
                          Raw intake payload
                        </summary>
                        <pre className="text-xs text-slate-400 mt-3 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(JSON.parse(lead.raw), null, 2)}
                        </pre>
                      </details>
                    )}

                    <CustomFieldsCard entity="lead" recordId={lead.id} />
                  </>
                ),
              },
              {
                key: "customer",
                label: "Customer",
                content: (
                  <div className="card max-w-xl">
                    <h2 className="font-semibold mb-3">Customer</h2>
                    {lead.contact && (
                      <Link
                        href={`/contacts/${lead.contact.id}`}
                        className="text-sm font-medium text-orange-400 hover:underline block mb-3"
                      >
                        {contactName(lead.contact)} →
                      </Link>
                    )}
                    <SaveForm success="Linked to contact" resetOnSuccess={false} action={linkLeadToContact.bind(null, lead.id)} className="space-y-2">
                      <label className="label">
                        {lead.contact ? "Change linked customer" : "Link to customer"}
                      </label>
                      <select
                        name="contactId"
                        className="input"
                        defaultValue={lead.contactId ?? ""}
                      >
                        <option value="">Select customer…</option>
                        {contacts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {contactName(c)}
                          </option>
                        ))}
                      </select>
                      <SaveButton className="btn-secondary btn-sm w-full">Save customer link</SaveButton>
                    </SaveForm>
                  </div>
                ),
              },
              {
                key: "activities",
                label: "Activities",
                count: lead.activities.filter((a) => a.status === "planned").length,
                content: (
                  <ActivityPanel
                    activities={lead.activities}
                    users={users}
                    currentUserId={user.id}
                    leadId={lead.id}
                    revalidate={path}
                    startOpen={tab === "activities" && schedule === "1"}
                  />
                ),
              },
              {
                key: "quotes",
                label: "Quotes",
                count: lead.quotes.length,
                content: (
                  <div className="card">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-semibold">Quotes</h2>
                      {lead.status === "open" && (
                        <SaveForm success="Quote created" resetOnSuccess={false} action={createQuoteFromLead.bind(null, lead.id)}>
                          <SaveButton className="btn-secondary btn-sm">+ Create quote</SaveButton>
                        </SaveForm>
                      )}
                    </div>
                    {lead.quotes.length === 0 ? (
                      <p className="text-sm text-slate-400">No quotes yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {lead.quotes.map((q) => {
                          const total = payableTotalCents(q);
                          return (
                            <li key={q.id} className="flex items-center gap-2 text-sm">
                              <Link href={`/quotes/${q.id}`} className="text-orange-400 hover:underline font-medium">
                                Q-{q.number}
                              </Link>
                              <span className="flex-1 text-slate-400">{formatZAR(Math.round(total))}</span>
                              <span
                                className={`badge ${
                                  q.supersededAt
                                    ? "bg-slate-800 text-slate-500"
                                    : q.status === "accepted"
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : q.status === "declined"
                                    ? "bg-red-500/15 text-red-300"
                                    : q.status === "sent"
                                    ? "bg-blue-500/15 text-blue-300"
                                    : "bg-slate-800 text-slate-300"
                                }`}
                              >
                                {q.supersededAt ? "superseded" : q.status}
                              </span>
                            </li>
                          );
                        })}
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
                      defaultTo={lead.email ?? ""}
                      templates={renderedTemplates}
                      smtpConfigured={smtpConfigured}
                      leadId={lead.id}
                      revalidate={path}
                      libraryDocs={libraryDocs}
                      aiConfigured={aiOn}
                    />
                    <WhatsAppPanel
                      phone={lead.phone ?? lead.contact?.whatsapp ?? lead.contact?.phone ?? null}
                      leadId={lead.id}
                      contactId={lead.contactId ?? undefined}
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
                      leadId={lead.id}
                      revalidate={path}
                    />
                  </>
                ),
              },
              {
                key: "research",
                label: "Research",
                count: lead.researchNotes.length,
                content: (
                  <div className="card space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="font-semibold">🔎 AI research</h2>
                      <ResearchButton leadId={lead.id} configured={aiOn} />
                    </div>
                    {lead.researchNotes.length === 0 ? (
                      <p className="text-sm text-slate-400">
                        No research yet. Use the Research button to generate a briefing on this
                        lead and the company behind the email.
                      </p>
                    ) : (
                      <ul className="space-y-4">
                        {lead.researchNotes.map((r) => (
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
            ]}
          />
        </div>

        <LeadTimeline
          leadId={lead.id}
          revalidate={path}
          audit={audit}
          auditDetail={await auditDetailFor(audit)}
          communications={comms}
          activities={lead.activities}
          creationNote={
            lead.notes
              ? {
                  text: lead.notes,
                  when: lead.createdAt,
                  who: lead.createdBy?.name ?? `via ${lead.source}`,
                }
              : null
          }
        />
      </div>
      </EntityDetailShell>
    </>
  );
}
