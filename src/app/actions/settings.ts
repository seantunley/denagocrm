"use server";

import { asActionResult, ActionRefusal, refuse, type ActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { basePrisma, prisma } from "@/lib/db";
import { ciExactIdFilter } from "@/lib/ciExact";
import { createSessionCookie, requireUser, requireOwner } from "@/lib/auth";
import { putSetting, getSetting } from "@/lib/settings";
import {
  WEATHER_CITIES_KEY,
  parseWeatherCities,
  serialiseWeatherCities,
  type WeatherCity,
} from "@/lib/weatherCities";
import { isManagedSecret, isRegeneratable, keepBlankSubmit } from "@/lib/settingsSecrets";
import { setNextStepScheduling } from "@/lib/nextStepConfig";
import { PUSH_KINDS } from "@/lib/push";
import { logAuditStrict } from "@/lib/audit";
import { bumpUserSessionVersion } from "@/lib/userSecurity";
import { createUserInOwnerTenant } from "@/lib/tenantContext";
import { deleteFile, saveFile } from "@/lib/storage";
import {
  detectProfileImageMime,
  isValidPhone,
  normalisePhone,
  PROFILE_IMAGE_MAX_BYTES,
} from "@/lib/profile";

// ---- Pipeline stages ----

export async function createStage(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name) refuse("Give the stage a name.");
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
  });
}

export async function renameStage(id: string, formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name) refuse("Give the stage a name.");
    await prisma.pipelineStage.update({
      where: { id },
      data: { name, color: String(formData.get("color") ?? "#64748b") },
    });
    revalidatePath("/settings");
    revalidatePath("/leads");
  });
}

export async function moveStage(id: string, direction: "up" | "down") {
  return asActionResult(async () => {
    await requireOwner();
    const stages = await prisma.pipelineStage.findMany({ orderBy: { order: "asc" } });
    const index = stages.findIndex((stage) => stage.id === id);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (index < 0) refuse("That stage no longer exists — reload the page.");
    if (swapWith < 0 || swapWith >= stages.length) refuse("That stage is already at the end.");
    await prisma.$transaction([
      prisma.pipelineStage.update({ where: { id: stages[index].id }, data: { order: stages[swapWith].order } }),
      prisma.pipelineStage.update({ where: { id: stages[swapWith].id }, data: { order: stages[index].order } }),
    ]);
    revalidatePath("/settings");
    revalidatePath("/leads");
  });
}

