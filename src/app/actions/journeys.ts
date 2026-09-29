"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite, withActingStaffScope } from "@/lib/actingScope";
import { journeyScope } from "@/lib/flowScope";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { collectAssignedUserIds, parseConditionGroup, parseJourneyDefinition } from "@/lib/journeyTypes";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { parseJourneyTriggers } from "@/lib/journeyTriggers";
import { parseRunMode } from "@/lib/journeyArbitration";
import {
  enrollJourneyNow,
  processJourneyEvents,
  processJourneyRuns,
} from "@/lib/journeys";

function parseObject(value: FormDataEntryValue | null, label: string) {
  if (!value || String(value).trim() === "") return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/** The array counterpart of parseObject — same "not valid JSON" contract. */
function parseArray(value: FormDataEntryValue | null, label: string) {
  if (!value || String(value).trim() === "") return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as unknown[];
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function journeyData(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const category = String(formData.get("category") ?? "automation");
  if (!name) throw new Error("Journey name is required");
  if (!new Set(["automation", "marketing"]).has(category)) throw new Error("Invalid journey category");

  // STRICT here, tolerant in the engine. This is the one place a person is
  // waiting to be told their journey is wrong, so an unknown trigger, a repeated
  // id or two unnamed triggers of the same type are all refused with a message
  // — rather than saved and discovered later as a journey that enrols nobody.
  const triggers = parseJourneyTriggers(parseArray(formData.get("triggers"), "Enrolment triggers"));
  const rawConditions = parseObject(formData.get("entryConditions"), "Entry conditions");
  const rawDefinition = parseObject(formData.get("definition"), "Journey definition") ?? {
    startStepId: null,
    steps: [],
  };
  const entryConditions = parseConditionGroup(rawConditions);
  const definition = parseJourneyDefinition(rawDefinition);

  // Absent is NOT the same as invalid, and the difference is destructive.
  // parseRunMode maps anything it does not recognise to "single" — which is
  // right for a garbage value, but a form that simply did not carry the control
  // would then silently downgrade every backfilled `parallel` journey to
  // `single` the first time anyone pressed Save. So a missing field means
  // "leave it alone"; only a present one is parsed and written.
  const rawRunMode = formData.get("runMode");
  const runMode = rawRunMode === null ? null : parseRunMode(String(rawRunMode));

  return {
    name: name.slice(0, 160),
    description: description?.slice(0, 1000) ?? null,
    category,
    runMode,
    triggers: triggers as unknown as Prisma.InputJsonValue,
    entryConditions: entryConditions as Prisma.InputJsonValue | null,
    definition: definition as Prisma.InputJsonValue,
  };
}

/**
 * The legacy `trigger` / `triggerConfig` pair, derived from the triggers list.
 *
 * EXPAND-PHASE DUAL-WRITE, and temporary. vercel.json runs
 * `apply-migrations && next build`, so the previous deployment keeps serving
 * production while this one builds — and that build reads those two columns.
 * Writing them alongside `triggers` is what keeps it correct for the length of
 * the rollout, and what makes a rollback a non-event instead of an outage.
 *
 * The FIRST trigger is the one projected down, mirroring the migration's
 * one-element backfill in reverse: a version with several triggers is a version
 * the old build cannot represent, so it sees the first and enrols on that rather
 * than on nothing. Under-representing is recoverable; `trigger` is NOT NULL and
 * a version with no triggers should never have got this far, so an empty list
 * throws rather than inventing a value the old build would act on.
 *
 * Deleted by the contract migration, together with the columns themselves.
 */
function legacyTriggerPair(triggers: unknown): { trigger: string; triggerConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull } {
  const first = Array.isArray(triggers) ? (triggers[0] as { type?: unknown; config?: unknown } | undefined) : undefined;
  if (!first || typeof first.type !== "string" || !first.type) {
    throw new Error("A journey version must declare at least one trigger.");
  }
  const config = first.config;
  return {
    trigger: first.type,
    triggerConfig:
      config && typeof config === "object" ? (config as Prisma.InputJsonValue) : Prisma.JsonNull,
  };
}

/**
 * Every stage and segment a trigger names must belong to the SAME tenant as the
 * journey about to go live.
 *
 * Shape validation cannot answer this: `parseJourneyTriggers` proves a
 * `stageId` is a well-formed string, not that it points at a row this workspace
 * owns. A published version is what the enrolment sweep acts on, so a reference
 * to another tenant's stage or segment is either an enrolment that never fires
 * or one that fires against data this workspace cannot see — both silent.
 *
 * Scoped by the journey's OWN tenantId rather than checked afterwards, so a
 * foreign id simply does not resolve. `tenantId: null` compiles to `IS NULL`,
 * which is the correct reading of an untenanted journey: it may reference
 * untenanted rows and nothing else.
 */
async function assertTriggerReferencesResolve(tenantId: string | null, triggers: unknown): Promise<void> {
  const specs = Array.isArray(triggers) ? (triggers as Array<{ type?: unknown; config?: unknown }>) : [];
  const stageIds = new Set<string>();
  const segmentIds = new Set<string>();
  for (const spec of specs) {
    const config = (spec?.config ?? {}) as Record<string, unknown>;
    if (typeof config.stageId === "string" && config.stageId) stageIds.add(config.stageId);
    if (typeof config.segmentId === "string" && config.segmentId) segmentIds.add(config.segmentId);
  }

  if (stageIds.size > 0) {
    const found = await prisma.pipelineStage.findMany({
      where: { tenantId, id: { in: [...stageIds] } },
      select: { id: true },
    });
    const alive = new Set(found.map((row) => row.id));
    const missing = [...stageIds].filter((id) => !alive.has(id));
    if (missing.length > 0) {
      throw new Error("This journey enrols on a pipeline stage that no longer exists in this workspace.");
    }
  }

  if (segmentIds.size > 0) {
    const found = await prisma.segment.findMany({
      where: { tenantId, id: { in: [...segmentIds] } },
      select: { id: true },
    });
    const alive = new Set(found.map((row) => row.id));
    const missing = [...segmentIds].filter((id) => !alive.has(id));
    if (missing.length > 0) {
      throw new Error("This journey enrols on a segment that no longer exists in this workspace.");
    }
  }
}

/**
 * Every person an `assign_user` step names must be a member of THIS workspace.
 *
 * The sibling of {@link assertTriggerReferencesResolve}, and for the same
 * reason: shape validation proves `config.userId` is a well-formed string, not
 * that it points at somebody who works here. The difference is what a bad value
 * does. A foreign stage id makes a journey that enrols nobody; a foreign USER id
 * makes a journey that works — it reassigns this workspace's leads to a stranger
 * on every run, and the run trace records it as "Lead assigned".
 *
 * Checked where the definition is WRITTEN rather than only where it runs. The
 * executor has no one to refuse to: it is the cron, and its options are to skip
 * silently or to assign wrongly. A save has a person in front of it.
 */
async function assertStepAssigneesResolve(definition: unknown): Promise<void> {
  for (const userId of collectAssignedUserIds(definition)) {
    // Throws ActionRefusal naming the field, exactly as the forms do.
    await resolveAssignableUser(userId, "team member");
  }
}

export async function createJourney(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const data = journeyData(formData);
    await assertStepAssigneesResolve(data.definition);
    // Atomic: journey + its first version in ONE transaction, tenant-stamped.
    //
    // USER-ORIGINATED: `requirePermission("journeys.manage")` above proves a
    // signed-in person is doing this, and a journey has no parent record, so the
    // acting workspace is the owner. `withTenantWrite` resolved the FOUNDING tenant
    // for every actor while enforcement is dormant — and a journey is not an inert
    // record: `publishJourney` scopes its stage/segment validation by
    // `journey.tenantId`, so a journey created in workspace B but stamped with
    // tenant A refuses to publish against B's own stages ("no longer exists in this
    // workspace") while looking correctly owned. The VERSION shares the journey's
    // tenantId from the same transaction, so parent and child cannot disagree.
    const journey = await withActingTenantWrite(async (tx, tenantId) => {
      const j = await tx.journey.create({
        data: {
          name: data.name,
          description: data.description,
          category: data.category,
          // A new journey with no control on the form keeps the schema default
          // ("single"), which is the safe end of the range.
          ...(data.runMode ? { runMode: data.runMode } : {}),
          createdById: user.id,
          tenantId,
        },
      });
      await tx.journeyVersion.create({
        data: {
          journeyId: j.id,
          version: 1,
          state: "draft",
          triggers: data.triggers,
          ...legacyTriggerPair(data.triggers),
          entryConditions: data.entryConditions ?? Prisma.JsonNull,
          definition: data.definition,
          createdById: user.id,
          tenantId,
        },
      });
      return j;
    });
    await logAudit({
      action: "journey.created",
      summary: `Created journey “${journey.name}”`,
      user,
    });
    revalidatePath("/journeys");
    // /automations was revalidated here too; it is a redirect now, with nothing
    // of its own to re-render.
  });
}

