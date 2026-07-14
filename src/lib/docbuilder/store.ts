import "server-only";
import { prisma } from "@/lib/db";
import { starterTemplate } from "./blocks";

export async function ensureBuilderSeeded(): Promise<void> {
  try {
    const n = await prisma.docBuilderTemplate.count();
    if (n > 0) return;
    await prisma.docBuilderTemplate.create({
      data: { name: "Quotation", key: "quote", isDefault: true, data: starterTemplate() as object },
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
