import "server-only";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { sendSms, normalizePhone } from "@/lib/sms";
// The channel RULE is pure and lives on its own so it can be tested directly;
// this module keeps the parts that need a database and a network.
import { offeredChannels, identityRequired, type IdentityChannel, type ChannelOffer } from "./identityChannels";
import { logSignEvent } from "./events";
import { signingOtpHash, safeEqualHex } from "./securityPolicy";
import { hashSignToken } from "./tokens";

/**
 * Proving a signer is who the document was sent to.
 *
 * Without this, holding the link IS the authority to sign — so a forwarded
 * email, a shared sales inbox, a mail-scanning proxy or a browser left open on
 * a shared machine are all enough to sign somebody's contract in their name.
 * A one-time code moves the question from "who has this URL" to "who controls
 * the mailbox or the phone we already had on file for this customer".
 *
 * ── Email or SMS, whichever the signer still has ────────────────────────────
 *
 * Both channels use the same ceremony and the same evidence. Offering both is
 * not a convenience: the usual reason a signature stalls is that the one channel
 * chosen months ago no longer reaches the person — a mailbox they have left, a
 * number they have changed. Letting them pick the one that still works is what
 * keeps the step-up from turning into a support call.
 *
 * The destinations are the ones ALREADY ON FILE — the recipient's email as
 * recorded on the envelope, and the contact's mobile number resolved when the
 * request was created. Nothing about the incoming request can choose or alter
 * where a code is sent, or the code would simply be posted to the attacker.
 */

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Codes may be re-requested, but not used to hose the signer with messages. */
const RESEND_COOLDOWN_MS = 45 * 1000;

type RecipientIdentity = {
  id: string;
  tenantId: string;
  name: string;
  email: string | null;
  phone: string | null;
  identityVerifiedAt: Date | null;
  identityMethod: string | null;
  request: { id: string; title: string; identityMode: string; status: string; deletedAt: Date | null };
};

export type IdentityStatus = {
  required: boolean;
  verified: boolean;
  mode: string;
  /** Channels this signer can actually be reached on, with a masked hint each. */
  channels: ChannelOffer[];
};

export function identityStatus(recipient: RecipientIdentity): IdentityStatus {
  const required = identityRequired(recipient.request.identityMode);
  return {
    required,
    verified: !required || Boolean(recipient.identityVerifiedAt),
    mode: recipient.request.identityMode,
    channels: required ? availableChannels(recipient) : [],
  };
}

/** This signer's usable channels, from the shared rule. */
export function availableChannels(recipient: RecipientIdentity): ChannelOffer[] {
  return offeredChannels({
    email: recipient.email,
    phone: recipient.phone,
    identityMode: recipient.request.identityMode,
  });
}

/** Resolve the capability digest, then load only that tenant-owned recipient. */
export async function loadRecipientIdentity(token: string): Promise<RecipientIdentity | null> {
  const row = await basePrisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: {
      id: true, tenantId: true, name: true, email: true, phone: true,
      identityVerifiedAt: true, identityMethod: true, tokenRevokedAt: true,
      request: { select: { id: true, title: true, identityMode: true, status: true, deletedAt: true } },
    },
  });
  // A revoked capability is not "not yet verified", it is finished. Returning it
  // would let a completed or declined envelope restart the ceremony.
  if (!row || row.tokenRevokedAt || !row.tenantId) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    identityVerifiedAt: row.identityVerifiedAt,
    identityMethod: row.identityMethod,
    request: row.request,
  };
}

/** Digest of where a code was sent — evidence, without a second readable copy. */
function destinationHash(tenantId: string, recipientId: string, destination: string): string {
  return crypto.createHash("sha256").update(`${tenantId}:${recipientId}:${destination}`).digest("hex");
}

