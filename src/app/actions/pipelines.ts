"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  getAccessibleLeadScope,
  hasPermission,
  requireLeadAccess,
  requirePermission,
} from "@/lib/permissions";
import {
  addPipelineStage,
  archivePipeline,
  captureForecastSnapshot,
  createPipeline,
  findOwnedPipelineForStage,
  getOwnedPipelineRow,
  getPipelineStage,
  listPipelineStages,
  reorderPipelineStages,
  updateLeadForecast,
  updatePipeline,
  updatePipelineStage,
} from "@/lib/pipelines";
import { UNREACHABLE_STAGE_MESSAGE } from "@/lib/pipelineTenantRule";
import { logAuditStrict } from "@/lib/audit";
import { basePrisma } from "@/lib/db";
import { parseRands } from "@/lib/format";
import { parsePipelineStageAction } from "@/lib/pipelineStageActions";
import { writeTenantId } from "@/lib/tenantWrite";

const str = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
};
const bool = (formData: FormData, key: string) => formData.get(key) === "on";
const int = (formData: FormData, key: string, fallback = 0) => {
  const value = parseInt(String(formData.get(key) ?? ""), 10);
  return Number.isFinite(value) ? value : fallback;
};

function validDateInput(raw: string | null) {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Expected close date is invalid");
  const date = new Date(`${raw}T12:00:00+02:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Expected close date is invalid");
  return date;
}

function forecastMonth(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("Forecast period must be YYYY-MM");
  const [year, month] = period.split("-").map(Number);
  return {
    closeFrom: new Date(Date.UTC(year, month - 1, 1)),
    closeTo: new Date(Date.UTC(year, month, 1)),
  };
}

export async function createSalesPipeline(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("pipelines.manage");
    const name = str(formData, "name");
    if (!name) throw new ActionRefusal("Pipeline name is required");
    const pipelineId = await createPipeline({
      name,
      description: str(formData, "description"),
      type: str(formData, "type") ?? "sales",
      isDefault: bool(formData, "isDefault"),
    });
    await logAuditStrict({
      action: "pipeline.created",
      summary: `Created sales pipeline “${name}”`,
      entityType: "SalesPipeline",
      entityId: pipelineId,
      user,
      after: { name, type: str(formData, "type") ?? "sales", isDefault: bool(formData, "isDefault") },
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
  });
}

export async function editSalesPipeline(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("pipelines.manage");
    // `id` is a bound server-action argument, so it is client-supplied and
    // forgeable. This read was unscoped: a pipeline id from another workspace
    // returned that workspace's entire row, and even though `updatePipeline`
    // then refused, the row had already been copied into THIS tenant's audit
    // trail as the `before` snapshot, where it stays and is readable.
    const before = await getOwnedPipelineRow(id);
    if (!before) throw new ActionRefusal("Pipeline not found");
    const name = str(formData, "name");
    if (!name) throw new ActionRefusal("Pipeline name is required");
    const after = {
      name,
      description: str(formData, "description"),
      type: str(formData, "type") ?? "sales",
      active: bool(formData, "active"),
      isDefault: bool(formData, "isDefault"),
    };
    await updatePipeline(id, after);
    await logAuditStrict({
      action: "pipeline.updated",
      summary: `Updated sales pipeline “${name}”`,
      entityType: "SalesPipeline",
      entityId: id,
      user,
      before,
      after,
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
    revalidatePath("/forecast");
  });
}

export async function createSalesPipelineStage(pipelineId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("pipelines.manage");
    const name = str(formData, "name");
    if (!name) throw new ActionRefusal("Stage name is required");
    const after = {
      pipelineId,
      name,
      color: str(formData, "color") ?? "#64748b",
      defaultProbability: int(formData, "defaultProbability", 10),
      staleAfterDays: str(formData, "staleAfterDays") ? int(formData, "staleAfterDays") : null,
      isClosed: bool(formData, "isClosed"),
      closedStatus: str(formData, "closedStatus"),
      entryAction: parsePipelineStageAction(str(formData, "entryAction")),
    };
    const stageId = await addPipelineStage(after);
    await logAuditStrict({
      action: "pipeline.stage_created",
      summary: `Created stage “${name}”`,
      entityType: "PipelineStage",
      entityId: stageId,
      user,
      after,
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
    revalidatePath("/forecast");
  });
}

/**
 * Edit one stage's shape.
 *
 * THE SAME DEFECT AS `moveStage` BELOW, by a third route, found by sweeping this
 * file for it. `id` is a bound server-action argument and therefore forgeable, and
 * the body opened with `getPipelineStage(id)` — scoped by `tenantFilter`, which is
 * `Prisma.empty` while enforcement is dormant, on `basePrisma`, which is the RLS
 * bypass. So the row resolved for ANY workspace's stage id, and the outcomes then
 * differed:
 *
 *   - a stage id that existed NOWHERE   → `ActionRefusal("Pipeline stage not
 *                                         found")`, rendered verbatim, logged
 *                                         nowhere;
 *   - a stage id owned by ANOTHER       → resolved, so control carried on to
 *     workspace                           `updatePipelineStage`, whose own
 *                                         `requireOwnedPipeline` fails by `throw
 *                                         new Error("Pipeline not found")` — the
 *                                         generic sentence, a reference code and a
 *                                         log line.
 *
 * And the bit was cheaper still to read than that suggests: with an empty `name`,
 * a foreign id fell through to the verbatim "Stage name is required" while an
 * absent id said "Pipeline stage not found", so the two answers came back from a
 * request that never intended to write anything.
 *
 * The `before` snapshot never reached the audit trail — `updatePipelineStage`
 * throws first — so, exactly as in #476, the VALUE was contained and the BRANCH
 * was not. Same fix: resolve through the boundary first, with the shared
 * one-statement resolver, and refuse once with the shared sentence.
 */
export async function editSalesPipelineStage(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("pipelines.manage");
    const pipeline = await findOwnedPipelineForStage(id);
    if (!pipeline) refuse(UNREACHABLE_STAGE_MESSAGE);
    // Keyed by a stage id whose parent this workspace has just been proved to own,
    // so the snapshot that goes into OUR audit trail can only be our own row.
    const before = await getPipelineStage(id);
    // Deleted between the two reads. Same constant, so the race is not a third
    // answer either.
    if (!before) refuse(UNREACHABLE_STAGE_MESSAGE);
    const name = str(formData, "name");
    if (!name) throw new ActionRefusal("Stage name is required");
    const after = {
      name,
      color: str(formData, "color") ?? "#64748b",
      defaultProbability: int(formData, "defaultProbability", 10),
      staleAfterDays: str(formData, "staleAfterDays") ? int(formData, "staleAfterDays") : null,
      isClosed: bool(formData, "isClosed"),
      closedStatus: str(formData, "closedStatus"),
      entryAction: parsePipelineStageAction(str(formData, "entryAction")),
    };
    await updatePipelineStage(id, after);
    await logAuditStrict({
      action: "pipeline.stage_updated",
      summary: `Updated stage “${name}”`,
      entityType: "PipelineStage",
      entityId: id,
      user,
      before,
      after,
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
    revalidatePath("/forecast");
  });
}

/**
 * Swap a stage with its neighbour to reorder the pipeline.
 *
 * THE GATE COMES BEFORE THE LIST, AND IT IS THE READ. That is the whole of this
 * function's tenant story, and it is the second instance of the defect #476 fixed
 * in the same-named `moveStage` in src/app/actions/settings.ts — a different route
 * to the identical oracle.
 *
 * Both `pipelineId` and `stageId` are bound server-action arguments, which is to
 * say POST parameters, which is to say forgeable. The body used to open with
 * `listPipelineStages(pipelineId)`, whose only boundary is `tenantFilter` — and
 * `tenantFilter` returns `Prisma.empty` whenever `tenantEnforcing()` is false,
 * which is every environment we run today. So a forged parent id returned ANOTHER
 * workspace's entire ordered stage list, on `basePrisma`, the documented RLS
 * bypass, and the three ways out of the function then differed in a way the caller
 * can see:
 *
 *   - the stage is not in that list          → `refuse(…)`, rendered VERBATIM,
 *                                              logged nowhere;
 *   - it is, and it is at the end            → `refuse("…already at the end.")`,
 *                                              also verbatim — and a different
 *                                              sentence, so the POSITION of a
 *                                              stage in a foreign pipeline is
 *                                              readable one bit at a time;
 *   - it is, and it can move                 → `reorderPipelineStages` reaches
 *                                              `requireOwnedPipeline`, which fails
 *                                              by `throw new Error("Pipeline not
 *                                              found")` — rendered by
 *                                              asActionResult as the generic
 *                                              sentence plus a reference code, and
 *                                              LOGGED.
 *
 * A pipeline id that exists nowhere lands in the first of those. So the write was
 * never at risk — #457 put the gate in `reorderPipelineStages` — and everything
 * upstream of it was: the existence of a foreign pipeline and the position of a
 * stage inside it, both answerable by anyone holding an id.
 *
 * WHY THE STAGE-KEYED RESOLVER AND NOT `requireOwnedPipeline(pipelineId)`. The
 * question this action has to answer is "may this workspace reorder this stage",
 * and `findOwnedPipelineForStage` (#476) answers exactly that in ONE statement
 * carrying the ownership predicate — returning the parent it proved we own, so the
 * forged `pipelineId` never bounds a read, it is only compared against the answer.
 * `requireOwnedPipeline` would gate the parent equally well but fails by THROWING,
 * which asActionResult turns into the generic sentence, a reference code and a log
 * line; a forged id is an expected refusal, not a fault, and #476's whole point is
 * that the two unreachable cases share the response AND the (empty) log. Same gate,
 * one statement earlier, in the shape that can refuse.
 *
 * Everything below therefore collapses to ONE outcome — `UNREACHABLE_STAGE_MESSAGE`,
 * the constant from #476 rather than a second literal — for a stage that is not
 * ours, a stage that is nowhere, a pipeline that is not ours, a pipeline that is
 * nowhere, and a stage/pipeline pair that do not belong together.
 */
export async function moveStage(pipelineId: string, stageId: string, direction: "up" | "down") {
  return asActionResult(async () => {
    const user = await requirePermission("pipelines.manage");
    // Resolve the stage THROUGH the boundary. `pipeline` is an owned pipeline or
    // nothing; the supplied `pipelineId` is then only ever checked against it, so a
    // forged parent cannot select the list that gets read.
    const pipeline = await findOwnedPipelineForStage(stageId);
    if (!pipeline || pipeline.id !== pipelineId) refuse(UNREACHABLE_STAGE_MESSAGE);

    // Bounded by a pipeline the statement above proved this workspace owns, which
    // is the same containment argument the sibling in settings.ts makes for its
    // `findMany`: the parent is the boundary, and it has been applied.
    const stages = await listPipelineStages(pipeline.id);
    const idx = stages.findIndex((s) => s.id === stageId);
    // Only reachable if the stage was deleted between the two reads. The SAME
    // sentence, from the same constant, so a race cannot become a third answer.
    if (idx < 0) refuse(UNREACHABLE_STAGE_MESSAGE);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    // Now a fact about the caller's OWN pipeline, which they are looking at.
    if (swapWith < 0 || swapWith >= stages.length) refuse("That stage is already at the end.");

    const ids = stages.map((s) => s.id);
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    await reorderPipelineStages(pipeline.id, ids);

    await logAuditStrict({
      action: "pipeline.stage_reordered",
      summary: `Moved stage “${stages[idx].name}” ${direction}`,
      entityType: "PipelineStage",
      entityId: stageId,
      user,
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
    revalidatePath("/forecast");
  });
}

export async function archiveSalesPipeline(id: string, formData: FormData) {
  return asActionResult(async () => {
    void formData;
    const user = await requirePermission("pipelines.manage");
    // The same unscoped `before` read as editSalesPipeline, with the same
    // consequence: another workspace's full row lifted into this tenant's audit
    // trail before `archivePipeline` got a chance to refuse.
    const before = await getOwnedPipelineRow(id);
    if (!before) throw new ActionRefusal("Pipeline not found");
    await archivePipeline(id);
    await logAuditStrict({
      action: "pipeline.archived",
      summary: `Archived sales pipeline “${String(before.name ?? id)}”`,
      entityType: "SalesPipeline",
      entityId: id,
      user,
      before,
      after: { archived: true },
    });
    revalidatePath("/settings/pipelines");
    revalidatePath("/leads");
    revalidatePath("/forecast");
  });
}

type LeadForecastBefore = {
  probability: number;
  forecastCategory: string;
  expectedCloseDate: Date | null;
  estimatedCostCents: number | null;
  teamId: string | null;
};

export async function saveLeadForecast(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "forecast.manage");
  const tenantId = writeTenantId();
  const tenantScope = tenantId
    ? Prisma.sql`AND "tenantId" = ${tenantId}`
    : Prisma.empty;
  const beforeRows = await basePrisma.$queryRaw<LeadForecastBefore[]>`
    SELECT "probability", "forecastCategory", "expectedCloseDate", "estimatedCostCents", "teamId"
    FROM "Lead"
    WHERE "id" = ${leadId} AND "deletedAt" IS NULL ${tenantScope}
    LIMIT 1
  `;
  const before = beforeRows[0] ?? null;
  if (!before) throw new Error("Lead not found");

  const teamId = str(formData, "teamId");
  if ((before.teamId ?? null) !== teamId && !(await hasPermission(user, "leads.assign"))) {
    throw new Error("You do not have permission to change the lead team");
  }
  const forecastCategory = str(formData, "forecastCategory") ?? "pipeline";
  if (!["pipeline", "best_case", "commit", "omitted"].includes(forecastCategory)) {
    throw new Error("Invalid forecast category for an open lead");
  }
  const estimatedCost = str(formData, "estimatedCost");
  const after = {
    probability: int(formData, "probability", 10),
    forecastCategory,
    expectedCloseDate: validDateInput(str(formData, "expectedCloseDate")),
    estimatedCostCents: estimatedCost ? Math.max(0, parseRands(estimatedCost)) : null,
    teamId,
  };
  await updateLeadForecast(leadId, after);
  await logAuditStrict({
    action: "lead.forecast_updated",
    summary: `Updated forecast for lead ${leadId}`,
    entityType: "Lead",
    entityId: leadId,
    leadId,
    user,
    before,
    after,
  });
  revalidatePath("/forecast");
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function snapshotForecast(formData: FormData) {
  const user = await requirePermission("forecast.manage");
  const scope = await getAccessibleLeadScope(user);
  const period = str(formData, "period") ?? new Date().toISOString().slice(0, 7);
  const requestedTeamId = str(formData, "teamId");
  const requestedUserId = str(formData, "userId");

  const teamId = requestedTeamId;
  let userId = requestedUserId;
  if (!scope.viewAll) {
    if (teamId && !scope.teamIds.includes(teamId)) {
      throw new Error("You cannot snapshot a team outside your access scope");
    }
    if (userId && userId !== user.id) {
      throw new Error("You cannot snapshot another user's forecast");
    }
    if (!teamId) userId = user.id;
  }

  const month = forecastMonth(period);
  const input = {
    period,
    pipelineId: str(formData, "pipelineId"),
    teamId,
    userId,
    closeFrom: month.closeFrom,
    closeTo: month.closeTo,
  };
  const result = await captureForecastSnapshot(input);
  await logAuditStrict({
    action: "forecast.snapshot_created",
    summary: `Captured forecast snapshot for ${period}`,
    entityType: "ForecastSnapshot",
    user,
    after: { period, pipelineId: input.pipelineId, teamId, userId, ...result },
  });
  revalidatePath("/forecast");
}
