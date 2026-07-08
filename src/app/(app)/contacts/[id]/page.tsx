import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { deleteContact } from "@/app/actions/contacts";
import CommsTimeline from "@/components/CommsTimeline";
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
import { isSmtpConfigured, renderTemplate, contactVars } from "@/lib/email";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";

const RESEARCH_SUBJECT = "🔎 AI research";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } },
      leads: { where: { deletedAt: null }, include: { stage: true, product: true }, orderBy: { createdAt: "desc" } },
      communications: { include: { user: true }, orderBy: { occurredAt: "desc" } },
      documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      activities: { include: { assignedTo: true }, orderBy: { dueDate: "asc" } },
      tags: true,
      owner: true,
      createdBy: true,
    },
  });
  if (!contact) notFound();
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
  const referralCode = await ensureReferralCode(contact.id);
  const [referralsMade, referredIn] = await Promise.all([
    prisma.referral.findMany({
      where: { referrerId: contact.id },
      include: { lead: true, contact: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.referral.findFirst({
      where: { OR: [{ contactId: contact.id }, { lead: { contactId: contact.id } }] },
      include: { referrer: true },
    }),
  ]);
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{contactName(contact)}</h1>
            {contact.tags.map((t) => (
              <span
                key={t.id}
                className="badge text-white"
                style={{ backgroundColor: t.color }}
              >
                {t.name}
              </span>
            ))}
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            {[contact.email, contact.phone, contact.city].filter(Boolean).join(" · ") || "No details"}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {contact.owner ? `Owner: ${contact.owner.name}` : "No owner assigned"}
            {" · added"}
            {contact.createdBy ? ` by ${contact.createdBy.name}` : ""} at{" "}
            {formatDateTime(contact.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/contacts/${contact.id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <ConfirmDelete
            action={deleteContact.bind(null, contact.id)}
            title={`Delete contact ${contactName(contact)}?`}
            description="The contact moves to the Trash and can be restored for 60 days. Their vehicles and job cards stay in place."
          />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-w-0">
          <Tabs
            tabs={[
              {
                key: "details",
                label: "Details",
                content: (
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
              {
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
              },
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
                count: contact.research ? 1 : 0,
                content: (
                  <div className="card space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="font-semibold">🔎 AI research</h2>
                      <ResearchButton contactId={contact.id} configured={aiOn} />
                    </div>
                    {!contact.research ? (
                      <p className="text-sm text-slate-400">
                        No research yet. Use the Research button to generate a briefing on this
                        customer and the company behind the email.
                      </p>
                    ) : (
                      <div>
                        {contact.researchedAt && (
                          <p className="text-xs text-slate-500 mb-1.5">
                            {formatDateTime(contact.researchedAt)}
                          </p>
                        )}
                        <p className="text-sm whitespace-pre-wrap leading-relaxed text-slate-200">
                          {contact.research}
                        </p>
                      </div>
                    )}
                  </div>
                ),
              },
              {
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
                        <code className="text-xl font-bold tracking-widest text-orange-400 bg-slate-800 rounded-lg px-4 py-2">
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
                                <form
                                  action={redeemReferral.bind(null, r.id)}
                                  className="flex items-center gap-1.5 mt-2"
                                >
                                  <input
                                    name="note"
                                    required
                                    className="input btn-sm flex-1 text-xs"
                                    placeholder="What was given? e.g. R1,000 service voucher"
                                  />
                                  <button className="btn-primary btn-sm">Redeem</button>
                                </form>
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
              },
              {
                key: "documents",
                label: "Documents",
                count: contact.documents.length,
                content: (
                  <DocumentsPanel
                    documents={contact.documents}
                    contactId={contact.id}
                    revalidate={path}
                  />
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
    </div>
  );
}
