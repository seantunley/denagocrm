import { Plus } from "lucide-react";
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

export const dynamic = "force-dynamic";

export default async function PipelineSettingsPage() {
  await requirePermission("pipelines.manage");
  const pipelines = await listSalesPipelines();
  const stagesByPipeline = new Map<string, Awaited<ReturnType<typeof listPipelineStages>>>();
  await Promise.all(
    pipelines.map(async (pipeline) => stagesByPipeline.set(pipeline.id, await listPipelineStages(pipeline.id)))
  );

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
          <form action={createSalesPipeline} className="space-y-4">
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
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" name="isDefault" className="h-4 w-4" /> Make this the default pipeline
            </label>
            <button className="btn-primary w-full">Create pipeline</button>
          </form>
        </ModalTrigger>
      }
    >

      <div className="card p-0 divide-y divide-slate-800">
      {pipelines.map((pipeline) => {
        const stages = stagesByPipeline.get(pipeline.id) ?? [];
        return (
          <details key={pipeline.id}>
            <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                {pipeline.name}
                {pipeline.isDefault && <span className="badge bg-orange-500/15 text-orange-300">Default</span>}
                {!pipeline.active && <span className="badge bg-slate-800 text-slate-400">Paused</span>}
                <span className="text-xs font-normal text-slate-500">
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

            <details className="rounded-lg border border-slate-800 p-3">
              <summary className="cursor-pointer text-sm font-medium text-orange-400">Edit pipeline</summary>
              <form action={editSalesPipeline.bind(null, pipeline.id)} className="grid md:grid-cols-5 gap-3 mt-4 items-end">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-slate-400">Name</span>
                  <input name="name" className="input" required defaultValue={pipeline.name} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Type</span>
                  <input name="type" className="input" defaultValue={pipeline.type} />
                </label>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <input type="checkbox" name="active" defaultChecked={pipeline.active} /> Active
                </label>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <input type="checkbox" name="isDefault" defaultChecked={pipeline.isDefault} /> Default
                </label>
                <label className="space-y-1 md:col-span-4">
                  <span className="text-xs text-slate-400">Description</span>
                  <input name="description" className="input" defaultValue={pipeline.description ?? ""} />
                </label>
                <button className="btn-primary">Save</button>
              </form>
            </details>

            <div>
              <h3 className="font-medium mb-3">Stages</h3>
              <div className="space-y-2">
                {stages.map((stage, i) => (
                  <div key={stage.id} className="flex items-stretch gap-1.5">
                    <div className="flex flex-col justify-center gap-1">
                      <form action={moveStage.bind(null, pipeline.id, stage.id, "up")}>
                        <button disabled={i === 0} title="Move up" aria-label={`Move ${stage.name} up`} className="flex size-6 items-center justify-center rounded-md border border-slate-800 text-slate-400 hover:border-orange-500/40 hover:text-orange-400 disabled:opacity-25 disabled:hover:border-slate-800 disabled:hover:text-slate-400">↑</button>
                      </form>
                      <form action={moveStage.bind(null, pipeline.id, stage.id, "down")}>
                        <button disabled={i === stages.length - 1} title="Move down" aria-label={`Move ${stage.name} down`} className="flex size-6 items-center justify-center rounded-md border border-slate-800 text-slate-400 hover:border-orange-500/40 hover:text-orange-400 disabled:opacity-25 disabled:hover:border-slate-800 disabled:hover:text-slate-400">↓</button>
                      </form>
                    </div>
                    <details className="flex-1 rounded-lg border border-slate-800 p-3">
                    <summary className="cursor-pointer flex items-center gap-3 list-none">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                      <span className="font-medium flex-1">{stage.order + 1}. {stage.name}</span>
                      <span className="text-xs text-slate-500">{stage.defaultProbability}% probability</span>
                      {stage.staleAfterDays && <span className="text-xs text-slate-500">stale after {stage.staleAfterDays}d</span>}
                      {stage.isClosed && <span className="badge bg-slate-800 text-slate-300">{stage.closedStatus || "closed"}</span>}
                    </summary>
                    <form action={editSalesPipelineStage.bind(null, stage.id)} className="grid md:grid-cols-6 gap-3 mt-4 items-end">
                      <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-slate-400">Name</span>
                        <input name="name" className="input" required defaultValue={stage.name} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-slate-400">Colour</span>
                        <input name="color" type="color" className="input h-10" defaultValue={stage.color} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-slate-400">Probability</span>
                        <input name="defaultProbability" type="number" min="0" max="100" className="input" defaultValue={stage.defaultProbability} />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-slate-400">Stale after days</span>
                        <input name="staleAfterDays" type="number" min="1" className="input" defaultValue={stage.staleAfterDays ?? ""} />
                      </label>
                      <button className="btn-secondary">Save stage</button>
                      <label className="flex items-center gap-2 text-sm md:col-span-2">
                        <input type="checkbox" name="isClosed" defaultChecked={stage.isClosed} /> Closed stage
                      </label>
                      <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-slate-400">Closed result</span>
                        <select name="closedStatus" className="input" defaultValue={stage.closedStatus ?? ""}>
                          <option value="">Not applicable</option>
                          <option value="won">Won</option>
                          <option value="lost">Lost</option>
                        </select>
                      </label>
                    </form>
                    </details>
                  </div>
                ))}
                {stages.length === 0 && <p className="text-sm text-slate-500">No stages yet.</p>}
              </div>
            </div>

            <details className="rounded-lg border border-dashed border-slate-700 p-3">
              <summary className="cursor-pointer text-sm font-medium">+ Add stage</summary>
              <form action={createSalesPipelineStage.bind(null, pipeline.id)} className="grid md:grid-cols-6 gap-3 mt-4 items-end">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-slate-400">Name</span>
                  <input name="name" className="input" required />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Colour</span>
                  <input name="color" type="color" className="input h-10" defaultValue="#64748b" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Probability</span>
                  <input name="defaultProbability" type="number" min="0" max="100" className="input" defaultValue="10" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-slate-400">Stale after days</span>
                  <input name="staleAfterDays" type="number" min="1" className="input" />
                </label>
                <button className="btn-primary">Add stage</button>
                <label className="flex items-center gap-2 text-sm md:col-span-2">
                  <input type="checkbox" name="isClosed" /> Closed stage
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs text-slate-400">Closed result</span>
                  <select name="closedStatus" className="input" defaultValue="">
                    <option value="">Not applicable</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                </label>
              </form>
            </details>
            </section>
          </details>
        );
      })}
      </div>
    </SettingsWorkspace>
  );
}
