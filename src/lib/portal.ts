import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma, basePrisma } from "./db";
import { isModuleEnabled } from "./modules/enabled";
import { enterTenantScope } from "./tenantScope";
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
  // Phase C: derive the tenant from the verified subject via a DELIBERATELY NARROW
  // trusted lookup (single column, basePrisma) and enter THAT tenant — the public
  // portal is NEVER given a broad `system` bypass. DORMANT until `tenantEnforcing()`;
  // when off, no lookup runs and the checks below behave exactly as before.
  if (tenantEnforcing()) {
    const owner = await resolvePortalTenant(contactId);
    if (!owner) return null; // unknown subject → fail closed
    enterTenantScope({ tenantId: owner.tenantId ?? null, system: false });
  }
  // Portal is an optional pack. When it is off, no session resolves — this is the
  // single choke point every portal page and action funnels through (directly, or
  // via getPortalScope/requirePortalScope/portalUser), so gating here makes the
  // whole portal self-reject server-side. Now runs in the customer's own tenant.
  if (!(await isModuleEnabled("portal"))) return null;
  return prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } });
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
