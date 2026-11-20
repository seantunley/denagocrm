import "server-only";
import QRCode from "qrcode";
import { basePrisma } from "./db";
import { isModuleEnabled } from "./modules/enabled";
import { getCompanyProfile } from "./companyProfile";
import { getWorkspaceSetting } from "./settings";
import { runInTenantScope } from "./tenantScope";
import { parseSignatureDesign, SIGNATURE_DESIGN_KEY, type SignatureDesign } from "./signature";
import { vCard } from "./contactCard";
import { verifyContactCardToken } from "./contactCardToken";

export { contactCardLinks, contactCardPath, verifyContactCardToken } from "./contactCardToken";

/*
 * "Save my contact" (lib/contactCard.ts): the card a signed link (lib/contactCardToken.ts) serves. The card is served
 * only while the person is still in that workspace, the workspace is active, the pack is on and the owner's "Save my
 * contact" is on. Anything else is "not found".
 */

/** The card for a token: the person's details as their signature shows them, or null ("not found"). */
export async function contactCardFor(token: string): Promise<{ name: string; vcf: string; design: SignatureDesign } | null> {
  const who = verifyContactCardToken(token);
  if (!who) return null;
  const { tenantId, userId } = who;
  return runInTenantScope({ tenantId, system: false }, async () => {
    const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { active: true } });
    if (!tenant?.active || !(await isModuleEnabled("signatures"))) return null;
    const design = parseSignatureDesign(await getWorkspaceSetting(tenantId, SIGNATURE_DESIGN_KEY));
    if (!design.contactCard) return null;
    const person = await basePrisma.user.findFirst({
      // Still in this workspace: someone who left stops being handed out from their old emails.
      where: { id: userId, memberships: { some: { tenantId } } },
      select: { name: true, email: true, mobile: true, jobTitle: true, signatureDirectLine: true, signatureWhatsapp: true },
    });
    if (!person) return null;
    const profile = await getCompanyProfile(tenantId);
    return {
      name: person.name,
      design,
      vcf: vCard(
        { name: person.name, email: person.email, mobile: person.mobile, jobTitle: person.jobTitle, directLine: person.signatureDirectLine, whatsapp: person.signatureWhatsapp },
        { name: profile.name, website: profile.website, switchboard: profile.phone, address: profile.address },
      ),
    };
  });
}

/** The QR code for a card link: a PNG, black on white, with the quiet margin phone cameras need. */
export function contactQrPng(cardUrl: string): Promise<Buffer> {
  return QRCode.toBuffer(cardUrl, { type: "png", width: 240, margin: 2, errorCorrectionLevel: "M" });
}
