import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { deleteContact } from "@/app/actions/contacts";
import CommsTimeline from "@/components/CommsTimeline";
import DocumentsPanel from "@/components/DocumentsPanel";
import ActivityPanel from "@/components/ActivityPanel";
import EmailComposer from "@/components/EmailComposer";
import SlideOver from "@/components/SlideOver";
import HistoryTimeline from "@/components/HistoryTimeline";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/lib/auth";
import { isSmtpConfigured, renderTemplate, contactVars } from "@/lib/email";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";

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
      vehicles: { include: { serviceRecords: true, mileageLogs: true } },
      leads: { include: { stage: true, product: true }, orderBy: { createdAt: "desc" } },
      communications: { include: { user: true }, orderBy: { occurredAt: "desc" } },
      documents: { include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      activities: { include: { assignedTo: true }, orderBy: { dueDate: "asc" } },
      tags: true,
      owner: true,
      createdBy: true,
    },
  });
  if (!contact) notFound();
  const [users, templates, smtpConfigured, history] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    isSmtpConfigured(),
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
  ]);
  const vars = contactVars(contact);
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    name: t.name,
    subject: renderTemplate(t.subject, vars),
    body: renderTemplate(t.body, vars),
  }));
  const path = `/contacts/${contact.id}`;

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
          <SlideOver label="🕘 History" title={`History — ${contactName(contact)}`}>
            <HistoryTimeline entries={history} />
          </SlideOver>
          <Link href={`/contacts/${contact.id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <form action={deleteContact.bind(null, contact.id)}>
            <button className="btn-danger">Delete</button>
          </form>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="space-y-6 lg:col-span-1">
          <div className="card">
            <h2 className="font-semibold mb-3">Details</h2>
            <dl className="space-y-2 text-sm">
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
              ].map(([label, value]) => (
                <div key={label as string} className="flex justify-between gap-4">
                  <dt className="text-slate-400">{label}</dt>
                  <dd className="text-right font-medium">{(value as string) ?? "—"}</dd>
                </div>
              ))}
            </dl>
            {contact.notes && (
              <p className="text-sm text-slate-400 mt-3 pt-3 border-t border-slate-800 whitespace-pre-wrap">
                {contact.notes}
              </p>
            )}
          </div>

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
        </div>

        <div className="space-y-6 lg:col-span-2">
          <ActivityPanel
            activities={contact.activities}
            users={users}
            currentUserId={user.id}
            contactId={contact.id}
            revalidate={path}
          />
          <EmailComposer
            defaultTo={contact.email ?? ""}
            templates={renderedTemplates}
            smtpConfigured={smtpConfigured}
            contactId={contact.id}
            revalidate={path}
          />
          <CommsTimeline
            communications={contact.communications}
            contactId={contact.id}
            revalidate={path}
          />
          <DocumentsPanel
            documents={contact.documents}
            contactId={contact.id}
            revalidate={path}
          />
        </div>
      </div>
    </div>
  );
}
