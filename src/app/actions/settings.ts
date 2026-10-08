"use server";

import { asActionResult, ActionRefusal, refuse, type ActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { validPassword } from "@/lib/passwordPolicy";
import crypto from "crypto";
import { basePrisma, prisma } from "@/lib/db";
import { ciExactIdFilter } from "@/lib/ciExact";
import { createSessionCookie, getActiveTenantId, requireUser, requireTenantOwner } from "@/lib/auth";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import {
  findOwnedPipelineForStage,
  getDefaultPipeline,
  reorderPipelineStages,
  requireOwnedPipeline,
} from "@/lib/pipelines";
import { stageTenantId, UNREACHABLE_STAGE_MESSAGE } from "@/lib/pipelineTenantRule";
import { putSetting, getSetting, getRegionalSettings, REGIONAL_KEYS } from "@/lib/settings";
import { regionalFrom } from "@/lib/format";
import { quoteValidDays } from "@/lib/quoteExpiry";
import {
  WEATHER_CITIES_KEY,
  parseWeatherCities,
  serialiseWeatherCities,
  type WeatherCity,
} from "@/lib/weatherCities";
import {
  ACTIVITY_TYPES_KEY,
  isSystemActivityType,
  resolveActivityTypes,
  serialiseActivityTypes,
  SYSTEM_ACTIVITY_TYPES,
  type ActivityType,
} from "@/lib/activityTypes";
import { isManagedSecret, isRegeneratable, keepBlankSubmit } from "@/lib/settingsSecrets";
import { keyNamesAnInboundEndpoint, reconcileTenantChannels } from "@/lib/channelRegistration";
import { setNextStepScheduling } from "@/lib/nextStepConfig";
import { PUSH_KINDS } from "@/lib/push";
import { logAuditStrict } from "@/lib/audit";
import { bumpUserSessionVersion } from "@/lib/userSecurity";
import { createUserInOwnerTenant } from "@/lib/tenantContext";
import { deleteFile, saveFile } from "@/lib/storage";
import { withActingStaffScope } from "@/lib/actingScope";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { LEAD_ROUTING_KEY, parseLeadRoutingConfig, routingCandidateIds } from "@/lib/leadRouting";
import {
  detectProfileImageMime,
  isValidPhone,
  normalisePhone,
  PROFILE_IMAGE_MAX_BYTES,
} from "@/lib/profile";

// ---- Pipeline stages ----

/**
 * A stage cannot exist outside a pipeline.
 *
 * `PipelineStage."pipelineId"` is NOT NULL with no default — migration
 * 52_pipelines_forecasting_rbac_audit adds it nullable, backfills every existing
 * row to 'pipeline_default_retail' and then SETs NOT NULL. The create this
 * replaces supplied no `pipelineId` at all, so every "Add stage" submission on
 * this screen failed with a not-null violation. It could not have supplied one
 * either: the column was never declared on the Prisma model, so there was no
 * field to pass. That is fixed in prisma/schema.prisma in the same change.
 *
 * WHICH pipeline is not a new rule invented here — `getDefaultPipeline()` is the
 * existing active/default choice (`isDefault DESC, createdAt ASC`, active and
 * undeleted), the same one the leads board and forecast already resolve.
 */
export async function createStage(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name) refuse("Give the stage a name.");

    const pipeline = await getDefaultPipeline();
    if (!pipeline) {
      refuse("There is no active sales pipeline to add this stage to — create one under Settings › Pipeline first.");
    }
    // The OWNER of that pipeline. `SalesPipelineRow` does not carry `tenantId`, so
    // it takes a second read — and that read goes THROUGH the boundary, not beside
    // it. This is #457's `requireOwnedPipeline()`, the same gate `addPipelineStage`
    // and `reorderPipelineStages` use, returning the id and the owning tenant from
    // one scoped query.
    //
    // `getDefaultPipeline()` above is itself tenant-scoped as of #457, so an
    // unscoped re-read by that id would in fact only ever return a row this
    // workspace can already see. But that is an argument about where the id came
    // from, and it stops holding the moment anyone passes an id in. The gate makes
    // it structural instead. It is also strictly weaker than the query that
    // produced the id — same scope, no `active = true` — so it can only refuse if
    // the pipeline was archived in between, which is a real race and correctly loud.
    const owner = await requireOwnedPipeline(pipeline.id);

    // Next `order` WITHIN THE PIPELINE, because the unique index is
    // ("pipelineId", "order") — a global max would leave gaps that grow with
    // every other pipeline's stages. Read on `basePrisma` and bounded by
    // `pipelineId`: the parent is the boundary here, and a guarded read scoped to
    // the ACTING tenant would return nothing (hence order 0, hence a duplicate-key
    // collision) whenever the actor's workspace is not the pipeline's.
    const max = await basePrisma.pipelineStage.aggregate({
      where: { pipelineId: pipeline.id },
      _max: { order: true },
    });

    // The stage takes its PARENT PIPELINE's tenant, never the acting user's —
    // PR #457's rule, reused verbatim rather than restated. The write goes through
    // `basePrisma` for that reason: under enforcement the guarded client's
    // stampCreate() overwrites `data.tenantId` with the ACTING scope (see
    // tenantGuard.ts), which is exactly the answer this must not produce.
    await basePrisma.pipelineStage.create({
      data: {
        name,
        color: String(formData.get("color") ?? "#64748b"),
        order: (max._max.order ?? -1) + 1,
        pipelineId: pipeline.id,
        tenantId: stageTenantId({
          pipelineTenantId: owner.tenantId,
          // Ignored by design — passed so the wrong answer stays expressible and a
          // test can prove it is not the one chosen. `getActiveTenantId()` is null
          // for sessions minted before the `tid` claim existed, which is equally
          // irrelevant for the same reason.
          actingTenantId: (await getActiveTenantId()) ?? "",
        }),
      },
    });
    revalidatePath("/settings");
    revalidatePath("/leads");
  });
}