export async function startIdentityChallenge(
  token: string,
  channel: IdentityChannel,
): Promise<{ ok: boolean; status?: IdentityStatus; error?: string }> {
  const recipient = await loadRecipientIdentity(token);
  if (!recipient || recipient.request.deletedAt) return { ok: false, error: "Signing link not found." };
  const status = identityStatus(recipient);
  if (!status.required || status.verified) return { ok: true, status };

  // The channel is checked against what the DOCUMENT allows and what is on
  // file — never taken on trust from the request.
  const allowed = status.channels.find((c) => c.channel === channel);
  if (!allowed) {
    return { ok: false, status, error: "That verification method is not available for this document." };
  }
  const destination = channel === "email" ? recipient.email!.trim() : recipient.phone!.trim();

  // Cooldown on the LAST issued challenge, so "resend" cannot be held down to
  // bill the tenant for SMS or bury the signer's inbox.
  const recent = await basePrisma.signingIdentityChallenge.findFirst({
    where: { tenantId: recipient.tenantId, recipientId: recipient.id, purpose: "sign" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, status, error: "A code was just sent. Wait a moment before asking for another." };
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const challengeId = `sic_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // Written BEFORE the send. If the row failed after a successful send, a signer
  // would hold a code that verifies against nothing.
  await basePrisma.signingIdentityChallenge.create({
    data: {
      id: challengeId,
      tenantId: recipient.tenantId,
      recipientId: recipient.id,
      purpose: "sign",
      channel,
      destinationHash: destinationHash(recipient.tenantId, recipient.id, destination),
      // HMAC, salted per tenant and recipient — never the code itself.
      codeHash: signingOtpHash(recipient.tenantId, recipient.id, code),
      expiresAt,
      attempts: 0,
    },
  });

  const sent = channel === "email"
    ? await sendEmail({
        to: destination,
        subject: `Verification code: ${recipient.request.title}`,
        text:
          `Hi ${recipient.name},\n\nYour verification code for “${recipient.request.title}” is ${code}.\n\n` +
          `It expires in 10 minutes. If you did not ask to sign this document, ignore this message ` +
          `and tell the sender.`,
      })
    : await sendSms(
        normalizePhone(destination) ?? destination,
        `Your verification code for "${recipient.request.title}" is ${code}. It expires in 10 minutes.`,
      );

  if (!sent.ok) {
    // Undeliverable code, so remove the challenge rather than leave one live
    // that nobody can answer — the signer would otherwise sit through the
    // cooldown before being allowed to try a channel that works.
    await basePrisma.signingIdentityChallenge
      .deleteMany({ where: { id: challengeId, tenantId: recipient.tenantId } })
      .catch(() => ({ count: 0 }));
    return { ok: false, status, error: sent.error ?? "Could not send the verification code." };
  }

  await logSignEvent(recipient.request.id, {
    type: "identity_challenge_sent",
    recipientId: recipient.id,
    actor: recipient.name,
    channel,
    // The destination is recorded as a digest, never in the clear: this event
    // stream is read by staff and exported in evidence bundles.
    metadata: { mode: recipient.request.identityMode, channel, challengeId },
  });
  return { ok: true, status };
}

export async function verifyIdentityChallenge(
  token: string,
  code: string,
  evidence: { ip?: string | null; userAgent?: string | null },
): Promise<{ ok: boolean; status?: IdentityStatus; error?: string }> {
  const recipient = await loadRecipientIdentity(token);
  if (!recipient || recipient.request.deletedAt) return { ok: false, error: "Signing link not found." };
  const current = identityStatus(recipient);
  if (!current.required || current.verified) return { ok: true, status: current };
  if (!/^\d{6}$/.test(code.trim())) return { ok: false, status: current, error: "Enter the six-digit code." };

  const verifiedAt = new Date();
  const outcome = await basePrisma.$transaction(async (tx) => {
    // FOR UPDATE so two submissions of the same code cannot both pass the
    // attempt check and spend the challenge twice.
    const rows = await tx.$queryRaw<Array<{
      id: string; codeHash: string; expiresAt: Date; attempts: number; consumedAt: Date | null; channel: string;
    }>>`
      SELECT "id", "codeHash", "expiresAt", "attempts", "consumedAt", "channel"
      FROM "SigningIdentityChallenge"
      WHERE "tenantId" = ${recipient.tenantId}
        AND "recipientId" = ${recipient.id}
        AND "purpose" = 'sign'
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge || challenge.consumedAt) return { result: "missing" as const };
    if (challenge.expiresAt < verifiedAt) return { result: "expired" as const };
    if (challenge.attempts >= MAX_ATTEMPTS) return { result: "locked" as const };

    const supplied = signingOtpHash(recipient.tenantId, recipient.id, code.trim());
    if (!safeEqualHex(challenge.codeHash, supplied)) {
      await tx.$executeRaw`
        UPDATE "SigningIdentityChallenge" SET "attempts" = "attempts" + 1
        WHERE "id" = ${challenge.id} AND "tenantId" = ${recipient.tenantId}
      `;
      return { result: "invalid" as const };
    }

    const method = challenge.channel === "sms" ? "sms_otp" : "email_otp";
    // Binds the proof to this challenge, this moment and this caller, without
    // keeping a readable copy of any of it.
    const evidenceHash = crypto.createHash("sha256").update(JSON.stringify({
      challengeId: challenge.id,
      recipientId: recipient.id,
      requestId: recipient.request.id,
      channel: challenge.channel,
      verifiedAt: verifiedAt.toISOString(),
      ip: evidence.ip ?? null,
      userAgent: evidence.userAgent ?? null,
    })).digest("hex");

    // Spend the challenge in the SAME transaction that marks the recipient
    // verified, so a crash between them cannot leave a reusable code behind.
    await tx.$executeRaw`
      UPDATE "SigningIdentityChallenge"
      SET "consumedAt" = ${verifiedAt}, "attempts" = "attempts" + 1
      WHERE "id" = ${challenge.id} AND "tenantId" = ${recipient.tenantId}
    `;
    await tx.signatureRecipient.updateMany({
      where: { id: recipient.id, tenantId: recipient.tenantId },
      data: { identityVerifiedAt: verifiedAt, identityMethod: method, identityEvidenceHash: evidenceHash },
    });
    return { result: "ok" as const, method, channel: challenge.channel };
  });

  if (outcome.result !== "ok") {
    const messages = {
      missing: "Request a new verification code.",
      expired: "That code has expired. Request a new one.",
      locked: "Too many attempts. Request a new code.",
      invalid: "That code is incorrect.",
    } as const;
    return { ok: false, status: current, error: messages[outcome.result] };
  }

  await logSignEvent(recipient.request.id, {
    type: "identity_verified",
    recipientId: recipient.id,
    actor: recipient.name,
    channel: outcome.channel,
    ip: evidence.ip ?? undefined,
    userAgent: evidence.userAgent ?? undefined,
    metadata: { mode: recipient.request.identityMode, method: outcome.method },
  });

  return { ok: true, status: { ...current, verified: true } };
}

export type { IdentityChannel, ChannelOffer } from "./identityChannels";
