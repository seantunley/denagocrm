import "server-only";
import { basePrisma } from "./db";
import { resolveApprovalToken, resolveSigningRecipientToken } from "./signing/tokenVault";

/**
 * Trusted PRE-SCOPE tenant resolvers for no-user token surfaces. Signing and
 * approval secrets are resolved by SHA-256 digest through the token vault; the
 * plaintext token is never compared with ciphertext at rest. Campaign/survey
 * tokens retain their existing model-specific resolver.
 */

export async function resolveSignRecipientTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const owner = await resolveSigningRecipientToken(token);
  return owner ? { tenantId: owner.tenantId } : null;
}

export async function resolveApprovalStepTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const owner = await resolveApprovalToken(token);
  return owner ? { tenantId: owner.tenantId } : null;
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
