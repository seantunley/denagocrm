import { ArrowLeft, Search } from "lucide-react";

/**
 * "Not found", said plainly (ui-ux-upgrade-plan.md 1.2).
 *
 * INSIDE THE APP (a record page's notFound() — a deleted lead, an old link) the sidebar stays and it offers a way
 * on: search, or back to the dashboard. Before, it fell through to the framework's bare 404 and lost the sidebar.
 *
 * AT THE ROOT it is NEUTRAL, because customers land there too: a used signing link, a handover or test-drive form,
 * an approval link (src/app/(handover), src/app/approvals call notFound()). Staff search and "the dashboard" mean
 * nothing to them, and would send them to the staff sign-in.
 */
export default function NotFoundScreen({ inApp }: { inApp: boolean }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="h-[3px] w-12 rounded-sm bg-primary" />
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
          {inApp ? "That record isn't here" : "This page isn't available"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {inApp
            ? "It may have been deleted, or the link is out of date. Deleted records stay in Trash for 60 days, where an owner can restore them."
            : "The link may be mistyped, out of date or already used. If someone sent it to you, ask them for a new one."}
        </p>
        {inApp && (
          <>
            {/* A plain GET form: works before any script has loaded. */}
            <form action="/search" method="get" role="search" className="mt-5 flex gap-2">
              <label htmlFor="not-found-search" className="sr-only">Search the CRM</label>
              <input
                id="not-found-search"
                name="q"
                type="search"
                placeholder="Search customers, deals, quotes…"
                className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary pointer-fine:min-h-9"
              />
              <button type="submit" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 pointer-fine:min-h-9">
                <Search className="size-4" aria-hidden />
                Search
              </button>
            </form>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a clean full load, as the error screen does */}
            <a
              href="/"
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted pointer-fine:min-h-9"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to the dashboard
            </a>
          </>
        )}
      </div>
    </div>
  );
}
