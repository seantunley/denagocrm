import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { embedStoredImage } from "./storedImage";
import { isDocEditorLibraryItem } from "./studioClauses";
import { DOC_DEFS, defaultTemplate, mergeTemplate, withCompanyDetails, type DocKey, type DocTemplate } from "./docTemplates";
import { getCompanyProfile } from "./companyProfile";
import { docKeyEnabled } from "./docModuleAccess";

/** First run per type: seed a "Standard" template (from legacy settings if any). */
export async function ensureSeeded(): Promise<void> {
  for (const key of Object.keys(DOC_DEFS) as DocKey[]) {
    if (!(await docKeyEnabled(key))) continue;
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
  if (!(await docKeyEnabled(key))) return [];
  return prisma.docTemplateRecord.findMany({
    where: { docType: key, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

/**
 * Live Studio clauses, by name — every Studio clause list reads through here.
 * Filtered in JS: a JSON-path `not` filter would also drop rows with no `kind`.
 */
export async function listStudioClauses() {
  const rows = await prisma.reusableBlock.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });
  return rows.filter((row) => !isDocEditorLibraryItem(row));
}

/** A template by id, or null when it is gone or its document's module is off. */
export async function getTemplateRecord(id: string) {
  const rec = await prisma.docTemplateRecord.findUnique({ where: { id } });
  if (!rec || !(await docKeyEnabled(rec.docType))) return null;
  return rec;
}

/**
 * The template a generated document should use: an explicit record (preview
 * via ?tpl=), else the type's default record, else built-in defaults.
 */
export async function getDocTemplate(key: DocKey, templateId?: string): Promise<DocTemplate> {
  // Every print of a typed document comes through here: refuse rather than
  // render a module-only document in a workspace without the module.
  if (!(await docKeyEnabled(key))) throw new Error(`The ${DOC_DEFS[key].label} isn't available in this workspace.`);
  const [tpl, company] = await Promise.all([loadDocTemplate(key, templateId), getCompanyProfile()]);
  return withCompanyDetails(tpl, company);
}

async function loadDocTemplate(key: DocKey, templateId?: string): Promise<DocTemplate> {
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
