"use server";

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
// The portal's own rule, shared with portalExpansion.ts since #471.
import { portalTenantId } from "@/lib/portalTenant";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { resolveTenantActor } from "@/lib/tenantActor";
import { sendEmail, isSmtpConfigured } from "@/lib/email";
import { tenantEmailContent } from "@/lib/signing/signingEmail";
import { getPortalContact, setPortalCookie, clearPortalCookie } from "@/lib/portal";
import { portalCanAccessVehicle, requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
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
type PortalContactRow = { id: string; firstName: string; lastName: string | null };

/**
 * The workspace whose portal this is: the one `withPortalHostScope` bound from
 * the VERIFIED hostname. This was pinned to DEFAULT_TENANT_ID, so on any other
 * workspace's portal domain the lookup searched Denago's contacts and no other
 * workspace's customer could ever sign in. With no bound scope — an address no
 * workspace has verified — there is no portal: null, and nobody signs in. Only
 * local dev with enforcement off keeps the founding workspace.
 */
async function portalLoginTenantId(): Promise<string | null> {
  const { currentTenantScope } = await import("@/lib/tenantScope");
  const { tenantEnforcing } = await import("@/lib/tenantEnforcement");
  return currentTenantScope()?.tenantId ?? (tenantEnforcing() ? null : DEFAULT_TENANT_ID);
}

/**
 * The OTP challenge key for this portal's sign-in. OtpChallenge is a global
 * model, so a bare email let a code issued on one workspace's portal be redeemed
 * on another's for a customer who uses the same address at both. Namespaced the
 * same way as serviceOtpKey. Rate-limit keys use it too, so one workspace's
 * traffic can't throttle another's customers.
 */
async function portalOtpKey(email: string): Promise<string> {
  return `t:${await portalLoginTenantId()}:${email}`;
}

async function findPortalContactByEmail(email: string): Promise<PortalContactRow | null> {
  const loginTenantId = await portalLoginTenantId();
  if (!loginTenantId) return null;
  const rows = await basePrisma.$queryRaw<PortalContactRow[]>`
    SELECT "id", "firstName", "lastName" FROM "Contact"
    WHERE LOWER("email") = ${email}
      AND "deletedAt" IS NULL
      AND "tenantId" = ${loginTenantId}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function firstStaffUser() {
  return resolveTenantActor();
}

/**
 * The workspace that owns a row the CUSTOMER PORTAL is writing.
 *
 * It is the CONTACT's workspace, never the ambient scope and never a default. A
 * portal request carries an OTP session for a customer, not a staff session, so
 * there is no acting workspace to resolve — the only honest source is the record
 * the customer is acting as.
 *
 * The previous `currentTenantScope()?.tenantId ?? null` was correct under
 * enforcement and null everywhere else, because no scope is entered while
 * enforcement is dormant. Every portal case, notification and profile-change
 * request has therefore been written tenantless, and would vanish from the
 * workspace that must answer it the moment enforcement flips on.
 *
 * The enforced scope still wins when present: it has already been validated
 * against this contact, and preferring it keeps one authority rather than two.
 */
// Implementation lives in @/lib/portalTenant — portalExpansion.ts needs the same
// rule, and a second copy is how this codebase ended up with four acting-tenant
// implementations.

async function createPortalNotification(contactId: string, title: string, body: string, href?: string, kind = "info") {
  const tenantId = await portalTenantId(contactId);
  await basePrisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id", "tenantId", "contactId", "title", "body", "href", "kind")
    VALUES (${crypto.randomUUID()}, ${tenantId}, ${contactId}, ${title}, ${body}, ${href ?? null}, ${kind})
  `;
}

/**
 * Bind the workspace that owns THIS HOSTNAME around a pre-auth portal action.
 *
 * ── WHY SIGN-IN NEEDS THIS AND THE REST OF THE PORTAL DOES NOT ──────────────
 *
 * Every other portal action derives its workspace from the CONTACT, through
 * `portalTenantId` — the customer is already identified, so the record is the
 * honest source. Sign-in is the one step where there is no contact yet, and no
 * staff session either. Production, 2026-08-27:
 *
 *   No tenant scope established for AppSetting   ·   POST /portal/login
 *
 * `requestPortalOtp` calls `isSmtpConfigured()` before anything else, and that
 * reads AppSetting — a tenant-scoped model — so under enforcement the guarded
 * client refuses and the whole page falls to the error boundary. The staff
 * recovery cannot help here: `recoverStaffScopeFromSession` needs a staff
 * cookie, and a customer signing in has none.
 *
 * ── THE HOSTNAME IS THE ONLY IDENTITY THE REQUEST CARRIES ───────────────────
 *
 * Which is exactly what `loginBrand()` already relies on to decide whose name to
 * print on this page. The same fact decides whose settings to read, resolved by
 * the same rule: a VERIFIED TenantDomain on an ACTIVE tenant. An unverified
 * domain is a hostname somebody merely claimed.
 *
 * Queried directly rather than through `brandForHost`, which is wrapped in React
 * `cache()` — an action has no request store, so the memo buys nothing and would
 * put a `cache()` call on a path that exists precisely because actions lack one.
 *
 * ── IT NEVER INVENTS A WORKSPACE ────────────────────────────────────────────
 *
 * An already-bound scope wins. An unresolvable hostname runs a bare `fn()`, so
 * the guards below refuse exactly as they do today rather than falling back to
 * the founding tenant — a portal served on an unknown address must not be handed
 * somebody's customer data.
 *
 * `runInTenantScope`, not `enterTenantScope`: a scope entered inside a callee
 * does not reach the frame that called it, which is the same reason the staff
 * actions have to bind an enclosing frame.
 */
async function withPortalHostScope<T>(fn: () => Promise<T>): Promise<T> {
  const { currentTenantScope, runInTenantScope } = await import("@/lib/tenantScope");
  if (currentTenantScope()) return fn();
  const { headers } = await import("next/headers");
  const raw = (await headers()).get("host");
  const hostname = (raw ?? "").split(":")[0].trim().toLowerCase().replace(/^www\./, "");
  if (!hostname) return fn();
  const row = await basePrisma.tenantDomain
    .findFirst({
      where: { hostname, verifiedAt: { not: null }, tenant: { active: true } },
      select: { tenantId: true },
    })
    // A database blip must not turn sign-in into an error boundary; failing to
    // resolve leaves the guards to refuse, which is the outcome today anyway.
    .catch(() => null);
  if (!row?.tenantId) return fn();
  return runInTenantScope({ tenantId: row.tenantId, system: false }, fn);
}

/** Step 1: email a 6-digit login code to a known customer. */
export async function requestPortalOtp(
  _prev: PortalAuthState | undefined,
  formData: FormData
): Promise<PortalAuthState> {
  const email = normEmail(str(formData.get("email")));
  if (!email || !email.includes("@")) return { error: "Enter your email address." };
  // The shape is deliberate: validate what needs no database, then bind the
  // workspace around everything that does. Splitting the body into its own
  // function rather than nesting it keeps this diff to the wrapper.
  return withPortalHostScope(() => issuePortalOtp(email));
}

async function issuePortalOtp(email: string): Promise<PortalAuthState> {
  if (!(await isSmtpConfigured())) return { error: "The customer portal isn't available right now." };

  const generic: PortalAuthState = { sent: true };
  const ip = await getRequestIp();
  const otpKey = await portalOtpKey(email);
  const accountKey = rateLimitKey("portal-otp-send-account", otpKey);
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp:portal:${otpKey}`})::bigint)`;
    await tx.otpChallenge.updateMany({
      where: { purpose: "portal", key: otpKey, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
    await tx.otpChallenge.create({
      data: {
        purpose: "portal",
        key: otpKey,
        codeHash,
        channel: "email",
        target: email,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
  });
  // The workspace's own editable "portal login code" email (Settings → Email
  // templates), signed by the workspace the contact belongs to (the lookup above pins it).
  const message = await tenantEmailContent("portal_code", await portalLoginTenantId(), {
    first_name: contact.firstName,
    recipient_name: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    code,
  });
  await sendEmail({
    to: email,
    subject: message.subject,
    text: message.text,
    html: message.html,
    // On the customer's timeline with the code masked.
    record: { contactId: contact.id, label: "Portal login code", secrets: [code] },
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
  // Same binding as step 1, for the same reason: every read below goes through
  // the GUARDED client, and there is still no contact and no staff session to
  // resolve a workspace from. `redirect()` throws by design and propagates
  // straight out through the scope, as it does everywhere else.
  return withPortalHostScope(() => completePortalOtp(email, code));
}

async function completePortalOtp(email: string, code: string): Promise<PortalAuthState> {
  const ip = await getRequestIp();
  const otpKey = await portalOtpKey(email);
  const verifyKey = rateLimitKey("portal-otp-verify", `${otpKey}:${ip}`);
  if (!(await checkRateLimit(verifyKey)).allowed) {
    return { error: "Too many incorrect codes. Request a new code later." };
  }

  const challenge = await prisma.otpChallenge.findFirst({
    where: { purpose: "portal", key: otpKey, verifiedAt: null, expiresAt: { gt: new Date() } },
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
    clearRateLimit(rateLimitKey("portal-otp-send-account", otpKey)),
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
      // The portal has no staff session to inherit from — the customer whose record
      // this is owns the row, which is also what the composite foreign key requires.
      tenantId: await customerRecordTenantId({ contactId: contact.id }),
    },
  });
  await prisma.communication.create({
    data: {
      type: "note",
      subject: "🔧 Service request (portal)",
      body: `${contactName(contact)} requested a service for ${vehicleLabel}.${preferred ? ` Preferred date: ${preferred}.` : ""}${notes ? `\n\n${notes}` : ""}`,
      contactId: contact.id,
      userId: staff.id,
      tenantId: await customerRecordTenantId({ contactId: contact.id }),
    },
  });
  await createPortalNotification(contact.id, "Service request received", `We received your service request for ${vehicleLabel}.`, "/portal#cases", "service");
  await logAudit({ action: "portal.service_request", summary: `Service request from ${contactName(contact)} for ${vehicleLabel}`, contactId: contact.id, userName: "Customer portal" });
  await sendPushToAll({ title: "New service request", body: `${contactName(contact)} — ${vehicleLabel}`, url: `/contacts/${contact.id}` }, "service_request").catch(() => {});
  revalidatePath("/portal");
  return { ok: "Thanks! We've received your request and will be in touch to confirm." };
}

// The portal's case, warranty, profile-change, preference and upload forms are
// served by actions/portalExpansion.ts (returning { error } to the form). The
// older copies that lived here were reached by nothing and threw raw Errors;
// they were deleted rather than left to be wired up by mistake.

export async function markPortalNotificationRead(id: string, formData: FormData) {
  void formData;
  const scope = await requirePortalScope();
  await basePrisma.$executeRaw`
    UPDATE "PortalNotification" SET "readAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "contactId" = ${scope.viewerContactId}
  `;
  revalidatePath("/portal");
}
