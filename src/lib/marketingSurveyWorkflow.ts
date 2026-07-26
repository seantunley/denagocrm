import crypto from "node:crypto";
import { basePrisma } from "./db";
import { assertSurveyTransition, validateSurveyQuestions } from "./surveyLifecycle";

export type SurveyWorkflowRow = {
  id: string;
  tenantId: string | null;
  title: string;
  type: string;
  intro: string | null;
  thankYou: string | null;
  questions: unknown[];
  trigger: string | null;
  delayHours: number;
  active: boolean;
  status: string;
  publishedVersion: number | null;
  submittedById: string | null;
  approvedById: string | null;
  reviewNote: string | null;
};

export async function surveyWorkflowRow(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<SurveyWorkflowRow[]>`
    SELECT "id", "tenantId", "title", "type", "intro", "thankYou", "questions",
      "trigger", "delayHours", "active", "status", "publishedVersion",
      "submittedById", "approvedById", "reviewNote"
    FROM "Survey"
    WHERE "id" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "deletedAt" IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createInactiveSurveyDraft(args: {
  tenantId: string | null;
  userId: string;
  title: string;
  type: string;
  questions: unknown[];
}) {
  const id = `survey_${crypto.randomUUID()}`;
  await basePrisma.$executeRaw`
    INSERT INTO "Survey" (
      "id", "tenantId", "title", "type", "questions", "active", "trigger",
      "status", "createdById", "ownerId", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${args.tenantId}, ${args.title.trim() || "Untitled survey"}, ${args.type},
      ${JSON.stringify(args.questions)}::jsonb, false, NULL, 'draft', ${args.userId},
      ${args.userId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `;
  return id;
}

export async function updateSurveyDraftRecord(args: {
  id: string;
  tenantId: string | null;
  title: string;
  intro: string;
  thankYou: string;
  questions: unknown[];
  delayHours: number;
}) {
  const survey = await surveyWorkflowRow(args.id, args.tenantId);
  if (!survey) throw new Error("Survey not found");
  if (!new Set(["draft", "changes_requested"]).has(survey.status)) {
    throw new Error("Published or reviewed survey versions cannot be edited");
  }
  const changed = await basePrisma.$executeRaw`
    UPDATE "Survey"
    SET "title" = ${args.title.trim() || "Untitled survey"},
      "intro" = ${args.intro.trim() || null},
      "thankYou" = ${args.thankYou.trim() || null},
      "questions" = ${JSON.stringify(args.questions)}::jsonb,
      "delayHours" = ${Math.max(0, Math.round(args.delayHours))},
      "active" = false,
      "trigger" = NULL,
      "status" = 'draft',
      "reviewNote" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.id}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "status" IN ('draft', 'changes_requested')
  `;
  if (changed !== 1) throw new Error("Survey changed while you were editing. Reload and try again.");
}

export async function transitionSurvey(args: {
  id: string;
  tenantId: string | null;
  to: string;
  userId: string;
  note?: string | null;
}) {
  const survey = await surveyWorkflowRow(args.id, args.tenantId);
  if (!survey) throw new Error("Survey not found");
  assertSurveyTransition(survey.status, args.to);

  if (args.to === "in_review") {
    const errors = validateSurveyQuestions(survey.questions);
    if (!survey.title.trim()) errors.unshift("Give the survey a name");
    if (errors.length) throw new Error(errors.join("; "));
  }
  if (args.to === "changes_requested" && !args.note?.trim()) {
    throw new Error("Explain the requested changes");
  }
  if (args.to === "approved" && survey.submittedById === args.userId) {
    throw new Error("The person who submitted a survey cannot approve it");
  }

  const changed = await basePrisma.$executeRaw`
    UPDATE "Survey"
    SET "status" = ${args.to},
      "submittedForReviewAt" = CASE WHEN ${args.to} = 'in_review' THEN CURRENT_TIMESTAMP ELSE "submittedForReviewAt" END,
      "submittedById" = CASE WHEN ${args.to} = 'in_review' THEN ${args.userId} ELSE "submittedById" END,
      "approvedAt" = CASE WHEN ${args.to} = 'approved' THEN CURRENT_TIMESTAMP ELSE "approvedAt" END,
      "approvedById" = CASE WHEN ${args.to} = 'approved' THEN ${args.userId} ELSE "approvedById" END,
      "changesRequestedAt" = CASE WHEN ${args.to} = 'changes_requested' THEN CURRENT_TIMESTAMP ELSE "changesRequestedAt" END,
      "reviewNote" = CASE
        WHEN ${args.to} = 'changes_requested' THEN ${args.note?.trim() || null}
        WHEN ${args.to} IN ('in_review', 'approved') THEN NULL
        ELSE "reviewNote"
      END,
      "active" = CASE WHEN ${args.to} IN ('inactive', 'archived', 'draft', 'changes_requested') THEN false ELSE "active" END,
      "archivedAt" = CASE WHEN ${args.to} = 'archived' THEN CURRENT_TIMESTAMP ELSE "archivedAt" END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.id}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "status" = ${survey.status}
  `;
  if (changed !== 1) throw new Error("Survey status changed. Reload and try again.");
}

export async function publishSurveyVersion(args: {
  id: string;
  tenantId: string | null;
  userId: string;
  label?: string | null;
  trigger?: string | null;
  replaceExisting?: boolean;
}) {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`survey:${args.id}`}))`;
    const locked = await tx.$queryRaw<SurveyWorkflowRow[]>`
      SELECT "id", "tenantId", "title", "type", "intro", "thankYou", "questions",
        "trigger", "delayHours", "active", "status", "publishedVersion",
        "submittedById", "approvedById", "reviewNote"
      FROM "Survey"
      WHERE "id" = ${args.id}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const survey = locked[0];
    if (!survey) throw new Error("Survey not found");
    assertSurveyTransition(survey.status, "published");
    const errors = validateSurveyQuestions(survey.questions);
    if (errors.length) throw new Error(errors.join("; "));

    if (args.trigger) {
      const conflicts = await tx.$queryRaw<Array<{ id: string; title: string }>>`
        SELECT "id", "title"
        FROM "Survey"
        WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
          AND "trigger" = ${args.trigger}
          AND "active" = true
          AND "deletedAt" IS NULL
          AND "id" <> ${args.id}
        FOR UPDATE
      `;
      if (conflicts.length && !args.replaceExisting) {
        throw new Error(`Trigger already belongs to “${conflicts[0].title}”`);
      }
      if (conflicts.length) {
        await tx.$executeRaw`
          UPDATE "Survey"
          SET "active" = false, "status" = 'inactive', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
            AND "trigger" = ${args.trigger}
            AND "active" = true
            AND "id" <> ${args.id}
        `;
      }
    }

    const versions = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT COALESCE(MAX("version"), 0) + 1 AS "version"
      FROM "SurveyVersion"
      WHERE "surveyId" = ${args.id}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    `;
    const version = Number(versions[0]?.version ?? 1);
    const snapshot = {
      title: survey.title,
      type: survey.type,
      intro: survey.intro,
      thankYou: survey.thankYou,
      questions: survey.questions,
      trigger: args.trigger ?? null,
      delayHours: survey.delayHours,
    };
    await tx.$executeRaw`
      INSERT INTO "SurveyVersion" (
        "id", "tenantId", "surveyId", "version", "snapshot", "publishedAt", "publishedById", "label"
      ) VALUES (
        ${`sv_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.id}, ${version},
        ${JSON.stringify(snapshot)}::jsonb, CURRENT_TIMESTAMP, ${args.userId}, ${args.label?.trim() || null}
      )
    `;
    const changed = await tx.$executeRaw`
      UPDATE "Survey"
      SET "status" = 'published', "publishedVersion" = ${version}, "active" = true,
        "trigger" = ${args.trigger ?? null}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${args.id}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "status" = 'approved'
    `;
    if (changed !== 1) throw new Error("Survey approval changed before publication");
    return version;
  });
}

export async function createSurveyRevision(args: {
  id: string;
  tenantId: string | null;
  userId: string;
}) {
  const source = await surveyWorkflowRow(args.id, args.tenantId);
  if (!source) throw new Error("Survey not found");
  if (!new Set(["published", "inactive"]).has(source.status)) {
    throw new Error("Only a published or inactive survey can be revised");
  }
  return createInactiveSurveyDraft({
    tenantId: args.tenantId,
    userId: args.userId,
    title: `${source.title} — revision`,
    type: source.type,
    questions: source.questions,
  });
}

export async function publishedSurveySnapshot(
  surveyId: string,
  version: number,
  tenantId?: string | null,
) {
  const rows = await basePrisma.$queryRaw<Array<{ snapshot: Record<string, unknown> }>>`
    SELECT "snapshot"
    FROM "SurveyVersion"
    WHERE "surveyId" = ${surveyId}
      AND "version" = ${version}
      AND (${tenantId === undefined} OR "tenantId" IS NOT DISTINCT FROM ${tenantId ?? null})
    LIMIT 1
  `;
  return rows[0]?.snapshot ?? null;
}
