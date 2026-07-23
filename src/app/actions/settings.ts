"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { basePrisma, prisma } from "@/lib/db";
import { createSessionCookie, requireUser, requireOwner } from "@/lib/auth";
import { putSetting, getSetting } from "@/lib/settings";
import { isManagedSecret, isRegeneratable, keepBlankSubmit } from "@/lib/settingsSecrets";
import { setNextStepScheduling } from "@/lib/nextStepConfig";
import { PUSH_KINDS } from "@/lib/push";
import { logAuditStrict } from "@/lib/audit";
import { bumpUserSessionVersion } from "@/lib/userSecurity";
import { createUserInOwnerTenant } from "@/lib/tenantContext";
import { deleteFile, saveFile } from "@/lib/storage";
import { clearTenantEmailProviderSecret } from "@/lib/emailProviderConfig";
import {
  detectProfileImageMime,
  isValidPhone,
  normalisePhone,
  PROFILE_IMAGE_MAX_BYTES,
} from "@/lib/profile";

// ---- Pipeline stages ----

export async function createStage(formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const max = await prisma.pipelineStage.aggregate({ _max: { order: true } });
  await prisma.pipelineStage.create({
    data: {
      name,
      color: String(formData.get("color") ?? "#64748b"),
      order: (max._max.order ?? -1) + 1,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function renameStage(id: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.pipelineStage.update({
    where: { id },
    data: { name, color: String(formData.get("color") ?? "#64748b") },
  });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function moveStage(id: string, direction: "up" | "down") {
  await requireOwner();
  const stages = await prisma.pipelineStage.findMany({ orderBy: { order: "asc" } });
  const index = stages.findIndex((stage) => stage.id === id);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= stages.length) return;
  await prisma.$transaction([
    prisma.pipelineStage.update({ where: { id: stages[index].id }, data: { order: stages[swapWith].order } }),
    prisma.pipelineStage.update({ where: { id: stages[swapWith].id }, data: { order: stages[index].order } }),
  ]);
  revalidatePath("/settings");
  revalidatePath("/leads");
}

export async function deleteStage(id: string, formData: FormData): Promise<void> {
  await requireOwner();
  void formData;
  const count = await prisma.lead.count({ where: { stageId: id } });
  if (count > 0) return;
  await prisma.pipelineStage.delete({ where: { id } });
  revalidatePath("/settings");
  revalidatePath("/leads");
}

// ---- Users ----

export type FormState = { error?: string; ok?: string };

function validPassword(password: string): boolean {
  return password.length >= 12 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export async function createUser(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  const owner = await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!name || !email || !validPassword(password)) {
    return { error: "Name, email and a password of at least 12 characters containing letters and numbers are required." };
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { error: "A user with that email already exists." };

  // Tenant provisioning (fail-closed): the new user MUST land in a validated tenant
  // — the owner's CURRENT tenant. createUserInOwnerTenant resolves + LOCKS that
  // tenant inside the write (FOR UPDATE), so suspension/removal of THAT tenant or
  // membership can't race it, and creates the user + membership together (never
  // tenantless). Zero or multiple active tenants is refused, not guessed.
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await createUserInOwnerTenant(owner.id, { name, email, passwordHash });
  if ("error" in result) {
    return {
      error:
        result.error === "ambiguous_tenant"
          ? "You belong to more than one tenant, and tenant selection isn't available yet — new users can't be added until it is."
          : result.error === "context_changed"
            ? "Your tenant changed while adding the user — please try again."
            : result.error === "duplicate_email"
              ? "A user with that email already exists."
              : "Your account isn't linked to an active tenant — contact support before adding users.",
    };
  }
  const created = result.user;
  // Initial RBAC role — best-effort, OUTSIDE the tenant tx (see PR notes): a missing
  // role must not block user+membership creation during a rolling deploy.
  try {
    await basePrisma.$executeRaw`
      INSERT INTO "UserRole" ("userId", "roleId")
      VALUES (${created.id}, 'role_sales_rep')
      ON CONFLICT DO NOTHING
    `;
  } catch {
    // Safe during a rolling deployment before the RBAC migration is applied.
  }
  await logAuditStrict({
    action: "security.user_created",
    summary: `Created user ${name}`,
    entityType: "User",
    entityId: created.id,
    user: owner,
    // Audit the tenant ACTUALLY used (returned from the locked transaction).
    after: { name, email, role: "member", initialRbacRole: "role_sales_rep", tenantId: result.tenantId },
  });
  revalidatePath("/settings");
  revalidatePath("/settings/access");
  return { ok: `${name} added to the team.` };
}

export async function changeOwnPassword(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  const user = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  if (!validPassword(next)) {
    return { error: "New password must be at least 12 characters and contain letters and numbers." };
  }
  if (await bcrypt.compare(next, user.passwordHash)) {
    return { error: "Choose a password different from your current password." };
  }
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return { error: "Current password is incorrect." };
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(next, 12), passwordChangedAt: new Date() },
  });
  await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated);
  await logAuditStrict({
    action: "security.password_changed",
    summary: "Password changed; all other sessions revoked",
    entityType: "User",
    entityId: user.id,
    user,
  });
  revalidatePath("/settings");
  return { ok: "Password updated. Other signed-in devices have been signed out." };
}

export async function saveQuoteDefaults(formData: FormData) {
  await requireOwner();
  const days = String(formData.get("validDays") ?? "").trim();
  const terms = String(formData.get("terms") ?? "").trim();
  await prisma.appSetting.upsert({ where: { key: "QUOTE_VALID_DAYS" }, update: { value: days || "7" }, create: { key: "QUOTE_VALID_DAYS", value: days || "7" } });
  await prisma.appSetting.upsert({ where: { key: "QUOTE_TERMS" }, update: { value: terms }, create: { key: "QUOTE_TERMS", value: terms } });
  revalidatePath("/settings");
}

export async function saveWorkshopSettings(formData: FormData) {
  await requireOwner();
  const days = formData.getAll("days").map(String).join(",");
  const entries: Record<string, string> = {
    BOOKING_SLOT_TIMES: String(formData.get("times") ?? "").trim() || "08:00,10:00,12:00,14:00",
    BOOKING_DAYS: days || "1,2,3,4,5",
    BOOKING_CAPACITY: String(formData.get("capacity") ?? "1").trim() || "1",
    BOOKING_HORIZON_DAYS: String(formData.get("horizon") ?? "30").trim() || "30",
  };
  for (const [key, value] of Object.entries(entries)) {
    await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  revalidatePath("/settings");
}

export async function saveNextStepScheduling(formData: FormData) {
  await requireOwner();
  const hour = parseInt(String(formData.get("hour") ?? ""), 10);
  // An unchecked checkbox submits nothing, so absence means "don't skip".
  const skipWeekends = formData.get("skipWeekends") != null;
  await setNextStepScheduling({ hour, skipWeekends });
  revalidatePath("/automations");
  revalidatePath("/settings");
}

export async function updateOwnProfile(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  const jobTitle = String(formData.get("jobTitle") ?? "").trim().replace(/\s+/g, " ") || null;
  const mobile = normalisePhone(String(formData.get("mobile") ?? ""));

  if (name.length < 2 || name.length > 100) {
    return { error: "Enter a name between 2 and 100 characters." };
  }
  if (jobTitle && jobTitle.length > 100) {
    return { error: "Job title must be 100 characters or fewer." };
  }
  if (mobile && !isValidPhone(mobile)) {
    return { error: "Enter a valid phone number, including its country code where possible." };
  }

  await prisma.user.update({ where: { id: user.id }, data: { name, jobTitle, mobile } });
  await logAuditStrict({
    action: "account.profile_updated",
    summary: "Updated personal profile",
    entityType: "User",
    entityId: user.id,
    user,
    before: { name: user.name, jobTitle: user.jobTitle, mobile: user.mobile },
    after: { name, jobTitle, mobile },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: "Profile updated." };
}

export async function updateOwnEmail(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const currentPassword = String(formData.get("currentPassword") ?? "");

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return { error: "Current password is incorrect." };
  }
  if (email === user.email.toLowerCase()) {
    return { ok: "Your sign-in email is already up to date." };
  }
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, id: { not: user.id } },
    select: { id: true },
  });
  if (existing) return { error: "That email address is already in use." };

  let updated;
  try {
    updated = await prisma.user.update({ where: { id: user.id }, data: { email } });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return { error: "That email address is already in use." };
    }
    throw error;
  }
  await logAuditStrict({
    action: "security.email_changed",
    summary: "Changed account sign-in email",
    entityType: "User",
    entityId: user.id,
    user,
    before: { email: user.email },
    after: { email },
  });
  await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated);
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: "Email updated. Other signed-in devices have been signed out." };
}

