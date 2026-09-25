import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { embedStoredImage } from "./storedImage";
import { DOC_DEFS, defaultTemplate, mergeTemplate, type DocKey, type DocTemplate } from "./docTemplates";

/** First run per type: seed a "Standard" template (from legacy settings if any). */
export async function ensureSeeded(): Promise<void> {
  for (const key of Object.keys(DOC_DEFS) as DocKey[]) {
    const count = await prisma.docTemplateRecord.count({ where: { docType: key, deletedAt: null } });
    if (count > 0) continue;
    const legacy = await getSetting(`DOC_TEMPLATE_${key}`); // pre-v2 storage
    await prisma.docTemplateRecord.create({
      data: {
        docType: key,
        name: "Standard",
        isDefault: true,
        config: mergeTemplate(key, legacy) as object,
      },
    });
  }
}

export async function listTemplates(key: DocKey) {
  return prisma.docTemplateRecord.findMany({
    where: { docType: key, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

export async function getTemplateRecord(id: string) {
  return prisma.docTemplateRecord.findUnique({ where: { id } });
}

/**
 * The template a generated document should use: an explicit record (preview
 * via ?tpl=), else the type's default record, else built-in defaults.
 */
export async function getDocTemplate(key: DocKey, templateId?: string): Promise<DocTemplate> {
  if (templateId) {
    const rec = await prisma.docTemplateRecord.findUnique({ where: { id: templateId } });
    if (rec && rec.docType === key) return withPrintableLogo(mergeTemplate(key, rec.config), rec.tenantId);
  }
  const def = await prisma.docTemplateRecord.findFirst({
    where: { docType: key, isDefault: true, deletedAt: null },
  });
  if (def) return withPrintableLogo(mergeTemplate(key, def.config), def.tenantId);
  const legacy = await getSetting(`DOC_TEMPLATE_${key}`);
  return withPrintableLogo(legacy ? mergeTemplate(key, legacy) : defaultTemplate(key), null);
}

/**
 * Only print pages load templates (every caller is under app/(print)), and an
 * uploaded logo lives in file storage — private, so it has no link a page can
 * use. It is embedded for printing; the stored config keeps the ref.
 */
async function withPrintableLogo(tpl: DocTemplate, tenantId: string | null): Promise<DocTemplate> {
  if (!tpl.logoUrl) return tpl;
  // null falls back to the built-in logo, which is what an unreadable one should do.
  return { ...tpl, logoUrl: await embedStoredImage(tpl.logoUrl, tenantId) };
}
