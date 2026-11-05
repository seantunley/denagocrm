"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { toggleRecordWatch } from "@/app/actions/collaboration";
import type { WatchableType } from "@/lib/collaborationRules";

/** Watch a lead, customer or job card: hear about its notes, stage or status changes and customer replies. */
export default function WatchButton({ type, id, watching, count }: { type: WatchableType; id: string; watching: boolean; count: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const others = count - (watching ? 1 : 0);
  const title = watching
    ? `You're watching this${others > 0 ? ` with ${others} other${others === 1 ? "" : "s"}` : ""}. Click to stop.`
    : `Hear about new notes, changes and customer replies${count > 0 ? ` (${count} watching)` : ""}.`;
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      aria-pressed={watching}
      title={title}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await toggleRecordWatch(type, id);
          if (result && "error" in result && result.error) toast.error(String(result.error));
          else if (result && "success" in result && result.success) toast.success(String(result.success));
          router.refresh();
        })
      }
    >
      {watching ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      {watching ? "Watching" : "Watch"}
      {count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
    </button>
  );
}
