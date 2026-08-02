import Link from "next/link";
import { CircleSlash, GitBranch, Repeat, TriangleAlert } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { JOURNEY_STEP_LABELS, type JourneyStepType } from "@/lib/journeyTypes";
import type { TraceRunDetail } from "@/lib/journeyTrace";
import {
  OPEN_RUN_STATUSES,
  buildTraceTree,
  chooseOutline,
  definitionNodeAt,
  describeOperator,
  describeValue,
  iterationsToExpand,
  repeatPlan,
  stepOutcome,
  summariseRepeat,
  takenChooseOption,
  type TraceGroup,
  type TraceNode,
} from "@/lib/journeyTraceTree";
import { StatusPill } from "@/components/visual-system";

/**
 * THE PATH A RUN ACTUALLY TOOK — an indented timeline, not a highlighted graph.
 *
 * The builder graph was the obvious answer and it is the wrong one. A `repeat`
 * visits the same node on every pass, so a graph can only colour that node once:
 * iteration three's failure and iteration one's success collapse into a single
 * badge, and the reader is back to the problem `@@unique([runId, path])` was
 * added to solve — a step id cannot identify an EXECUTION. (The builder has no
 * visual editor for choose/repeat at all, so for the nested case there is not
 * even a geometry to highlight.) A timeline keeps the three things a graph
 * loses: order, repetition, and elapsed time.
 *
 * What the graph does better is the road not taken, so that is imported rather
 * than abandoned: a `choose` lists EVERY branch it declares, with the one that
 * ran expanded and the rest greyed. "Why did it not send the other one" is the
 * question that brings someone here, and a trace of only what happened cannot
 * answer it.
 */

function stepLabel(type: string): string {
  return JOURNEY_STEP_LABELS[type as JourneyStepType] ?? type;
}

