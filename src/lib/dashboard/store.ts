import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { dashboardViewer } from "./data";
import { viewerTenantId } from "./viewerTenant";
import { sharedInTenant } from "./sharedScope";
import {
  CONFIG_VERSION,
  parseConfig,
  slugify,
  type CardConfig,
  type DashboardConfig,
} from "./config";
import { DEFAULT_LAYOUT, cardById } from "./registry";

/**
 * The READ path for user-built dashboards.
 *
 * WHOSE DASHBOARDS. Every function here resolves the owner from the SESSION, via
 * `dashboardViewer()`, and there is deliberately no `userId` parameter anywhere
 * in this file — the same rule `dashboardLayoutForViewer` follows, for the same
 * reason. These are called from server components whose props ultimately come
 * from a URL, so a function that accepted a user id would let one person's screen
 * be addressed by another. `dashboardBySlug` does take an argument, but a slug
 * names a dashboard WITHIN the caller's own rows: it narrows a set that is
 * already scoped to them and can never widen it.
 *
 * MEMOISED PER REQUEST. Every export is wrapped in React's `cache()`, matching
 * data.ts. The switcher in the chrome and the page body both want the dashboard
 * list, and a page renders its own config while its tabs re-read it — without the
 * memo that is three or four identical queries on the first screen every user
 * sees.
 *
 * NOTHING HERE THROWS ON BAD DATA. A stored config goes through `parseConfig`,
 * the lenient parser, which drops what it cannot understand and names each loss
 * in `dropped`. The home screen is the one page a user cannot route around, so a
 * config written by a newer release, or hand-edited in the raw editor, has to
 * degrade to a slightly emptier screen and a message — never to an error page.
 * `parseConfigStrict` is the write path's job, in
 * src/app/actions/dashboardConfig.ts.
 */

/** A dashboard as the switcher needs it — everything except the config itself. */
export type DashboardSummary = {
  id: string;
  slug: string;
  title: string;
  icon: string | null;
  sortOrder: number;
  /**
   * True when this is somebody else's dashboard, published to the tenant.
   *
   * The switcher shows it, and the screen renders it READ-ONLY. Carried on the
   * summary rather than recomputed at the point of use, so the one place that
   * knows whose row it is decides, and nothing downstream has to ask again.
   */
  shared: boolean;
};

/** A dashboard with its config parsed and whatever had to be dropped named. */
export type LoadedDashboard = {
  /**
   * True when this dashboard belongs to somebody else and was published to the
   * tenant. The screen renders it READ-ONLY: a viewer editing a shared dashboard
   * would be editing the author's, for everybody, which is not what "view" means.
   */
  shared: boolean;
  /**
   * `null` for the default dashboard.
   *
   * This is the whole "has this user taken control yet?" signal. A user who has
   * never edited anything has no row, and nothing is written on their behalf
   * until they make a change — see `defaultDashboard` below. A caller with a null
   * id knows the next edit has to go through `takeControl()` first.
   */
  id: string | null;
  slug: string;
  title: string;
  icon: string | null;
  sortOrder: number;
  config: DashboardConfig;
  /**
   * The row's revision, as an ISO string, or `null` for the default dashboard —
   * which has no row and therefore no revision yet.
   *
   * This is the optimistic-concurrency fence the editor's autosave writes
   * against: it sends back the revision it loaded, and the server refuses the
   * write if the row has moved on since. An ISO string rather than a Date
   * because it crosses the server→client boundary.
   */
  updatedAt: string | null;
  /** Human-readable notes about parts of the stored config that were removed. */
  dropped: string[];
};

/**
 * The address and name of the dashboard a user gets before they have made one.
 *
 * Exported because the write path has to agree with the read path about them:
 * `takeControl()` materialises exactly this row, and if the two files disagreed
 * about the slug the user would take control and then find themselves looking at
 * a different (empty) screen.
 */
export const DEFAULT_DASHBOARD_SLUG = "home";
export const DEFAULT_DASHBOARD_TITLE = "Home";

/**
 * Every dashboard belonging to the signed-in user, in switcher order.
 *
 * `createdAt` breaks ties on sortOrder rather than leaving the order to the
 * planner. Duplicate sortOrder values are legal — only `reorderDashboards`
 * renumbers, and until it runs every dashboard a user creates shares whatever
 * position it was given — so without the tiebreak the switcher could reorder
 * itself between two renders of the same data, which reads as a bug in the drag
 * handle rather than as an unspecified sort.
 */
