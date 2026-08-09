"use client";

import { useEffect } from "react";
import { unstable_catchError, type ErrorInfo } from "next/error";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * ONE BAD CARD COSTS EXACTLY ONE CARD — kept true once cards stream.
 *
 * `renderCard` already turns a failed card into an inline notice, and
 * DashboardView catches anything that gets past it. Both work because the card is
 * AWAITED on the server: the error happens while the page is being assembled,
 * where there is something to catch it.
 *
 * A streamed card is different. Its work continues after the shell has been sent,
 * so a throw no longer lands in that try/catch — it goes to the nearest React
 * error boundary. Without one per card that is the page boundary, and streaming
 * would have traded this codebase's strongest guarantee for a faster first paint.
 *
 * ── WHY THE FRAMEWORK PRIMITIVE, NOT A CLASS COMPONENT ──────────────────────
 *
 * The first version was a hand-written class with getDerivedStateFromError, which
 * is the classic way to do this and is WRONG here in a way that is easy to miss:
 *
 *   - `redirect()` and `notFound()` work by THROWING special errors. A custom
 *     boundary catches them like any other failure, so a card that redirects
 *     would render "could not be loaded" instead of redirecting. Next's own
 *     wrapper knows to let those through.
 *   - `unstable_retry()` re-fetches and re-renders the boundary's children. A
 *     class component can only clear its own error state, which cannot recover a
 *     Server Component error — the card would fail again immediately.
 *   - The error state clears automatically on client navigation, so a card that
 *     failed does not stay failed after you move to another dashboard and back.
 *
 * See node_modules/next/dist/docs/01-app/03-api-reference/04-functions/catchError.md.
 *
 * ── WHAT IT SHOWS ───────────────────────────────────────────────────────────
 *
 * The same "could not be loaded" language as the server-side fallback, and
 * deliberately no detail: a card that failed on a row the viewer should never
 * have seen must not describe that row on its way out.
 *
 * It DOES report to the server. Containing a failure silently was an
 * observability regression in the first version — the console line lived in a
 * browser nobody was looking at, so a card could fail for every user of a tenant
 * and leave no trace anywhere. It reports to the same endpoint the page-level
 * boundary uses.
 */
function CardFallback({ title }: { title?: string }, { error, unstable_retry }: ErrorInfo) {
  useEffect(() => {
    // Same endpoint as app/(app)/error.tsx. A contained failure still has to be
    // findable: this is the only record that a card failed at all.
    fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        digest: (error as { digest?: string })?.digest ?? null,
        message: `dashboard card "${title ?? "untitled"}": ${error?.message ?? "unknown"}`,
        stack: error?.stack?.slice(0, 4000) ?? null,
        path: typeof window === "undefined" ? null : window.location.pathname,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [error, title]);

  return (
    <div className="flex h-full min-h-24 flex-col justify-center rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0 text-amber-400" aria-hidden />
        <span>
          {title ? `“${title}” ` : "This card "}
          could not be loaded.
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Try again
        </button>
        <span className="text-xs text-muted-foreground/80">The rest of the dashboard is unaffected.</span>
      </div>
    </div>
  );
}

export const CardBoundary = unstable_catchError(CardFallback);
