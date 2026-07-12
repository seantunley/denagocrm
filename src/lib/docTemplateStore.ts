import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
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
    if (rec && rec.docType === key) return mergeTemplate(key, rec.config);
  }
  const def = await prisma.docTemplateRecord.findFirst({
    where: { docType: key, isDefault: true, deletedAt: null },
  });
  if (def) return mergeTemplate(key, def.config);
  const legacy = await getSetting(`DOC_TEMPLATE_${key}`);
  return legacy ? mergeTemplate(key, legacy) : defaultTemplate(key);
}
