import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  addJobCardItem,
  deleteJobCardItem,
  setJobCardStatus,
  completeJobCard,
  deleteJobCard,
} from "@/app/actions/jobcards";
import DocumentsPanel from "@/components/DocumentsPanel";
import ConfirmDelete from "@/components/ConfirmDelete";
import SigningBlock from "@/components/SigningBlock";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export default async function JobCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jobCard = await prisma.jobCard.findUnique({
    where: { id },
    include: {
      vehicle: true,
      contact: true,
      items: true,
      serviceRecord: true,
      documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!jobCard) notFound();
  const path = `/jobcards/${jobCard.id}`;

  const partsTotal = jobCard.items
    .filter((i) => i.kind === "part")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const labourTotal = jobCard.items
    .filter((i) => i.kind === "labour")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const grandTotal = partsTotal + labourTotal;

  const statusBadge =
    jobCard.status === "completed"
      ? "bg-emerald-500/15 text-emerald-300"
      : jobCard.status === "in_progress"
      ? "bg-amber-500/15 text-amber-300"
      : "bg-slate-800 text-slate-400";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Job card #{jobCard.number}</h1>
            <span className={`badge ${statusBadge}`}>{jobCard.status.replace("_", " ")}</span>
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            <Link href={`/vehicles/${jobCard.vehicleId}`} className="text-orange-400 hover:underline">
              {jobCard.vehicle.model}
            </Link>
            {" · "}
            <Link href={`/contacts/${jobCard.contactId}`} className="text-orange-400 hover:underline">
              {contactName(jobCard.contact)}
            </Link>
            {" · opened "}
            {formatDate(jobCard.openedAt)}
            {jobCard.kmIn != null ? ` at ${jobCard.kmIn.toLocaleString()} km` : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={`/jobcards/${jobCard.id}/print`} className="btn-secondary">
            🖨 Print
          </Link>
          {jobCard.status === "open" && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "in_progress")}>
              <button className="btn bg-amber-500 text-white hover:bg-amber-600">
                ▶ Start work
              </button>
            </form>
          )}
          {jobCard.status === "completed" && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "open")}>
              <button className="btn-secondary">Reopen</button>
            </form>
          )}
          <ConfirmDelete
            action={deleteJobCard.bind(null, jobCard.id)}
            title={`Delete job card #${jobCard.number}?`}
            description="The job card moves to the Trash and can be restored for 60 days."
          />
        </div>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-2">Work requested</h2>
        <p className="text-sm text-slate-400 whitespace-pre-wrap">{jobCard.description}</p>
      </div>

      <SigningBlock
        kind="jobcard"
        id={jobCard.id}
        refLabel={`#${jobCard.number}`}
        signToken={jobCard.signToken}
        signedAt={jobCard.signedAt}
        signedByName={jobCard.signedByName}
        customerEmail={jobCard.contact.email}
        customerPhone={jobCard.contact.whatsapp ?? jobCard.contact.phone}
      />

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          <div className="card">
            <h2 className="font-semibold mb-4">Parts &amp; labour</h2>
            <table className="table-base mb-4">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobCard.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-400 py-4">
                      No items added.
                    </td>
                  </tr>
                )}
                {jobCard.items.map((i) => (
                  <tr key={i.id}>
                    <td className="capitalize">{i.kind}</td>
                    <td>{i.description}</td>
                    <td className="text-right">{i.qty}</td>
                    <td className="text-right">{formatZAR(i.unitPriceCents)}</td>
                    <td className="text-right font-medium">
                      {formatZAR(Math.round(i.qty * i.unitPriceCents))}
                    </td>
                    <td className="text-right">
                      {jobCard.status !== "completed" && (
                        <ConfirmDelete
                          action={deleteJobCardItem.bind(null, i.id, jobCard.id)}
                          title={`Remove “${i.description}”?`}
                          description="This cannot be undone. The removal is recorded in the customer history."
                          trigger="✕"
                          triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {jobCard.status !== "completed" && (
              <form
                action={addJobCardItem.bind(null, jobCard.id)}
                className="grid grid-cols-12 gap-2 items-end rounded-lg bg-slate-800/40 p-3 border border-slate-800"
              >
                <div className="col-span-2">
                  <label className="label">Type</label>
                  <select name="kind" className="input">
                    <option value="part">Part</option>
                    <option value="labour">Labour</option>
                  </select>
                </div>
                <div className="col-span-5">
                  <label className="label">Description</label>
                  <input name="description" className="input" required />
                </div>
                <div className="col-span-1">
                  <label className="label">Qty</label>
                  <input name="qty" className="input" defaultValue="1" inputMode="decimal" />
                </div>
                <div className="col-span-2">
                  <label className="label">Unit (R)</label>
                  <input name="unitPrice" className="input" inputMode="decimal" />
                </div>
                <div className="col-span-2">
                  <button className="btn-primary w-full">Add</button>
                </div>
              </form>
            )}

            <div className="flex justify-end mt-4">
              <dl className="text-sm space-y-1 w-56">
                <div className="flex justify-between">
                  <dt className="text-slate-400">Parts</dt>
                  <dd className="font-medium">{formatZAR(Math.round(partsTotal))}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Labour</dt>
                  <dd className="font-medium">{formatZAR(Math.round(labourTotal))}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-800 pt-1">
                  <dt className="font-semibold">Total</dt>
                  <dd className="font-bold">{formatZAR(Math.round(grandTotal))}</dd>
                </div>
              </dl>
            </div>
          </div>

          {jobCard.status !== "completed" ? (
            <div className="card border-emerald-500/30">
              <h2 className="font-semibold mb-1">Complete job card</h2>
              <p className="text-xs text-slate-400 mb-4">
                Completing writes a service record on the vehicle. Next-due values default to the
                vehicle&apos;s service intervals if left blank.
              </p>
              <form action={completeJobCard.bind(null, jobCard.id)} className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="label">Mileage (km)</label>
                    <input
                      type="number"
                      name="km"
                      className="input"
                      defaultValue={jobCard.kmIn ?? ""}
                    />
                  </div>
                  <div>
                    <label className="label">Next due (km)</label>
                    <input type="number" name="nextDueKm" className="input" placeholder="auto" />
                  </div>
                  <div>
                    <label className="label">Next due (date)</label>
                    <input type="date" name="nextDueDate" className="input" />
                  </div>
                  <div className="col-span-2 md:col-span-4">
                    <label className="label">Service summary</label>
                    <input
                      name="summary"
                      className="input"
                      placeholder={jobCard.description}
                    />
                  </div>
                  <div className="col-span-2 md:col-span-4">
                    <label className="label">Work done / notes</label>
                    <textarea name="details" className="input" rows={2} />
                  </div>
                </div>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  ✓ Complete &amp; write service record
                </button>
              </form>
            </div>
          ) : (
            jobCard.serviceRecord && (
              <div className="card bg-emerald-500/10 border-emerald-500/30">
                <h2 className="font-semibold text-emerald-300 mb-1">
                  Completed {formatDate(jobCard.completedAt)}
                </h2>
                <p className="text-sm text-emerald-300">
                  Service record: {jobCard.serviceRecord.summary}
                  {jobCard.serviceRecord.nextDueDate
                    ? ` — next due ${formatDate(jobCard.serviceRecord.nextDueDate)}`
                    : ""}
                  {jobCard.serviceRecord.nextDueKm != null
                    ? ` at ${jobCard.serviceRecord.nextDueKm.toLocaleString()} km`
                    : ""}
                </p>
              </div>
            )
          )}
        </div>

        <DocumentsPanel documents={jobCard.documents} jobCardId={jobCard.id} revalidate={path} />
      </div>
    </div>
  );
}
