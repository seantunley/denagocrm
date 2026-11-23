/**
 * Guided paths through the help centre (2026-11-23): a short, ordered set of
 * guides for one kind of work — "New to the CRM", "Selling", "Running the
 * workshop" — with a tick for each one read. Pure: which paths a person is
 * offered, and how far along they are. Where the ticks are kept is
 * lib/help/readStore.ts.
 *
 * A path names articles by slug. Slugs that are not visible to this workspace
 * (the module is off) drop out, and a path left with fewer than three guides
 * is not offered at all — two links are not a path.
 */
export type HelpPathAudience = "everyone" | "managers" | "admins";
export type HelpPath = { key: string; label: string; blurb: string; audience: HelpPathAudience; slugs: readonly string[] };

export const HELP_PATHS: readonly HelpPath[] = [
  {
    key: "new",
    label: "New to the CRM",
    blurb: "From signing in to working comfortably.",
    audience: "everyone",
    slugs: ["welcome", "signing-in", "finding-your-way-around", "who-can-see-what", "install-on-your-phone", "everyday-conventions"],
  },
  {
    key: "selling",
    label: "Selling",
    blurb: "A lead from first contact to a signed quote and a delivery.",
    audience: "everyone",
    slugs: ["leads-pipeline-overview", "leads-create-a-lead", "leads-working-a-lead", "quotes-overview", "quotes-build-and-price", "quotes-send-revise-lock", "signatures-sign-a-quote", "deliveries-board"],
  },
  {
    key: "workshop",
    label: "Running the workshop",
    blurb: "Job cards from check-in to a finished service record.",
    audience: "everyone",
    slugs: ["jobcards-overview", "jobcards-open-new", "jobcards-workflow-stages", "jobcards-checkin-photos-inspection", "jobcards-complete-service-record", "workshop-calendar-bookings", "service-due-scheduling"],
  },
  {
    key: "customers",
    label: "Answering customers",
    blurb: "The shared inbox and help desk tickets.",
    audience: "everyone",
    slugs: ["inbox-overview", "inbox-replying", "cases-overview", "cases-working-a-ticket"],
  },
  {
    key: "managing",
    label: "Managing the team",
    blurb: "Targets, the forecast, reports and how the team is organised.",
    audience: "managers",
    slugs: ["targets-monthly-goals", "forecast-sales-pipeline", "forecast-managing-deals", "reports-sales-dashboard", "admin-teams", "admin-pipelines"],
  },
  {
    key: "admin",
    label: "Setting up the workspace",
    blurb: "Company details, people, access, integrations and backups.",
    audience: "admins",
    slugs: ["admin-company-profile", "admin-team-user-management", "admin-roles-permissions", "admin-integrations", "automatic-jobs-and-messages", "admin-backup-recovery"],
  },
];

export const MIN_PATH_LENGTH = 3;

/** What this person may be offered: managers see the manager path too, admins see all three levels. */
export type HelpReader = { manager: boolean; admin: boolean };

/** The paths for this reader, each cut down to the guides that exist for this workspace. */
export function pathsFor(visibleSlugs: ReadonlySet<string>, reader: HelpReader): HelpPath[] {
  return HELP_PATHS.filter((path) => path.audience === "everyone" || (path.audience === "managers" && (reader.manager || reader.admin)) || (path.audience === "admins" && reader.admin))
    .map((path) => ({ ...path, slugs: path.slugs.filter((slug) => visibleSlugs.has(slug)) }))
    .filter((path) => path.slugs.length >= MIN_PATH_LENGTH);
}

export type HelpPathProgress = { done: number; total: number; next: string | null; complete: boolean };

/** How far along a path someone is: guides read, and the first one not yet read. */
export function pathProgress(slugs: readonly string[], read: ReadonlySet<string>): HelpPathProgress {
  const done = slugs.filter((slug) => read.has(slug)).length;
  const next = slugs.find((slug) => !read.has(slug)) ?? null;
  return { done, total: slugs.length, next, complete: slugs.length > 0 && done === slugs.length };
}

/**
 * Guides worth pointing at from the front page. CHOSEN BY HAND, not measured:
 * the CRM does not record which guides are read most, so this is not called
 * "popular". The first few that exist for the workspace are shown.
 */
export const FEATURED_SLUGS: readonly string[] = [
  "quotes-build-and-price",
  "leads-working-a-lead",
  "assistant-ask-the-crm",
  "install-on-your-phone",
  "jobcards-open-new",
  "inbox-replying",
  "dashboards-arranging",
];
export const FEATURED_SHOWN = 4;

export function featuredFor(visibleSlugs: ReadonlySet<string>): string[] {
  return FEATURED_SLUGS.filter((slug) => visibleSlugs.has(slug)).slice(0, FEATURED_SHOWN);
}

/* ── The read list, as text (what readStore keeps) ───────────────────── */

export const MAX_READ_SLUGS = 500;

/** The stored text as a set. Anything that is not a list of slug-shaped strings reads as nothing. */
export function parseRead(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && /^[a-z0-9-]{1,80}$/.test(item)).slice(0, MAX_READ_SLUGS));
  } catch {
    return new Set();
  }
}

/** The stored text with one more guide read — or null when it is already there. */
export function withRead(raw: string | null | undefined, slug: string): string | null {
  const read = parseRead(raw);
  if (read.has(slug) || !/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  read.add(slug);
  return JSON.stringify([...read].slice(-MAX_READ_SLUGS));
}
