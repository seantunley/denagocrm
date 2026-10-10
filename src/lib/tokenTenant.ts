import "server-only";
import { basePrisma } from "./db";
import { hashSignToken } from "./signing/tokenVault";

/**
 * Trusted PRE-SCOPE tenant resolvers for no-user token surfaces.
 *
 * These run BEFORE a tenant scope exists — they are what decides which tenant
 * the request belongs to — so they use basePrisma deliberately.
 *
 * Signing and approval capabilities are stored as SHA-256 digests, so the raw
 * value out of the URL is hashed before it is queried. The raw token is never
 * compared against anything at rest, and no query here can match on a readable
 * secret. Campaign and survey tokens keep their existing model-specific
 * resolvers: those are tracking identifiers, not credentials that authorise
 * signing someone's contract.
 */

export async function resolveSignRecipientTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: { tenantId: true, tokenRevokedAt: true },
  });
  if (!row || row.tokenRevokedAt) return null;
  return { tenantId: row.tenantId };
}

export async function resolveApprovalStepTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.approvalStep.findUnique({
    where: { token: hashSignToken(token) },
    select: { tenantId: true, tokenRevokedAt: true },
  });
  // A revoked capability resolves to nothing, so the guarded work never runs and
  // the page fails closed before it can load a document.
  if (!row || row.tokenRevokedAt) return null;
  return { tenantId: row.tenantId };
}

/** Owning tenant of a campaign tracking/unsubscribe token. */
export async function resolveCampaignRecipientTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.campaignRecipient.findUnique({
    where: { token },
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
}

/** Owning tenant of an email's open-tracking token (the pixel in a sent email). */
export async function resolveEmailOpenTenant(
  openToken: string,
): Promise<{ tenantId: string | null } | null> {
  // A tracking id, not a credential (like campaign tokens): it can only bump an open count.
  const row = await basePrisma.communication.findUnique({
    where: { openToken },
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
}

/**
 * Owning workspace of a SEALED DOCUMENT, found from the SHA-256 of the file.
 *
 * For the public "is this document genuine?" page, which has no session and no
 * token — only a file somebody was handed. The digest covers every byte of that
 * file, so presenting it IS presenting the document: there is nothing to guess
 * or walk, and a match tells the holder only about the file already in their
 * hands. The custody row is immutable and outlives a trashed request, which is
 * right: a signed contract does not stop being genuine when someone tidies up.
 *
 * Format-checked here, so nothing but a digest ever reaches the query.
 */
export async function resolveSealedDocument(
  sha256: string,
): Promise<{ tenantId: string; requestId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const row = await basePrisma.legalArtifact.findFirst({
    where: { sha256 },
    orderBy: { createdAt: "asc" },
    select: { tenantId: true, requestId: true },
  });
  return row?.tenantId ? { tenantId: row.tenantId, requestId: row.requestId } : null;
}

/** Owning tenant of a public survey-response token (page load + submission). */
export async function resolveSurveyResponseTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.surveyResponse.findUnique({
    where: { token },
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
}
