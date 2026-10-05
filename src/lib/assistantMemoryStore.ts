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
 *
 * UNREVIEWED LEARNING STAYS WITH THE PERSON IT CAME FROM. It was learned from
 * one person's conversation, which ran with THEIR visibility — a manager's
 * question about a deal a salesperson can't see may leave a note behind. Until
 * the owner approves it, an entry reaches only the prompt of the person whose
 * conversation produced it (createdById); approval is the owner's decision to
 * share it with everyone. The nightly tidy-up's own entries (createdById null)
 * reach nobody until approved.
 */
export const visibleTo = (userId: string) => ({ OR: [{ status: "approved" }, { createdById: userId }] });

/** What one person's conversations may add before the owner has reviewed it. */
export const UNREVIEWED_MEMORY_PER_PERSON = 600;
export const UNREVIEWED_PLAYBOOKS_PER_PERSON = 5;

export async function loadLearned(userId: string) {
  const [memory, profile, playbooks] = await Promise.all([
    prisma.assistantNote.findMany({ where: { kind: "memory", ...visibleTo(userId) }, orderBy: { createdAt: "asc" }, select: { id: true, content: true, status: true } }),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId }, orderBy: { createdAt: "asc" }, select: { id: true, content: true, status: true } }),
    prisma.assistantNote.findMany({ where: { kind: "playbook", ...visibleTo(userId) }, orderBy: { name: "asc" }, select: { name: true, description: true, content: true, status: true } }),
  ]);
  return {
    memory,
    profile,
    playbooks: playbooks.map((p) => ({ name: p.name ?? "", description: p.description ?? "", content: p.content, status: p.status })),
  };
}

export async function loadPlaybook(name: string, userId: string) {
  return prisma.assistantNote.findFirst({
    where: { kind: "playbook", name: name.trim().toLowerCase(), ...visibleTo(userId) },
    select: { name: true, description: true, content: true, status: true },
  });
}

/**
 * Apply what the model decided to learn. One transaction under a per-workspace
 * advisory lock, so two questions finishing together can't both pass the size
 * check and overflow the cap, or create the same playbook twice. Returns how
 * many entries changed — never throws into the answer path. `userId` is the
 * person it learned from; null for the nightly tidy-up, which has no person
 * and so never touches a profile.
 */
export async function applyLearn(userId: string | null, learn: LearnBlock): Promise<number> {
  const tenantId = ownedWriteTenantId();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
    let changed = 0;

    const notes = async (kind: "memory" | "profile", ops: NoteOp[] | undefined, limit: number) => {
      if (!ops?.length) return;
      const scope = kind === "profile" ? { tenantId, kind, userId } : { tenantId, kind };
      const all = await tx.assistantNote.findMany({ where: scope, select: { id: true, content: true, status: true, createdById: true } });
      // It may only see — and so only match, rewrite or remove — what this
      // person may see: approved entries and their own unreviewed ones. Someone
      // else's unreviewed entries still count against the size cap.
      const mine = (e: (typeof all)[number]) => e.status === "approved" || e.createdById === userId;
      const entries: Entry[] = all.filter(mine).map(({ id, content, status }) => ({ id, content, status }));
      const othersSize = all.filter((e) => !mine(e)).reduce((n, e) => n + e.content.length, 0);
      // One person can't fill the space everyone shares: their unreviewed
      // business memory is capped on its own, on top of the shared cap.
      const approvedSize = all.filter((e) => e.status === "approved").reduce((n, e) => n + e.content.length, 0);
      const cap = kind === "memory" ? Math.min(limit - othersSize, approvedSize + UNREVIEWED_MEMORY_PER_PERSON) : limit;
      // Writes re-assert ownership inside the lock, whatever the plan says.
      const where = { ...scope, createdById: userId };
      for (const change of planNoteChanges(entries, ops, Math.max(0, cap))) {
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
    if (userId) await notes("profile", learn.profile, PROFILE_CHAR_LIMIT);

    for (const book of learn.playbook ?? []) {
      const description = scanEntry(book.description);
      const content = scanEntry(book.content);
      if (!description.ok || !content.ok) continue;
      const existing = await tx.assistantNote.findFirst({ where: { tenantId, kind: "playbook", name: book.name }, select: { id: true, status: true, createdById: true } });
      if (existing) {
        // An approved playbook is the owner's; the assistant can't rewrite it.
        // Someone else's unreviewed one isn't this person's to see or change.
        if (existing.status === "approved" || existing.createdById !== userId) continue;
        await tx.assistantNote.update({ where: { id: existing.id }, data: { description: description.text, content: content.text, status: "unreviewed" } });
      } else {
        if ((await tx.assistantNote.count({ where: { tenantId, kind: "playbook" } })) >= PLAYBOOK_LIMIT) continue;
        const myUnreviewed = await tx.assistantNote.count({ where: { tenantId, kind: "playbook", createdById: userId, status: { not: "approved" } } });
        if (myUnreviewed >= UNREVIEWED_PLAYBOOKS_PER_PERSON) continue;
        await tx.assistantNote.create({
          data: { tenantId, kind: "playbook", name: book.name, description: description.text, content: content.text, createdById: userId },
        });
      }
      changed++;
    }
    return changed;
  });
}
