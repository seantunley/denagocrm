"use client";

import { useTransition } from "react";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { restoreLeadAttention } from "@/app/actions/attention";

/**
 * Put a dismissed lead back on the list.
 *
 * No confirmation and no reason, deliberately: restoring ADDS work to somebody's
 * queue, and nothing is lost if it was a misclick — the row simply reappears with
 * its signals. Dismissing is the direction that needs an argument.
 */
export default function RestoreAttentionButton({ leadId, name, signalKey }: { leadId: string; name: string; signalKey?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn-ghost btn-sm shrink-0"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
      const result = await restoreLeadAttention(leadId, signalKey).catch(() => ({
            ok: false as const,
            error: "Couldn't restore this deal",
          }));
          if (!result.ok) {
            toast.error(result.error ?? "Couldn't restore this deal");
            return;
          }
          toast.success(`${name} is back on the list`);
          router.refresh();
        })
      }
    >
      <Undo2 className="size-3.5" />
      {pending ? "Restoring…" : "Restore"}
    </button>
  );
}
