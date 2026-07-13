"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  assignConversation,
  addConversationNote,
  markConversationReadAction,
} from "@/app/actions/conversations";

export type CollabNote = { id: string; authorName: string; body: string; createdAt: string };

/**
 * Phase-2 collaboration panel shown inside a conversation: assignment, internal
 * notes, and (on open) clearing the unread flag. Sits alongside the reply box.
 */
export default function ConversationCollab({
  conversationId,
  staff,
  assignedToId,
  notes: initialNotes,
  unread,
  meName,
}: {
  conversationId: string;
  staff: { id: string; name: string }[];
  assignedToId: string | null;
  notes: CollabNote[];
  unread: boolean;
  meName: string;
}) {
  const [assignee, setAssignee] = useState<string>(assignedToId ?? "");
  const [assignPending, startAssign] = useTransition();
  const [notes, setNotes] = useState<CollabNote[]>(initialNotes);
  const [noteBody, setNoteBody] = useState("");
  const [notePending, startNote] = useTransition();

  // Opening the thread clears its unread flag (the modal body mounts on open).
  const marked = useRef(false);
  useEffect(() => {
    if (unread && !marked.current) {
      marked.current = true;
      void markConversationReadAction(conversationId);
    }
  }, [unread, conversationId]);

  function onAssign(value: string) {
    setAssignee(value);
    startAssign(() => {
      void assignConversation(conversationId, value || null);
    });
  }

  function submitNote() {
    const body = noteBody.trim();
    if (!body) return;
    // Optimistic — the server also persists + audit-logs it.
    setNotes((prev) => [
      { id: `tmp-${prev.length}`, authorName: meName, body, createdAt: "just now" },
      ...prev,
    ]);
    setNoteBody("");
    startNote(() => {
      void addConversationNote(conversationId, body);
    });
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      {/* Assignment */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-400">Assigned to</span>
        <select
          value={assignee}
          onChange={(e) => onAssign(e.target.value)}
          className="input py-1 text-sm"
          disabled={assignPending}
        >
          <option value="">Unassigned</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {assignPending && <span className="text-[11px] text-slate-500">saving…</span>}
      </div>

      {/* Internal notes */}
      <div>
        <p className="mb-1 text-xs font-medium text-slate-400">
          Internal notes <span className="font-normal text-slate-500">· team-only, never sent to the customer</span>
        </p>
        {notes.length > 0 && (
          <ul className="mb-2 space-y-1.5">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg bg-amber-500/[0.07] px-2.5 py-1.5 text-sm">
                <p className="whitespace-pre-wrap text-slate-200">{n.body}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {n.authorName} · {n.createdAt}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            rows={1}
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitNote();
              }
            }}
            placeholder="Add an internal note…"
            className="input flex-1 resize-none py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={submitNote}
            disabled={notePending || !noteBody.trim()}
            className="btn-secondary btn-sm shrink-0 disabled:opacity-50"
          >
            Note
          </button>
        </div>
      </div>
    </div>
  );
}
