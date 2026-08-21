/**
 * The checklist wire format: what a template is, what a run submits, and what
 * "finished" means.
 *
 * PURE — no Prisma, no `server-only`. Every rule here is enforced on the way IN
 * (the actions parse through these schemas) and the interesting ones are
 * re-checked on the way out, because a run arrives from a phone that may have
 * been offline for an hour and is not a trusted input.
 */
import { z } from "zod";
import { HOST_IDS } from "./hosts";

/* ── what a step collects ─────────────────────────────────────────────── */

/**
 * The capture kinds, as a closed union.
 *
 * `photo` and `photo_note` are separate rather than one kind with a flag,
 * because the difference is visible in the UI (a note field appears) and in the
 * completeness rule (a note may be required). A flag would put that decision in
 * two places.
 */
export const CAPTURE_KINDS = ["photo", "photo_note", "boolean", "text", "number"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export function isPhotoCapture(kind: string): boolean {
  return kind === "photo" || kind === "photo_note";
}

/** What a person did with a step. */
export const ENTRY_STATUSES = ["pending", "done", "skipped", "na"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/* ── caps ─────────────────────────────────────────────────────────────── */

/**
 * Bounds, enforced on the write path and again on the read path.
 *
 * `itemsPerTemplate` is the one worth arguing about: a handover list of forty
 * steps is a list nobody finishes honestly, and the failure mode is somebody
 * tapping Skip forty times. Twenty-five is already generous for the job.
 */
export const CHECKLIST_LIMITS = {
  itemsPerTemplate: 25,
  photosPerItem: 6,
  labelLength: 80,
  descriptionLength: 300,
  noteLength: 500,
  valueLength: 200,
  skipReasonLength: 200,
  /** How many runs one device may sync in a single call. */
  runsPerSync: 5,
} as const;

/**
 * The shortest acceptable reason for skipping a REQUIRED step.
 *
 * A required step that can be skipped with an empty string is not required, and
 * the first time somebody asks why there is no serial-number photo on a disputed
 * handover, "someone tapped skip" is not an answer. Same reasoning as the
 * dismissal reason on the Attention Centre.
 */
export const MIN_SKIP_REASON = 4;

/* ── the template ─────────────────────────────────────────────────────── */

export const ITEM_INPUT = z.object({
  /** Absent for a new step; present when editing an existing one. */
  id: z.string().min(1).max(40).optional(),
  label: z.string().trim().min(1).max(CHECKLIST_LIMITS.labelLength),
  description: z.string().trim().max(CHECKLIST_LIMITS.descriptionLength).optional(),
  capture: z.enum(CAPTURE_KINDS).default("photo"),
  required: z.boolean().default(true),
  minPhotos: z.number().int().min(0).max(CHECKLIST_LIMITS.photosPerItem).default(1),
  maxPhotos: z.number().int().min(1).max(CHECKLIST_LIMITS.photosPerItem).default(1),
  /**
   * The shared condition grammar (lib/dashboard/conditions.ts). Parsed by the
   * action against that module's own schema rather than restated here — a second
   * definition of "if" is exactly the drift this codebase keeps removing.
   */
  visibility: z.unknown().optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type ChecklistItemInput = z.infer<typeof ITEM_INPUT>;

export const TEMPLATE_INPUT = z.object({
  host: z.enum(HOST_IDS),
  name: z.string().trim().min(1).max(CHECKLIST_LIMITS.labelLength),
  description: z.string().trim().max(CHECKLIST_LIMITS.descriptionLength).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
  items: z.array(ITEM_INPUT).max(CHECKLIST_LIMITS.itemsPerTemplate).default([]),
});
export type ChecklistTemplateInput = z.infer<typeof TEMPLATE_INPUT>;

/**
 * Rules zod cannot express, because they are about a step as a WHOLE.
 *
 * Returned as a list of messages rather than thrown, so the editor can show all
 * of them at once instead of revealing them one save at a time.
 */
export function templateProblems(input: ChecklistTemplateInput): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const label = item.label.trim().toLowerCase();
    if (seen.has(label)) {
      // Two steps with the same name produce two photos nobody can tell apart
      // afterwards, which defeats the point of a named list.
      problems.push(`Two steps are both called "${item.label}".`);
    }
    seen.add(label);

    if (item.maxPhotos < item.minPhotos) {
      problems.push(`"${item.label}" asks for at least ${item.minPhotos} photos but allows at most ${item.maxPhotos}.`);
    }
    if (isPhotoCapture(item.capture)) {
      if (item.required && item.minPhotos < 1) {
        problems.push(`"${item.label}" is required but asks for no photos.`);
      }
    } else if (item.minPhotos > 0) {
      // A text step that demands photos is a step whose kind and configuration
      // disagree; the capture UI would show a camera the answer never uses.
      problems.push(`"${item.label}" does not collect photos, so it cannot require any.`);
    }
  }
  return problems;
}

/* ── a run, as the device submits it ──────────────────────────────────── */

/**
 * Ids are supplied BY THE DEVICE and are not optional.
 *
 * This is what lets a capture start with no signal — see the note on
 * ChecklistRun.id in prisma/checklists.prisma. It also makes the sync
 * idempotent: the same payload applied twice upserts to the same rows instead of
 * creating a second run, which matters because the retry path is the normal path
 * on a bad connection.
 *
 * Length-capped and pattern-free on purpose: the server never interpolates these
 * into anything but a parameterised query and a blob path prefix it builds
 * itself, so the useful constraint is "short and present", not a UUID shape the
 * client could satisfy while still colliding.
 */
const CLIENT_ID = z.string().trim().min(8).max(64);

export const ENTRY_INPUT = z.object({
  id: CLIENT_ID,
  /**
   * The only template fact a device may name. The server resolves every frozen
   * label/capture/required/photo-limit value from the authoritative revision.
   */
  itemId: z.string().min(1).max(40),
  status: z.enum(ENTRY_STATUSES).default("pending"),
  note: z.string().trim().max(CHECKLIST_LIMITS.noteLength).optional(),
  value: z.string().trim().max(CHECKLIST_LIMITS.valueLength).optional(),
  skipReason: z.string().trim().max(CHECKLIST_LIMITS.skipReasonLength).optional(),
  recordedAt: z.coerce.date().optional(),
});
export type ChecklistEntryInput = z.infer<typeof ENTRY_INPUT>;

export const RUN_INPUT = z.object({
  id: CLIENT_ID,
  templateId: z.string().min(1).max(40),
  /** The exact immutable revision the device rendered. */
  templateVersion: z.number().int().min(1),
  hostType: z.enum(HOST_IDS),
  hostId: z.string().min(1).max(40),
  startedAt: z.coerce.date(),
  entries: z.array(ENTRY_INPUT).max(CHECKLIST_LIMITS.itemsPerTemplate),
});
export type ChecklistRunInput = z.infer<typeof RUN_INPUT>;

/**
 * The immutable server-owned representation of one template revision.
 * Stored as JSON on ChecklistTemplateRevision and parsed again on every sync:
 * database JSON is durable input, not trusted TypeScript memory.
 */
export const REVISION_ITEM = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(CHECKLIST_LIMITS.labelLength),
  description: z.string().trim().max(CHECKLIST_LIMITS.descriptionLength).nullable(),
  capture: z.enum(CAPTURE_KINDS),
  required: z.boolean(),
  minPhotos: z.number().int().min(0).max(CHECKLIST_LIMITS.photosPerItem),
  maxPhotos: z.number().int().min(1).max(CHECKLIST_LIMITS.photosPerItem),
  visibility: z.unknown().nullable(),
  sortOrder: z.number().int().min(0).max(999),
});
export const REVISION_ITEMS = z.array(REVISION_ITEM).max(CHECKLIST_LIMITS.itemsPerTemplate);
export type ChecklistRevisionItem = z.infer<typeof REVISION_ITEM>;

