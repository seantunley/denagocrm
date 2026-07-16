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
 * NON-DESTRUCTIVE: we only ever repair OUR OWN system seed — the row this seeder
 * created, identified by a null createdById. Templates authored by a user through
 * createBuilderTemplate() always carry a createdById (and legacy Puck ones also
 * fail parseDocument), so they are NEVER overwritten here — repairing by "most
 * recently updated, unparseable" would silently clobber a user's customised
 * Puck-era layout. If there is no system seed we create one (default only when the
 * quote key is otherwise empty, so we never fight a user's chosen default).
 */
export async function ensureBuilderSeeded(): Promise<void> {
  try {
    const rows = await prisma.docBuilderTemplate.findMany({
      where: { key: "quote", deletedAt: null },
      select: { id: true, data: true, createdById: true },
    });
    // Our seed has no author; anything with a createdById is user-authored.
    const seed = rows.find((r) => r.createdById === null);
    if (!seed) {
      await prisma.docBuilderTemplate.create({
        data: { name: "Quotation", key: "quote", isDefault: rows.length === 0, data: standardQuoteTemplate() as object },
      });
    } else if (!parseDocument(seed.data)) {
      // Repair only the legacy/unparseable system seed — in place.
      await prisma.docBuilderTemplate.update({
        where: { id: seed.id },
        data: { data: standardQuoteTemplate() as object },
      });
    }
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
