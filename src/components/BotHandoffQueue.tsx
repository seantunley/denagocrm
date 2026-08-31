"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bot, Clock3, Hand, UserRound } from "lucide-react";
import { toast } from "sonner";
import { unstable_rethrow } from "next/navigation";
import { assignConversation, setConversationBotMode } from "@/app/actions/conversations";

export type HandoffQueueItem = {
  key: string;
  conversationId: string;
  name: string;
  channel: string;
  reason: string | null;
  summary: string | null;
  intent: string | null;
  confidence: string | null;
  requestedAt: string;
  dueAt: string;
  overdue: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
};

type Staff = { id: string; name: string };

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", x: "X", telegram: "Telegram" };

function waitLabel(requestedAt: string, now: number | null) {
  if (now === null) return "—";
  const minutes = Math.max(0, Math.floor((now - new Date(requestedAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m waiting`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m waiting`;
}

export default function BotHandoffQueue({ items, staff, canAct }: { items: HandoffQueueItem[]; staff: Staff[]; canAct: boolean }) {
  if (!items.length) return <div className="rounded-2xl border border-border bg-card p-8 text-center"><Bot className="mx-auto size-7 text-emerald-400" aria-hidden="true" /><p className="mt-3 text-sm font-medium">No chatbot handoffs are waiting</p><p className="mt-1 text-xs text-muted-foreground">New handoffs appear here as soon as the bot asks for a person.</p></div>;
  return <div className="grid gap-3 lg:grid-cols-2">{items.map((item) => <HandoffCard key={item.key} item={item} staff={staff} canAct={canAct} />)}</div>;
}

function HandoffCard({ item, staff, canAct }: { item: HandoffQueueItem; staff: Staff[]; canAct: boolean }) {
  const router = useRouter();
  const [assignee, setAssignee] = useState(item.assigneeId ?? "");
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const overdue = now !== null && now >= new Date(item.dueAt).getTime();

  const run = (work: () => Promise<{ error?: string; success?: string } | void>) => {
    startTransition(async () => {
      try {
        const result = await work();
        if (result && "error" in result && result.error) {
          toast.error(String(result.error));
          return;
        }
        if (result && "success" in result && result.success) toast.success(String(result.success));
        router.refresh();
      } catch (error) {
        unstable_rethrow(error);
        toast.error("That change did not reach the server. Refresh and try again.");
      }
    });
  };

  return (
    <article className={`rounded-2xl border bg-card p-4 ${overdue ? "border-red-400/30" : "border-border"}`}>
      <div className="flex items-start gap-3">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${overdue ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-300"}`}>{overdue ? <AlertTriangle className="size-5" aria-hidden="true" /> : <Hand className="size-5" aria-hidden="true" />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold">{item.name}</h3><span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{channelLabel[item.channel] ?? item.channel}</span>{overdue ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-300">SLA overdue</span> : null}</div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" aria-live="polite"><span className="inline-flex items-center gap-1"><Clock3 className="size-3" aria-hidden="true" />{waitLabel(item.requestedAt, now)}</span>{item.confidence ? <span>AI confidence: {item.confidence}</span> : null}{item.intent ? <span>Intent: {item.intent}</span> : null}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-border/80 bg-muted/20 p-3">
        <p className="text-xs font-medium text-foreground">{item.reason ?? "The bot requested human help."}</p>
        {item.summary ? <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.summary}</p> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border/70 pt-3">
        <label className="min-w-44 flex-1 text-[11px] text-muted-foreground">Assign to
          <select className="input mt-1 min-h-11 text-xs" value={assignee} disabled={!canAct || pending} onChange={(event) => {
            const next = event.target.value;
            setAssignee(next);
            run(() => assignConversation(item.conversationId, next || null));
          }}><option value="">Nobody</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        </label>
        <button type="button" className="btn-primary btn-sm min-h-11" disabled={!canAct || pending} onClick={() => run(() => setConversationBotMode(item.conversationId, "human"))}><UserRound className="size-3.5" aria-hidden="true" />{pending ? "Saving…" : "Take over"}</button>
      </div>
    </article>
  );
}
