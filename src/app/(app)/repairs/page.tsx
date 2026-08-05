import Link from "next/link";
import { ArrowRight, BellOff, CheckCircle2, Hammer } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { listRepairIssues, type RepairIssueView } from "@/lib/repairs";
import { ignoreRepairIssue, restoreRepairIssue } from "@/app/actions/repairs";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { PageHeader } from "@/components/page-header";
import { EmptyState, StatusPill } from "@/components/visual-system";

export const dynamic = "force-dynamic";

/**
 * Repairs — the workspace issue inbox.
 *
 * The whole point is the shape: a problem you would otherwise meet as a
 * customer complaint becomes a LIST WITH A BUTTON. Not a log to read, not a
 * metric to interpret — a specific sentence about a specific broken thing, and
 * a link to where it is fixed.
 *
 * Everything here is written by detectors on the automations cron
 * (src/lib/repairsDetectors.ts). Nothing on this page can create or close an
 * issue: an issue is a claim about the state of the workspace, and the only
 * thing entitled to withdraw it is a detector finding the problem gone. The one
 * human verb is Ignore, and Ignore hides — it does not assert a fix.
 */
export default async function RepairsPage() {
  await requireOwner();
  const { open, ignored } = await listRepairIssues();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Repairs"
        description="Problems this workspace has that nothing else would tell you about — a journey that stopped sending, a credential that stopped working. Checked automatically every few minutes; each one disappears on its own once it is fixed."
      />

      {open.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing to repair"
          description={
            ignored.length > 0
              ? "No open issues. Some are ignored — they are listed below, and will come back on their own if they clear and then recur."
              : "Every check passed the last time they ran. If something breaks quietly, it will appear here."
          }
        />
      ) : (
        <ul className="space-y-3">
          {open.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </ul>
      )}

      {ignored.length > 0 && (
        <details className="rounded-xl border border-border bg-card">
          {/* Ignored issues are kept ON THIS PAGE, collapsed, rather than
              filtered out of existence. A dismissal you cannot find again is a
              way to lose a real problem permanently by mis-clicking. */}
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-muted-foreground">
            {ignored.length} ignored {ignored.length === 1 ? "issue" : "issues"}
          </summary>
          <ul className="space-y-3 border-t border-border/60 p-4">
            {ignored.map((issue) => (
              <IssueCard key={issue.id} issue={issue} ignored />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function IssueCard({ issue, ignored = false }: { issue: RepairIssueView; ignored?: boolean }) {
  const critical = issue.severity === "critical";
  return (
    <li
      className={
        ignored
          ? "rounded-xl border border-border bg-muted/20 p-4 opacity-70"
          : "rounded-xl border border-border bg-card p-4"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={critical ? "danger" : "warning"}>
          {critical ? "Critical" : "Warning"}
        </StatusPill>
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{issue.title}</h2>
      </div>

      <p className="mt-2 text-sm leading-6 text-muted-foreground">{issue.description}</p>

      {/* First-seen, not just last-seen. "Since Tuesday" is the fact that turns
          a line on a page into a decision — a problem that started an hour ago
          and one that has been running for three weeks read identically
          otherwise. */}
      <p className="mt-2 text-[11px] text-muted-foreground/80">
        First seen {formatDateTime(issue.firstSeenAt)} · last confirmed {formatDateTime(issue.lastSeenAt)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {issue.fixRoute && (
          <Link href={issue.fixRoute} className="btn-primary btn-sm">
            Fix
            <ArrowRight className="size-4" />
          </Link>
        )}
        {ignored ? (
          <SaveForm action={restoreRepairIssue.bind(null, issue.id)} success="Back on the list.">
            <SaveButton className="btn-secondary btn-sm" pendingLabel="Restoring…">
              <Hammer className="size-4" />
              Un-ignore
            </SaveButton>
          </SaveForm>
        ) : (
          <SaveForm action={ignoreRepairIssue.bind(null, issue.id)} success="Ignored.">
            <SaveButton className="btn-secondary btn-sm" pendingLabel="Ignoring…">
              <BellOff className="size-4" />
              Ignore
            </SaveButton>
          </SaveForm>
        )}
      </div>
    </li>
  );
}
