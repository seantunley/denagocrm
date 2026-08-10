/**
 * THE TABLE. Adding a model to the isolation suite means adding one entry here.
 *
 * Every probe drives a REAL server action from src/app/actions/. That is the
 * whole design constraint and it is worth being blunt about why: each defect this
 * repository has actually shipped lived in the action layer, not in the guard —
 * a forged id arriving in a form post, a `basePrisma` transaction entered after
 * the authorisation check had already passed, an insert that simply never
 * mentioned tenantId. A suite that called `prisma.model.findMany()` directly
 * would have gone green for all of them, because the guard it was testing was
 * never the thing that was broken.
 *
 * Where an action genuinely does not exist for one of the five operations, the
 * probe is OMITTED rather than faked, and the engine reports it as a skip. A
 * missing probe is visible in the coverage table at the end of every run.
 */
import type { ModelProbe } from "./engine";
import type { SeededRows } from "./seed";

/** Which seeded row of the victim tenant a given model aims at. */
export type RowSelector = (rows: SeededRows) => string;

export type MatrixEntry = ModelProbe & {
  victimRow: RowSelector;
  /** Only when the DELETE check must aim at a different row — see engine.ts. */
  deleteVictimRow?: RowSelector;
};

const fd = (entries: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

/**
 * Actions signal "no" in three different ways in this codebase — a thrown
 * redirect from an access guard, a thrown Error, or an `{ error }` result from
 * asActionResult. The engine treats all three identically (it judges the data,
 * not the message), so probes simply return whatever the action returned and let
 * throws propagate.
 */
export async function buildMatrix(): Promise<MatrixEntry[]> {
  const pipelines = await import("../../src/app/actions/pipelines");
  const dashboards = await import("../../src/app/actions/dashboardConfig");
  const contacts = await import("../../src/app/actions/contacts");
  const leads = await import("../../src/app/actions/leads");
  const quotes = await import("../../src/app/actions/quotes");
  const flows = await import("../../src/app/actions/flow");
  const pins = await import("../../src/app/actions/timelinePins");
  const testDrives = await import("../../src/app/actions/testDrives");
  const journeyRuns = await import("../../src/app/actions/journeyRuns");
  const jobcards = await import("../../src/app/actions/jobcards");
  const privacy = await import("../../src/app/actions/privacy");
  const pipelineLib = await import("../../src/lib/pipelines");

  return [
    /* ───────────────────────────────────────────────────────────────────────
     * SalesPipeline — the module the audit found had been skipped entirely.
     * Every read and write in src/lib/pipelines.ts goes through basePrisma
     * (which sets app.bypass_rls='on') as raw SQL with no tenant predicate, so
     * neither the Prisma guard extension nor RLS is in the path at all.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      model: "SalesPipeline",
      table: "SalesPipeline",
      actions: "pipelines.ts: createSalesPipeline / editSalesPipeline / archiveSalesPipeline",
      witness: "name",
      victimRow: (r) => r.pipelineId,
      deleteVictimRow: (r) => r.archivePipelineId,
      createViaAction: async (actor) => {
        const before = await pipelineLib.listSalesPipelines();
        const seen = new Set(before.map((p) => p.id));
        await actor.as(() =>
          pipelines.createSalesPipeline(fd({ name: `probe-${actor.tenant.key}-${Date.now().toString(36)}`, type: "sales" })),
        );
        const after = await pipelineLib.listSalesPipelines();
        return after.find((p) => !seen.has(p.id))?.id ?? null;
      },
      readById: async (actor, id) => {
        // editSalesPipeline's own pre-read is the closest thing to a detail
        // fetch; a successful edit means the row WAS readable, so a failed
        // edit is indistinguishable from "not found" — which is why the
        // authoritative signal here is the UPDATE check below.
        const rows = await pipelineLib.listSalesPipelines();
        return actor.tenant ? (rows.find((p) => p.id === id) ?? null) : null;
      },
      updateById: async (actor, id, value) =>
        actor.as(() => pipelines.editSalesPipeline(id, fd({ name: value, type: "sales", active: "on" }))),
      deleteById: async (actor, id) => actor.as(() => pipelines.archiveSalesPipeline(id, fd({}))),
      list: async (actor) => actor.as(async () => (await pipelineLib.listSalesPipelines()).map((p) => p.id)),
      gaps: "reorderPipelineStages, saveLeadForecast and snapshotForecast are not driven.",
    },

    /* PipelineStage — tenant-filtered in lib/pipelines.ts, unlike its parent.
     * Included precisely because it is the CORRECT sibling of a broken model:
     * if the suite cannot tell these two apart it is not measuring anything. */
    {
      model: "PipelineStage",
      table: "PipelineStage",
      actions: "pipelines.ts: createSalesPipelineStage / editSalesPipelineStage",
      witness: "name",
      victimRow: (r) => r.stageId,
      createViaAction: async (actor) => {
        const before = await pipelineLib.listPipelineStages(actor.tenant.rows.pipelineId);
        const seen = new Set(before.map((s) => s.id));
        await actor.as(() =>
          pipelines.createSalesPipelineStage(
            actor.tenant.rows.pipelineId,
            fd({ name: `stage-${Date.now().toString(36)}`, defaultProbability: "20" }),
          ),
        );
        const after = await pipelineLib.listPipelineStages(actor.tenant.rows.pipelineId);
        return after.find((s) => !seen.has(s.id))?.id ?? null;
      },
      readById: async (actor, id) => actor.as(() => pipelineLib.getPipelineStage(id)),
      updateById: async (actor, id, value) =>
        actor.as(() => pipelines.editSalesPipelineStage(id, fd({ name: value, defaultProbability: "20" }))),
      // LIST THE VICTIM'S PIPELINE, NOT THE ACTOR'S.
      //
      // This probe originally listed the ACTOR's own pipeline, and mutation
      // testing proved that worthless: deleting the tenant predicate from
      // listPipelineStages() outright did not turn the suite red, because a
      // query scoped by `pipelineId = <A's pipeline>` cannot return B's stages
      // whether or not it also filters by tenant. The check was passing for a
      // reason that had nothing to do with the boundary it claimed to test.
      //
      // Asking for B's pipeline id is the realistic attack anyway — the id is
      // in a URL — and it makes the tenant predicate the ONLY thing standing
      // between A and B's rows, which is the point.
      list: async (actor) =>
        actor.as(async () => (await pipelineLib.listPipelineStages(victimPipeline)).map((s) => s.id)),
      gaps: "no delete action exists for a stage; moveStage and reorderPipelineStages are not driven.",
    },

    /* ───────────────────────────────────────────────────────────────────────
     * The five models the pre-flip audit found 100% UNOWNED in production.
     * Each declares tenantId and satisfies tenantSchemaContract.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      model: "Dashboard",
      table: "Dashboard",
      actions: "dashboardConfig.ts: createDashboard / renameDashboard / deleteDashboard",
      witness: "title",
      victimRow: (r) => r.dashboardId,
      createViaAction: async (actor) => {
        const title = `probe ${Date.now().toString(36)}`;
        await actor.as(() => dashboards.createDashboard(title));
        const { basePrisma } = await import("../../src/lib/db");
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "Dashboard" WHERE "userId" = $1 AND "title" = $2`,
          actor.tenant.memberUserId,
          title,
        );
        return rows[0]?.id ?? null;
      },
      // Dashboards are addressed by slug, and every action scopes on userId, so
      // the cross-tenant probe uses the VICTIM's slug — the realistic forgery.
      updateById: async (actor, _id, value) =>
        actor.as(() => dashboards.renameDashboard(victimSlugFor(actor), value)),
      deleteById: async (actor) => actor.as(() => dashboards.deleteDashboard(victimSlugFor(actor))),
      gaps: "no read-by-id or list action is exported; saveDashboardConfig and reorderDashboards are not driven.",
    },

    {
      model: "TimelinePin",
      table: "TimelinePin",
      actions: "timelinePins.ts: toggleActivityPin",
      witness: "kind",
      victimRow: (r) => r.timelinePinId,
      createViaAction: async (actor) => {
        // Toggling twice would remove it again, so this pins the tenant's own
        // activity once and reads back the pin row it produced.
        const { basePrisma } = await import("../../src/lib/db");
        await basePrisma.$executeRawUnsafe(
          `DELETE FROM "TimelinePin" WHERE "kind" = 'activity' AND "itemId" = $1`,
          actor.tenant.rows.activityId,
        );
        await actor.as(() => pins.toggleActivityPin(actor.tenant.rows.activityId, "/leads"));
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "TimelinePin" WHERE "kind" = 'activity' AND "itemId" = $1`,
          actor.tenant.rows.activityId,
        );
        return rows[0]?.id ?? null;
      },
      // A pin is toggled by the id of the ITEM, so the cross-tenant attempt
      // targets the victim's activity — unpinning it if the guard lets it.
      deleteById: async (actor) => actor.as(() => pins.toggleActivityPin(victimActivityFor(actor), "/leads")),
      gaps: "read/update/list are not exposed as actions; getTimelinePins (lib) is not driven.",
    },

    {
      model: "JourneyRun",
      table: "JourneyRun",
      actions: "journeyRuns.ts: cancelJourneyRun / retryJourneyRun",
      witness: "status",
      victimRow: (r) => r.journeyRunId,
      updateById: async (actor, id) => actor.as(() => journeyRuns.retryJourneyRun(id)),
      deleteById: async (actor, id) => actor.as(() => journeyRuns.cancelJourneyRun(id)),
      gaps:
        "no create probe (runJourneyOnLead needs a published journey version); " +
        "no read or list action is exported.",
    },

    {
      model: "TestDriveBooking",
      table: "TestDriveBooking",
      actions: "testDrives.ts: updateTestDriveBooking / cancelTestDrive",
      witness: "branch",
      victimRow: (r) => r.testDriveId,
      updateById: async (actor, id, value) =>
        actor.as(() => testDrives.updateTestDriveBooking(id, fd({ branch: value }))),
      deleteById: async (actor, id) =>
        actor.as(() => testDrives.cancelTestDrive(id, fd({ reason: "harness cross-tenant probe" }))),
      gaps:
        "createTestDriveBooking needs a demo vehicle and a slot, so OWN is not driven here; " +
        "no read or list action is exported.",
    },

    /* ───────────────────────────────────────────────────────────────────────
     * Core CRM models — the ones with the most action surface.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      model: "Contact",
      table: "Contact",
      actions: "contacts.ts: createContact / updateContact / deleteContact",
      witness: "firstName",
      victimRow: (r) => r.contactId,
      createViaAction: async (actor) => {
        const first = `Probe${Date.now().toString(36)}`;
        await actor.as(() => contacts.createContact(fd({ firstName: first })));
        const { basePrisma } = await import("../../src/lib/db");
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "Contact" WHERE "firstName" = $1`,
          first,
        );
        return rows[0]?.id ?? null;
      },
      updateById: async (actor, id, value) =>
        actor.as(() => contacts.updateContact(id, fd({ firstName: value }))),
      deleteById: async (actor, id) =>
        actor.as(() => contacts.deleteContact(id, fd({ reason: "harness cross-tenant probe" }))),
      gaps: "no read or list action is exported from contacts.ts (pages query directly).",
    },

    {
      model: "Lead",
      table: "Lead",
      actions: "leads.ts: createLead / updateLead / deleteLead / markLost",
      witness: "title",
      victimRow: (r) => r.leadId,
      createViaAction: async (actor) => {
        const name = `Probe${Date.now().toString(36)}`;
        const result = await actor.as(() =>
          leads.createLead(fd({ name, title: name, stageId: actor.tenant.rows.stageId })),
        );
        const to = (result as { redirectTo?: string } | undefined)?.redirectTo;
        if (to) return to.split("/").pop() ?? null;
        const { basePrisma } = await import("../../src/lib/db");
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "Lead" WHERE "name" = $1`,
          name,
        );
        return rows[0]?.id ?? null;
      },
      updateById: async (actor, id, value) =>
        actor.as(() =>
          leads.updateLead(id, fd({ name: value, title: value, stageId: actor.tenant.rows.stageId })),
        ),
      deleteById: async (actor, id) =>
        actor.as(() => leads.deleteLead(id, fd({ reason: "harness cross-tenant probe" }))),
      gaps: "moveLead / assignLead / markWon / convertLeadToContact are not driven; no list action.",
    },

    {
      model: "Quote",
      table: "Quote",
      actions: "quotes.ts: saveQuoteDraft / setQuoteStatus / deleteQuote",
      witness: "terms",
      victimRow: (r) => r.quoteId,
      createViaAction: async (actor) => {
        const result = await actor.as(() =>
          quotes.saveQuoteDraft({
            contactId: actor.tenant.rows.contactId,
            terms: `probe ${Date.now().toString(36)}`,
            intent: "draft",
            items: [],
          } as Parameters<typeof quotes.saveQuoteDraft>[0]),
        );
        const ok = result as { ok?: boolean; quote?: { id: string } };
        return ok?.ok && ok.quote ? ok.quote.id : null;
      },
      readById: async (actor, id) => actor.as(() => quotes.quoteEditorRecord(id)),
      // The forged id lands in the SAVE payload — a quote draft names the row it
      // is updating, which is the exact shape of a forged form post.
      updateById: async (actor, id, value) =>
        actor.as(() =>
          quotes.saveQuoteDraft({
            id,
            contactId: actor.tenant.rows.contactId,
            terms: value,
            intent: "draft",
            items: [],
          } as Parameters<typeof quotes.saveQuoteDraft>[0]),
        ),
      deleteById: async (actor, id) =>
        actor.as(() => quotes.deleteQuote(id, fd({ reason: "harness cross-tenant probe" }))),
      gaps: "createQuoteRevision, createQuoteFromLead and the signing surface are not driven.",
    },

    /* ───────────────────────────────────────────────────────────────────────
     * PR #430's gating regression. The reviewer's objection to the existing
     * `unguardedTenantWrites` test is that it is a source scanner: it proves a
     * `tenantId` TOKEN appears in the payload, which is not the same fact as
     * what row ownership PostgreSQL ends up holding — and the bug was a
     * convincingly WRONG id being persisted, which a token check waves through.
     *
     * So the OWN check for these three does the one thing that settles it:
     * create through the action as a staff user of a tenant, then SELECT the row
     * and compare its tenantId column. Not the return value, not the arguments.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      model: "JobCard",
      table: "JobCard",
      actions: "jobcards.ts: createJobCard / setJobCardStatus / deleteJobCard",
      witness: "description",
      victimRow: (r) => r.jobCardId,
      createViaAction: async (actor) => {
        const description = `probe ${Date.now().toString(36)}`;
        // createJobCard ends in a bare redirect() on SUCCESS, so the thrown
        // redirect is the happy path and the row is found by its description.
        await actor
          .as(() => jobcards.createJobCard(fd({ vehicleId: actor.tenant.rows.vehicleId, description })))
          .catch(() => undefined);
        const { basePrisma } = await import("../../src/lib/db");
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "JobCard" WHERE "description" = $1`,
          description,
        );
        return rows[0]?.id ?? null;
      },
      updateById: async (actor, id) => actor.as(() => jobcards.setJobCardStatus(id, "diagnosis")),
      deleteById: async (actor, id) =>
        actor.as(() => jobcards.deleteJobCard(id, fd({ reason: "harness cross-tenant probe" }))),
      gaps:
        "the witness for UPDATE is `status` via setJobCardStatus, not `description`; " +
        "reservePart / addJobCardItem (the forged partId paths) are not driven here — see defects.ts.",
    },

    {
      model: "ConsentRecord",
      table: "ConsentRecord",
      actions: "privacy.ts: recordConsent",
      witness: "type",
      victimRow: (r) => r.consentRecordId,
      createViaAction: async (actor) => {
        const { basePrisma } = await import("../../src/lib/db");
        const before = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "ConsentRecord" WHERE "contactId" = $1`,
          actor.tenant.rows.contactId,
        );
        const seen = new Set(before.map((r) => r.id));
        await actor.as(() =>
          privacy.recordConsent(actor.tenant.rows.contactId, fd({ type: "marketing", granted: "granted" })),
        );
        const after = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "ConsentRecord" WHERE "contactId" = $1`,
          actor.tenant.rows.contactId,
        );
        return after.find((r) => !seen.has(r.id))?.id ?? null;
      },
      gaps: "consent records are append-only — there is no update, delete, read-by-id or list action to drive.",
    },

    {
      model: "BotFlow",
      table: "BotFlow",
      actions: "flow.ts: saveFlow / renameFlow / deleteFlow (all requireOwner)",
      witness: "name",
      victimRow: (r) => r.flowId,
      // Every flow action is gated on requireOwner(), so these act as the
      // tenant's OWNER user rather than its member.
      updateById: async (actor, id, value) => actor.asOwner(() => flows.renameFlow(id, fd({ name: value }))),
      deleteById: async (actor, id) => actor.asOwner(() => flows.deleteFlow(id)),
      gaps: "createFlow ends in a bare redirect() and exposes no id, so OWN is not driven; no read or list action.",
    },
  ];
}

/* The victim's identifiers are injected by the runner before each model runs,
 * because a probe signature only receives the acting side. Kept as module state
 * rather than threaded through every closure so the table stays readable. */
let victimSlug = "";
let victimActivity = "";
let victimPipeline = "";

export function setVictimHandles(slug: string, activityId: string, pipelineId: string): void {
  victimSlug = slug;
  victimActivity = activityId;
  victimPipeline = pipelineId;
}

function victimSlugFor(_actor: unknown): string {
  return victimSlug;
}
function victimActivityFor(_actor: unknown): string {
  return victimActivity;
}
