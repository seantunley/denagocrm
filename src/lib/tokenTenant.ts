import "server-only";
import { basePrisma } from "./db";
import { hashSignToken } from "./signing/tokens";

export async function resolveSignRecipientTenant(token: string): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: { request: { select: { tenantId: true } } },
  });
  return row ? { tenantId: row.request.tenantId } : null;
}

export async function resolveApprovalStepTenant(token: string): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.approvalStep.findUnique({ where: { token: hashSignToken(token) }, select: { tenantId: true } });
  return row ? { tenantId: row.tenantId } : null;
}

export async function resolveCampaignRecipientTenant(token: string): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.campaignRecipient.findUnique({ where: { token }, select: { tenantId: true } });
  return row ? { tenantId: row.tenantId } : null;
}

export async function resolveSurveyResponseTenant(token: string): Promise<{ tenantId: string | null } | null> {
  const row = await basePrisma.surveyResponse.findUnique({ where: { token }, select: { tenantId: true } });
  return row ? { tenantId: row.tenantId } : null;
}
