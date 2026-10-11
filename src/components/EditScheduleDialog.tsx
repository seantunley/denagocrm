"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { updateAssistantSchedule } from "@/app/actions/assistantSchedules";
import type { Cadence } from "@/lib/assistantSchedule";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Schedules run on the hour or half past, so those are the only times offered.
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const CADENCE_LABELS: Record<Cadence, string> = { once: "Once", daily: "Every day", weekdays: "Weekdays (Mon–Fri)", weekly: "Every week" };

export type EditableSchedule = { id: string; question: string; cadence: string; weekday: number | null; timeOfDay: string; onDate: string | null };

/**
 * Edit one scheduled question on the Ask page: what it asks, how often, and
 * when. The server checks it again with the same rules as creating one; this
 * only offers what those rules allow (a weekday with a weekly, a date with a
 * one-off, a time on the half hour).
 */
export default function EditScheduleDialog({ schedule }: { schedule: EditableSchedule }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = () => ({
    question: schedule.question,
    cadence: (schedule.cadence in CADENCE_LABELS ? schedule.cadence : "daily") as Cadence,
    weekday: schedule.weekday ?? 1,
    timeOfDay: TIMES.includes(schedule.timeOfDay) ? schedule.timeOfDay : "08:00",
    onDate: schedule.onDate ?? "",
  });
  const [form, setForm] = useState(initial);
  const valid = form.question.trim().length > 0 && (form.cadence !== "once" || /^\d{4}-\d{2}-\d{2}$/.test(form.onDate));

  async function save() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updateAssistantSchedule(schedule.id, {
        question: form.question.trim(),
        cadence: form.cadence,
        timeOfDay: form.timeOfDay,
        ...(form.cadence === "weekly" ? { weekday: form.weekday } : {}),
        ...(form.cadence === "once" ? { onDate: form.onDate } : {}),
      });
      if (result?.error) {
        setError(result.error);
        return;
      }
      toast.success(result?.success ?? "Saved");
      setOpen(false);
    } catch {
      setError("Couldn't save that — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        setOpen(next);
        if (next) {
          setForm(initial());
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground">Edit</button>
      </DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-lg" aria-busy={busy}>
        <DialogHeader className="text-left">
          <DialogTitle>Edit scheduled question</DialogTitle>
          <DialogDescription>It runs as you, on the hour or half past. Answers it already gave stay in your history.</DialogDescription>
        </DialogHeader>
        <label className="space-y-1.5 text-sm font-medium text-foreground">
          <span>Question</span>
          <textarea
            autoFocus
            className="input min-h-24"
            maxLength={300}
            value={form.question}
            disabled={busy}
            onChange={(event) => setForm({ ...form, question: event.target.value })}
          />
          <span className="block text-xs font-normal text-muted-foreground">{form.question.trim().length}/300</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium text-foreground">
            <span>How often</span>
            <select className="input" value={form.cadence} disabled={busy} onChange={(event) => setForm({ ...form, cadence: event.target.value as Cadence })}>
              {(Object.keys(CADENCE_LABELS) as Cadence[]).map((cadence) => (
                <option key={cadence} value={cadence}>{CADENCE_LABELS[cadence]}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm font-medium text-foreground">
            <span>Time</span>
            <select className="input" value={form.timeOfDay} disabled={busy} onChange={(event) => setForm({ ...form, timeOfDay: event.target.value })}>
              {TIMES.map((time) => (
                <option key={time} value={time}>{time}</option>
              ))}
            </select>
          </label>
          {form.cadence === "weekly" && (
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              <span>Day of the week</span>
              <select className="input" value={form.weekday} disabled={busy} onChange={(event) => setForm({ ...form, weekday: Number(event.target.value) })}>
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>{day}</option>
                ))}
              </select>
            </label>
          )}
          {form.cadence === "once" && (
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              <span>Date</span>
              <input type="date" className="input" value={form.onDate} disabled={busy} onChange={(event) => setForm({ ...form, onDate: event.target.value })} />
            </label>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary" disabled={busy}>Cancel</button>
          </DialogClose>
          <button type="button" className="btn-primary" disabled={busy || !valid} onClick={save}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
