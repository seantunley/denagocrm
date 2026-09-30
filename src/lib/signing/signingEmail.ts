import "server-only";
import { basePrisma } from "@/lib/db";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { emailBrand } from "@/lib/emailBrand";
import { formatDate } from "@/lib/format";
import { decryptValue } from "@/lib/settings";
import {
  DEFAULT_ACCENT,
  SIGNING_EMAILS,
  parseStoredSigningTemplate,
  renderSigningEmail,
  type RenderedSigningEmail,
  type SigningEmailBrand,
  type SigningEmailKind,
} from "./emailTemplates";

/**
 * Subject, HTML and text for one signing email, from the REQUEST's tenant's
 * template (or the default), in that tenant's brand.
 *
 * Every lookup is keyed on the request's own `tenantId`, read explicitly through
 * basePrisma — never ambient scope — because these sends run from cron, the job
 * worker and the public signing page as often as from a signed-in action.
 *
 * NEVER THROWS. A template or brand lookup that fails must not cost a customer
 * their signing link: it degrades to the default wording, unbranded.
 */
export async function signingEmailContent(
  kind: SigningEmailKind,
  input: { requestId: string; title: string; recipientName: string; signingUrl?: string; code?: string },
): Promise<RenderedSigningEmail> {
  const vars: Record<string, string> = {
    recipient_name: input.recipientName,
    first_name: input.recipientName.trim().split(/\s+/)[0] ?? input.recipientName,
    document_title: input.title,
    signing_link: input.signingUrl ?? "",
    code: input.code ?? "",
  };
  const fallbackBrand: SigningEmailBrand = {
    companyName: DEFAULT_BRAND.displayName,
    tagline: null,
    logoUrl: null,
    accent: DEFAULT_ACCENT,
    accentText: "#ffffff",
    phone: "",
    email: "",
  };
  const unbranded = () => {
    vars.company_name = fallbackBrand.companyName;
    return renderSigningEmail(kind, null, vars, fallbackBrand);
  };
  try {
    const req = await basePrisma.signatureRequest.findUnique({
      where: { id: input.requestId },
      select: { tenantId: true, quoteId: true, createdById: true, expiresAt: true },
    });
    // No request, or one with no owning tenant → nothing to brand as. Never
    // fall through to the default tenant's template, phone, email or logo.
    if (!req?.tenantId) return unbranded();
    const tenantId = req.tenantId;
    const def = SIGNING_EMAILS[kind];
    const [brand, mailBrand, settings, quote, sender] = await Promise.all([
      brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
      emailBrand(tenantId),
      basePrisma.appSetting.findMany({
        where: {
          tenantId,
          key: { in: [def.settingKey, "COMPANY_NAME", "COMPANY_TAGLINE", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_LOGO_URL"] },
        },
        select: { key: true, value: true },
      }),
      req.quoteId
        ? basePrisma.quote.findFirst({ where: { id: req.quoteId, tenantId }, select: { number: true } })
        : null,
      req.createdById ? basePrisma.user.findUnique({ where: { id: req.createdById }, select: { name: true } }) : null,
    ]);
    const setting = (key: string) => {
      const raw = settings.find((s) => s.key === key)?.value ?? "";
      try {
        return decryptValue(raw).trim();
      } catch {
        return "";
      }
    };
    vars.quote_number = quote ? `Q-${quote.number}` : "";
    vars.sender_name = sender?.name ?? "";
    // Company Profile first, then the platform brand — getCompanyProfile()'s
    // order, read in this one query so the send stays keyed on the request's tenant.
    const companyName = setting("COMPANY_NAME") || brand.displayName;
    const tagline = setting("COMPANY_TAGLINE") || brand.tagline;
    vars.company_name = companyName;
    vars.company_phone = setting("COMPANY_PHONE");
    vars.company_email = setting("COMPANY_EMAIL");
    vars.expiry_date = req.expiresAt ? formatDate(req.expiresAt) : "";

    // The public brand-logo route (what campaign mail uses); a typed-in company
    // logo only if it is a public https URL — never a private-store link, which
    // a recipient's mail client cannot fetch.
    const profileLogo = setting("COMPANY_LOGO_URL");
    const logoUrl =
      mailBrand.logoUrl ??
      (/^https:\/\//i.test(profileLogo) && !/\.private\.blob\.|\/api\/stored/i.test(profileLogo) ? profileLogo : null);

    return renderSigningEmail(kind, parseStoredSigningTemplate(setting(def.settingKey)), vars, {
      companyName,
      tagline: tagline || null,
      logoUrl,
      accent: brand.primary ?? DEFAULT_ACCENT,
      accentText: brand.primaryForeground ?? "#ffffff",
      phone: vars.company_phone,
      email: vars.company_email,
    });
  } catch {
    return unbranded();
  }
}
