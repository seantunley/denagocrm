import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { portalLogout } from "@/app/actions/portal";
import ServiceRequestForm from "@/components/ServiceRequestForm";
import { computeDue, dueLabels, dueColors } from "@/lib/serviceDue";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export default async function PortalHome() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");

  const [vehicles, quotes] = await Promise.all([
    prisma.vehicle.findMany({
      where: { contactId: contact.id, deletedAt: null },
      include: {
        serviceRecords: { orderBy: { serviceDate: "desc" } },
        mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.quote.findMany({
      where: { contactId: contact.id, deletedAt: null, supersededAt: null },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Hello, {contact.firstName}</h1>
          <p className="text-sm text-slate-400 mt-0.5">Welcome to your Denago Cape Town portal.</p>
        </div>
        <form action={portalLogout}>
          <button className="btn-secondary btn-sm">Sign out</button>
        </form>
      </div>

      {/* Vehicles + service history */}
      <section className="space-y-3">
        <h2 className="font-semibold">Your carts</h2>
        {vehicles.length === 0 ? (
          <div className="card text-sm text-slate-400">
            No carts on file yet. Once you buy or register a cart with us it&apos;ll appear here.
          </div>
        ) : (
          vehicles.map((v) => {
            const due = computeDue(v);
            return (
              <div key={v.id} className="card">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-semibold">
                      {v.model}
                      {v.color ? ` · ${v.color}` : ""}
                    </p>
                    <p className="text-xs text-slate-400">
                      {[v.regNumber, v.vin].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <span className={`badge ${dueColors[due.status]}`}>
                    Service: {dueLabels[due.status]}
                    {due.nextDueDate ? ` · ${formatDate(due.nextDueDate)}` : ""}
                  </span>
                </div>
                {v.serviceRecords.length > 0 && (
                  <div className="mt-3 border-t border-slate-800 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      Service history
                    </p>
                    <ul className="space-y-1.5">
                      {v.serviceRecords.slice(0, 6).map((s) => (
                        <li key={s.id} className="text-sm flex justify-between gap-3">
                          <span>{s.summary}</span>
                          <span className="text-slate-400 shrink-0">{formatDate(s.serviceDate)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* Quotes */}
      {quotes.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold">Your quotes</h2>
          <div className="card p-0 divide-y divide-slate-800">
            {quotes.map((q) => {
              const total = q.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
              const canSign = q.signToken && !q.signedAt && q.status !== "declined";
              return (
                <div key={q.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-medium">Quote Q-{q.number}</p>
                    <p className="text-xs text-slate-400">
                      {formatZAR(Math.round(total))} ·{" "}
                      {q.signedAt ? "Signed" : q.status}
                    </p>
                  </div>
                  {canSign && (
                    <a href={`/sign/quote/${q.signToken}`} className="btn-primary btn-sm">
                      Review &amp; sign
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Request a service */}
      <section className="space-y-3">
        <h2 className="font-semibold">Book a service</h2>
        <div className="card">
          <ServiceRequestForm
            vehicles={vehicles.map((v) => ({
              id: v.id,
              label: v.model + (v.regNumber ? ` (${v.regNumber})` : ""),
            }))}
          />
        </div>
      </section>

      <p className="text-xs text-slate-500 text-center">
        Signed in as {contactName(contact)} · {contact.email}
      </p>
    </div>
  );
}