export async function renameStage(id: string, formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
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

/**
 * Reorder one stage against its neighbour.
 *
 * The two-statement `order` swap this replaces COULD NOT SUCCEED. `order` is
 * unique per pipeline — "PipelineStage_pipelineId_order_key", a plain
 * `CREATE UNIQUE INDEX` from migration 52, therefore NOT DEFERRABLE — so the
 * first UPDATE inside the transaction put two rows of the same pipeline on the
 * same order value and Postgres raised a duplicate-key violation right there.
 * Being inside one `$transaction` does not help: only a DEFERRABLE constraint
 * postpones the check to COMMIT, and an index-backed unique cannot be deferred.
 * That is precisely why `reorderPipelineStages()` parks the whole list at
 * 1000+i and only then places it at i — two passes, never a transient collision.
 * So: delegate to it, exactly as the sibling `moveStage` in
 * src/app/actions/pipelines.ts already does, instead of keeping a second and
 * broken copy of the same manoeuvre.
 *
 * It also swapped against the wrong neighbour. Reading EVERY stage ordered by
 * `order` mixes pipelines, so with more than one pipeline the "neighbour" could
 * belong to a different process entirely. The list is now bounded to the moving
 * stage's own pipeline — which the model can finally express, because
 * `pipelineId` is declared on it as of this change.
 */
export async function moveStage(id: string, direction: "up" | "down") {
  return asActionResult(async () => {
    await requireTenantOwner();
    // THE LOOKUP AND THE GATE ARE ONE STATEMENT. THAT IS THE WHOLE FIX.
    //
    // `reorderPipelineStages()` already refuses a pipeline this workspace does not
    // own (#457), so the WRITE below was never at risk. Everything upstream of it
    // was: `id` is a bound server-action argument, which is a POST parameter and
    // therefore forgeable, and the reads around it run on `basePrisma` — the
    // documented RLS bypass — so a stage id belonging to another workspace returned
    // that workspace's entire ordered stage list and the refusals below reported the
    // stage's POSITION in it ("already at the end") before anything checked
    // ownership. #466 closed that by putting the gate here, above the list.
    //
    // What #466 left, and #458's sweep then named, is one bit finer. The lookup was
    // still an unscoped `findUnique` by that forgeable id, sitting BEFORE the gate,
    // and the comment that used to stand here argued it was contained because
    // "nothing read from a row outside the boundary reaches the caller, the
    // response, or the log". True of the VALUE. False of the BRANCH:
    //
    //   - a stage id owned by another workspace RESOLVED, so control reached
    //     `requireOwnedPipeline`, which fails by `throw new Error("Pipeline not
    //     found")` — rendered by asActionResult as the generic sentence and a
    //     reference code;
    //   - a stage id that existed NOWHERE failed one line earlier at `refuse(…)`,
    //     which renders verbatim.
    //
    // Two distinguishable answers to "is there such a stage?" is a one-bit
    // cross-workspace existence oracle. Narrow — the caller must already hold an id
    // — and real, and a comment about where the value went could never have fixed
    // it, because the value was never what was being read.
    //
    // So the read now carries the ownership predicate itself: one JOIN through
    // "SalesPipeline", scoped to the acting workspace, in which "not yours" and
    // "not there" are the same empty result. ONE refusal, ONE sentence, and a
    // refusal logs nothing — so the two cases share the response and the log.
    const pipeline = await findOwnedPipelineForStage(id);
    if (!pipeline) refuse(UNREACHABLE_STAGE_MESSAGE);

    // Bounded by a `pipelineId` the statement above proved this workspace owns —
    // the same containment argument as the `aggregate` in createStage, and it holds
    // here for the same reason: the parent is the boundary, and it has been applied.
    const stages = await basePrisma.pipelineStage.findMany({
      where: { pipelineId: pipeline.id },
      orderBy: { order: "asc" },
      select: { id: true },
    });
    const index = stages.findIndex((row) => row.id === id);
    const swapWith = direction === "up" ? index - 1 : index + 1;
    // Only reachable if the stage was deleted between the two reads. The SAME
    // sentence as the unresolvable case above, from the same constant, so a race
    // cannot become a third distinguishable answer either.
    if (index < 0) refuse(UNREACHABLE_STAGE_MESSAGE);
    if (swapWith < 0 || swapWith >= stages.length) refuse("That stage is already at the end.");
    const ids = stages.map((row) => row.id);
    [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
    await reorderPipelineStages(pipeline.id, ids);
    revalidatePath("/settings");
    revalidatePath("/leads");
  });
}

export async function deleteStage(id: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireTenantOwner();
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


export async function createUser(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  const owner = await requireTenantOwner();
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
  // The WORKSPACE's own copy of the role. Every tenant but the founding one has
  // its roles as `<system id>:<tenantId>` (seedTenantDefaultRoles); assigning the
  // bare id gave a new workspace's users the founding tenant's role row, which
  // their workspace cannot see — so they had no permissions at all.
  const salesRepRoleId =
    result.tenantId === DEFAULT_TENANT_ID ? "role_sales_rep" : `role_sales_rep:${result.tenantId}`;
  try {
    await basePrisma.$executeRaw`
      INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId")
      VALUES (gen_random_uuid()::text, ${created.id}, ${salesRepRoleId}, ${result.tenantId})
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
    after: { name, email, role: "member", initialRbacRole: salesRepRoleId, tenantId: result.tenantId },
  });
  revalidatePath("/settings");
  revalidatePath("/settings/access");
  return { ok: `${name} added to the team.` };
}

export async function changeOwnPassword(
  _prev: FormState | undefined,
  formData: FormData
): Promise<FormState> {
  return withActingStaffScope(async () => {
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
  });
}

export async function saveQuoteDefaults(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
    const days = String(formData.get("validDays") ?? "").trim();
    const terms = String(formData.get("terms") ?? "").trim();
    await putSetting("QUOTE_VALID_DAYS", String(quoteValidDays(days)));
    await putSetting("QUOTE_TERMS", terms);
    revalidatePath("/settings");
  });
}

/**
 * VAT rate, currency, number/date format and time zone (Settings → Quotes).
 * Refuses anything Intl can't format with rather than storing it and letting
 * every document fall back silently. Changing the VAT rate affects NEW quote
 * lines only — issued lines keep the rate stored on them.
 */
export async function saveRegionalSettings(formData: FormData) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const field = (name: string) => String(formData.get(name) ?? "").trim();
    const input = {
      vatRatePct: field("vatRatePct").replace(",", "."),
      currency: field("currency").toUpperCase(),
      locale: field("locale"),
      timeZone: field("timeZone"),
    };
    const vat = Number(input.vatRatePct);
    if (!input.vatRatePct || !Number.isFinite(vat) || vat < 0 || vat > 100) {
      throw new ActionRefusal("VAT rate must be a number from 0 to 100.");
    }
    // regionalFrom hands back each value unchanged when it is valid, so any
    // difference is a value it had to replace.
    const parsed = regionalFrom(input);
    if (parsed.currency !== input.currency) throw new ActionRefusal(`“${input.currency}” isn't a currency code (e.g. ZAR, USD, EUR).`);
    if (parsed.locale !== input.locale) throw new ActionRefusal(`“${input.locale}” isn't a number and date format (e.g. en-ZA, en-GB).`);
    if (parsed.timeZone !== input.timeZone) throw new ActionRefusal(`“${input.timeZone}” isn't a time zone (e.g. Africa/Johannesburg).`);

    const before = await getRegionalSettings();
    for (const key of Object.keys(REGIONAL_KEYS) as (keyof typeof REGIONAL_KEYS)[]) {
      await putSetting(REGIONAL_KEYS[key], String(parsed[key]));
    }
    await logAuditStrict({
      action: "settings.regional_updated",
      summary: `Tax & currency: VAT ${before.vatRatePct}% → ${parsed.vatRatePct}%, ${before.currency} → ${parsed.currency}, ${before.locale} → ${parsed.locale}, ${before.timeZone} → ${parsed.timeZone}`,
      user,
    });
    revalidatePath("/settings");
  });
}

export async function saveWorkshopSettings(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
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
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const hour = parseInt(String(formData.get("hour") ?? ""), 10);
    // An unchecked checkbox submits nothing, so absence means "don't skip".
    const skipWeekends = formData.get("skipWeekends") != null;
    await setNextStepScheduling({ hour, skipWeekends });
    revalidatePath("/automations");
    revalidatePath("/settings");
  });
}

