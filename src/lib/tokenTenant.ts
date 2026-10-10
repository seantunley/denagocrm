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

/**
 * The owning tenant of a signing link that may already be FINISHED.
 *
 * Only for telling the person holding it what became of their document — signed,
 * declined, withdrawn, expired — and for sending their own signed copy to the
 * address on file again. A revoked link used to resolve to nothing at all, so a
 * customer who reopened it after signing met a bare "page not found" with no way
 * to tell a finished document from a broken one.
 *
 * Nothing that can open, fill, sign or decline a document may use this: those
 * routes keep resolveSignRecipientTenant, which fails closed on a revoked link.
 *
 * One route does hand a document back through it: the signed copy, to the
 * browser that just signed (api/signing/[token]/signed). The link is not what
 * authorises that — a pass cookie the sign route set is (signing/signedCopyPass.ts)
 * — and without the pass a revoked link gets the same refusal there as anywhere.
 */
export async function resolveSignRecipientTenantForNotice(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
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
