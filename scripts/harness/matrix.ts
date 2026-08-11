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
  const journeyTrace = await import("../../src/lib/journeyTrace");
  const journeyRunsLib = await import("../../src/lib/journeyRuns");
  const journeyEnrolment = await import("../../src/lib/journeyDirectEnrollment");
  const pinLib = await import("../../src/lib/timelinePins");
  const permissionLib = await import("../../src/lib/permissions");

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
        actor.as(async () => (await pipelineLib.listPipelineStages(victimRows().pipelineId)).map((s) => s.id)),
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
      gaps:
        "READ and LIST are DELIBERATELY LEFT UNCOVERED, and the reason is the trap this suite already " +
        "fell into once. The only read surfaces are `dashboardBySlug` and `dashboardsForViewer` " +
        "(src/lib/dashboard/store.ts), and both are scoped `where: { userId: user.id }`. A probe " +
        "built on either could not return tenant B's dashboards whether or not a tenant predicate " +
        "existed anywhere — exactly the shape of the PipelineStage LIST probe that mutation testing " +
        "exposed as proving nothing. Two green checks would be added and zero facts. If a " +
        "cross-user read surface ever lands (dashboard sharing), probe it then. " +
        "saveDashboardConfig and reorderDashboards are not driven.",
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
      // `getTimelinePins` is what every timeline renders through, and it is RAW
      // SQL on the scoped client — `prisma.$queryRaw` with a hand-written WHERE
      // that names only itemId and kind. A raw query is not intercepted by the
      // Prisma extension at all, so the app-layer tenant guard has nothing to
      // say about it and RLS is the only remaining line. Asking for the
      // victim's activity id (which is what a timeline URL carries) is
      // therefore a genuine question with no second predicate to hide behind.
      readById: async (actor) =>
        actor.as(() => pinLib.getTimelinePins([{ kind: "activity", itemId: victimActivityFor(actor) }])),
      gaps:
        "no update action (a pin has no editable field) and no list action — getTimelinePins is a " +
        "by-item lookup, which the READ probe drives; it returns no row ids, so LIST cannot be " +
        "expressed against it without inventing one.",
    },

    {
      model: "JourneyRun",
      table: "JourneyRun",
      actions: "journeyRuns.ts: retryJourneyRun; journeyDirectEnrollment.ts: enrollEntityInJourney; journeyTrace.ts: recentRunSummaries",
      witness: "status",
      // THE FAILED RUN, NOT THE RUNNING ONE. `retryJourneyRun` refuses anything
      // that is not failed or cancelled, so aiming at the fixture's `running`
      // row meant the action stopped on a business rule and the engine — which
      // judges the row, correctly — recorded the untouched row as the boundary
      // holding. Mutation-tested: with this row the probe goes red when the
      // guard is removed, and with the running row it did not.
      victimRow: (r) => r.journeyRunFailedId,
      createViaAction: async (actor) => {
        // The chatbot's Start Journey path, which is the only place a run is
        // created without waiting for a real trigger to fire at a real
        // customer. JourneyRun is 6/6 unowned in production and previously had
        // NO create probe at all, so nothing here could have caught that.
        // ENROL THE CONTACT, NOT THE LEAD. The journey's runMode defaults to
        // `single`, under which arbitration DROPS an enrolment while any run is
        // still open on the same (journey, entityType, entityId) — and the
        // fixture keeps a `running` and a `queued` run on (journey, lead,
        // leadId). Aimed at the lead this probe returned no id and the check
        // reported itself as "the action does not expose the new row's id":
        // a skip that looks like a missing feature and is really a refusal.
        const enrolment = await actor.as(() =>
          journeyEnrolment.enrollEntityInJourney({
            journeyId: actor.tenant.rows.journeyId,
            entityType: "contact",
            entityId: actor.tenant.rows.contactId,
            eventKey: `harness-own-${Date.now().toString(36)}`,
          }),
        );
        return enrolment.runId ?? null;
      },
      updateById: async (actor, id) => actor.as(() => journeyRuns.retryJourneyRun(id)),
      // `recentRunSummaries()` has NO where clause of any kind — it is the
      // activity screen's "every recent run" query. That makes it the ideal
      // list probe and the exact opposite of the trap PipelineStage fell into:
      // there is no other predicate that could be doing the filtering, so a
      // pass can only mean the tenant predicate did it.
      list: async (actor) => actor.as(async () => (await journeyTrace.recentRunSummaries(100)).map((r) => r.id)),
      gaps:
        "DELETE is deliberately NOT probed: `cancelJourneyRun` sets status='cancelled' and JourneyRun has " +
        "no deletedAt column, so the engine's DELETE check (which asks whether the row still exists) could " +
        "never fail on it however broken the boundary was. It is asked as its own defect probe instead, " +
        "asserting on the status column. runJourneyOnLead and processJourneyRuns are not driven.",
    },

    /* ───────────────────────────────────────────────────────────────────────
     * JourneyStepLog — 6/6 unowned in production and, until now, the only model
     * in that list with NO probe of any kind. It is the engine's own audit
     * trail: one row per step execution, written by `updateStepLog` in
     * lib/journeyRuns.ts, which is reached ONLY by running a journey. That is
     * why it had no coverage — a probe for it has to actually drive the engine
     * — and it is exactly why the gap mattered.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      model: "JourneyStepLog",
      table: "JourneyStepLog",
      actions: "lib/journeyRuns.ts: processOneRun → updateStepLog; journeyRuns.ts: retryJourneyRun; journeyTrace.ts: traceRun / recentTraceRuns",
      witness: "status",
      victimRow: (r) => r.journeyStepLogId,
      deleteVictimRow: (r) => r.journeyStepLogRetryId,
      createViaAction: async (actor) => {
        // Run the tenant's own queued journey run one tick. `processOneRun` is
        // the function the journeys cron and `runJourneyOnLead` both call; it
        // claims the run, executes the step, and upserts the step log. Nothing
        // is stubbed — the seeded step is a real `add_tag` the executor skips
        // for want of a tag, so the write under test happens and nothing else
        // does.
        const { basePrisma } = await import("../../src/lib/db");
        const before = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "JourneyStepLog" WHERE "runId" = $1`,
          actor.tenant.rows.journeyRunQueuedId,
        );
        const seen = new Set(before.map((r) => r.id));
        await actor.as(() => journeyRunsLib.processOneRun(actor.tenant.rows.journeyRunQueuedId));
        const after = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "JourneyStepLog" WHERE "runId" = $1`,
          actor.tenant.rows.journeyRunQueuedId,
        );
        const made = after.find((r) => !seen.has(r.id))?.id ?? null;
        if (!made) {
          // A run that executed nothing must not be reported as "the action
          // does not expose an id" — that reads as a missing feature and hides
          // a fixture that never ran. Say why, using the run's own record.
          const [row] = await basePrisma.$queryRawUnsafe<Array<{ status: string; lastError: string | null; currentStepId: string | null; stepsExecuted: number }>>(
            `SELECT "status","lastError","currentStepId","stepsExecuted" FROM "JourneyRun" WHERE "id" = $1`,
            actor.tenant.rows.journeyRunQueuedId,
          );
          throw new Error(
            `processOneRun wrote no step log — run is ${row?.status}, stepsExecuted=${row?.stepsExecuted}, currentStepId=${row?.currentStepId}, lastError=${row?.lastError}`,
          );
        }
        return made;
      },
      // A step log is never addressed by its own id — it is read as part of its
      // run's trace, and the RUN id is what sits in the activity-screen URL. So
      // the realistic read is "A opens the trace of B's run", and the returned
      // steps are the rows in question.
      readById: async (actor) =>
        actor.as(async () => (await journeyTrace.traceRun(victimRows().journeyRunId))?.steps ?? null),
      // Same shape one level up: `recentTraceRuns` takes a journeyId straight
      // from the URL and includes every run's step logs. Asking for B's journey
      // id leaves the tenant predicate as the only thing in the way.
      list: async (actor) => {
        const exposed = await actor.as(async () =>
          (await journeyTrace.recentTraceRuns(victimRows().journeyId, 50)).flatMap((run) =>
            run.steps.map((step) => ({ runId: run.id, path: step.path })),
          ),
        );
        // A TraceStep carries `path`, not `id` — the row identity the trace UI
        // uses is (runId, path), which is the model's own @@unique. The engine
        // compares ids, so the pairs the application just handed over are
        // translated back to ids through the bypass client. The translation
        // reads ONLY what the app already leaked; it cannot manufacture a hit.
        if (exposed.length === 0) return [];
        const { basePrisma } = await import("../../src/lib/db");
        const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "JourneyStepLog" WHERE ("runId", "path") IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
          exposed.map((e) => e.runId),
          exposed.map((e) => e.path),
        );
        return rows.map((r) => r.id);
      },
      // `retryJourneyRun` opens with `journeyStepLog.deleteMany({ where: { runId,
      // status: { in: ["running","failed"] } } })`. The id the engine hands in is
      // the step log's; the action wants its RUN's, so the probe aims at the run
      // that owns the seeded failed step.
      deleteById: async (actor) => actor.as(() => journeyRuns.retryJourneyRun(victimRows().journeyRunRetryId)),
      gaps:
        "no update action exists — a step log is written by the engine and never edited. " +
        "The OWN probe drives processOneRun (lib), not a server action: nothing in src/app/actions " +
        "creates a step log except by running a journey, and runJourneyOnLead adds an event emit and " +
        "an arbitration pass that would make a failure ambiguous.",
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
      // THE GATE THE PAGE ITSELF USES. `/jobcards/[id]` opens with
      // `requireJobCardReadAccess(id)`, which resolves the row through
      // `canAccessJobCard` → `basePrisma.jobCard.findFirst({ id, ...activeTenantPredicate() })`.
      // basePrisma is the BYPASS client, so `activeTenantPredicate()` is not
      // defence in depth here — it is the entire boundary, and it is a plain
      // object spread that a careless edit deletes without breaking a type.
      // A refusal is a thrown redirect, which the engine already counts as
      // "returned nothing".
      readById: async (actor, id) => actor.as(() => permissionLib.requireJobCardReadAccess(id)),
      gaps:
        "the witness for UPDATE is `status` via setJobCardStatus, not `description`; " +
        "reservePart / addJobCardItem (the forged partId paths) are not driven here — see defects.ts. " +
        "No LIST: the job-card list is built inside the page component and is not exported, and " +
        "getAccessibleJobCardIds returns null (meaning 'no restriction') for a user holding " +
        "jobcards.view_all, so it cannot answer a tenancy question at all.",
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
      gaps:
        "consent records are append-only — there is no update, delete, read-by-id or list action to drive. " +
        "Every read of one is a NESTED include under a Contact or a Fleet (contacts/[id]/page.tsx, " +
        "fleetRollup.ts), so the row that decides the answer is the parent Contact, not the ConsentRecord: " +
        "a probe there would report on Contact's boundary under a ConsentRecord label. Left uncovered on " +
        "purpose rather than covered misleadingly.",
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
 * rather than threaded through every closure so the table stays readable.
 *
 * The whole row set is held rather than a hand-picked few: every one of these is
 * a handle that arrives from a URL or a form field in production, and a probe
 * that needs one should not require a signature change to get it.
 */
let victim: SeededRows | null = null;

export function setVictimHandles(rows: SeededRows): void {
  victim = rows;
}

/** The victim's rows. Throws rather than returning "" — an empty id would make
 *  a probe query for a row that cannot exist and report the miss as a pass. */
function victimRows(): SeededRows {
  if (!victim) throw new Error("setVictimHandles() was not called before the matrix ran");
  return victim;
}

function victimSlugFor(_actor: unknown): string {
  return victimRows().dashboardSlug;
}
function victimActivityFor(_actor: unknown): string {
  return victimRows().activityId;
}
