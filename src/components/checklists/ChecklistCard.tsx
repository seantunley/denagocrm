import Link from "next/link";
import { CheckCircle2, ClipboardList, TriangleAlert } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { hostById, hostHref } from "@/lib/checklists/hosts";
import type { ChecklistRunRow, ChecklistTemplateRow } from "@/lib/checklists/store";
import { CAPTURE_KINDS, outstanding, type CaptureKind } from "@/lib/checklists/types";
import ChecklistRunner, {
  type RunnerEntry,
  type RunnerTemplate,
} from "./ChecklistRunner";

/**
 * The checklists on one record, as a block on that record's own page.
 *
 * ── A SERVER COMPONENT THAT FETCHES NOTHING ─────────────────────────────────
 *
 * The rows come in as props, from `templatesForHost` and `runsForHost` in
 * lib/checklists/store.ts. Not fetched here, for two reasons. The host page has
 * already resolved the record and the viewer, so a query here is a second query
 * behind answers it is holding; and `runsForHost` authorises the HOST before it
 * returns anything, which means the page that decides whether to draw this block
 * and the query that decides whether the viewer may see it stay one decision.
 * Same division of labour as the dashboard canvas.
 *
 * ── WHY THE RUNNER IS MOUNTED HERE RATHER THAN LINKED TO ────────────────────
 *
 * Capture is a full-height sheet over this page, not a route of its own. A route
 * would re-resolve the record, the template and the half-finished run from a
 * URL — three lookups to arrive back at data this page already has — and would
 * drop somebody in a workshop somewhere they then have to navigate back from.
 * The sheet closes onto the record they were already looking at.
 *
 * ── WHAT "OUTSTANDING" MEANS HERE ───────────────────────────────────────────
 *
 * `outstanding()`, over the entry SNAPSHOTS, exactly as the capture screen and
 * `completeChecklistRun` do it. So a run this card calls complete is one the
 * server will also accept as complete, and a list edited this morning cannot
 * make last week's finished handover start reading as unfinished.
 */

export default function ChecklistCard({
  tenantId,
  userId,
  hostType,
  hostId,
  templates,
  runs,
  people,
  canCapture = true,
}: {
  /** Needed to build the blob path the upload route will authorise. */
  tenantId: string;
  userId: string;
  hostType: string;
  hostId: string;
  /** The ACTIVE lists for this host — `templatesForHost(host)`. */
  templates: ChecklistTemplateRow[];
  /** `runsForHost(hostType, hostId)`, newest first. */
  runs: ChecklistRunRow[];
  /**
   * User id → display name, for the byline.
   *
   * Optional and resolved by the page. A run stores who by ID; looking the names
   * up here would be one query per card for something the page usually already
   * has, and an id on screen is no use to anybody.
   */
  people?: Record<string, string>;
  /**
   * Whether this viewer may record against this record.
   *
   * Decided by the page from `canUseHost` and never re-derived here. A second
   * copy of "who may capture" is a second answer, and the one that disagrees is
   * the one nobody tests.
   */
  canCapture?: boolean;
}) {
  const host = hostById(hostType);
  // An unknown host string means a payload naming something this build does not
  // have. Drawing nothing is the safe reading; hosts.ts is the only catalogue.
  if (!host) return null;

  const usable = templates.map(toRunnerTemplate);
  const unfinished = runs.filter((run) => !run.completedAt);
  const startable = usable.filter(
    (template) => !unfinished.some((run) => run.templateId === template.id),
  );
  if (!canCapture && runs.length === 0 && usable.length === 0) return null;

  return (
    <section className="card space-y-3" aria-labelledby={`checklists-${hostId}`}>
      <div>
        <h2
          id={`checklists-${hostId}`}
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground"
        >
          <ClipboardList className="size-4 text-muted-foreground" aria-hidden="true" />
          {host.label}
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{host.description}</p>
      </div>

      {runs.length === 0 && usable.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          No lists are set up for this yet. One can be configured in Settings → Checklists.
        </p>
      )}

      {runs.length > 0 && (
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              tenantId={tenantId}
              userId={userId}
              hostType={hostType}
              hostId={hostId}
              template={usable.find((candidate) => candidate.id === run.templateId)}
              people={people}
              canCapture={canCapture}
            />
          ))}
        </ul>
      )}

      {canCapture && startable.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {startable.map((template) => (
            <ChecklistRunner
              key={template.id}
              tenantId={tenantId}
              userId={userId}
              hostType={hostType}
              hostId={hostId}
              template={template}
              triggerLabel={template.name}
            />
          ))}
        </div>
      )}

      {/* For anybody who reached this block from a list rather than the record. */}
      <p className="text-[10px] text-muted-foreground">
        <Link href={hostHref(host, hostId)} className="hover:text-foreground">
          Open the record
        </Link>
      </p>
    </section>
  );
}

