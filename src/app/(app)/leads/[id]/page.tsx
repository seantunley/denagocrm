import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  markWon,
  markLost,
  reopenLead,
  deleteLead,
  linkLeadToContact,
} from "@/app/actions/leads";
import CommsTimeline from "@/components/CommsTimeline";
import ActivityPanel from "@/components/ActivityPanel";
import EmailComposer from "@/components/EmailComposer";
import LeadTimeline from "@/components/LeadTimeline";
import ConfirmDelete from "@/components/ConfirmDelete";
import { requireUser } from "@/lib/auth";
import { isSmtpConfigured, renderTemplate, leadVars } from "@/lib/email";
import { contactName, formatDate, formatZAR } from "@/lib/format";

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
    },
  });
  if (!lead) notFound();
  const [contacts, users, templates, smtpConfigured, audit] = await Promise.all([
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
    isSmtpConfigured(),
    prisma.auditLog.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  const vars = leadVars(lead);
  const renderedTemplates = templates.map((t) => ({
    id: t.id,
    name: t.name,
    subject: renderTemplate(t.subject, vars),
    body: renderTemplate(t.body, vars),
  }));
  const path = `/leads/${lead.id}`;

  const statusBadge =
    lead.status === "won"
      ? "bg-emerald-500/15 text-emerald-300"
      : lead.status === "lost"
      ? "bg-red-500/15 text-red-300"
      : "bg-blue-500/15 text-blue-300";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{lead.title}</h1>
            <span className={`badge ${statusBadge}`}>
              {lead.status === "open" ? lead.stage.name : lead.status.toUpperCase()}
            </span>
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            {lead.name} · {lead.source} · added {formatDate(lead.createdAt)}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {lead.status === "open" && (
            <>
              <form action={markWon.bind(null, lead.id)}>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  ✓ Mark won
                </button>
              </form>
              <Link href={`/leads/${lead.id}/edit`} className="btn-secondary">
                Edit
              </Link>
            </>
          )}
          {lead.status !== "open" && (
            <form action={reopenLead.bind(null, lead.id)}>
              <button className="btn-secondary">Reopen</button>
            </form>
          )}
          <ConfirmDelete
            action={deleteLead.bind(null, lead.id)}
            title={`Delete lead “${lead.title}”?`}
            description="The lead moves to the Trash and can be restored for 60 days."
          />
        </div>
      </div>

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
        <div className="space-y-6">
          <div className="card">
            <h2 className="font-semibold mb-3">Details</h2>
            <dl className="space-y-2 text-sm">
              {[
                ["Customer", lead.name],
                ["Email", lead.email],
                ["Phone", lead.phone],
                ["Product", lead.product?.name],
                ["Colour", lead.color],
                ["Value", lead.valueCents ? formatZAR(lead.valueCents) : null],
                ["Assigned to", lead.assignedTo?.name],
                ["Source", lead.source],
                ["Lost reason", lead.lostReason],
              ].map(([label, value]) =>
                value ? (
                  <div key={label as string} className="flex justify-between gap-4">
                    <dt className="text-slate-400">{label}</dt>
                    <dd className="text-right font-medium">{value as string}</dd>
                  </div>
                ) : null
              )}
            </dl>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-3">Contact</h2>
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
                {lead.contact ? "Change linked contact" : "Link to contact"}
              </label>
              <select
                name="contactId"
                className="input"
                defaultValue={lead.contactId ?? ""}
              >
                <option value="">Select contact…</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {contactName(c)}
                  </option>
                ))}
              </select>
              <button className="btn-secondary btn-sm w-full">Save contact link</button>
            </form>
          </div>

          {lead.status === "open" && (
            <div className="card">
              <h2 className="font-semibold mb-3">Mark as lost</h2>
              <form action={markLost.bind(null, lead.id)} className="space-y-2">
                <input
                  name="lostReason"
                  className="input"
                  placeholder="Reason (optional)"
                />
                <button className="btn-danger btn-sm w-full">Mark lost</button>
              </form>
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
        </div>

        <div className="space-y-6">
          <ActivityPanel
            activities={lead.activities}
            users={users}
            currentUserId={user.id}
            leadId={lead.id}
            revalidate={path}
          />
          <EmailComposer
            defaultTo={lead.email ?? ""}
            templates={renderedTemplates}
            smtpConfigured={smtpConfigured}
            leadId={lead.id}
            revalidate={path}
          />
          <CommsTimeline
            communications={lead.communications}
            leadId={lead.id}
            revalidate={path}
          />
        </div>

        <LeadTimeline
          leadId={lead.id}
          revalidate={path}
          audit={audit}
          communications={lead.communications}
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
    </div>
  );
}
