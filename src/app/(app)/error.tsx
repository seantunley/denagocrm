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
 * navigation, and CAN retry.
 *
 * RETRY, NOT RESET. `reset()` only clears the error state and re-renders the
 * children — it does not re-fetch anything, so a segment that failed because a
 * query failed simply throws again on the same stale RSC output, and the button
 * appears to do nothing. Next's own docs put it plainly: "In most cases, you
 * should use retry() instead." `retry()` re-fetches and
 * re-renders the segment inside a Transition, which preserves Client Component
 * state outside this boundary. Since almost everything that lands here is a
 * failed server query, that difference is the whole value of the button.
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
  // `retry`, not `unstable_retry`: the prop was renamed when the API stabilised
  // in Next 16.3. This file declares its OWN prop type rather than importing
  // Next's, so TypeScript could not see the mismatch — the old name would have
  // arrived undefined and Try again would have thrown on click.
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
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
    }).catch((reportError) => {
      // If the reporting endpoint itself is unavailable, retain evidence in the
      // browser console instead of silently discarding the second failure.
      console.error("[client-error-report-failure]", reportError);
    });
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
            onClick={() => retry()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            <RotateCcw className="size-4" aria-hidden />
            Try again
          </button>
          {/* A plain <a>, not next/link, and deliberately so: this forces a FULL
              document load, which throws away whatever client state was left
              behind by the render that failed. A soft navigation carries that
              state into the next page. `reset()` above is the in-place retry;
              this is the escape hatch, and it should be a clean one. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
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
