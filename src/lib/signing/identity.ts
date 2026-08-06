import "server-only";
import crypto from "crypto";
import { cookies } from "next/headers";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { waDigits } from "@/lib/whatsapp";
import { getCurrentUser } from "@/lib/auth";
import { isSigningSmsConfigured, sendSigningSms } from "./sms";
import { hashSignToken, safeTokenEqual } from "./tokens";
import { logSignEvent } from "./events";
import { signingReleaseId } from "./securityConfig";

export type IdentityPolicy =
  | "ES1_LINK"
  | "ES2_EMAIL_OTP"
  | "ES2_SMS_OTP"
  | "ES2_EMAIL_SMS"
  | "ES2_AUTHENTICATED_PORTAL"
  | "ES3_PASSKEY"
  | "ES3_IDENTITY_PROVIDER"
  | "AES_ACCREDITED";
export type OtpMethod = "email" | "sms";

const COOKIE = "denago_signing_identity";
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 30 * 60;

export type RecipientIdentityRow = {
  recipientId: string;
  envelopeId: string;
  tenantId: string;
  email: string | null;
  phone: string | null;
  name: string;
  policy: IdentityPolicy;
  assuranceLevel: string;
};

type IdentitySession = {
  rid: string;
  eid: string;
  exp: number;
  methods: string[];
  assurance: string;
  nonce: string;
};

function sessionKey(): Buffer {
  const secret = process.env.SIGNING_IDENTITY_SESSION_SECRET || process.env.SIGNING_TOKEN_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!secret) throw new Error("Signing identity session secret is not configured");
  return crypto.createHash("sha256").update(secret).digest();
}
function hmac(value: string): string { return crypto.createHmac("sha256", sessionKey()).update(value).digest("hex"); }
function otpHash(challengeId: string, recipientId: string, otp: string): string { return hmac(`${challengeId}:${recipientId}:${otp}`); }
function encodeSession(payload: IdentitySession): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}
function decodeSession(token: string): IdentitySession | null {
  const [body, signature] = token.split(".");
  if (!body || !signature || !safeTokenEqual(hmac(body), signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as IdentitySession;
    if (!payload.rid || !payload.eid || !payload.exp || payload.exp < Date.now() || !Array.isArray(payload.methods)) return null;
    return payload;
  } catch { return null; }
}

export function requiredOtpMethods(policy: IdentityPolicy): OtpMethod[] {
  if (policy === "ES2_EMAIL_OTP") return ["email"];
  if (policy === "ES2_SMS_OTP") return ["sms"];
  if (policy === "ES2_EMAIL_SMS") return ["email", "sms"];
  return [];
}

export function maskedDestination(value: string | null): string {
  if (!value) return "your verified contact method";
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    return `${local?.slice(0, 2) || "*"}${"*".repeat(Math.max(2, (local?.length || 2) - 2))}@${domain}`;
  }
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

export async function findRecipientIdentity(rawToken: string): Promise<RecipientIdentityRow | null> {
  const digest = hashSignToken(rawToken);
  const rows = await basePrisma.$queryRaw<RecipientIdentityRow[]>(Prisma.sql`
    SELECT r.id AS "recipientId", r."requestId" AS "envelopeId", r."tenantId", r.email, r.phone, r.name,
           q."identityPolicy" AS policy, q."assuranceLevel"
      FROM "SignatureRecipient" r JOIN "SignatureRequest" q ON q.id=r."requestId" AND q."tenantId"=r."tenantId"
     WHERE r.token=${digest} AND r."tokenRevokedAt" IS NULL
       AND (r."tokenExpiresAt" IS NULL OR r."tokenExpiresAt" > now())
     LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function currentIdentitySession(): Promise<{ raw: string; payload: IdentitySession } | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  const payload = raw ? decodeSession(raw) : null;
  return raw && payload ? { raw, payload } : null;
}

export async function identitySatisfied(recipientId: string, envelopeId: string, policy: IdentityPolicy): Promise<boolean> {
  if (policy === "ES1_LINK") return true;
  if (policy === "ES2_AUTHENTICATED_PORTAL") {
    const identity = await basePrisma.$queryRaw<Array<{ tenantId: string; email: string | null; name: string }>>(Prisma.sql`
      SELECT "tenantId",email,name FROM "SignatureRecipient" WHERE id=${recipientId} AND "requestId"=${envelopeId} LIMIT 1
    `);
    const user = await getCurrentUser();
    const match = Boolean(user && identity[0]?.email && user.tenantId === identity[0].tenantId
      && user.email.trim().toLowerCase() === identity[0].email.trim().toLowerCase());
    if (match) await recordAuthenticatedIdentity(recipientId, envelopeId, identity[0]!.tenantId, identity[0]!.name, "authenticated_portal", "ES-2", `portal:${user!.id}`);
    return match;
  }
  if (["ES3_IDENTITY_PROVIDER", "AES_ACCREDITED"].includes(policy)) return false;
  if (policy === "ES3_PASSKEY") {
    const session = await currentIdentitySession();
    if (!session || session.payload.rid !== recipientId || session.payload.eid !== envelopeId || !session.payload.methods.includes("passkey")) return false;
    const sessionHash = crypto.createHash("sha256").update(session.raw).digest("hex");
    const proof = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "SigningIdentityChallenge" WHERE "recipientId"=${recipientId} AND "envelopeId"=${envelopeId}
        AND method='passkey' AND status='verified' AND "sessionHash"=${sessionHash} AND "expiresAt">now() LIMIT 1
    `);
    return proof.length === 1;
  }
  const session = await currentIdentitySession();
  if (!session || session.payload.rid !== recipientId || session.payload.eid !== envelopeId) return false;
  const required = requiredOtpMethods(policy);
  if (!required.every((method) => session.payload.methods.includes(method))) return false;
  const sessionHash = crypto.createHash("sha256").update(session.raw).digest("hex");
  const rows = await basePrisma.$queryRaw<Array<{ method: string }>>(Prisma.sql`
    SELECT DISTINCT method FROM "SigningIdentityChallenge"
     WHERE "recipientId"=${recipientId} AND "envelopeId"=${envelopeId}
       AND status='verified' AND "sessionHash"=${sessionHash} AND "expiresAt" > now()
  `);
  const proven = new Set(rows.map((row) => row.method));
  return required.every((method) => proven.has(method === "email" ? "email_otp" : "sms_otp"));
}

