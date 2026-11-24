"use server";

import { withActingStaffScope } from "@/lib/actingScope";
import { requireUser } from "@/lib/auth";
import { loadLeadPeek, type LeadPeek } from "@/lib/records/leadPeek";
import { parseRecordRef } from "@/lib/records/ref";

export type RecordPeek = LeadPeek;
export type PeekResult = { ok: true; peek: RecordPeek } | { ok: false; error: string };

/**
 * The contextual drawer's one read (wave 2, W2-01). Read-only. Wrapped in
 * `withActingStaffScope` like actions/capture.ts: a Server Action does not inherit
 * the scope a page render establishes. A record the person may not open, another
 * workspace's, or a deleted one all answer the same way — nothing about it leaks.
 */
export async function peekRecord(open: string): Promise<PeekResult> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const ref = parseRecordRef(open);
    const gone: PeekResult = { ok: false, error: "This record isn't available — it may have been deleted, or you don't have access to it." };
    if (!ref) return gone;
    const peek = ref.type === "lead" ? await loadLeadPeek(user, ref.id) : null;
    return peek ? { ok: true, peek } : gone;
  });
}