export async function saveJourneyDraft(journeyId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const data = journeyData(formData);
    await assertStepAssigneesResolve(data.definition);
    await prisma.$transaction(async (tx) => {
      const journey = await tx.journey.findUniqueOrThrow({
        where: { id: journeyId },
        include: { versions: { orderBy: { version: "desc" } } },
      });
      const draft = journey.versions.find((version) => version.state === "draft");
      const versionData = {
        triggers: data.triggers,
        ...legacyTriggerPair(data.triggers),
        entryConditions: data.entryConditions ?? Prisma.JsonNull,
        definition: data.definition,
        createdById: user.id,
      };
      if (draft) {
        await tx.journeyVersion.update({ where: { id: draft.id }, data: versionData });
      } else {
        await tx.journeyVersion.create({
          data: {
            journeyId,
            version: (journey.versions[0]?.version ?? 0) + 1,
            state: "draft",
            ...versionData,
          },
        });
      }
      await tx.journey.update({
        where: { id: journeyId },
        data: {
          name: data.name,
          description: data.description,
          category: data.category,
          // The run mode lives on the Journey, not the version: it governs
          // enrolment, which happens before any version is chosen, and it takes
          // effect without a republish. Dropping it here is what left every
          // journey stuck on whatever the database had.
          ...(data.runMode ? { runMode: data.runMode } : {}),
          status: journey.activeVersion ? journey.status : "draft",
        },
      });
    });
    await logAudit({
      action: "journey.draft_saved",
      summary: `Saved a new draft for journey “${data.name}”`,
      user,
    });
    revalidatePath("/journeys");
  });
}