export async function updateOwnAvatar(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const upload = formData.get("avatar");
  if (!(upload instanceof File) || upload.size === 0) {
    return { error: "Choose a JPG, PNG or WebP image." };
  }
  if (upload.size > PROFILE_IMAGE_MAX_BYTES) {
    return { error: "Profile photos must be 3 MB or smaller." };
  }

  const buffer = Buffer.from(await upload.arrayBuffer());
  const mimeType = detectProfileImageMime(buffer);
  if (!mimeType) {
    return { error: "That file is not a supported JPG, PNG or WebP image." };
  }
  const extension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : ".webp";
  const nextRef = await saveFile(buffer, `profile${extension}`, mimeType);
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarRef: nextRef, avatarMimeType: mimeType, avatarUpdatedAt: new Date() },
    });
  } catch (error) {
    await deleteFile(nextRef).catch(() => {});
    throw error;
  }
  await logAuditStrict({
    action: "account.photo_updated",
    summary: "Updated profile photo",
    entityType: "User",
    entityId: user.id,
    user,
  });
  if (user.avatarRef) {
    await deleteFile(user.avatarRef).catch((error) => console.warn("Unable to remove previous profile photo", error));
  }
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: "Profile photo updated." };
}

export async function removeOwnAvatar(
  _prev: FormState | undefined,
  _formData: FormData,
): Promise<FormState> {
  void _prev;
  void _formData;
  const user = await requireUser();
  if (!user.avatarRef) return { ok: "No profile photo to remove." };
  const previousRef = user.avatarRef;
  await prisma.user.update({
    where: { id: user.id },
    data: { avatarRef: null, avatarMimeType: null, avatarUpdatedAt: new Date() },
  });
  await logAuditStrict({
    action: "account.photo_removed",
    summary: "Removed profile photo",
    entityType: "User",
    entityId: user.id,
    user,
  });
  await deleteFile(previousRef).catch((error) => console.warn("Unable to delete profile photo", error));
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: "Profile photo removed." };
}

