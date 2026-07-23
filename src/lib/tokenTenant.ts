import "server-only";
import { basePrisma } from "./db";

/**
 * Trusted PRE-SCOPE tenant resolvers for the no-user token surfaces (public
 * signing + approval pages/routes, campaign open/click tracking, unsubscribe).
 *
 * Each does a DELIBERATELY NARROW `basePrisma` lookup — the owning `tenantId` only,
 * keyed by the public token — so the request's tenant can be established BEFORE any
 * guarded read. This mirrors `resolvePortalTenant` in portal.ts: `basePrisma` (the
 * unguarded client) is correct and REQUIRED here, because the tenant guard has no
 * scope yet and this is the single trusted boundary the public surface crosses
 * before its scope exists. A guarded read at this point would dead-lock (no scope →
 * `TenantScopeError`). Returns null for an unknown token so the caller fails closed.
 *
 * These are the ONE resolver per token type shared by the page and its mutation
 * route, so the read surface and the write surface can never drift onto different
 * tenant-derivation logic.
 */

/** Owning tenant of a per-recipient signing token (from the parent request). */
export async function resolveSignRecipientTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.signatureRecipient.findUnique({
    where: { token },
    select: { request: { select: { tenantId: true } } },
  });
  return row ? { tenantId: row.request.tenantId } : null;
}

/** Owning tenant of an approval-step token. */
export async function resolveApprovalStepTenant(
  token: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.approvalStep.findUnique({
    where: { token },
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

/** Owning tenant of a provider campaign event keyed by our opaque recipient id. */
export async function resolveCampaignRecipientIdTenant(
  recipientId: string,
): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.campaignRecipient.findUnique({
    where: { id: recipientId },
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
