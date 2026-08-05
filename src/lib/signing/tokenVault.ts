import "server-only";
import { basePrisma } from "@/lib/db";
import { encryptValue, decryptValue } from "@/lib/settings";
import { newSignToken } from "./tokens";
import { bearerTokenHash } from "./securityPolicy";

export type ProtectedBearerToken = {
  plain: string;
  stored: string;
  hash: string;
};

export type SigningRecipientTokenOwner = {
  id: string;
  tenantId: string;
  requestId: string;
};

export type ApprovalTokenOwner = {
  id: string;
  tenantId: string;
  requestId: string;
};

export function createProtectedBearerToken(): ProtectedBearerToken {
  const plain = newSignToken();
  return { plain, stored: encryptValue(plain), hash: bearerTokenHash(plain) };
}

export function protectBearerToken(plain: string): ProtectedBearerToken {
  return { plain, stored: encryptValue(plain), hash: bearerTokenHash(plain) };
}

/** Legacy plaintext reads remain lossless; strict production values decrypt. */
export function revealBearerToken(stored: string): string {
  return decryptValue(stored);
}

async function upgradeRecipientToken(
  row: SigningRecipientTokenOwner & { storedToken: string },
  plain: string,
  hash: string,
): Promise<void> {
  if (row.storedToken.startsWith("enc:v1:")) return;
  try {
    const encrypted = encryptValue(plain);
    if (encrypted === plain) return; // local compatibility without a key
    await basePrisma.$executeRaw`
      UPDATE "SignatureRecipient"
      SET "token" = ${encrypted}, "tokenHash" = ${hash}
      WHERE "id" = ${row.id}
        AND "tenantId" = ${row.tenantId}
        AND "requestId" = ${row.requestId}
        AND "token" = ${row.storedToken}
        AND "tokenRevokedAt" IS NULL
    `;
  } catch {
    // Lookup succeeds even if a rolling deployment cannot upgrade this row yet.
    // Strict readiness prevents new production signing work without the key.
  }
}

async function upgradeApprovalToken(
  row: ApprovalTokenOwner & { storedToken: string },
  plain: string,
  hash: string,
): Promise<void> {
  if (row.storedToken.startsWith("enc:v1:")) return;
  try {
    const encrypted = encryptValue(plain);
    if (encrypted === plain) return;
    await basePrisma.$executeRaw`
      UPDATE "ApprovalStep"
      SET "token" = ${encrypted}, "tokenHash" = ${hash}
      WHERE "id" = ${row.id}
        AND "tenantId" = ${row.tenantId}
        AND "requestId" = ${row.requestId}
        AND "token" = ${row.storedToken}
        AND "tokenRevokedAt" IS NULL
    `;
  } catch {
    // Retain the valid legacy row; the next trusted access retries the upgrade.
  }
}

/**
 * Trusted pre-scope signing-token resolver. The secret is never compared against
 * the ciphertext column; only its digest is indexed. The legacy token fallback
 * is restricted to rows not yet backfilled, then upgraded immediately.
 */
export async function resolveSigningRecipientToken(
  plain: string,
): Promise<SigningRecipientTokenOwner | null> {
  const hash = bearerTokenHash(plain);
  const rows = await basePrisma.$queryRaw<Array<SigningRecipientTokenOwner & { storedToken: string }>>`
    SELECT "id", "tenantId", "requestId", "token" AS "storedToken"
    FROM "SignatureRecipient"
    WHERE "tokenRevokedAt" IS NULL
      AND ("tokenHash" = ${hash} OR ("tokenHash" IS NULL AND "token" = ${plain}))
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.tenantId) return null;
  await upgradeRecipientToken(row, plain, hash);
  return { id: row.id, tenantId: row.tenantId, requestId: row.requestId };
}

/** Trusted pre-scope approval-token resolver; same digest/ciphertext contract. */
export async function resolveApprovalToken(plain: string): Promise<ApprovalTokenOwner | null> {
  const hash = bearerTokenHash(plain);
  const rows = await basePrisma.$queryRaw<Array<ApprovalTokenOwner & { storedToken: string }>>`
    SELECT "id", "tenantId", "requestId", "token" AS "storedToken"
    FROM "ApprovalStep"
    WHERE "tokenRevokedAt" IS NULL
      AND ("tokenHash" = ${hash} OR ("tokenHash" IS NULL AND "token" = ${plain}))
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.tenantId) return null;
  await upgradeApprovalToken(row, plain, hash);
  return { id: row.id, tenantId: row.tenantId, requestId: row.requestId };
}
