"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { moveLead } from "@/app/actions/leads";

/**
 * Move the deal to another stage from the inbox rail — the board's own action (moveLead), so permissions, stage rules
 * and the audit trail are the same. A stage that asks for more first (a test drive, a customer, a quote, or a reason
 * to override a rule) is finished on the board, where those dialogs live; the rail says so instead of guessing.
 */
export default function DealStageSelect({ leadId, stageId, color, stages }: {
  leadId: string;
  stageId: string;
  color: string;
  /** The deal's own pipeline's open stages, in order. */
  stages: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(stageId);
  const [needsBoard, setNeedsBoard] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function move(next: string) {
    if (next === value) return;
    const before = value;
    const name = stages.find((stage) => stage.id === next)?.name ?? "that stage";
    setValue(next);
    setNeedsBoard(null);
    start(async () => {
      try {
        const result = await moveLead(leadId, next);
        if (result.ok) {
          toast.success(`Moved to ${name}`);
          router.refresh();
          return;
        }
        setValue(before);
        if (result.error) toast.error(result.error);
        // No error: the stage wants something first (remedy) or a reason for overriding a rule.
        else setNeedsBoard(name);
      } catch (error) {
        unstable_rethrow(error);
        setValue(before);
        toast.error("The move didn't go through. Please try again.");
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <select
          aria-label="Stage"
          className="min-w-0 max-w-40 truncate rounded-md border border-border bg-background px-1.5 py-0.5 text-sm"
          value={value}
          disabled={pending}
          onChange={(event) => move(event.target.value)}
        >
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </select>
      </span>
      {needsBoard ? (
        <p className="text-right text-xs text-amber-600 dark:text-amber-300" role="status">
          {needsBoard} asks for more first — <Link href="/leads" className="underline underline-offset-2">move it on the board</Link>.
        </p>
      ) : null}
    </div>
  );
}
