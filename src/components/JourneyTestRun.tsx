"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Play } from "lucide-react";
import { runJourneyOnLead } from "@/app/actions/journeyRuns";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { FeedbackBanner, StatusPill } from "@/components/visual-system";

/**
 * Run a journey against one chosen lead, from the journey list.
 *
 * `runJourneyOnLead` had no caller at all, so the only way to test a journey was
 * to wait for the real trigger to happen to a real customer. Two things this
 * screen has to get right, both of them stated in that action's doc comment:
 *
 *  1. It REALLY SENDS. Not a dry run, deliberately — the half of a journey that
 *     breaks is the message, the merge fields and the consent gate, and only a
 *     real send exercises those. So the warning goes in front of the button, not
 *     in a tooltip, and it names the lead that is about to receive mail.
 *  2. The answer is the whole point. "Ran" with nothing sent and no reason is
 *     the exact failure the activity trace exists to stop, so the refusal string
 *     and the final run status are rendered verbatim rather than flattened into
 *     a toast that says "Done".
 */

/** Pinned to the action, so a change to its shape breaks here rather than silently. */
type TestRunResult = Awaited<ReturnType<typeof runJourneyOnLead>>;

/** A lead as the operator has to recognise it — `title` falls back to `name`. */
export type JourneyTestLead = { id: string; label: string };

/** How a finished run should read at a glance. */
function statusTone(status: string) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "blocked" || status === "waiting") return "warning" as const;
  return "info" as const;
}

export default function JourneyTestRun({
  journeyId,
  journeyName,
  leads,
}: {
  journeyId: string;
  journeyName: string;
  leads: JourneyTestLead[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [leadId, setLeadId] = useState("");
  const [result, setResult] = useState<TestRunResult | null>(null);

  const lead = leads.find((option) => option.id === leadId);

  const run = () => {
    if (!leadId || pending) return;
    start(async () => {
      try {
        setResult(await runJourneyOnLead(journeyId, leadId));
      } catch (error) {
        unstable_rethrow(error);
        setResult({ ok: false, error: "The test run could not be started. Please try again." });
      }
      // The run and its step log land underneath this dialog; the dialog itself
      // is client state and stays open, holding the answer.
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && !next) return;
        setOpen(next);
        // A stale result beside a freshly picked lead reads as that lead's
        // result. Clear it when the dialog closes.
        if (!next) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className="btn-secondary btn-sm">
          <Play className="size-4" />
          Test on a lead
        </button>
      </DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-lg" aria-busy={pending}>
        <DialogHeader className="text-left">
          <span className="mb-1 grid size-10 place-items-center rounded-xl border border-amber-400/20 bg-amber-400/10 text-amber-300">
            <AlertTriangle className="size-5" />
          </span>
          <DialogTitle>Test “{journeyName}” on a real lead</DialogTitle>
          <DialogDescription>
            This is not a dry run. The journey enrols the lead you pick and its steps execute for
            real — emails, SMS, push notifications, stage moves and tasks all happen, to that lead
            and to whoever the steps notify.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="label" htmlFor={`test-lead-${journeyId}`}>Lead to run against</label>
            <select
              id={`test-lead-${journeyId}`}
              className="input"
              value={leadId}
              onChange={(event) => { setLeadId(event.target.value); setResult(null); }}
              disabled={pending || leads.length === 0}
            >
              <option value="">Choose a lead…</option>
              {leads.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            {leads.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                There are no open leads to test against yet.
              </p>
            )}
          </div>

          {lead && (
            <FeedbackBanner tone="warning" title={`“${lead.label}” will really be contacted`}>
              Use a lead you own, or one created for testing. There is no undo on a sent message.
            </FeedbackBanner>
          )}

          {/* The result, in full. A refusal is an answer, not an error to hide:
              “not enrolled — entry conditions did not match” is the single most
              useful thing this screen can say. */}
          {result && !result.ok && (
            <FeedbackBanner tone="danger" title="Nothing was sent">
              {result.error}
            </FeedbackBanner>
          )}
          {result?.ok && (
            <FeedbackBanner
              tone={statusTone(result.status)}
              title={
                <span className="flex items-center gap-2">
                  Enrolled — run is <StatusPill tone={statusTone(result.status)}>{result.status}</StatusPill>
                </span>
              }
            >
              <span className="block">Run {result.runId.slice(-8)}</span>
              {result.status === "blocked" && (
                <span className="block mt-1">
                  Parked behind a run already open for this lead — that is run mode “queued” doing
                  its job, and it will start when the other one finishes.
                </span>
              )}
              {result.error && <span className="block mt-1">Last error: {result.error}</span>}
            </FeedbackBanner>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary" disabled={pending}>
              {result ? "Close" : "Cancel"}
            </button>
          </DialogClose>
          <button type="button" className="btn-primary" onClick={run} disabled={pending || !leadId}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {result ? "Run again" : "Run it for real"}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
