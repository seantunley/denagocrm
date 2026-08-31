"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, GitBranch, Radio, Route } from "lucide-react";
import { toast } from "sonner";
import { setActiveFlow } from "@/app/actions/flow";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

export default function PublishFlowButton({
  flowId,
  label,
  channel,
  routeCount = 0,
  warnings = 0,
  draftNodes,
  liveNodes,
  liveVersion,
}: {
  flowId: string;
  label: string;
  channel?: string;
  routeCount?: number;
  warnings?: number;
  draftNodes?: number;
  liveNodes?: number | null;
  liveVersion?: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function publish() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const state = await setActiveFlow(flowId, {});
      if (state.error) {
        const errors = state.issues?.filter((issue) => issue.severity === "error") ?? [];
        const suffix = errors.length > 1 ? ` ${errors.length} problems in total.` : "";
        setError(`${state.error}${suffix}`);
        toast.error(state.error);
        return;
      }
      toast.success(state.ok ?? "Flow published");
      setOpen(false);
      router.refresh();
    });
  }

  const nodeDelta = liveNodes == null || draftNodes == null ? null : draftNodes - liveNodes;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); if (next) setError(null); } }}>
      <DialogTrigger asChild>
        <button type="button" className="btn-secondary btn-sm">{label}</button>
      </DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-lg" aria-busy={pending}>
        <DialogHeader className="text-left">
          <span className="mb-1 grid size-10 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
            <Radio className="size-5" />
          </span>
          <DialogTitle>Review before publishing</DialogTitle>
          <DialogDescription>
            Publishing creates a new immutable live version. Existing in-progress conversations stay pinned to the version they started on.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/25 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><GitBranch className="size-3.5" />Channel</p>
            <p className="mt-1 text-sm font-semibold capitalize">{channel ?? "Current flow channel"}</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/25 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Route className="size-3.5" />Routes affected</p>
            <p className="mt-1 text-sm font-semibold">{routeCount}</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/25 p-3">
            <p className="text-xs font-medium text-muted-foreground">Draft</p>
            <p className="mt-1 text-sm font-semibold">{draftNodes ?? "—"} nodes</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/25 p-3">
            <p className="text-xs font-medium text-muted-foreground">Current live</p>
            <p className="mt-1 text-sm font-semibold">{liveVersion ? `v${liveVersion}` : "Not published"}{liveNodes != null ? ` · ${liveNodes} nodes` : ""}</p>
          </div>
        </div>

        {nodeDelta !== null && nodeDelta !== 0 && (
          <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            This draft has {Math.abs(nodeDelta)} {nodeDelta > 0 ? "more" : "fewer"} node{Math.abs(nodeDelta) === 1 ? "" : "s"} than the current live version.
          </p>
        )}

        {warnings > 0 ? (
          <div className="flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{warnings} warning{warnings === 1 ? "" : "s"} remain. Warnings do not block publishing, but should be reviewed.</span>
          </div>
        ) : (
          <div className="flex gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>No publish warnings are currently reported for this saved draft.</span>
          </div>
        )}

        {error && <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild><button type="button" className="btn-secondary" disabled={pending}>Cancel</button></DialogClose>
          <button type="button" onClick={publish} disabled={pending} className="btn-primary">
            {pending ? "Publishing…" : liveVersion ? "Publish new version" : "Publish flow"}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
