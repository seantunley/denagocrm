import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { CheckCircle2, CircleDashed, FlaskConical, ListChecks, Play, Plus, Trash2, XCircle } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { basePrisma, prisma } from "@/lib/db";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { createFlowEvaluation, deleteFlowEvaluation, runAllFlowEvaluations, runFlowEvaluation } from "@/app/actions/flowEvaluations";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import type { FlowEvaluationExpectation, FlowEvaluationTurn } from "@/lib/flowEvaluationContract";

type VersionRow = { id: string; version: number; createdAt: Date };
type StoredResult = { outcome?: string; reasons?: string[]; replyExcerpt?: string; finalNodeId?: string | null };
type EvaluationRow = Awaited<ReturnType<typeof prisma.botFlowEvaluation.findMany>>[number];

const statusTone = (status: string) => status === "passed" ? "success" : status === "failed" ? "danger" : status === "error" ? "warning" : "neutral";
const asTurns = (value: unknown): FlowEvaluationTurn[] => Array.isArray(value) ? value as FlowEvaluationTurn[] : [];
const asExpectation = (value: unknown) => value as FlowEvaluationExpectation;
const asResult = (value: unknown) => (value && typeof value === "object" ? value : {}) as StoredResult;

export default async function FlowEvaluationsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const tenantId = await builderTenantId();
  const scope = await flowScope();
  const flow = await prisma.botFlow.findFirst({ where: { id, ...scope }, select: { id: true, name: true, active: true } });
  if (!flow) notFound();
  const [evaluations, versions] = await Promise.all([
    prisma.botFlowEvaluation.findMany({ where: { tenantId, flowId: id }, orderBy: { createdAt: "asc" } }),
    basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
      SELECT "id", "version", "createdAt"
        FROM "BotFlowVersion"
       WHERE "tenantId" = ${tenantId}
         AND "flowId" = ${id}
       ORDER BY "version" DESC
    `),
  ]);

  const passed = evaluations.filter((evaluation) => evaluation.lastStatus === "passed");
  const failed = evaluations.filter((evaluation) => ["failed", "error"].includes(evaluation.lastStatus));
  const notRun = evaluations.filter((evaluation) => !evaluation.lastRunAt || !["passed", "failed", "error"].includes(evaluation.lastStatus));

  return (
    <EntityDetailShell
      backHref={`/bot-builder/${id}`}
      backLabel="Back to draft"
      eyebrow="Regression testing"
      title={<span className="flex items-center gap-2"><ListChecks className="size-5 text-primary" />Evaluate {flow.name}</span>}
      status={flow.active ? <StatusPill tone="success">Live flow</StatusPill> : undefined}
      description="Replay saved customer paths against the current draft or an immutable published version, with provider sends and CRM effects simulated."
      actions={evaluations.length ? (
        <SaveForm action={runAllFlowEvaluations.bind(null, id)} success="Evaluation suite finished">
          <SaveButton className="btn-primary btn-sm" pendingLabel={`Running ${evaluations.length} cases…`}><Play className="size-4" />Run all</SaveButton>
        </SaveForm>
      ) : undefined}
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-4">
          <Metric label="Saved cases" value={evaluations.length} />
          <Metric label="Passed" value={passed.length} tone="text-emerald-300" />
          <Metric label="Failed" value={failed.length} tone="text-red-300" />
          <Metric label="Not run" value={notRun.length} tone="text-slate-300" />
        </div>

        <Surface className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Plus className="size-4" /></span>
            <div><h2 className="font-semibold">Add a repeatable evaluation</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Enter one customer turn per line. Prefix exact menu selections with <code>choice:</code> and file inputs with <code>file:</code>.</p></div>
          </div>
          <SaveForm action={createFlowEvaluation.bind(null, id)} success="Evaluation saved" className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div><label className="label">Evaluation name</label><input name="name" className="input" required maxLength={120} placeholder="Service booking happy path" /></div>
              <div><label className="label">Target</label><select name="target" className="input" defaultValue="draft"><option value="draft">Current saved draft</option>{versions.map((version) => <option key={version.id} value={version.id}>Published version {version.version} · {version.createdAt.toLocaleDateString("en-ZA")}</option>)}</select></div>
              <div><label className="label">Customer turns</label><textarea name="turns" className="input min-h-44 font-mono text-xs" required placeholder={"choice: Book a service\ntext: Rover XL\nfile: licence.jpg"} /><p className="mt-1 text-[11px] text-muted-foreground">Up to 12 turns. A line without a prefix is treated as text.</p></div>
            </div>
            <div className="space-y-4">
              <div><label className="label">Expected final outcome</label><select name="outcome" className="input" defaultValue="completed"><option value="completed">Flow completed</option><option value="handoff">Human handoff</option><option value="waiting">Still waiting for customer input</option></select></div>
              <div><label className="label">Reply must contain (optional)</label><input name="replyContains" className="input" maxLength={240} placeholder="booking is confirmed" /></div>
              <div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Variable key (optional)</label><input name="variableKey" className="input" maxLength={80} placeholder="service" /></div><div><label className="label">Expected value</label><input name="variableValue" className="input" maxLength={240} placeholder="Annual service" /></div></div>
              <div className="rounded-xl border border-sky-400/15 bg-sky-500/5 p-3 text-xs leading-5 text-muted-foreground"><b className="text-sky-200">Deterministic suite:</b> graph routing, captures, conditions, menus and simulated effects are checked. AI nodes return a fixed simulated answer; use Chatbot → Test AI answers for live production inference.</div>
              <SaveButton className="btn-primary" pendingLabel="Saving evaluation…"><Plus className="size-4" />Save evaluation</SaveButton>
            </div>
          </SaveForm>
        </Surface>

        {evaluations.length === 0 ? (
          <EmptyState icon={FlaskConical} title="No saved evaluations" description="Save your highest-value customer paths, then run the suite before publishing a flow change." />
        ) : (
          <div className="space-y-5">
            <EvaluationGroup title="Failed" description="Expected and actual results differ. Fix these first." icon={XCircle} tone="text-red-300" evaluations={failed} versions={versions} />
            <EvaluationGroup title="Not run" description="Saved cases that still need a result for this target." icon={CircleDashed} tone="text-slate-300" evaluations={notRun} versions={versions} />
            <EvaluationGroup title="Passed" description="Cases currently matching their saved expectations." icon={CheckCircle2} tone="text-emerald-300" evaluations={passed} versions={versions} />
          </div>
        )}
      </div>
    </EntityDetailShell>
  );
}

function EvaluationGroup({ title, description, icon: Icon, tone, evaluations, versions }: { title: string; description: string; icon: typeof CheckCircle2; tone: string; evaluations: EvaluationRow[]; versions: VersionRow[] }) {
  if (!evaluations.length) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <div><h2 className={`flex items-center gap-2 font-semibold ${tone}`}><Icon className="size-4" />{title} <span className="text-xs font-normal text-muted-foreground">({evaluations.length})</span></h2><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
      </div>
      {evaluations.map((evaluation) => <EvaluationCard key={evaluation.id} evaluation={evaluation} versions={versions} />)}
    </section>
  );
}

function EvaluationCard({ evaluation, versions }: { evaluation: EvaluationRow; versions: VersionRow[] }) {
  const turns = asTurns(evaluation.turns);
  const expectation = asExpectation(evaluation.expectation);
  const result = asResult(evaluation.lastResult);
  const version = versions.find((item) => item.id === evaluation.flowVersionId);
  const failing = ["failed", "error"].includes(evaluation.lastStatus);

  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{evaluation.name}</h3><StatusPill tone={statusTone(evaluation.lastStatus)}>{evaluation.lastStatus.replace("_", " ")}</StatusPill></div>
          <p className="mt-1 text-xs text-muted-foreground">{version ? `Published version ${version.version}` : "Current saved draft"} · expects {expectation.outcome}</p>
        </div>
        <div className="flex gap-2">
          <SaveForm action={runFlowEvaluation.bind(null, evaluation.id)} success="Evaluation finished"><SaveButton className="btn-secondary btn-sm" pendingLabel="Running…"><Play className="size-3.5" />Rerun</SaveButton></SaveForm>
          <SaveForm action={deleteFlowEvaluation.bind(null, evaluation.id)} success="Evaluation deleted"><SaveButton className="btn-ghost btn-sm text-red-300" pendingLabel="Deleting…"><Trash2 className="size-3.5" />Delete</SaveButton></SaveForm>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Saved path</p><ol className="mt-2 space-y-1 text-xs text-foreground">{turns.map((turn, index) => <li key={`${index}-${turn.kind}-${turn.value}`}><span className="mr-2 text-muted-foreground">{index + 1}.</span><code>{turn.kind}:</code> {turn.value}</li>)}</ol></div>
        <div><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Assertions</p><ul className="mt-2 space-y-1 text-xs"><li>Outcome: {expectation.outcome}</li>{expectation.replyContains && <li>Reply contains: “{expectation.replyContains}”</li>}{expectation.variable && <li><code>{`{{${expectation.variable.key}}}`}</code> equals “{expectation.variable.value}”</li>}</ul></div>
      </div>

      {evaluation.lastRunAt && (
        <div className={`mt-4 rounded-xl border p-3 ${evaluation.lastStatus === "passed" ? "border-emerald-400/15 bg-emerald-500/5" : "border-amber-400/15 bg-amber-500/5"}`}>
          <div className="flex items-center gap-2 text-xs font-medium">{evaluation.lastStatus === "passed" ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-amber-400" />}Last run {evaluation.lastRunAt.toLocaleString("en-ZA")}{result.finalNodeId ? ` · waiting at ${result.finalNodeId}` : ""}</div>
          {failing && <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg border border-white/8 bg-black/10 p-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Expected</p><p className="mt-1 text-xs font-medium">{expectation.outcome}</p></div><div className="rounded-lg border border-amber-400/15 bg-amber-500/5 p-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Actual</p><p className="mt-1 text-xs font-medium text-amber-200">{result.outcome ?? "error"}</p></div></div>}
          {result.reasons?.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-200">{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          {result.replyExcerpt ? <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Reply excerpt</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-foreground">{result.replyExcerpt}</p></details> : null}
        </div>
      )}
    </Surface>
  );
}

function Metric({ label, value, tone = "text-foreground" }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-xl border border-border bg-card p-4"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p></div>;
}
