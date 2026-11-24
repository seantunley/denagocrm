import Link from "next/link";
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
import { rankedLeads, riskReasons, worklistColumns } from "@/lib/salesWorklist";
import { WORKLIST_SORTS, WORKLIST_VIEWS, daysSince, worklistOrderBy, worklistSort, worklistView, worklistWhere } from "@/lib/salesWorklistRules";

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
  const [{ next, last }, risk] = await Promise.all([
    worklistColumns(leadIds),
    ranked ? new Map<string, string>() : riskReasons(user, leads.filter((lead) => lead.status === "open").map((lead) => lead.id), now),
  ]);
  const why = ranked ? new Map(ranked.map((row) => [row.id, row.reason])) : risk;

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">Lead list</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your deals as a worklist: pick a view, filter, sort, and save it to come back to in one click.
          </p>
        </div>
        <form action={switchLeadsView.bind(null, "board")}>
          <button className="btn-secondary btn-sm" title="Show the deals as a board. The board opens for you from now on.">Board view</button>
        </form>
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Worklist views">
        {WORKLIST_VIEWS.map((option) => (
          <Link
            key={option.key}
            href={`/leads/list?show=${option.key}`}
            title={option.hint}
            aria-current={view === option.key ? "page" : undefined}
            className={view === option.key ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
          >
            {option.label}
          </Link>
        ))}
      </nav>

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

      <form method="GET" className="card hidden flex-wrap items-end gap-3 p-4 sm:flex">
        <LeadFilterFields {...filterProps} />
        <button className="btn-primary btn-sm">Filter</button>
        {currentQuery && <Link href={`/leads/list?show=${view}`} className="btn-secondary btn-sm">Clear</Link>}
      </form>

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
                    title={<Link href={`/leads/${lead.id}`} className="text-primary hover:underline">{lead.name}</Link>}
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
            <div className="card overflow-x-auto p-0">
              <table className="table-base">
                <thead><tr><th>Lead</th><th>Stage</th><th className="text-right">Value</th><th>Owner</th><th>Next action</th><th>Last activity</th><th>Source</th><th>Contact</th></tr></thead>
                <tbody>
                  {leads.map((lead) => (
                    <RecordContextMenu
                      key={lead.id}
                      label={lead.name}
                      href={`/leads/${lead.id}`}
                      actions={leadListActions(lead.id, canEdit, canManageActivities)}
                    >
                    <tr tabIndex={0} data-nav-row="" data-nav-href={`/leads/${lead.id}`} data-nav-lead={lead.id} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                      <td>
                        <Link href={`/leads/${lead.id}`} className="font-medium text-primary hover:underline">{lead.name}</Link>
                        <p className="max-w-52 truncate text-xs text-muted-foreground">{lead.title}</p>
                        {why.get(lead.id) && <p className="max-w-72 text-xs text-amber-700 dark:text-amber-400">{why.get(lead.id)}</p>}
                      </td>
                      <td>
                        {lead.status === "open" ? <span className="badge text-white" style={{ backgroundColor: lead.stage.color }}>{lead.stage.name}</span> : <StatusPill tone={lead.status === "won" ? "success" : lead.status === "lost" ? "danger" : "info"}>{lead.status}</StatusPill>}
                        {lead.status === "open" && <p className="mt-0.5 text-xs text-muted-foreground">{daysSince(lead.stageEnteredAt, now)} d in stage</p>}
                      </td>
                      <td className="text-right font-medium">{lead.valueCents > 0 ? formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency)) : "—"}</td>
                      <td className="text-sm text-muted-foreground">{lead.assignedTo?.name ?? "Unassigned"}</td>
                      <td className="text-sm"><NextActionCell action={next.get(lead.id)} now={now} /></td>
                      <td className="text-sm text-muted-foreground">{last.get(lead.id) ? formatDate(last.get(lead.id)) : "—"}</td>
                      <td className="text-sm capitalize text-foreground/80">{lead.source}</td>
                      <td>
                        {lead.contact
                          ? <Link href={`/contacts/${lead.contact.id}`} className="text-sm text-primary hover:underline">{contactName(lead.contact)}</Link>
                          : <AddToContactsButton leadId={lead.id} />}
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
    </div>
  );
}

/** The next planned activity and when; red once its time has gone. None = say so, it is a gap. */
function NextActionCell({ action, now }: { action?: { summary: string; dueDate: Date; allDay: boolean }; now: Date }) {
  if (!action) return <span className="text-muted-foreground">No next step</span>;
  const late = isOverdueActivity(action, now);
  return (
    <span>
      <span className="block max-w-56 truncate">{action.summary}</span>
      <span className={`text-xs ${late ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
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
