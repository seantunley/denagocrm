import { Search, History } from "lucide-react";
import ResearchButton from "@/components/ResearchButton";
import { ResearchBriefingView } from "@/components/ResearchBriefing";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type ResearchNoteRow = { id: string; createdAt: Date; body: string };

/**
 * The Research tab body, shared by the lead and contact detail pages — they
 * carried byte-for-byte the same markup (a flat `<ul>` of every note, equal
 * weight, oldest styling unchanged since the feature shipped), so a fix to
 * one silently drifted from the other. One component, two callers.
 *
 * The newest note is the one anyone actually reads day to day, so it gets a
 * full-weight card up top; everything older sits behind a disclosure instead
 * of pushing the newest note down the page as the history grows.
 */
export default function ResearchTabPanel({
  notes,
  leadId,
  contactId,
  configured,
  subjectLabel,
}: {
  notes: ResearchNoteRow[];
  leadId?: string;
  contactId?: string;
  configured: boolean;
  subjectLabel: string;
}) {
  const [latest, ...earlier] = notes;

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
            <Search className="size-3.5" />
          </span>
          AI research
        </h2>
        <ResearchButton leadId={leadId} contactId={contactId} configured={configured} />
      </div>

      {!latest ? (
        <p className="text-sm text-slate-400">
          No research yet. Use the Research button to generate a briefing on this {subjectLabel}{" "}
          and the company behind the email — including a LinkedIn check on the person.
        </p>
      ) : (
        <>
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4">
            <p className="mb-3 text-xs text-sky-300/80">{formatRelativeTime(latest.createdAt)}</p>
            <ResearchBriefingView text={latest.body} />
          </div>

          {earlier.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-slate-300">
                <History className="size-3.5" />
                {earlier.length} earlier research note{earlier.length === 1 ? "" : "s"}
                <span className="transition-transform group-open:rotate-180">⌄</span>
              </summary>
              <ul className="mt-3 space-y-3 border-t border-slate-800 pt-3">
                {earlier.map((r) => (
                  <li key={r.id} className="border-t border-slate-800/60 pt-3 first:border-0 first:pt-0">
                    <p className="mb-1.5 text-xs text-slate-500">{formatDateTime(r.createdAt)}</p>
                    <ResearchBriefingView text={r.body} compact />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
