"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Maximize2, X } from "lucide-react";
import { DaxIcon } from "@/components/DaxIcon";
import { openAssistantBubble } from "@/app/actions/assistant";
import AssistantChat from "@/components/AssistantChat";

type Opened = { name: string; connected: boolean; listen: boolean; history: { question: string; answer: string; source: string }[] };

/**
 * The floating "Ask DAX" bubble, on every page in the app.
 *
 * Nothing loads until it's opened — no request per page view. When it opens it
 * fetches the assistant's name and only TODAY's conversation (Sean: keep the
 * context small); the full history lives on /assistant. It passes the current
 * page along, so on a lead "what should I do with this one?" works. Hidden on
 * /assistant itself, where the full chat already is.
 *
 * `unseen` — scheduled answers not yet seen — comes from the server layout, so
 * the dot costs no request either. The layout persists across navigation, so
 * the dot is cleared HERE once seen (opened, or the Ask page visited); the
 * server marks them seen at the same moments.
 */
export default function AssistantBubble({ unseen = 0 }: { unseen?: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Opened | null>(null);
  const [error, setError] = useState(false);
  const [unread, setUnread] = useState(unseen > 0);
  // A question to ask the moment it opens — sent by the home page's daily
  // brief ("Ask DAX for a plan") as a window event, so the card needn't know
  // where the bubble is mounted. Each press has its own key; the chat asks each
  // key once, however often it remounts.
  const [autoAsk, setAutoAsk] = useState<{ question: string; key: number } | null>(null);

  const toggle = async () => {
    if (open) return setOpen(false);
    await openBubble();
  };

  const openBubble = async () => {
    setOpen(true);
    setUnread(false);
    setLoading(true);
    setError(false);
    // Re-fetched each time it opens, so today's turns from the full page show up.
    const result = await openAssistantBubble().catch(() => ({ ok: false as const }));
    setLoading(false);
    if (result.ok) setData(result);
    else setError(true);
  };

  useEffect(() => {
    const onAsk = (event: Event) => {
      const question = (event as CustomEvent<{ question?: unknown }>).detail?.question;
      if (typeof question !== "string" || !question.trim()) return;
      setAutoAsk({ question: question.slice(0, 500), key: Date.now() });
      void openBubble();
    };
    window.addEventListener("dax:ask", onAsk);
    return () => window.removeEventListener("dax:ask", onAsk);
  });

  if (pathname?.startsWith("/assistant")) {
    if (unread) setUnread(false);
    return null;
  }

  const name = data?.name ?? "the CRM";

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label={`Ask ${name}`}
          className="fixed bottom-24 right-4 z-50 flex max-h-[min(640px,calc(100vh-8rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl md:bottom-20"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <DaxIcon className="size-4 text-primary" /> Ask {name}
            </p>
            <div className="flex items-center gap-1">
              <Link href="/assistant" className="rounded p-1 text-muted-foreground hover:text-foreground" title="Open the full page" aria-label="Open the full page" onClick={() => setOpen(false)}>
                <Maximize2 className="size-4" />
              </Link>
              <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading ? (
              <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Opening…</p>
            ) : error || !data ? (
              <p className="p-4 text-sm text-muted-foreground">The assistant isn&apos;t available right now.</p>
            ) : !data.connected ? (
              <p className="p-4 text-sm text-muted-foreground">
                It runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
                <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link>.
              </p>
            ) : (
              <AssistantChat
                key={pathname}
                name={data.name}
                history={data.history}
                page={pathname ?? undefined}
                autoAsk={autoAsk ?? undefined}
                listen={data.listen}
                compact
              />
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Close the assistant" : unread ? `Ask ${name} — new scheduled answer` : `Ask ${name}`}
        title={`Ask ${name}`}
        className="fixed bottom-20 right-4 z-50 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 md:bottom-6 md:right-6"
      >
        {open ? <X className="size-5" /> : <DaxIcon className="size-6" />}
        {unread && !open && <span className="absolute right-0.5 top-0.5 size-3 rounded-full border-2 border-card bg-destructive" aria-hidden />}
      </button>
    </>
  );
}
