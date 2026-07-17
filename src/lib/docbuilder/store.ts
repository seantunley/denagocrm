import "server-only";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
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
      const parsed = rows.map((row) => ({
        ...row,
        valid: parseDocument(row.data) !== null,
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
      // Keep pages usable before migrations complete, but never hide a partial seed
      // failure. Continue with the remaining document types and leave an actionable log.
      console.error(`Could not seed builder template "${key}"`, error);
    }
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
