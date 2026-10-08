"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isTenantOwner, requireTenantOwner, requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { ENTRY_CHARS, MEMORY_CHAR_LIMIT, PLAYBOOK_CHARS, PLAYBOOK_LIMIT, PROFILE_CHAR_LIMIT, parseUntil, scanEntry } from "@/lib/assistantMemory";
import { ownedWriteTenantId } from "@/lib/tenantWrite";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";

/*
 * Reviewing what the assistant learned. It learns on its own (Sean's choice);
 * these are the owner's controls: approve (it may no longer rewrite or remove
 * the entry), edit (counts as approved — the owner wrote it), delete. A person
 * may also delete what it remembers about THEM. Reads/writes are tenant-scoped,
 * so an id from another workspace is simply not found.
 */

const NOTE_GONE = "That entry is no longer there — refresh the page.";

function revalidate() {
  revalidatePath("/settings/assistant");
  revalidatePath("/assistant");
}

export async function approveAssistantNote(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const note = await prisma.assistantNote.findUnique({ where: { id }, select: { kind: true, name: true } });
      if (!note) refuse(NOTE_GONE);
      // Approving a flagged fact is the owner saying it's right: the flag goes.
      const now = new Date();
      await prisma.assistantNote.update({
        where: { id },
        data: {
          status: "approved", conflictsWithId: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now,
          ...(note.kind === "playbook" ? {} : { description: null }),
        },
      });
      await logAudit({ action: "assistant.note_approved", summary: `Approved what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`, user });
      revalidate();
      return { success: "Approved" };
    }),
  );
}

/** A playbook's name and description, as the owner typed them → checked values. */
async function playbookFields(formData: FormData, exceptId?: string) {
  const name = String(formData.get("name") ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 48) {
    refuse("Give the playbook a short name of letters, numbers and dashes — e.g. hot-lead.");
  }
  const description = scanEntry(String(formData.get("description") ?? "").slice(0, 60));
  if (!description.ok) refuse(`The description can't be saved: it ${description.reason}.`);
  const clash = await prisma.assistantNote.findFirst({
    where: { kind: "playbook", name, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) refuse(`There's already a playbook called “${name}”.`);
  return { name, description: description.text };
}

export async function updateAssistantNote(id: string, formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const note = await prisma.assistantNote.findUnique({ where: { id }, select: { kind: true, name: true } });
      if (!note) refuse(NOTE_GONE);
      const limit = note.kind === "playbook" ? PLAYBOOK_CHARS : ENTRY_CHARS;
      const scanned = scanEntry(String(formData.get("content") ?? "").slice(0, limit));
      // Even the owner's text is scanned: it goes into the assistant's prompt.
      if (!scanned.ok) refuse(`That can't be saved: it ${scanned.reason}.`);
      const book = note.kind === "playbook" ? await playbookFields(formData, id) : null;
      // Its last day: empty clears it (use it for good). A form without the
      // field leaves it as it is.
      let validUntil: Date | null | undefined;
      if (formData.has("validUntil")) {
        const day = String(formData.get("validUntil") ?? "").trim();
        validUntil = day ? parseUntil(day) : null;
        if (day && !validUntil) refuse("Pick a valid date, or leave it empty to keep using it.");
      }
      const now = new Date();
      await prisma.assistantNote.update({
        where: { id },
        // A fact's description only ever holds a tidy-up flag; the owner's edit
        // settles it — and a held conflict: the owner has written what's true.
        data: {
          content: scanned.text, ...(book ?? { description: null }), ...(validUntil === undefined ? {} : { validUntil }),
          status: "approved", conflictsWithId: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now,
        },
      });
      await logAudit({ action: "assistant.note_edited", summary: `Edited what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`, user });
      revalidate();
      return { success: "Saved" };
    }),
  );
}

/**
 * The owner teaches it directly: a business fact or a playbook, approved from
 * the start. Same caps as what it learns itself, held under the same
 * per-workspace lock, so the owner and the assistant can't overflow it between them.
 */
export async function createAssistantNote(formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const kind = String(formData.get("kind") ?? "");
      if (kind !== "memory" && kind !== "playbook") refuse("Choose a business fact or a playbook.");
      const limit = kind === "playbook" ? PLAYBOOK_CHARS : ENTRY_CHARS;
      const scanned = scanEntry(String(formData.get("content") ?? "").slice(0, limit));
      if (!scanned.ok) refuse(scanned.reason === "empty" ? "Write what it should know." : `That can't be saved: it ${scanned.reason}.`);
      const book = kind === "playbook" ? await playbookFields(formData) : null;
      const tenantId = ownedWriteTenantId();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
        // The owner's space is the SHARED one — what's approved. Colleagues'
        // unreviewed entries reach only their own conversations, so a few busy
        // colleagues can't fill it and lock the owner out of teaching.
        const shared = { tenantId, status: "approved" };
        if (kind === "memory") {
          const used = (await tx.assistantNote.findMany({ where: { ...shared, kind: "memory" }, select: { content: true } }))
            .reduce((n, e) => n + e.content.length, 0);
          if (used + scanned.text.length > MEMORY_CHAR_LIMIT) {
            refuse("Its business memory is full — remove or shorten something first (it's kept small because it's read with every question).");
          }
        } else if ((await tx.assistantNote.count({ where: { ...shared, kind: "playbook" } })) >= PLAYBOOK_LIMIT) {
          refuse(`It already has ${PLAYBOOK_LIMIT} playbooks — remove one first.`);
        }
        await tx.assistantNote.create({
          data: {
            tenantId, kind, content: scanned.text, ...(book ?? {}), source: "owner",
            status: "approved", createdById: user.id, reviewedById: user.id, reviewedAt: new Date(), lastConfirmedAt: new Date(),
          },
        });
      });
      await logAudit({ action: "assistant.note_taught", summary: `Taught the assistant a ${kind === "playbook" ? `playbook “${book!.name}”` : "business fact"}`, user });
      revalidate();
      return { success: "Saved — it will use this from now on" };
    }),
  );
}

