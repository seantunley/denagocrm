"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { requireUser } from "@/lib/auth";
import { logError } from "@/lib/errorLog";
import { MAX_PHOTO_BYTES } from "@/lib/photoBudget";
import { assertOwnedBlob, deleteFile } from "@/lib/storage";
import { requireChecklistHostAccess } from "@/lib/checklists/hostRecords";
import { visibleChecklistItems } from "@/lib/checklists/visibility";
import { hostHref } from "@/lib/checklists/hosts";
import { entryMaxPhotos, entryState } from "@/lib/checklists/store";
import { REVISION_ITEMS, RUN_INPUT, outstanding, type Outstanding } from "@/lib/checklists/types";

/**
 * Capturing a guided checklist. Configuration is
 * src/app/actions/checklistTemplates.ts; the read path is lib/checklists/store.ts.
 *
 * ── WHAT THESE ARE DEFENDING AGAINST ────────────────────────────────────────
 *
 * Everything here arrives from a phone that may have been out of signal for an
 * hour, holding ids it minted itself. That is the design (see the note on
 * `ChecklistRun.id` in prisma/checklists.prisma) and it is also the threat model:
 * a server action is a POST endpoint, so "the app sent it" is not a fact the
 * server has. Four rules follow, and every function below observes all four.
 *
 *   THE WORKSPACE IS RESOLVED HERE, from the session, by `actingTenantId()`. No
 *   function in this file takes a `tenantId`, and none reads one from a payload.
 *
 *   THE HOST IS AUTHORISED BEFORE ANYTHING IS WRITTEN, through
 *   `requireChecklistHostAccess` — the only door (see lib/checklists/hostRecords.ts).
 *   A checklist must never become a way to attach evidence to a record you could
 *   not otherwise touch.
 *
 *   A CLIENT ID IS NEVER ADOPTED. Upserting on an id the client chose is,
 *   unguarded, a way to reach into a row somebody else owns and rewrite it. Every
 *   upsert below is preceded by a check on who currently holds that id, and a
 *   collision is refused rather than absorbed.
 *
 *   A COMPLETED RUN IS A RECORD. Once `completedAt` is set nothing may change it:
 *   not a late sync from a phone that was in a tunnel, not a photo, not a
 *   deletion. That is what makes it quotable afterwards.
 */

/** Photos the device has already pushed to blob storage and now wants recorded. */
export type StagedChecklistPhoto = {
  /**
   * Minted on the device, for the same reason the run is: a retry after a crash
   * has to re-send the same photo rather than a second copy of it.
   */
  id: string;
  /** The blob URL the direct upload returned. Verified below; never trusted. */
  url: string;
  /** When the CAMERA fired, which on a bad signal is not when the upload landed. */
  capturedAt: string;
};

const STAGED_PHOTO = z.object({
  id: z.string().trim().min(8).max(64),
  url: z.string().trim().min(1).max(2000),
  capturedAt: z.coerce.date(),
});

/** A rejected payload, said in a way the capture screen can show. */
function describeIssue(error: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> }): string {
  const issue = error.issues[0];
  const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
  return `That checklist could not be read${where}: ${issue?.message ?? "unrecognised"}`;
}

/** The first few unfinished steps, as a sentence. */
function describeOutstanding(missing: Outstanding[]): string {
  const shown = missing.slice(0, 3).map((item) => `${item.label} — ${item.reason}`);
  const rest = missing.length - shown.length;
  return `${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`;
}

/* ── sync ─────────────────────────────────────────────────────────────── */

/**
 * Push a run and its answers up from the device.
 *
 * IDEMPOTENT BY CONSTRUCTION. The run and every entry are upserted on the ids the
 * device minted, so the same payload applied twice converges on the same rows
 * instead of producing a second handover. That matters because on a bad
 * connection the retry IS the normal path — a response lost on the way back looks
 * exactly like a request that never arrived, and the device has no way to tell
 * them apart.
 *
 * THE DEVICE MUST SUBMIT THE WHOLE APPLICABLE ITEM SET. Answers are small and
 * stored together; accepting a partial set would let a modified client omit the
 * required steps that define completion. Sync only upserts those authoritative
 * entries and never deletes evidence; photo removal remains an explicit action.
 *
 * AN INACTIVE TEMPLATE IS STILL SYNCABLE, deliberately. Somebody may have started
 * a handover an hour before an administrator deactivated the list, and refusing
 * the sync would strand their photographs on a phone. Deactivating stops a list
 * being OFFERED (`templatesForHost`); it does not abandon work already in hand.
 */