export async function publishJourney(journeyId: string) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const journey = await prisma.journey.findUniqueOrThrow({
      where: { id: journeyId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    const draft = journey.versions.find((version) => version.state === "draft");
    if (!draft) throw new Error("This journey has no draft to publish");

    // PUBLISH IS THE STRICT GATE — for the whole version, not just its definition.
    //
    // Saving already validates strictly, so it is tempting to treat a stored draft
    // as trusted. It is not: legacy drafts were CONVERTED into the triggers shape
    // by a migration, never re-saved, and the runtime reader is deliberately
    // tolerant of trigger names it does not know so that an unknown name degrades
    // to "matches nothing" instead of throwing mid-sweep. Publishing such a draft
    // without re-checking therefore produces an ACTIVE journey that silently
    // enrols nobody — the exact failure this feature must not introduce, and one
    // no error surfaces because tolerance is doing its job.
    //
    // So everything that decides who gets enrolled is re-parsed here, strictly,
    // before any row changes state.
    parseJourneyTriggers(draft.triggers);
    parseConditionGroup(draft.entryConditions);
    parseJourneyDefinition(draft.definition);
    await assertTriggerReferencesResolve(journey.tenantId, draft.triggers);
    // Also on publish, not only on save: a draft can be written by one build and
    // published by another, and membership can lapse in between. Publishing is
    // what the enrolment sweep acts on, so it is the last point at which a person
    // can be told.
    await assertStepAssigneesResolve(draft.definition);

    await prisma.$transaction([
      prisma.journeyVersion.updateMany({
        where: { journeyId, state: "published" },
        data: { state: "retired" },
      }),
      prisma.journeyVersion.update({
        where: { id: draft.id },
        data: { state: "published", publishedAt: new Date() },
      }),
      prisma.journey.update({
        where: { id: journeyId },
        data: { activeVersion: draft.version, status: "active" },
      }),
    ]);
    await logAudit({
      action: "journey.published",
      summary: `Published journey “${journey.name}” version ${draft.version}`,
      user,
    });
    revalidatePath("/journeys");
  });
}

export async function setJourneyStatus(journeyId: string, status: "active" | "paused" | "archived") {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { id: journeyId } });
    if (status === "active" && !journey.activeVersion) throw new Error("Publish the journey before activating it");
    await prisma.journey.update({ where: { id: journeyId }, data: { status } });
    await logAudit({
      action: `journey.${status}`,
      summary: `${status === "active" ? "Activated" : status === "paused" ? "Paused" : "Archived"} journey “${journey.name}”`,
      user,
    });
    revalidatePath("/journeys");
  });
}

export async function runJourneyNow(journeyId: string) {
  return withActingStaffScope(async () => {
    await requirePermission("journeys.manage");
    const scheduled = await enrollJourneyNow(journeyId);
    const events = await processJourneyEvents(100);
    const runs = await processJourneyRuns(50);
    revalidatePath("/journeys");
    return { scheduled, events, runs };
  });
}

function definition(steps: Array<Record<string, unknown>>) {
  return {
    startStepId: steps[0]?.id ?? null,
    steps: steps.map((step, index) => ({
      ...step,
      nextStepId: index < steps.length - 1 ? steps[index + 1].id : null,
    })),
  };
}

