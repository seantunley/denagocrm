"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setActiveFlow, type PublishFlowState } from "@/app/actions/flow";

const initial: PublishFlowState = {};

/**
 * Publishing used to be a bare `<form action={setActiveFlow.bind(null, id)}>`, and
 * the action swallowed every failure into null. The server validates more than the
 * editor can — a Journey disabled since the draft was written, a draft that moved
 * during publication, an action whose failure route would announce success — so a
 * correct refusal reached the owner as a button that did nothing.
 *
 * The refusal is now shown, with the compiler's own words.
 */
export default function PublishFlowButton({ flowId, label }: { flowId: string; label: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(setActiveFlow.bind(null, flowId), initial);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.ok);
      router.refresh();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, router]);

  const errors = state.issues?.filter((issue) => issue.severity === "error") ?? [];

  return (
    <form action={action} className="contents">
      <button className="btn-secondary btn-sm" disabled={pending}>
        {pending ? "Publishing…" : label}
      </button>
      {state.error && (
        <p className="mt-2 basis-full text-xs text-red-300">
          {state.error}
          {errors.length > 1 && (
            <span className="mt-1 block text-muted-foreground">
              {errors.length} problem{errors.length === 1 ? "" : "s"} in total — open the draft to see them on the canvas.
            </span>
          )}
        </p>
      )}
    </form>
  );
}
