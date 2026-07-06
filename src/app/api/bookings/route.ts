import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { reserveSlot } from "@/lib/bookingSlots";
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
  time: z.string().regex(/^\d{2}:\d{2}$/),
  message: z.string().max(3000).optional().nullable(),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Service booking from denagocpt.co.za. Hard slots: the requested time is
 * reserved atomically — if it's taken, the request fails with 409.
 */
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

  // A service booking is workshop work — it must never open a sales lead.
  let contactId: string | null = contact?.id ?? null;
  if (!contact) {
    const [firstName, ...rest] = b.name.trim().split(/\s+/);
    const created = await prisma.contact.create({
      data: {
        firstName: firstName || b.name,
        lastName: rest.join(" ") || null,
        email: b.email,
        phone: b.phone,
        source: "website",
        notes: `Created from an online service booking for ${b.date} at ${b.time}.`,
      },
    });
    contactId = created.id;
    await logAudit({
      action: "contact.created",
      summary: `Contact created from an online service booking`,
      contactId,
      userName: "Website",
    });
  }

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) {
    return NextResponse.json({ error: "No users configured" }, { status: 500, headers: corsHeaders });
  }

  // Open a job card when we can tell which vehicle is coming in
  const vehicles = contact?.vehicles.filter((v) => !v.deletedAt) ?? [];
  const vehicle =
    vehicles.length === 1
      ? vehicles[0]
      : (b.model
          ? vehicles.find((v) => v.model.toLowerCase().includes(b.model!.toLowerCase()))
          : null) ?? null;
  let jobCardNumber: number | null = null;
  if (vehicle && contactId) {
    const maxJc = await basePrisma.jobCard.aggregate({ _max: { number: true } });
    const jc = await prisma.jobCard.create({
      data: {
        number: (maxJc._max.number ?? 1000) + 1,
        description: `Online service booking for ${b.date} at ${b.time} — call the customer to confirm.${
          b.message ? `\n\nCustomer note: ${b.message}` : ""
        }`,
        vehicleId: vehicle.id,
        contactId,
      },
    });
    jobCardNumber = jc.number;
    await logAudit({
      action: "jobcard.created",
      summary: `Job card #${jc.number} opened from an online service booking (${vehicle.model})`,
      contactId,
      userName: "Website",
    });
  }

  const vehicleHint =
    vehicle?.model ?? b.model ?? (vehicles.length === 1 ? vehicles[0].model : null);
  const summary = `Service ${b.time} — ${b.name}${vehicleHint ? ` (${vehicleHint})` : ""}`;

  let activity;
  try {
    activity = await reserveSlot({
      date: b.date,
      time: b.time,
      summary,
      note: [
        b.message,
        `Booked online · ${b.email} · ${b.phone} · call to confirm${
          jobCardNumber ? ` · job card #${jobCardNumber}` : ""
        }`,
      ]
        .filter(Boolean)
        .join("\n"),
      contactId,
      leadId: null,
      userId: firstUser.id,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "SLOT_TAKEN") {
      return NextResponse.json(
        { error: "slot_taken", message: "That time has just been booked — please pick another slot." },
        { status: 409, headers: corsHeaders }
      );
    }
    return NextResponse.json(
      { error: "slot_invalid", message: "That date/time isn't available for booking." },
      { status: 422, headers: corsHeaders }
    );
  }

  await logAudit({
    action: "booking.received",
    summary: `Online service booking: ${summary} on ${formatDate(activity.dueDate)}${
      jobCardNumber ? ` — job card #${jobCardNumber} opened` : ""
    }`,
    contactId,
    userName: "Website",
  });
  await sendPushToAll({
    title: "New service booking 📅",
    body: `${contact ? contactName(contact) : b.name} — ${formatDate(activity.dueDate)} at ${b.time} · call to confirm`,
    url: "/workshop-calendar",
  }).catch(() => {});

  return NextResponse.json(
    { ok: true, activityId: activity.id },
    { status: 201, headers: corsHeaders }
  );
}
