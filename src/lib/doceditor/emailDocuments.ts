import "server-only";
import { basePrisma } from "@/lib/db";
import { decryptValue } from "@/lib/settings";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { emailBrand } from "@/lib/emailBrand";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { CARD_ORANGE, parseSignatureDesign, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { parseDocument, type DocumentModel } from "./model";
import { EMAIL_FRAME_KEY, emailBodyKey } from "./emailDefaults";
import type { EmailBrand } from "./emailRender";
import type { SigningEmailKind } from "../signing/emailTemplates";

/**
 * How a workspace's customer emails look: its name and details (Company
 * profile first, then the platform brand), its logo (the public brand-logo
 * route, or a public https Company profile logo — never a private-store link,
 * which a mail app cannot load), the signature's logo-panel banner, its colour,
 * and the origin its icons are served from. By EXPLICIT tenant; never throws.
 */
export async function emailBrandFor(tenantId: string): Promise<EmailBrand> {
  const [brand, mailBrand, rows, origin] = await Promise.all([
    brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
    emailBrand(tenantId).catch(() => ({ logoUrl: null })),
    basePrisma.appSetting
      .findMany({
        where: {
          tenantId,
          key: { in: ["COMPANY_NAME", "COMPANY_TAGLINE", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_ADDRESS", "COMPANY_WEBSITE", "COMPANY_LOGO_URL", SIGNATURE_DESIGN_KEY] },
        },
        select: { key: true, value: true },
      })
      .catch(() => []),
    tenantOrigin(tenantId),
  ]);
  const setting = (key: string) => {
    const raw = rows.find((r) => r.key === key)?.value ?? "";
    try {
      return decryptValue(raw).trim();
    } catch {
      return "";
    }
  };
  const profileLogo = setting("COMPANY_LOGO_URL");
  return {
    companyName: setting("COMPANY_NAME") || brand.displayName,
    tagline: setting("COMPANY_TAGLINE") || brand.tagline || "",
    address: setting("COMPANY_ADDRESS"),
    phone: setting("COMPANY_PHONE"),
    email: setting("COMPANY_EMAIL"),
    website: setting("COMPANY_WEBSITE"),
    logoUrl:
      mailBrand.logoUrl ??
      (/^https:\/\//i.test(profileLogo) && !/\.private\.blob\.|\/api\/stored/i.test(profileLogo) ? profileLogo : ""),
    bannerUrl: parseSignatureDesign(setting(SIGNATURE_DESIGN_KEY)).bannerUrl,
    accent: brand.primary ?? CARD_ORANGE,
    assetBase: origin,
  };
}

/**
 * The PUBLISHED email frame and one message's PUBLISHED body for a workspace —
 * what customers get. A draft (seeded or autosaved, never published) is not
 * here: nobody approved it, so the message keeps sending as it does until
 * someone presses Publish (the same rule as documents, docbuilder/published.ts).
 *
 * Read by EXPLICIT tenant on basePrisma, never ambient scope: emails go out
 * from cron, the job worker and public signing pages as often as from a
 * signed-in action. Never throws — a failed read is "not published".
 */
export async function publishedEmailDocs(
  tenantId: string,
  kind: SigningEmailKind,
): Promise<{ frame: DocumentModel | null; body: DocumentModel | null }> {
  try {
    const templates = await basePrisma.docBuilderTemplate.findMany({
      where: { tenantId, key: { in: [EMAIL_FRAME_KEY, emailBodyKey(kind)] }, deletedAt: null, publishedVersion: { not: null } },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, key: true, publishedVersion: true },
    });
    const load = async (key: string) => {
      const template = templates.find((t) => t.key === key);
      if (!template || template.publishedVersion == null) return null;
      const version = await basePrisma.docBuilderVersion.findUnique({
        where: { templateId_version: { templateId: template.id, version: template.publishedVersion } },
        select: { data: true, tenantId: true },
      });
      // The version belongs to the template's workspace — never another's.
      return version && (version.tenantId === null || version.tenantId === tenantId) ? parseDocument(version.data) : null;
    };
    const [frame, body] = await Promise.all([load(EMAIL_FRAME_KEY), load(emailBodyKey(kind))]);
    return { frame, body };
  } catch {
    return { frame: null, body: null };
  }
}
