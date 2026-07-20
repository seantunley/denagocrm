import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireApiOwner, apiAuthErrorResponse } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { collectCustomValues, displayValue, type CollectedCustomValue } from "@/lib/customFields";

/** Flatten collected custom values into label-keyed rows for the export payload. */
function exportCustomValues(rows: CollectedCustomValue[]) {
  return rows.map((r) => ({
    recordId: r.recordId,
    field: r.def.label,
    key: r.def.key,
    type: r.def.type,
    value: displayValue(r.def, r.value),
  }));
}

/** POPIA data-subject access request: full personal-data export as JSON. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireApiOwner(); // JSON 401/403 (not an HTML redirect) for this download route
  } catch (err) {
    const res = apiAuthErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const { id } = await params;

  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      leads: { select: { id: true, name: true, email: true, phone: true, source: true, status: true, createdAt: true } },
      quotes: { select: { id: true, number: true, status: true, createdAt: true } },
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

  // Custom-field values live in a separate EAV table with no FK to the record,
  // so a "full personal data export" must gather them per entity by record id —
  // for the contact itself and every related lead / quote / case.
  const leadIds = contact.leads.map((l) => l.id);
  const quoteIds = contact.quotes.map((q) => q.id);
  const caseIds = (
    await prisma.customerCase.findMany({ where: { contactId: id }, select: { id: true } })
  ).map((c) => c.id);
  const [contactCustom, leadCustom, quoteCustom, caseCustom] = await Promise.all([
    collectCustomValues("contact", [id]),
    collectCustomValues("lead", leadIds),
    collectCustomValues("quote", quoteIds),
    collectCustomValues("case", caseIds),
  ]);
  const customFields = {
    contact: exportCustomValues(contactCustom),
    leads: exportCustomValues(leadCustom),
    quotes: exportCustomValues(quoteCustom),
    cases: exportCustomValues(caseCustom),
  };

  await logAudit({
    action: "privacy.exported",
    summary: "Personal data exported (POPIA access request)",
    contactId: id,
    user,
  });

  const payload = { exportedAt: new Date().toISOString(), contact, surveys, customFields };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="contact-${id}.json"`,
    },
  });
}
