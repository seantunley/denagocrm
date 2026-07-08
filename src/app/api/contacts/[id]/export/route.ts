import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

/** POPIA data-subject access request: full personal-data export as JSON. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;

  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      leads: { select: { name: true, email: true, phone: true, source: true, status: true, createdAt: true } },
      quotes: { select: { number: true, status: true, createdAt: true } },
      vehicles: { select: { model: true, vin: true, regNumber: true, purchaseDate: true } },
      communications: { select: { type: true, direction: true, subject: true, body: true, occurredAt: true } },
      documents: { select: { fileName: true, tag: true, createdAt: true } },
      consentRecords: true,
      tags: { select: { name: true } },
      activities: { select: { type: true, summary: true, dueDate: true } },
    },
  });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const surveys = await prisma.surveyResponse.findMany({
    where: { contactId: id },
    select: { status: true, score: true, comment: true, answers: true, completedAt: true },
  });

  await logAudit({
    action: "privacy.exported",
    summary: "Personal data exported (POPIA access request)",
    contactId: id,
    user,
  });

  const payload = { exportedAt: new Date().toISOString(), contact, surveys };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="contact-${id}.json"`,
    },
  });
}
