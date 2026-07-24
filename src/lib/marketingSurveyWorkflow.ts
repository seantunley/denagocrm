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
  reviewNote: string | null;
};

export async function surveyWorkflowRow(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<SurveyWorkflowRow[]>`SELECT "id", "tenantId", "title", "type", "intro", "thankYou", "questions", "trigger", "delayHours", "active", "status", "publishedVersion", "reviewNote" FROM "Survey" WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} AND "deletedAt" IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

export async function createInactiveSurveyDraft(args: { tenantId: string | null; userId: string; title: string; type: string; questions: unknown[] }) {
  const id = `survey_${crypto.randomUUID()}`;
  await basePrisma.$executeRaw`INSERT INTO "Survey" ("id", "tenantId", "title", "type", "questions", "active", "trigger", "status", "createdById", "ownerId", "createdAt", "updatedAt") VALUES (${id}, ${args.tenantId}, ${args.title}, ${args.type}, ${JSON.stringify(args.questions)}::jsonb, false, NULL, 'draft', ${args.userId}, ${args.userId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  return id;
}

export async function updateSurveyDraftRecord(args: { id: string; tenantId: string | null; title: string; intro: string; thankYou: string; questions: unknown[]; delayHours: number }) {
  const survey = await surveyWorkflowRow(args.id, args.tenantId);
  if (!survey) throw new Error("Survey not found");
  if (!new Set(["draft", "changes_requested"]).has(survey.status)) throw new Error("Published or reviewed survey versions cannot be edited");
  await basePrisma.$executeRaw`UPDATE "Survey" SET "title" = ${args.title || "Untitled survey"}, "intro" = ${args.intro || null}, "thankYou" = ${args.thankYou || null}, "questions" = ${JSON.stringify(args.questions)}::jsonb, "delayHours" = ${Math.max(0, Math.round(args.delayHours))}, "active" = false, "trigger" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${args.id} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}`;
}

export async function transitionSurvey(args: { id: string; tenantId: string | null; to: string; userId: string; note?: string | null }) {
  const survey = await surveyWorkflowRow(args.id, args.tenantId);
  if (!survey) throw new Error("Survey not found");
  assertSurveyTransition(survey.status, args.to);
  if (args.to === "in_review") {
    const errors = validateSurveyQuestions(survey.questions);
    if (errors.length) throw new Error(errors.join("; "));
  }
  await basePrisma.$executeRaw`UPDATE "Survey" SET "status" = ${args.to}, "submittedForReviewAt" = CASE WHEN ${args.to} = 'in_review' THEN CURRENT_TIMESTAMP ELSE "submittedForReviewAt" END, "approvedAt" = CASE WHEN ${args.to} = 'approved' THEN CURRENT_TIMESTAMP ELSE "approvedAt" END, "approvedById" = CASE WHEN ${args.to} = 'approved' THEN ${args.userId} ELSE "approvedById" END, "changesRequestedAt" = CASE WHEN ${args.to} = 'changes_requested' THEN CURRENT_TIMESTAMP ELSE "changesRequestedAt" END, "reviewNote" = COALESCE(${args.note ?? null}, "reviewNote"), "active" = CASE WHEN ${args.to} IN ('inactive','archived','draft') THEN false ELSE "active" END, "archivedAt" = CASE WHEN ${args.to} = 'archived' THEN CURRENT_TIMESTAMP ELSE "archivedAt" END, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${args.id} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = ${survey.status}`;
}

export async function publishSurveyVersion(args: { id: string; tenantId: string | null; userId: string; label?: string | null; trigger?: string | null; replaceExisting?: boolean }) {
  const survey = await surveyWorkflowRow(args.id, args.tenantId);
  if (!survey) throw new Error("Survey not found");
  assertSurveyTransition(survey.status, "published");
  const errors = validateSurveyQuestions(survey.questions);
  if (errors.length) throw new Error(errors.join("; "));
  const rows = await basePrisma.$queryRaw<Array<{ version: number }>>`SELECT COALESCE(MAX("version"), 0) + 1 AS version FROM "SurveyVersion" WHERE "surveyId" = ${args.id}`;
  const version = Number(rows[0]?.version ?? 1);
  const snapshot = { title: survey.title, type: survey.type, intro: survey.intro, thankYou: survey.thankYou, questions: survey.questions, trigger: args.trigger ?? null, delayHours: survey.delayHours };
  await basePrisma.$transaction(async (tx) => {
    if (args.trigger) {
      const conflicts = await tx.$queryRaw<Array<{ id: string; title: string }>>`SELECT "id", "title" FROM "Survey" WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "trigger" = ${args.trigger} AND "active" = true AND "deletedAt" IS NULL AND "id" <> ${args.id} FOR UPDATE`;
      if (conflicts.length && !args.replaceExisting) throw new Error(`Trigger already belongs to “${conflicts[0].title}”`);
      if (conflicts.length) await tx.$executeRaw`UPDATE "Survey" SET "active" = false, "status" = 'inactive', "updatedAt" = CURRENT_TIMESTAMP WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "trigger" = ${args.trigger} AND "active" = true AND "id" <> ${args.id}`;
    }
    await tx.$executeRaw`INSERT INTO "SurveyVersion" ("id", "tenantId", "surveyId", "version", "snapshot", "publishedAt", "publishedById", "label") VALUES (${`sv_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.id}, ${version}, ${JSON.stringify(snapshot)}::jsonb, CURRENT_TIMESTAMP, ${args.userId}, ${args.label ?? null})`;
    await tx.$executeRaw`UPDATE "Survey" SET "status" = 'published', "publishedVersion" = ${version}, "active" = true, "trigger" = ${args.trigger ?? null}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${args.id} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = 'approved'`;
  });
  return version;
}

export async function publishedSurveySnapshot(surveyId: string, version: number) {
  const rows = await basePrisma.$queryRaw<Array<{ snapshot: Record<string, unknown> }>>`SELECT "snapshot" FROM "SurveyVersion" WHERE "surveyId" = ${surveyId} AND "version" = ${version} LIMIT 1`;
  return rows[0]?.snapshot ?? null;
}
