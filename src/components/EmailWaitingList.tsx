"use client";

import { useEffect, useState } from "react";
import { cancelScheduledEmail, discardEmailDraft, emailDraftsOnRecord } from "@/app/actions/emails";
import type { DraftSummary } from "@/lib/emailDrafts";
import { formatDateTime } from "@/lib/format";

/**
 * What waits on this record (lib/emailDrafts.ts), under the composer's button:
 * your own drafts, and EVERY scheduled email to this customer — whoever
 * scheduled it, and when it goes — so nothing reaches them that the team cannot
 * see coming. Yours can be continued, edited or cancelled here.
 */
export default function EmailWaitingList({
  contactId,
  leadId,
  revalidate,
  refreshKey,
  onOpen,
}: {
  contactId?: string;
  leadId?: string;
  revalidate: string;
  /** Bumped by the composer after anything that changes the list. */
  refreshKey: number;
  /** Open a draft (or take back a scheduled send) in the composer. Returns a problem to show, if any. */
  onOpen: (id: string) => Promise<string | undefined>;
}) {
  const [items, setItems] = useState<DraftSummary[]>([]);
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [localKey, setLocalKey] = useState(0);
  useEffect(() => {
    let alive = true;
    emailDraftsOnRecord({ contactId, leadId }).then((list) => alive && setItems(list), () => {});
    return () => { alive = false; };
  }, [contactId, leadId, refreshKey, localKey]);
  if (items.length === 0 && !problem) return null;

  const act = async (work: () => Promise<string | undefined | void>) => {
    setProblem("");
    const said = await work();
    if (said) setProblem(said);
    setConfirming(null);
    setLocalKey((k) => k + 1);
  };
  const button = "cursor-pointer text-xs text-orange-400 hover:underline";

  return (
    <div className="card mt-2 space-y-2 py-3" data-testid="email-waiting">
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="shrink-0">
            {item.status === "draft" ? "📝 Draft" : item.status === "scheduled" ? "🕒 Scheduled" : item.status === "sending" ? "📤 Sending" : "⚠️ Not sent"}
          </span>
          <span className="min-w-0 flex-1 truncate text-slate-300">
            “{item.subject || "(no subject)"}”{item.to ? ` to ${item.to}` : ""}
            <span className="text-slate-500">
              {item.status === "draft" && ` · saved ${formatDateTime(item.updatedAt)}`}
              {item.status === "scheduled" && item.sendAt && ` · goes ${formatDateTime(item.sendAt)}`}
              {item.status !== "draft" && ` · by ${item.mine ? "you" : item.author}`}
            </span>
            {item.status === "sending" && <span className="block text-xs text-amber-300">Going now — or it stopped part-way. Check the timeline before sending it again.</span>}
            {item.status === "failed" && item.error && <span className="block text-xs text-amber-300">{item.error}</span>}
          </span>
          {item.mine && item.status === "draft" && (
            <>
              <button type="button" className={button} onClick={() => act(() => onOpen(item.id))}>Continue</button>
              {confirming === item.id ? (
                <button type="button" className={`${button} text-red-400`} onClick={() => act(() => discardEmailDraft(item.id))}>Discard it — sure?</button>
              ) : (
                <button type="button" className={button} onClick={() => setConfirming(item.id)}>Discard</button>
              )}
            </>
          )}
          {item.mine && (item.status === "scheduled" || item.status === "failed") && (
            <button type="button" className={button} onClick={() => act(() => onOpen(item.id))}>Edit</button>
          )}
          {item.mine && (item.status === "scheduled" || item.status === "failed") && (
            <button type="button" className={button} onClick={() => act(async () => (await cancelScheduledEmail(item.id, revalidate)).error)}>
              {item.status === "failed" ? "Dismiss" : "Cancel"}
            </button>
          )}
        </div>
      ))}
      {problem && <p className="text-xs text-red-400">{problem}</p>}
    </div>
  );
}
