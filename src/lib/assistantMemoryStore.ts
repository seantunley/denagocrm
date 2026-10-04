import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import {
  MEMORY_CHAR_LIMIT,
  PLAYBOOK_LIMIT,
  PROFILE_CHAR_LIMIT,
  planNoteChanges,
  scanEntry,
  type Entry,
  type LearnBlock,
  type NoteOp,
} from "./assistantMemory";

/**
 * What the assistant has learned, in the database (AssistantNote, RLS-forced).
 * Reads go through the tenant-scoped client, so a workspace only ever sees its
 * own; a profile is read only for the person it describes.
 */

export async function loadLearned(userId: string) {
  const [memory, profile, playbooks] = await Promise.all([
    prisma.assistantNote.findMany({ where: { kind: "memory" }, orderBy: { createdAt: "asc" }, select: { id: true, content: true, status: true } }),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId }, orderBy: { createdAt: "asc" }, select: { id: true, content: true, status: true } }),
    prisma.assistantNote.findMany({ where: { kind: "playbook" }, orderBy: { name: "asc" }, select: { name: true, description: true, status: true } }),
  ]);
  return {
    memory,
    profile,
    playbooks: playbooks.map((p) => ({ name: p.name ?? "", description: p.description ?? "", status: p.status })),
  };
}

export async function loadPlaybook(name: string) {
  return prisma.assistantNote.findFirst({
    where: { kind: "playbook", name: name.trim().toLowerCase() },
    select: { name: true, description: true, content: true, status: true },
  });
}

/**
 * Apply what the model decided to learn. One transaction under a per-workspace
 * advisory lock, so two questions finishing together can't both pass the size
 * check and overflow the cap, or create the same playbook twice. Returns how
 * many entries changed — never throws into the answer path.
 */
export async function applyLearn(userId: string, learn: LearnBlock): Promise<number> {
  const tenantId = ownedWriteTenantId();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
    let changed = 0;

    const notes = async (kind: "memory" | "profile", ops: NoteOp[] | undefined, limit: number) => {
      if (!ops?.length) return;
      const where = kind === "profile" ? { tenantId, kind, userId } : { tenantId, kind };
      const entries: Entry[] = await tx.assistantNote.findMany({ where, select: { id: true, content: true, status: true } });
      for (const change of planNoteChanges(entries, ops, limit)) {
        if (change.kind === "create") {
          await tx.assistantNote.create({
            data: { tenantId, kind, userId: kind === "profile" ? userId : null, content: change.content, createdById: userId },
          });
        } else if (change.kind === "update") {
          // A rewrite is new learning: back to unreviewed.
          await tx.assistantNote.updateMany({ where: { id: change.id, ...where, status: { not: "approved" } }, data: { content: change.content, status: "unreviewed" } });
        } else {
          await tx.assistantNote.deleteMany({ where: { id: change.id, ...where, status: { not: "approved" } } });
        }
        changed++;
      }
    };
    await notes("memory", learn.memory, MEMORY_CHAR_LIMIT);
    await notes("profile", learn.profile, PROFILE_CHAR_LIMIT);

    for (const book of learn.playbook ?? []) {
      const description = scanEntry(book.description);
      const content = scanEntry(book.content);
      if (!description.ok || !content.ok) continue;
      const existing = await tx.assistantNote.findFirst({ where: { tenantId, kind: "playbook", name: book.name }, select: { id: true, status: true } });
      if (existing) {
        // An approved playbook is the owner's; the assistant can't rewrite it.
        if (existing.status === "approved") continue;
        await tx.assistantNote.update({ where: { id: existing.id }, data: { description: description.text, content: content.text, status: "unreviewed" } });
      } else {
        if ((await tx.assistantNote.count({ where: { tenantId, kind: "playbook" } })) >= PLAYBOOK_LIMIT) continue;
        await tx.assistantNote.create({
          data: { tenantId, kind: "playbook", name: book.name, description: description.text, content: content.text, createdById: userId },
        });
      }
      changed++;
    }
    return changed;
  });
}