export async function deleteAssistantNote(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireUser();
      const note = await prisma.assistantNote.findUnique({ where: { id }, select: { kind: true, name: true, userId: true } });
      if (!note) refuse(NOTE_GONE);
      const ownProfile = note.kind === "profile" && note.userId === user.id;
      if (!ownProfile && !(await isTenantOwner())) refuse("Only the workspace owner can remove what the assistant learned.");
      await prisma.assistantNote.delete({ where: { id } });
      await logAudit({ action: "assistant.note_deleted", summary: `Removed what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`, user });
      revalidate();
      return { success: "Removed" };
    }),
  );
}

/**
 * The owner settles learning that was held because it contradicts an approved
 * entry. "new": the new entry is approved and replaces the one it contradicts
 * (that one is removed). "existing": the new entry goes. Under the same lock as
 * learning, so a conversation finishing meanwhile plans against the result.
 */
export async function resolveAssistantConflict(id: string, keep: "new" | "existing") {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      if (keep !== "new" && keep !== "existing") refuse("Choose which one to keep.");
      const tenantId = ownedWriteTenantId();
      const note = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
        const held = await tx.assistantNote.findFirst({ where: { id, status: "conflict" }, select: { kind: true, userId: true, conflictsWithId: true } });
        if (!held) refuse(NOTE_GONE);
        if (keep === "existing") {
          await tx.assistantNote.delete({ where: { id } });
          return held;
        }
        const now = new Date();
        await tx.assistantNote.update({
          where: { id },
          data: { status: "approved", conflictsWithId: null, description: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now },
        });
        // Only ever the entry it was held against — same kind, about the same person.
        if (held.conflictsWithId) {
          await tx.assistantNote.deleteMany({ where: { id: held.conflictsWithId, kind: held.kind, userId: held.userId } });
        }
        return held;
      });
      // The kind only — what either entry says stays in Settings, not the trail.
      await logAudit({
        action: "assistant.conflict_resolved",
        summary: keep === "new"
          ? `Kept the assistant's newer ${note.kind} entry in place of the one it contradicted`
          : `Kept the existing ${note.kind} entry and dropped the assistant's contradicting one`,
        user,
      });
      revalidate();
      return { success: keep === "new" ? "Kept the new one" : "Kept the existing one" };
    }),
  );
}

/**
 * A person telling the assistant about THEMSELVES ("I run fleet deals in
 * Gauteng", "bullet points, please"), Hermes' USER.md in their own hands.
 * Their own words, used only in their own conversations, so no owner review:
 * saved as approved — the assistant can't rewrite it. Only ever the caller's
 * own profile: the row is created for, and updated where userId is, the
 * signed-in person; an id belonging to anyone else is simply not found.
 */
export async function saveMyAssistantNote(id: string | null, formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
      if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
      const scanned = scanEntry(String(formData.get("content") ?? "").slice(0, ENTRY_CHARS));
      if (!scanned.ok) refuse(scanned.reason === "empty" ? "Write something about yourself first." : `That can't be saved: it ${scanned.reason}.`);
      const tenantId = ownedWriteTenantId();
      const mine = { tenantId, kind: "profile", userId: user.id };
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
        const entries = await tx.assistantNote.findMany({ where: mine, select: { id: true, content: true } });
        const others = entries.filter((e) => e.id !== id).reduce((n, e) => n + e.content.length, 0);
        if (others + scanned.text.length > PROFILE_CHAR_LIMIT) refuse("That's all the room there is about you — shorten or remove something first.");
        const now = new Date();
        const reviewed = { status: "approved", conflictsWithId: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now };
        if (id) {
          const updated = await tx.assistantNote.updateMany({ where: { id, ...mine }, data: { content: scanned.text, ...reviewed } });
          if (!updated.count) refuse(NOTE_GONE);
        } else {
          await tx.assistantNote.create({ data: { ...mine, content: scanned.text, createdById: user.id, source: "person", ...reviewed } });
        }
      });
      await logAudit({ action: "assistant.profile_saved", summary: "Told the assistant about themselves", user });
      revalidate();
      return { success: "Saved — it will use this in your conversations" };
    }),
  );
}
