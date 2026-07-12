"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sendEmail, isSmtpConfigured } from "@/lib/email";
import { getPortalContact, setPortalCookie, clearPortalCookie } from "@/lib/portal";
import { sendPushToAll } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import {
  OTP_SEND_POLICY,
  OTP_VERIFY_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

export type PortalAuthState = { ok?: boolean; sent?: boolean; error?: string };
const str = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const normEmail = (email: string) => email.trim().toLowerCase();

export async function requestPortalOtp(
  _prev: PortalAuthState | undefined,
  formData: FormData
): Promise<PortalAuthState> {
  const email = normEmail(str(formData.get("email")));
  if (!email || !email.includes("@")) return { error: "Enter your email address." };
  if (!(await isSmtpConfigured())) return { error: "The customer portal isn't available right now." };

  const generic: PortalAuthState = { sent: true };
  const ip = await getRequestIp();
  const accountKey = rateLimitKey("portal-otp-send-account", email);
  const ipKey = rateLimitKey("portal-otp-send-ip", ip);
  const [accountLimit, ipLimit] = await Promise.all([
    registerRateLimitAttempt(accountKey, OTP_SEND_POLICY),
    registerRateLimitAttempt(ipKey, OTP_SEND_POLICY),
  ]);
  if (!accountLimit.allowed || !ipLimit.allowed) return generic;

  const contact = await prisma.contact.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
  });
  if (!contact) return generic;

  const code = crypto.randomInt(100000, 1000000).toString();
  await prisma.otpChallenge.create({
    data: {
      purpose: "portal",
      key: email,
      codeHash: await bcrypt.hash(code, 10),
      channel: "email",
      target: email,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  await sendEmail({
    to: email,
    subject: "Your Denago Cape Town portal code",
    text: `Your login code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.\n\nDenago Cape Town`,
  }).catch(() => {});
  return generic;
}

export async function verifyPortalOtp(
  _prev: PortalAuthState | undefined,
  formData: FormData
): Promise<PortalAuthState> {
  const email = normEmail(str(formData.get("email")));
  const code = str(formData.get("code"));
  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code." };

  const ip = await getRequestIp();
  const verifyKey = rateLimitKey("portal-otp-verify", `${email}:${ip}`);
  if (!(await checkRateLimit(verifyKey)).allowed) {
    return { error: "Too many incorrect codes. Request a new code later." };
  }

  const challenge = await prisma.otpChallenge.findFirst({
    where: { purpose: "portal", key: email, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.attempts >= 5) {
    return { error: "That code has expired — request a new one." };
  }
  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });
  if (!(await bcrypt.compare(code, challenge.codeHash))) {
    await registerRateLimitAttempt(verifyKey, OTP_VERIFY_POLICY);
    return { error: "That code isn't right — check and try again." };
  }

  const contact = await prisma.contact.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
  });
  if (!contact) return { error: "We couldn't find your account." };

  await Promise.all([
    prisma.otpChallenge.update({ where: { id: challenge.id }, data: { verifiedAt: new Date() } }),
    clearRateLimit(verifyKey),
    clearRateLimit(rateLimitKey("portal-otp-send-account", email)),
  ]);
  await setPortalCookie(contact.id, email);
  redirect("/portal");
}

export async function portalLogout() {
  await clearPortalCookie();
  redirect("/portal/login");
}

export async function requestService(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData
): Promise<{ ok?: string; error?: string }> {
  const contact = await getPortalContact();
  if (!contact) return { error: "Please sign in again." };
  const vehicleId = str(formData.get("vehicleId")) || null;
  const preferred = str(formData.get("preferred"));
  const notes = str(formData.get("notes"));

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!firstUser) return { error: "Couldn't submit right now — please phone us." };

  let vehicleLabel = "a vehicle";
  if (vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, contactId: contact.id, deletedAt: null },
    });
    if (!vehicle) return { error: "That vehicle is not available in your portal." };
    vehicleLabel = vehicle.model + (vehicle.regNumber ? ` (${vehicle.regNumber})` : "");
  }
  const due = preferred ? new Date(`${preferred}T00:00:00+02:00`) : new Date();

  await prisma.activity.create({
    data: {
      type: "todo",
      category: "workshop",
      summary: `Service request from ${contactName(contact)} — ${vehicleLabel}`,
      note: [preferred ? `Preferred date: ${preferred}` : null, notes || null].filter(Boolean).join("\n") || null,
      dueDate: due,
      status: "planned",
      contactId: contact.id,
      assignedToId: firstUser.id,
      createdById: firstUser.id,
    },
  });
  await prisma.communication.create({
    data: {
      type: "note",
      subject: "🔧 Service request (portal)",
      body: `${contactName(contact)} requested a service for ${vehicleLabel}.${preferred ? ` Preferred date: ${preferred}.` : ""}${notes ? `\n\n${notes}` : ""}`,
      contactId: contact.id,
      userId: firstUser.id,
    },
  });
  await logAudit({
    action: "portal.service_request",
    summary: `Service request from ${contactName(contact)} for ${vehicleLabel}`,
    contactId: contact.id,
    userName: "Customer portal",
  });
  await sendPushToAll(
    {
      title: "New service request",
      body: `${contactName(contact)} — ${vehicleLabel}`,
      url: `/contacts/${contact.id}`,
    },
    "service_request"
  ).catch(() => {});

  return { ok: "Thanks! We've received your request and will be in touch to confirm." };
}
