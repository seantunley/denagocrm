"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { unstable_rethrow } from "next/navigation";
import { UserRound } from "lucide-react";
import { assignConversation, addConversationNote } from "@/app/actions/conversations";
import { formatDateTime } from "@/lib/format";
import type { ThreadCollaboration } from "@/lib/inboxThreads";

/**
 * Who is dealing with this conversation, and what should the next person know.
 *
 * Rebuilt from PR #17. The two things a shared inbox needs that a personal one
 * does not: an owner, so "is anyone on this?" has an answer that is not a
 * question to the room; and staff-only notes, so the handover context ("promised
 * a callback Tuesday, waiting on stock") sits beside the thread rather than in
 * somebody's memory.
 *
 * Notes are NEVER sent to the customer. That is worth being loud about in the UI,
 * because the box sits directly above a reply box that is.
 */
/**
 * Shown when the call never reaches the server — overwhelmingly a tab older than
 * the running deployment, since a failure INSIDE the action comes back as a value.
 *
 * Stated locally rather than imported: PR #364 introduces the shared sentence in
 * components/actionError.ts, and importing from an unmerged branch is how fifteen
 * PRs came to be stacked on each other and never shipped. Fold this into that
 * constant once #364 is on main.
 */
const NOT_DELIVERED =
  "That did not reach the server, so nothing was saved. If this page has been open a while, refresh it and try again.";

export default function ConversationCollab({
  collaboration,
  staff,
  canAct,
}: {
  collaboration: ThreadCollaboration;
  staff: { id: string; name: string }[];
  canAct: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(collaboration.assignee?.id ?? "");

  const run = (work: () => Promise<{ error?: string; success?: string } | void>) => {
    startTransition(async () => {
      try {
        const result = await work();
        if (result && "error" in result && result.error) {
          toast.error(String(result.error));
          return;
        }
        if (result && "success" in result && result.success) toast.success(String(result.success));
      } catch (error) {
        unstable_rethrow(error);
        toast.error(NOT_DELIVERED);
      }
    });
  };

  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <UserRound className="size-4 shrink-0 text-muted-foreground" />
        <label htmlFor={`assign-${collaboration.conversationId}`} className="text-xs font-medium text-foreground">
          Assigned to
        </label>
        <select
          id={`assign-${collaboration.conversationId}`}
          className="input h-8 max-w-52 py-0 text-xs"
          value={assignee}
          disabled={!canAct || pending}
          onChange={(event) => {
            const next = event.target.value;
            setAssignee(next);
            run(() => assignConversation(collaboration.conversationId, next || null));
          }}
        >
          <option value="">Nobody</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        {collaboration.notes.length > 0 && (
          <ul className="space-y-1.5">
            {collaboration.notes.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-border bg-card px-3 py-2">
                <p className="whitespace-pre-wrap text-xs text-foreground">{entry.body}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {entry.authorName} · {formatDateTime(entry.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canAct && (
          <div className="flex items-start gap-2">
            <textarea
              className="input min-h-9 flex-1 py-1.5 text-xs"
              rows={2}
              placeholder="Internal note — your team only, never sent to the customer"
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
            />
            <button
              type="button"
              className="btn-secondary btn-sm shrink-0"
              disabled={pending || !note.trim()}
              onClick={() =>
                run(async () => {
                  const result = await addConversationNote(collaboration.conversationId, note);
                  // Cleared only on success, so a refused note is not lost from the
                  // box the moment the person is told to fix it.
                  if (!(result && "error" in result && result.error)) setNote("");
                  return result;
                })
              }
            >
              {pending ? "Saving…" : "Add note"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
