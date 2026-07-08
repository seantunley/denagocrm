import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

const verifySchema = z.object({
  vin: z.string().min(4).max(60),
  code: z.string().regex(/^\d{6}$/),
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Step 2 of owner verification: correct OTP in → registered details out,
 * to prefill the booking form. Max 5 attempts per code, 10-minute expiry.
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
  const parsed = verifySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please enter the 6-digit code." },
      { status: 422, headers: corsHeaders }
    );
  }
  const vin = parsed.data.vin.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

  const challenge = await basePrisma.otpChallenge.findFirst({
    where: {
      purpose: "service-booking",
      key: vin,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.attempts >= 5) {
    return NextResponse.json(
      { error: "Code expired or too many attempts — request a new one." },
      { status: 410, headers: corsHeaders }
    );
  }

  await basePrisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });

  // Support both the new bcrypt hashes and any legacy SHA-256 rows still
  // within their 10-minute window during the changeover.
  const stored = challenge.codeHash;
  const codeOk = stored.startsWith("$2")
    ? await bcrypt.compare(parsed.data.code, stored)
    : (await import("crypto")).createHash("sha256").update(parsed.data.code).digest("hex") === stored;
  if (!codeOk) {
    return NextResponse.json(
      { error: "That code isn't right — please check and try again." },
      { status: 401, headers: corsHeaders }
    );
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { vin: { equals: vin, mode: "insensitive" } },
    include: { contact: true, serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 } },
  });
  if (!vehicle || vehicle.contact.deletedAt) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404, headers: corsHeaders });
  }

  await basePrisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { verifiedAt: new Date() },
  });
  await logAudit({
    action: "booking.otp_verified",
    summary: `Vehicle owner verified by OTP (${challenge.channel}) for ${vehicle.model} — online service booking`,
    contactId: vehicle.contactId,
    userName: "Website",
  });

  return NextResponse.json(
    {
      ok: true,
      details: {
        name: contactName(vehicle.contact),
        email: vehicle.contact.email,
        phone: vehicle.contact.phone ?? vehicle.contact.whatsapp,
        model: vehicle.model,
        vin: vehicle.vin,
        lastServiceDate: vehicle.serviceRecords[0]?.serviceDate ?? null,
      },
    },
    { headers: corsHeaders }
  );
}
