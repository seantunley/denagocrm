import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { claimColors, claimStatuses } from "@/lib/warranty";
import { hasPermission, requireAnyPermission, requireVehicleReadAccess } from "@/lib/permissions";
import {
  deleteWarrantyClaimFromPage,
  setWarrantyClaimStatus,
  updateWarrantyClaimDescription,
} from "@/app/actions/warranty";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmDelete from "@/components/ConfirmDelete";
import { WorkspaceHero } from "@/components/workspace-hero";

export const dynamic = "force-dynamic";

/**
 * One warranty claim (gap audit #20: claims had no page of their own — they were
 * a line on the vehicle and a row in the Warranty list).
 *
 * The page guards itself, not only through warranty/[id]/layout.tsx: a layout
 * does not re-run on client navigation. Read access is the warranty grant plus
 * access to the claim's vehicle; the forms are offered only with warranty.manage,
 * and every action checks the same again on the server.
 */
export default async function WarrantyClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAnyPermission("warranty.view", "warranty.manage");
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id },
    include: { vehicle: { include: { contact: true } } },
  });
  if (!claim) notFound();
  await requireVehicleReadAccess(claim.vehicleId);
  const canManage = await hasPermission(user, "warranty.manage");

  const [jobCard, openedBy] = await Promise.all([
    claim.jobCardId
      ? prisma.jobCard.findFirst({ where: { id: claim.jobCardId, deletedAt: null }, select: { id: true, number: true, status: true } })
      : null,
    // Only the name: User is a global model, so nothing else about the account is read.
    claim.createdById ? prisma.user.findUnique({ where: { id: claim.createdById }, select: { name: true } }) : null,
  ]);
  const owner = claim.vehicle.contact;

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={ShieldCheck}
        eyebrow="Warranty claim"
        title={`${claim.vehicle.model} — warranty claim`}
        description={`Opened ${formatDate(claim.claimedAt)}${openedBy?.name ? ` by ${openedBy.name}` : ""}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${claimColors[claim.status]}`}>{claim.status}</span>
            <a href={`/warranty/${claim.id}/print`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">Print claim</a>
            {canManage && (
              <ConfirmDelete
                action={deleteWarrantyClaimFromPage.bind(null, claim.id)}
                title="Delete this warranty claim?"
                description="The claim is permanently removed — it does not go to Trash. Consider setting it to resolved or rejected instead."
                triggerClass="btn-danger btn-sm"
              />
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card space-y-2 text-sm lg:col-span-1">
          <h2 className="font-semibold mb-2">Details</h2>
          <p><span className="text-slate-400">Vehicle: </span><Link href={`/vehicles/${claim.vehicleId}`} className="text-orange-400 hover:underline">{claim.vehicle.model}</Link></p>
          <p><span className="text-slate-400">Owner: </span><Link href={`/contacts/${owner.id}`} className="text-orange-400 hover:underline">{contactName(owner)}</Link></p>
          {jobCard && (
            <p><span className="text-slate-400">Job card: </span><Link href={`/jobcards/${jobCard.id}`} className="text-orange-400 hover:underline">JC-{jobCard.number}</Link> <span className="text-xs text-slate-500">({jobCard.status})</span></p>
          )}
          <p><span className="text-slate-400">Opened: </span>{formatDate(claim.claimedAt)}</p>
          {claim.resolvedAt && <p><span className="text-slate-400">{claim.status === "rejected" ? "Rejected" : "Resolved"}: </span>{formatDate(claim.resolvedAt)}</p>}
        </div>

        <div className="space-y-6 lg:col-span-2">
          <div className="card">
            <h2 className="font-semibold mb-3">Fault</h2>
            {canManage ? (
              <SaveForm action={updateWarrantyClaimDescription.bind(null, claim.id)} resetOnSuccess={false} className="space-y-2">
                <textarea name="description" className="input" rows={4} defaultValue={claim.description} required />
                <SaveButton className="btn-secondary btn-sm">Save description</SaveButton>
              </SaveForm>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{claim.description}</p>
            )}
          </div>

          <div className="card">
            <h2 className="font-semibold mb-3">Status & resolution</h2>
            {canManage ? (
              <SaveForm action={setWarrantyClaimStatus.bind(null, claim.id)} resetOnSuccess={false} className="space-y-2">
                <select name="status" defaultValue={claim.status} className="input">
                  {claimStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
                <textarea name="resolution" className="input" rows={3} defaultValue={claim.resolution ?? ""} placeholder="What was decided or done" />
                <SaveButton className="btn-primary btn-sm">Save</SaveButton>
              </SaveForm>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{claim.resolution || <span className="text-slate-500">No resolution recorded yet.</span>}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
