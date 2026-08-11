"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, GitBranch, LayoutGrid } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The sentinel for "show me every pipeline at once", as a summary. */
export const ALL_PIPELINES = "all";

export type PipelineOption = { id: string; name: string; isDefault: boolean };

/**
 * Which pipeline the board is operating on.
 *
 * A Kanban has ONE pipeline as its context. Rendering every stage regardless of
 * pipeline put a Discovery column from Sales beside a Triage column from
 * Service, in one board, with drag between them — a move that has no meaning and
 * that the stage's own entry actions and probabilities cannot answer for.
 *
 * "All pipelines" is deliberately NOT a board. It is a read-only summary, because
 * the moment it becomes draggable it is the same mixed board again under a
 * friendlier name.
 *
 * The choice lives in the URL rather than in component state so it survives a
 * refresh, is linkable, and is readable by the server component that has to do
 * the filtering.
 */
export default function PipelineSwitcher({
  pipelines,
  activeId,
}: {
  pipelines: PipelineOption[];
  /** null when showing the aggregated summary. */
  activeId: string | null;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  const href = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("pipeline", value);
    return `${pathname}?${next.toString()}`;
  };

  const active = pipelines.find((p) => p.id === activeId) ?? null;
  const label = active ? active.name : "All pipelines";

  // One pipeline and nothing to choose between: a switcher would be furniture.
  if (pipelines.length <= 1 && activeId) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="btn-secondary btn-sm"
          aria-label={`Pipeline: ${label}`}
        >
          {active ? <GitBranch className="size-4" /> : <LayoutGrid className="size-4" />}
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[15rem]">
        <DropdownMenuLabel className="text-muted-foreground">Pipeline</DropdownMenuLabel>
        {pipelines.map((pipeline) => (
          <DropdownMenuItem key={pipeline.id} asChild>
            <Link href={href(pipeline.id)} className={cn(pipeline.id === activeId && "bg-accent")}>
              <GitBranch className="size-4" />
              <span className="min-w-0 flex-1 truncate">{pipeline.name}</span>
              {pipeline.isDefault && (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">default</span>
              )}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={href(ALL_PIPELINES)} className={cn(!activeId && "bg-accent")}>
            <LayoutGrid className="size-4" />
            <span className="min-w-0 flex-1">All pipelines</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">summary</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
