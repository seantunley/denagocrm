/**
 * What a signature request is ABOUT, when that is neither a quote nor a job card.
 *
 * A quote or job card request names its record in `quoteId` / `jobCardId`, and
 * everything hangs off those: who may open it, what the document renders from,
 * what gets marked signed. A request about anything else names it here instead,
 * in `subjectType` + `subjectId`, and carries that record's values frozen in
 * `contextJson` — nothing locks a test-drive booking while its indemnity is
 * being signed, so the document cannot be left reading the live record.
 *
 * No server imports, like binding.ts: the shapes are checked by tests that
 * cannot load the database. What completing a request does to its subject is in
 * subjectCompletion.ts.
 */
import type { MergeContext } from "@/lib/docbuilder/merge";

/** A test drive's indemnity. `subjectId` is the TestDriveBooking's id. */
export const TEST_DRIVE_INDEMNITY = "test_drive_indemnity";

export type RequestSubject = { type: string; id: string };

/** The columns that say what a request is about, and whose it is. */
export type SubjectRow = { subjectType: string | null; subjectId: string | null; tenantId: string | null };

/**
 * The frozen values a subject's document renders with, or null for anything
 * that is not one — every request made before this existed, and every quote and
 * job card. A stored value of the wrong shape is "none" too: rendering literal
 * {{placeholders}} is a visible fault, a thrown render is a document nobody can
 * open.
 */
export function parseSubjectContext(value: unknown): MergeContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { tokens, items, vars } = value as Partial<MergeContext>;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  return {
    tokens,
    items: Array.isArray(items) ? items : [],
    vars: vars && typeof vars === "object" && !Array.isArray(vars) ? vars : {},
  };
}
