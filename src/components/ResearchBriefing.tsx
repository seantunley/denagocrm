import { Building2, UserRound, Sparkles } from "lucide-react";

type ParsedBriefing =
  | { structured: true; company: string | null; role: string | null; fit: string | null }
  | { structured: false };

/**
 * aiResearch() (lib/ai.ts) returns up to three labeled lines — Company:,
 * Role:, Fit: — instead of free prose, so this can render a structured card
 * instead of one undifferentiated paragraph.
 *
 * Tolerant on purpose: text with none of the three labels falls back to
 * `structured: false` rather than guessing at a shape. That covers every
 * research note written before this format existed, and anything the model
 * drifts on, without a migration or a backfill.
 */
function parseBriefing(text: string): ParsedBriefing {
  const fields: Partial<Record<"company" | "role" | "fit", string>> = {};
  let matchedAny = false;
  for (const rawLine of text.split("\n")) {
    const match = rawLine.trim().match(/^(Company|Role|Fit):\s*(.+)$/i);
    if (!match) continue;
    matchedAny = true;
    const key = match[1].toLowerCase() as "company" | "role" | "fit";
    fields[key] = match[2].trim();
  }
  if (!matchedAny) return { structured: false };
  return {
    structured: true,
    company: fields.company ?? null,
    role: fields.role ?? null,
    fit: fields.fit ?? null,
  };
}

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
