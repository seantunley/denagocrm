import "server-only";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * WebAuthn relying-party config derived from the request origin, so passkeys
 * work on both crm.denagocpt.co.za (prod) and localhost (dev) without config.
 */
export async function rpConfig(): Promise<{ rpID: string; origin: string; rpName: string }> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const rpID = host.split(":")[0]; // hostname only, no port
  return { rpID, origin: `${proto}://${host}`, rpName: "Denago Cape Town CRM" };
}

/* Challenges are stateless: signed into a short-lived httpOnly cookie rather
   than stored server-side, so nothing leaks across the register/auth flow. */

const CHALLENGE_COOKIE = "denago_wa_chal";
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret-local-only");

export async function stashChallenge(challenge: string, extra: Record<string, string> = {}) {
  const token = await new SignJWT({ ch: challenge, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret());
  (await cookies()).set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });
}

export async function readChallenge(): Promise<{ ch: string; [k: string]: string } | null> {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as { ch: string; [k: string]: string };
  } catch {
    return null;
  }
}

export async function clearChallenge() {
  (await cookies()).delete(CHALLENGE_COOKIE);
}
