import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma, basePrisma } from "./db";
import { isModuleEnabled } from "./modules/enabled";
import { enterTenantScope, runInTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is not set (or too short) in production.");
    }
    return new TextEncoder().encode("dev-secret-local-only");
  }
  // Distinct salt so a portal token can never be used as a staff token.
  return new TextEncoder().encode(s + ":portal");
};

export const PORTAL_COOKIE = "denago_portal";
const PORTAL_DAYS = 30;

export async function signPortalSession(contactId: string, email: string): Promise<string> {
  return new SignJWT({ sub: contactId, email, kind: "portal" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PORTAL_DAYS}d`)
    .sign(secret());
}

export async function setPortalCookie(contactId: string, email: string) {
  const token = await signPortalSession(contactId, email);
  const store = await cookies();
  store.set(PORTAL_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PORTAL_DAYS * 24 * 3600,
  });
}

export async function clearPortalCookie() {
  const store = await cookies();
  store.delete(PORTAL_COOKIE);
}

/** The logged-in customer for the portal, or null. */
export async function getPortalContact() {
  // Verify the portal JWT FIRST, with NO database access, so no tenant-owned data
  // is touched before we know whose tenant this request belongs to.
  const store = await cookies();
  const token = store.get(PORTAL_COOKIE)?.value;
  if (!token) return null;
  let contactId: string;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "portal" || typeof payload.sub !== "string") return null;
    contactId = payload.sub;
  } catch {
    return null;
  }
  // Dormant path (enforcement off): unchanged pre-tenancy behaviour, no scope
  // machinery. Portal is an optional pack — this is the single choke point every
  // portal page/action funnels through, so gating here self-rejects server-side.
  if (!tenantEnforcing()) {
    if (!(await isModuleEnabled("portal"))) return null;
    return prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } });
  }

  // Enforcing: derive the tenant from the verified subject via a DELIBERATELY
  // NARROW trusted lookup (single column, basePrisma) — the public portal is NEVER
  // given a broad `system` bypass.
  const owner = await resolvePortalTenant(contactId);
  if (!owner) return null; // unknown subject → fail closed
  const tenantId = owner.tenantId ?? null;

  // Do the module check + LIVE (non-deleted) Contact read inside a CONFINED tenant
  // scope, so a rejected request (module off / soft-deleted / missing) leaves NO
  // scope behind — the scope reverts when this callback returns.
  const contact = await runInTenantScope({ tenantId, system: false }, async () => {
    if (!(await isModuleEnabled("portal"))) return null;
    return prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } });
  });
  if (!contact) return null;

  // Only after validation SUCCEEDS, persist the tenant scope for the rest of the
  // request.
  enterTenantScope({ tenantId, system: false });
  return contact;
}

/**
 * Narrow trusted lookup: the owning tenant of a verified portal subject (contact
 * id). basePrisma + single column — the ONLY thing the public portal reads before
 * its tenant scope is established, deliberately not a broad system bypass.
 * Exported for tests.
 */
export async function resolvePortalTenant(
  contactId: string,
): Promise<{ tenantId: string | null } | null> {
  return basePrisma.contact.findUnique({
    where: { id: contactId },
    select: { tenantId: true },
  });
}
