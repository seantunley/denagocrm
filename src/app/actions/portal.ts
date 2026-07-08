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

export type PortalAuthState = { ok?: boolean; sent?: boolean; error?: string };
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const normEmail = (e: string) => e.trim().toLowerCase();

/** Step 1: email a 6-digit login code to a known customer. */
export async function requestPortalOtp(
  _prev: PortalAuthState | undefined,
  formData: FormData
): Promise<PortalAuthState> {
  const email = normEmail(str(formData.get("email")));
  if (!email || !email.includes("@")) return { error: "Enter your email address." };
  if (!(await isSmtpConfigured())) return { error: "The customer portal isn't available right now." };

  // Generic response either way — don't reveal whether an email is on file.
  const generic: PortalAuthState = { sent: true };

  const recent = await prisma.otpChallenge.count({
    where: { purpose: "portal", key: email, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  if (recent >= 5) return generic;

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

/** Step 2: verify the code and open a portal session. */
export async function verifyPortalOtp(
  _prev: PortalAuthState | undefined,
  formData: FormData
): Promise<PortalAuthState> {
  const email = normEmail(str(formData.get("email")));
  const code = str(formData.get("code"));
  if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code." };

  const challenge = await prisma.otpChallenge.findFirst({
    where: { purpose: "portal", key: email, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.attempts >= 5) {
    return { error: "That code has expired — request a new one." };
  }
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
  if (!(await bcrypt.compare(code, challenge.codeHash))) {
    return { error: "That code isn't right — check and try again." };
  }
  const contact = await prisma.contact.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
  });
  if (!contact) return { error: "We couldn't find your account." };

  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { verifiedAt: new Date() } });
  await setPortalCookie(contact.id, email);
  redirect("/portal");
}

export async function portalLogout() {
  await clearPortalCookie();
  redirect("/portal/login");
}

/** A customer requests a service booking from inside the portal. */
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
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (v) vehicleLabel = v.model + (v.regNumber ? ` (${v.regNumber})` : "");
  }
  const due = preferred ? new Date(`${preferred}T00:00:00+02:00`) : new Date();

  await prisma.activity.create({
    data: {
      type: "todo",
      category: "workshop",
      summary: `Service request from ${contactName(contact)} — ${vehicleLabel}`,
      note: [preferred ? `Preferred date: ${preferred}` : null, notes || null]
        .filter(Boolean)
        .join("\n") || null,
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
      body: `${contactName(contact)} requested a service for ${vehicleLabel}.${
        preferred ? ` Preferred date: ${preferred}.` : ""
      }${notes ? `\n\n${notes}` : ""}`,
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
