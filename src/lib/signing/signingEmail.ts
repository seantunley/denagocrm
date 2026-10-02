import "server-only";
import { basePrisma } from "@/lib/db";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { emailBrand } from "@/lib/emailBrand";
import { formatDate } from "@/lib/format";
import { decryptValue } from "@/lib/settings";
import {
  DEFAULT_ACCENT,
  SIGNING_EMAILS,
  parseEmailHeaderStyle,
  parseStoredSigningTemplate,
  renderSigningEmail,
  renderSms,
  type RenderedSigningEmail,
  type SigningEmailBrand,
  type SigningEmailKind,
  type StoredSigningTemplate,
} from "./emailTemplates";

const FALLBACK_BRAND: SigningEmailBrand = {
  companyName: DEFAULT_BRAND.displayName,
  tagline: null,
  logoUrl: null,
  accent: DEFAULT_ACCENT,
  accentText: "#ffffff",
  phone: "",
  email: "",
};

/**
 * One email of `kind`, rendered from `tenantId`'s own template (or the default,
 * or `override` when the sender edited this one message) in that tenant's brand.
 *
 * Every lookup is keyed on the tenantId the CALLER names — the signature
 * request's, the quote's — read explicitly through basePrisma, never ambient
 * scope, because these sends run from cron, the job worker and public pages as
 * often as from a signed-in action.
 *
 * `vars` supplies the record's own fields; the company fields are filled here.
 * NEVER THROWS: a failed lookup degrades to the default wording, unbranded.
 */
export async function tenantEmailContent(
  kind: SigningEmailKind,
  tenantId: string | null,
  vars: Record<string, string>,
  override?: StoredSigningTemplate | null,
): Promise<RenderedSigningEmail> {
  const unbranded = () =>
    renderSigningEmail(kind, override ?? null, { ...vars, company_name: FALLBACK_BRAND.companyName }, FALLBACK_BRAND);
  // No owning tenant → nothing to brand as. Never fall through to the default
  // tenant's template, phone, email or logo.
  if (!tenantId) return unbranded();
  try {
    const def = SIGNING_EMAILS[kind];
    const [brand, mailBrand, settings] = await Promise.all([
      brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
      emailBrand(tenantId),
      basePrisma.appSetting.findMany({
        where: {
          tenantId,
          key: { in: [def.settingKey, "COMPANY_NAME", "COMPANY_TAGLINE", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_LOGO_URL", "EMAIL_HEADER_STYLE"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    const setting = (key: string) => {
      const raw = settings.find((s) => s.key === key)?.value ?? "";
      try {
        return decryptValue(raw).trim();
      } catch {
        return "";
      }
    };
    // Company Profile first, then the platform brand — getCompanyProfile()'s
    // order, read in this one query so the send stays keyed on the caller's tenant.
    const companyName = setting("COMPANY_NAME") || brand.displayName;
    const tagline = setting("COMPANY_TAGLINE") || brand.tagline;
    const all = { ...vars, ...companyFields(companyName, setting("COMPANY_PHONE"), setting("COMPANY_EMAIL")) };

    // The public brand-logo route (what campaign mail uses); a typed-in company
    // logo only if it is a public https URL — never a private-store link, which
    // a recipient's mail client cannot fetch.
    const profileLogo = setting("COMPANY_LOGO_URL");
    const logoUrl =
      mailBrand.logoUrl ??
      (/^https:\/\//i.test(profileLogo) && !/\.private\.blob\.|\/api\/stored/i.test(profileLogo) ? profileLogo : null);

    return renderSigningEmail(kind, override ?? parseStoredSigningTemplate(setting(def.settingKey), kind), all, {
      companyName,
      tagline: tagline || null,
      logoUrl,
      accent: brand.primary ?? DEFAULT_ACCENT,
      accentText: brand.primaryForeground ?? "#ffffff",
      phone: all.company_phone,
      email: all.company_email,
      header: parseEmailHeaderStyle(setting("EMAIL_HEADER_STYLE")),
    });
  } catch {
    return unbranded();
  }
}

/** The company merge fields, the same for every message. `company_contact` reads "Acme on 021 000 0000" (companyContactPhrase). */
function companyFields(name: string, phone: string, email: string) {
  return { company_name: name, company_phone: phone, company_email: email, company_contact: phone ? `${name} on ${phone}` : name };
}

/**
 * One SMS of `kind`, from `tenantId`'s own template (or the default), with the
 * company fields from that tenant's Company Profile. Same rules as
 * tenantEmailContent: explicit tenant, never the default tenant's wording, and
 * NEVER THROWS — a failed lookup still sends the default text.
 */
export async function tenantSmsContent(
  kind: SigningEmailKind,
  tenantId: string | null,
  vars: Record<string, string>,
  /** The unsaved draft, for the Settings preview. */
  override?: StoredSigningTemplate | null,
): Promise<string> {
  const plain = () => renderSms(kind, override ?? null, { ...vars, ...companyFields(DEFAULT_BRAND.displayName, "", "") });
  if (!tenantId) return plain();
  try {
    const def = SIGNING_EMAILS[kind];
    const [brand, settings] = await Promise.all([
      brandForTenant(tenantId).catch(() => DEFAULT_BRAND),
      basePrisma.appSetting.findMany({
        where: { tenantId, key: { in: [def.settingKey, "COMPANY_NAME", "COMPANY_PHONE", "COMPANY_EMAIL"] } },
        select: { key: true, value: true },
      }),
    ]);
    const setting = (key: string) => {
      const raw = settings.find((s) => s.key === key)?.value ?? "";
      try {
        return decryptValue(raw).trim();
      } catch {
        return "";
      }
    };
    const company = companyFields(setting("COMPANY_NAME") || brand.displayName, setting("COMPANY_PHONE"), setting("COMPANY_EMAIL"));
    return renderSms(kind, override ?? parseStoredSigningTemplate(setting(def.settingKey), kind), { ...vars, ...company });
  } catch {
    return plain();
  }
}

/**
 * Subject, HTML and text for one signing email, from the REQUEST's tenant's
 * template (or the default), in that tenant's brand.
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
  try {
    const req = await basePrisma.signatureRequest.findUnique({
      where: { id: input.requestId },
      select: { tenantId: true, quoteId: true, createdById: true, expiresAt: true },
    });
    if (!req?.tenantId) return tenantEmailContent(kind, null, vars);
    const tenantId = req.tenantId;
    const [quote, sender] = await Promise.all([
      req.quoteId
        ? basePrisma.quote.findFirst({ where: { id: req.quoteId, tenantId }, select: { number: true } })
        : null,
      req.createdById ? basePrisma.user.findUnique({ where: { id: req.createdById }, select: { name: true } }) : null,
    ]);
    vars.quote_number = quote ? `Q-${quote.number}` : "";
    vars.sender_name = sender?.name ?? "";
    vars.expiry_date = req.expiresAt ? formatDate(req.expiresAt) : "";
    return tenantEmailContent(kind, tenantId, vars);
  } catch {
    return tenantEmailContent(kind, null, vars);
  }
}
