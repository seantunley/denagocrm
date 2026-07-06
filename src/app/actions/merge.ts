"use server";

import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";

/**
 * Merges duplicate contacts into one: every lead, vehicle, job card, quote,
 * communication, activity and document moves to the kept contact; missing
 * details are filled in from the duplicates; duplicates go to the Trash.
 */
export async function mergeContacts(keepId: string, otherIdsCsv: string) {
  const user = await requireUser();
  const otherIds = otherIdsCsv.split(",").filter((id) => id && id !== keepId);
  if (otherIds.length === 0) return;

  const keep = await prisma.contact.findUniqueOrThrow({ where: { id: keepId } });
  const others = await prisma.contact.findMany({
    where: { id: { in: otherIds } },
    include: { tags: true },
  });

  for (const other of others) {
    await basePrisma.$transaction([
      basePrisma.lead.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.vehicle.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.jobCard.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.quote.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.communication.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.activity.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.document.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
      basePrisma.auditLog.updateMany({ where: { contactId: other.id }, data: { contactId: keepId } }),
    ]);
    if (other.tags.length > 0) {
      await prisma.contact.update({
        where: { id: keepId },
        data: { tags: { connect: other.tags.map((t) => ({ id: t.id })) } },
      });
    }
    // fill gaps on the kept contact from the duplicate
    const fill: Record<string, string> = {};
    for (const f of ["email", "phone", "whatsapp", "company", "address", "suburb", "city", "province", "postalCode", "notes"] as const) {
      if (!keep[f] && other[f]) fill[f] = other[f] as string;
    }
    if (Object.keys(fill).length > 0) {
      await prisma.contact.update({ where: { id: keepId }, data: fill });
    }
    await basePrisma.contact.update({
      where: { id: other.id },
      data: {
        deletedAt: new Date(),
        deletedByName: user.name,
        deleteReason: `Merged into ${contactName(keep)}`,
      },
    });
  }

  await logAudit({
    action: "contact.merged",
    summary: `Merged ${others.length} duplicate${others.length !== 1 ? "s" : ""} into ${contactName(keep)}`,
    contactId: keepId,
    user,
  });
  revalidatePath("/contacts");
  revalidatePath("/duplicates");
  revalidatePath(`/contacts/${keepId}`);
}
