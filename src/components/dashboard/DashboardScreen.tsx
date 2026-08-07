import Link from "next/link";
import { notFound } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { dashboardsForViewer, type LoadedDashboard } from "@/lib/dashboard/store";
import { viewerConditionContext } from "@/lib/dashboard/viewer";
import DashboardView, { visibleViews } from "./DashboardView";

/**
 * A whole dashboard: the switcher, the tab strip, and the active view.
 *
 * Shared by `/` and `/d/[slug]` so the two cannot drift — the home screen is a
 * dashboard like any other, and the only thing special about it is which one it
 * resolves to. Making it a genuinely different page is how the two end up with
 * different tab behaviour and different empty states six months from now.
 *
 * WHY THE TAB IS A URL AND NOT LOCAL STATE. A dashboard tab is a place: people
 * link to it, bookmark it, and expect Back to work. Client state would make all
 * three fail silently, and would also mean every tab's cards had to be rendered
 * on every visit so that switching felt instant — which is the opposite of what
 * a screen carrying thirty queries wants.
 */
export default async function DashboardScreen({
  dashboard,
  tab,
}: {
  dashboard: LoadedDashboard;
  /** The `path` of the view to show. Absent means the first visible one. */
  tab?: string;
}) {
  const ctx = await viewerConditionContext();
  const dashboards = await dashboardsForViewer();
  const views = visibleViews(dashboard.config, ctx);

  /*
   * A dashboard with no visible views is not an error — every tab may be
   * legitimately hidden from this person — but it must not 404, because the
   * dashboard does exist and they may be able to see it tomorrow.
   */
  if (views.length === 0) {
    return (
      <Chrome dashboards={dashboards} current={dashboard} views={[]} active={null}>
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">Nothing to show here yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Every tab on this dashboard is hidden by one of its own rules.
          </p>
        </div>
      </Chrome>
    );
  }

  // An unknown tab is a 404 rather than a silent fallback to the first one. A
  // stale bookmark that quietly shows a DIFFERENT tab's numbers is worse than
  // one that says the page is gone — the numbers look like an answer to the
  // question the URL asked.
  const active = tab ? views.find((view) => view.path === tab) : views[0];
  if (!active) notFound();

  return (
    <Chrome dashboards={dashboards} current={dashboard} views={views} active={active.path}>
      {dashboard.dropped.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {dashboard.dropped.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      <DashboardView view={active} ctx={ctx} />
    </Chrome>
  );
}

function Chrome({
  dashboards,
  current,
  views,
  active,
  children,
}: {
  dashboards: { id: string; slug: string; title: string }[];
  current: LoadedDashboard;
  views: { id: string; path: string; title: string }[];
  active: string | null;
  children: React.ReactNode;
}) {
  // The switcher is only worth drawing once there is something to switch to.
  // A single-dashboard user gets no chrome they cannot use.
  const showSwitcher = dashboards.length > 1;
  const base = current.slug === "home" ? "" : `/d/${current.slug}`;

  return (
    <div className="space-y-4">
      {showSwitcher && (
        <div className="flex flex-wrap items-center gap-1.5">
          <LayoutGrid className="size-3.5 text-muted-foreground" />
          {dashboards.map((entry) => (
            <Link
              key={entry.id}
              href={entry.slug === "home" ? "/" : `/d/${entry.slug}`}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                entry.slug === current.slug
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.title}
            </Link>
          ))}
        </div>
      )}

      {views.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
          {views.map((view) => (
            <Link
              key={view.id}
              // The first tab is the bare address, so the default view has one
              // canonical URL rather than two that render identically.
              href={view.path === views[0].path ? base || "/" : `${base || ""}?tab=${view.path}`}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                view.path === active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {view.title}
            </Link>
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
