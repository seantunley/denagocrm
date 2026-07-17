import "server-only";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { standardQuoteTemplate } from "@/lib/doceditor/factory";

/**
 * Ensure the standard builder template exists AND is stored in the current
 * doceditor DocumentModel format. The old seed wrote the Puck-era `starterTemplate`
 * shape, which the current editor's parseDocument() can't read — so it fell back
 * to a blank document (the "blank quote" symptom).
 *
 * NON-DESTRUCTIVE — we never overwrite an existing row's data. A row with a null
 * createdById is a system row, but an author-less row may be an UNTOUCHED seed OR a
 * dealer who edited the default in the old builder (saveBuilderData doesn't stamp an
 * author), whose legacy Puck JSON also fails parseDocument. We can't tell those
 * apart, so instead of repairing in place we CLONE: if no *valid* system template
 * exists we add a fresh standard one (and demote any stale/unparseable system rows so
 * a broken layout isn't left as the default) while preserving the old row's data for
 * recovery. We also never override a user's explicitly chosen default.
 */
export async function ensureBuilderSeeded(): Promise<void> {
  try {
    const rows = await prisma.docBuilderTemplate.findMany({
      where: { key: "quote", deletedAt: null },
      select: { id: true, data: true, createdById: true, isDefault: true },
    });
    const parsed = rows.map((r) => ({ ...r, ok: parseDocument(r.data) !== null }));
    const validSystem = parsed.filter((r) => r.createdById === null && r.ok);

    if (validSystem.length > 0) {
      // A valid system template already exists — but the default must still be a
      // RENDERABLE row. A broken/unparseable system row could have been re-made default
      // (e.g. via setDefaultBuilderTemplate) after a prior repair, so on the idempotent
      // path we still demote a bad default and promote a valid one.
      const currentDefault = parsed.find((r) => r.isDefault);
      const badDefault = !currentDefault || (currentDefault.createdById === null && !currentDefault.ok);
      if (badDefault) {
        await prisma.docBuilderTemplate.updateMany({
          where: { key: "quote", createdById: null, deletedAt: null },
          data: { isDefault: false },
        });
        await prisma.docBuilderTemplate.update({
          where: { id: validSystem[0].id },
          data: { isDefault: true },
        });
      }
      return;
    }

    // No valid system template. Preserve any unparseable system rows (could be a
    // dealer's edited legacy layout) and add a fresh standard one.
    const invalidSystem = parsed.filter((r) => r.createdById === null && !r.ok);
    if (invalidSystem.length > 0) {
      await prisma.docBuilderTemplate.updateMany({
        where: { key: "quote", createdById: null, deletedAt: null },
        data: { isDefault: false },
      });
    }
    // Take over the default only if a stale system row held it, or nothing else does.
    const becomeDefault = invalidSystem.some((r) => r.isDefault) || !parsed.some((r) => r.isDefault);
    await prisma.docBuilderTemplate.create({
      data: { name: "Quotation", key: "quote", isDefault: becomeDefault, data: standardQuoteTemplate() as object },
    });
  } catch {
    // table not migrated yet — ignore so the page still renders
  }
}

export async function listBuilderTemplates() {
  try {
    return await prisma.docBuilderTemplate.findMany({ orderBy: [{ key: "asc" }, { updatedAt: "desc" }] });
  } catch {
    return [];
  }
}

export async function getBuilderTemplate(id: string) {
  const r = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!r || r.deletedAt) return null;
  return r;
}

/** Version history for a template, newest first (metadata only — no data blob). */
export async function listBuilderVersions(templateId: string) {
  try {
    return await prisma.docBuilderVersion.findMany({
      where: { templateId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, label: true, publishedAt: true, publishedBy: true },
    });
  } catch {
    return [];
  }
}