export async function saveMyProfile(formData: FormData) {
  const user = await requireUser();
  const signatureHtml = String(formData.get("signatureHtml") ?? "").trim() || null;
  await prisma.user.update({ where: { id: user.id }, data: { signatureHtml } });
  revalidatePath("/settings");
}

// ---- Integration settings ----

export async function saveSetting(formData: FormData) {
  await requireOwner();
  const key = String(formData.get("key") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!key) return;
  // Secret fields render blank (never echo the stored value into the DOM) and
  // pass keepIfBlank — a blank submit then means "leave the saved value alone"
  // rather than wiping it. Clearing is a separate, explicit owner action.
  if (keepBlankSubmit(value, Boolean(formData.get("keepIfBlank")))) return;
  await putSetting(key, value);
  revalidatePath("/settings");
}

/** Reveal a stored secret to the owner on demand — so the value is NEVER in the
 *  initial server-rendered page, only fetched by an explicit owner action. */
export async function revealSecret(key: string): Promise<string> {
  await requireOwner();
  if (!isManagedSecret(key)) throw new Error("Not a revealable secret.");
  return (await getSetting(key)) ?? "";
}

/** Explicitly clear a secret (disconnect an integration / remove a compromised
 *  key). Owner-only, and the key is allowlisted — a server action's bound arg
 *  comes from the client, so we must not delete an arbitrary AppSetting. */
export async function clearSecret(key: string, _formData?: FormData): Promise<void> {
  const user = await requireOwner();
  void _formData;
  if (!isManagedSecret(key)) throw new Error("Not a clearable secret.");
  if (key === "SENDGRID_API_KEY" || key === "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY") {
    await clearTenantEmailProviderSecret(user.id, key);
  } else {
    await putSetting(key, "");
  }
  revalidatePath("/settings");
}

export async function regenerateSetting(key: string) {
  await requireOwner();
  // The key is a client-supplied bound arg — only allow secrets we actually
  // generate, so this can't overwrite an externally-issued credential.
  if (!isRegeneratable(key)) throw new Error("Not a regeneratable secret.");
  const value = crypto.randomBytes(24).toString("hex");
  await putSetting(key, value);
  revalidatePath("/settings");
}

export async function saveNotificationPrefs(formData: FormData) {
  await requireOwner();
  const enabled = new Set(formData.getAll("kinds").map(String));
  const disabled = PUSH_KINDS.map((kind) => kind.id).filter((id) => !enabled.has(id));
  await putSetting("PUSH_DISABLED_KINDS", disabled.join(","));
  revalidatePath("/settings");
}
