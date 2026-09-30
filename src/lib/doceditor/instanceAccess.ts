import "server-only";
import { canAccessContact, canAccessLead, canAccessQuote, type PermissionUser } from "@/lib/permissions";

/**
 * A custom document carries its customer's data, so opening, previewing,
 * editing or finalising one needs access to EVERY record it is linked to — the
 * same rule the Studio document page and actions apply. One helper, because the
 * page, the preview route and the actions must never disagree about it.
 */
export async function canAccessDocumentLinks(
  user: PermissionUser,
  links: { contactId?: string | null; leadId?: string | null; quoteId?: string | null },
): Promise<boolean> {
  if (links.contactId && !(await canAccessContact(user, links.contactId))) return false;
  if (links.leadId && !(await canAccessLead(user, links.leadId))) return false;
  if (links.quoteId && !(await canAccessQuote(user, links.quoteId))) return false;
  return true;
}
