"use client";

import { useEffect } from "react";
import { RotateCcw, ArrowLeft } from "lucide-react";

/**
 * The error boundary for every signed-in page.
 *
 * WHY THIS FILE EXISTS. There was no route-level boundary anywhere in the app —
 * only `app/global-error.tsx`. That is the LAST-RESORT page: it replaces the root
 * layout, so it loses the sidebar, the navigation and every piece of client
 * state, and by its own design it cannot even offer a retry button (it renders
 * outside the layout that carries the CSP nonce, so its scripts are blocked).
 *
 * The effect was that any error on any signed-in page — one dashboard card, one
 * failed query, one client component throwing during a drag — escalated to a
 * full-document crash screen offering "Back to the dashboard" and "Sign in
 * again". Somebody rearranging their dashboard lost the whole app.
 *
 * This boundary sits inside the layout, so it keeps the shell, keeps the
 * navigation, and CAN retry: `reset()` re-renders the failed segment without a
 * document load, and the rest of the app was never unmounted.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Like global-error, it does not promise that
 * nothing was saved. A server action may have committed before the render that
 * failed, so "nothing was saved" would invite the retry that duplicates a quote.
 *
 * THE DIGEST IS THE WHOLE POINT OF REPORTING. In production Next replaces a
 * server error's message with an opaque digest and logs the real error server
 * side under that same digest. Showing it is what makes a report actionable.
 * A CLIENT-side error has no digest — React never generates one — which is why
 * this also reports to the server explicitly below. Without that, a client crash
 * leaves no trace anywhere: not in the browser the user has already navigated
 * away from, and not in any log.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report once per error instance. A client-side crash produces no digest and
    // no server log, so without this the only record of it is a console message
    // in a browser nobody is looking at.
    //
    // `keepalive` so the report still goes out if this render is immediately
    // followed by a navigation away, and a swallowed rejection because a failing
    // error-reporter must never be the thing that breaks the error page.
    const payload = JSON.stringify({
      digest: error.digest ?? null,
      message: error.message,
      stack: error.stack?.slice(0, 4000) ?? null,
      path: typeof window === "undefined" ? null : window.location.pathname,
    });
    fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="h-[3px] w-12 rounded-sm bg-primary" />

        <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
          This page hit an error
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          The rest of the app is still working. Your last action may have completed — check the
          record before trying it again.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            <RotateCcw className="size-4" aria-hidden />
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back to the dashboard
          </a>
        </div>

        {error?.digest && (
          <p className="mt-5 text-xs text-muted-foreground">
            Quote this reference if you report it:{" "}
            <code className="font-mono text-muted-foreground">{error.digest}</code>
          </p>
        )}
      </div>
    </div>
  );
}