export async function issueOtp(rawToken: string, method: OtpMethod): Promise<{ masked: string; expiresAt: Date }> {
  const identity = await findRecipientIdentity(rawToken);
  if (!identity) throw new Error("Signing link is invalid or expired");
  if (!requiredOtpMethods(identity.policy).includes(method)) throw new Error(`${method.toUpperCase()} verification is not required for this document`);
  const destination = method === "email" ? identity.email : identity.phone;
  if (!destination) throw new Error(`This signer has no confirmed ${method === "email" ? "email address" : "mobile number"}`);
  if (method === "sms" && !isSigningSmsConfigured()) throw new Error("SMS OTP delivery is not configured");

  const challengeId = crypto.randomUUID();
  const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const normalized = method === "email" ? destination.trim().toLowerCase() : waDigits(destination);
  const destinationHash = crypto.createHash("sha256").update(normalized).digest("hex");
  const dbMethod = method === "email" ? "email_otp" : "sms_otp";
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "SigningIdentityChallenge" SET status='revoked'
       WHERE "recipientId"=${identity.recipientId} AND method=${dbMethod} AND status='pending'
    `;
    await tx.$executeRaw`
      INSERT INTO "SigningIdentityChallenge"(
        id,"tenantId","envelopeId","recipientId",method,"destinationHash","secretHash","expiresAt"
      ) VALUES (
        ${challengeId},${identity.tenantId},${identity.envelopeId},${identity.recipientId},${dbMethod},
        ${destinationHash},${otpHash(challengeId, identity.recipientId, otp)},${expiresAt}
      )
    `;
  });

  const delivery = method === "email"
    ? await sendEmail({
        to: destination,
        subject: "Your Denago signing verification code",
        text: `Hi ${identity.name},\n\nYour one-time verification code is ${otp}. It expires in 10 minutes.\n\nDo not forward this code. Denago Cape Town`,
      })
    : await sendSigningSms({ to: waDigits(destination), text: `Denago signing verification code: ${otp}\nExpires in 10 minutes. Do not forward this code.`, idempotencyKey: `signing-otp:${challengeId}` });
  if (!delivery.ok) {
    await basePrisma.$executeRaw`UPDATE "SigningIdentityChallenge" SET status='delivery_failed' WHERE id=${challengeId}`;
    throw new Error(delivery.error || "Could not deliver the verification code");
  }
  await logSignEvent(identity.envelopeId, {
    type: "identity_challenge_issued", recipientId: identity.recipientId, actor: "system", channel: method === "email" ? "email" : "sms",
    metadata: { method: dbMethod, destinationHash, expiresAt: expiresAt.toISOString(), releaseId: signingReleaseId() },
  });
  return { masked: maskedDestination(destination), expiresAt };
}

export async function verifyOtp(rawToken: string, method: OtpMethod, otp: string): Promise<{ cookie: string; maxAge: number; complete: boolean; verifiedMethods: OtpMethod[] }> {
  const identity = await findRecipientIdentity(rawToken);
  if (!identity) throw new Error("Signing link is invalid or expired");
  const dbMethod = method === "email" ? "email_otp" : "sms_otp";
  const rows = await basePrisma.$queryRaw<Array<{ id: string; secretHash: string; attempts: number; maxAttempts: number; expiresAt: Date }>>(Prisma.sql`
    SELECT id,"secretHash",attempts,"maxAttempts","expiresAt"
      FROM "SigningIdentityChallenge"
     WHERE "recipientId"=${identity.recipientId} AND method=${dbMethod} AND status='pending'
     ORDER BY "createdAt" DESC LIMIT 1
  `);
  const challenge = rows[0];
  if (!challenge || challenge.expiresAt < new Date()) throw new Error("Verification code expired; request a new one");
  if (challenge.attempts >= challenge.maxAttempts) throw new Error("Verification is locked; request a new code");
  const expected = otpHash(challenge.id, identity.recipientId, otp);
  if (!safeTokenEqual(expected, challenge.secretHash)) {
    await basePrisma.$executeRaw`
      UPDATE "SigningIdentityChallenge"
         SET attempts=attempts+1,status=CASE WHEN attempts+1 >= "maxAttempts" THEN 'locked' ELSE status END
       WHERE id=${challenge.id} AND status='pending'
    `;
    throw new Error("Incorrect verification code");
  }

  const prior = await currentIdentitySession();
  const methods = new Set<string>(
    prior?.payload.rid === identity.recipientId && prior.payload.eid === identity.envelopeId ? prior.payload.methods : [],
  );
  methods.add(method);
  const verifiedMethods = [...methods] as OtpMethod[];
  const required = requiredOtpMethods(identity.policy);
  const complete = required.every((requiredMethod) => methods.has(requiredMethod));
  const maxAge = SESSION_TTL_SECONDS;
  const sessionExpiresAt = new Date(Date.now() + maxAge * 1000);
  const cookie = encodeSession({
    rid: identity.recipientId, eid: identity.envelopeId, exp: sessionExpiresAt.getTime(), methods: verifiedMethods,
    assurance: complete ? "ES-2" : "ES-2-partial", nonce: crypto.randomUUID(),
  });
  const sessionHash = crypto.createHash("sha256").update(cookie).digest("hex");
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "SigningIdentityChallenge" SET status='verified',"verifiedAt"=now(),"sessionHash"=${sessionHash},"expiresAt"=${sessionExpiresAt}
       WHERE id=${challenge.id} AND status='pending'
    `;
    if (complete) {
      for (const requiredMethod of required) {
        const requiredDbMethod = requiredMethod === "email" ? "email_otp" : "sms_otp";
        await tx.$executeRaw`
          UPDATE "SigningIdentityChallenge" SET "sessionHash"=${sessionHash},"expiresAt"=${sessionExpiresAt}
           WHERE "recipientId"=${identity.recipientId} AND "envelopeId"=${identity.envelopeId}
             AND status='verified' AND method=${requiredDbMethod}
        `;
      }
      await tx.$executeRaw`
        UPDATE "SignatureRecipient" SET "authMethod"=${required.length > 1 ? "email_otp+sms_otp" : dbMethod},"assuranceLevel"='ES-2',
          "authVerifiedAt"=now(),"authTransactionId"=${challenge.id}
         WHERE id=${identity.recipientId}
      `;
    }
  });
  await logSignEvent(identity.envelopeId, {
    type: "identity_verified", recipientId: identity.recipientId, actor: identity.name, channel: method === "email" ? "email" : "sms",
    metadata: { method: dbMethod, assuranceLevel: complete ? "ES-2" : "ES-2-partial", transactionId: challenge.id, complete },
  });
  return { cookie, maxAge, complete, verifiedMethods };
}

