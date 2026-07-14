"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Check,
  Phone,
  Mail,
  MessageCircle,
  Users,
  Car,
  CalendarPlus,
  FileText,
  Trophy,
  XCircle,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import {
  completeActivityAssess,
  rescheduleActivity,
  scheduleFollowUp,
} from "@/app/actions/activities";
import { markWon, markLost } from "@/app/actions/leads";
import { fireConfetti } from "@/lib/confetti";
import { createQuoteFromLead } from "@/app/actions/quotes";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const input =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

function defaultFollowUp(): string {
  const d = new Date(Date.now() + 2 * 86400000);
  return `${d.toISOString().slice(0, 10)}T10:00`;
}

/* ── the "what's next?" dialog ───────────────────────────────────── */

export function NextStepDialog({
  open,
  leadId,
  leadName,
  onClose,
}: {
  open: boolean;
  leadId: string;
  leadName: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "followup" | "lost">("choose");
  const [fuType, setFuType] = useState("call");
  const [fuWhen, setFuWhen] = useState(defaultFollowUp());
  const [lostReason, setLostReason] = useState("");
  const [shake, setShake] = useState(false);
  const [pending, start] = useTransition();

  function reset() {
    setMode("choose");
    setLostReason("");
    setFuType("call");
    setFuWhen(defaultFollowUp());
  }

  const choice =
    "flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent/50";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What&apos;s next for {leadName}?</DialogTitle>
          <DialogDescription>
            This lead has no planned next step — decide now so it doesn&apos;t go stale on the
            board.
          </DialogDescription>
        </DialogHeader>

        {mode === "choose" && (
          <div className="space-y-2">
            <button className={choice} onClick={() => setMode("followup")}>
              <CalendarPlus className="size-4 shrink-0 text-primary" />
              <span className="flex-1">
                Schedule a follow-up
                <span className="block text-xs text-muted-foreground">
                  Call, message, meeting or another test drive
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>

            <button
              className={choice}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  toast.success("Creating a quote…");
                  await createQuoteFromLead(leadId); // redirects to the new quote
                })
              }
            >
              <FileText className="size-4 shrink-0 text-sky-400" />
              <span className="flex-1">
                Send a quote
                <span className="block text-xs text-muted-foreground">
                  Draft a quote for this lead now
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>

            <button
              className={choice}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  fireConfetti();
                  toast.success(`${leadName} marked WON 🎉`);
                  await markWon(leadId); // redirects to the contact
                })
              }
            >
              <Trophy className="size-4 shrink-0 text-emerald-400" />
              <span className="flex-1">
                We won the deal
                <span className="block text-xs text-muted-foreground">
                  Marks the lead won and opens the customer
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>

            <button className={choice} onClick={() => setMode("lost")}>
              <XCircle className="size-4 shrink-0 text-red-400" />
              <span className="flex-1">
                We lost it
                <span className="block text-xs text-muted-foreground">
                  Record the reason and close the lead
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>

            <button
              className="w-full pt-1 text-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Skip for now
            </button>
          </div>
        )}

        {mode === "followup" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
                <select className={input} value={fuType} onChange={(e) => setFuType(e.target.value)}>
                  <option value="call">Call</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="meeting">Meeting</option>
                  <option value="test_drive">Test drive</option>
                  <option value="todo">To-do</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">When</label>
                <input
                  type="datetime-local"
                  className={input}
                  value={fuWhen}
                  onChange={(e) => setFuWhen(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode("choose")}>
                Back
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await scheduleFollowUp({ leadId, type: fuType, when: fuWhen });
                    if (r.ok) {
                      toast.success("Follow-up scheduled");
                      reset();
                      onClose();
                    } else toast.error(r.error ?? "Couldn't schedule");
                  })
                }
              >
                <CalendarPlus className="size-4" />
                Schedule
              </Button>
            </div>
          </div>
        )}

        {mode === "lost" && (
          <form
            className={shake ? "space-y-3 animate-shake" : "space-y-3"}
            onAnimationEnd={() => setShake(false)}
            action={(fd) =>
              start(async () => {
                if (!String(fd.get("lostReason") ?? "").trim()) {
                  setShake(true);
                  toast.error("A reason is required");
                  return;
                }
                toast(`${leadName} marked lost`);
                await markLost(leadId, fd);
                reset();
                onClose();
              })
            }
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Why did we lose it?
              </label>
              <input
                name="lostReason"
                className={input}
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                placeholder="Price, timing, bought elsewhere…"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setMode("choose")}>
                Back
              </Button>
              <Button type="submit" variant="destructive" size="sm" disabled={pending}>
                <XCircle className="size-4" />
                Mark lost
              </Button>
            </div>
          </form>
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}

/* ── ✓ button that enforces the loop ─────────────────────────────── */

