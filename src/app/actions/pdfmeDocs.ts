"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { BLANK_TEMPLATE, PDFME_SEEDS } from "@/lib/pdfmeSeeds";

const DOCS = "/settings/documents";

/** Create a new pdfme template — blank, from a seed layout, or copied from an existing one. */
export async function createPdfmeTemplate(formData: FormData) {
  const user = await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  const key = String(formData.get("key") ?? "").trim() || "quote";
  const baseId = String(formData.get("baseId") ?? "").trim();
  if (!name) return;

  let schema: object = BLANK_TEMPLATE;
  let sample: Record<string, string> = {};

  if (baseId.startsWith("seed:")) {
    const seed = PDFME_SEEDS.find((s) => s.key === baseId.slice(5));
    if (seed) {
      schema = seed.template as object;
      sample = seed.sample;
    }
  } else if (baseId) {
    const base = await prisma.pdfmeTemplate.findUnique({ where: { id: baseId } });
    if (base) {
      schema = base.schema as object;
      sample = (base.sample ?? {}) as Record<string, string>;
    }
  }

  const created = await prisma.pdfmeTemplate.create({
    data: { key, name, schema, sample, createdById: user.id },
  });
  await logAudit({
    action: "pdfme.template.created",
    summary: `Created document designer template “${name}” (${key})`,
    entityType: "PdfmeTemplate",
    entityId: created.id,
    user,
  });
  revalidatePath(DOCS);
}

/** Persist the edited pdfme Template JSON from the Designer. */
export async function savePdfmeSchema(
  id: string,
  schema: unknown
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireOwner();
  const existing = await prisma.pdfmeTemplate.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) return { ok: false, error: "Template not found." };
  await prisma.pdfmeTemplate.update({
    where: { id },
    data: { schema: schema as object },
  });
  await logAudit({
    action: "pdfme.template.saved",
    summary: `Saved layout for designer template “${existing.name}”`,
    entityType: "PdfmeTemplate",
    entityId: id,
    user,
  });
  revalidatePath(`${DOCS}/designer/${id}`);
  revalidatePath(DOCS);
  return { ok: true };
}

export async function renamePdfmeTemplate(id: string, formData: FormData) {
  const user = await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.pdfmeTemplate.update({ where: { id }, data: { name } });
  await logAudit({
    action: "pdfme.template.renamed",
    summary: `Renamed designer template to “${name}”`,
    entityType: "PdfmeTemplate",
    entityId: id,
    user,
  });
  revalidatePath(`${DOCS}/designer/${id}`);
  revalidatePath(DOCS);
}

export async function setDefaultPdfmeTemplate(id: string) {
  const user = await requireOwner();
  const tpl = await prisma.pdfmeTemplate.findUnique({ where: { id } });
  if (!tpl || tpl.deletedAt) return;
  await prisma.$transaction([
    prisma.pdfmeTemplate.updateMany({ where: { key: tpl.key }, data: { isDefault: false } }),
    prisma.pdfmeTemplate.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await logAudit({
    action: "pdfme.template.default",
    summary: `Set “${tpl.name}” as the default ${tpl.key} designer template`,
    entityType: "PdfmeTemplate",
    entityId: id,
    user,
  });
  revalidatePath(DOCS);
}

export async function deletePdfmeTemplate(id: string) {
  const user = await requireOwner();
  const tpl = await prisma.pdfmeTemplate.findUnique({ where: { id } });
  if (!tpl || tpl.deletedAt) return;
  await prisma.pdfmeTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({
    action: "pdfme.template.deleted",
    summary: `Deleted designer template “${tpl.name}”`,
    entityType: "PdfmeTemplate",
    entityId: id,
    user,
  });
  revalidatePath(DOCS);
}
