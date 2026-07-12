import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { rpConfig, stashChallenge } from "@/lib/webauthn";

/** Discoverable (username-less) login: the device offers whichever passkey. */
export async function POST() {
  const { rpID } = await rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    // no allowCredentials — resident keys let the authenticator pick
  });
  await stashChallenge(options.challenge);
  return NextResponse.json(options);
}
