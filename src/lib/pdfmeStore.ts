import "server-only";
import type { Template } from "@pdfme/common";
import { prisma } from "./db";
import { PDFME_SEEDS } from "./pdfmeSeeds";

export type PdfmeTemplateRow = {
  id: string;
  key: string;
  name: string;
  isDefault: boolean;
  schema: Template;
  sample: Record<string, string>;
  updatedAt: Date;
};

/**
 * Seed the Designer with the live Denago layouts on first use so it never opens
 * empty. Best-effort: before migration 55 is applied the table doesn't exist —
 * we swallow that so the Documents page still renders.
 */
export async function ensurePdfmeSeeded(): Promise<void> {
  try {
    // Seed one starter template per doc type, idempotently: any seed whose key
    // has no template yet is created (so newly-added doc types appear on next
    // load without duplicating types the user has already customised).
    const present = await prisma.pdfmeTemplate.findMany({ select: { key: true } });
    const seededKeys = new Set(present.map((t) => t.key));
    for (const seed of PDFME_SEEDS) {
      if (seededKeys.has(seed.key)) continue;
      await prisma.pdfmeTemplate.create({
        data: {
          key: seed.key,
          name: seed.name,
          isDefault: true, // one seed per key, so each is its type's default
          schema: seed.template as object,
          sample: seed.sample,
        },
      });
    }
  } catch {
    // table not migrated yet, or a race on first concurrent load — ignore
  }
}

export async function listPdfmeTemplates(): Promise<PdfmeTemplateRow[]> {
  try {
    const rows = await prisma.pdfmeTemplate.findMany({
      orderBy: [{ key: "asc" }, { isDefault: "desc" }, { updatedAt: "desc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      isDefault: r.isDefault,
      schema: r.schema as unknown as Template,
      sample: (r.sample ?? {}) as Record<string, string>,
      updatedAt: r.updatedAt,
    }));
  } catch {
    return [];
  }
}

export async function getPdfmeTemplate(id: string): Promise<PdfmeTemplateRow | null> {
  const r = await prisma.pdfmeTemplate.findUnique({ where: { id } });
  if (!r || r.deletedAt) return null;
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    isDefault: r.isDefault,
    schema: r.schema as unknown as Template,
    sample: (r.sample ?? {}) as Record<string, string>,
    updatedAt: r.updatedAt,
  };
}
