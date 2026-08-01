import { prisma } from "@/lib/db";
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
 * about. A request carries any of quoteId / jobCardId / contactId / documentId;
 * access to ANY of the records it is bound to grants access to the request,
 * which matches how it is reachable in the UI in the first place.
 */

type RequestBinding = {
  quoteId: string | null;
  jobCardId: string | null;
  contactId: string | null;
  documentId: string | null;
  createdById: string | null;
};

export async function canAccessSignatureRequest(
  user: PermissionUser,
  request: RequestBinding,
): Promise<boolean> {
  const checks: Array<Promise<boolean>> = [];
  if (request.quoteId) checks.push(canAccessQuote(user, request.quoteId));
  if (request.jobCardId) checks.push(canAccessJobCard(user, request.jobCardId));
  if (request.documentId) checks.push(canAccessDocument(user, request.documentId));
  if (request.contactId) checks.push(canAccessContact(user, request.contactId));

  if (checks.length === 0) {
    // Bound to nothing — there is no record to derive a decision from, so fall
    // back to the two people who can't be wrong: whoever created it, and anyone
    // whose scope is unrestricted anyway (getAccessibleQuoteIds returns null for
    // owners and quotes.view_all). Production currently has no such request;
    // this exists so an unbound one fails safe rather than throwing.
    if (request.createdById && request.createdById === user.id) return true;
    return (await getAccessibleQuoteIds(user)) === null;
  }

  return (await Promise.all(checks)).some(Boolean);
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
