"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser, requireTenantOwner } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import type { ActionResult } from "@/lib/actionResultTypes";
import {
  CONFIG_VERSION,
  LIMITS,
  parseConfigStrict,
  slugify,
  type DashboardConfig,
} from "@/lib/dashboard/config";
import { defaultDashboard } from "@/lib/dashboard/store";

/**
 * The WRITE path for user-built dashboards. The read path is
 * src/lib/dashboard/store.ts.
 *
 * WHOSE DASHBOARD. Every function here derives the acting user from the SESSION
 * (`requireUser()`), never from an argument, and there is deliberately no
 * `userId` parameter anywhere in this file — the same rule
 * src/app/actions/dashboard.ts follows. A server action is reachable by direct
 * POST, so a user id in the payload would be an open invitation to rewrite, or
 * read back, somebody else's screen. Dashboards are addressed by SLUG, and a slug
 * is resolved through `ownDashboard()`, which filters on the session user's id;
 * the row id that reaches a `where` clause has therefore always just been proved
 * to belong to the caller.
 *
 * TENANCY. Everything goes through the scoped `prisma` client, not `basePrisma`,
 * so the tenant extension adds `tenantId` to the `where` on read, update and
 * delete ONCE ENFORCEMENT IS ON. No `$queryRaw` and no `basePrisma`, so no
 * hand-written tenant predicate is needed on the read side.
 *
 * THE CREATE SIDE IS DIFFERENT, and this comment used to get it wrong. The
 * extension stamps NOTHING until enforcement is on — `scopeArgs` in db.ts returns
 * its args untouched unless `tenantEnforcing()`, which is false in every
 * environment today — so "the extension stamps tenantId on create" described a
 * future, and every dashboard created in the meantime was written with a NULL
 * tenant (1 of 1 on production at the 2026-08-10 audit). That is not merely
 * invisible-at-the-flip: `@@unique([tenantId, userId, slug])` does not bind on
 * NULL, which is why migration 20260805140000 had to carry a second, partial
 * index to stop a double-click producing two dashboards at one address. So the
 * creates below name the acting workspace themselves, and the real constraint
 * starts doing its job.
 *
 * NO PERMISSION KEY, matching the layout actions. Arranging your own screens is
 * not a privileged act, and inventing a `dashboards.manage` permission would mean
 * every existing role had to be granted it before anyone could move a card.
 * `requireUser()` is the whole gate. WHAT a card may show is decided elsewhere,
 * per card, per request — a config is a description of a screen and confers
 * nothing; a card that queries data is answered under the viewer's own scopes.
 *
 * ONE DOOR FOR CONFIGS. `validated()` below is the only function in this file
 * that produces a value for the `config` column, and it always runs
 * `parseConfigStrict` first. That is what stops a config the renderer cannot read
 * from being stored at all — and, just as important, what makes the refusal
 * MESSAGE reach the user ("unknown card type 'guage'") instead of a config that
 * saves successfully with their card quietly missing.
 */

/* ── input shapes ─────────────────────────────────────────────────── */

const TITLE = z.string().trim().min(1).max(LIMITS.titleLength);

/**
 * A slug as it arrives from a client. Length-bounded and non-empty, then put
 * through `slugify` before it reaches a query — the client is not trusted to have
 * normalised it, and an unnormalised slug would simply fail to match a row, which
 * looks to the user like their dashboard has vanished.
 */
const SLUG = z.string().min(1).max(60);

/* ── the only way a config reaches the database ───────────────────── */

/**
 * Validate a config and turn it into something Prisma will accept for a Json
 * column.
 *
 * Refuses with the strict parser's own message, which is written for the person
 * who typed the thing — "Two tabs share the address \"sales\"", "Cannot group by
 * \"colour\"". Rewriting those into a generic "That could not be saved" is how a
 * raw-JSON editor becomes unusable.
 *
 * The JSON round trip is not decoration. `DashboardConfig` has optional fields,
 * so a parsed config can carry explicit `undefined` values, and Prisma's
 * `InputJsonValue` does not admit `undefined` — it is the difference between a
 * type error and, worse, a stored `null` where a key should simply be absent.
 * Stringify drops those keys, which is exactly the shape the parser expects to
 * read back.
 */
function validated(config: unknown): Prisma.InputJsonValue {
  const parsed = parseConfigStrict(config);
  if (!parsed.ok) refuse(parsed.error);
  return JSON.parse(JSON.stringify(parsed.config)) as Prisma.InputJsonValue;
}

