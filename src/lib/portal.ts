import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { isModuleEnabled } from "./modules/enabled";

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
  // Portal is an optional pack. When it is off, no session resolves — this is
  // the single choke point every portal page and action funnels through
  // (directly, or via getPortalScope/requirePortalScope/portalUser), so gating
  // here makes the whole portal self-reject server-side, not just hide its UI.
  if (!(await isModuleEnabled("portal"))) return null;
  const store = await cookies();
  const token = store.get(PORTAL_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.kind !== "portal" || typeof payload.sub !== "string") return null;
    const contact = await prisma.contact.findFirst({
      where: { id: payload.sub, deletedAt: null },
    });
    return contact;
  } catch {
    return null;
  }
}
