"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Maximize2, X } from "lucide-react";
import { DaxIcon } from "@/components/DaxIcon";
import { openAssistantBubble } from "@/app/actions/assistant";
import AssistantChat from "@/components/AssistantChat";
import { publishDax, registerDax } from "@/lib/daxLauncher";

type Opened = { name: string; connected: boolean; listen: boolean; history: { question: string; answer: string; source: string }[]; conversation: string | null };

/**
 * The "Ask DAX" chat panel, on every page in the app — opened by the sidebar's Ask the CRM button.
 *
 * It used to have its own floating round button in the bottom-right corner. Sean, 2026-11-13: "remove this now and
 * make the button in the sidebar behave the same way". The panel registers with lib/daxLauncher.ts, which the
 * sidebar button (Nav.tsx) toggles, and publishes open/unread so the button can show both.
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
    // Re-fetched each time it opens: the conversation for THIS page (a deal's or customer's), or the one you were in.
    const result = await openAssistantBubble(pathname).catch(() => ({ ok: false as const }));
    setLoading(false);
    if (result.ok) setData(result);
    else setError(true);
  };

  // Moved to another page with the panel open: that page's conversation, not the last one's (a deal's, a customer's).
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    // Reloading for a new page is a response to navigation — an outside change, not this component's own state.
    if (openRef.current) void openBubble();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the page changes
  }, [pathname]);

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

  // The sidebar button opens and closes this panel (lib/daxLauncher.ts). Registered once; it calls the latest toggle.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => registerDax(() => void toggleRef.current()), []);
  useEffect(() => publishDax({ open, unread }), [open, unread]);
  // Escape closes it: its button is now in the sidebar, not beside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
          className="fixed bottom-6 right-6 z-50 flex max-h-[min(640px,calc(100vh-5rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <DaxIcon className="size-4 text-primary" /> Ask {name}
            </p>
            <div className="flex items-center gap-1">
              {/* A fresh conversation, here and now (assistantConversation). */}
              {data?.connected && (
                <button
                  type="button"
                  onClick={() => setData((d) => (d ? { ...d, history: [], conversation: "new" } : d))}
                  className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Start a new conversation"
                >
                  ＋ New
                </button>
              )}
              <Link href={data?.conversation && data.conversation !== "new" ? `/assistant?c=${data.conversation}` : "/assistant"} className="rounded p-1 text-muted-foreground hover:text-foreground" title="Open the full page" aria-label="Open the full page" onClick={() => setOpen(false)}>
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
                It runs on your workspace&apos;s AI connection, which isn&apos;t set up yet.{" "}
                <Link href="/settings/integrations" className="text-primary underline">Connect an AI service</Link>.
              </p>
            ) : (
              <AssistantChat
                key={`${pathname}:${data.conversation ?? "pick"}`}
                name={data.name}
                history={data.history}
                page={pathname ?? undefined}
                autoAsk={autoAsk ?? undefined}
                listen={data.listen}
                conversation={data.conversation}
                compact
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
