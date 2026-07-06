import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { createIntakeLead } from "@/lib/leadIntake";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { contactName, formatDate } from "@/lib/format";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

const bookingSchema = z.object({
  name: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z
    .string()
    .refine((v) => v.replace(/\D/g, "").length >= 9, "Phone number looks too short"),
  model: z.string().max(200).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timePreference: z.enum(["morning", "afternoon", "any"]).optional(),
  message: z.string().max(3000).optional().nullable(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/** Service booking intake from denagocpt.co.za — lands on the Workshop calendar. */
export async function POST(req: NextRequest) {
  const apiKey = await getSetting("INTAKE_API_KEY");
  if (!apiKey || req.headers.get("x-api-key") !== apiKey) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: corsHeaders });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }
  const parsed = bookingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 422, headers: corsHeaders }
    );
  }
  const b = parsed.data;
  const bookingDate = new Date(`${b.date}T08:00:00`);
  if (isNaN(bookingDate.getTime()) || bookingDate < new Date(new Date().toDateString())) {
    return NextResponse.json(
      { error: "Booking date must be today or later" },
      { status: 422, headers: corsHeaders }
    );
  }

  const digits = b.phone.replace(/\D/g, "").slice(-9);
  const contact = await prisma.contact.findFirst({
    where: {
      OR: [
        { email: { equals: b.email, mode: "insensitive" } },
        { phone: { contains: digits } },
        { whatsapp: { contains: digits } },
      ],
    },
    include: { vehicles: true },
  });

  let contactId: string | null = contact?.id ?? null;
  let leadId: string | null = null;

  if (!contact) {
    const lead = await createIntakeLead({
      name: b.name,
      email: b.email,
      phone: b.phone,
      model: b.model,
      message: `Service booking request for ${b.date}${
        b.timePreference && b.timePreference !== "any" ? ` (${b.timePreference})` : ""
      }.${b.message ? `\n\n${b.message}` : ""}`,
      source: "website",
      raw: json,
    });
    leadId = lead.id;
    contactId = lead.contactId;
  }

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) {
    return NextResponse.json({ error: "No users configured" }, { status: 500, headers: corsHeaders });
  }

  const vehicleHint =
    b.model ?? (contact && contact.vehicles.length === 1 ? contact.vehicles[0].model : null);
  const summary = `Service booking — ${b.name}${vehicleHint ? ` (${vehicleHint})` : ""}${
    b.timePreference && b.timePreference !== "any" ? ` · ${b.timePreference}` : ""
  }`;

  const activity = await prisma.activity.create({
    data: {
      type: "meeting",
      category: "workshop",
      summary,
      note: [b.message, `Booked online · ${b.email} · ${b.phone}`].filter(Boolean).join("\n"),
      dueDate: bookingDate,
      contactId,
      leadId,
      assignedToId: firstUser.id,
      createdById: firstUser.id,
    },
  });

  await logAudit({
    action: "booking.received",
    summary: `Online service booking for ${formatDate(bookingDate)}: ${summary}`,
    contactId,
    leadId,
    userName: "Website",
  });
  await sendPushToAll({
    title: "New service booking 📅",
    body: `${contact ? contactName(contact) : b.name} — ${formatDate(bookingDate)}${
      b.timePreference && b.timePreference !== "any" ? ` (${b.timePreference})` : ""
    }`,
    url: "/workshop-calendar",
  }).catch(() => {});

  return NextResponse.json(
    { ok: true, activityId: activity.id },
    { status: 201, headers: corsHeaders }
  );
}
