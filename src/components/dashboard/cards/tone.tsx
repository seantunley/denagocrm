import { cn } from "@/lib/utils";
import { TONE_LABEL, type Tone } from "@/lib/dashboard/tone";

/**
 * How a tone looks — lib/dashboard/tone.ts decides which one a number has.
 *
 * The same emerald, amber and red the stat card's change arrow has always used,
 * so a coloured number and its arrow read as one family. The ring colours are
 * the same three shades as plain colour values, because TargetRings takes a CSS
 * colour rather than a class.
 */
export const TONE_TEXT: Record<Tone, string> = {
  good: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-red-400",
};

export const TONE_RING: Record<Tone, string> = {
  good: "oklch(0.765 0.177 163.223)",
  warn: "oklch(0.828 0.189 84.429)",
  bad: "oklch(0.704 0.191 22.216)",
};

const TONE_PILL: Record<Tone, string> = {
  good: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
  warn: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
  bad: "bg-red-400/10 text-red-300 ring-red-400/30",
};

/** The tone in words, so it never rests on colour alone. */
export function TonePill({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_PILL[tone],
        className,
      )}
    >
      {TONE_LABEL[tone]}
    </span>
  );
}
