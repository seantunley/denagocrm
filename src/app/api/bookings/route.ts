import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { ciExactIdFilter } from "@/lib/ciExact";
import { authenticateIntakeKey } from "@/lib/apiKeys";
import { throttlePublic } from "@/lib/publicThrottle";
import { API_KEY_POLICY } from "@/lib/rateLimit";
import { withTenantScopeFromId } from "@/lib/tenantScopeEntry";
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
  // Authenticate before any tenant-owned read. The API key is the tenant
  // principal for this public route; keep its resolved tenant as an ENCLOSING
  // async scope around the operation rather than relying on enterWith in a helper
  // to propagate back into this Route Handler.
  {
    const throttled = await throttlePublic("api-bookings", req.headers.get("x-api-key"), API_KEY_POLICY);
    if (throttled) return throttled;
  }
  const auth = await authenticateIntakeKey(req.headers.get("x-api-key"), "bookings");
  if (!auth) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401, headers: corsHeaders });
  }

  return withTenantScopeFromId(auth.tenantId, async () => {
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
    // Exact (case-folded) email match. `mode: "insensitive"` compiled to an
    // unescaped ILIKE, and `_`/`%` are legal in an email local part that Zod's
    // `.email()` accepts — so a booking submitted with `%@%` attached itself to an
    // arbitrary existing customer, taking their vehicle list with it. Ordered so
    // the same submission always resolves to the same contact.
    const contact = await prisma.contact.findFirst({
      where: {
        OR: [
          await ciExactIdFilter("contactEmail", b.email),
          { phone: { contains: digits } },
          { whatsapp: { contains: digits } },
        ],
      },
      include: { vehicles: true },
      orderBy: { createdAt: "asc" },
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

    // The tenant to NAMESPACE the slot capacity by. The writes below run on
    // `basePrisma` for the row lock, so the db.ts guard does NOT scope them — we do it
    // explicitly. null under dormant/system → single-namespace, exactly the pre-tenancy
    // behaviour. Deliberately NOT used as the stamp any more: see below.
    const writeTid = writeTenantId();

    // The tenant to STAMP the rows with, which is NOT the same question.
    //
    // `writeTenantId()` returns null whenever enforcement is dormant, so every
    // contact, job card and activity this endpoint created used to land unowned and
    // would vanish from the workspace at the flip. The owner is not unknown, though:
    // the API key that authenticated this request belongs to exactly one tenant.
    // A legacy dormant global key still resolves null, so unregistered callers keep
    // writing exactly what they wrote before — nothing is invented.
    //
    // The capacity namespace stays on `writeTid` on purpose. Narrowing the count to a
    // tenant would make every pre-existing NULL-tenant booking invisible to it, and the
    // slot would be double-booked — a stamping change must not quietly become a
    // capacity change.
    const stampTid = writeTid ?? auth.tenantId;

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
              ...(stampTid ? { tenantId: stampTid } : {}),
            },
          });
          contactId = created.id;
          createdContact = true;
        }

        // Everything below points at that contact through a COMPOSITE tenant foreign
        // key, so it must claim the contact's tenant — not the key's. A pre-existing
        // contact that is still unstamped cannot host a stamped job card or activity:
        // PostgreSQL refuses the insert and the customer's booking 500s. New contact →
        // the tenant we just gave it; existing contact → whatever it already has.
        const rowTid = contact ? contact.tenantId : stampTid;

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
              ...(rowTid ? { tenantId: rowTid } : {}),
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
            ...(rowTid ? { tenantId: rowTid } : {}),
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
  });
}
