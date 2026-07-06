import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { sendSms, isSmsConfigured, maskPhone } from "@/lib/sms";
import { sendEmail, isSmtpConfigured } from "@/lib/email";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

const lookupSchema = z.object({
  vin: z.string().min(4).max(60),
});

export function normalizeVin(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}•••@${domain}`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Step 1 of owner verification on the public book-a-service form:
 * VIN in → OTP out to the registered number (or email as fallback).
 * The response NEVER contains customer data — only where the code went,
 * masked. Details are only released after the OTP is verified.
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
  const parsed = lookupSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 422, headers: corsHeaders });
  }
  const vin = normalizeVin(parsed.data.vin);
  const notFound = NextResponse.json(
    {
      ok: true,
      sent: false,
      message:
        "We couldn't verify that VIN / serial number automatically — please fill in your details below.",
    },
    { headers: corsHeaders }
  );

  // Flood guard: max 3 codes per VIN per hour
  const recent = await basePrisma.otpChallenge.count({
    where: {
      purpose: "service-booking",
      key: vin,
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recent >= 3) {
    return NextResponse.json(
      { ok: true, sent: false, message: "Too many attempts — please try again in an hour or fill in the form manually." },
      { headers: corsHeaders }
    );
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { vin: { equals: vin, mode: "insensitive" } },
    include: { contact: true },
  });
  if (!vehicle || vehicle.contact.deletedAt) return notFound;

  const phone = vehicle.contact.whatsapp ?? vehicle.contact.phone;
  const email = vehicle.contact.email;
  const code = crypto.randomInt(100000, 1000000).toString();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  let channel: "sms" | "email" | null = null;
  let target = "";
  if (phone && (await isSmsConfigured())) {
    const res = await sendSms(
      phone,
      `Denago Cape Town: your verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this message.`
    );
    if (res.ok) {
      channel = "sms";
      target = maskPhone(phone);
    }
  }
  if (!channel && email && (await isSmtpConfigured())) {
    const res = await sendEmail({
      to: email,
      subject: "Your Denago Cape Town verification code",
      text: `Your verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.\n\nDenago Cape Town`,
    });
    if (res.ok) {
      channel = "email";
      target = maskEmail(email);
    }
  }
  if (!channel) return notFound;

  await basePrisma.otpChallenge.create({
    data: {
      purpose: "service-booking",
      key: vin,
      codeHash,
      channel,
      target,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  return NextResponse.json(
    {
      ok: true,
      sent: true,
      channel,
      target,
      message: `We've sent a 6-digit code to ${target}.`,
    },
    { headers: corsHeaders }
  );
}
