import "server-only";
import { prisma } from "@/lib/db";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
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
          data: standardTemplateFor(key) as object,
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
    return await prisma.docBuilderTemplate.findMany({
      orderBy: [{ key: "asc" }, { updatedAt: "desc" }],
    });
  } catch {
    return [];
  }
}

export async function getBuilderTemplate(id: string) {
  const record = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!record || record.deletedAt) return null;
  return record;
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
