import { prisma } from "@/lib/db";
import { accessibleRequestWhere, governingBinding as resolveBinding, type RequestBinding } from "./binding";
import { canActOnStep } from "./approvals";
import { CLOSED_REQUEST_STATUSES } from "./statusPolicy";
import {
  canAccessContact,
  canAccessDocument,
  canAccessJobCard,
  canAccessQuote,
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleJobCardIds,
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
 * The list form of {@link canAccessSignatureRequest}: a `where` fragment for
 * "the signature requests this person may open".
 *
 * The Signatures page listed every request in the workspace to anyone holding
 * `signing.view` — titles, signers' names and email addresses, who had opened
 * what — while every button on it refused the ones outside their records. An
 * owner is unrestricted and gets no filter; everyone else gets the same
 * precedence the single-record check applies, built from the same four scopes.
 */
export async function accessibleSignatureRequestWhere(user: PermissionUser) {
  if (user.role === "owner") return {};
  const [quoteIds, jobCardIds, documentIds, contactIds] = await Promise.all([
    getAccessibleQuoteIds(user),
    getAccessibleJobCardIds(user),
    getAccessibleDocumentIds(user),
    getAccessibleContactIds(user),
  ]);
  return accessibleRequestWhere({ quoteIds, jobCardIds, documentIds, contactIds, userId: user.id });
}

/**
 * The approval steps the Signatures page offers this person: ones they may decide (canActOnStep — the assigned
 * approver, or the owner) on requests they may OPEN (the list rule above). Both, never either (review of #1111: the
 * panel checked only the assignee, so it named and linked a delivery note on another rep's deal). An assigned approver
 * who can't open the deal still has the approval link emailed to them.
 */
export async function pendingApprovalsFor(user: PermissionUser) {
  const mine = await accessibleSignatureRequestWhere(user);
  const steps = await prisma.approvalStep.findMany({
    where: {
      status: "pending",
      // canActOnStep's own rule, in the query BEFORE the limit (re-review of #1111): filtered only afterwards, the first
      // 100 pending steps could all be other approvers' and hide this person's.
      ...(user.role === "owner" ? {} : { assigneeType: "staff", assigneeUserId: user.id }),
      request: { deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] }, AND: [mine] },
    },
    include: { request: { select: { id: true, title: true } } },
    orderBy: { createdAt: "asc" },
    // A display limit: the oldest 100 this person may decide. An owner may decide every step, so for an owner it is the
    // workspace's oldest 100 pending (#1114).
    take: 100,
  });
  return steps.filter((step) => canActOnStep(step, user));
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
  subjectType: true,
  subjectId: true,
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
