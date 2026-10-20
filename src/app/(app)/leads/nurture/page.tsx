import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Sprout, ArrowLeft, CalendarClock } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleLeadIds, hasPermission } from "@/lib/permissions";
import { actingTenantId } from "@/lib/actingTenant";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { listActiveSalesPipelines, listPipelineStages } from "@/lib/pipelines";
import { pageWindow, parsePage, searchTerms, containsText } from "@/lib/listPaging";
import { nurtureReasonLabel, NURTURE_REASONS } from "@/lib/leadNurture";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import ModalTrigger from "@/components/Modal";
import NurtureForm from "@/components/NurtureForm";
import ListPager from "@/components/ListPager";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { queueNurtureFollowUp } from "@/app/actions/nurture";
import { reactivateNurturedLead, markLost } from "@/app/actions/leads";

export const metadata = { title: "Nurture" };

export default async function NurturePage({ searchParams }: { searchParams: Promise<{ q?: string; reason?: string; due?: string; owner?: string; page?: string }> }) {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const params = await searchParams;
  const [tenantId, accessibleIds, users, pipelines, canMove, canActivities, canAssign, canLost] = await Promise.all([
    actingTenantId(), getAccessibleLeadIds(user), listActingTenantStaff(), listActiveSalesPipelines(),
    hasPermission(user, "leads.change_stage"), hasPermission(user, "activities.manage"),
    hasPermission(user, "leads.assign"), hasPermission(user, "leads.mark_lost"),
  ]);
  const stages = (await Promise.all(pipelines.map(async (p) => (await listPipelineStages(p.id)).filter((s) => !s.isClosed).map((s) => ({ ...s, label: `${p.name} · ${s.name}` }))))).flat();
  const now = new Date();
  const todayEnd = new Date(`${new Date(now.getTime() + 7200000).toISOString().slice(0, 10)}T23:59:59.999+02:00`);
  const scope: Prisma.LeadWhereInput = { tenantId, deletedAt: null, status: "nurture", ...(accessibleIds ? { id: { in: accessibleIds } } : {}) };
  const where: Prisma.LeadWhereInput = {
    ...scope,
    ...(params.reason && Object.hasOwn(NURTURE_REASONS, params.reason) ? { nurtureReason: params.reason } : {}),
    ...(params.owner ? { assignedToId: params.owner } : {}),
    ...(params.due === "1" ? { nurtureReviewAt: { lte: todayEnd } } : {}),
    AND: searchTerms(params.q).map((term) => ({ OR: [{ name: containsText(term) }, { title: containsText(term) }, { nurtureInterest: containsText(term) }, { nurtureTrigger: containsText(term) }] })),
  };
  const [total, allCount, dueCount] = await Promise.all([
    prisma.lead.count({ where }), prisma.lead.count({ where: scope }),
    prisma.lead.count({ where: { ...scope, nurtureReviewAt: { lte: todayEnd } } }),
  ]);
  const { page, skip, take } = pageWindow(parsePage(params.page), total);
  const leads = await prisma.lead.findMany({ where, orderBy: [{ nurtureReviewAt: "asc" }, { id: "asc" }], skip, take, include: { assignedTo: { select: { name: true } } } });
  return <div className="space-y-5">
    <PageHeader title="Nurture" description="Future opportunities, with a clear reason to reconnect.">
      <Link href="/leads" className="btn-secondary"><ArrowLeft className="size-4" />Active pipeline</Link>
    </PageHeader>
    <div className="grid gap-3 sm:grid-cols-2">
      <Link href="/leads/nurture" className="rounded-xl border bg-card p-4"><Sprout className="mb-2 size-5 text-emerald-400" /><p className="text-2xl font-semibold">{allCount}</p><p className="text-sm text-muted-foreground">Future opportunities · excluded from active forecast</p></Link>
      <Link href="/leads/nurture?due=1" className="rounded-xl border bg-card p-4"><CalendarClock className="mb-2 size-5 text-amber-400" /><p className="text-2xl font-semibold">{dueCount}</p><p className="text-sm text-muted-foreground">Reviews due today or overdue</p></Link>
    </div>
    <form className="flex flex-wrap items-end gap-3" method="GET">
      <label className="min-w-52 flex-1"><span className="label">Search people or product interests</span><input className="input" name="q" defaultValue={params.q} placeholder="e.g. 4×4, hunting, Andre" /></label>
      <label><span className="label">Reason</span><select name="reason" className="input" defaultValue={params.reason ?? ""}><option value="">All reasons</option>{Object.entries(NURTURE_REASONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label><span className="label">Salesperson</span><select name="owner" className="input" defaultValue={params.owner ?? ""}><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label><span className="label">Review</span><select name="due" className="input" defaultValue={params.due ?? ""}><option value="">All dates</option><option value="1">Due / overdue</option></select></label>
      <button className="btn-primary">Apply</button><Link href="/leads/nurture" className="btn-secondary">Clear</Link>
    </form>
    <p className="text-sm text-muted-foreground">When product information becomes available, search its interest and use “Queue follow-up” to bring each salesperson’s review task forward. No customer messages are sent.</p>
    <ResponsiveEntityTable><table className="table-base"><thead><tr><th>Opportunity</th><th>Waiting for</th><th>Salesperson</th><th>Review</th><th>Actions</th></tr></thead><tbody>
      {!leads.length && <tr><td data-empty colSpan={5} className="py-12 text-center text-muted-foreground">{allCount ? "No opportunities match these filters." : "Nothing in nurture yet. Move a future opportunity here from its pipeline card."}</td></tr>}
      {leads.map((lead) => <tr key={lead.id}>
        <td data-primary data-label="Opportunity"><Link href={`/leads/${lead.id}`} className="font-medium text-primary hover:underline">{lead.name}</Link><p className="mt-1 text-xs text-muted-foreground">{lead.title}</p><p className="mt-1 text-xs text-muted-foreground">Since {formatDate(lead.nurtureSince)}</p></td>
        <td data-label="Waiting for"><p className="font-medium">{lead.nurtureInterest}</p><p className="text-xs text-muted-foreground">{nurtureReasonLabel(lead.nurtureReason)}</p><p className="mt-1 max-w-sm whitespace-pre-wrap text-sm">{lead.nurtureTrigger}</p></td>
        <td data-label="Salesperson">{lead.assignedTo?.name ?? "Unassigned"}</td>
        <td data-label="Review"><span className={lead.nurtureReviewAt && lead.nurtureReviewAt <= todayEnd ? "text-amber-400" : "text-muted-foreground"}>{formatDate(lead.nurtureReviewAt)}{lead.nurtureReviewAt && lead.nurtureReviewAt <= todayEnd ? " · Due" : ""}</span></td>
        <td data-actions><div className="flex flex-wrap gap-2">
          {canMove && canActivities && <>
            <ModalTrigger label="Reactivate" title={`Reactivate ${lead.name}`} buttonClass="btn-primary btn-sm">
              <SaveForm action={reactivateNurturedLead.bind(null, lead.id)} resetOnSuccess={false} className="space-y-4">
                <p className="text-sm text-muted-foreground">Return to the active pipeline with a scheduled next action. Stage rules still apply.</p>
                <label className="block"><span className="label">Stage</span><select name="stageId" className="input" required defaultValue={lead.stageId}>{stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
                <label className="block"><span className="label">Next action</span><input name="summary" className="input" required minLength={3} maxLength={300} placeholder="Call to discuss 4×4 specifications" /></label>
                <label className="block"><span className="label">Action date</span><input type="date" name="dueDate" className="input" required /></label>
                <SaveButton className="btn-primary">Reactivate and schedule</SaveButton>
              </SaveForm>
            </ModalTrigger>
            <ModalTrigger label="Edit / review" title={`Future interest · ${lead.name}`} buttonClass="btn-secondary btn-sm"><NurtureForm leadId={lead.id} users={users} ownerId={lead.assignedToId} canAssign={canAssign} initial={{ reason: lead.nurtureReason, interest: lead.nurtureInterest, trigger: lead.nurtureTrigger, reviewDate: lead.nurtureReviewAt?.toISOString().slice(0, 10) ?? null }} /></ModalTrigger>
          </>}
          {canActivities && <SaveForm action={queueNurtureFollowUp.bind(null, lead.id)} resetOnSuccess={false}><SaveButton className="btn-secondary btn-sm">Queue follow-up</SaveButton></SaveForm>}
          {canLost && <ModalTrigger label="Close lost" title={`Close ${lead.name}`} buttonClass="btn-secondary btn-sm"><SaveForm action={markLost.bind(null, lead.id)} className="space-y-4"><label className="block"><span className="label">Reason lost</span><input name="lostReason" className="input" required placeholder="e.g. No longer interested" /></label><SaveButton className="btn-danger">Close lost</SaveButton></SaveForm></ModalTrigger>}
        </div></td>
      </tr>)}
    </tbody></table></ResponsiveEntityTable>
    <ListPager path="/leads/nurture" page={page} total={total} />
  </div>;
}
