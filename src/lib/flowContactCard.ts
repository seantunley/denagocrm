import { basePrisma, prisma } from "./db";
import { getCompanyProfile } from "./companyProfile";
import { businessNumberFromLabel } from "./assistantWhatsAppRules";
import type { ContactCard } from "./flow";

/**
 * The workspace's WhatsApp business number, read from its endpoint label
 * ("Verified name · +27 21 123 4567" — see businessNumberFromLabel). Null when
 * the label carries no number.
 */
export async function businessWhatsApp(tenantId: string): Promise<{ display: string; digits: string } | null> {
  const endpoint = await basePrisma.channelIdentity.findFirst({
    where: { tenantId, channel: "whatsapp", disabledAt: null },
    orderBy: { createdAt: "asc" },
    select: { label: true },
  });
  return businessNumberFromLabel(endpoint?.label);
}

function distinctPhones(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const phone = value?.trim();
    const digits = phone?.replace(/\D/g, "");
    if (!phone || !digits || seen.has(digits)) continue;
    seen.add(digits);
    out.push(phone);
  }
  return out;
}

/**
 * The card a "Send contact card" node sends, built from Settings → Company (and
 * the WhatsApp business number), or from one staff member of THIS workspace.
 * Null when there is nothing to send: no company name, or a staff member who is
 * no longer a member here.
 */
export async function flowContactCard(tenantId: string, staffUserId?: string): Promise<ContactCard | null> {
  const [company, whatsapp] = await Promise.all([getCompanyProfile(tenantId), businessWhatsApp(tenantId)]);
  const organization = company.name.trim() || undefined;
  const shared = {
    ...(company.website.trim() ? { website: company.website.trim() } : {}),
    ...(company.address.trim() ? { address: company.address.trim() } : {}),
  };
  if (staffUserId) {
    const member = await prisma.tenantMember.findFirst({
      where: { tenantId, userId: staffUserId },
      select: { user: { select: { name: true, email: true, mobile: true, jobTitle: true } } },
    });
    if (!member) return null;
    const { user } = member;
    return {
      name: user.name,
      ...(organization ? { organization } : {}),
      ...(user.jobTitle?.trim() ? { title: user.jobTitle.trim() } : {}),
      phones: distinctPhones([user.mobile, company.phone, whatsapp?.display]),
      email: user.email,
      ...shared,
    };
  }
  if (!organization) return null;
  return {
    name: organization,
    organization,
    phones: distinctPhones([company.phone, whatsapp?.display]),
    ...(company.email.trim() ? { email: company.email.trim() } : {}),
    ...shared,
  };
}