function nodeName(definitionNode: Record<string, unknown> | null, fallback: string): string {
  const name = definitionNode?.name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

function duration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/* ── one execution ───────────────────────────────────────────────────────── */

function StepRow({ node, run }: { node: TraceNode; run: TraceRunDetail }) {
  const { step } = node;
  const outcome = stepOutcome(step, run.status);
  const definitionNode = node.parsed ? definitionNodeAt(run.definition, node.parsed) : null;
  const isCurrent = run.cursorPath === step.path;
  const elapsed = duration(step.durationMs);

  return (
    <div
      className={
        isCurrent
          ? "rounded-lg border border-sky-400/40 bg-sky-400/[0.06] p-3"
          : "rounded-lg border border-border/60 bg-background/40 p-3"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">
          {nodeName(definitionNode, step.stepId)}
        </span>
        <span className="text-[11px] text-muted-foreground">{stepLabel(step.stepType)}</span>
        <StatusPill tone={outcome.tone}>{outcome.label}</StatusPill>
        {node.orphaned && (
          <StatusPill tone="warning">Container missing</StatusPill>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {elapsed && <span className="tabular-nums">{elapsed}</span>}
          <span>{formatDateTime(step.startedAt)}</span>
        </span>
      </div>

      {/* The path, verbatim. It is what the database holds and what a support
          conversation quotes; deriving it back by hand from the indentation is
          exactly the work this screen is here to remove. */}
      <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground/70">{step.path}</p>

      {step.note && <p className="mt-1.5 text-[12px] text-muted-foreground">{step.note}</p>}

      {step.nextRunAt && step.status === "running" && (
        <p className="mt-1.5 text-[12px] text-amber-300">
          Held — not sent. Next attempt {formatDateTime(step.nextRunAt)}.
        </p>
      )}

      {outcome.label === "Never finished" && (
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          Started but never wrote a result, and the run has since closed. The step was interrupted
          mid-flight rather than skipped.
        </p>
      )}

      {step.clauses && step.clauses.length > 0 && (
        <ul className="mt-2 space-y-1">
          {step.clauses.map((clause, index) => (
            <li
              key={`${clause.field}-${clause.operator}-${index}`}
              className="flex flex-wrap items-baseline gap-1.5 text-[11px]"
            >
              <span className={clause.passed ? "text-emerald-400" : "text-red-400"}>
                {clause.passed ? "✓" : "✗"}
              </span>
              <span className="font-mono text-foreground">{clause.field}</span>
              <span className="text-muted-foreground">{describeOperator(clause.operator)}</span>
              <span className="font-mono text-foreground">{describeValue(clause.expected)}</span>
              {/* The value the clause actually SAW. "Condition did not match" on
                  its own sends someone re-reading every clause against a lead
                  whose values have changed since. */}
              <span className="text-muted-foreground">— saw {describeValue(clause.actual)}</span>
            </li>
          ))}
        </ul>
      )}
      {step.clauses && step.clauses.length === 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          No clauses — an empty condition always passes.
        </p>
      )}
    </div>
  );
}

/* ── containers ──────────────────────────────────────────────────────────── */

function Branches({ node, run }: { node: TraceNode; run: TraceRunDetail }) {
  const definitionNode = node.parsed ? definitionNodeAt(run.definition, node.parsed) : null;
  const taken = takenChooseOption(node);
  const outline = chooseOutline(definitionNode, taken);
  const nodesByOption = new Map<number | "default", TraceGroup>(
    node.groups.filter((group) => group.kind === "choose").map((group) => [group.key, group]),
  );

  if (outline.length === 0) {
    // The definition could not be read — a hand-written journey, or a version
    // whose JSON has since been damaged. Show what ran rather than nothing.
    return <Nodes nodes={node.groups.flatMap((group) => group.nodes)} run={run} />;
  }

  return (
    <ul className="space-y-2">
      {outline.map((branch) => {
        const group = nodesByOption.get(branch.option);
        return (
          <li key={String(branch.option)}>
            <div className="flex flex-wrap items-center gap-2">
              <GitBranch className={branch.taken ? "size-3.5 text-emerald-400" : "size-3.5 text-muted-foreground"} />
              <span className={branch.taken ? "text-[12px] font-medium text-foreground" : "text-[12px] text-muted-foreground"}>
                {branch.label}
              </span>
              <StatusPill tone={branch.taken ? "success" : "neutral"}>
                {branch.taken ? "Taken" : "Not taken"}
              </StatusPill>
              <span className="text-[11px] text-muted-foreground">
                {branch.steps} step{branch.steps === 1 ? "" : "s"}
              </span>
            </div>
            {group && group.nodes.length > 0 && (
              <div className="mt-2">
                <Nodes nodes={group.nodes} run={run} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Iterations({ node, run }: { node: TraceNode; run: TraceRunDetail }) {
  const definitionNode = node.parsed ? definitionNodeAt(run.definition, node.parsed) : null;
  const plan = repeatPlan(definitionNode, node.step);
  const summary = summariseRepeat(node);
  const open = iterationsToExpand(node);
  const groups = node.groups
    .filter((group) => group.kind === "repeat" && typeof group.key === "number")
    .sort((a, b) => (a.key as number) - (b.key as number));

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Repeat className="size-3.5" />
        <span>
          {summary.iterations} iteration{summary.iterations === 1 ? "" : "s"}
          {plan.planned !== null && plan.planned !== summary.iterations ? ` of ${plan.planned}` : ""}
          {plan.mode ? ` · ${plan.mode}` : ""} · {summary.executions} step
          {summary.executions === 1 ? "" : "s"}
        </span>
        {summary.failed.length > 0 && (
          <StatusPill tone="danger">{summary.failed.length} failed</StatusPill>
        )}
        {summary.held.length > 0 && <StatusPill tone="warning">{summary.held.length} held</StatusPill>}
      </p>

      {/* Collapsed by default past a handful. A hundred-iteration repeat must
          not be a hundred screens of scroll; iterationsToExpand opens the ones
          that went wrong, plus the first and last. Native <details>, so this
          needs no client JavaScript and survives a print. */}
      {groups.map((group) => {
        const iteration = group.key as number;
        const failed = summary.failed.includes(iteration);
        const held = summary.held.includes(iteration);
        return (
          <details
            key={iteration}
            open={open.has(iteration)}
            className="rounded-lg border border-border/60 bg-background/20"
          >
            <summary className="cursor-pointer px-3 py-2 text-[12px] text-muted-foreground">
              <span className="text-foreground">Iteration {iteration + 1}</span>
              <span className="ml-2">
                {group.nodes.length} step{group.nodes.length === 1 ? "" : "s"}
              </span>
              {failed && <span className="ml-2 text-red-400">failed</span>}
              {held && <span className="ml-2 text-amber-300">held</span>}
            </summary>
            <div className="px-3 pb-3">
              <Nodes nodes={group.nodes} run={run} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

function Nodes({ nodes, run }: { nodes: TraceNode[]; run: TraceRunDetail }) {
  if (nodes.length === 0) return null;
  return (
    <ol className="space-y-2 border-l border-border/60 pl-3">
      {nodes.map((node) => (
        <li key={node.step.path} className="space-y-2">
          <StepRow node={node} run={run} />
          {node.groups.length > 0 && (
            <div className="pl-3">
              {node.step.stepType === "choose" ? (
                <Branches node={node} run={run} />
              ) : node.step.stepType === "repeat" ? (
                <Iterations node={node} run={run} />
              ) : (
                <Nodes nodes={node.groups.flatMap((group) => group.nodes)} run={run} />
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/* ── the run ─────────────────────────────────────────────────────────────── */

export default function JourneyRunTrace({ run }: { run: TraceRunDetail }) {
  const tree = buildTraceTree(run.steps);
  const inFlight = OPEN_RUN_STATUSES.has(run.status);
  const tone =
    run.status === "completed" ? "success"
    : run.status === "failed" ? "danger"
    : run.status === "waiting" || run.status === "blocked" ? "warning"
    : run.status === "cancelled" ? "neutral"
    : "info";

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">{run.journeyName}</h2>
        <StatusPill tone="neutral">v{run.version}</StatusPill>
        <StatusPill tone={tone}>{run.status}</StatusPill>
        {run.leadId ? (
          <Link className="text-[12px] text-primary hover:underline" href={`/leads/${run.leadId}`}>
            Lead
          </Link>
        ) : run.contactId ? (
          <Link className="text-[12px] text-primary hover:underline" href={`/contacts/${run.contactId}`}>
            Contact
          </Link>
        ) : (
          <span className="text-[12px] text-muted-foreground">{run.entityType}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          Enrolled {formatDateTime(run.createdAt)}
          {run.completedAt ? ` · Ended ${formatDateTime(run.completedAt)}` : ""}
        </span>
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground">
        {run.stepsExecuted} step{run.stepsExecuted === 1 ? "" : "s"} executed
        {run.attempts > 0 ? ` · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}` : ""}
      </p>

      {run.lastError && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/[0.07] p-2.5 text-[12px] text-red-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {run.lastError}
        </p>
      )}

      <div className="mt-4">
        {tree.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-[12px] text-muted-foreground">
            No step has been recorded yet. The run is enrolled and waiting for the engine to pick it
            up — which is different from a run that executed nothing.
          </p>
        ) : (
          <Nodes nodes={tree} run={run} />
        )}
      </div>

      {/* THE LIVE HEAD. An in-flight run's most useful fact is the step it has
          not taken yet, and no step log can carry it — it has not happened. The
          cursor is the only place that position exists, so it is drawn as a real
          node rather than left as an empty end to the list, which reads
          identically to a finished run. */}
      {inFlight ? (
        <div className="mt-3 rounded-lg border border-dashed border-sky-400/40 bg-sky-400/[0.05] p-3">
          <p className="text-[12px] text-sky-200">
            {run.cursorPath ? (
              <>
                Still running. Next step <span className="font-mono text-[11px]">{run.cursorPath}</span>,
                due {formatDateTime(run.nextRunAt)}.
              </>
            ) : (
              <>Still running. Due {formatDateTime(run.nextRunAt)}.</>
            )}
          </p>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <CircleSlash className="size-3.5" />
          Run {run.status}. Nothing further will execute.
        </p>
      )}
    </section>
  );
}
