import "server-only";
import Link from "next/link";
import {
  SquareKanban,
  CircleDollarSign,
  Truck,
  Wrench,
  Clock4,
  CarFront,
  Check,
  TriangleAlert,
  ArrowRight,
  FileSignature,
  Sparkles,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { accessibleInboxWhere } from "@/lib/permissions";
import { getAiHealth } from "@/lib/systemHealth";
import { getLastRun } from "@/lib/securityRunbook";
import { formatZARCompact, formatDate, formatDateTime, contactName } from "@/lib/format";
import { dueLabels, dueColors } from "@/lib/serviceDue";
import {
  Stagger,
  StaggerItem,
  StatSparkCard,
  PipelineSnapshot,
  TargetRings,
  type SparkStat,
  type PipeSeg,
  type RingDef,
} from "@/components/dashboard/widgets";
import { SectionCard, AgendaCard } from "@/components/dashboard/sections";
import type { DashboardCardId } from "./registry";
import {
  dashboardViewer,
  dashboardWindow,
  grants,
  leadWhere,
  quoteWhere,
  jobCardWhere,
  leadsThisMonth,
  prevLeadCount,
  wonThisMonth,
  prevWonValue,
  servicesThisMonth,
  deliveriesThisMonth,
  plannedActivities,
  vehiclesDueForService,
  dailySeries,
  pctDelta,
} from "./data";

/**
 * The dashboard card catalogue — the executable half. ./registry.ts declares
 * WHAT each card is; this declares how it loads and how it draws.
 *
 * PERMISSION GATING HAPPENS TWICE, ON PURPOSE.
 *
 * The registry's `permissions` list decides whether a card appears at all, and
 * it is an ANY-of list. That is the right grain for a card drawn from one record
 * type, but several cards here are composites: "Needs attention" pairs leads
 * with quotes, "Latest activity" braids new leads, logged conversations and
 * quote/signing audit events. For those, an any-of gate alone would hand a
 * leads-only user the quote numbers and customer names in the other half.
 *
 * So each loader below re-checks, STRAND BY STRAND, against the same resolved
 * permission set, and simply omits the strands the viewer is not entitled to.
 * A card that ends up with nothing to show renders its ordinary empty state —
 * which is also why the empty states are phrased as "nothing here", never
 * "you are not allowed to see this": the absence of data must not itself
 * become the disclosure.
 *
 * Row-level scoping (WHICH leads, WHICH quotes) is applied in ./data.ts.
 */

/**
 * A loaded card: what to draw, plus the SIGNALS its visibility condition is
 * evaluated against.
 *
 * Signals are published under `vars`, because that is the namespace the shared
 * condition evaluator already reserves for caller-supplied values — so a card
 * condition names `vars.count` and typechecks as a `ConditionField` without
 * CONDITION_FIELDS having to learn any dashboard vocabulary.
 */
export type LoadedCard = { node: React.ReactNode; signals: Record<string, unknown> };
export type DashboardCardImpl = { load: () => Promise<LoadedCard> };

/**
 * Pair a loader with a renderer, and optionally with the signals its condition
 * reads. The generic is inferred from `load`, so the renderer and the signal
 * function are both fully typed against exactly what the loader returned, while
 * the value stored in the map is a single uniform shape the page can iterate.
 *
 * `signals` defaults to empty, which makes an unconditional card's contract
 * trivial: no signals, no condition, always shown.
 */
function card<T>(
  load: () => Promise<T>,
  render: (data: T) => React.ReactNode,
  signals: (data: T) => Record<string, unknown> = () => ({}),
): DashboardCardImpl {
  return {
    load: async () => {
      const data = await load();
      return { node: render(data), signals: signals(data) };
    },
  };
}

/* ── shared bits of presentation ──────────────────────────────────── */

function statGrid(stats: { stat: SparkStat; icon: React.ReactNode }[]) {
  return (
    <Stagger className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {stats.map(({ stat, icon }) => (
        <StaggerItem key={stat.label}>
          <StatSparkCard stat={stat} icon={icon} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/** Label + badge tone for a quote's live signing state. */
const SIGN_STATE: Record<
  string,
  { label: (r: { signedCount: number; totalSigners: number; waitingFor: string | null }) => string; pill: string }
> = {
  sent: { label: (r) => `Sent · waiting for ${r.waitingFor}`, pill: "bg-blue-500/10 text-blue-300" },
  viewed: { label: (r) => `Opened · waiting for ${r.waitingFor}`, pill: "bg-indigo-500/10 text-indigo-300" },
  partial: { label: (r) => `${r.signedCount}/${r.totalSigners} signed · waiting for ${r.waitingFor}`, pill: "bg-amber-500/10 text-amber-300" },
  signed: { label: () => "Fully signed", pill: "bg-emerald-500/10 text-emerald-300" },
};

const EmptyLine = ({ children }: { children: React.ReactNode }) => (
  <p className="py-2 text-xs text-muted-foreground/70">{children}</p>
);

/* ── the cards ────────────────────────────────────────────────────── */

export const DASHBOARD_CARD_IMPLS: Record<DashboardCardId, DashboardCardImpl> = {
  /*
   * System alerts — the one card that is normally invisible.
   *
   * Lifted from the fixed dashboard's `systemAlerts` band, which was rendered
   * unconditionally and simply produced no rows when healthy. As a card it
   * declares that instead: `WHEN_NOT_EMPTY` over the alert count.
   */
  "system-alerts": card(
    async () => {
      const { user } = await dashboardViewer();
      const [aiHealth, lastSecurity] = await Promise.all([getAiHealth(), getLastRun()]);
      const alerts: { text: string; href: string }[] = [];
      if (aiHealth && ["billing", "auth", "error"].includes(aiHealth.status)) {
        alerts.push({ text: `AI assistant problem: ${aiHealth.detail}`, href: "/settings/security" });
      }
      // Owner-only, exactly as before: the runbook's pass/fail counts describe
      // the workspace's security posture and are not a rep's business.
      if (user.role === "owner" && lastSecurity && lastSecurity.failed > 0) {
        alerts.push({
          text: `Security runbook: ${lastSecurity.failed} check(s) failing`,
          href: "/settings/security",
        });
      }
      return alerts;
    },
    (alerts) => (
      <div className="space-y-2">
        {alerts.map((a) => (
          <Link
            key={a.text}
            href={a.href}
            className="flex items-center gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-200 transition-colors hover:bg-red-500/15"
          >
            <TriangleAlert className="size-4 shrink-0 text-red-400" />
            <span className="min-w-0 flex-1 truncate">{a.text}</span>
            <ArrowRight className="size-4 shrink-0 text-red-400" />
          </Link>
        ))}
      </div>
    ),
    (alerts) => ({ count: alerts.length }),
  ),

  /* Sales stats — four sparkline tiles, each gated on its OWN record type. */
  "sales-stats": card(
    async () => {
      const { access } = await dashboardViewer();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const seesQuotes = grants(access, "quotes.view_all", "quotes.view_owned");
      // "To deliver" counts quotes awaiting delivery — an automotive-pack idea,
      // dropped with the pack exactly as the fixed dashboard dropped it.
      const showDeliveries = seesQuotes && access.modules.has("automotive");
      const { daysSoFar } = await dashboardWindow();

      const [leads, prevLeads, won, prevWon, openLeads, awaitingDelivery] = await Promise.all([
        seesLeads ? leadsThisMonth() : [],
        seesLeads ? prevLeadCount() : 0,
        seesLeads ? wonThisMonth() : [],
        seesLeads ? prevWonValue() : 0,
        seesLeads ? prisma.lead.count({ where: { ...(await leadWhere()), status: "open" } }) : 0,
        showDeliveries
          ? prisma.quote.count({
              where: {
                ...(await quoteWhere()),
                status: "accepted",
                deliveredAt: null,
                supersededAt: null,
              },
            })
          : 0,
      ]);

      const wonValue = won.reduce((sum, w) => sum + w.valueCents, 0);
      const stats: { stat: SparkStat; icon: React.ReactNode }[] = [];
      if (seesLeads) {
        stats.push(
          {
            icon: <SquareKanban />,
            stat: {
              label: "New leads (month)",
              value: leads.length,
              delta: pctDelta(leads.length, prevLeads),
              href: "/leads",
              spark: dailySeries(leads.map((l) => l.createdAt), daysSoFar),
            },
          },
          {
            icon: <CircleDollarSign />,
            stat: {
              label: "Won value (month)",
              value: Math.round(wonValue / 100),
              display: "zar",
              delta: pctDelta(wonValue, prevWon),
              href: "/reports",
              spark: dailySeries(won.map((w) => w.updatedAt), daysSoFar, (i) =>
                Math.round(won[i].valueCents / 100),
              ),
            },
          },
          {
            icon: <SquareKanban />,
            stat: {
              label: "Open leads",
              value: openLeads,
              delta: null,
              href: "/leads",
              spark: dailySeries(leads.map((l) => l.createdAt), daysSoFar),
            },
          },
        );
      }
      if (showDeliveries) {
        stats.push({
          icon: <Truck />,
          stat: { label: "To deliver", value: awaitingDelivery, delta: null, href: "/deliveries", spark: [] },
        });
      }
      return stats;
    },
    (stats) => (stats.length === 0 ? null : statGrid(stats)),
  ),

  /* Brand-new leads — open and never opened by anyone (viewedAt still null). */
  "new-leads": card(
    async () =>
      prisma.lead.count({ where: { ...(await leadWhere()), status: "open", viewedAt: null } }),
    (count) => (
      <Link
        href="/leads"
        className={`group flex h-full min-w-0 flex-col justify-between rounded-xl border p-4 shadow-sm transition-colors ${
          count > 0
            ? "border-emerald-500/30 bg-emerald-500/[0.07] hover:border-emerald-500/50"
            : "border-border bg-card hover:border-primary/30"
        }`}
      >
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Brand-new
          </p>
          <Sparkles className={`size-4 ${count > 0 ? "text-emerald-400" : "text-muted-foreground"}`} />
        </div>
        <div className="mt-2">
          <div className={`text-3xl font-bold tabular-nums ${count > 0 ? "text-emerald-300" : "text-foreground"}`}>
            {count}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {count === 1 ? "lead not opened yet" : "leads not opened yet"}
          </p>
        </div>
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary group-hover:underline">
          {count > 0 ? "Review now" : "All caught up"}
          <ArrowRight className="size-3" />
        </span>
      </Link>
    ),
  ),

  /* Pipeline snapshot — open leads by stage. */
  "pipeline-snapshot": card(
    async () => {
      const where = { ...(await leadWhere()), status: "open" };
      const [rows, value] = await Promise.all([
        prisma.lead.findMany({
          where,
          select: { valueCents: true, stage: { select: { id: true, name: true, color: true, order: true } } },
        }),
        prisma.lead.aggregate({ where, _sum: { valueCents: true } }),
      ]);
      const segMap = new Map<string, PipeSeg & { order: number }>();
      for (const l of rows) {
        const cur =
          segMap.get(l.stage.id) ??
          { name: l.stage.name, color: l.stage.color, count: 0, value: 0, order: l.stage.order };
        cur.count += 1;
        cur.value += l.valueCents;
        segMap.set(l.stage.id, cur);
      }
      return {
        segments: [...segMap.values()].sort((a, b) => a.order - b.order) as PipeSeg[],
        totalValue: formatZARCompact(value._sum.valueCents ?? 0),
      };
    },
    ({ segments, totalValue }) => (
      <SectionCard title="Pipeline snapshot" action={{ href: "/leads", label: "Board" }}>
        <PipelineSnapshot segments={segments} totalValue={totalValue} />
      </SectionCard>
    ),
  ),

  /* Month targets — one ring per metric the viewer is entitled to. */
  "month-targets": card(
    async () => {
      const { access } = await dashboardViewer();
      const { period } = await dashboardWindow();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const seesQuotes = grants(access, "quotes.view_all", "quotes.view_owned");
      const seesJobCards = grants(access, "jobcards.view_all", "jobcards.view_owned");
      // Deliveries and Services are automotive-pack metrics — dropped with the pack.
      const automotive = access.modules.has("automotive");

      const [targets, leads, won, deliveries, services] = await Promise.all([
        prisma.target.findMany({ where: { period } }),
        seesLeads ? leadsThisMonth() : [],
        seesLeads ? wonThisMonth() : [],
        automotive && seesQuotes ? deliveriesThisMonth() : 0,
        automotive && seesJobCards ? servicesThisMonth() : [],
      ]);

      const tMap = new Map(targets.map((t) => [t.metric, t.value]));
      const rings: RingDef[] = [];
      if (seesLeads) {
        rings.push(
          { label: "Leads", actual: leads.length, target: tMap.get("leads") ?? 0, display: "int", color: "var(--chart-2)" },
          {
            label: "Sales",
            actual: Math.round(won.reduce((s, w) => s + w.valueCents, 0) / 100),
            target: Math.round((tMap.get("sales_value") ?? 0) / 100),
            display: "zar",
            color: "var(--chart-1)",
          },
        );
      }
      if (automotive && seesQuotes) {
        rings.push({ label: "Deliveries", actual: deliveries, target: tMap.get("deliveries") ?? 0, display: "int", color: "var(--chart-3)" });
      }
      if (automotive && seesJobCards) {
        rings.push({ label: "Services", actual: services.length, target: tMap.get("services") ?? 0, display: "int", color: "var(--chart-4)" });
      }
      return rings;
    },
    (rings) =>
      rings.length === 0 ? null : (
        <SectionCard title="Month targets" action={{ href: "/targets", label: "Targets" }}>
          <TargetRings rings={rings} />
        </SectionCard>
      ),
  ),

  /* Sales agenda — today + tomorrow, everything that is not workshop work. */
  "sales-agenda": card(
    async () => {
      const { today, tomorrow } = await plannedActivities();
      return {
        today: today.filter((a) => a.category !== "workshop"),
        tomorrow: tomorrow.filter((a) => a.category !== "workshop"),
      };
    },
    ({ today, tomorrow }) => (
      <AgendaCard today={today} tomorrow={tomorrow} action={{ href: "/calendar", label: "Calendar" }} />
    ),
  ),

  /* Quotes out for signature, with who each one is waiting on. */
  "out-for-signature": card(
    async () => {
      const requests = await prisma.signatureRequest.findMany({
        where: { quoteId: { not: null }, deletedAt: null, status: { in: ["sent", "viewed", "in_progress"] } },
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: {
          quoteId: true,
          status: true,
          recipients: { orderBy: { order: "asc" }, select: { name: true, role: true, status: true, viewedAt: true } },
        },
      });
      const ids = [...new Set(requests.map((r) => r.quoteId).filter((v): v is string => Boolean(v)))];
      // Scoped by the viewer's QUOTE access as well as their signing permission.
      // signing.view says "you may work with signature requests"; it does not say
      // which customers' quotes you may read, and this card prints quote numbers
      // and customer names. A signing-only user therefore sees an empty card
      // rather than a directory of who is buying what.
      const quotes = ids.length
        ? await prisma.quote.findMany({
            where: { ...(await quoteWhere()), id: { in: ids }, deletedAt: null },
            select: {
              id: true,
              number: true,
              lead: { select: { name: true } },
              contact: { select: { firstName: true, lastName: true, isCompany: true, company: true } },
            },
          })
        : [];
      const byId = new Map(quotes.map((q) => [q.id, q]));

      return requests
        .map((r) => {
          const q = r.quoteId ? byId.get(r.quoteId) : null;
          if (!q) return null;
          const signers = r.recipients.filter((x) => x.role !== "viewer");
          const next = signers.find((x) => x.status !== "signed" && x.status !== "declined");
          const signedCount = signers.filter((x) => x.status === "signed").length;
          const anyViewed = r.status === "viewed" || r.status === "in_progress" || signers.some((x) => x.viewedAt);
          const state: "sent" | "viewed" | "partial" | "signed" = !next
            ? "signed"
            : signedCount > 0
              ? "partial"
              : anyViewed
                ? "viewed"
                : "sent";
          return {
            id: q.id,
            number: q.number,
            who: q.lead?.name ?? (q.contact ? contactName(q.contact) : "customer"),
            waitingFor: next ? next.name.split(" ")[0] : null,
            signedCount,
            totalSigners: signers.length,
            state,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    },
    (rows) => (
      <SectionCard title="Out for signature" action={{ href: "/signatures", label: "Signatures" }}>
        {rows.length === 0 ? (
          <EmptyLine>Nothing out for signature.</EmptyLine>
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((s) => {
              const meta = SIGN_STATE[s.state];
              return (
                <li key={s.id} className="flex items-center gap-2.5 py-1.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <FileSignature className="size-3.5" />
                  </span>
                  <p className="min-w-0 flex-1 truncate text-[13px]">
                    <Link href={`/quotes/${s.id}`} className="font-medium text-foreground hover:text-primary">
                      Q-{s.number}
                    </Link>
                    <span className="text-[11px] text-muted-foreground"> — {s.who}</span>
                  </p>
                  <span className={`badge shrink-0 ${meta.pill}`}>{meta.label(s)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    ),
    // Drives WHEN_NOT_EMPTY: no quotes out for signature, no card. The
    // renderer's empty branch is kept anyway — it is what the card would show if
    // the condition were ever relaxed, and a renderer that assumes non-empty
    // input is a trap for whoever changes the condition next.
    (rows) => ({ count: rows.length }),
  ),

  /* Needs attention — leads with no next step, quotes left unsigned. */
  "needs-attention": card(
    async () => {
      const { access } = await dashboardViewer();
      const { staleQuoteCutoff } = await dashboardWindow();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const seesQuotes = grants(access, "quotes.view_all", "quotes.view_owned");

      const [noNextLeads, staleQuotes] = await Promise.all([
        seesLeads
          ? prisma.lead.findMany({
              where: { ...(await leadWhere()), status: "open", activities: { none: { status: "planned" } } },
              select: { id: true, name: true, stage: { select: { name: true, color: true } } },
              orderBy: { createdAt: "asc" },
              take: 5,
            })
          : [],
        seesQuotes
          ? prisma.quote.findMany({
              where: {
                ...(await quoteWhere()),
                status: "sent",
                supersededAt: null,
                signedAt: null,
                createdAt: { lt: staleQuoteCutoff },
              },
              select: {
                id: true,
                number: true,
                createdAt: true,
                lead: { select: { name: true } },
                contact: { select: { firstName: true, lastName: true, isCompany: true, company: true } },
              },
              orderBy: { createdAt: "asc" },
              take: 5,
            })
          : [],
      ]);
      return { noNextLeads, staleQuotes };
    },
    ({ noNextLeads, staleQuotes }) => (
      <SectionCard title="Needs attention" action={{ href: "/leads", label: "Board" }}>
        {noNextLeads.length === 0 && staleQuotes.length === 0 ? (
          <EmptyLine>All clear — every open lead has a next step. 🎉</EmptyLine>
        ) : (
          <ul className="divide-y divide-border/50">
            {noNextLeads.map((l) => (
              <li key={l.id} className="flex items-center gap-2.5 py-1.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-300">
                  <TriangleAlert className="size-3.5" />
                </span>
                <p className="min-w-0 flex-1 truncate text-[13px]">
                  <Link href={`/leads/${l.id}`} className="font-medium text-foreground hover:text-primary">
                    {l.name}
                  </Link>
                  <span className="text-[11px] text-muted-foreground"> — no next step planned</span>
                </p>
                <span className="badge shrink-0 text-white" style={{ backgroundColor: l.stage.color }}>
                  {l.stage.name}
                </span>
              </li>
            ))}
            {staleQuotes.map((q) => (
              <li key={q.id} className="flex items-center gap-2.5 py-1.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-300">
                  <Clock4 className="size-3.5" />
                </span>
                <p className="min-w-0 flex-1 truncate text-[13px]">
                  <Link href={`/quotes/${q.id}`} className="font-medium text-foreground hover:text-primary">
                    Q-{q.number}
                  </Link>
                  <span className="text-[11px] text-muted-foreground">
                    {` — ${q.lead?.name ?? (q.contact ? contactName(q.contact) : "customer")} · sent ${formatDate(q.createdAt)}, still unsigned — call them`}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    ),
  ),

  /* One chronological feed: new leads + logged conversations + quote/signing events. */
  "latest-activity": card(
    async () => {
      const { access, user } = await dashboardViewer();
      const seesLeads = grants(access, "leads.view_all", "leads.view_owned");
      const seesRecords = grants(
        access,
        "contacts.view_all",
        "contacts.view_owned",
        "leads.view_all",
        "leads.view_owned",
      );
      // The quote/signing strand is drawn from the AUDIT LOG, so it is gated on
      // the permission that opens the audit log itself. Audit summaries are free
      // text about records the viewer may have no access to, and there is no
      // per-row scope to apply to them — so the honest gate is "may this person
      // read the audit trail at all?", which is what /audit asks.
      const seesAudit = grants(access, "audit.view");

      const [recentLeads, recentComms, recentAudit] = await Promise.all([
        seesLeads
          ? prisma.lead.findMany({
              where: await leadWhere(),
              take: 5,
              orderBy: { createdAt: "desc" },
              include: { product: true, stage: true },
            })
          : [],
        seesRecords
          ? prisma.communication.findMany({
              where: { ...(await accessibleInboxWhere(user)), subject: { not: "🔎 AI research" } },
              take: 5,
              orderBy: { occurredAt: "desc" },
              include: { user: true, contact: true, lead: true },
            })
          : [],
        seesAudit
          ? prisma.auditLog.findMany({
              where: { OR: [{ action: { startsWith: "quote." } }, { action: { startsWith: "signing." } }] },
              orderBy: { createdAt: "desc" },
              take: 8,
              select: { id: true, action: true, summary: true, createdAt: true, contactId: true, leadId: true },
            })
          : [],
      ]);

      return [
        ...recentLeads.map((l) => ({ kind: "lead" as const, when: l.createdAt, lead: l })),
        ...recentComms.map((c) => ({ kind: "comm" as const, when: c.occurredAt, comm: c })),
        ...recentAudit.map((a) => ({ kind: "audit" as const, when: a.createdAt, audit: a })),
      ]
        .sort((a, b) => b.when.getTime() - a.when.getTime())
        .slice(0, 8);
    },
    (feed) => (
      <SectionCard title="Latest activity" action={{ href: "/leads", label: "Pipeline" }}>
        <ul className="divide-y divide-border/50">
          {feed.length === 0 && <li><EmptyLine>Nothing yet.</EmptyLine></li>}
          {feed.map((f) =>
            f.kind === "lead" ? (
              <li key={`l-${f.lead.id}`} className="flex items-center gap-2 py-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                <p className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Lead · </span>
                  <Link href={`/leads/${f.lead.id}`} className="font-medium text-foreground hover:text-primary">
                    {f.lead.name}
                  </Link>
                  <span className="text-[11px] text-muted-foreground">
                    {" — "}
                    {f.lead.product ? `${f.lead.product.name} · ` : ""}
                    {f.lead.source} · {formatDate(f.lead.createdAt)}
                  </span>
                </p>
                <span className="badge shrink-0 text-white" style={{ backgroundColor: f.lead.stage.color }}>
                  {f.lead.status === "open" ? f.lead.stage.name : f.lead.status}
                </span>
              </li>
            ) : f.kind === "comm" ? (
              <li key={`c-${f.comm.id}`} className="flex items-center gap-2 py-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-sky-400" />
                <p className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {f.comm.type} ·{" "}
                  </span>
                  {f.comm.contact ? (
                    <Link href={`/contacts/${f.comm.contact.id}`} className="font-medium text-foreground hover:text-primary">
                      {contactName(f.comm.contact)}
                    </Link>
                  ) : f.comm.lead ? (
                    <Link href={`/leads/${f.comm.lead.id}`} className="font-medium text-foreground hover:text-primary">
                      {f.comm.lead.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {" · "}
                    {f.comm.body.slice(0, 56)} · {formatDateTime(f.comm.occurredAt)}
                  </span>
                </p>
              </li>
            ) : (
              <li key={`a-${f.audit.id}`} className="flex items-center gap-2 py-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                <p className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {f.audit.action.startsWith("signing") ? "Signing" : "Quote"} ·{" "}
                  </span>
                  {f.audit.leadId ? (
                    <Link href={`/leads/${f.audit.leadId}`} className="font-medium text-foreground hover:text-primary">{f.audit.summary}</Link>
                  ) : f.audit.contactId ? (
                    <Link href={`/contacts/${f.audit.contactId}`} className="font-medium text-foreground hover:text-primary">{f.audit.summary}</Link>
                  ) : (
                    <span className="font-medium text-foreground">{f.audit.summary}</span>
                  )}
                  <span className="text-[11px] text-muted-foreground"> · {formatDateTime(f.audit.createdAt)}</span>
                </p>
              </li>
            ),
          )}
        </ul>
      </SectionCard>
    ),
  ),

  /* Service stats — job cards and fleet, each tile on its own permission. */
  "service-stats": card(
    async () => {
      const { access } = await dashboardViewer();
      const { daysSoFar, prevMonthStart, prevSameDay } = await dashboardWindow();
      const seesJobCards = grants(access, "jobcards.view_all", "jobcards.view_owned");
      const seesVehicles = grants(access, "vehicles.view_all", "vehicles.view_owned");

      const [openJobCards, services, prevServices, fleet] = await Promise.all([
        seesJobCards
          ? prisma.jobCard.count({ where: { ...(await jobCardWhere()), status: { not: "completed" } } })
          : 0,
        seesJobCards ? servicesThisMonth() : [],
        seesJobCards
          ? prisma.jobCard.count({
              where: {
                ...(await jobCardWhere()),
                status: "completed",
                completedAt: { gte: prevMonthStart, lt: prevSameDay },
              },
            })
          : 0,
        seesVehicles ? vehiclesDueForService() : null,
      ]);

      const stats: { stat: SparkStat; icon: React.ReactNode }[] = [];
      if (seesJobCards) {
        stats.push(
          { icon: <Wrench />, stat: { label: "Open job cards", value: openJobCards, delta: null, href: "/jobcards", spark: [] } },
          {
            icon: <Check />,
            stat: {
              label: "Services (month)",
              value: services.length,
              delta: pctDelta(services.length, prevServices),
              href: "/jobcards",
              spark: dailySeries(services.map((j) => j.completedAt!), daysSoFar),
            },
          },
        );
      }
      if (fleet) {
        stats.push(
          {
            icon: <Clock4 />,
            stat: {
              label: "Service due",
              value: fleet.due.length,
              delta: null,
              href: "/service-due",
              spark: [],
              tone: fleet.due.length > 0 ? "warn" : "default",
            },
          },
          { icon: <CarFront />, stat: { label: "Fleet", value: fleet.total, delta: null, href: "/vehicles", spark: [] } },
        );
      }
      return stats;
    },
    (stats) => (stats.length === 0 ? null : statGrid(stats)),
  ),

  /* Workshop agenda — the workshop half of today + tomorrow. */
  "service-agenda": card(
    async () => {
      const { today, tomorrow } = await plannedActivities();
      return {
        today: today.filter((a) => a.category === "workshop"),
        tomorrow: tomorrow.filter((a) => a.category === "workshop"),
      };
    },
    ({ today, tomorrow }) => (
      <AgendaCard today={today} tomorrow={tomorrow} action={{ href: "/workshop-calendar", label: "Calendar" }} />
    ),
  ),

  /* Vehicles overdue or coming up for a service. */
  "service-due": card(
    async () => (await vehiclesDueForService()).due.slice(0, 10),
    (due) => (
      <SectionCard title="Vehicles due for service" action={{ href: "/service-due", label: "Service due" }}>
        <ul className="divide-y divide-border/60">
          {due.length === 0 && <li><EmptyLine>Nothing due. 🎉</EmptyLine></li>}
          {due.map(({ vehicle, due: state }) => (
            <li key={vehicle.id} className="flex items-center gap-2 py-2">
              <p className="min-w-0 flex-1 truncate text-[13px]">
                <Link href={`/vehicles/${vehicle.id}`} className="font-medium text-foreground hover:text-primary">
                  {vehicle.model}
                </Link>
                <span className="text-[11px] text-muted-foreground">
                  {" — "}
                  {contactName(vehicle.contact)}
                  {state.nextDueDate ? ` · due ${formatDate(state.nextDueDate)}` : ""}
                  {state.nextDueKm != null ? ` · ${state.nextDueKm.toLocaleString()} km` : ""}
                </span>
              </p>
              <span className={`badge ${dueColors[state.status]} shrink-0`}>{dueLabels[state.status]}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    ),
  ),
};