/* ── resolving the caller's own rows ──────────────────────────────── */

/**
 * The caller's dashboard at this address, or a refusal.
 *
 * The `where` carries the session user's id, so a slug belonging to somebody else
 * simply does not match and the caller is told "not found" — the same answer they
 * get for an address that never existed. That is deliberate: distinguishing the
 * two would confirm that another user has a dashboard called "board-review".
 */
async function ownDashboard(userId: string, slug: unknown) {
  const parsed = SLUG.safeParse(slug);
  if (!parsed.success) refuse("That dashboard could not be found.");
  const row = await prisma.dashboard.findFirst({
    where: { userId, slug: slugify(parsed.data) },
    select: { id: true, slug: true, title: true, sortOrder: true, config: true },
  });
  if (!row) refuse("That dashboard could not be found.");
  return row;
}

/**
 * An address this user does not already have, derived from a title.
 *
 * A COLLISION GETS A SUFFIX, NOT AN ERROR. Two dashboards may legitimately be
 * called "Sales" — the title is the user's label and the slug is plumbing they
 * never asked to think about — so refusing the create would be refusing something
 * reasonable in order to protect an implementation detail. "sales", then
 * "sales-2", "sales-3".
 *
 * The base is trimmed to 55 characters before the suffix is appended so the
 * result cannot exceed the 60 the schema allows; slicing can leave a trailing
 * dash, which is stripped, and a slug that slices away to nothing falls back to
 * `slugify`'s own "tab" rather than the empty string.
 *
 * The loop is bounded by the per-user cap plus two. It cannot run out — a user
 * holds at most `dashboardsPerUser` rows, so at most that many suffixes are
 * taken — but an unbounded loop against a table is not something to leave lying
 * around, and the refusal is a message rather than a hang if the invariant ever
 * changes.
 */
async function freeSlug(userId: string, title: string): Promise<string> {
  const base = slugify(slugify(title).slice(0, 55).replace(/-+$/, ""));
  const taken = new Set(
    (
      await prisma.dashboard.findMany({
        where: { userId, slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= LIMITS.dashboardsPerUser + 2; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  refuse("Could not find a free address for that dashboard.");
}

/** How many dashboards the caller already owns. */
async function ownCount(userId: string): Promise<number> {
  return prisma.dashboard.count({ where: { userId } });
}

/**
 * The cap, checked on every path that can add a row.
 *
 * `LIMITS.dashboardsPerUser` is about cost, not tidiness: each dashboard is a row
 * in the switcher on every page and a set of queries the moment it is opened. The
 * ceiling has to be one the user cannot raise from the client.
 */
function refuseIfFull(count: number): void {
  if (count >= LIMITS.dashboardsPerUser) {
    refuse(`You already have ${LIMITS.dashboardsPerUser} dashboards. Delete one to add another.`);
  }
}

/**
 * A brand-new dashboard's config: one empty view, ready to have cards dropped
 * into it.
 *
 * Not empty-empty. A config with no views renders as nothing at all, and the
 * first thing a user does after creating a dashboard is look for somewhere to put
 * a card — so the section they need already exists.
 */
function starterConfig(title: string, slug: string): DashboardConfig {
  return {
    version: CONFIG_VERSION,
    title,
    views: [
      {
        // Ids only have to be unique WITHIN one config, so deriving them from the
        // slug is both stable and collision-free here. Sliced to the 40 the
        // schema allows.
        id: `view-${slug}`.slice(0, 40),
        title,
        path: slug,
        columns: 3,
        sections: [{ id: `section-${slug}`.slice(0, 40), columnSpan: 3, cards: [] }],
      },
    ],
  };
}

/**
 * Revalidation.
 *
 * `"layout"` for anything that changes the SET of dashboards, because the
 * switcher is rendered in the app chrome — revalidating the page alone leaves a
 * renamed or deleted dashboard sitting in the nav until the next hard load, which
 * users read as the action having failed. A config save changes only the page.
 */
function revalidateSwitcher(): void {
  revalidatePath("/", "layout");
}

/* ── actions ──────────────────────────────────────────────────────── */

/** Add a dashboard. */
export async function createDashboard(title: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const parsed = TITLE.safeParse(title);
    if (!parsed.success) refuse("Give the dashboard a name.");
    const count = await ownCount(user.id);
    refuseIfFull(count);
    const slug = await freeSlug(user.id, parsed.data);
    await prisma.dashboard.create({
      data: {
        userId: user.id,
        slug,
        title: parsed.data,
        // Appended, not inserted: a new dashboard must not push the one the user
        // is looking at out from under them.
        sortOrder: count,
        config: validated(starterConfig(parsed.data, slug)),
      },
    });
    revalidateSwitcher();
    return { success: `"${parsed.data}" created.` };
  });
}

/**
 * Rename a dashboard.
 *
 * The title lives in two places — the column, which the switcher reads without
 * parsing anything, and the config, which is what a user gets if they export or
 * hand-edit the JSON. Both are updated here so they cannot drift; the SLUG is
 * deliberately left alone, because it is in the URL and in whatever the user has
 * bookmarked, and silently moving a page on rename is worse than a stale address.
 */
export async function renameDashboard(slug: unknown, title: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const parsed = TITLE.safeParse(title);
    if (!parsed.success) refuse("Give the dashboard a name.");
    const row = await ownDashboard(user.id, slug);
    const stored = parseConfigStrict(row.config);
    await prisma.dashboard.update({
      where: { id: row.id },
      data: {
        title: parsed.data,
        // The config's title is brought into step ONLY when the stored config
        // still parses strictly. A config saved under an older release, or one a
        // rule change has since made invalid, must stay renameable — and
        // rewriting it from here would mean the rename silently repaired it,
        // which is to say discarded the parts that no longer parse. Renaming is
        // how a user labels the thing they are on their way to go and fix.
        ...(stored.ok ? { config: validated({ ...stored.config, title: parsed.data }) } : {}),
      },
    });
    revalidateSwitcher();
    return { success: `Renamed to "${parsed.data}".` };
  });
}

/**
 * Delete a dashboard.
 *
 * Deleting the LAST one is allowed. A user with no rows falls back to
 * `defaultDashboard()`, which is a complete, working screen rather than a broken
 * state — so there is nothing to protect them from, and a "you must keep at least
 * one" refusal would only be protecting the code.
 */
export async function deleteDashboard(slug: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const row = await ownDashboard(user.id, slug);
    await prisma.dashboard.delete({ where: { id: row.id } });
    revalidateSwitcher();
    return { success: `"${row.title}" deleted.` };
  });
}

