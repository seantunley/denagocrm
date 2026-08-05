import "server-only";
import crypto from "crypto";
import { basePrisma, prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent } from "./events";
import { signingOtpHash, safeEqualHex } from "./securityPolicy";

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type RecipientIdentity = {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  identityVerifiedAt: Date | null;
  identityMethod: string | null;
  request: { id: string; title: string; identityMode: string; status: string; deletedAt: Date | null };
};

type ChallengeRow = {
  id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
};

export type IdentityStatus = {
  required: boolean;
  verified: boolean;
  mode: string;
  emailHint: string | null;
};

function emailHint(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}${"•".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export function identityStatus(recipient: RecipientIdentity): IdentityStatus {
  const required = recipient.request.identityMode !== "link";
  return {
    required,
    verified: !required || Boolean(recipient.identityVerifiedAt),
    mode: recipient.request.identityMode,
    emailHint: emailHint(recipient.email),
  };
}

export async function loadRecipientIdentity(token: string): Promise<RecipientIdentity | null> {
  const row = await prisma.signatureRecipient.findUnique({
    where: { token },
    select: {
      id: true,
      tenantId: true,
      name: true,
      email: true,
      identityVerifiedAt: true,
      identityMethod: true,
      request: { select: { id: true, title: true, identityMode: true, status: true, deletedAt: true } },
    },
  });
  if (!row?.tenantId) return null;
  return row as RecipientIdentity;
}

export async function startEmailOtp(token: string): Promise<{ ok: boolean; status?: IdentityStatus; error?: string }> {
  const recipient = await loadRecipientIdentity(token);
  if (!recipient || recipient.request.deletedAt) return { ok: false, error: "Signing link not found." };
  const status = identityStatus(recipient);
  if (!status.required || status.verified) return { ok: true, status };
  if (recipient.request.identityMode !== "email_otp") {
    return { ok: false, status, error: `Identity mode ${recipient.request.identityMode} is not supported by this channel.` };
  }
  if (!recipient.email) return { ok: false, status, error: "This signer has no verified email address." };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const challengeId = `sic_${crypto.randomUUID().replace(/-/g, "")}`;
  const codeHash = signingOtpHash(recipient.tenantId, recipient.id, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await basePrisma.$executeRaw`
    INSERT INTO "SigningIdentityChallenge"
      ("id","tenantId","recipientId","purpose","codeHash","expiresAt","attempts","createdAt")
    VALUES
      (${challengeId}, ${recipient.tenantId}, ${recipient.id}, 'sign', ${codeHash}, ${expiresAt}, 0, NOW())
  `;

  const sent = await sendEmail({
    to: recipient.email,
    subject: `Verification code: ${recipient.request.title}`,
    text:
      `Hi ${recipient.name},\n\nYour verification code for “${recipient.request.title}” is ${code}.\n\n` +
      `It expires in 10 minutes. Do not share this code.\n\nDenago Cape Town`,
  });
  if (!sent.ok) {
    await basePrisma.$executeRaw`
      DELETE FROM "SigningIdentityChallenge"
      WHERE "id" = ${challengeId} AND "tenantId" = ${recipient.tenantId}
    `.catch(() => 0);
    return { ok: false, status, error: sent.error ?? "Could not send the verification code." };
  }

  await logSignEvent(recipient.request.id, {
    type: "identity_challenge_sent",
    recipientId: recipient.id,
    actor: recipient.name,
    channel: "email",
    metadata: { mode: "email_otp", challengeId },
  });
  return { ok: true, status };
}

export async function verifyEmailOtp(
  token: string,
  code: string,
  evidence: { ip?: string | null; userAgent?: string | null },
): Promise<{ ok: boolean; status?: IdentityStatus; error?: string }> {
  const recipient = await loadRecipientIdentity(token);
  if (!recipient || recipient.request.deletedAt) return { ok: false, error: "Signing link not found." };
  const current = identityStatus(recipient);
  if (!current.required || current.verified) return { ok: true, status: current };
  if (!/^\d{6}$/.test(code)) return { ok: false, status: current, error: "Enter the six-digit code." };

  const verifiedAt = new Date();
  const outcome = await basePrisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ChallengeRow[]>`
      SELECT "id", "codeHash", "expiresAt", "attempts", "consumedAt"
      FROM "SigningIdentityChallenge"
      WHERE "tenantId" = ${recipient.tenantId}
        AND "recipientId" = ${recipient.id}
        AND "purpose" = 'sign'
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge || challenge.consumedAt) return "missing" as const;
    if (challenge.expiresAt < verifiedAt) return "expired" as const;
    if (challenge.attempts >= MAX_ATTEMPTS) return "locked" as const;

    const supplied = signingOtpHash(recipient.tenantId, recipient.id, code);
    if (!safeEqualHex(challenge.codeHash, supplied)) {
      await tx.$executeRaw`
        UPDATE "SigningIdentityChallenge"
        SET "attempts" = "attempts" + 1
        WHERE "id" = ${challenge.id} AND "tenantId" = ${recipient.tenantId}
      `;
      return "invalid" as const;
    }

    const evidenceHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        challengeId: challenge.id,
        recipientId: recipient.id,
        requestId: recipient.request.id,
        verifiedAt: verifiedAt.toISOString(),
        ip: evidence.ip ?? null,
        userAgent: evidence.userAgent ?? null,
      }))
      .digest("hex");

    await tx.$executeRaw`
      UPDATE "SigningIdentityChallenge"
      SET "consumedAt" = ${verifiedAt}, "attempts" = "attempts" + 1
      WHERE "id" = ${challenge.id} AND "tenantId" = ${recipient.tenantId}
    `;
    await tx.$executeRaw`
      UPDATE "SignatureRecipient"
      SET "identityVerifiedAt" = ${verifiedAt},
          "identityMethod" = 'email_otp',
          "identityEvidenceHash" = ${evidenceHash}
      WHERE "id" = ${recipient.id} AND "tenantId" = ${recipient.tenantId}
    `;
    return "ok" as const;
  });

  if (outcome !== "ok") {
    const messages = {
      missing: "Request a new verification code.",
      expired: "That code has expired. Request a new one.",
      locked: "Too many attempts. Request a new code.",
      invalid: "That code is incorrect.",
    } as const;
    return { ok: false, status: current, error: messages[outcome] };
  }

  await logSignEvent(recipient.request.id, {
    type: "identity_verified",
    recipientId: recipient.id,
    actor: recipient.name,
    channel: "email",
    ip: evidence.ip ?? undefined,
    userAgent: evidence.userAgent ?? undefined,
    metadata: { mode: "email_otp" },
  });

  return {
    ok: true,
    status: { ...current, verified: true },
  };
}
