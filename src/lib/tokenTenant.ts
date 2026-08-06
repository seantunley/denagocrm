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
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
}

export async function resolveApprovalStepTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.approvalStep.findUnique({
    where: { token: hashSignToken(token) },
    select: { tenantId: true },
  });
  return row ? { tenantId: row.tenantId } : null;
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