export async function installJourneyTemplates() {
  return withActingStaffScope(async () => {
    const user = await requirePermission("journeys.manage");
    const templates = [
      {
        name: "New lead speed-to-contact",
        description: "Immediately alerts the team and creates a same-day follow-up task.",
        category: "automation",
        triggers: [{ type: "lead_created", config: {} }],
        entryConditions: { logic: "and", conditions: [] },
        definition: definition([
          { id: "notify", type: "send_push", config: { message: "New lead: {{name}} — {{model}}" } },
          { id: "task", type: "create_activity", config: { activityType: "call", summary: "Call new lead {{name}}", dueDays: 0 } },
        ]),
      },
      {
        name: "Won-customer welcome",
        description: "A delayed welcome message after a lead is marked won.",
        category: "marketing",
        triggers: [{ type: "lead_won", config: {} }],
        entryConditions: { logic: "and", conditions: [] },
        definition: definition([
          { id: "wait", type: "wait", config: { amount: 1, unit: "days" } },
          {
            id: "welcome",
            type: "send_email",
            config: {
              subject: "Welcome to the Denago Cape Town family",
              body: "Hi {{first_name}},\n\nThank you for choosing Denago Cape Town. We are delighted to have you with us and will be in touch with the next steps.\n\nWarm regards,\nDenago Cape Town",
            },
          },
        ]),
      },
      {
        name: "Purchase anniversary",
        description: "Annual anniversary greeting for vehicle owners.",
        category: "marketing",
        triggers: [{ type: "purchase_anniversary", config: {} }],
        entryConditions: { logic: "and", conditions: [] },
        definition: definition([
          {
            id: "anniversary-email",
            type: "send_email",
            config: {
              subject: "Happy Denago anniversary, {{first_name}}!",
              body: "Hi {{first_name}},\n\nHappy anniversary from Denago Cape Town. Thank you for being part of our community. If your vehicle needs a service, accessories or a battery health check, our team is ready to help.\n\nWarm regards,\nDenago Cape Town",
            },
          },
        ]),
      },
      {
        name: "Service win-back",
        description: "Re-engages owners who have been inactive for 12 months.",
        category: "marketing",
        triggers: [{ type: "win_back", config: { inactiveMonths: 12 } }],
        entryConditions: { logic: "and", conditions: [] },
        definition: definition([
          {
            id: "winback-email",
            type: "send_email",
            config: {
              subject: "We miss you at Denago Cape Town",
              body: "Hi {{first_name}},\n\nIt has been a while since we saw you. A quick service helps protect your vehicle and battery. Reply to this email and our team will arrange a convenient booking.\n\nWarm regards,\nDenago Cape Town",
            },
          },
          { id: "wait", type: "wait", config: { amount: 7, unit: "days" } },
          { id: "follow-up", type: "create_activity", config: { activityType: "call", summary: "Follow up win-back contact {{name}}", dueDays: 0 } },
        ]),
      },
    ];

    // USER-ORIGINATED: `requirePermission("journeys.manage")` above. Templates are
    // installed INTO the acting workspace, so both halves of this loop take that
    // workspace — and they must take the SAME one.
    //
    // The existence check is scoped for that reason. It was a bare name match with
    // no tenant predicate, and the db.ts guard adds none while enforcement is
    // dormant, so once the founding tenant had installed the templates every OTHER
    // workspace saw `exists` and installed NOTHING — the button reported success and
    // did nothing at all. Reading globally while writing into one workspace is the
    // same disagreement the write itself had, on the read side.
    // `journeyScope()` is the existing rule for "which Journey rows does this
    // builder's workspace own" — the same `enforced ?? session ?? founding` ladder
    // the acting scope uses, plus the documented legacy clause (Journey.tenantId is
    // nullable and the NULL rows are the FOUNDING tenant's, and only its). Reusing
    // it keeps one rule rather than a second copy that can drift from it.
    const ownScope = await journeyScope();
    for (const item of templates) {
      const exists = await prisma.journey.findFirst({
        where: { name: item.name, status: { not: "archived" }, ...ownScope },
      });
      if (exists) continue;
      await withActingTenantWrite(async (tx, tenantId) => {
        const tpl = await tx.journey.create({
          data: {
            name: item.name,
            description: item.description,
            category: item.category,
            createdById: user.id,
            tenantId,
          },
        });
        await tx.journeyVersion.create({
          data: {
            journeyId: tpl.id,
            version: 1,
            state: "draft",
            triggers: item.triggers,
            ...legacyTriggerPair(item.triggers),
            entryConditions: item.entryConditions,
            definition: item.definition as Prisma.InputJsonValue,
            createdById: user.id,
            tenantId,
          },
        });
      });
    }
    revalidatePath("/journeys");
  });
}
