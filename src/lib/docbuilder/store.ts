import "server-only";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { standardQuoteTemplate } from "@/lib/doceditor/factory";

/**
 * Ensure the standard builder template exists AND is stored in the current
 * doceditor DocumentModel format. The old seed wrote the Puck-era `starterTemplate`
 * shape, which the current editor's parseDocument() can't read — so it fell back
 * to a blank document (the "blank quote" symptom). A legacy/unparseable seed is
 * repaired in place with the real branded layout; any template whose data already
 * parses as a valid DocumentModel (i.e. anything a user has edited) is left alone.
 */
export async function ensureBuilderSeeded(): Promise<void> {
  try {
    const existing = await prisma.docBuilderTemplate.findFirst({
      where: { key: "quote", deletedAt: null },
      orderBy: { updatedAt: "desc" },
    });
    if (!existing) {
      await prisma.docBuilderTemplate.create({
        data: { name: "Quotation", key: "quote", isDefault: true, data: standardQuoteTemplate() as object },
      });
    } else if (!parseDocument(existing.data)) {
      await prisma.docBuilderTemplate.update({
        where: { id: existing.id },
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