export async function updateOwnProfile(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  return withActingStaffScope(async () => {
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
  });
}

export async function updateOwnEmail(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  return withActingStaffScope(async () => {
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
  });
}

export async function updateOwnAvatar(
  _prev: FormState | undefined,
  formData: FormData,
): Promise<FormState> {
  return withActingStaffScope(async () => {
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
    // A profile photo belongs to the USER row it is stored on, verbatim — not to
    // whichever workspace they happened to be acting in when they uploaded it, which
    // would move the same person's photo between prefixes as they switch workspaces.
    // A global owner has no tenantId, and null is the honest answer for them.
    const nextRef = await saveFile(buffer, `profile${extension}`, mimeType, user.tenantId);
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
  });
}

export async function removeOwnAvatar(
  _prev: FormState | undefined,
  _formData: FormData,
): Promise<FormState> {
  return withActingStaffScope(async () => {
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
  });
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
    await requireTenantOwner();
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
    // A credential that names an inbound endpoint must register that endpoint,
    // or the webhook carrying it is dropped unattributed under enforcement —
    // see channelRegistration.ts. This is the path the founding tenant's
    // WhatsApp number is saved through, and it is the one that was missing.
    await registerInboundEndpointsFor(key);
    // "layout": these forms live on /settings/integrations (batch 6).
    revalidatePath("/settings", "layout");
  });
}

