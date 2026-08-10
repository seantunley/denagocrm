import Link from "next/link";
import { notFound } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { dashboardsForViewer, type LoadedDashboard } from "@/lib/dashboard/store";
import { viewerConditionContext } from "@/lib/dashboard/viewer";
import { isTenantOwner } from "@/lib/auth";
import { renderViewSlots, visibleViews } from "./DashboardView";
import DashboardEditorRoot from "./editor/DashboardEditorRoot";

/**
 * A whole dashboard: the switcher, and the editable canvas.
 *
 * Shared by `/` and `/d/[slug]` so the two cannot drift — the home screen is a
 * dashboard like any other, and the only thing special about it is which one it
 * resolves to. Making it a genuinely different page is how the two end up with
 * different tab behaviour and different empty states six months from now.
 *
 * ── ONLY THE ACTIVE TAB IS RENDERED ─────────────────────────────────────────
 *
 * Cards are queries, so rendering every tab so that switching feels instant
 * would mean a five-tab dashboard firing every query on every visit — five times
 * the cost for a screen the user looks at one fifth of. The tab is therefore a
 * URL and a switch is a navigation, which is also what makes a tab linkable and
 * Back work.
 *
 * The exception is EDIT mode, where the client switches tabs locally: a full
 * navigation between tabs while arranging would re-run every query and lose the
 * drag context, and nobody bookmarks a tab mid-edit. That is why the client
 * receives the whole config but only one tab's rendered nodes — the others draw
 * as placeholders until it is saved and the server catches up.
 *
 * ── AN UNKNOWN TAB IS A 404, NOT A FALLBACK ──────────────────────────────────
 *
 * A stale bookmark that quietly showed a DIFFERENT tab's numbers would be worse
 * than one that says the page is gone: the numbers on screen would look like an
 * answer to the question the URL asked. Renaming a tab changes its `path`
 * (`slugify` of the title), which could make exactly that stale link, so it
 * would be tempting to fall back instead — but EDIT MODE NEVER NAVIGATES to
 * switch tabs, it only sets local state (`localViewId` in
 * DashboardEditorRoot.tsx), so a rename mid-session never produces a broken
 * link for the person doing the renaming. The 404 only ever fires for a link
 * that genuinely no longer resolves, which is exactly when it should.
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
  /*
   * Who may publish to THIS workspace.
   *
   * `viewer.role === "owner"` was the wrong question and hid the button from the
   * only people the feature is for: tenant ownership is a row
   * (`Tenant.ownerUserId`) for the ACTIVE workspace, not the platform role, so
   * under the old predicate the provisioned owner of tenant B saw no Share
   * control at all. Qualifying the server action alone would not have been
   * enough — the button would still have vanished for the very person entitled to
   * press it, and a control that is absent produces no refusal anybody can
   * report.
   *
   * Same predicate the action enforces (`isTenantOwner`/`requireTenantOwner`), so
   * the two cannot drift. Resolved on the server: the client has no authoritative
   * view of either the role or the workspace.
   */
  const canPublish = await isTenantOwner();
  const dashboards = await dashboardsForViewer();
  const views = visibleViews(dashboard.config, ctx);

  // No visible views at all is not an error — every tab may legitimately be
  // hidden from this person — but a NAMED tab that does not resolve is: see the
  // header note.
  if (tab && views.length > 0 && !views.some((view) => view.path === tab)) notFound();
  const active = tab ? views.find((view) => view.path === tab) : (views[0] ?? null);
  const slots = active ? await renderViewSlots(active, ctx) : {};

  return (
    <div className="space-y-4">
      {dashboards.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <LayoutGrid className="size-3.5 text-muted-foreground" />
          {dashboards.map((entry) => (
            <Link
              key={entry.id}
              href={entry.slug === "home" ? "/" : `/d/${entry.slug}`}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                entry.slug === dashboard.slug
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.title}
            </Link>
          ))}
        </div>
      )}

      {dashboard.dropped.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {dashboard.dropped.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      <DashboardEditorRoot
        slug={dashboard.slug}
        dashboardId={dashboard.id}
        config={dashboard.config}
        views={views}
        activeViewId={active?.id ?? null}
        slots={slots}
        /*
         * The first shared dashboard has now arrived, and this is the line the
         * old comment was holding the door open for.
         *
         * A published dashboard belongs to whoever wrote it. Letting a viewer
         * edit it would mean editing the AUTHOR's copy, for everyone who can see
         * it — which is not what "view" means, and not something a person would
         * expect a drag on their own screen to do.
         */
        canEdit={!dashboard.shared}
        shared={dashboard.shared}
        // The owner of THIS workspace decides what it sees; everyone else builds
        // their own. Not the platform role — see `canPublish` above.
        canPublish={canPublish}
        // Plain arrays, not Sets — a Set does not survive the server→client
        // boundary. The picker and builder rebuild Sets from these once,
        // memoised, rather than every consumer doing its own conversion.
        access={{ permissions: [...ctx.permissions], modules: [...ctx.modules] }}
      />
    </div>
  );
}
