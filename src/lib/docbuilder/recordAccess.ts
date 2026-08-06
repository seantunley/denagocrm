import "server-only";
import { canAccessJobCard, canAccessQuote, type PermissionUser } from "@/lib/permissions";
import type { BuilderRecordKind } from "./recordBinding";

/**
 * May this caller have THIS record rendered into a document?
 *
 * `docbuilder.view` / `docbuilder.manage` answer a different question — "may this
 * person work with document templates at all". The record id arrives separately,
 * off a form field or a query string, and nothing in the template permission says
 * anything about it. So the two have to be checked separately, and the record
 * check is the one that was missing.
 *
 * THE ONLY place that decision is made. `validatedBinding` in actions/doceditor.ts
 * had it; the two API routes that render the same templates from the same ids did
 * not — `/api/pdf/doc-editor/[id]` returned any quote or job card as a PDF, and
 * `/api/doc-editor/[id]/export` returned any quote as HTML, an email body or a Word
 * document, complete with pricing, line items and the customer contact block. A
 * `docbuilder.view` holder with no quotes permission needed only the id.
 *
 * That split is exactly how it happened: the action grew the check and the routes
 * were never updated with it. One function, three call sites, and a test that
 * counts them.
 */
export async function canAccessBuilderRecord(
  user: PermissionUser,
  record: { kind: BuilderRecordKind; id: string },
): Promise<boolean> {
  return record.kind === "quote"
    ? canAccessQuote(user, record.id)
    : canAccessJobCard(user, record.id);
}

/**
 * The one refusal message for an inaccessible record.
 *
 * Identical whether the record does not exist or the caller may not see it: two
 * different answers turn any of these endpoints into an existence oracle for
 * records the caller has no business enumerating.
 */
export const RECORD_UNAVAILABLE = "That record isn't available.";
