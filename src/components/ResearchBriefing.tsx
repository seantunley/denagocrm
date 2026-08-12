import { Building2, UserRound, Sparkles } from "lucide-react";

type ParsedBriefing =
  | { structured: true; company: string | null; role: string | null; fit: string | null }
  | { structured: false };

/**
 * aiResearch() (lib/ai.ts) returns up to three labeled lines — Company:,
 * Role:, Fit: — instead of free prose, so this can render a structured card
 * instead of one undifferentiated paragraph.
 *
 * STRUCTURED MODE IS ALL-OR-NOTHING, and that is the whole safety property.
 *
 * The first version switched to structured mode as soon as ONE line matched a
 * label, then silently dropped every line that did not. So this:
 *
 *     Company: Example Estates, Stellenbosch
 *     Current role appears to be Managing Director.
 *     Fit: Large estate with internal transport needs
 *
 * rendered as Company + Fit, and the role sentence vanished from the screen
 * with nothing to indicate anything was missing. Partial format drift is
 * exactly what this tolerance exists to absorb — this is generated text — so
 * the lenient path was discarding content precisely when it was needed. It also
 * reached backwards: an old free-form note that happens to contain one
 * "Company: ..." line would be read as structured and have all its other prose
 * hidden.
 *
 * So every non-empty line must conform before the structured view is used.
 * Anything else renders verbatim, which is the honest fallback and the one the
 * component always claimed to have.
 */
function parseBriefing(text: string): ParsedBriefing {
  const fields: Partial<Record<"company" | "role" | "fit", string>> = {};
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { structured: false };

  for (const rawLine of lines) {
    const match = rawLine.trim().match(/^(Company|Role|Fit):\s*(.+)$/i);
    // ONE non-conforming line disqualifies the whole briefing. Losing the
    // structured card is a cosmetic cost; losing a sentence of research is not.
    if (!match) return { structured: false };
    const key = match[1].toLowerCase() as "company" | "role" | "fit";
    // A repeated label would otherwise overwrite silently — same class of
    // content loss, so it disqualifies too.
    if (fields[key] !== undefined) return { structured: false };
    fields[key] = match[2].trim();
  }
  return {
    structured: true,
    company: fields.company ?? null,
    role: fields.role ?? null,
    fit: fields.fit ?? null,
  };
}

/** Exported for tests — the parser is the part with a safety property. */
export const __parseBriefingForTests = parseBriefing;

const ROWS = [
  { key: "company" as const, label: "Company", icon: Building2 },
  { key: "role" as const, label: "Role", icon: UserRound },
  { key: "fit" as const, label: "Why an electric cart", icon: Sparkles },
];

/**
 * One research briefing: structured Company/Role/Fit rows when the text
 * carries those labels, a plain paragraph otherwise (unlabeled text, or the
 * model's own "no information found" line).
 */
export function ResearchBriefingView({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  const parsed = parseBriefing(text);
  if (!parsed.structured) {
    return (
      <p
        className={`whitespace-pre-wrap leading-relaxed text-foreground/90 ${compact ? "text-xs" : "text-sm"}`}
      >
        {text}
      </p>
    );
  }
  const rows = ROWS.map((r) => ({ ...r, value: parsed[r.key] })).filter(
    (r): r is (typeof ROWS)[number] & { value: string } => Boolean(r.value)
  );
  if (rows.length === 0) {
    return (
      <p className={`leading-relaxed text-slate-400 ${compact ? "text-xs" : "text-sm"}`}>
        No reliable information found.
      </p>
    );
  }
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {rows.map(({ key, label, icon: Icon, value }) => (
        <div key={key} className="flex gap-2.5">
          <Icon className={`mt-0.5 shrink-0 text-sky-400 ${compact ? "size-3.5" : "size-4"}`} />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {label}
            </p>
            <p className={`leading-relaxed text-slate-100 ${compact ? "text-xs" : "text-sm"}`}>
              {value}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
