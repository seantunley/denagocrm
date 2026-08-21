import "server-only";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { requireChecklistHostAccess } from "./hostRecords";
import type { HostId } from "./hosts";
import { CHECKLIST_LIMITS, ENTRY_STATUSES, type EntryState, type EntryStatus } from "./types";

/**
 * The READ path for checklists. The write paths are
 * src/app/actions/checklistTemplates.ts (configuration) and
 * src/app/actions/checklistRuns.ts (capture).
 *
 * ── WHOSE CHECKLISTS ────────────────────────────────────────────────────────
 *
 * Every function here resolves the workspace ITSELF, from `actingTenantId()`,
 * and there is deliberately no `tenantId` parameter anywhere in this file. These
 * are called from server components whose props ultimately come from a URL, so a
 * function that accepted a workspace id would let one business's handover
 * evidence be addressed by another. Same rule as lib/dashboard/store.ts, for the
 * same reason.
 *
 * The queries run on `basePrisma` with the workspace named in every `where`,
 * matching ./hostRecords.ts. That is not an oversight: `basePrisma` sets
 * `app.bypass_rls`, and the scoped client adds no predicate of its own while
 * tenant enforcement is dormant (see db.ts), so the hand-written `tenantId` is
 * the boundary rather than a belt over one. Removing it would not narrow to the
 * workspace — it would widen to every workspace, silently.
 *
 * ── AND THE HOST GATE, ON READS TOO ─────────────────────────────────────────
 *
 * `runsForHost` and `runById` go through `requireChecklistHostAccess` before
 * returning anything. hostRecords.ts names the write paths, but a run is a set of
 * photographs of somebody's vehicle: reading one is a disclosure, and "the page
 * that calls this is already gated" is an assumption about a caller rather than a
 * property of this function. Both calls are memoised, so the record page pays for
 * the check once however many components ask.
 *
 * Templates are NOT host-record gated — there is no record to gate on, a template
 * names a SITUATION rather than a subject — so they are workspace-scoped only.
 * The action file is where configuring one is gated.
 *
 * ── MEMOISED PER REQUEST ────────────────────────────────────────────────────
 *
 * Every export is wrapped in React's `cache()`. A record page renders the run
 * list, each run's steps and a completeness badge from the same rows; without the
 * memo that is three identical queries, each of them dragging every photo row
 * along with it.
 *
 * ── DATES CROSS AS STRINGS ──────────────────────────────────────────────────
 *
 * The capture screen is a client component that keeps its own queue in the
 * browser, so everything here has to survive serialisation. ISO strings do; a
 * `Date` handed to a client component is a runtime error nobody sees until the
 * page is opened on a phone.
 */

/* ── row shapes ───────────────────────────────────────────────────────── */

export type ChecklistItemRow = {
  id: string;
  label: string;
  description: string | null;
  capture: string;
  required: boolean;
  minPhotos: number;
  maxPhotos: number;
  /** The shared condition grammar, as stored. Parsed by the renderer. */
  visibility: unknown;
  sortOrder: number;
};

export type ChecklistTemplateRow = {
  id: string;
  host: string;
  name: string;
  description: string | null;
  active: boolean;
  version: number;
  sortOrder: number;
  items: ChecklistItemRow[];
};

export type ChecklistPhotoRow = {
  id: string;
  url: string;
  capturedAt: string;
};

/**
 * One answered step, as a screen needs it: the completeness inputs
 * ({@link EntryState}) plus the things only a renderer cares about.
 *
 * It EXTENDS `EntryState` rather than restating those fields, so the badge on the
 * screen and the refusal in `completeChecklistRun` are computed from one shape by
 * one function. Two shapes here is how a run comes to look finished on the page
 * and be refused on the server.
 */
export type ChecklistEntryRow = EntryState & {
  itemId: string | null;
  descriptionSnapshot: string | null;
  sortOrder: number;
  recordedAt: string | null;
  /** How many more photos this step will accept. See {@link entryMaxPhotos}. */
  maxPhotos: number;
  photos: ChecklistPhotoRow[];
};

export type ChecklistRunRow = {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  hostType: string;
  hostId: string;
  startedAt: string;
  startedById: string | null;
  completedAt: string | null;
  completedById: string | null;
  entries: ChecklistEntryRow[];
};

/* ── the two coercions the read and write paths must agree on ─────────── */

