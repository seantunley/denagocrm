import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { createSessionCookie } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { rpConfig, readChallenge, clearChallenge } from "@/lib/webauthn";

export async function POST(req: NextRequest) {
  const { rpID, origin } = await rpConfig();
  const stashed = await readChallenge();
  if (!stashed) {
    return NextResponse.json({ error: "Challenge expired — try again." }, { status: 400 });
  }

  const body = await req.json();
  const response = body.response;
  // The browser returns the raw credential id (base64url) that was used.
  const credentialId: string | undefined = response?.id;
  if (!credentialId) {
    return NextResponse.json({ error: "No credential returned." }, { status: 400 });
  }

  const passkey = await prisma.passkey.findUnique({
    where: { credentialId },
    include: { user: true },
  });
  if (!passkey) {
    return NextResponse.json({ error: "Unrecognised passkey." }, { status: 400 });
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verification failed" },
      { status: 400 }
    );
  }

  if (!verification.verified) {
    return NextResponse.json({ error: "Could not verify the passkey." }, { status: 400 });
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
  await createSessionCookie(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    { pwa: Boolean(body.pwa) }
  );
  await clearChallenge();
  await logAudit({
    action: "passkey.login",
    summary: `Signed in with a passkey${passkey.nickname ? ` (${passkey.nickname})` : ""}`,
    user,
  });
  return NextResponse.json({ ok: true });
}
