import Link from "next/link";
import { Suspense } from "react";
import OpenRecordLink from "@/components/records/OpenRecordLink";
import RecordDrawer from "@/components/records/RecordDrawer";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { ListFilter } from "lucide-react";
import { subDays } from "date-fns";
import { prisma } from "@/lib/db";
import { pageWindow, parsePage } from "@/lib/listPaging";
import ListPager from "@/components/ListPager";
import { saveView, deleteView } from "@/app/actions/views";
import { currencySymbol, formatDate, formatZAR, type MoneyFormat } from "@/lib/format";
import { totalsByCurrency, withCurrency } from "@/lib/currencyRules";
import { getAccessibleLeadIds, hasPermission, requireAnyPermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listPipelineStages } from "@/lib/pipelines";
import MobileFilterDrawer from "@/components/MobileFilterDrawer";
import { EmptyState, StatusPill } from "@/components/visual-system";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
  StickyActionArea,
} from "@/components/responsive-patterns";
import RecordContextMenu, { type RecordContextAction } from "@/components/RecordContextMenu";
import AddToContactsButton from "@/components/AddToContactsButton";
import { contactName } from "@/lib/format";
import { getRegionalSettings } from "@/lib/settings";
import { formatDue } from "@/lib/format";
import { isOverdueActivity } from "@/lib/activityDay";
import { switchLeadsView } from "@/app/actions/leadsView";
import { attentionFor, rankedLeads, worklistColumns, worklistCounts } from "@/lib/salesWorklist";
import { HEALTH, WORKLIST_SORTS, WORKLIST_VIEWS, daysSince, urgencyOf, worklistOrderBy, worklistSort, worklistView, worklistWhere } from "@/lib/salesWorklistRules";
import { johannesburgStartOfDay } from "@/lib/activityDay";
import { Plus, Zap } from "lucide-react";
import { CentreCards, CentreHeader, CentreMain, Panel, ViewChips } from "@/components/centre";
import { NextBestActions, SalesCentreCards, SalesCentreStats } from "./SalesCentreParts";

export const metadata = { title: "Lead list" };

type Params = {
  /** The worklist view (salesWorklistRules.ts) and its sort. */
  show?: string;
  sort?: string;
  status?: string;
  source?: string;
  pipeline?: string;
  stageId?: string;
  minValue?: string;
  days?: string;
  page?: string;
};

type FilterOption = { id: string; name: string };

