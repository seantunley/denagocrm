import { prisma } from "@/lib/db";
import { evaluateConditions } from "@/lib/journeyTypes";
import { formatDate } from "@/lib/format";
import { FollowUpPrompts } from "@/components/proactive/NextStep";
import DashboardGrid, { type GridCard, type AddableCard } from "@/components/dashboard/DashboardGrid";
import {
  addableCards,
  isConditional,
  visibleCards,
} from "@/lib/dashboard/registry";
import {
  dashboardViewer,
  dashboardWindow,
  dashboardLayoutForViewer,
  plannedActivities,
  grants,
} from "@/lib/dashboard/data";
import { DASHBOARD_CARD_IMPLS } from "@/lib/dashboard/cards";

/**
 * The home screen: cards the user arranges, rather than a fixed layout.
 *
 * This page used to be ~890 lines — every query for every tile in one
 * `Promise.all`, and the markup for all of them inline. It is now a thin shell:
 * resolve who is asking, ask the registry which cards they may see, load those
 * in parallel, and hand the rendered nodes to the grid. Adding a card means
 * adding a registry entry, not editing this file.
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY MODEL:
 *
 *   1. Resolve the viewer's permissions and the tenant's enabled modules ONCE.
 *   2. Filter the saved layout down to cards they are entitled to. Everything
 *      after this point only ever concerns cards that passed step 2 — a card the
 *      viewer may not see is never loaded, so its query never runs.
 *   3. Load the survivors in parallel.
 *   4. Apply each card's visibility condition to the signals it published.
 *
 * Conditions come LAST, after permissions, and never the other way round: a
 * condition that decided whether to run a query would make the query itself the
 * disclosure.
 */
export default async function DashboardPage() {
  const { user, access } = await dashboardViewer();
  const layout = await dashboardLayoutForViewer();

  // Step 2 — the permission and module filter. `visibleCards` is the SAME
  // function the add-card picker filters through (below), so the picker cannot
  // offer a card the renderer would refuse.
  const entitled = visibleCards(layout, access);

  // Step 3 — every visible card loads at once. Shared sub-queries are memoised
  // per request in lib/dashboard/data.ts, so two cards wanting the same rows
  // cost one query, not two.
  const loaded = await Promise.all(
    entitled.map(async (meta) => ({ meta, ...(await DASHBOARD_CARD_IMPLS[meta.id].load()) })),
  );

  // Step 4 — visibility conditions, evaluated against each card's own signals
  // using the shared journey condition evaluator. A card whose renderer returned
  // nothing at all is dropped here too, so a card with no entitled content
  // leaves no empty box behind.
  const cards: GridCard[] = loaded
    .filter(
      ({ meta, node, signals }) =>
        node !== null && evaluateConditions(meta.condition ?? null, { vars: signals }),
    )
    .map(({ meta, node }) => ({ id: meta.id, title: meta.title, span: meta.span, node }));

  const addable: AddableCard[] = addableCards(layout, access).map((meta) => ({
    id: meta.id,
    title: meta.title,
    description: meta.description,
    conditional: isConditional(meta),
  }));

  /* ── page chrome ──────────────────────────────────────────────────
   * The greeting and the follow-up prompts are NOT cards. They are the "before
   * you do anything else" band: the prompts are an interaction (mark it done,
   * or don't) rather than a summary, and a user who arranged them off the screen
   * would silently stop being asked about their own overdue work. Everything
   * that is a SUMMARY is a card; these two are not.
   */
  const { todayStart, now } = await dashboardWindow();

  // The viewer's OWN overdue items. Inherently self-scoped — assignedToId is the
  // caller — so this shows nobody else's work regardless of permissions.
  const myOverdue = await prisma.activity.findMany({
    where: { status: "planned", dueDate: { lt: todayStart }, assignedToId: user.id },
    orderBy: { dueDate: "asc" },
    take: 3,
    include: { lead: true },
  });

  // The agenda count in the subtitle is drawn from the same query the agenda
  // card uses (memoised, so it is free here), and is shown only to someone who
  // may see activities at all — otherwise the subtitle would quietly report the
  // size of a queue they cannot open.
  const seesActivities = grants(access, "activities.view", "activities.manage");
  const dueTodayCount = seesActivities ? (await plannedActivities()).today.length : null;

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];

  return (
    <div className="space-y-5">
      <FollowUpPrompts
        prompts={myOverdue.map((a) => ({
          id: a.id,
          type: a.type,
          summary: a.summary,
          dueLabel: formatDate(a.dueDate),
          leadId: a.leadId,
          leadName: a.lead?.name ?? null,
        }))}
      />

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {greeting}, {firstName}
        </h1>
        {dueTodayCount !== null && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {dueTodayCount === 0
              ? "Nothing on the agenda today — a clean slate."
              : `${dueTodayCount} ${dueTodayCount === 1 ? "item" : "items"} on today's agenda.`}
          </p>
        )}
      </div>

      <DashboardGrid cards={cards} addable={addable} savedOrder={[...layout]} />
    </div>
  );
}
