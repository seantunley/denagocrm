"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isTenantOwner, requireTenantOwner, requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { PLAYBOOK_CHARS, ENTRY_CHARS, scanEntry } from "@/lib/assistantMemory";

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
      await prisma.assistantNote.update({ where: { id }, data: { status: "approved", reviewedById: user.id, reviewedAt: new Date() } });
      await logAudit({ action: "assistant.note_approved", summary: `Approved what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`, user });
      revalidate();
      return { success: "Approved" };
    }),
  );
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
      await prisma.assistantNote.update({
        where: { id },
        data: { content: scanned.text, status: "approved", reviewedById: user.id, reviewedAt: new Date() },
      });
      await logAudit({ action: "assistant.note_edited", summary: `Edited what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`, user });
      revalidate();
      return { success: "Saved" };
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