/* ── completeness ─────────────────────────────────────────────────────── */

/**
 * What a step needs before the run may be called finished.
 *
 * Deliberately computed from the SNAPSHOTS on the entry rather than from the
 * template's current items. A run answers the list as it stood when it started;
 * re-reading today's template would let an edit made this morning retroactively
 * make last week's completed handover incomplete.
 */
export type EntryState = {
  id: string;
  labelSnapshot: string;
  captureSnapshot: string;
  requiredSnapshot: boolean;
  minPhotosSnapshot: number;
  status: EntryStatus;
  note?: string | null;
  value?: string | null;
  skipReason?: string | null;
  photoCount: number;
};

export type Outstanding = { id: string; label: string; reason: string };

/**
 * Everything still standing between this run and "done".
 *
 * A list rather than a boolean, because the capture screen has to say WHICH step
 * is unfinished — "the run is incomplete" with no pointer is the kind of message
 * that makes somebody tap through all twelve again looking for the gap.
 */
export function outstanding(entries: readonly EntryState[]): Outstanding[] {
  const out: Outstanding[] = [];
  for (const entry of entries) {
    // An optional step needs nothing, whatever state it is in.
    if (!entry.requiredSnapshot) continue;

    if (entry.status === "skipped" || entry.status === "na") {
      // Skipping a REQUIRED step is allowed — the charger genuinely may not be
      // in the box — but it has to be accounted for.
      const reason = (entry.skipReason ?? "").trim();
      if (reason.length < MIN_SKIP_REASON) {
        out.push({ id: entry.id, label: entry.labelSnapshot, reason: "needs a reason for skipping" });
      }
      continue;
    }

    if (entry.status === "pending") {
      out.push({ id: entry.id, label: entry.labelSnapshot, reason: "not done yet" });
      continue;
    }

    // status === "done"
    if (isPhotoCapture(entry.captureSnapshot)) {
      if (entry.photoCount < entry.minPhotosSnapshot) {
        const need = entry.minPhotosSnapshot - entry.photoCount;
        out.push({
          id: entry.id,
          label: entry.labelSnapshot,
          reason: `needs ${need} more photo${need === 1 ? "" : "s"}`,
        });
      }
      if (entry.captureSnapshot === "photo_note" && !(entry.note ?? "").trim()) {
        out.push({ id: entry.id, label: entry.labelSnapshot, reason: "needs a note" });
      }
      continue;
    }

    // A non-photo step marked done must actually carry its answer. `boolean`
    // is exempt: "false" is a real answer and an unticked box is indistinguishable
    // from an empty one, which is why the status carries the meaning there.
    if (entry.captureSnapshot !== "boolean" && !(entry.value ?? "").trim()) {
      out.push({ id: entry.id, label: entry.labelSnapshot, reason: "needs an answer" });
    }
  }
  return out;
}

export function isComplete(entries: readonly EntryState[]): boolean {
  return outstanding(entries).length === 0;
}
