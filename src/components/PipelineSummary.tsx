import Link from "next/link";
import { GitBranch, Layers3 } from "lucide-react";
import { formatZAR } from "@/lib/format";
import { EmptyState, Surface } from "@/components/visual-system";

export type PipelineSummaryRow = {
  id: string;
  name: string;
  stageCount: number;
  openCount: number;
  openValueCents: number;
};

/**
 * Every pipeline at once — as a summary, deliberately not as a board.
 *
 * The board used to render every stage regardless of pipeline, which put a
 * Discovery column from Sales beside a Triage column from Service on one
 * draggable surface. Dragging between them is a move with no meaning: the target
 * stage's entry action, probability and close semantics belong to a different
 * process entirely.
 *
 * So "All pipelines" answers the question that view was really being used for —
 * where is the work, across everything — and hands off to a real board to act.
 */
export default function PipelineSummary({ pipelines }: { pipelines: PipelineSummaryRow[] }) {
  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={Layers3}
        title="No active pipelines"
        description="Create one in Settings → Pipelines to start tracking deals."
      />
    );
  }

  const totalOpen = pipelines.reduce((sum, p) => sum + p.openCount, 0);
  const totalValue = pipelines.reduce((sum, p) => sum + p.openValueCents, 0);

  return (
    <div className="space-y-4">
      <Surface className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            All pipelines
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalOpen} open · {formatZAR(totalValue)} across {pipelines.length} pipeline
            {pipelines.length === 1 ? "" : "s"}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Choose a pipeline above to work its board.
        </p>
      </Surface>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {pipelines.map((pipeline) => (
          <Link
            key={pipeline.id}
            href={`/leads?pipeline=${encodeURIComponent(pipeline.id)}`}
            className="group"
          >
            <Surface className="flex h-full flex-col p-5 transition hover:border-primary/35">
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg border border-border bg-card">
                  <GitBranch className="size-4" />
                </span>
                <p className="min-w-0 flex-1 truncate font-medium">{pipeline.name}</p>
              </div>
              <p className="mt-4 text-2xl font-semibold tracking-tight">
                {formatZAR(pipeline.openValueCents)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {pipeline.openCount} open · {pipeline.stageCount} stage
                {pipeline.stageCount === 1 ? "" : "s"}
              </p>
              <span className="mt-4 text-xs text-primary opacity-0 transition group-hover:opacity-100">
                Open this board →
              </span>
            </Surface>
          </Link>
        ))}
      </div>
    </div>
  );
}