export async function syncChecklistRun(payload: unknown): Promise<ActionResult> {
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "checklist-run-sync",
    context: "run=unparsed",
  };
  return asActionResult(async () => {
    /*
     * A SESSION BEFORE ANY STATE IS READ.
     *
     * Not redundant with the host check below, which cannot run until the record
     * has been fetched to find out which host it belongs to. Without this, the
     * specific refusals underneath ("that step is no longer available") answer an
     * unauthenticated caller, turning the action into an existence oracle for
     * client-minted ids. The host gate still decides access; this decides who may
     * be told anything at all.
     */
    await requireUser();
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;

    const parsed = RUN_INPUT.safeParse(payload);
    if (!parsed.success) refuse(describeIssue(parsed.error));
    const run = parsed.data;
    failureLog.context = `run=${run.id} host=${run.hostType}`;

    // THE DOOR. Before any read of the run and before any write at all: this
    // proves the caller holds the permission the host demands and that the record
    // exists in THIS workspace. `hostId` came off a phone; nothing else checks it.
    const { host } = await requireChecklistHostAccess(run.hostType, run.hostId, tenantId);

    const template = await basePrisma.checklistTemplate.findFirst({
      where: { id: run.templateId, tenantId },
      select: {
        id: true,
        host: true,
        name: true,
        items: { select: { id: true } },
        revisions: {
          where: { version: run.templateVersion },
          take: 1,
          select: { version: true, items: true },
        },
      },
    });
    if (!template) refuse("That checklist is no longer available in this workspace.");
    // A run must not answer a list built for a different situation. Without this,
    // a workshop check-in list could be filled in against a delivery — the steps
    // would be nonsense on the printed note, and every completeness rule would be
    // measuring the wrong thing.
    if (template.host !== run.hostType) {
      refuse(`“${template.name}” is not a checklist for this kind of record.`);
    }
    const revision = template.revisions[0];
    if (!revision) refuse("That checklist revision is no longer available. Refresh the record and start again.");
    const parsedRevision = REVISION_ITEMS.safeParse(revision.items);
    if (!parsedRevision.success) refuse("That checklist revision is damaged and cannot be used.");
    const applicable = await visibleChecklistItems(
      parsedRevision.data,
      run.hostType,
      run.hostId,
      tenantId,
      run.startedAt,
    );

    /*
     * WHO CURRENTLY HOLDS THIS ID.
     *
     * Looked up WITHOUT the workspace predicate on purpose. Scoped to our own
     * rows, an id already taken by another workspace would read as "no such run",
     * the upsert would try to create it, and the caller would get a primary-key
     * violation reported as an internal failure — with the row still belonging to
     * somebody else. Asking globally lets this refuse in a sentence, and it
     * reveals nothing: the answer is the same "already in use" whether the holder
     * is in this workspace or not, and the ids are 64-character values the device
     * generates.
     */
    const existing = await basePrisma.checklistRun.findUnique({
      where: { id: run.id },
      select: {
        id: true,
        tenantId: true,
        templateId: true,
        templateVersion: true,
        hostType: true,
        hostId: true,
        completedAt: true,
      },
    });
    if (existing && existing.tenantId !== tenantId) {
      refuse("That checklist id is already in use. Start the checklist again to get a new one.");
    }
    if (existing?.completedAt) {
      // A completed handover is a RECORD. A sync arriving afterwards — a phone
      // coming out of a tunnel with an older copy — must not rewrite what the
      // customer signed for, and must be told so rather than silently ignored.
      refuse(
        "That checklist was already completed and can no longer be changed. Start a new one if something else needs recording.",
      );
    }
    if (
      existing &&
      (existing.hostType !== run.hostType ||
        existing.hostId !== run.hostId ||
        existing.templateId !== run.templateId)
    ) {
      // Re-pointing an existing run at a different record or a different list
      // would move every photograph already attached to it. The host gate above
      // authorised the NEW target; it says nothing about the old one.
      refuse("That checklist belongs to a different record. Start a new one for this record.");
    }
    if (existing && existing.templateVersion !== run.templateVersion) {
      refuse("That saved checklist belongs to a different template revision. Refresh the record and carry on there.");
    }

    const entryIds = run.entries.map((entry) => entry.id);
    if (new Set(entryIds).size !== entryIds.length) {
      refuse("Two steps in that checklist share an id.");
    }
    const submittedItems = run.entries.map((entry) => entry.itemId);
    if (new Set(submittedItems).size !== submittedItems.length) {
      refuse("That checklist submitted the same configured step more than once.");
    }
    const applicableIds = new Set(applicable.map((item) => item.id));
    if (
      submittedItems.length !== applicableIds.size ||
      submittedItems.some((itemId) => !applicableIds.has(itemId))
    ) {
      refuse("The steps on this device do not match the authoritative checklist revision. Refresh and start again.");
    }
    /*
     * Same question, for the entries: is any of these ids already held by another
     * run, or another workspace? Upserting one would RE-PARENT it — dragging the
     * photographs attached to it into this run, which is a way to move evidence
     * between records without ever touching the record it came from.
     */
    const foreign =
      entryIds.length > 0
        ? await basePrisma.checklistEntry.findMany({
            where: { id: { in: entryIds }, NOT: { runId: run.id, tenantId } },
            select: { id: true },
          })
        : [];
    if (foreign.length > 0) {
      refuse("One of those steps is already recorded against another checklist.");
    }

    const liveItems = new Set(template.items.map((item) => item.id));
    const authoritative = new Map(applicable.map((item) => [item.id, item]));
    const user = await requireUser();

    await basePrisma.$transaction(async (tx) => {
      await tx.checklistRun.upsert({
        where: { id: run.id },
        create: {
          id: run.id,
          tenantId,
          templateId: template.id,
          // STAMPED ONCE, AT CREATE. A run answers the revision of the list that
          // was in force when it started; re-reading today's version on every
          // sync would let an edit made this morning claim authorship of what was
          // recorded last week.
          templateVersion: revision.version,
          hostType: run.hostType,
          hostId: run.hostId,
          startedAt: run.startedAt,
          startedById: user.id,
        },
        // Deliberately empty. Everything on the run itself — when it started, who
        // started it, which revision it answers — is settled at create, and a
        // later sync is only ever bringing ANSWERS. A payload cannot rewrite the
        // header of a run it did not begin.
        update: {},
      });

      // The row lock is the finality boundary. Completion and every evidence
      // mutation take the same lock, so none can pass a stale completedAt read.
      const [locked] = await tx.$queryRaw<Array<{ completedAt: Date | null }>>`
        SELECT "completedAt" FROM "ChecklistRun"
        WHERE "id" = ${run.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!locked || locked.completedAt) {
        refuse("That checklist was already completed and can no longer be changed.");
      }

      const storedEntries = await tx.checklistEntry.findMany({
        where: { tenantId, runId: run.id },
        select: { id: true, itemIdSnapshot: true },
      });
      const storedByItem = new Map(storedEntries.map((entry) => [entry.itemIdSnapshot, entry.id]));

      for (const entry of run.entries) {
        const item = authoritative.get(entry.itemId)!;
        const storedId = storedByItem.get(item.id);
        if (storedId && storedId !== entry.id) {
          refuse("That checklist step is already saved under a different device id.");
        }
        const answers = {
          status: entry.status,
          note: entry.note ?? null,
          value: entry.value ?? null,
          skipReason: entry.skipReason ?? null,
          recordedAt: entry.recordedAt ?? null,
        };
        await tx.checklistEntry.upsert({
          where: { id: entry.id },
          create: {
            id: entry.id,
            tenantId,
            runId: run.id,
            itemId: liveItems.has(item.id) ? item.id : null,
            itemIdSnapshot: item.id,
            labelSnapshot: item.label,
            descriptionSnapshot: item.description,
            captureSnapshot: item.capture,
            requiredSnapshot: item.required,
            minPhotosSnapshot: item.minPhotos,
            maxPhotosSnapshot: item.maxPhotos,
            sortOrder: item.sortOrder,
            ...answers,
          },
          update: answers,
        });
      }
    });

    revalidatePath(hostHref(host, run.hostId));
    return { success: existing ? "Checklist saved" : "Checklist started" };
  }, failureLog);
}

/* ── complete ─────────────────────────────────────────────────────────── */

/**
 * Close a run, if it is genuinely finished.
 *
 * COMPLETENESS IS RECOMPUTED FROM THE DATABASE, never taken from the caller. The
 * capture screen computes the same thing to draw its badge, and that is the point
 * of `outstanding()` being pure and shared — but the screen's answer is a claim
 * made by the device, and the device is where somebody who wants a handover
 * signed off without the serial-number photo would make it. The entries and the
 * photo COUNTS are read here, on the way in, and judged by the same function.
 *
 * The counts are real rows. A ChecklistPhoto exists only once the finalizer has
 * verified the blob (see the model comment), so "three photos" is a fact about
 * storage rather than a promise about a queue on a phone.
 */
export async function completeChecklistRun(runId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    /*
     * A SESSION BEFORE ANY STATE IS READ.
     *
     * Not redundant with the host check below, which cannot run until the record
     * has been fetched to find out which host it belongs to. Without this, the
     * specific refusals underneath ("that step is no longer available") answer an
     * unauthenticated caller, turning the action into an existence oracle for
     * client-minted ids. The host gate still decides access; this decides who may
     * be told anything at all.
     */
    await requireUser();
    const tenantId = await actingTenantId();
    const run = await basePrisma.checklistRun.findFirst({
      where: { id: runId, tenantId },
      select: {
        id: true,
        hostType: true,
        hostId: true,
      },
    });
    if (!run) refuse("That checklist is no longer available in this workspace.");
    const { host } = await requireChecklistHostAccess(run.hostType, run.hostId, tenantId);
    const user = await requireUser();
    await basePrisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ completedAt: Date | null }>>`
        SELECT "completedAt" FROM "ChecklistRun"
        WHERE "id" = ${run.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!locked) refuse("That checklist is no longer available in this workspace.");
      if (locked.completedAt) refuse("That checklist has already been completed.");

      const entries = await tx.checklistEntry.findMany({
        where: { tenantId, runId: run.id },
        select: {
          id: true,
          labelSnapshot: true,
          captureSnapshot: true,
          requiredSnapshot: true,
          minPhotosSnapshot: true,
          status: true,
          note: true,
          value: true,
          skipReason: true,
          _count: { select: { photos: true } },
        },
      });
      if (entries.length === 0) refuse("That checklist has no steps recorded yet.");
      const missing = outstanding(entries.map((entry) => entryState(entry, entry._count.photos)));
      if (missing.length > 0) refuse(`Not finished yet — ${describeOutstanding(missing)}.`);

      const completed = await tx.checklistRun.updateMany({
        where: { id: run.id, tenantId, completedAt: null },
        data: { completedAt: new Date(), completedById: user.id },
      });
      if (completed.count !== 1) refuse("That checklist has already been completed.");
    });

    revalidatePath(hostHref(host, run.hostId));
    return { success: "Checklist completed" };
  }, { scope: "checklist-run-complete", context: `run=${runId}` });
}

