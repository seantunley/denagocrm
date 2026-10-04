import { cn } from "@/lib/utils";

/**
 * The lead score as a small pill. Theme tokens only, so it follows a tenant's
 * brand colour instead of hard-coding one. Three steps of emphasis, no more —
 * the reasons beside it carry the meaning; this only says how loudly.
 */
export function LeadScoreBadge({ score, className }: { score: number; className?: string }) {
  const tone =
    score >= 60
      ? "border-primary/50 bg-primary/20 text-primary"
      : score >= 30
        ? "border-primary/25 bg-primary/10 text-primary"
        : "border-border bg-muted/60 text-muted-foreground";
  return (
    <span
      title={`Lead score ${score} of 100`}
      className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-4", tone, className)}
    >
      {score}
    </span>
  );
}
