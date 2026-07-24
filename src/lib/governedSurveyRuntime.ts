import "server-only";

import { basePrisma, prisma } from "./db";
import { currentTenantScope } from "./tenantScopeEntry";
import { resolveTenantActor } from "./tenantActor";
import { createSurveyDistribution } from "./surveyDistributionQueue";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { defaultIntro, type SurveyQuestion, type SurveyType } from "./surveyTypes";

export type FrozenSurveySnapshot = {
  title: string;
  type: string;
  intro: string | null;
  thankYou: string | null;
  questions: SurveyQuestion[];
  trigger: string | null;
  delayHours: number;
};

type FrozenResponseRow = {
  id: string;
  tenantId: string | null;
  surveyId: string;
  surveyVersion: number | null;
  status: string;
  contactId: string | null;
  snapshot: FrozenSurveySnapshot;
};

function tenantFromScope() {
  const scope = currentTenantScope();
  if (!scope || scope.system) return undefined;
  return scope.tenantId;
}

export async function loadFrozenSurveyResponse(token: string): Promise<FrozenResponseRow | null> {
  const tenantId = tenantFromScope();
  if (tenantId === undefined) return null;
  const rows = await basePrisma.$queryRaw<FrozenResponseRow[]>`
    SELECT r."id", r."tenantId", r."surveyId", r."surveyVersion", r."status", r."contactId",
      COALESCE(
        v."snapshot",
        jsonb_build_object(
          'title', s."title", 'type', s."type", 'intro', s."intro", 'thankYou', s."thankYou",
          'questions', s."questions", 'trigger', s."trigger", 'delayHours', s."delayHours"
        )
      ) AS "snapshot"
    FROM "SurveyResponse" r
    JOIN "Survey" s ON s."id" = r."surveyId"
    LEFT JOIN "SurveyVersion" v
      ON v."surveyId" = r."surveyId"
      AND v."version" = r."surveyVersion"
      AND v."tenantId" IS NOT DISTINCT FROM r."tenantId"
    WHERE r."token" = ${token}
      AND r."tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND s."tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND s."deletedAt" IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    snapshot: {
      ...row.snapshot,
      intro: row.snapshot.intro || defaultIntro(row.snapshot.type as SurveyType),
      thankYou: row.snapshot.thankYou || null,
      questions: Array.isArray(row.snapshot.questions) ? row.snapshot.questions : [],
      trigger: row.snapshot.trigger || null,
      delayHours: Math.max(0, Number(row.snapshot.delayHours) || 0),
    },
  };
}

function answerMissing(question: SurveyQuestion, value: unknown) {
  if ((question as SurveyQuestion & { required?: boolean }).required === false) return false;
  if (question.type === "checkbox") return value !== true && value !== "true";
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function summarise(questions: SurveyQuestion[], answers: Record<string, unknown>, score: number | null) {
  const lines = questions.map((question) => {
    const value = answers[question.id];
    const formatted = Array.isArray(value) ? value.join(", ") : value === undefined || value === null || value === "" ? "—" : String(value);
    return `${question.label}\n  → ${formatted}`;
  });
  if (score !== null) lines.unshift(`Score: ${score}`);
  return lines.join("\n\n");
}

export async function submitFrozenSurveyResponse(token: string, supplied: Record<string, unknown>) {
  const response = await loadFrozenSurveyResponse(token);
  if (!response) return { ok: false as const, error: "not_found" as const };
  if (response.status === "completed") return { ok: false as const, error: "done" as const, survey: response.snapshot };

  const allowedIds = new Set(response.snapshot.questions.map((question) => question.id));
  const answers = Object.fromEntries(Object.entries(supplied).filter(([key]) => allowedIds.has(key)));
  const missing = response.snapshot.questions.filter((question) => answerMissing(question, answers[question.id]));
  if (missing.length) {
    return { ok: false as const, error: "validation" as const, fields: missing.map((question) => question.id), survey: response.snapshot };
  }

  let score: number | null = null;
  let comment: string | null = null;
  for (const question of response.snapshot.questions) {
    const answer = answers[question.id];
    if (score === null && (question.type === "nps" || question.type === "rating")) {
      const numeric = typeof answer === "number" ? answer : Number(answer);
      if (Number.isFinite(numeric)) score = numeric;
    }
    if (comment === null && question.type === "text" && typeof answer === "string" && answer.trim()) comment = answer.trim();
  }

  const changed = await basePrisma.$executeRaw`
    UPDATE "SurveyResponse"
    SET "answers" = ${JSON.stringify(answers)}::jsonb, "score" = ${score}, "comment" = ${comment},
      "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${response.id}
      AND "tenantId" IS NOT DISTINCT FROM ${response.tenantId}
      AND "status" <> 'completed'
  `;
  if (changed !== 1) return { ok: false as const, error: "done" as const, survey: response.snapshot };

  if (response.contactId) {
    const actor = await resolveTenantActor();
    if (actor) {
      await prisma.communication.create({
        data: {
          type: "note",
          direction: "inbound",
          subject: `Survey response: ${response.snapshot.title}`,
          body: summarise(response.snapshot.questions, answers, score),
          contactId: response.contactId,
          userId: actor.id,
        },
      });
    }
  }

  await logAudit({
    action: "survey.completed",
    summary: `Survey completed: ${response.snapshot.title}${score !== null ? ` — score ${score}` : ""}`,
    contactId: response.contactId ?? undefined,
    userName: "Customer",
  });
  return { ok: true as const, survey: response.snapshot };
}

export async function triggerGovernedSurvey(trigger: string, target: {
  contactId?: string | null;
  leadId?: string | null;
  jobCardId?: string | null;
}) {
  try {
    const tenantId = tenantFromScope();
    if (tenantId === undefined || !target.contactId) return;
    const surveys = await basePrisma.$queryRaw<Array<{
      id: string; title: string; type: string; delayHours: number; publishedVersion: number | null;
    }>>`
      SELECT "id", "title", "type", "delayHours", "publishedVersion"
      FROM "Survey"
      WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "trigger" = ${trigger}
        AND "status" = 'published'
        AND "active" = true
        AND "deletedAt" IS NULL
      ORDER BY "updatedAt" DESC
      LIMIT 1
    `;
    const survey = surveys[0];
    if (!survey?.publishedVersion) return;

    const recent = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "SurveyResponse"
      WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "surveyId" = ${survey.id}
        AND "contactId" = ${target.contactId}
        AND COALESCE("inviteSentAt", "sentAt", "scheduledFor") >= CURRENT_TIMESTAMP - INTERVAL '30 days'
        AND "status" NOT IN ('cancelled', 'suppressed', 'failed', 'failed_permanent')
    `;
    if (Number(recent[0]?.count ?? 0) > 0) return;

    const actor = await resolveTenantActor();
    if (!actor) return;
    const scheduledFor = survey.delayHours > 0 ? new Date(Date.now() + survey.delayHours * 3_600_000) : null;
    await createSurveyDistribution({
      tenantId,
      userId: actor.id,
      surveyId: survey.id,
      name: `${survey.title} · automated ${trigger}`,
      purpose: survey.type === "nps" || survey.type === "adhoc" ? "survey_marketing" : "survey_transactional",
      channel: "any",
      contactIds: [target.contactId],
      audienceSnapshot: {
        source: "automation_trigger",
        trigger,
        contactId: target.contactId,
        leadId: target.leadId ?? null,
        jobCardId: target.jobCardId ?? null,
        resolvedAt: new Date().toISOString(),
      },
      scheduledFor,
      reminderAfterHours: 48,
      maxReminders: 1,
    });
  } catch (error) {
    await logError("governed-survey-trigger", error);
  }
}
