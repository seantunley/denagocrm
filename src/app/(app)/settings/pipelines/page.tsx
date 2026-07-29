import { Plus, Zap } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { requirePermission } from "@/lib/permissions";
import { listSalesPipelines, listPipelineStages } from "@/lib/pipelines";
import {
  archiveSalesPipeline,
  createSalesPipeline,
  createSalesPipelineStage,
  editSalesPipeline,
  editSalesPipelineStage,
  moveStage,
} from "@/app/actions/pipelines";
import ConfirmDelete from "@/components/ConfirmDelete";
import ModalTrigger from "@/components/Modal";
import { buttonVariants } from "@/components/ui/button";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { PIPELINE_STAGE_ACTION_META } from "@/lib/pipelineStageActions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PipelineSettingsPage() {
  await requirePermission("pipelines.manage");
  const pipelines = await listSalesPipelines();
  const stagesByPipeline = new Map<string, Awaited<ReturnType<typeof listPipelineStages>>>();
  await Promise.all(
    pipelines.map(async (pipeline) => stagesByPipeline.set(pipeline.id, await listPipelineStages(pipeline.id)))
  );
  const stageAutomationRules = await prisma.automationRule.findMany({
    where: { active: true, trigger: "stage_entered", triggerStageId: { not: null } },
    select: { name: true, triggerStageId: true },
    orderBy: { name: "asc" },
  });
  const automationRulesByStage = new Map<string, string[]>();
  for (const rule of stageAutomationRules) {
    if (!rule.triggerStageId) continue;
    const names = automationRulesByStage.get(rule.triggerStageId) ?? [];
    names.push(rule.name);
    automationRulesByStage.set(rule.triggerStageId, names);
  }

  return (
    <SettingsWorkspace
      current="pipeline"
      title="Sales pipelines"
      description="Configure separate retail, fleet, hospitality, partner and service-sales processes."
      groups={SETTINGS_NAV_GROUPS}
      actions={
        <ModalTrigger
          label={<><Plus className="size-4" />Create pipeline</>}
          title="Create pipeline"
          buttonClass={buttonVariants({ size: "sm" })}
        >
          <SaveForm success="Pipeline created" action={createSalesPipeline} className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input name="name" className="input" required autoFocus placeholder="Fleet / B2B Sales" />
            </div>
            <div>
              <label className="label">Type</label>
              <select name="type" className="input" defaultValue="sales">
                <option value="retail">Retail</option>
                <option value="fleet">Fleet / B2B</option>
                <option value="hospitality">Hospitality</option>
                <option value="partner">Partner / Dealer</option>
                <option value="service">Service upsell</option>
                <option value="sales">Other sales</option>
              </select>
            </div>
            <div>
              <label className="label">Description</label>
              <input name="description" className="input" placeholder="Optional" />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" name="isDefault" className="h-4 w-4" /> Make this the default pipeline
            </label>
            <SaveButton className="btn-primary w-full">Create pipeline</SaveButton>
          </SaveForm>
        </ModalTrigger>
      }
    >

      <div className="card p-0 divide-y divide-border/50">
      {pipelines.map((pipeline) => {
        const stages = stagesByPipeline.get(pipeline.id) ?? [];
        return (
          <details key={pipeline.id}>
            <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                {pipeline.name}
                {pipeline.isDefault && <span className="badge bg-primary/15 text-primary">Default</span>}
                {!pipeline.active && <span className="badge bg-muted text-muted-foreground">Paused</span>}
                <span className="text-xs font-normal text-muted-foreground">
                  {stages.length} stage{stages.length === 1 ? "" : "s"}{pipeline.description ? ` · ${pipeline.description}` : ""}
                </span>
              </span>
              <span className="btn-secondary btn-sm shrink-0">Manage</span>
            </summary>
            <section className="px-5 pb-5 space-y-5">
            <div className="flex items-start justify-end gap-4 flex-wrap">
              {!pipeline.isDefault && (
                <ConfirmDelete
                  action={archiveSalesPipeline.bind(null, pipeline.id)}
                  title={`Archive “${pipeline.name}”?`}
                  description="The pipeline can only be archived when it has no active or historical leads."
                  trigger="Archive"
                  triggerClass="btn-secondary btn-sm text-red-300"
                />
              )}
            </div>

            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-primary">Edit pipeline</summary>
              <SaveForm success="Pipeline updated" resetOnSuccess={false} action={editSalesPipeline.bind(null, pipeline.id)} className="grid md:grid-cols-5 gap-3 mt-4 items-end">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <input name="name" className="input" required defaultValue={pipeline.name} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Type</span>
                  <input name="type" className="input" defaultValue={pipeline.type} />
                </label>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <input type="checkbox" name="active" defaultChecked={pipeline.active} /> Active
                </label>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <input type="checkbox" name="isDefault" defaultChecked={pipeline.isDefault} /> Default
                </label>
                <label className="space-y-1 md:col-span-4">
                  <span className="text-xs text-muted-foreground">Description</span>
                  <input name="description" className="input" defaultValue={pipeline.description ?? ""} />
                </label>
                <SaveButton className="btn-primary">Save</SaveButton>
              </SaveForm>
            </details>

            <div>
              <h3 className="font-medium mb-3">Stages</h3>
              <div className="space-y-2">
                {stages.map((stage, i) => (
                  <div key={stage.id} className="flex items-stretch gap-1.5">
                    <div className="flex flex-col justify-center gap-1">
                      <SaveForm success="Stage reordered" resetOnSuccess={false} action={moveStage.bind(null, pipeline.id, stage.id, "up")}>
                        <SaveButton disabled={i === 0} title="Move up" aria-label={`Move ${stage.name} up`} className="flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-25 disabled:hover:border-border disabled:hover:text-muted-foreground">↑</SaveButton>
                      </SaveForm>
                      <SaveForm success="Stage reordered" resetOnSuccess={false} action={moveStage.bind(null, pipeline.id, stage.id, "down")}>
                        <SaveButton disabled={i === stages.length - 1} title="Move down" aria-label={`Move ${stage.name} down`} className="flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-25 disabled:hover:border-border disabled:hover:text-muted-foreground">↓</SaveButton>
                      </SaveForm>
                    </div>
                    <details className="flex-1 rounded-lg border border-border p-3">
                    <summary className="cursor-pointer flex items-center gap-3 list-none">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                      <span className="font-medium flex-1">{stage.order + 1}. {stage.name}</span>
                      <span className="text-xs text-muted-foreground">{stage.defaultProbability}% probability</span>
                      {stage.staleAfterDays && <span className="text-xs text-muted-foreground">stale after {stage.staleAfterDays}d</span>}
                      {stage.isClosed && <span className="badge bg-muted text-muted-foreground">{stage.closedStatus || "closed"}</span>}
                      {stage.entryAction === "book_test_drive" && (
                        <span className="badge bg-primary/15 text-primary">
                          <Zap className="size-3" />
                          {PIPELINE_STAGE_ACTION_META.book_test_drive.shortLabel}
                        </span>
                      )}
                      {(automationRulesByStage.get(stage.id)?.length ?? 0) > 0 && (
                        <span
                          className="badge bg-blue-500/10 text-blue-300"
                          title={automationRulesByStage.get(stage.id)?.join(", ")}
                        >
                          {automationRulesByStage.get(stage.id)?.length} active automation
                          {automationRulesByStage.get(stage.id)?.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </summary>
                    <SaveForm success="Stage updated" resetOnSuccess={false} action={editSalesPipelineStage.bind(null, stage.id)} className="grid md:grid-cols-6 gap-3 mt-4 items-end">
                      <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-muted-foreground">Name</span>
                        <input name="name" className="input" required defaultValue={stage.name} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Colour</span>
                        <input name="color" type="color" className="input h-10" defaultValue={stage.color} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Probability</span>
                        <input name="defaultProbability" type="number" min="0" max="100" className="input" defaultValue={stage.defaultProbability} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Stale after days</span>
                        <input name="staleAfterDays" type="number" min="1" className="input" defaultValue={stage.staleAfterDays ?? ""} />
                      </label>
                      <SaveButton className="btn-secondary">Save stage</SaveButton>
                      <label className="flex items-center gap-2 text-sm md:col-span-2">
                        <input type="checkbox" name="isClosed" defaultChecked={stage.isClosed} /> Closed stage
                      </label>
                      <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-muted-foreground">Closed result</span>
                        <select name="closedStatus" className="input" defaultValue={stage.closedStatus ?? ""}>
                          <option value="">Not applicable</option>
                          <option value="won">Won</option>
                          <option value="lost">Lost</option>
                        </select>
                      </label>
                      <label className="space-y-1 md:col-span-3">
                        <span className="text-xs text-muted-foreground">When a lead enters this stage</span>
                        <select name="entryAction" className="input" defaultValue={stage.entryAction ?? ""}>
                          <option value="">No required stage action</option>
                          <option value="book_test_drive">Require and book a test drive</option>
                        </select>
                        <span className="block text-[11px] leading-4 text-muted-foreground">
                          {stage.entryAction === "book_test_drive"
                            ? PIPELINE_STAGE_ACTION_META.book_test_drive.description
                            : "The lead moves immediately; configurable automations can still run afterward."}
                        </span>
                      </label>
                    </SaveForm>
                    </details>
                  </div>
                ))}
                {stages.length === 0 && <p className="text-sm text-muted-foreground">No stages yet.</p>}
              </div>
            </div>

            <details className="rounded-lg border border-dashed border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">+ Add stage</summary>
              <SaveForm success="Stage added" action={createSalesPipelineStage.bind(null, pipeline.id)} className="grid md:grid-cols-6 gap-3 mt-4 items-end">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <input name="name" className="input" required />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Colour</span>
                  <input name="color" type="color" className="input h-10" defaultValue="#64748b" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Probability</span>
                  <input name="defaultProbability" type="number" min="0" max="100" className="input" defaultValue="10" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Stale after days</span>
                  <input name="staleAfterDays" type="number" min="1" className="input" />
                </label>
                <SaveButton className="btn-primary">Add stage</SaveButton>
                <label className="flex items-center gap-2 text-sm md:col-span-2">
                  <input type="checkbox" name="isClosed" /> Closed stage
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-muted-foreground">Closed result</span>
                  <select name="closedStatus" className="input" defaultValue="">
                    <option value="">Not applicable</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                </label>
                <label className="space-y-1 md:col-span-3">
                  <span className="text-xs text-muted-foreground">When a lead enters this stage</span>
                  <select name="entryAction" className="input" defaultValue="">
                    <option value="">No required stage action</option>
                    <option value="book_test_drive">Require and book a test drive</option>
                  </select>
                  <span className="block text-[11px] leading-4 text-muted-foreground">
                    Required actions collect their details before the lead is moved.
                  </span>
                </label>
              </SaveForm>
            </details>
            </section>
          </details>
        );
      })}
      </div>
    </SettingsWorkspace>
  );
}
