import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { authenticateIntakeKey } from "@/lib/apiKeys";
import { throttlePublic } from "@/lib/publicThrottle";
import { API_KEY_POLICY } from "@/lib/rateLimit";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";
import { writeTenantId } from "@/lib/tenantWrite";
import { resolveTenantActor } from "@/lib/tenantActor";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { getSlotConfig, slotInstantOrThrow, claimSlotCapacity } from "@/lib/bookingSlots";
import { nextJobCardNumber } from "@/lib/numbering";
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
  // Authenticate + establish the caller's tenant scope BEFORE any guarded read
  // (incl. the module check, which reads tenant-owned settings).
  // Throttled BEFORE the key is checked, so guessing keys is bounded too;
  // keyed on the presented key (HMACed by rateLimitKey) so a LEAKED key cannot
  // write without limit. See API_KEY_POLICY — generous, aimed at abuse not use.
  {
    const throttled = await throttlePublic("api-bookings", req.headers.get("x-api-key"), API_KEY_POLICY);
    if (throttled) return throttled;
  }
  const auth = await authenticateIntakeKey(req.headers.get("x-api-key"), "bookings");
  if (!auth) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: corsHeaders });
  }
  establishTenantScopeFromId(auth.tenantId);
  // Workshop bookings belong to the automotive pack — gone when it's off.
  if (!(await isModuleEnabled("automotive"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  // Validate the slot up front (cheap, no writes) so a bad date/time fails before
  // anything is touched.
  const config = await getSlotConfig();
  let dt: Date;
  try {
    dt = slotInstantOrThrow(b.date, b.time, config);
  } catch {
    return NextResponse.json(
      { error: "slot_invalid", message: "That date/time isn't available for booking." },
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

  // The booking's system actor — a member of THIS tenant, never a global user.
  const firstUser = await resolveTenantActor();
  if (!firstUser) {
    return NextResponse.json({ error: "No users configured" }, { status: 500, headers: corsHeaders });
  }

  // Which vehicle (if any) this booking is for — computed from existing data.
  const vehicles = contact?.vehicles.filter((v) => !v.deletedAt) ?? [];
  const vehicle =
    vehicles.length === 1
      ? vehicles[0]
      : (b.model
          ? vehicles.find((v) => v.model.toLowerCase().includes(b.model!.toLowerCase()))
          : null) ?? null;
  const vehicleHint =
    vehicle?.model ?? b.model ?? (vehicles.length === 1 ? vehicles[0].model : null);
  const summary = `Service ${b.time} — ${b.name}${vehicleHint ? ` (${vehicleHint})` : ""}`;

  // The tenant to STAMP every row with (and namespace the slot capacity by). The
  // writes below run on `basePrisma` for the row lock, so the db.ts guard does NOT
  // scope or stamp them — we do it explicitly. null under dormant/system → unstamped,
  // single-namespace, exactly the pre-tenancy behaviour.
  const writeTid = writeTenantId();

  // Everything that WRITES runs in ONE transaction, and the slot capacity is
  // claimed FIRST. Previously the contact and job card were created before the
  // slot was reserved, so a full/invalid slot left an orphan contact + job card
  // behind on every retry. Now a SLOT_TAKEN rolls the whole thing back.
  let outcome: { activityId: string; contactId: string | null; jobCardNumber: number | null; createdContact: boolean };
  try {
    outcome = await basePrisma.$transaction(async (tx) => {
      await claimSlotCapacity(tx, dt, config.capacity, writeTid);

      // A service booking is workshop work — it must never open a sales lead.
      let contactId: string | null = contact?.id ?? null;
      let createdContact = false;
      if (!contact) {
        const [firstName, ...rest] = b.name.trim().split(/\s+/);
        const created = await tx.contact.create({
          data: {
            firstName: firstName || b.name,
            lastName: rest.join(" ") || null,
            email: b.email,
            phone: b.phone,
            source: "website",
            notes: `Created from an online service booking for ${b.date} at ${b.time}.`,
            ...(writeTid ? { tenantId: writeTid } : {}),
          },
        });
        contactId = created.id;
        createdContact = true;
      }

      let jobCardNumber: number | null = null;
      if (vehicle && contactId) {
        const number = await nextJobCardNumber(tx);
        const jc = await tx.jobCard.create({
          data: {
            number,
            description: `Online service booking for ${b.date} at ${b.time} — call the customer to confirm.${
              b.message ? `\n\nCustomer note: ${b.message}` : ""
            }`,
            vehicleId: vehicle.id,
            contactId,
            ...(writeTid ? { tenantId: writeTid } : {}),
          },
        });
        jobCardNumber = jc.number;
      }

      const activity = await tx.activity.create({
        data: {
          type: "meeting",
          category: "workshop",
          summary,
          note: [
            b.message,
            `Booked online · ${b.email} · ${b.phone} · call to confirm${
              jobCardNumber ? ` · job card #${jobCardNumber}` : ""
            }`,
          ]
            .filter(Boolean)
            .join("\n"),
          dueDate: dt,
          contactId,
          assignedToId: firstUser.id,
          createdById: firstUser.id,
          ...(writeTid ? { tenantId: writeTid } : {}),
        },
      });
      return { activityId: activity.id, contactId, jobCardNumber, createdContact };
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "SLOT_TAKEN") {
      return NextResponse.json(
        { error: "slot_taken", message: "That time has just been booked — please pick another slot." },
        { status: 409, headers: corsHeaders }
      );
    }
    if (code === "SLOT_INVALID") {
      return NextResponse.json(
        { error: "slot_invalid", message: "That date/time isn't available for booking." },
        { status: 422, headers: corsHeaders }
      );
    }
    // Only the known slot outcomes are client errors. An unexpected DB /
    // transaction failure must surface as a 500, not masquerade as a bad slot
    // (which would tell the website to blame the customer's date/time).
    console.error("Booking transaction failed", err);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong creating your booking. Please try again." },
      { status: 500, headers: corsHeaders }
    );
  }

  // Audit + notify AFTER commit (best-effort; never rolls the booking back).
  if (outcome.createdContact) {
    await logAudit({ action: "contact.created", summary: "Contact created from an online service booking", contactId: outcome.contactId, userName: "Website" });
  }
  if (outcome.jobCardNumber && vehicle) {
    await logAudit({ action: "jobcard.created", summary: `Job card #${outcome.jobCardNumber} opened from an online service booking (${vehicle.model})`, contactId: outcome.contactId, userName: "Website" });
  }
  await logAudit({
    action: "booking.received",
    summary: `Online service booking: ${summary} on ${formatDate(dt)}${
      outcome.jobCardNumber ? ` — job card #${outcome.jobCardNumber} opened` : ""
    }`,
    contactId: outcome.contactId,
    userName: "Website",
  });
  await sendPushToAll({
    title: "New service booking 📅",
    body: `${contact ? contactName(contact) : b.name} — ${formatDate(dt)} at ${b.time} · call to confirm`,
    url: "/workshop-calendar",
  }, "booking").catch(() => {});

  return NextResponse.json(
    { ok: true, activityId: outcome.activityId },
    { status: 201, headers: corsHeaders }
  );
}
