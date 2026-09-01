import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { createSessionCookie } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { rpConfig, readChallenge, clearChallenge } from "@/lib/webauthn";
import {
  PASSKEY_POLICY,
  checkRateLimit,
  clearRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

/**
 * Passkey login. Public by necessity — it runs before any session exists.
 *
 * The throttling and the failure trail below are NOT a brute-force guard: an
 * assertion cannot be forged without the private key, so attempt count is not
 * what stands between a caller and a session. They exist because this route had
 * neither, while the password path next door had both — see PASSKEY_POLICY.
 */
export async function POST(req: NextRequest) {
  const ip = await getRequestIp();
  const ipKey = rateLimitKey("passkey-auth-verify-ip", ip);

  // Checked BEFORE any work — the point is to stop doing the work.
  if (!(await checkRateLimit(ipKey)).allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  /**
   * One exit for every rejection, so a new early-return can't be added later
   * that skips the accounting — which is exactly how this route came to have
   * none. Records the attempt and leaves a trail; the audit write is
   * best-effort by construction inside logAudit.
   */
  const fail = async (
    message: string,
    status: number,
    actor?: { id: string; name: string } | null,
  ) => {
    await registerRateLimitAttempt(ipKey, PASSKEY_POLICY);
    await logAudit({
      action: "passkey.login_failed",
      summary: `Failed passkey sign-in attempt: ${message}`,
      user: actor ?? null,
      userName: actor?.name ?? "Unknown",
      metadata: { ip },
    });
    return NextResponse.json({ error: message }, { status });
  };

  const { rpID, origin } = await rpConfig();
  // "auth", not any challenge: a registration ceremony's cookie is refused here
  // rather than relying on the attestation/assertion shape mismatch to catch it.
  const stashed = await readChallenge("auth");
  if (!stashed) {
    return await fail("Challenge expired — try again.", 400);
  }

  const body = await req.json().catch(() => null);
  const response = body?.response;
  // The browser returns the raw credential id (base64url) that was used.
  const credentialId: string | undefined = response?.id;
  if (!credentialId) {
    return await fail("No credential returned.", 400);
  }

  const passkey = await prisma.passkey.findUnique({
    where: { credentialId },
    include: { user: true },
  });
  if (!passkey) {
    return await fail("Unrecognised passkey.", 400);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stashed.ch,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports
          ? (passkey.transports.split(",") as import("@simplewebauthn/server").AuthenticatorTransportFuture[])
          : undefined,
      },
    });
  } catch (e) {
    return await fail(e instanceof Error ? e.message : "Verification failed", 400, passkey.user);
  }

  if (!verification.verified) {
    return await fail("Could not verify the passkey.", 400, passkey.user);
  }

  // Advance the signature counter (clone/replay detection) and record use.
  await prisma.passkey.update({
    where: { id: passkey.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });

  const user = passkey.user;
  /**
   * A disabled account is refused HERE, by createSessionCookie, which throws
   * rather than minting anything — the check this route does not make itself and
   * does not need to.
   *
   * It was previously uncaught, so an offboarded user presenting a valid passkey
   * got an unhandled 500. That failed CLOSED (no session), so it was never a way
   * in; it was a confusing error and an unhelpful log line. Catch it and refuse
   * cleanly. Deliberately NOT reimplementing the disabled/sessionVersion checks
   * here: they live in one place and are re-run on every request thereafter.
   */
  try {
    await createSessionCookie(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      { pwa: Boolean(body?.pwa) }
    );
  } catch {
    return await fail("This account can no longer sign in.", 403, user);
  }

  await clearRateLimit(ipKey);
  await clearChallenge();
  await logAudit({
    action: "passkey.login",
    summary: `Signed in with a passkey${passkey.nickname ? ` (${passkey.nickname})` : ""}`,
    user,
  });
  return NextResponse.json({ ok: true });
}
