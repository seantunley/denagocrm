import "server-only";
import crypto from "crypto";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { rpConfig, stashChallenge, readChallenge, clearChallenge } from "@/lib/webauthn";
import { findRecipientIdentity, createIdentitySession, recordAuthenticatedIdentity } from "./identity";

export async function passkeySigningOptions(rawToken: string) {
  const identity = await findRecipientIdentity(rawToken);
  if (!identity || identity.policy !== "ES3_PASSKEY") throw new Error("Passkey signing is not required for this document");
  if (!identity.email) throw new Error("The signer has no verified account email");
  const credentials = await basePrisma.$queryRaw<Array<{ credentialId: string; transports: string | null }>>(Prisma.sql`
    SELECT p."credentialId",p.transports FROM "Passkey" p JOIN "User" u ON u.id=p."userId"
     WHERE u."tenantId"=${identity.tenantId} AND lower(u.email)=lower(${identity.email})
  `);
  if (!credentials.length) throw new Error("No passkey is registered for this signer account");
  const { rpID } = await rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports ? credential.transports.split(",") as AuthenticatorTransportFuture[] : undefined,
    })),
  });
  await stashChallenge(options.challenge, { purpose: "signing", rid: identity.recipientId, eid: identity.envelopeId });
  return options;
}

export async function verifyPasskeySigning(rawToken: string, response: Parameters<typeof verifyAuthenticationResponse>[0]["response"]) {
  const identity = await findRecipientIdentity(rawToken);
  if (!identity || identity.policy !== "ES3_PASSKEY" || !identity.email) throw new Error("Passkey signing is not available");
  const challenge = await readChallenge();
  if (!challenge || challenge.purpose !== "signing" || challenge.rid !== identity.recipientId || challenge.eid !== identity.envelopeId) {
    throw new Error("Passkey challenge expired; try again");
  }
  const credentialId = response?.id;
  if (!credentialId) throw new Error("No passkey credential returned");
  const rows = await basePrisma.$queryRaw<Array<{ id: string; credentialId: string; publicKey: Buffer; counter: bigint; transports: string | null; userId: string }>>(Prisma.sql`
    SELECT p.id,p."credentialId",p."publicKey",p.counter,p.transports,p."userId"
      FROM "Passkey" p JOIN "User" u ON u.id=p."userId"
     WHERE p."credentialId"=${credentialId} AND u."tenantId"=${identity.tenantId} AND lower(u.email)=lower(${identity.email}) LIMIT 1
  `);
  const passkey = rows[0];
  if (!passkey) throw new Error("This passkey does not belong to the intended signer");
  const { rpID, origin } = await rpConfig();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.ch,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: Number(passkey.counter),
      transports: passkey.transports ? passkey.transports.split(",") as AuthenticatorTransportFuture[] : undefined,
    },
  });
  if (!verification.verified) throw new Error("Passkey verification failed");
  await basePrisma.$executeRaw`UPDATE "Passkey" SET counter=${BigInt(verification.authenticationInfo.newCounter)},"lastUsedAt"=now() WHERE id=${passkey.id}`;
  const session = createIdentitySession({ recipientId: identity.recipientId, envelopeId: identity.envelopeId, methods: ["passkey"], assurance: "ES-3" });
  const transactionId = crypto.randomUUID();
  await recordAuthenticatedIdentity(identity.recipientId, identity.envelopeId, identity.tenantId, identity.name, "passkey", "ES-3", transactionId, { raw: session.cookie, expiresAt: session.expiresAt });
  await clearChallenge();
  return session;
}
