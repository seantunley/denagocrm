"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRight, CalendarPlus, Check, CheckCircle2, Clock, History, MessageSquare, UserRound, Workflow } from "lucide-react";
import { completeActivity, scheduleFollowUp } from "@/app/actions/activities";
import { assignLead, moveLead } from "@/app/actions/leads";
import type { LeadPeek, PeekActivity } from "@/lib/records/leadPeek";
import { StatusPill } from "@/components/visual-system";
import ContactComposer from "./ContactComposer";

/**
 * A deal in the drawer (wave 2, W2-01/02/03): why it is worth acting on now (Today's
 * own reasons), Up next (its planned activities, overdue first), and the actions
 * the person may take — each one an existing server action that checks again.
 *
 * Nothing here pretends: a step is shown done only after its action succeeded, and
 * the record is then re-read from the server (`onChanged`). "Next deal" is offered
 * once something has actually been done, never instead of doing it.
 */
export default function LeadPeekView({ peek, onChanged, onNext }: { peek: LeadPeek; onChanged: () => void; onNext: (() => void) | null }) {
  const can = (id: LeadPeek["actions"][number]) => peek.actions.includes(id);
  const [composing, setComposing] = useState(false);
  const [did, setDid] = useState<string | null>(null);

  const done = (what: string) => {
    setDid(what);
    onChanged();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusPill tone="info">{peek.stage.name}</StatusPill>
        {peek.status !== "open" && <StatusPill tone="neutral">{peek.status === "nurture" ? "Nurturing" : peek.status}</StatusPill>}
        {peek.value && <span className="tabular-nums text-muted-foreground">{peek.value}</span>}
        <span className="text-muted-foreground">{peek.owner ? `Owner: ${peek.owner.name}` : "Unassigned"}</span>
      </div>
      {peek.opportunity && <p className="-mt-3 text-sm text-muted-foreground">{peek.opportunity}</p>}
      {/* Parked on purpose: waiting, not stale. Says when it comes back. */}
      {peek.nurture && (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">Nurturing{peek.nurture.reviewOn ? ` until ${peek.nurture.reviewOn}` : ""}.</span>{" "}
          <span className="text-muted-foreground">{`${peek.nurture.reason ?? "Parked for later."} It isn't due for contact before then.`}</span>
        </p>
      )}

      {did && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-400" />{did}</span>
          {onNext && (
            <button type="button" className="btn-primary btn-sm" onClick={onNext}>
              Next deal
              <ArrowRight className="size-4" />
            </button>
          )}
        </div>
      )}

      {peek.reasons.length > 0 && (
        <Section icon={Clock} title="Why now">
          <p className="text-sm font-medium">{peek.action}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {peek.reasons.map((reason) => (
              <li key={reason} className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-foreground/80">{reason}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section icon={Check} title="Up next">
        {peek.upNext.length === 0 ? (
          <p className="text-sm text-muted-foreground">No next step planned on this deal.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {peek.upNext.map((activity) => (
              <UpNextRow key={activity.id} activity={activity} canComplete={can("completeActivity")} onDone={() => done(`Done: ${activity.summary}`)} />
            ))}
          </ul>
        )}
        {can("schedule") && !composing && <ScheduleNext leadId={peek.id} defaultDate={peek.contact.nextStep?.date ?? peek.contact.retryDate} onDone={() => done("Next step booked")} />}
      </Section>

      {can("contact") && (
        <Section icon={MessageSquare} title="Contact">
          {composing ? (
            <ContactComposer
              {...peek.contact}
              leadId={peek.id}
              revalidate={`/leads/${peek.id}`}
              onCancel={() => setComposing(false)}
              onDone={() => {
                setComposing(false);
                done("Contact logged");
              }}
            />
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={() => setComposing(true)}>
              {peek.action}
              <ArrowRight className="size-4" />
            </button>
          )}
        </Section>
      )}

      {(can("changeStage") && peek.stages.length > 0) || (can("assignOwner") && peek.staff.length > 0) ? (
        <Section icon={Workflow} title="Deal">
          <div className="grid gap-3 sm:grid-cols-2">
            {can("changeStage") && peek.stages.length > 0 && (
              <PickAndSave
                label="Stage"
                options={peek.stages}
                current={peek.stage.id}
                button="Move"
                save={async (stageId) => {
                  const result = await moveLead(peek.id, stageId);
                  return result.ok ? null : result.error ?? "That move didn't go through. Open the full record to see why.";
                }}
                onDone={(name) => done(`Moved to ${name}`)}
              />
            )}
            {can("assignOwner") && peek.staff.length > 0 && (
              <PickAndSave
                label="Owner"
                icon={UserRound}
                options={peek.staff}
                current={peek.owner?.id ?? ""}
                button="Change"
                save={async (userId) => {
                  const result = await assignLead(peek.id, userId);
                  return result.ok ? null : result.error;
                }}
                onDone={(name) => done(`Now owned by ${name}`)}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Mark won or lost, and stages that start a workflow, are on the full record.</p>
        </Section>
      ) : null}

      {peek.recent.length > 0 && (
        <Section icon={History} title="Recently done">
          <ul className="space-y-1.5">
            {peek.recent.map((activity) => (
              <li key={activity.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{activity.summary}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{activity.when}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Check; title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Icon className="size-3.5 text-primary" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function UpNextRow({ activity, canComplete, onDone }: { activity: PeekActivity; canComplete: boolean; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete() {
    setPending(true);
    setError(null);
    try {
      const result = await completeActivity(activity.id, new FormData());
      // Still planned unless the action itself said it succeeded (it refuses, e.g., work dated for a later day).
      if (result && "error" in result && result.error) setError(result.error);
      else {
        toast.success("Marked done");
        onDone();
      }
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{activity.summary}</p>
          <p className="text-xs text-muted-foreground">
            <StatusPill tone={activity.overdue ? "danger" : "neutral"}>{activity.overdue ? `Overdue · ${activity.when}` : activity.when}</StatusPill>
            <span className="ml-2">{activity.type === "todo" ? "Task" : activity.type}{activity.owner ? ` · ${activity.mine ? "You" : activity.owner}` : ""}</span>
          </p>
        </div>
        {canComplete && (
          <button type="button" className="btn-secondary btn-sm shrink-0" onClick={complete} disabled={pending}>
            {pending ? "Working…" : "Mark done"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
    </li>
  );
}

function ScheduleNext({ leadId, defaultDate, onDone }: { leadId: string; defaultDate: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("09:00");
  const [summary, setSummary] = useState("Follow-up call");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => setOpen(true)}>
        <CalendarPlus className="size-4" />
        Book the next step
      </button>
    );
  }
  async function save() {
    setPending(true);
    setError(null);
    try {
      const result = await scheduleFollowUp({ leadId, type: "call", when: `${date}T${time}`, summary: summary.trim() || undefined });
      if (!result.ok) setError(result.error ?? "That didn't go through. Try again.");
      else {
        setOpen(false);
        toast.success("Next step booked");
        onDone();
      }
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(false);
    }
  }
  const id = `next-${leadId}`;
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
        <div>
          <label htmlFor={`${id}-date`} className="label">On</label>
          <input id={`${id}-date`} type="date" className="input" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-time`} className="label">At</label>
          <input id={`${id}-time`} type="time" className="input" value={time} onChange={(event) => setTime(event.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-what`} className="label">What</label>
        <input id={`${id}-what`} className="input" value={summary} onChange={(event) => setSummary(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
        <button type="button" className="btn-primary btn-sm" onClick={save} disabled={pending || !date} title={!date ? "Pick a date first" : undefined}>{pending ? "Booking…" : "Book"}</button>
      </div>
    </div>
  );
}

function PickAndSave({ label, icon: Icon, options, current, button, save, onDone }: {
  label: string;
  icon?: typeof Check;
  options: { id: string; name: string }[];
  current: string;
  button: string;
  /** Returns the refusal to show, or null once it is done. */
  save: (id: string) => Promise<string | null | undefined>;
  onDone: (name: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `pick-${label.toLowerCase()}`;

  async function run() {
    setPending(true);
    setError(null);
    try {
      const refusal = await save(value);
      if (refusal) setError(refusal);
      else onDone(options.find((option) => option.id === value)?.name ?? label);
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <label htmlFor={id} className="label inline-flex items-center gap-1">{Icon && <Icon className="size-3.5" />}{label}</label>
      <div className="flex gap-2">
        <select id={id} className="input" value={value} onChange={(event) => setValue(event.target.value)}>
          {!options.some((option) => option.id === current) && <option value={current}>—</option>}
          {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        <button type="button" className="btn-secondary btn-sm shrink-0" onClick={run} disabled={pending || value === current || !value} title={value === current || !value ? `Pick a different ${label.toLowerCase()} first` : undefined}>
          {pending ? "…" : button}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
