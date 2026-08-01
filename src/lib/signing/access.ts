import { prisma } from "@/lib/db";
import { governingBinding as resolveBinding, type RequestBinding } from "./binding";
import {
  canAccessContact,
  canAccessDocument,
  canAccessJobCard,
  canAccessQuote,
  getAccessibleQuoteIds,
  requirePermission,
  type PermissionKey,
  type PermissionUser,
} from "@/lib/permissions";

/**
 * Record-level authorization for signature requests.
 *
 * `recordSigning.ts` already carries this rule — see the comment on
 * `requireRecordSigningAccess` there, which records that module-only
 * authorization "let any crm/workshop user start/resend/void signing on ANY
 * quote or job card by id". The Signatures HUB performs the same lifecycle
 * operations on the same records and never got the same treatment: every action
 * in `signhub.ts` checked the `signing.manage` CAPABILITY and then took the
 * request id straight from the caller.
 *
 * A capability is not an access decision. `signing.manage` says "this person may
 * run signing operations"; it does not say "on this record". With scoped access
 * configured (quotes.view_owned rather than view_all), a holder could act on a
 * signature request belonging to a record they cannot open — and the reachable
 * chain is worse than it looks: point a recipient's email at yourself, resend,
 * and the signing token arrives in your inbox for a document you were never
 * allowed to see.
 *
 * The check is by SOURCE RECORD, because that is what a signature request is
 * about. A request carries any of quoteId / jobCardId / documentId / contactId,
 * and the decision is made against the FIRST one present in that order — not
 * against whichever happens to be reachable.
 *
 * That precedence is load-bearing, and getting it wrong reopens the hole. Most
 * requests carry SEVERAL bindings at once (the one in production carries a
 * quote, a contact and a document). An "access to any binding is enough" rule
 * therefore lets a role holding signing.manage plus documents.view_all — or
 * merely access to the customer — modify and resend a request for a quote it
 * cannot open, which is exactly the escalation this module exists to stop.
 *
 * Quote and job card are the authoritative sources: the document is GENERATED
 * from one of them and the contact is merely its customer, so neither is
 * evidence of access to the underlying deal.
 */

export type { RequestBinding, GoverningBinding } from "./binding";
export { governingBinding } from "./binding";

export async function canAccessSignatureRequest(
  user: PermissionUser,
  request: RequestBinding,
): Promise<boolean> {
  const binding = resolveBinding(request);
  switch (binding?.kind) {
    case "quote":
      return canAccessQuote(user, binding.id);
    case "jobcard":
      return canAccessJobCard(user, binding.id);
    case "document":
      return canAccessDocument(user, binding.id);
    case "contact":
      return canAccessContact(user, binding.id);
  }

  // Bound to nothing — there is no record to derive a decision from, so fall
  // back to the two people who can't be wrong: whoever created it, and anyone
  // whose scope is unrestricted anyway (getAccessibleQuoteIds returns null for
  // owners and quotes.view_all). Production currently has no such request; this
  // exists so an unbound one fails safe rather than throwing.
  if (request.createdById && request.createdById === user.id) return true;
  return (await getAccessibleQuoteIds(user)) === null;
}

/**
 * Capability + record access for a signature request, resolved by id.
 *
 * Returns `null` when the caller may not act, WITHOUT distinguishing "no such
 * request" from "not yours" — the hub's actions already answer "Not found" for
 * both, and keeping them identical is what stops this becoming an existence
 * oracle for other people's documents.
 */
export async function resolveSignatureRequestAccess<T extends RequestBinding>(
  select: () => Promise<T | null>,
  permission: PermissionKey = "signing.manage",
): Promise<{ user: PermissionUser; request: T } | null> {
  const user = await requirePermission(permission);
  const request = await select();
  if (!request) return null;
  if (!(await canAccessSignatureRequest(user, request))) return null;
  return { user, request };
}

/** The binding columns every access check needs — one place, so none drifts. */
export const REQUEST_BINDING_SELECT = {
  quoteId: true,
  jobCardId: true,
  contactId: true,
  documentId: true,
  createdById: true,
} as const;

/**
 * Access to the request a recipient belongs to. `remindRecipient` and
 * `updateRecipientContact` are addressed by RECIPIENT id, so the record they
 * ultimately touch is one hop away — and it is the hop that was missing.
 */
export async function canAccessRecipient(
  user: PermissionUser,
  recipientId: string,
): Promise<boolean> {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    select: { request: { select: REQUEST_BINDING_SELECT } },
  });
  if (!recipient) return false;
  return canAccessSignatureRequest(user, recipient.request);
}
