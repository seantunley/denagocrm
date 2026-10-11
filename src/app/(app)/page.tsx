import Link from "next/link";
import { ArrowRight, LayoutGrid } from "lucide-react";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { FollowUpPrompts } from "@/components/proactive/NextStep";
import { FocusHome } from "@/components/focus/FocusHome";
import { DEFAULT_DASHBOARD_SLUG } from "@/lib/dashboard/store";
import { dashboardViewer, dashboardWindow, grants } from "@/lib/dashboard/data";
import type { DashboardAccess } from "@/lib/dashboard/registry";
import type { PermissionUser } from "@/lib/permissions";
import { loadHomeFocus } from "@/lib/home/focus";
import { loadDaxBrief, type DaxBrief } from "@/lib/daxBrief";
import { logError } from "@/lib/errorLog";
import { DaxBriefCard } from "@/components/DaxBriefCard";

/**
 * The DAX brief, or nothing. Only where DAX exists (the automation module) and
 * for someone who can see leads at all — it is a summary OF leads. A failure
 * hides it rather than the home page: the brief is a convenience, and the
 * screen under it must still load. Logged by reason only; the error is the
 * query's, never a customer's details.
 */
async function homeBrief(user: PermissionUser, access: DashboardAccess): Promise<DaxBrief | null> {
  if (!access.modules.has("automation") || !grants(access, "leads.view_all", "leads.view_owned")) return null;
  try {
    return await loadDaxBrief(user);
  } catch (error) {
    await logError("dax-brief", error, "home page brief failed to load");
    return null;
  }
}

/**
 * The home screen: what needs you, and what to do next.
 *
 * It answers one question before any other — "what should I do now?" — and
 * shows as little as it can while doing so. Three layers, in order:
 *
 *  1. A GLANCE. One sentence, then at most five numbers, each with what it is
 *     measured against and each a link to the records behind it.
 *  2. A QUEUE. The deals most worth contacting, best first, each with its reason
 *     and one action; beside it, today's agenda and what is waiting on others.
 *  3. DETAIL, ON DEMAND. Charts, feeds and everything a person arranged for
 *     themselves live on their dashboards, one click away at /d/home — the same
 *     dashboards as before, with nothing removed. They are not loaded here, so
 *     the home screen costs only what it shows.
 *
 * What a person sees is decided by what they are allowed to see (see
 * lib/home/focus.ts): a rep gets their own deals and work; someone who can see
 * everyone's can switch the queue to the whole team's.
 *
 * ── WHAT STAYS ABOVE EVERYTHING, AND WHY ────────────────────────────────────
 *
 * The follow-up prompts are an INTERACTION — mark it done, or do not — about
 * the viewer's own overdue work. They are not a summary and are never folded
 * away: somebody who could hide them would silently stop being asked.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const { user, access } = await dashboardViewer();
  const canSeeTeam = grants(access, "leads.view_all");
  // "Everyone" is offered only to someone who may see everyone's; asking for it otherwise changes nothing.
  const mine = !(view === "all" && canSeeTeam);
  // Started now, awaited at the render, so it overlaps the queries below.
  const briefPromise = homeBrief(user, access);
  const focusPromise = loadHomeFocus({ mine });

  const { todayStart, now } = await dashboardWindow();

  // The viewer's OWN overdue items. Inherently self-scoped — assignedToId is the
  // caller — so this shows nobody else's work regardless of permissions.
  const myOverdue = await prisma.activity.findMany({
    where: { status: "planned", availabilityBlock: false, dueDate: { lt: todayStart }, assignedToId: user.id },
    orderBy: { dueDate: "asc" },
    take: 3,
    include: { lead: true },
  });

  const hour = Number(
    now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" }),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.name.split(/\s+/)[0];
  const [brief, focus] = await Promise.all([briefPromise, focusPromise]);
  const briefHasMore = !!brief && (brief.items.length > 0 || !!brief.team?.length);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
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

      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {greeting}, {firstName}
        </h1>
        {/* One sentence does the job of several charts: how much needs you, and of what kind. */}
        <p className="mt-1 text-sm text-muted-foreground">{focus.brief}</p>
      </header>

      <FocusHome focus={focus} mine={mine} canSeeTeam={canSeeTeam} />

      {/* Detail, on demand: DAX's fuller brief folds open; charts and custom cards are a click away. */}
      <footer className="space-y-3 border-t border-border/60 pt-4">
        {briefHasMore && brief && (
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">DAX&apos;s brief for today</summary>
            <div className="mt-3"><DaxBriefCard brief={brief} /></div>
          </details>
        )}
        <Link href={`/d/${DEFAULT_DASHBOARD_SLUG}`} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <LayoutGrid className="size-4" aria-hidden />
          Dashboards — charts, targets and your own cards
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </footer>
    </div>
  );
}