/**
 * A stored status, narrowed — with anything unrecognised read as `pending`.
 *
 * `ChecklistEntry.status` is a text column, so a row written by a newer release
 * (or by hand) can hold a value this build has never heard of. Failing CLOSED
 * matters in one direction only: an unknown status treated as `done` would let a
 * run be completed with a step nobody has actually answered, while an unknown
 * status treated as `pending` merely asks somebody to look at it. Same reasoning
 * as the `default:` arms in lib/dashboard/conditions.ts.
 */
export function asEntryStatus(value: string): EntryStatus {
  return (ENTRY_STATUSES as readonly string[]).includes(value) ? (value as EntryStatus) : "pending";
}

/**
 * How many photos a step will accept.
 *
 * The live item's `maxPhotos` when the step still exists. When it does not —
 * `ChecklistEntry.itemId` is SET NULL on purpose, so evidence outlives the step
 * that asked for it — there is no `maxPhotosSnapshot` column to fall back to, and
 * inventing a generous default would turn every orphaned step into an unbounded
 * photo bucket that any device holding its id could keep filling. The snapshot of
 * what the run was ASKED for is the only surviving statement of intent, so that
 * is the cap, floored at one so a step that wanted no photos can still be
 * corrected with one.
 *
 * Clamped to `photosPerItem` at both ends, because the stored number predates any
 * later tightening of the cap.
 */
export function entryMaxPhotos(
  itemMaxPhotos: number | null | undefined,
  minPhotosSnapshot: number,
): number {
  const wanted = itemMaxPhotos ?? Math.max(minPhotosSnapshot, 1);
  return Math.min(Math.max(wanted, 1), CHECKLIST_LIMITS.photosPerItem);
}

/** The fields completeness is decided from, as they sit in the database. */
export type EntrySnapshotRow = {
  id: string;
  labelSnapshot: string;
  captureSnapshot: string;
  requiredSnapshot: boolean;
  minPhotosSnapshot: number;
  status: string;
  note: string | null;
  value: string | null;
  skipReason: string | null;
};

/**
 * A database row as `outstanding()` wants it.
 *
 * Shared by this file and `completeChecklistRun` deliberately: the screen's "2
 * steps left" and the server's refusal have to be the same computation over the
 * same inputs, or a person is told they are finished and then told they are not.
 * `photoCount` is passed in rather than read here because the two callers count
 * it differently — one has the photo rows in hand, the other only a `_count`.
 */
export function entryState(row: EntrySnapshotRow, photoCount: number): EntryState {
  return {
    id: row.id,
    labelSnapshot: row.labelSnapshot,
    captureSnapshot: row.captureSnapshot,
    requiredSnapshot: row.requiredSnapshot,
    minPhotosSnapshot: row.minPhotosSnapshot,
    status: asEntryStatus(row.status),
    note: row.note,
    value: row.value,
    skipReason: row.skipReason,
    photoCount,
  };
}

/* ── selects ──────────────────────────────────────────────────────────── */

const TEMPLATE_SELECT = {
  id: true,
  host: true,
  name: true,
  description: true,
  active: true,
  version: true,
  sortOrder: true,
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      label: true,
      description: true,
      capture: true,
      required: true,
      minPhotos: true,
      maxPhotos: true,
      visibility: true,
      sortOrder: true,
    },
  },
} satisfies Prisma.ChecklistTemplateSelect;

const RUN_SELECT = {
  id: true,
  templateId: true,
  templateVersion: true,
  hostType: true,
  hostId: true,
  startedAt: true,
  startedById: true,
  completedAt: true,
  completedById: true,
  template: { select: { name: true } },
  entries: {
    orderBy: [{ sortOrder: "asc" }, { labelSnapshot: "asc" }],
    select: {
      id: true,
      itemId: true,
      labelSnapshot: true,
      descriptionSnapshot: true,
      captureSnapshot: true,
      requiredSnapshot: true,
      minPhotosSnapshot: true,
      sortOrder: true,
      status: true,
      note: true,
      value: true,
      skipReason: true,
      recordedAt: true,
      item: { select: { maxPhotos: true } },
      photos: { orderBy: { capturedAt: "asc" }, select: { id: true, url: true, capturedAt: true } },
    },
  },
} satisfies Prisma.ChecklistRunSelect;

/*
 * The row shapes are DERIVED from the selects above rather than written out
 * again. A hand-written mirror of a select is a thing that goes stale silently:
 * add a column to one and the other keeps compiling, having quietly stopped
 * describing what the query returns.
 */
