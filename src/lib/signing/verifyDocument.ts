import "server-only";
import { basePrisma } from "@/lib/db";
import { runInTenantScope } from "@/lib/tenantScope";
import { resolveSealedDocument } from "@/lib/tokenTenant";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getRegionalSettings } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import { verifyTimestampToken } from "./timestampVerify";
import { NOT_GENUINE, type DocumentVerdict } from "./verifyVerdict";

/**
 * "Is this the document that was signed?" — answered for anyone holding the file.
 *
 * A sealed PDF already proves itself to someone who knows how to read a
 * signature panel. Most people who are handed a contract do not, and the panel
 * says the signer is "unknown" for a company's own certificate. This is the
 * plain answer: the file's fingerprint is compared with the one recorded when
 * the document was sealed. Identical bytes, identical fingerprint; one changed
 * character and it no longer matches.
 *
 * The answer (verifyVerdict.ts) names the workspace that sealed it, when, and
 * how many people signed — what the holder can already read in the file.
 */
export async function verifySealedDocument(sha256: string): Promise<DocumentVerdict> {
  const digest = sha256.trim().toLowerCase();
  const sealed = await resolveSealedDocument(digest);
  if (!sealed) return NOT_GENUINE;

  // The workspace is the one the custody row names, and it is named on the read.
  // Not the guarded client: that hides a trashed request, and a signed document
  // is still genuine after somebody has tidied the request away.
  const request = await basePrisma.signatureRequest.findFirst({
    where: { id: sealed.requestId, tenantId: sealed.tenantId },
    select: {
      title: true,
      status: true,
      completedAt: true,
      signedPdfHash: true,
      timestampToken: true,
      recipients: { where: { role: { not: "viewer" }, status: "signed" }, select: { id: true } },
    },
  });
  // Both records must agree. The custody row says a file with this fingerprint
  // was sealed; the request says which document it completed with.
  if (!request || request.status !== "completed" || request.signedPdfHash !== digest || !request.completedAt) return NOT_GENUINE;

  const completedAt = request.completedAt;
  return runInTenantScope({ tenantId: sealed.tenantId, system: false }, async () => {
    const [company, regional] = await Promise.all([getCompanyProfile(sealed.tenantId), getRegionalSettings()]);
    return {
      genuine: true,
      sealedBy: company.name,
      title: request.title,
      sealedAt: formatDateTime(completedAt, regional),
      timeZone: regional.timeZone,
      signers: request.recipients.length,
      timestamped: Boolean(request.timestampToken) && verifyTimestampToken(request.timestampToken!, Buffer.from(digest, "hex")).ok,
    };
  });
}
