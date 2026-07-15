import Link from "next/link";
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
import ConfirmDelete from "@/components/ConfirmDelete";
import MarkLeadViewed from "@/components/MarkLeadViewed";
import WhatsAppPanel from "@/components/WhatsAppPanel";
import Tabs from "@/components/Tabs";
import ModalTrigger from "@/components/Modal";
import ResearchButton from "@/components/ResearchButton";
import { isAiConfigured } from "@/lib/ai";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { requireUser } from "@/lib/auth";
import { isSmtpConfigured, renderTemplate, leadVars } from "@/lib/email";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";
import { Car, Check, FileText } from "lucide-react";

const RESEARCH_SUBJECT = "🔎 AI research";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
      quotes: { where: { deletedAt: null }, include: { items: true }, orderBy: { createdAt: "desc" } },
      researchNotes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!lead) notFound();
  const alreadyViewed = !!lead.viewedAt;
  const [contacts, users, templates, smtpConfigured, audit, waConfigured, libraryDocuments, products, stages] = await Promise.all([
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
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
  const vars = leadVars(lead);
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
              <form action={createQuoteFromLead.bind(null, lead.id)}>
                <button className="btn-primary"><FileText className="size-4" />Create quote</button>
              </form>
              <form action={markWon.bind(null, lead.id)}>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  <Check className="size-4" />Mark won
                </button>
              </form>
              <ModalTrigger
                label="Mark lost"
                title={`Why was “${lead.title}” lost?`}
                buttonClass="btn-danger"
              >
                <form action={markLost.bind(null, lead.id)} className="card space-y-4">
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
                  <button className="btn-danger">Mark lost</button>
                </form>
              </ModalTrigger>
            </>
          )}
          {lead.status !== "open" && (
            <form action={reopenLead.bind(null, lead.id)}>
              <button className="btn-secondary">Reopen</button>
            </form>
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

      {lead.status === "won" && (
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
                    <form action={linkLeadToContact.bind(null, lead.id)} className="space-y-2">
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
                      <button className="btn-secondary btn-sm w-full">Save customer link</button>
                    </form>
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
                        <form action={createQuoteFromLead.bind(null, lead.id)}>
                          <button className="btn-secondary btn-sm">+ Create quote</button>
                        </form>
                      )}
                    </div>
                    {lead.quotes.length === 0 ? (
                      <p className="text-sm text-slate-400">No quotes yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {lead.quotes.map((q) => {
                          const total = q.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
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
          communications={comms}
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