// Compatibility wrappers for existing callers/tests.
export const issueEmailOtp = (rawToken: string) => issueOtp(rawToken, "email");
export const verifyEmailOtp = (rawToken: string, otp: string) => verifyOtp(rawToken, "email", otp);

export function identityCookieHeader(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function recordAuthenticatedIdentity(
  recipientId: string,
  envelopeId: string,
  tenantId: string,
  actor: string,
  method: string,
  assurance: string,
  transactionId: string,
  session?: { raw: string; expiresAt: Date },
): Promise<void> {
  const sessionHash = session ? crypto.createHash("sha256").update(session.raw).digest("hex") : null;
  await basePrisma.$transaction(async (tx) => {
    if (session) await tx.$executeRaw`
      INSERT INTO "SigningIdentityChallenge"(id,"tenantId","envelopeId","recipientId",method,"destinationHash","secretHash","sessionHash",status,"expiresAt","verifiedAt")
      VALUES (${transactionId},${tenantId},${envelopeId},${recipientId},${method},${hashSignToken(actor)},${hashSignToken(transactionId)},${sessionHash},'verified',${session.expiresAt},now())
      ON CONFLICT (id) DO NOTHING
    `;
    await tx.$executeRaw`
      UPDATE "SignatureRecipient" SET "authMethod"=${method},"assuranceLevel"=${assurance},"authVerifiedAt"=now(),"authTransactionId"=${transactionId}
       WHERE id=${recipientId} AND "requestId"=${envelopeId}
    `;
    await tx.$executeRaw`
      INSERT INTO "SignatureEvent"(id,"tenantId","requestId","recipientId",type,actor,channel,metadata,"createdAt")
      SELECT gen_random_uuid()::text,${tenantId},${envelopeId},${recipientId},'identity_verified',${actor},'web',
        ${JSON.stringify({ method, assuranceLevel: assurance, transactionId })}::jsonb,now()
      WHERE NOT EXISTS (SELECT 1 FROM "SignatureEvent" WHERE "requestId"=${envelopeId} AND "recipientId"=${recipientId}
        AND type='identity_verified' AND metadata->>'transactionId'=${transactionId})
    `;
  });
}

export function createIdentitySession(input: { recipientId: string; envelopeId: string; methods: string[]; assurance: string }): { cookie: string; maxAge: number; expiresAt: Date } {
  const maxAge = SESSION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  return { cookie: encodeSession({ rid: input.recipientId, eid: input.envelopeId, exp: expiresAt.getTime(), methods: input.methods, assurance: input.assurance, nonce: crypto.randomUUID() }), maxAge, expiresAt };
}

export async function requireIdentityForToken(rawToken: string): Promise<RecipientIdentityRow> {
  const identity = await findRecipientIdentity(rawToken);
  if (!identity) throw new Error("Signing link is invalid or expired");
  if (["ES3_IDENTITY_PROVIDER", "AES_ACCREDITED"].includes(identity.policy)) {
    throw new Error(`This document requires ${identity.policy}; use the authenticated identity ceremony configured for this template`);
  }
  if (!(await identitySatisfied(identity.recipientId, identity.envelopeId, identity.policy))) {
    throw new Error("Identity verification is required before signing");
  }
  return identity;
}
