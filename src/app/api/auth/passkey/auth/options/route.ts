import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { rpConfig, stashChallenge } from "@/lib/webauthn";
import {
  PASSKEY_POLICY,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";

/** Discoverable (username-less) login: the device offers whichever passkey. */
export async function POST() {
  // Unauthenticated and public, so bound the work. Every call here mints a
  // challenge and signs a cookie; there is no failure to count, so each call
  // counts. See PASSKEY_POLICY for why the ceiling is generous rather than
  // login-shaped (this bucket is shared by everyone behind an office NAT).
  const ip = await getRequestIp();
  const limit = await registerRateLimitAttempt(
    rateLimitKey("passkey-auth-options-ip", ip),
    PASSKEY_POLICY,
  );
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const { rpID } = await rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    // no allowCredentials — resident keys let the authenticator pick
  });
  await stashChallenge("auth", options.challenge);
  return NextResponse.json(options);
}