export function CompleteActivityButton({ activityId }: { activityId: string }) {
  const [nextStep, setNextStep] = useState<{ leadId: string; leadName: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <>
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await completeActivityAssess(activityId, "").catch(() => null);
            if (!res) {
              toast.error("Couldn't complete the activity");
              return;
            }
            if (res.needsNextStep && res.leadId) {
              setNextStep({ leadId: res.leadId, leadName: res.leadName ?? "this lead" });
            } else {
              toast.success("Marked done");
            }
          })
        }
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-emerald-500/15 hover:text-emerald-400 disabled:opacity-50"
        title="Mark done"
      >
        <Check className="size-4" />
      </button>
      {nextStep && (
        <NextStepDialog
          open
          leadId={nextStep.leadId}
          leadName={nextStep.leadName}
          onClose={() => setNextStep(null)}
        />
      )}
    </>
  );
}

/* ── on-open queue: "did Friday's test drive happen?" ────────────── */

export type OverduePrompt = {
  id: string;
  type: string;
  summary: string;
  dueLabel: string;
  leadId: string | null;
  leadName: string | null;
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  whatsapp: MessageCircle,
  meeting: Users,
  test_drive: Car,
};

export function FollowUpPrompts({ prompts }: { prompts: OverduePrompt[] }) {
  // Once per browser session, max 3 — nudge, don't nag.
  const eligible = useMemo(() => {
    if (typeof window === "undefined") return [];
    try {
      if (sessionStorage.getItem("denago-prompted")) return [];
    } catch {}
    return prompts.slice(0, 3);
  }, [prompts]);

  const [idx, setIdx] = useState(0);
  const [note, setNote] = useState("");
  const [reschedWhen, setReschedWhen] = useState(defaultFollowUp());
  const [view, setView] = useState<"ask" | "reschedule">("ask");
  const [nextStep, setNextStep] = useState<{ leadId: string; leadName: string } | null>(null);
  const [pending, start] = useTransition();

  const current = eligible[idx];
  const open = !!current && !nextStep;

  function advance() {
    setNote("");
    setView("ask");
    setReschedWhen(defaultFollowUp());
    if (idx + 1 >= eligible.length) {
      try {
        sessionStorage.setItem("denago-prompted", "1");
      } catch {}
      setIdx(eligible.length); // closes
    } else {
      setIdx((i) => i + 1);
    }
  }

  if (eligible.length === 0 && !nextStep) return null;
  const Icon = current ? TYPE_ICONS[current.type] ?? Check : Check;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            try {
              sessionStorage.setItem("denago-prompted", "1");
            } catch {}
            setIdx(eligible.length);
          }
        }}
      >
        <ResponsiveDialogContent className="sm:max-w-md">
          {current && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon className="size-4 text-primary" />
                  Did this happen?
                </DialogTitle>
                <DialogDescription>
                  <span className="font-medium text-foreground">{current.summary}</span>
                  {`${current.leadName ? ` — ${current.leadName}` : ""} · was due ${current.dueLabel}${
                    eligible.length > 1 ? ` · ${idx + 1} of ${eligible.length}` : ""
                  }`}
                </DialogDescription>
              </DialogHeader>

              {view === "ask" && (
                <div className="space-y-3">
                  <textarea
                    className={cn(input, "min-h-16")}
                    placeholder="Outcome note (optional) — goes on the timeline"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const res = await completeActivityAssess(current.id, note).catch(() => null);
                          if (!res) {
                            toast.error("Something went wrong");
                            return;
                          }
                          toast.success("Logged — nice one");
                          if (res.needsNextStep && res.leadId) {
                            setNextStep({
                              leadId: res.leadId,
                              leadName: res.leadName ?? "this lead",
                            });
                          }
                          advance();
                        })
                      }
                    >
                      <Check className="size-4" />
                      Yes, it happened
                    </Button>
                    <Button variant="outline" disabled={pending} onClick={() => setView("reschedule")}>
                      No — rebook it
                    </Button>
                  </div>
                  <button
                    className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                    onClick={advance}
                  >
                    Ask me later
                  </button>
                </div>
              )}

              {view === "reschedule" && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      New date &amp; time
                    </label>
                    <input
                      type="datetime-local"
                      className={input}
                      value={reschedWhen}
                      onChange={(e) => setReschedWhen(e.target.value)}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setView("ask")}>
                      Back
                    </Button>
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const r = await rescheduleActivity(current.id, reschedWhen);
                          if (r.ok) {
                            toast.success("Rebooked");
                            advance();
                          } else toast.error(r.error ?? "Couldn't reschedule");
                        })
                      }
                    >
                      <CalendarPlus className="size-4" />
                      Rebook
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </ResponsiveDialogContent>
      </Dialog>

      {nextStep && (
        <NextStepDialog
          open
          leadId={nextStep.leadId}
          leadName={nextStep.leadName}
          onClose={() => setNextStep(null)}
        />
      )}
    </>
  );
}