export default async function LeadListPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const params = await searchParams;
  const status = params.status || "";
  const source = params.source || "";
  const pipelineId = params.pipeline || "";
  const stageId = params.stageId || "";
  const minValue = parseInt(params.minValue || "", 10);
  const days = parseInt(params.days || "", 10);
  const now = new Date();
  const view = worklistView(params.show, Boolean(status || source || pipelineId || stageId || params.minValue || params.days));
  const sort = worklistSort(params.sort);

  const [pipelines, accessibleIds, views, canEdit, canManageActivities, ranked] = await Promise.all([
    listActiveSalesPipelines(),
    getAccessibleLeadIds(user),
    prisma.savedView.findMany({ where: { page: "leads" }, orderBy: { createdAt: "asc" } }),
    hasPermission(user, "leads.edit"),
    hasPermission(user, "activities.manage"),
    rankedLeads(user, view, now),
  ]);
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;
  const stages = selectedPipeline
    ? await listPipelineStages(selectedPipeline.id)
    : (await Promise.all(pipelines.map((pipeline) => listPipelineStages(pipeline.id)))).flat();
  const selectedPipelineStageIds = selectedPipeline ? stages.map((stage) => stage.id) : [];

  const filtersWhere = {
    ...(accessibleIds ? { id: { in: accessibleIds } } : {}),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(stageId
      ? { stageId }
      : selectedPipeline
        ? { stageId: { in: selectedPipelineStageIds } }
        : {}),
    ...(!isNaN(minValue) && minValue > 0 ? { valueCents: { gte: minValue * 100 } } : {}),
    ...(!isNaN(days) && days > 0 ? { createdAt: { gte: subDays(new Date(), days) } } : {}),
  };
  // The filters, AND the view: a view narrows, it never widens what the filters and access allow.
  const where = {
    AND: [filtersWhere, worklistWhere(view, now), ...(ranked ? [{ id: { in: ranked.map((row) => row.id) } }] : [])],
  };
  // Paged in the database, so every matching lead is reachable, and the count
  // and value in the footer cover the whole match rather than the newest 200.
  const [total, sum] = await Promise.all([
    prisma.lead.count({ where }),
    // A total PER CURRENCY (multicurrency module): rubles and rand are never added together.
    prisma.lead.groupBy({ by: ["currency"], where, _sum: { valueCents: true } }),
  ]);
  const { page, skip, take } = pageWindow(parsePage(params.page), total);
  const include = { stage: true, product: true, contact: true, assignedTo: true } as const;
  // A ranked view keeps its own order unless another sort is picked. It is bounded
  // (Today's candidate cap, the Attention list), so it is ordered here and paged after.
  const byRank = ranked && !sort ? new Map(ranked.map((row, index) => [row.id, index])) : null;
  const leads = byRank
    ? (await prisma.lead.findMany({ where, include }))
        .sort((a, b) => (byRank.get(a.id) ?? 0) - (byRank.get(b.id) ?? 0))
        .slice(skip, skip + take)
    : await prisma.lead.findMany({ where, include, orderBy: worklistOrderBy(sort), skip, take });
  const leadIds = leads.map((lead) => lead.id);
  const [{ next, last }, attention, counts] = await Promise.all([
    worklistColumns(leadIds),
    attentionFor(user, leads.filter((lead) => lead.status === "open").map((lead) => lead.id), now),
    worklistCounts(user, filtersWhere, now),
  ]);
  const why = ranked
    ? new Map(ranked.map((row) => [row.id, row.reason]))
    : new Map([...attention].filter(([, a]) => a.reason).map(([id, a]) => [id, a.reason]));
  const todayEnd = new Date(johannesburgStartOfDay(now).getTime() + 86_400_000);

  // `page` is navigation, not a filter: it must not end up in a saved view or
  // the active-filter badge.
  const filters = Object.entries(params).filter(([key, value]) => key !== "page" && value);
  const currentQuery = new URLSearchParams(Object.fromEntries(filters) as Record<string, string>).toString();
  const activeFilterCount = filters.length;

  const moneyFmt = await getRegionalSettings();
  const totalValueText = totalsByCurrency(sum, (row) => ({ cents: row._sum.valueCents ?? 0, currency: row.currency }), moneyFmt.currency)
    .map((row) => formatZAR(row.cents, withCurrency(moneyFmt, row.currency)))
    .join(" · ");
  const filterProps = { params, status, source, pipelineId, stageId, pipelines, stages, moneyFmt, view, sort };

  return (
    <div className="space-y-5">
      <CentreHeader
        title="Sales Centre"
        description="Your opportunities as a worklist: what to do next, what is late, what is at risk."
        note="Ranked by the Today score and the Attention Centre"
        actions={
          <>
            <form action={switchLeadsView.bind(null, "board")}>
              <button className="btn-secondary btn-sm" title="Show the deals as a board. The board opens for you from now on.">Board view</button>
            </form>
            <Link href="/leads/new" className="btn-primary btn-sm"><Plus className="size-4" />New lead</Link>
          </>
        }
      />

      <SalesCentreStats user={user} now={now} money={moneyFmt} />

      <CentreMain aside={<NextBestActions user={user} now={now} />}>
      <Panel icon={Zap} title="Opportunity worklist" description="Pick a view, filter and sort; save the ones you use.">
      <ViewChips
        label="Worklist views"
        active={view}
        chips={WORKLIST_VIEWS.map((option) => ({ key: option.key, label: option.label, hint: option.hint, href: `/leads/list?show=${option.key}`, count: counts[option.key] }))}
      />

      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Saved views:</span>
          {views.map((view) => (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Link href={`/leads/list?${view.query}`} className={`badge cursor-pointer ${currentQuery === view.query ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}>{view.name}</Link>
              <SaveForm success="View deleted" resetOnSuccess={false} action={deleteView.bind(null, view.id)}><SaveButton className="text-xs text-muted-foreground hover:text-red-400" title="Delete view">×</SaveButton></SaveForm>
            </span>
          ))}
        </div>
      )}

      <MobileFilterDrawer activeCount={activeFilterCount} title="Lead filters">
        <form method="GET" className="space-y-4 [&_.input]:w-full">
          <LeadFilterFields {...filterProps} />
          <StickyActionArea className="grid grid-cols-2">
            <button className="btn-primary">Apply filters</button>
            {currentQuery ? <Link href={`/leads/list?show=${view}`} className="btn-secondary">Clear</Link> : <span />}
          </StickyActionArea>
        </form>
      </MobileFilterDrawer>

      {/* Folded away until wanted (the mockup's list leads with the deals); open while a filter is on. */}
      <details className="group mb-3 hidden sm:block" open={filters.some(([key]) => key !== "show")}>
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          Filters and sort{activeFilterCount > 1 ? ` (${activeFilterCount - 1} on)` : ""}
        </summary>
        <form method="GET" className="mt-2 flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
          <LeadFilterFields {...filterProps} />
          <button className="btn-primary btn-sm">Filter</button>
          {currentQuery && <Link href={`/leads/list?show=${view}`} className="btn-secondary btn-sm">Clear</Link>}
        </form>
      </details>

      {currentQuery && (
        <SaveForm success="View saved" action={saveView} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="page" value="leads" />
          <input type="hidden" name="query" value={currentQuery} />
          <input name="name" className="input text-sm sm:w-64" placeholder="Name this view" required />
          <SaveButton className="btn-secondary btn-sm">Save view</SaveButton>
        </SaveForm>
      )}

      {leads.length === 0 ? (
        <EmptyState icon={ListFilter} title="No deals in this view" description={WORKLIST_VIEWS.find((option) => option.key === view)?.hint ?? "Clear or adjust the active filters to widen the result set."} />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {leads.map((lead) => (
                <RecordContextMenu
                  key={lead.id}
                  label={lead.name}
                  href={`/leads/${lead.id}`}
                  actions={leadListActions(lead.id, canEdit, canManageActivities)}
                >
                <MobileDataCard>
                  <MobileDataHeader
                    title={<span data-record-open={`lead:${lead.id}`}><OpenRecordLink record={{ type: "lead", id: lead.id }} className="text-primary hover:underline">{lead.name}</OpenRecordLink></span>}
                    detail={lead.title}
                    aside={<StatusPill tone={lead.status === "won" ? "success" : lead.status === "lost" ? "danger" : "info"}>{lead.status === "open" ? lead.stage.name : lead.status}</StatusPill>}
                  />
                  <MobileDataFields>
                    {why.get(lead.id) && <MobileDataField label="Why">{why.get(lead.id)}</MobileDataField>}
                    <MobileDataField label="Next action"><NextActionCell action={next.get(lead.id)} now={now} /></MobileDataField>
                    <MobileDataField label="Value">{lead.valueCents > 0 ? formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency)) : "—"}</MobileDataField>
                    <MobileDataField label="Source"><span className="capitalize">{lead.source}</span></MobileDataField>
                    <MobileDataField label="Assigned">{lead.assignedTo?.name ?? "Unassigned"}</MobileDataField>
                    <MobileDataField label="Created">{formatDate(lead.createdAt)}</MobileDataField>
                    <MobileDataField label="Contact">
                      {lead.contact
                        ? <Link href={`/contacts/${lead.contact.id}`} className="text-primary hover:underline">{contactName(lead.contact)}</Link>
                        : <AddToContactsButton leadId={lead.id} />}
                    </MobileDataField>
                  </MobileDataFields>
                </MobileDataCard>
                </RecordContextMenu>
              ))}
              <div className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                {total} lead{total !== 1 ? "s" : ""} · <span className="font-semibold text-foreground">{totalValueText}</span> total
              </div>
              <ListPager path="/leads/list" page={page} total={total} />
            </MobileDataList>
          }
          desktop={
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead><tr><th>Customer / deal</th><th className="text-right">Amount</th><th>Stage</th><th>Owner</th><th>Health</th><th>Last activity</th><th>Next action</th></tr></thead>
                <tbody>
                  {leads.map((lead) => (
                    <RecordContextMenu
                      key={lead.id}
                      label={lead.name}
                      href={`/leads/${lead.id}`}
                      actions={leadListActions(lead.id, canEdit, canManageActivities)}
                    >
                    <tr tabIndex={0} data-nav-row="" data-nav-href={`/leads/${lead.id}`} data-nav-lead={lead.id} data-record-open={`lead:${lead.id}`} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                      <td>
                        {/* A click opens the deal beside the list (W2-03); Ctrl/middle-click and Enter on the row still open the full page. */}
                        <OpenRecordLink record={{ type: "lead", id: lead.id }} className="font-medium text-primary hover:underline">{lead.name}</OpenRecordLink>
                        <p className="max-w-60 truncate text-xs text-muted-foreground">
                          {lead.title}
                          {lead.contact && lead.title ? " · " : ""}
                          {lead.contact && <Link href={`/contacts/${lead.contact.id}`} className="hover:underline">{contactName(lead.contact)}</Link>}
                        </p>
                        {!lead.contact && <AddToContactsButton leadId={lead.id} />}
                        {why.get(lead.id) && <p className="line-clamp-2 max-w-56 text-xs text-muted-foreground" title={why.get(lead.id)}>{why.get(lead.id)}</p>}
                      </td>
                      <td className="whitespace-nowrap text-right font-medium tabular-nums">{lead.valueCents > 0 ? formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency)) : "—"}</td>
                      <td className="whitespace-nowrap">
                        {lead.status === "open" ? <span className="badge text-white" style={{ backgroundColor: lead.stage.color }}>{lead.stage.name}</span> : <StatusPill tone={lead.status === "won" ? "success" : lead.status === "lost" ? "danger" : "info"}>{lead.status}</StatusPill>}
                        {lead.status === "open" && <p className="mt-0.5 text-xs text-muted-foreground">{daysSince(lead.stageEnteredAt, now)} d in stage</p>}
                      </td>
                      <td className="whitespace-nowrap text-sm text-muted-foreground" title={lead.assignedTo?.name}>{lead.assignedTo?.name.split(/\s+/)[0] ?? "Unassigned"}</td>
                      <td className="whitespace-nowrap">{lead.status === "open" ? <HealthPill band={attention.get(lead.id)?.band} /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="whitespace-nowrap text-sm text-muted-foreground">{last.get(lead.id) ? formatDate(last.get(lead.id)) : "—"}</td>
                      <td className="text-sm">
                        <NextActionCell action={next.get(lead.id)} now={now} />
                        {lead.status === "open" && (
                          <span className="mt-1 block" title="Urgency: High when the Attention Centre says urgent or the next step is late; Medium when it says act, the step is today or nothing is planned.">
                            <StatusPill tone={URGENCY_TONE[urgencyOf(attention.get(lead.id)?.band, next.get(lead.id), now, todayEnd)]}>{urgencyOf(attention.get(lead.id)?.band, next.get(lead.id), now, todayEnd)} urgency</StatusPill>
                          </span>
                        )}
                      </td>
                    </tr>
                    </RecordContextMenu>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{total} lead{total !== 1 ? "s" : ""} · total value <span className="font-semibold text-foreground">{totalValueText}</span></p>
              <ListPager path="/leads/list" page={page} total={total} className="border-t border-border" />
            </div>
          }
        />
      )}
      </Panel>
      </CentreMain>

      <CentreCards>
        <SalesCentreCards user={user} now={now} money={moneyFmt} />
      </CentreCards>

      {/* The deal opened from the list (?open=lead:<id>): it re-checks access itself. */}
      <Suspense fallback={null}>
        <RecordDrawer />
      </Suspense>
    </div>
  );
}

const URGENCY_TONE = { High: "danger", Medium: "warning", Low: "neutral" } as const;

function HealthPill({ band }: { band?: string }) {
  const health = HEALTH[band ?? "none"] ?? HEALTH.none;
  return <StatusPill tone={health.tone}>{health.label}</StatusPill>;
}

/** The next planned activity and when; red once its time has gone. None = say so, it is a gap. */
function NextActionCell({ action, now }: { action?: { summary: string; dueDate: Date; allDay: boolean }; now: Date }) {
  if (!action) return <span className="text-muted-foreground">No next step</span>;
  const late = isOverdueActivity(action, now);
  return (
    <span>
      <span className="block max-w-36 truncate" title={action.summary}>{action.summary}</span>
      <span className={`whitespace-nowrap text-xs ${late ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
        {action.allDay ? formatDate(action.dueDate) : formatDue(action.dueDate)}
        {late ? " · overdue" : ""}
      </span>
    </span>
  );
}

function leadListActions(
  leadId: string,
  canEdit: boolean,
  canManageActivities: boolean,
): RecordContextAction[] {
  return [
    ...(canEdit
      ? [{ label: "Edit lead", href: `/leads/${leadId}?edit=1`, icon: "edit" as const }]
      : []),
    ...(canManageActivities
      ? [{
          label: "Schedule activity",
          href: `/leads/${leadId}?tab=activities&schedule=1`,
          icon: "calendar" as const,
        }]
      : []),
  ];
}

function LeadFilterFields({ params, status, source, pipelineId, stageId, pipelines, stages, moneyFmt, view, sort }: {
  moneyFmt: MoneyFormat;
  view: string;
  sort: string;
  params: Params;
  status: string;
  source: string;
  pipelineId: string;
  stageId: string;
  pipelines: FilterOption[];
  stages: FilterOption[];
}) {
  return (
    <>
      {/* The view the filters narrow; switching view is the chips above. */}
      <input type="hidden" name="show" value={view} />
      <label className="space-y-1"><span className="label">Sort</span><select name="sort" className="input w-40" defaultValue={sort}>{WORKLIST_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
      <label className="space-y-1"><span className="label">Status</span><select name="status" className="input w-32" defaultValue={status}><option value="">Any</option><option value="open">Open</option><option value="nurture">Nurture</option><option value="won">Won</option><option value="lost">Lost</option></select></label>
      <label className="space-y-1"><span className="label">Source</span><select name="source" className="input w-36" defaultValue={source}><option value="">Any</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="website">Website</option><option value="whatsapp">WhatsApp</option><option value="referral">Referral</option><option value="manual">Manual</option><option value="walk-in">Walk-in</option></select></label>
      <label className="space-y-1"><span className="label">Pipeline</span><select name="pipeline" className="input w-44" defaultValue={pipelineId}><option value="">Any</option>{pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</select></label>
      <label className="space-y-1"><span className="label">Stage</span><select name="stageId" className="input w-40" defaultValue={stageId}><option value="">Any</option>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      <label className="space-y-1"><span className="label">Value at least ({currencySymbol(moneyFmt)})</span><input name="minValue" type="number" className="input w-32" defaultValue={params.minValue ?? ""} /></label>
      <label className="space-y-1"><span className="label">Created in last days</span><input name="days" type="number" className="input w-32" defaultValue={params.days ?? ""} /></label>
    </>
  );
}