/**
 * Reconcile this workspace's inbound channel endpoints after a credential save.
 *
 * Deliberately swallowing: `reconcileTenantChannels` already logs its own
 * failures, and a save the owner made correctly must not report an error
 * because Meta was unreachable while we were deriving a Page id from it. The
 * cron sweep repairs anything this misses.
 */
async function registerInboundEndpointsFor(key: string): Promise<void> {
  if (!keyNamesAnInboundEndpoint(key)) return;
  const tenantId = await getActiveTenantId();
  if (!tenantId) return;
  await reconcileTenantChannels(tenantId, { force: true }).catch(() => undefined);
}

/** Reveal a stored secret to the owner on demand — so the value is NEVER in the
 *  initial server-rendered page, only fetched by an explicit owner action. */
export async function revealSecret(key: string): Promise<string> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    if (!isManagedSecret(key)) throw new Error("Not a revealable secret.");
    return (await getSetting(key)) ?? "";
  });
}

/** Explicitly clear a secret (disconnect an integration / remove a compromised
 *  key). Owner-only, and the key is allowlisted — a server action's bound arg
 *  comes from the client, so we must not delete an arbitrary AppSetting. */
export async function clearSecret(key: string, _formData?: FormData): Promise<void> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    void _formData;
    if (!isManagedSecret(key)) throw new Error("Not a clearable secret.");
    await putSetting(key, "");
    // Disconnecting must RETIRE the endpoint, not merely stop using it. A row
    // left active keeps routing inbound events into this workspace, and — worse
    // — permanently blocks any other workspace from claiming that endpoint,
    // because registration correctly refuses to steal a row it does not own.
    await registerInboundEndpointsFor(key);
    // "layout": these forms live on /settings/integrations (batch 6).
    revalidatePath("/settings", "layout");
  });
}

export async function regenerateSetting(key: string) {
  return asActionResult(async () => {
    await requireTenantOwner();
    // The key is a client-supplied bound arg — only allow secrets we actually
    // generate, so this can't overwrite an externally-issued credential.
    if (!isRegeneratable(key)) throw new ActionRefusal("Not a regeneratable secret.");
    const value = crypto.randomBytes(24).toString("hex");
    await putSetting(key, value);
    revalidatePath("/settings", "layout");
  });
}

