"use server";

import { withActingStaffScope } from "@/lib/actingScope";
import { requireUser } from "@/lib/auth";
import { PALETTE_KINDS, searchCrm } from "@/lib/crmSearch";
import { SEARCH_HITS_PER_TYPE, type SearchHit } from "@/lib/recordSearch";

/**
 * Record search for the command palette: the search everything else uses (lib/crmSearch.ts), trimmed to what a
 * dropdown can show — the records people look up by name and the messages that mention it, five each, with "search
 * everything" one keystroke away.
 *
 * Wrapped in `withActingStaffScope`: a Server Action does NOT inherit the scope a page render establishes, and every
 * read is tenant-guarded, so without it this throws under enforcement. Permissions are the CRM's own access lists,
 * inside searchCrm — a second resolver written for a search box is how a search box becomes a way round them.
 *
 * The type, the minimum term and the per-type cap live in `@/lib/recordSearch`: a `"use server"` module may only export
 * async functions (a build-time rule tsc cannot see).
 */
export async function searchRecords(rawTerm: string): Promise<SearchHit[]> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    return searchCrm(user, rawTerm, { kinds: PALETTE_KINDS, perKind: SEARCH_HITS_PER_TYPE });
  });
}
