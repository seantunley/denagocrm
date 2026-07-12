import { requirePermission } from "@/lib/permissions";
import { listSalesPipelines, listPipelineStages } from "@/lib/pipelines";
import {
  archiveSalesPipeline,
  createSalesPipeline,
  createSalesPipelineStage,
  editSalesPipeline,
  editSalesPipelineStage,
} from "@/app/actions/pipelines";
import ConfirmDelete from "@/components/ConfirmDelete";

export const dynamic = "force-dynamic";

export default async function PipelineSettingsPage() {
  await requirePermission("pipelines.manage");
  const pipelines = await listSalesPipelines();
  const stagesByPipeline = new Map<string, Awaited<ReturnType<typeof listPipelineStages>>>();
  await Promise.all(
    pipelines.map(async (pipeline) => stagesByPipeline.set(pipeline.id, await listPipelineStages(pipeline.id)))
  );

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold">Sales pipelines</h1>
        <p className="text-sm text-slate-400 mt-1">
          Configure separate retail, fleet, hospitality, partner and service-sales processes.
        </p>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Create pipeline</h2>
        <form action={createSalesPipeline} className="grid md:grid-cols-5 gap-3 items-end">
          <label className="space-y-1 md:col-span-2">
            <span className="text-xs text-slate-400">Name</span>
            <input name="name" className="input" required placeholder="Fleet / B2B Sales" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Type</span>
            <select name="type" className="input" defaultValue="sales">
              <option value="retail">Retail</option>
              <option value="fleet">Fleet / B2B</option>
              <option value="hospitality">Hospitality</option>
              <option value="partner">Partner / Dealer</option>
              <option value="service">Service upsell</option>
              <option value="sales">Other sales</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" name="isDefault" /> Default
          </label>
          <button className="btn-primary">Create</button>
          <label className="space-y-1 md:col-span-5">
            <span className="text-xs text-slate-400">Description</span>
            <input name="description" className="input" />
          </label>
        </form>
      </div>

      {pipelines.map((pipeline) => {
        const stages = stagesByPipeline.get(pipeline.id) ?? [];
        return (
          <section key={pipeline.id} className="card space-y-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{pipeline.name}</h2>
                  {pipeline.isDefault && <span className="badge bg-orange-950 text-orange-300">Default</span>}
                  {!pipeline.active && <span className="badge bg-slate-800 text-slate-400">Paused</span>}
                </div>
                <p className="text-sm text-slate-400">{pipeline.description || "No description"}</p>
              </div>
              {!pipeline.isDefault && (
                <ConfirmDelete
                  action={archiveSalesPipeline.bind(null, pipeline.id)}
                  title={`Archive “${pipeline.name}”?`}
                  description="The pipeline can only be archived when it has no active or historical leads."
                  trigger="Archive"
                  triggerClass="btn-secondary text-red-300"
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
                {stages.map((stage) => (
                  <details key={stage.id} className="rounded-lg border border-slate-800 p-3">
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
        );
      })}
    </div>
  );
}
