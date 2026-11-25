"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Clock3 } from "lucide-react";
import { completeActivity, rescheduleActivity } from "@/app/actions/activities";
import { Surface } from "@/components/visual-system";

/**
 * "Next step" on the deal page: the deal's next planned activity and who has it,
 * a warning when its date doesn't make sense (lib/dealStand.ts nextStepWarning),
 * and the moves that fix it here — through the existing activity actions, which
 * check access and the calendar again. Nothing is shown as done until the server
 * says so. Without Activities access the page passes only when (summary/type/who null).
 */
export default function DealNextStepCard({ next, warning, tomorrow, canManage, scheduleHref }: {
  next: { id: string; summary: string | null; type: string | null; who: string | null; when: string } | null;
  warning: string | null;
  /** Tomorrow's date (YYYY-MM-DD) in the workspace's time zone. */
  tomorrow: string;
  canManage: boolean;
  scheduleHref: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"move" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "move" | "done") {
    if (!next) return;
    setPending(kind);
    setError(null);
    try {
      if (kind === "move") {
        const result = await rescheduleActivity(next.id, `${tomorrow}T09:00`);
        if (!result.ok) return setError(result.error ?? "That didn't go through. Try again.");
        toast.success("Moved to tomorrow 09:00");
      } else {
        const result = await completeActivity(next.id, new FormData());
        if (result && "error" in result && result.error) return setError(result.error);
        toast.success("Marked done");
      }
      router.refresh();
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Surface className="p-5" aria-label="Next step">
      <div className="flex items-center gap-2">
        <Clock3 className="size-5 text-primary" aria-hidden="true" />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Next step</p>
      </div>
      {next ? (
        <div className="mt-3">
          <p className="text-sm font-semibold">{next.summary ?? `Planned for ${next.when}`}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {[next.type ? (next.type === "todo" ? "Task" : next.type) : null, next.summary ? next.when : null, next.who ? `with ${next.who}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Nothing planned.</p>
      )}
      {warning && <p className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-200">{warning}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {next && canManage && warning && (
          <button type="button" className="btn-primary btn-sm" onClick={() => run("move")} disabled={pending !== null} title={pending !== null ? "Saving the last change…" : undefined}>
            {pending === "move" ? "Moving…" : "Move to tomorrow 09:00"}
          </button>
        )}
        {scheduleHref && <Link href={scheduleHref} className="btn-secondary btn-sm">{next ? "Reschedule" : "Book the next step"}</Link>}
        {next && canManage && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => run("done")} disabled={pending !== null} title={pending !== null ? "Saving the last change…" : undefined}>
            {pending === "done" ? "Working…" : "Mark done"}
          </button>
        )}
      </div>
    </Surface>
  );
}