export async function deleteStage(id: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireOwner();
    void formData;
    const count = await prisma.lead.count({ where: { stageId: id } });
    // Silently returning here reported "Deleted" for a stage that is still in use.
    if (count > 0) refuse(`That stage still holds ${count} lead${count === 1 ? "" : "s"} — move them first.`);
    await prisma.pipelineStage.delete({ where: { id } });
    revalidatePath("/settings");
    revalidatePath("/leads");
  });
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
  // role must not block user+membership creation during a rolling deploy. Stamp the
  // tenant the membership was just created in (result.tenantId, non-null): a raw
  // insert bypasses the db.ts tenant-stamping extension, so this is the only place
  // the assignment gets labelled — without it, new rows would be NULL-tenant while
  // migration-backfilled rows carry a tenantId (and a NULL tenant defeats the
  // (tenantId,userId,roleId) unique index's dedup). Reads stay tenant-agnostic for
  // now: scoping getUserPermissions by the active tenant is the enforcement flip,
  // deferred to the staged tenant rollout (see below / accessControl.ts).
  try {
    await basePrisma.$executeRaw`
      INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId")
      VALUES (gen_random_uuid()::text, ${created.id}, 'role_sales_rep', ${result.tenantId})
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
  // Pin the cookie to the version this bump produced. Letting
  // createSessionCookie re-read means a revoke-all landing in between is undone
  // by the older request, handing back the access it just removed.
  const revokedAt = await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated, { sessionVersion: revokedAt });
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
  return asActionResult(async () => {
    await requireOwner();
    const days = String(formData.get("validDays") ?? "").trim();
    const terms = String(formData.get("terms") ?? "").trim();
    await putSetting("QUOTE_VALID_DAYS", days || "7");
    await putSetting("QUOTE_TERMS", terms);
    revalidatePath("/settings");
  });
}

export async function saveWorkshopSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const days = formData.getAll("days").map(String).join(",");
    const entries: Record<string, string> = {
      BOOKING_SLOT_TIMES: String(formData.get("times") ?? "").trim() || "08:00,10:00,12:00,14:00",
      BOOKING_DAYS: days || "1,2,3,4,5",
      BOOKING_CAPACITY: String(formData.get("capacity") ?? "1").trim() || "1",
      BOOKING_HORIZON_DAYS: String(formData.get("horizon") ?? "30").trim() || "30",
    };
    for (const [key, value] of Object.entries(entries)) {
      await putSetting(key, value);
    }
    revalidatePath("/settings");
  });
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
  // Exact (case-folded) match, not `mode: "insensitive"`. That compiled to an
  // unescaped ILIKE, which made this clash check a user-enumeration oracle: the
  // address is only regex-validated, so `a%@x.co` passes and "already in use"
  // then answers "does any staff email start with a", one character at a time.
  const existing = await prisma.user.findFirst({
    where: { AND: [await ciExactIdFilter("userEmail", email), { id: { not: user.id } }] },
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
  // Pin the cookie to the version this bump produced. Letting
  // createSessionCookie re-read means a revoke-all landing in between is undone
  // by the older request, handing back the access it just removed.
  const revokedAt = await bumpUserSessionVersion(user.id);
  await createSessionCookie(updated, { sessionVersion: revokedAt });
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
  return asActionResult(async () => {
    const user = await requireUser();
    const signatureHtml = String(formData.get("signatureHtml") ?? "").trim() || null;
    await prisma.user.update({ where: { id: user.id }, data: { signatureHtml } });
    revalidatePath("/settings");
  });
}

// ---- Integration settings ----

export async function saveSetting(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const key = String(formData.get("key") ?? "");
    const value = String(formData.get("value") ?? "").trim();
    if (!key) refuse("Nothing to save — the setting key was missing.");
    // Secret fields render blank (never echo the stored value into the DOM) and
    // pass keepIfBlank — a blank submit then means "leave the saved value alone"
    // rather than wiping it. Clearing is a separate, explicit owner action.
    // A deliberate no-op: blank means "keep the saved secret". Say that rather
    // than claim a save.
    if (keepBlankSubmit(value, Boolean(formData.get("keepIfBlank")))) {
      return { success: "Left blank — the saved value is unchanged" };
    }
    await putSetting(key, value);
    revalidatePath("/settings");
  });
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
  await requireOwner();
  void _formData;
  if (!isManagedSecret(key)) throw new Error("Not a clearable secret.");
  await putSetting(key, "");
  revalidatePath("/settings");
}

export async function regenerateSetting(key: string) {
  return asActionResult(async () => {
    await requireOwner();
    // The key is a client-supplied bound arg — only allow secrets we actually
    // generate, so this can't overwrite an externally-issued credential.
    if (!isRegeneratable(key)) throw new ActionRefusal("Not a regeneratable secret.");
    const value = crypto.randomBytes(24).toString("hex");
    await putSetting(key, value);
    revalidatePath("/settings");
  });
}

export async function saveNotificationPrefs(formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const enabled = new Set(formData.getAll("kinds").map(String));
    const disabled = PUSH_KINDS.map((kind) => kind.id).filter((id) => !enabled.has(id));
    await putSetting("PUSH_DISABLED_KINDS", disabled.join(","));
    revalidatePath("/settings");
  });
}

// ---- Clock / weather cities ----

/**
 * The cities in the dashboard clock/weather strip, per tenant.
 *
 * OWNER ONLY, and tenant-scoped twice over. `requireOwner` decides who may
 * write, and `putSetting` resolves WHICH tenant from the request scope — it
 * throws rather than guessing when there is none, so a caller cannot reach
 * another tenant's list even by direct POST.
 *
 * Validation lives in lib/weatherCities.ts and runs on the way IN as well as on
 * the way out, so a write cannot store something a read would reject. A bad
 * timezone matters more than it looks: the clock would show a confidently wrong
 * time rather than fail visibly.
 */
export async function saveWeatherCities(cities: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireOwner();

    if (!Array.isArray(cities)) refuse("Could not read that list of cities.");
    const cleaned = parseWeatherCities(serialiseWeatherCities(cities as WeatherCity[]));

    // Only refuse when something was offered and NONE of it survived. An empty
    // list is a legitimate choice — somebody may want the strip bare.
    if (cities.length > 0 && cleaned.length === 0) {
      refuse("None of those cities were valid. Check the timezone and coordinates.");
    }

    await putSetting(WEATHER_CITIES_KEY, serialiseWeatherCities(cleaned));
    // The strip renders in the (app) layout, so every signed-in page shows it.
    revalidatePath("/", "layout");
  });
}
