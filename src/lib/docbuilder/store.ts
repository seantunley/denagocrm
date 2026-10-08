import "server-only";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { docKeyEnabled } from "@/lib/docModuleAccess";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { hasLegacyTokens, inlineLegacyText, type LegacyText } from "@/lib/doceditor/inlineLegacyText";
import { getDocTemplateText } from "@/lib/docTemplateStore";
import {
  STANDARD_TEMPLATE_KEYS,
  STANDARD_TEMPLATE_NAMES,
  standardTemplateFor,
} from "@/lib/doceditor/standardTemplates";

/**
 * Ensure a valid system builder template exists for every operational document
 * type. Existing data is never overwritten: invalid legacy system rows are
 * preserved for recovery and a new valid template is cloned alongside them.
 */
export async function ensureBuilderSeeded(): Promise<void> {
  for (const key of STANDARD_TEMPLATE_KEYS) {
    // No job card / indemnity / … templates minted for a workspace without the module.
    if (!(await docKeyEnabled(key))) continue;
    try {
      const rows = await prisma.docBuilderTemplate.findMany({
        where: { key, deletedAt: null },
        select: {
          id: true,
          data: true,
          createdById: true,
          isDefault: true,
        },
      });
      // "Valid" means the app can RENDER it, which now includes the legacy Puck
      // format — otherwise a legacy row is treated as broken and gets a
      // replacement cloned next to it, which is how "Quotation" came to appear
      // twice in the builder list.
      const parsed = rows.map((row) => ({
        ...row,
        valid: readTemplateDocument(row.data).status === "ok",
      }));
      const validSystem = parsed.filter(
        (row) => row.createdById === null && row.valid,
      );

      if (validSystem.length > 0) {
        const currentDefault = parsed.find((row) => row.isDefault);
        const systemDefaultIsBroken =
          !currentDefault ||
          (currentDefault.createdById === null && !currentDefault.valid);
        if (systemDefaultIsBroken) {
          await prisma.docBuilderTemplate.updateMany({
            where: { key, createdById: null, deletedAt: null },
            data: { isDefault: false },
          });
          await prisma.docBuilderTemplate.update({
            where: { id: validSystem[0].id },
            data: { isDefault: true },
          });
        }
        continue;
      }

      const invalidSystem = parsed.filter(
        (row) => row.createdById === null && !row.valid,
      );
      if (invalidSystem.length > 0) {
        await prisma.docBuilderTemplate.updateMany({
          where: { key, createdById: null, deletedAt: null },
          data: { isDefault: false },
        });
      }

      const becomeDefault =
        invalidSystem.some((row) => row.isDefault) ||
        !parsed.some((row) => row.isDefault);
      await prisma.docBuilderTemplate.create({
        data: {
          name: STANDARD_TEMPLATE_NAMES[key],
          key,
          isDefault: becomeDefault,
          // The workspace's own standard: no vehicle card or EV disclaimer on a
          // non-automotive workspace's quotes.
          data: standardTemplateFor(key, { automotive: await isModuleEnabled("automotive") }) as object,
        },
      });
    } catch (error) {
      console.error(`Could not seed builder template "${key}"`, error);
    }
  }
}

/**
 * Resolve the builder template that should drive an operational document. The
 * explicit default wins, with the most recently updated valid row as fallback.
 */
export async function defaultBuilderTemplateId(
  key: string,
): Promise<string | null> {
  try {
    if (!(await docKeyEnabled(key))) return null;
    await ensureBuilderSeeded();
    const rows = await prisma.docBuilderTemplate.findMany({
      where: { key, deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, data: true },
    });
    return rows.find((row) => readTemplateDocument(row.data).status === "ok")?.id ?? null;
  } catch (error) {
    console.error(`Could not resolve default builder template "${key}"`, error);
    return null;
  }
}

export async function listBuilderTemplates() {
  try {
    const rows = await prisma.docBuilderTemplate.findMany({
      orderBy: [{ key: "asc" }, { updatedAt: "desc" }],
    });
    const enabled = await Promise.all(rows.map((row) => docKeyEnabled(row.key)));
    return rows.filter((_, i) => enabled[i]);
  } catch {
    return [];
  }
}

export async function getBuilderTemplate(id: string) {
  const record = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!record || record.deletedAt) return null;
  // The one door every by-id read uses (editor, preview, render, export, and the
  // builder actions), so a module-only template opened by id is simply not there.
  if (!(await docKeyEnabled(record.key))) return null;
  // A customer EMAIL layout (`email:…`) exists only for the workspace that OWNS
  // it (review of #806). `isTenantOwner()` proves the caller owns their active
  // workspace, not that this row is in it — and this lookup is by id alone, so
  // an owner of workspace A holding one of B's ids could otherwise open, save,
  // publish, restore and preview B's email. Checked HERE, the one door, so every
  // one of those paths gets it; an email row without a tenant is nobody's.
  if (record.key.startsWith("email:")) {
    const active = await getActiveTenantId().catch(() => null);
    if (!active || record.tenantId !== active) return null;
  }
  return record;
}

/**
 * An invoice or sales agreement layout that still reads its text (bank
 * details, payment terms, clauses) from the old form editor, with that text
 * written in (inlineLegacyText) — so it is edited in the one editor. READS
 * only: the editor opens this and its save stores it; Publish stores it too
 * (publishBuilderVersion). Until the owner publishes, the live document keeps
 * printing the old text, as it always has.
 */
export async function withLegacyTextInlined<T extends { key: string; data: unknown }>(template: T): Promise<T> {
  if ((template.key !== "invoice" && template.key !== "agreement") || !hasLegacyTokens(template.key, template.data)) return template;
  const old = await getDocTemplateText(template.key);
  const sectionOn = (section: string) => old.sections[section] !== false;
  const legacy: LegacyText =
    template.key === "invoice"
      ? {
          intro: { text: old.intro ?? "", on: true },
          paymentTerms: { text: old.terms ?? "", on: sectionOn("terms") },
          bankingDetails: { text: old.bodyText ?? "", on: sectionOn("banking") },
        }
      : {
          intro: { text: old.intro ?? "", on: true },
          clauses: { text: old.bodyText ?? "", on: sectionOn("clauses") },
        };
  return { ...template, data: inlineLegacyText(template.key, template.data, legacy) };
}

/**
 * The template as customers get it: its PUBLISHED version, not the working draft.
 *
 * The editor autosaves, so rendering `data` put every half-finished edit straight
 * onto quotes, signing envelopes and filed PDFs, and Publish did nothing. Real
 * documents now render the published snapshot. A template never published falls
 * back to its draft, which is exactly what it rendered before this existed, so
 * nothing changes for it until someone presses Publish.
 *
 * Previews of the layout being edited (the editor, ?tpl= in Document Studio, the
 * editor's own export) keep using getBuilderTemplate and the draft.
 */
export async function getLiveBuilderTemplate(id: string) {
  const record = await getBuilderTemplate(id);
  if (!record || record.publishedVersion == null) return record;
  const published = await prisma.docBuilderVersion.findUnique({
    where: { templateId_version: { templateId: id, version: record.publishedVersion } },
    select: { data: true },
  });
  // A missing snapshot would be data damage; render the draft rather than nothing.
  return published ? { ...record, data: published.data } : record;
}

/** Version history for a template, newest first (metadata only — no data blob). */
export async function listBuilderVersions(templateId: string) {
  try {
    return await prisma.docBuilderVersion.findMany({
      where: { templateId },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        label: true,
        publishedAt: true,
        publishedBy: true,
      },
    });
  } catch {
    return [];
  }
}