type TemplateShape = Prisma.ChecklistTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;
type RunShape = Prisma.ChecklistRunGetPayload<{ select: typeof RUN_SELECT }>;

function toTemplateRow(row: TemplateShape): ChecklistTemplateRow {
  return {
    id: row.id,
    host: row.host,
    name: row.name,
    description: row.description,
    active: row.active,
    version: row.version,
    sortOrder: row.sortOrder,
    items: row.items.map((item) => ({ ...item })),
  };
}

function toRunRow(row: RunShape): ChecklistRunRow {
  return {
    id: row.id,
    templateId: row.templateId,
    templateName: row.template.name,
    templateVersion: row.templateVersion,
    hostType: row.hostType,
    hostId: row.hostId,
    startedAt: row.startedAt.toISOString(),
    startedById: row.startedById,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedById: row.completedById,
    entries: row.entries.map((entry) => ({
      ...entryState(entry, entry.photos.length),
      itemId: entry.itemId,
      descriptionSnapshot: entry.descriptionSnapshot,
      sortOrder: entry.sortOrder,
      recordedAt: entry.recordedAt?.toISOString() ?? null,
      maxPhotos: entryMaxPhotos(entry.item?.maxPhotos, entry.minPhotosSnapshot),
      photos: entry.photos.map((photo) => ({
        id: photo.id,
        url: photo.url,
        capturedAt: photo.capturedAt.toISOString(),
      })),
    })),
  };
}

/* ── templates ────────────────────────────────────────────────────────── */

/**
 * The configured lists for one situation, in the order somebody arranged them.
 *
 * ACTIVE ONLY BY DEFAULT, and the default is the safe one: the capture screen's
 * picker must never offer a list that was deactivated precisely so it would stop
 * being used. The editor in Settings passes `true` to see the rest, and it is the
 * only caller that should.
 *
 * `createdAt` breaks ties on `sortOrder` because duplicate positions are legal —
 * only `reorderChecklistTemplates` renumbers — and an unspecified sort would let
 * the picker reorder itself between two renders of identical data.
 */
export const templatesForHost = cache(
  async (host: HostId, includeInactive = false): Promise<ChecklistTemplateRow[]> => {
    const tenantId = await actingTenantId();
    const rows = await basePrisma.checklistTemplate.findMany({
      where: { tenantId, host, ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: TEMPLATE_SELECT,
    });
    return rows.map(toTemplateRow);
  },
);

/**
 * One configured list, or null.
 *
 * Null covers "no such template" AND "somebody else's template" — the `where`
 * carries the workspace, so a row that is not ours is indistinguishable from a
 * row that does not exist. That is the intended answer: distinguishing them would
 * confirm that another business has a list with this id.
 */
export const templateById = cache(async (id: string): Promise<ChecklistTemplateRow | null> => {
  const tenantId = await actingTenantId();
  const row = await basePrisma.checklistTemplate.findFirst({
    where: { id, tenantId },
    select: TEMPLATE_SELECT,
  });
  return row ? toTemplateRow(row) : null;
});

/* ── runs ─────────────────────────────────────────────────────────────── */

/**
 * The checklists captured against one record, newest first.
 *
 * The host is authorised BEFORE the rows are fetched, not after — an unauthorised
 * caller must not be able to time the difference between a record with runs and
 * one without, and more plainly, there is no reason to read evidence we are about
 * to discard.
 */
export const runsForHost = cache(
  async (hostType: string, hostId: string): Promise<ChecklistRunRow[]> => {
    const tenantId = await actingTenantId();
    await requireChecklistHostAccess(hostType, hostId, tenantId);
    const rows = await basePrisma.checklistRun.findMany({
      where: { tenantId, hostType, hostId },
      orderBy: [{ startedAt: "desc" }],
      select: RUN_SELECT,
    });
    return rows.map(toRunRow);
  },
);

/**
 * One captured checklist, or null.
 *
 * Two steps, and the order is the point: the run is resolved WITHIN this
 * workspace first, and only then is its host authorised. Reversed, the caller
 * would be naming the host themselves, and a run could be read by anybody who
 * could name any record they happen to have access to.
 */
export const runById = cache(async (id: string): Promise<ChecklistRunRow | null> => {
  const tenantId = await actingTenantId();
  const row = await basePrisma.checklistRun.findFirst({
    where: { id, tenantId },
    select: RUN_SELECT,
  });
  if (!row) return null;
  await requireChecklistHostAccess(row.hostType, row.hostId, tenantId);
  return toRunRow(row);
});
