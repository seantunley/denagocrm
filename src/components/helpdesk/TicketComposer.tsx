"use client";

import { useState } from "react";
import { MessageSquare, StickyNote, Send } from "lucide-react";
import { cn } from "@/lib/utils";

type Canned = { id: string; title: string; body: string };

/**
 * Reply / internal-note composer for the staff ticket view. Public replies go to
 * the customer (and set the ticket status); notes are staff-only.
 */
export function TicketComposer({
  replyAction,
  noteAction,
  cannedReplies,
  statusOptions,
  signature,
}: {
  replyAction: (formData: FormData) => void | Promise<void>;
  noteAction: (formData: FormData) => void | Promise<void>;
  cannedReplies: Canned[];
  statusOptions: { value: string; label: string }[];
  signature?: string | null;
}) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [body, setBody] = useState("");

  function applyCanned(id: string) {
    const canned = cannedReplies.find((c) => c.id === id);
    if (!canned) return;
    setBody((current) => (current ? `${current}\n\n${canned.body}` : canned.body));
  }

  return (
    <div className="card p-0">
      <div className="flex items-center gap-1 border-b border-white/[0.07] px-2 py-1.5">
        <button
          type="button"
          onClick={() => setMode("reply")}
          className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors", mode === "reply" ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}
        >
          <MessageSquare className="size-4" /> Reply
        </button>
        <button
          type="button"
          onClick={() => setMode("note")}
          className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors", mode === "note" ? "bg-amber-400/10 font-medium text-amber-300" : "text-muted-foreground hover:text-foreground")}
        >
          <StickyNote className="size-4" /> Internal note
        </button>
      </div>

      {mode === "reply" ? (
        <form
          action={replyAction}
          onSubmit={() => setTimeout(() => setBody(""), 0)}
          className="space-y-3 p-3"
        >
          {cannedReplies.length > 0 && (
            <select
              className="input text-sm"
              defaultValue=""
              onChange={(e) => {
                applyCanned(e.target.value);
                e.currentTarget.value = "";
              }}
            >
              <option value="">Insert a saved reply…</option>
              {cannedReplies.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          )}
          <textarea
            name="body"
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Reply to the customer…"
            className="input min-h-28 resize-y"
          />
          {signature && <p className="text-xs text-muted-foreground">Signature: {signature}</p>}
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Send &amp; set to
              <select name="status" defaultValue="waiting_customer" className="input h-9 py-0 text-sm">
                {statusOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-primary">
              <Send className="size-4" /> Send reply
            </button>
          </div>
        </form>
      ) : (
        <form
          action={noteAction}
          onSubmit={() => setTimeout(() => setBody(""), 0)}
          className="space-y-3 p-3"
        >
          <textarea
            name="body"
            required
            rows={4}
            placeholder="Add an internal note (not visible to the customer)…"
            className="input min-h-24 resize-y border-amber-400/20 bg-amber-400/[0.03]"
          />
          <div className="flex justify-end">
            <button type="submit" className="btn-secondary">
              <StickyNote className="size-4" /> Save note
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
