"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { unstable_rethrow } from "next/navigation";
import { Bot, Clock3, Hand, UserRound } from "lucide-react";
import {
  assignConversation,
  addConversationNote,
  setConversationBotMode,
} from "@/app/actions/conversations";
import { formatDateTime } from "@/lib/format";
import type { ThreadCollaboration } from "@/lib/inboxThreads";

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
  const [botMode, setBotMode] = useState<"bot" | "handoff" | "human">(collaboration.bot.mode);

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

      {collaboration.bot.supported && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
          {botMode === "human"
            ? <Hand className="size-4 shrink-0 text-amber-400" />
            : botMode === "handoff"
              ? <Clock3 className="size-4 shrink-0 text-red-400" />
              : <Bot className="size-4 shrink-0 text-emerald-400" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium text-foreground">Conversation control</p>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${botMode === "human" ? "bg-amber-500/15 text-amber-300" : botMode === "handoff" ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                {botMode === "human" ? "Human handling" : botMode === "handoff" ? "Needs human" : "Bot available"}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {botMode === "human"
                ? "Automation is paused for this customer. Returning it to the bot starts a fresh flow on their next message."
                : botMode === "handoff"
                  ? `${collaboration.bot.handoff?.reason ?? "The bot requested help."}${collaboration.bot.handoff?.overdue ? " · SLA overdue" : ""}`
                  : "A staff reply automatically takes over and pauses automated replies."}
            </p>
            {botMode === "handoff" && collaboration.bot.handoff?.summary ? (
              <p className="mt-1 text-[10px] leading-4 text-foreground/80">{collaboration.bot.handoff.summary}</p>
            ) : null}
          </div>
          {canAct && (
            <button
              type="button"
              className={botMode === "human" ? "btn-secondary btn-sm" : "btn-primary btn-sm"}
              disabled={pending}
              onClick={() => {
                const next = botMode === "human" ? "bot" : "human";
                run(async () => {
                  const result = await setConversationBotMode(collaboration.conversationId, next);
                  if (!(result && "error" in result && result.error)) setBotMode(next);
                  return result;
                });
              }}
            >
              {pending ? "Saving…" : botMode === "human" ? "Return to bot" : "Take over"}
            </button>
          )}
        </div>
      )}

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
