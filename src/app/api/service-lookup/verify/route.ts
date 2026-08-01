import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { ciExactIdFilter } from "@/lib/ciExact";
import { authenticateIntakeKey } from "@/lib/apiKeys";
import { throttlePublic } from "@/lib/publicThrottle";
import { API_KEY_POLICY } from "@/lib/rateLimit";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";
import { serviceOtpKey } from "@/lib/serviceOtp";
import { isModuleEnabled } from "@/lib/modules/enabled";
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
  // Authenticate + establish the caller's tenant scope BEFORE any guarded read.
  // Throttled BEFORE the key is checked, so guessing keys is bounded too;
  // keyed on the presented key (HMACed by rateLimitKey) so a LEAKED key cannot
  // write without limit. See API_KEY_POLICY — generous, aimed at abuse not use.
  {
    const throttled = await throttlePublic("api-service-lookup-verify", req.headers.get("x-api-key"), API_KEY_POLICY);
    if (throttled) return throttled;
  }
  const auth = await authenticateIntakeKey(req.headers.get("x-api-key"), "service-lookup");
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
  const parsed = verifySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please enter the 6-digit code." },
      { status: 422, headers: corsHeaders }
    );
  }
  const vin = parsed.data.vin.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  // Same tenant-namespaced key as issuance — a code issued for another tenant's
  // request (or a bare-VIN legacy row from a different tenant) is invisible here.
  const otpKey = serviceOtpKey(vin);

  const challenge = await basePrisma.otpChallenge.findFirst({
    where: {
      purpose: "service-booking",
      key: otpKey,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) {
    return NextResponse.json(
      { error: "Code expired or too many attempts — request a new one." },
      { status: 410, headers: corsHeaders }
    );
  }
  // Atomically consume one attempt — only succeeds while the challenge is still
  // unverified and under the 5-attempt cap. The old read-then-increment let N
  // concurrent requests all pass the cap check before any increment landed,
  // giving far more than 5 guesses (brute force).
  const gate = await basePrisma.otpChallenge.updateMany({
    where: { id: challenge.id, verifiedAt: null, attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  if (gate.count !== 1) {
    return NextResponse.json(
      { error: "Code expired or too many attempts — request a new one." },
      { status: 410, headers: corsHeaders }
    );
  }

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

  // Exact (case-folded) — see the sibling route. The VIN is stripped to
  // [a-zA-Z0-9] on line 55, so the wildcards can't reach the query today; the
  // match is made exact so that stays true if the normalisation ever moves.
  const vehicle = await prisma.vehicle.findFirst({
    where: await ciExactIdFilter("vehicleVin", vin),
    include: { contact: true, serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 } },
  });
  if (!vehicle || vehicle.contact.deletedAt) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404, headers: corsHeaders });
  }

  // Atomically CONSUME the challenge: only the request that flips verifiedAt (from
  // null, still unexpired) may return the owner's details. Two concurrent correct
  // submissions both pass bcrypt, but only one wins this claim — the loser gets a
  // 410 instead of also leaking the customer's registered details.
  const consumed = await basePrisma.otpChallenge.updateMany({
    where: { id: challenge.id, verifiedAt: null, expiresAt: { gt: new Date() } },
    data: { verifiedAt: new Date() },
  });
  if (consumed.count !== 1) {
    return NextResponse.json(
      { error: "Code expired or already used — request a new one." },
      { status: 410, headers: corsHeaders }
    );
  }
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