export const dashboardsForViewer = cache(async (): Promise<DashboardSummary[]> => {
  const { user } = await dashboardViewer();
  const tenantId = await viewerTenantId();
  const rows = await prisma.dashboard.findMany({
    /*
     * The viewer's own dashboards, plus any published IN THIS WORKSPACE.
     *
     * This used to lean on the scoped `prisma` client for the tenant boundary.
     * db.ts is explicit that there is none while enforcement is dormant — it
     * returns args untouched — so a bare `sharedAt: { not: null }` matched every
     * tenant's published dashboards, and tenant A's "Sales" listed for tenant B.
     * The predicate names the tenant itself now rather than assuming something
     * upstream added one.
     */
    where: { OR: [{ userId: user.id }, sharedInTenant(tenantId)] },
    select: {
      id: true,
      slug: true,
      title: true,
      icon: true,
      sortOrder: true,
      userId: true,
      sharedAt: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  /*
   * A viewer's OWN dashboard wins over a shared one at the same address.
   *
   * Both can legitimately be called "sales", and the switcher would otherwise
   * show two entries that lead to the same URL — where only one of them can
   * ever be opened. Own-first is the right precedence: a person's own screen
   * should not be displaced by something published over it.
   */
  const seen = new Set<string>();
  const summaries: DashboardSummary[] = [];
  for (const row of [...rows.filter((r) => r.userId === user.id), ...rows.filter((r) => r.userId !== user.id)]) {
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    summaries.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      icon: row.icon,
      sortOrder: row.sortOrder,
      shared: row.userId !== user.id,
    });
  }
  return summaries;
});

/**
 * One of the signed-in user's dashboards, by address, with its config parsed.
 *
 * `null` when they have no dashboard at that address — including when the
 * address belongs to somebody else's dashboard, because the `where` is scoped to
 * the session user and a row that is not theirs is indistinguishable from a row
 * that does not exist. That is the intended answer: "not found" leaks nothing
 * about whose it is.
 *
 * The slug is put through `slugify` before it reaches the query. It arrives from
 * a URL segment, so `/Sales` and `/sales` are the same dashboard to a user, and
 * normalising here means they are also the same cache key and the same row rather
 * than one hit and one 404.
 */
export const dashboardBySlug = cache(async (slug: string): Promise<LoadedDashboard | null> => {
  const { user } = await dashboardViewer();
  const path = slugify(slug);
  /*
   * The viewer's own dashboard at this address, or one published to the tenant.
   *
   * OWN FIRST, and that ordering is the whole reason this is two queries rather
   * than one `OR`. Both can legitimately be called "sales", and a single query
   * would return whichever row the planner reached first — so a person's own
   * screen could be displaced by something somebody else published over it,
   * intermittently, which is the worst possible way for that to behave.
   */
  // BOTH selects carry `userId` AND `updatedAt`. This branch added `userId`
  // (the return distinguishes somebody else's published dashboard from your own
  // to render it read-only) and main added `updatedAt`; the return block below
  // reads both, so either one missing from either query is a type error at best
  // and a wrong `shared` flag at worst.
  const SELECT = {
    id: true,
    slug: true,
    title: true,
    icon: true,
    sortOrder: true,
    config: true,
    userId: true,
    updatedAt: true,
  } as const;
  const row =
    (await prisma.dashboard.findFirst({
      where: { userId: user.id, slug: path },
      select: SELECT,
    })) ??
    (await prisma.dashboard.findFirst({
      // Same rule as the switcher: published HERE, not published anywhere.
      where: { slug: path, ...sharedInTenant(await viewerTenantId()) },
      select: SELECT,
    }));
  if (!row) return null;
  const { config, dropped } = parseConfig(row.config);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    icon: row.icon,
    sortOrder: row.sortOrder,
    // Somebody else's, published to the tenant. The screen uses this to
    // render read-only rather than letting a viewer edit the author's copy.
    shared: row.userId !== user.id,
    config,
    updatedAt: row.updatedAt.toISOString(),
    dropped,
  };
});

/**
 * What a user with no dashboards of their own sees.
 *
 * THIS IS THE "NOT YET TAKEN CONTROL" STATE, and the point of it is that NOTHING
 * IS WRITTEN. A user who has never opened the editor has no row; they get this,
 * built fresh from `DEFAULT_LAYOUT`, and the first row appears only when they
 * make an edit (`takeControl()` in the action file). Seeding a row on first login
 * instead would freeze every existing user's screen at whatever the catalogue
 * contained on the day they signed in — a card added in a later release would
 * never reach anyone who had already logged in once, which is the opposite of
 * what a default is for. Left unwritten, the default follows the catalogue.
 *
 * The result is the same content the fixed dashboard shows today: the full
 * catalogue in catalogue order, in one view, one section, three columns.
 * Permission and module filtering happens downstream, at render, exactly as it
 * does for a saved config — the default deliberately does not pre-filter, so a
 * permission granted later brings its card back without anyone having to re-add
 * it.
 *
 * `span` comes from the CATALOGUE, not from the config schema's default of 1. A
 * builtin card's width is a property of the card — "Sales stats" is a full-width
 * strip and always was — so taking it from `registry.ts` is what makes this
 * pixel-for-pixel the screen the user already had. (The SQL backfill in migration
 * 20260805140000 cannot do this: the catalogue is TypeScript and Postgres has no
 * way to read it. A renderer must therefore prefer the catalogue's span for
 * builtin cards regardless of what is stored.)
 *
 * Built FRESH on every call rather than shared as a module constant: the parse
 * and budget helpers in config.ts mutate the arrays they are handed, and one
 * request trimming a shared default would change what the next request renders.
 * It is a dozen small objects; the memo is not worth the aliasing bug.
 */
export function defaultDashboard(): LoadedDashboard {
  const cards: CardConfig[] = DEFAULT_LAYOUT.map((id, index) => ({
    id: `card-${index + 1}`,
    type: "builtin",
    card: id,
    span: cardById(id)?.span ?? 1,
  }));
  return {
    id: null,
    // A generated default is always the viewer's own - there is nobody else it
    // could belong to - so it stays editable.
    shared: false,
    slug: DEFAULT_DASHBOARD_SLUG,
    title: DEFAULT_DASHBOARD_TITLE,
    icon: null,
    sortOrder: 0,
    config: {
      version: CONFIG_VERSION,
      views: [
        {
          id: "view-home",
          title: DEFAULT_DASHBOARD_TITLE,
          path: DEFAULT_DASHBOARD_SLUG,
          columns: 3,
          sections: [{ id: "section-home", columnSpan: 3, cards }],
        },
      ],
    },
    // No row, so no revision. `takeControl()` materialises the row on the first
    // edit and hands back the stamp the editor's first save fences against.
    updatedAt: null,
    dropped: [],
  };
}
