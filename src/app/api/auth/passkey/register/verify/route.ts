import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { rpConfig, readChallenge, clearChallenge } from "@/lib/webauthn";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  const { rpID, origin } = await rpConfig();
  // "reg", not any challenge: an authentication ceremony's cookie is refused
  // here. The `uid` check below already bound this route to the signed-in user;
  // the purpose check binds it to the CEREMONY, which `uid` cannot express.
  const stashed = await readChallenge("reg");
  if (!stashed || stashed.uid !== user.id) {
    return NextResponse.json({ error: "Challenge expired — try again." }, { status: 400 });
  }

  const body = await req.json();
  const nickname = String(body.nickname ?? "").trim() || null;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: stashed.ch,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verification failed" },
      { status: 400 }
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "Could not verify the passkey." }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  await prisma.passkey.create({
    data: {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: credential.transports?.join(",") ?? null,
      nickname,
      userId: user.id,
    },
  });
  await clearChallenge();
  await logAudit({
    action: "passkey.registered",
    summary: `Registered a passkey${nickname ? ` (${nickname})` : ""}`,
    user,
  });
  return NextResponse.json({ ok: true });
}
