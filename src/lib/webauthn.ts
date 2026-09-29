import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * WebAuthn relying-party config derived from the request origin, so passkeys
 * work on both crm.denagocpt.co.za (prod) and localhost (dev) without config,
 * and — the reason it must stay per-request — on each tenant's own domain.
 *
 * Deriving `rpID`/`origin` from the Host header looks like the classic mistake
 * of letting the caller name the value we then claim to "expect", and the
 * 2026-09-01 retest raised it as exactly that before withdrawing it. It is not
 * one, and the reason is worth keeping next to the code: the security anchor in
 * WebAuthn is that the BROWSER writes the true origin into `clientDataJSON` and
 * the authenticator signs over it. Spoofing this header on a direct HTTP request
 * changes what we compare against, but produces no signature over the challenge
 * — that needs the private key. An attacker who could forge the assertion would
 * not need the header.
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

/**
 * Which ceremony a stashed challenge belongs to.
 *
 * Registration and authentication share this one cookie, and before the
 * 2026-09-01 retest they shared it with NO marker distinguishing them:
 * `register/verify` was bound (it requires `uid` to equal the signed-in user),
 * but `auth/verify` accepted any challenge cookie at all — including one minted
 * by a registration ceremony.
 *
 * No attack was built from that, and the reason it failed is instructive: a
 * registration response is an attestation object, so `verifyAuthenticationResponse`
 * rejects its SHAPE before reaching anything security-relevant. That is a real
 * defence, but it is somebody else's library's input validation, and it is the
 * only thing standing between the two ceremonies. Binding the purpose costs two
 * lines and removes the dependency.
 */
export type ChallengePurpose = "reg" | "auth";

/**
 * A key of its own, derived from `SESSION_SECRET` rather than being it.
 *
 * This cookie was signed with `SESSION_SECRET` directly — the same key that
 * signs session JWTs — which is the issue `lib/domainCheck.ts` already fixed for
 * its own HMAC, with the same reasoning, in the previous audit. That fix simply
 * did not reach this file.
 *
 * As with domain-check, key reuse was not exploitable here: a challenge token
 * carries `{ch, pur, …}` and a session carries `{sub, sv, jti, tid}`, and
 * `verifySessionFull` requires `sub`, so neither verifies as the other. But the
 * safety came entirely from the current claim shapes — one added claim on either
 * side turns key reuse into cross-context forgery. HKDF makes it structural: this
 * key cannot sign or verify a session token no matter what is put through it,
 * because it is not that key.
 *
 * No new environment variable: rotating `SESSION_SECRET` rotates this too, and a
 * challenge lives five minutes, so changing the key strands nothing but the
 * ceremonies literally in flight at deploy (the browser retries).
 *
 * The missing-secret policy deliberately MIRRORS `lib/session.ts`: throw in
 * production, fall back to the documented dev value otherwise. The previous
 * version fell back silently even in production — unreachable in practice,
 * because session.ts throws first on any real deployment, but this file should
 * not be the one that makes it reachable.
 */
function challengeKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  const material =
    !secret || secret.length < 16
      ? (() => {
          if (process.env.NODE_ENV === "production") {
            throw new Error("SESSION_SECRET is not set (or too short) in production.");
          }
          return "dev-secret-local-only";
        })()
      : secret;
  return new Uint8Array(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(material, "utf8"),
      Buffer.alloc(0),
      Buffer.from("denago:webauthn-challenge:v1", "utf8"),
      32,
    ),
  );
}

export async function stashChallenge(
  purpose: ChallengePurpose,
  challenge: string,
  extra: Record<string, string> = {},
) {
  const token = await new SignJWT({ ch: challenge, pur: purpose, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(challengeKey());
  (await cookies()).set(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });
}

/**
 * Read the stashed challenge, and refuse one raised for the OTHER ceremony.
 *
 * The purpose check is not optional and there is no "any purpose" overload on
 * purpose: a caller that does not know which ceremony it is completing has no
 * business completing one.
 */
export async function readChallenge(
  purpose: ChallengePurpose,
): Promise<{ ch: string; [k: string]: string } | null> {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, challengeKey());
    if (payload.pur !== purpose) return null;
    return payload as { ch: string; [k: string]: string };
  } catch {
    return null;
  }
}

export async function clearChallenge() {
  (await cookies()).delete(CHALLENGE_COOKIE);
}
