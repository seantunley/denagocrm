"use server";

import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";
import { canAccessSignatureRequest, REQUEST_BINDING_SELECT } from "@/lib/signing/access";
import { decryptSignToken, isValidSignToken } from "@/lib/signing/tokens";
import { signUrl } from "@/lib/signing/delivery";
import { isRequestClosed } from "@/lib/signing/status";

type CapabilityRow = {
  tokenCiphertext: string | null;
  tokenExpiresAt: Date | null;
  tokenRevokedAt: Date | null;
};

/**
 * Public signing capabilities are deliberately absent from ordinary record state.
 * A manager may reveal one only through this audited, record-authorized action;
 * the raw value lives in browser memory for that interaction and is never logged.
 */
export async function revealSigningLink(recipientId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const user = await requirePermission("signing.manage");
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    select: {
      id: true,
      tenantId: true,
      name: true,
      status: true,
      requestId: true,
      request: { select: { status: true, deletedAt: true, ...REQUEST_BINDING_SELECT } },
    },
  });
  if (!recipient || !recipient.tenantId || !(await canAccessSignatureRequest(user, recipient.request))) {
    return { ok: false, error: "Signing link not found." };
  }
  if (recipient.request.deletedAt || isRequestClosed(recipient.request.status) || ["signed", "declined"].includes(recipient.status)) {
    return { ok: false, error: "This signing capability is no longer active." };
  }

  const rows = await basePrisma.$queryRaw<CapabilityRow[]>(Prisma.sql`
    SELECT "tokenCiphertext","tokenExpiresAt","tokenRevokedAt"
      FROM "SignatureRecipient"
     WHERE id=${recipient.id} AND "tenantId"=${recipient.tenantId}
     LIMIT 1
  `);
  const capability = rows[0];
  if (!capability?.tokenCiphertext || capability.tokenRevokedAt || !capability.tokenExpiresAt || capability.tokenExpiresAt <= new Date()) {
    return { ok: false, error: "The signing capability is unavailable or expired. Resend to rotate it." };
  }

  let rawToken: string;
  try {
    rawToken = decryptSignToken(capability.tokenCiphertext);
  } catch {
    return { ok: false, error: "The signing capability could not be recovered. Resend to rotate it." };
  }
  if (!isValidSignToken(rawToken)) return { ok: false, error: "The recovered signing capability is invalid." };

  await logAuditStrict({
    action: "signing.link_revealed",
    summary: `Revealed the active signing link for ${recipient.name}`,
    entityType: "SignatureRecipient",
    entityId: recipient.id,
    user,
    metadata: { requestId: recipient.requestId, recipientId: recipient.id },
  });
  return { ok: true, url: signUrl(rawToken) };
}