function RunRow({
  run,
  tenantId,
  userId,
  hostType,
  hostId,
  template,
  people,
  canCapture,
}: {
  run: ChecklistRunRow;
  tenantId: string;
  userId: string;
  hostType: string;
  hostId: string;
  /** Absent when the list was deactivated or deleted after this run was taken. */
  template: RunnerTemplate | undefined;
  people?: Record<string, string>;
  canCapture: boolean;
}) {
  const gaps = outstanding(run.entries);
  const finished = Boolean(run.completedAt);
  const who = (id: string | null) => (id ? (people?.[id] ?? null) : null);

  /*
   * A run whose list has gone can still be READ — the snapshots on its entries
   * are what keep it readable — but it cannot be carried on, because there is no
   * list left to carry on with. A button that cannot work is worse than none.
   */
  const entries = template ? run.entries.map(toRunnerEntry) : [];
  const resumable = !finished && template !== undefined;

  const photos = run.entries.flatMap((entry) =>
    entry.photos.map((photo) => ({ ...photo, entryLabel: entry.labelSnapshot })),
  );
  const startedBy = who(run.startedById);
  const completedBy = who(run.completedById);

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{run.templateName}</p>
          <p className="text-[11px] text-muted-foreground">
            {finished
              ? `Completed ${formatDateTime(run.completedAt)}${completedBy ? ` by ${completedBy}` : ""}`
              : `Started ${formatDateTime(run.startedAt)}${startedBy ? ` by ${startedBy}` : ""}`}
            {` · v${run.templateVersion}`}
          </p>
        </div>

        {finished && gaps.length === 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
            <CheckCircle2 className="size-3" aria-hidden="true" />
            Complete
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            <TriangleAlert className="size-3" aria-hidden="true" />
            {gaps.length} outstanding
          </span>
        )}
      </div>

      {/*
        The gaps, NAMED. A count on its own says there is a problem and nothing
        about which step to go back to — and going back to a vehicle is the
        expensive part, so it has to be worth one trip rather than three.
      */}
      {gaps.length > 0 && (
        <ul className="space-y-0.5">
          {gaps.slice(0, 4).map((gap) => (
            <li key={`${gap.id}-${gap.reason}`} className="text-[11px] text-muted-foreground">
              <span className="text-foreground">{gap.label}</span> — {gap.reason}
            </li>
          ))}
          {gaps.length > 4 && (
            <li className="text-[11px] text-muted-foreground">…and {gaps.length - 4} more</li>
          )}
        </ul>
      )}

      {photos.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {photos.slice(0, 8).map((photo) => (
            <li key={photo.id}>
              <a href={photo.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- blob
                    storage is not a configured Next image domain, and a strip of
                    evidence thumbnails is not worth making it one. */}
                <img
                  src={photo.url}
                  alt={photo.entryLabel}
                  loading="lazy"
                  className="size-12 rounded-md border border-border object-cover"
                />
              </a>
            </li>
          ))}
          {photos.length > 8 && (
            <li className="grid size-12 place-items-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
              +{photos.length - 8}
            </li>
          )}
        </ul>
      )}

      {canCapture && resumable && template && (
        <ChecklistRunner
          tenantId={tenantId}
          userId={userId}
          hostType={hostType}
          hostId={hostId}
          template={template}
          run={{ id: run.id, templateVersion: run.templateVersion, startedAt: run.startedAt, entries }}
          triggerLabel="Carry on"
        />
      )}
    </li>
  );
}

/* ── store rows → what the client component takes ─────────────────────── */

/**
 * A stored capture kind, narrowed — anything unrecognised read as `photo`.
 *
 * `ChecklistItem.capture` is a text column, so a row written by a newer release
 * can hold a kind this build has never heard of. Same fail-closed reasoning as
 * `asEntryStatus` in the store, and `photo` is the closed direction here: it is
 * the most demanding kind, so an unknown step asks for evidence rather than
 * quietly needing nothing at all.
 */
function asCaptureKind(value: string): CaptureKind {
  return (CAPTURE_KINDS as readonly string[]).includes(value) ? (value as CaptureKind) : "photo";
}

function toRunnerTemplate(template: ChecklistTemplateRow): RunnerTemplate {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    items: template.items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      capture: asCaptureKind(item.capture),
      required: item.required,
      minPhotos: item.minPhotos,
      maxPhotos: item.maxPhotos,
      sortOrder: item.sortOrder,
    })),
  };
}

function toRunnerEntry(entry: ChecklistRunRow["entries"][number]): RunnerEntry {
  return {
    id: entry.id,
    itemId: entry.itemId,
    labelSnapshot: entry.labelSnapshot,
    descriptionSnapshot: entry.descriptionSnapshot,
    captureSnapshot: asCaptureKind(entry.captureSnapshot),
    requiredSnapshot: entry.requiredSnapshot,
    minPhotosSnapshot: entry.minPhotosSnapshot,
    maxPhotos: entry.maxPhotos,
    sortOrder: entry.sortOrder,
    status: entry.status,
    // `EntryState` allows undefined for these; the runner's working copy does
    // not, because `??` on every read of a tri-state is how one of them gets
    // missed and an empty note reads as a missing one.
    note: entry.note ?? null,
    value: entry.value ?? null,
    skipReason: entry.skipReason ?? null,
    photoCount: entry.photoCount,
    photos: entry.photos.map((photo) => ({ id: photo.id, url: photo.url })),
  };
}
