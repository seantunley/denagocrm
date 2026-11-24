"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleHelp, ExternalLink, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ArticleBody from "@/components/help/ArticleBody";
import { helpSlugForScreen } from "@/lib/help/screenHelp";
import type { HelpBlock } from "@/lib/help/types";

type Article = { slug: string; title: string; summary: string; body: HelpBlock[] };
type State = { status: "idle" | "loading" | "missing" } | { status: "ready"; article: Article };

/**
 * HELP WHERE YOU WORK: the "?" in the top bar. Opens the guide for THIS screen in a side panel, so nobody has to
 * leave what they're doing (lib/help/screenHelp.ts maps screens to guides). Hidden on a screen with no guide.
 */
export default function ScreenHelp() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  // The settings tab lives in the query string; it's read at click time (useSearchParams would need a Suspense
  // boundary around the whole top bar).
  const screenSlug = helpSlugForScreen(pathname);
  if (!screenSlug) return null;

  async function show() {
    const slug = helpSlugForScreen(pathname, window.location.search) ?? screenSlug;
    setOpen(true);
    if (state.status === "ready" && state.article.slug === slug) return;
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/help/${encodeURIComponent(slug!)}`, { cache: "force-cache" });
      setState(res.ok ? { status: "ready", article: (await res.json()) as Article } : { status: "missing" });
    } catch {
      setState({ status: "missing" });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label="Help for this screen"
        title="Help for this screen"
        className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:text-foreground"
      >
        <CircleHelp className="size-3.5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {state.status === "ready" ? (
            <>
              <SheetHeader className="border-b border-border px-6 py-5 pr-12">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Help for this screen</p>
                <SheetTitle className="text-lg">{state.article.title}</SheetTitle>
                <SheetDescription>{state.article.summary}</SheetDescription>
              </SheetHeader>
              <div className="px-6 py-5">
                <ArticleBody body={state.article.body} />
              </div>
              <div className="mt-auto flex flex-wrap gap-x-4 gap-y-2 border-t border-border px-6 py-4 text-sm">
                <Link href={`/help/${state.article.slug}`} onClick={() => setOpen(false)} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <ExternalLink className="size-3.5" /> Open the full guide
                </Link>
                <Link href="/help" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                  Browse the Help Centre
                </Link>
              </div>
            </>
          ) : (
            <>
              <SheetHeader className="px-6 py-5 pr-12">
                <SheetTitle className="text-lg">Help for this screen</SheetTitle>
                <SheetDescription>{state.status === "missing" ? "This guide couldn't be loaded." : "Loading the guide…"}</SheetDescription>
              </SheetHeader>
              <div className="px-6 py-2 text-sm text-muted-foreground">
                {state.status === "missing" ? (
                  <Link href="/help" onClick={() => setOpen(false)} className="text-primary hover:underline">
                    Open the Help Centre
                  </Link>
                ) : (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
