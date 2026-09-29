import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { rpConfig, stashChallenge } from "@/lib/webauthn";

export async function POST() {
  const user = await requireUser();
  const { rpID, rpName } = await rpConfig();
  const existing = await prisma.passkey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: (c.transports?.split(",").filter(Boolean) ?? []) as never,
    })),
    authenticatorSelection: {
      residentKey: "required", // discoverable — enables username-less sign-in
      userVerification: "preferred",
    },
  });

  await stashChallenge("reg", options.challenge, { uid: user.id });
  return NextResponse.json(options);
}
