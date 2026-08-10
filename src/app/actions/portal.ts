"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { currentTenantScope } from "@/lib/tenantScope";
import { resolveTenantActor } from "@/lib/tenantActor";
import { sendEmail, isSmtpConfigured } from "@/lib/email";
import { getPortalContact, setPortalCookie, clearPortalCookie } from "@/lib/portal";
import { portalCanAccessVehicle, requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { sendPushToAll } from "@/lib/push";
import { logAudit } from "@/lib/audit";
import { contactName } from "@/lib/format";
import { saveFile } from "@/lib/storage";
import {
  OTP_SEND_POLICY,
  OTP_VERIFY_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";

export type PortalAuthState = { ok?: boolean; sent?: boolean; error?: string };
const str = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const normEmail = (email: string) => email.trim().toLowerCase();

/**
 * Resolve a portal contact by email — case-insensitively, but EXACTLY.
 *
 * This was `{ email: { equals, mode: "insensitive" } }`, which Prisma compiles
 * to `ILIKE` with the value bound UNESCAPED. `_` and `%` in the submitted
 * string are therefore LIKE wildcards. Confirmed against a real database: a
 * login attempt for `probe_victim@example.invalid` resolved to the contact
 * `probe.victim@example.invalid`.
 *
 * That is an account-takeover primitive, not a curiosity, because the code is
 * emailed to the SUBMITTED address while the session is minted for the MATCHED
 * contact. Register `john_smith@outlook.com` (an underscore is a legal local
 * part), request a portal code, receive it in your own inbox, enter it — and
 * you are signed in as `john.smith@outlook.com`. No prior access needed.
 *
 * Backslash-escaping the metacharacters does not fix it; I tested that, and the
 * escape does not survive Prisma's ILIKE. So the comparison has to stop being a
 * LIKE at all. LOWER() rather than a plain `=` because production has a contact
 * whose stored address is mixed-case, and they must keep being able to log in.
 *
 * ORDER BY is deterministic so that two contacts differing only in case can
 * never resolve to different rows on the request and verify legs of one login.
 *
 * Runs on `basePrisma`, the explicit trusted/bypass client, NOT on `prisma`.
 * The scoped client's extension only intercepts MODEL operations, so a raw query
 * issued through it never gets its `SET LOCAL app.current_tenant` /
 * `app.bypass_rls` — it works today only because the application role still has
 * rolbypassrls, and would return zero rows (breaking portal login outright)
 * under the restricted role the RLS work is heading for. basePrisma sets
 * app.bypass_rls explicitly, which is the correct posture for a PRE-auth lookup
 * that cannot have a tenant scope yet and pins the tenant in its own WHERE.
 */
async function findPortalContactByEmail(email: string): Promise<{ id: string } | null> {
  const rows = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Contact"
    WHERE LOWER("email") = ${email}
      AND "deletedAt" IS NULL
      AND "tenantId" = ${DEFAULT_TENANT_ID}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
const MAX_UPLOAD = 10 * 1024 * 1024;
const ALLOWED_UPLOADS = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"]);

async function firstStaffUser() {
  return resolveTenantActor();
}

async function createPortalNotification(contactId: string, title: string, body: string, href?: string, kind = "info") {
  // Every caller resolves getPortalContact()/requirePortalScope() first, which —
  // under enforcement — enters the contact's tenant scope; ambient here matches
  // audit.ts's actingTenantId non-user branch. Null when not enforcing (today).
  const tenantId = currentTenantScope()?.tenantId ?? null;
  await basePrisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id", "tenantId", "contactId", "title", "body", "href", "kind")
    VALUES (${crypto.randomUUID()}, ${tenantId}, ${contactId}, ${title}, ${body}, ${href ?? null}, ${kind})
  `;
}

/** Step 1: email a 6-digit login code to a known customer. */
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

  const contact = await findPortalContactByEmail(email);
  if (!contact) return generic;

  const code = crypto.randomInt(100000, 1000000).toString();
  const codeHash = await bcrypt.hash(code, 10);
  // Invalidate every prior unverified code for this email BEFORE issuing the new
  // one, in one transaction serialized by a per-key advisory lock. Verification
  // picks the newest unverified challenge, so without this an older still-
  // unexpired code stayed usable after a newer one was consumed. The advisory
  // lock stops two concurrent reissues from each expiring the visible codes and
  // then inserting a new one — which would leave TWO valid codes.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:portal:${email}`})::bigint)`;
    await tx.otpChallenge.updateMany({
      where: { purpose: "portal", key: email, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
    await tx.otpChallenge.create({
      data: {
        purpose: "portal",
        key: email,
        codeHash,
        channel: "email",
        target: email,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
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

  const ip = await getRequestIp();
  const verifyKey = rateLimitKey("portal-otp-verify", `${email}:${ip}`);
  if (!(await checkRateLimit(verifyKey)).allowed) {
    return { error: "Too many incorrect codes. Request a new code later." };
  }

  const challenge = await prisma.otpChallenge.findFirst({
    where: { purpose: "portal", key: email, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) return { error: "That code has expired — request a new one." };

  // Atomically consume one attempt: only succeeds while unverified and under the
  // cap, so concurrent requests can't each pass the read-gate and brute-force
  // past 5 guesses.
  const gate = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, verifiedAt: null, attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  });
  if (gate.count !== 1) return { error: "That code has expired — request a new one." };
  if (!(await bcrypt.compare(code, challenge.codeHash))) {
    await registerRateLimitAttempt(verifyKey, OTP_VERIFY_POLICY);
    return { error: "That code isn't right — check and try again." };
  }

  const contact = await findPortalContactByEmail(email);
  if (!contact) return { error: "We couldn't find your account." };

  // Atomically CONSUME the challenge before creating any session: only the
  // request that flips verifiedAt (from null, still unexpired) may sign in. Two
  // concurrent correct submissions both pass bcrypt, but only one wins the claim
  // — the loser is turned away instead of also minting a portal session.
  const consumed = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, verifiedAt: null, expiresAt: { gt: new Date() } },
    data: { verifiedAt: new Date() },
  });
  if (consumed.count !== 1) return { error: "That code has expired — request a new one." };
  await Promise.all([
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

/** Customer service booking; vehicle ownership is verified server-side. */
export async function requestService(
  _prev: { ok?: string; error?: string } | undefined,
  formData: FormData
): Promise<{ ok?: string; error?: string }> {
  // Service booking is automotive-owned. The page hides the form when the pack
  // is off, but a stale open page could still POST — the action must self-reject.
  if (!(await isModuleEnabled("automotive"))) return { error: "Service booking is not available." };
  const contact = await getPortalContact();
  if (!contact) return { error: "Please sign in again." };
  const vehicleId = str(formData.get("vehicleId")) || null;
  const preferred = str(formData.get("preferred"));
  const notes = str(formData.get("notes"));

  if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) return { error: "That vehicle is not available in your portal." };
  const staff = await firstStaffUser();
  if (!staff) return { error: "Couldn't submit right now — please phone us." };

  let vehicleLabel = "a vehicle";
  if (vehicleId) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (vehicle) vehicleLabel = vehicle.model + (vehicle.regNumber ? ` (${vehicle.regNumber})` : "");
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
      assignedToId: staff.id,
      createdById: staff.id,
    },
  });
  await prisma.communication.create({
    data: {
      type: "note",
      subject: "🔧 Service request (portal)",
      body: `${contactName(contact)} requested a service for ${vehicleLabel}.${preferred ? ` Preferred date: ${preferred}.` : ""}${notes ? `\n\n${notes}` : ""}`,
      contactId: contact.id,
      userId: staff.id,
    },
  });
  await createPortalNotification(contact.id, "Service request received", `We received your service request for ${vehicleLabel}.`, "/portal#cases", "service");
  await logAudit({ action: "portal.service_request", summary: `Service request from ${contactName(contact)} for ${vehicleLabel}`, contactId: contact.id, userName: "Customer portal" });
  await sendPushToAll({ title: "New service request", body: `${contactName(contact)} — ${vehicleLabel}`, url: `/contacts/${contact.id}` }, "service_request").catch(() => {});
  revalidatePath("/portal");
  return { ok: "Thanks! We've received your request and will be in touch to confirm." };
}

export async function submitPortalCase(formData: FormData) {
  const scope = await requirePortalScope();
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const subject = str(formData.get("subject"));
  const description = str(formData.get("description"));
  const type = str(formData.get("type")) || "support";
  const vehicleId = str(formData.get("vehicleId")) || null;
  if (!subject || !description) throw new Error("Subject and description are required");
  if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) throw new Error("Vehicle access denied");

  const id = crypto.randomUUID();
  const tenantId = currentTenantScope()?.tenantId ?? null;
  await basePrisma.$executeRaw`
    INSERT INTO "CustomerCase" ("id", "tenantId", "subject", "description", "type", "contactId", "vehicleId")
    VALUES (${id}, ${tenantId}, ${subject}, ${description}, ${type}, ${scope.viewerContactId}, ${vehicleId})
  `;
  await createPortalNotification(scope.viewerContactId, "Support request created", subject, "/portal#cases", "case");
  await logAudit({ action: "portal.case_created", summary: `Portal case created: ${subject}`, contactId: scope.viewerContactId, entityType: "CustomerCase", entityId: id, userName: "Customer portal" });
  await sendPushToAll({ title: "New portal support case", body: `${contactName(contact)} — ${subject}`, url: `/contacts/${contact.id}` }, "portal_case").catch(() => {});
  revalidatePath("/portal");
}

export async function submitPortalWarrantyClaim(formData: FormData) {
  const scope = await requirePortalScope();
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");
  const vehicleId = str(formData.get("vehicleId"));
  const description = str(formData.get("description"));
  if (!vehicleId || !description) throw new Error("Vehicle and description are required");
  if (!(await portalCanAccessVehicle(vehicleId))) throw new Error("Vehicle access denied");

  const claim = await prisma.warrantyClaim.create({
    data: { vehicleId, contactId: scope.viewerContactId, description, createdById: null },
  });
  const caseId = crypto.randomUUID();
  const tenantId = currentTenantScope()?.tenantId ?? null;
  await basePrisma.$executeRaw`
    INSERT INTO "CustomerCase" ("id", "tenantId", "subject", "description", "type", "priority", "contactId", "vehicleId", "warrantyClaimId")
    VALUES (${caseId}, ${tenantId}, ${"Warranty claim"}, ${description}, ${"warranty"}, ${"high"}, ${scope.viewerContactId}, ${vehicleId}, ${claim.id})
  `;
  await createPortalNotification(scope.viewerContactId, "Warranty claim submitted", "Your warranty request has been sent to our team.", "/portal#cases", "warranty");
  await logAudit({ action: "portal.warranty_claim_created", summary: "Warranty claim submitted through portal", contactId: scope.viewerContactId, entityType: "WarrantyClaim", entityId: claim.id, userName: "Customer portal" });
  await sendPushToAll({ title: "New warranty claim", body: `${contactName(contact)} submitted a warranty claim`, url: `/vehicles/${vehicleId}` }, "warranty").catch(() => {});
  revalidatePath("/portal");
}

export async function requestPortalProfileChange(formData: FormData) {
  const scope = await requirePortalScope();
  const changes = {
    phone: str(formData.get("phone")) || null,
    whatsapp: str(formData.get("whatsapp")) || null,
    address: str(formData.get("address")) || null,
    suburb: str(formData.get("suburb")) || null,
    city: str(formData.get("city")) || null,
    province: str(formData.get("province")) || null,
    postalCode: str(formData.get("postalCode")) || null,
  };
  const note = str(formData.get("note")) || null;
  const id = crypto.randomUUID();
  const tenantId = currentTenantScope()?.tenantId ?? null;
  await basePrisma.$executeRaw`
    INSERT INTO "PortalProfileChangeRequest" ("id", "tenantId", "contactId", "changes", "note")
    VALUES (${id}, ${tenantId}, ${scope.viewerContactId}, ${JSON.stringify(changes)}::jsonb, ${note})
  `;
  await createPortalNotification(scope.viewerContactId, "Profile update requested", "We received your profile and address changes.", "/portal#profile", "profile");
  await logAudit({ action: "portal.profile_change_requested", summary: "Customer requested profile changes", contactId: scope.viewerContactId, entityType: "PortalProfileChangeRequest", entityId: id, after: changes, userName: "Customer portal" });
  revalidatePath("/portal");
}

export async function updatePortalPreferences(formData: FormData) {
  const scope = await requirePortalScope();
  const emailServiceUpdates = formData.get("emailServiceUpdates") === "on";
  const smsServiceUpdates = formData.get("smsServiceUpdates") === "on";
  const emailMarketing = formData.get("emailMarketing") === "on";

  // A portal request is a CUSTOMER, not a staff session, so there is no acting
  // workspace to resolve — getActiveTenantId() would be null here and the
  // founding-tenant fallback would file another tenant's customer's consent
  // against tenant A. The Contact already knows who owns it, and that is the
  // only tenant this write can legitimately belong to.
  const owner = await basePrisma.contact.findUnique({
    where: { id: scope.viewerContactId },
    select: { tenantId: true },
  });
  const tenantId = currentTenantScope()?.tenantId ?? owner?.tenantId ?? null;
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "PortalPreference" ("contactId", "tenantId", "emailServiceUpdates", "smsServiceUpdates", "emailMarketing", "updatedAt")
      VALUES (${scope.viewerContactId}, ${tenantId}, ${emailServiceUpdates}, ${smsServiceUpdates}, ${emailMarketing}, CURRENT_TIMESTAMP)
      ON CONFLICT ("contactId") DO UPDATE SET
        "emailServiceUpdates" = EXCLUDED."emailServiceUpdates",
        "smsServiceUpdates" = EXCLUDED."smsServiceUpdates",
        "emailMarketing" = EXCLUDED."emailMarketing",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
    await tx.contact.update({ where: { id: scope.viewerContactId }, data: { marketingOptOut: !emailMarketing } });
    await tx.consentRecord.create({ data: { tenantId: tenantId ?? DEFAULT_TENANT_ID, contactId: scope.viewerContactId, type: "marketing", granted: emailMarketing, source: "portal", note: "Updated in customer portal" } });
  });
  await logAudit({ action: "portal.preferences_updated", summary: "Customer updated portal communication preferences", contactId: scope.viewerContactId, after: { emailServiceUpdates, smsServiceUpdates, emailMarketing }, userName: "Customer portal" });
  revalidatePath("/portal");
}

export async function uploadPortalDocument(formData: FormData) {
  const scope = await requirePortalScope();
  const vehicleId = str(formData.get("vehicleId")) || null;
  if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) throw new Error("Vehicle access denied");
  const value = formData.get("file");
  if (!(value instanceof File) || value.size === 0) throw new Error("Choose a file");
  if (value.size > MAX_UPLOAD) throw new Error("File is too large");
  if (!ALLOWED_UPLOADS.has(value.type)) throw new Error("Unsupported file type");

  const staff = await firstStaffUser();
  if (!staff) throw new Error("No staff account is available to file the document");
  const buffer = Buffer.from(await value.arrayBuffer());
  const storedName = await saveFile(buffer, value.name, value.type);
  const doc = await prisma.document.create({
    data: {
      fileName: value.name,
      storedName,
      mimeType: value.type,
      sizeBytes: value.size,
      contactId: scope.viewerContactId,
      vehicleId,
      tag: "portal-upload",
      uploadedById: staff.id,
    },
  });
  await createPortalNotification(scope.viewerContactId, "Document uploaded", `${value.name} was uploaded securely.`, "/portal#documents", "document");
  await logAudit({ action: "portal.document_uploaded", summary: `Customer uploaded ${value.name}`, contactId: scope.viewerContactId, entityType: "Document", entityId: doc.id, userName: "Customer portal", metadata: { mimeType: value.type, sizeBytes: value.size } });
  revalidatePath("/portal");
}

export async function markPortalNotificationRead(id: string, formData: FormData) {
  void formData;
  const scope = await requirePortalScope();
  await basePrisma.$executeRaw`
    UPDATE "PortalNotification" SET "readAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "contactId" = ${scope.viewerContactId}
  `;
  revalidatePath("/portal");
}