/**
 * Set the switcher order from a list of slugs.
 *
 * TOTAL BY CONSTRUCTION. Anything the caller did not name keeps its relative
 * position and is appended, and anything named that is not theirs is ignored. A
 * client working from a stale list — a dashboard created in another tab, one
 * deleted in this one — therefore reorders what it knows about and cannot make a
 * dashboard disappear from the nav by omitting it.
 */
export async function reorderDashboards(slugs: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const parsed = z.array(SLUG).max(LIMITS.dashboardsPerUser).safeParse(slugs);
    if (!parsed.success) refuse("That order could not be saved.");
    const wanted = [...new Set(parsed.data.map(slugify))];

    const own = await prisma.dashboard.findMany({
      where: { userId: user.id },
      select: { id: true, slug: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const idBySlug = new Map(own.map((row) => [row.slug, row.id]));
    const named = wanted.filter((slug) => idBySlug.has(slug));
    const rest = own.map((row) => row.slug).filter((slug) => !named.includes(slug));

    // One transaction, so a failure halfway does not leave the switcher in an
    // order the user never chose. Bounded by dashboardsPerUser, so this is at
    // most a dozen statements.
    await prisma.$transaction(
      [...named, ...rest].map((slug, index) =>
        prisma.dashboard.update({ where: { id: idBySlug.get(slug)! }, data: { sortOrder: index } }),
      ),
    );
    revalidateSwitcher();
  });
}

/**
 * Replace a dashboard's config.
 *
 * The config arrives as `unknown` — it comes from the editor, or from the raw
 * JSON editor, which means it comes from a text box — and `validated()` is what
 * stands between that and the column. A refusal here is a message the user can
 * act on; the alternative, storing it and letting the lenient read path drop the
 * broken parts, would tell them their dashboard saved and then quietly show them
 * less of it than they built.
 */
export async function saveDashboardConfig(slug: unknown, config: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const row = await ownDashboard(user.id, slug);
    await prisma.dashboard.update({
      where: { id: row.id },
      data: { config: validated(config) },
    });
    // The page only — the switcher shows titles, and this changes none of them.
    revalidatePath("/");
    return { success: "Dashboard saved." };
  });
}