export async function saveNotificationPrefs(formData: FormData) {
  return asActionResult(async () => {
    await requireTenantOwner();
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
    await requireTenantOwner();

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

// ---- Activity types ----

/**
 * The activity types this workspace can schedule.
 *
 * OWNER ONLY and tenant-scoped by `putSetting`, same as the weather cities: the
 * action decides who may write, the storage layer decides WHICH tenant, and it
 * throws rather than guessing when the request carries no scope.
 *
 * TWO THINGS THIS REFUSES, both of which would break the app quietly:
 *
 * 1. Losing a built-in. `test_drive` is what a test-drive booking completes and
 *    `follow_up` carries a required note and auto-pin; a list that dropped one
 *    would leave those code paths writing a type nothing can render. The
 *    built-ins are re-seeded from SYSTEM_ACTIVITY_TYPES rather than trusted from
 *    the client, so a malformed or hostile payload cannot delete one — it can
 *    only rename or hide it, which is what the screen actually offers.
 *
 * 2. Hiding everything. An empty picker is a workspace that cannot schedule
 *    anything, reachable by ticking seven checkboxes, and the way back is this
 *    same screen — which is fine, but the rep hitting it at 16:00 has no idea
 *    that is where to go.
 *
 * `serialiseActivityTypes` stores only the DIFFERENCE from the defaults, so a
 * workspace that renames nothing writes `[]` and keeps inheriting future
 * built-in changes rather than freezing today's labels.
 */
export async function saveActivityTypes(types: unknown): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireTenantOwner();

    if (!Array.isArray(types)) refuse("Could not read that list of activity types.");

    const submitted = types as ActivityType[];

    // Re-seed every built-in from the source of truth, carrying across only the
    // label/emoji/hidden the client asked for. A built-in the payload omitted is
    // restored untouched rather than lost.
    const merged: ActivityType[] = SYSTEM_ACTIVITY_TYPES.map((system) => {
      const sent = submitted.find(
        (type) => type && typeof type === "object" && type.key === system.key
      );
      return sent ? { ...system, label: sent.label, emoji: sent.emoji, hidden: sent.hidden === true } : { ...system };
    });

    for (const type of submitted) {
      if (!type || typeof type !== "object") continue;
      if (isSystemActivityType(type.key)) continue;
      merged.push(type);
    }

    const cleaned = resolveActivityTypes(serialiseActivityTypes(merged));

    if (cleaned.every((type) => type.hidden)) {
      refuse("Leave at least one activity type visible — otherwise nothing can be scheduled.");
    }

    await putSetting(ACTIVITY_TYPES_KEY, serialiseActivityTypes(cleaned));
    // The list is resolved in the (app) layout and handed to every type picker
    // in the app, so the whole shell has to re-render.
    revalidatePath("/", "layout");
  });
}

// ---- Lead routing ----

/**
 * Who new inbound leads are auto-assigned to (lib/leadRouting.ts).
 *
 * OWNER ONLY. Every user id the config can assign to — reps AND fixed rule
 * targets — must be an active member of the ACTING workspace, checked here
 * against the same list the picker was built from: a posted id from another
 * workspace would otherwise be stored and, at the next lead, refused only by the
 * runtime re-check. Refusing at save time tells the owner instead of silently
 * leaving leads unassigned. Products are checked through the tenant-guarded
 * client for the same reason.
 *
 * `withActingStaffScope` because the product read below goes through the guarded
 * client, which needs a bound scope a Server Action does not otherwise have.
 */
export async function saveLeadRouting(input: unknown): Promise<ActionResult> {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      await requireTenantOwner();
      const config = parseLeadRoutingConfig(input);

      const members = new Set((await listActingTenantStaff()).map((person) => person.id));
      if (routingCandidateIds(config).some((id) => !members.has(id))) {
        refuse("One of the chosen people is not an active member of this workspace. Refresh and try again.");
      }
      const productIds = [...new Set(config.rules.flatMap((rule) => (rule.productId ? [rule.productId] : [])))];
      if (productIds.length > 0) {
        const found = await prisma.product.count({ where: { id: { in: productIds } } });
        if (found !== productIds.length) refuse("One of the chosen products no longer exists. Refresh and try again.");
      }
      if (config.enabled && routingCandidateIds(config).length === 0) {
        refuse("Pick at least one rep before switching lead routing on.");
      }

      await putSetting(LEAD_ROUTING_KEY, JSON.stringify(config));
      revalidatePath("/settings/lead-routing");
    }),
  );
}
