/**
 * What a card looks like while its data is still coming.
 *
 * Shaped like a card rather than a spinner, and given a minimum height, so the
 * grid does not reflow when the real card arrives. A dashboard that streams into
 * a jumping layout is worse to use than one that simply took a moment.
 *
 * The title is shown when the config has one: it is already known before any
 * query runs, and "Pipeline snapshot, loading" tells the viewer more about
 * whether to wait than an anonymous grey box does.
 */
export function CardSkeleton({ title }: { title?: string }) {
  return (
    <div
      className="flex h-full min-h-24 animate-pulse flex-col gap-3 rounded-xl border border-border bg-card p-4"
      aria-busy="true"
      aria-live="polite"
    >
      {title ? (
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
      ) : (
        <span className="h-4 w-28 rounded bg-muted" />
      )}
      <span className="h-3 w-full rounded bg-muted" />
      <span className="h-3 w-4/5 rounded bg-muted" />
      <span className="sr-only">Loading{title ? ` ${title}` : ""}…</span>
    </div>
  );
}