/* ── photos ───────────────────────────────────────────────────────────── */

/**
 * Record a photo the device has already uploaded.
 *
 * The finalizer half of the direct-to-blob upload, and the same shape as
 * `registerInspectionPhoto`: the upload route decides who may be ISSUED a token,
 * this decides what may be RECORDED, and both are needed because a token and a
 * URL are two different things to hold. Every check below is on a fact the STORE
 * reports rather than on anything the caller said about the file:
 *
 *   `assertOwnedBlob` proves the object is in our store and under this
 *   workspace's prefix — a hostname match proves only the vendor, and that store
 *   is shared by every Vercel customer.
 *   The content type and the size come back from the store, not from the client.
 *   The pathname must sit under `uploads/<tenant>/checklist/<entryId>/`, which is
 *   what stops a photo captured for one step being filed against another by a
 *   caller writing its own upload path.
 *
 * PHOTOS ARE APPENDED, NOT REPLACED, which is the one place this deliberately
 * differs from the inspection finalizer. A step can legitimately want three
 * angles of the same panel, so there is no previous blob to clean up here;
 * `deleteChecklistPhoto` is the explicit way to remove one and that is where the
 * blob is deleted.
 */
export async function registerChecklistPhoto(
  entryId: string,
  staged: StagedChecklistPhoto[],
): Promise<ActionResult> {
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "checklist-photo-finalize",
    context: `entry=${entryId}`,
  };
  return asActionResult(async () => {
    /*
     * A SESSION BEFORE ANY STATE IS READ.
     *
     * Not redundant with the host check below, which cannot run until the record
     * has been fetched to find out which host it belongs to. Without this, the
     * specific refusals underneath ("that step is no longer available") answer an
     * unauthenticated caller, turning the action into an existence oracle for
     * client-minted ids. The host gate still decides access; this decides who may
     * be told anything at all.
     */
    await requireUser();
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;

    const entry = await basePrisma.checklistEntry.findFirst({
      where: { id: entryId, tenantId },
      select: {
        id: true,
        tenantId: true,
        minPhotosSnapshot: true,
        maxPhotosSnapshot: true,
        run: { select: { id: true, hostType: true, hostId: true, completedAt: true } },
      },
    });
    if (!entry?.run) refuse("That checklist step is no longer available in this workspace.");
    const { host } = await requireChecklistHostAccess(entry.run.hostType, entry.run.hostId, tenantId);

    const photo = STAGED_PHOTO.safeParse(staged[0]);
    if (staged.length !== 1 || !photo.success) refuse("Register one checklist photo at a time.");
    const url = photo.data.url;

    const blob = await assertOwnedBlob(url, entry.tenantId);
    if (!blob.contentType.startsWith("image/")) refuse("That file is not an image.");
    if (blob.size <= 0 || blob.size > MAX_PHOTO_BYTES) refuse("That photo is outside the 4 MB limit.");
    if (!blob.pathname.startsWith(`uploads/${entry.tenantId}/checklist/${entry.id}/`)) {
      refuse("That photo does not belong to this checklist step.");
    }

    /*
     * A RETRY IS NOT A SECOND PHOTO.
     *
     * The id is the device's, so a response lost on the way back brings the same
     * one round again. Looked up globally for the same reason the run is: an id
     * held elsewhere must be refused in a sentence rather than surface as a
     * primary-key violation — and re-pointing it at this entry would move
     * somebody else's photograph onto this record.
     */
    let alreadyRecorded = false;
    await basePrisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ completedAt: Date | null }>>`
        SELECT "completedAt" FROM "ChecklistRun"
        WHERE "id" = ${entry.run.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!locked || locked.completedAt) {
        refuse("That checklist has been completed, so no more photos can be added to it.");
      }

      const held = await tx.checklistPhoto.findUnique({
        where: { id: photo.data.id },
        select: { tenantId: true, entryId: true, url: true },
      });
      if (held) {
        if (held.tenantId !== tenantId || held.entryId !== entry.id) refuse("That photo id is already in use.");
        if (held.url !== url) refuse("That photo id has already been used for a different image.");
        alreadyRecorded = true;
      } else {
        const cap = entryMaxPhotos(entry.maxPhotosSnapshot, entry.minPhotosSnapshot);
        const count = await tx.checklistPhoto.count({ where: { tenantId, entryId: entry.id } });
        if (count >= cap) {
          refuse(`That step already holds ${cap} photo${cap === 1 ? "" : "s"}. Remove one before adding another.`);
        }
        await tx.checklistPhoto.create({
          data: { id: photo.data.id, tenantId, entryId: entry.id, url, capturedAt: photo.data.capturedAt },
        });
      }
    });

    revalidatePath(hostHref(host, entry.run.hostId));
    return { success: alreadyRecorded ? "Photo already recorded" : "Photo saved" };
  }, failureLog);
}

/**
 * Remove one photo, and the object behind it.
 *
 * THE ROW GOES FIRST. If the blob delete fails afterwards the person has still
 * had what they asked for — the photograph no longer appears on the record — and
 * what is left is an unreferenced object, which is logged and costs storage.
 * Deleting the blob first and then failing to remove the row would leave a
 * checklist pointing at an image that no longer loads, which reads to everybody
 * afterwards as lost evidence.
 */
export async function deleteChecklistPhoto(photoId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    /*
     * A SESSION BEFORE ANY STATE IS READ.
     *
     * Not redundant with the host check below, which cannot run until the record
     * has been fetched to find out which host it belongs to. Without this, the
     * specific refusals underneath ("that step is no longer available") answer an
     * unauthenticated caller, turning the action into an existence oracle for
     * client-minted ids. The host gate still decides access; this decides who may
     * be told anything at all.
     */
    await requireUser();
    const tenantId = await actingTenantId();
    const photo = await basePrisma.checklistPhoto.findFirst({
      where: { id: photoId, tenantId },
      select: {
        id: true,
        url: true,
        entry: {
          select: {
            id: true,
            run: { select: { id: true, hostType: true, hostId: true, completedAt: true } },
          },
        },
      },
    });
    if (!photo?.entry?.run) refuse("That photo is no longer available in this workspace.");
    const { host } = await requireChecklistHostAccess(
      photo.entry.run.hostType,
      photo.entry.run.hostId,
      tenantId,
    );
    const removed = await basePrisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ completedAt: Date | null }>>`
        SELECT "completedAt" FROM "ChecklistRun"
        WHERE "id" = ${photo.entry.run.id} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!locked || locked.completedAt) {
        refuse("That checklist has been completed, so its photos can no longer be removed.");
      }
      return tx.checklistPhoto.deleteMany({ where: { id: photo.id, tenantId, entryId: photo.entry.id } });
    });
    if (removed.count > 0) {
      await deleteFile(photo.url).catch(async (error) => {
        await logError("checklist-photo-cleanup", error, `entry=${photo.entry?.id} photo=${photo.id}`, {
          tenantId,
          alert: false,
        });
      });
    }

    revalidatePath(hostHref(host, photo.entry.run.hostId));
    return { success: "Photo removed" };
  }, { scope: "checklist-photo-delete", context: `photo=${photoId}` });
}