/**
 * Turn the default dashboard into a real row, on the user's first edit.
 *
 * WHY THIS EXISTS AT ALL. A user who has never edited anything has no row, and
 * `defaultDashboard()` in the store is what they see — which means the default
 * keeps following the catalogue as releases add and remove cards, instead of
 * being frozen at whatever it contained on the day they first logged in. The
 * price is that the first edit has nothing to write TO, and this is that moment:
 * the default is materialised verbatim, and from then on the dashboard is theirs.
 *
 * IDEMPOTENT, AND IT HAS TO BE. The editor calls this before its first save, and
 * "before the first save" is a race with itself the moment a user has two tabs
 * open. A caller who already has rows gets a no-op; a caller who loses the insert
 * race gets the same, because the partial unique index added in migration
 * 20260805140000 turns the second insert into a constraint violation rather than
 * a duplicate "home" — which is exactly why that index exists.
 */
export async function takeControl(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const count = await ownCount(user.id);
    // Already taken control. Not a refusal: the caller's intent — "make sure a
    // real row exists" — is already satisfied, and telling them otherwise would
    // turn a harmless double-click into an error message.
    if (count > 0) return {};
    refuseIfFull(count);
    const seed = defaultDashboard();
    try {
      await prisma.dashboard.create({
        data: {
          tenantId: await actingTenantId(),
          userId: user.id,
          slug: seed.slug,
          title: seed.title,
          sortOrder: 0,
          config: validated(seed.config),
        },
      });
    } catch {
      // Lost the race, or the row appeared between the count and the insert. If
      // there is now a row, the intent is satisfied and there is nothing to
      // report; if there is not, the failure was something else and must not be
      // swallowed.
      if ((await ownCount(user.id)) === 0) refuse("Could not set up your dashboard.");
    }
    revalidateSwitcher();
    return { success: "Dashboard ready to edit." };
  });
}

/**
 * Publish a dashboard to the rest of the tenant, or take it back.
 *
 * OWNER OF THIS WORKSPACE, not owner of the platform. Everyone can build their
 * own dashboards; deciding what the whole workspace sees is a different act — but
 * it is a TENANT-LOCAL one. `requireOwner()` was the wrong gate and said so in the
 * name: `role === "owner"` is a property of the platform, and under it the
 * provisioned owner of tenant B could not publish a dashboard to tenant B. The
 * only person who could was somebody outside their workspace entirely, whose
 * `ownDashboard()` lookup would then find nothing to publish. So the feature was
 * reachable by exactly one account on the whole platform and by nobody it was
 * built for.
 *
 * `requireTenantOwner()` is the predicate this needs and the one routeAccess.ts
 * spells out for the same distinction ("a surface that shows one workspace its
 * OWN data wants `tenantOwner`"): the platform owner, or `Tenant.ownerUserId` for
 * the ACTIVE workspace, resolved live from the row rather than from a JWT claim.
 * The UI asks `isTenantOwner()` — the same predicate, boolean — so the button and
 * this gate cannot disagree.
 *
 * `ownDashboard` still applies, so an owner can only publish something that is
 * THEIRS. That is deliberate rather than incidental: an owner publishing another
 * person's private dashboard to the company would be a surprising amount of
 * power hiding behind a toggle, and nobody asked for it. It is also the second
 * half of the tenant boundary — a platform owner acting in workspace A cannot
 * reach into B's rows, because a row that is not theirs does not resolve.
 *
 * WHAT SHARING DOES NOT DO is grant access to data. A shared dashboard is a
 * layout, and every card re-runs its own permission and module checks against
 * whoever is looking — `renderCard` and the loaders in lib/dashboard/cards.tsx
 * decide that per request. Two people opening the same shared dashboard can
 * legitimately see different cards, and a card the viewer may not see simply
 * does not render for them. Publishing a layout can therefore never widen
 * anybody's access to records.
 */
export async function setDashboardShared(
  slug: unknown,
  shared: unknown,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const row = await ownDashboard(user.id, slug);
    const publish = shared === true;

    await prisma.dashboard.update({
      where: { id: row.id },
      // sharedById is KEPT when unpublishing, so the record of who exposed
      // something to the whole workspace does not vanish with the flag.
      data: publish
        ? { sharedAt: new Date(), sharedById: user.id }
        : { sharedAt: null },
    });

    await logAudit({
      action: publish ? "dashboard.shared" : "dashboard.unshared",
      summary: publish
        ? `Published dashboard "${row.title}" to the workspace`
        : `Stopped sharing dashboard "${row.title}"`,
      user,
    });

    revalidateSwitcher();
    return {
      success: publish
        ? `"${row.title}" is now visible to everyone in this workspace.`
        : `"${row.title}" is private again.`,
    };
  });
}
