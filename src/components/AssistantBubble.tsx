"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { openAssistantBubble } from "@/app/actions/assistant";
import AssistantChat from "@/components/AssistantChat";

type Opened = { name: string; connected: boolean; history: { question: string; answer: string }[] };

/**
 * The floating "Ask DAX" bubble, on every page in the app.
 *
 * Nothing loads until it's opened — no request per page view. When it opens it
 * fetches the assistant's name and only TODAY's conversation (Sean: keep the
 * context small); the full history lives on /assistant. It passes the current
 * page along, so on a lead "what should I do with this one?" works. Hidden on
 * /assistant itself, where the full chat already is.
 */
export default function AssistantBubble() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Opened | null>(null);
  const [error, setError] = useState(false);

  if (pathname?.startsWith("/assistant")) return null;

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    setLoading(true);
    setError(false);
    // Re-fetched each time it opens, so today's turns from the full page show up.
    const result = await openAssistantBubble().catch(() => ({ ok: false as const }));
    setLoading(false);
    if (result.ok) setData(result);
    else setError(true);
  };

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
              <Sparkles className="size-4 text-primary" /> Ask {name}
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
              <AssistantChat key={pathname} name={data.name} history={data.history} page={pathname ?? undefined} compact />
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Close the assistant" : `Ask ${name}`}
        title={`Ask ${name}`}
        className="fixed bottom-20 right-4 z-50 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 md:bottom-6 md:right-6"
      >
        {open ? <X className="size-5" /> : <Sparkles className="size-5" />}
      </button>
    </>
  );
}
