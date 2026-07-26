import { basePrisma } from "./db";

export type SurveyMetricInput = {
  status: string;
  type: string;
  score: number | null;
  inviteSentAt: Date | null;
  sentAt: Date | null;
  completedAt: Date | null;
};

export function calculateSurveyMetrics(rows: SurveyMetricInput[]) {
  const delivered = rows.filter((row) => row.status === "sent" || row.status === "completed");
  const completed = rows.filter((row) => row.status === "completed");
  const npsScores = completed.filter((row) => row.type === "nps" && row.score !== null).map((row) => row.score as number);
  const promoters = npsScores.filter((score) => score >= 9).length;
  const passives = npsScores.filter((score) => score >= 7 && score <= 8).length;
  const detractors = npsScores.filter((score) => score <= 6).length;
  const nps = npsScores.length ? Math.round(((promoters - detractors) / npsScores.length) * 100) : null;

  const satisfactionScores = completed
    .filter((row) => (row.type === "csat" || row.type === "sales") && row.score !== null)
    .map((row) => row.score as number);
  const satisfied = satisfactionScores.filter((score) => score >= 4).length;
  const csat = satisfactionScores.length ? Math.round((satisfied / satisfactionScores.length) * 1000) / 10 : null;

  const responseHours = completed.flatMap((row) => {
    const sent = row.inviteSentAt ?? row.sentAt;
    if (!sent || !row.completedAt) return [];
    const hours = (row.completedAt.getTime() - sent.getTime()) / 3_600_000;
    return hours >= 0 ? [hours] : [];
  });

  return {
    delivered: delivered.length,
    completed: completed.length,
    responseRate: delivered.length ? Math.round((completed.length / delivered.length) * 1000) / 10 : 0,
    nps,
    npsResponses: npsScores.length,
    promoters,
    passives,
    detractors,
    csat,
    csatResponses: satisfactionScores.length,
    averageResponseHours: responseHours.length
      ? Math.round((responseHours.reduce((sum, value) => sum + value, 0) / responseHours.length) * 10) / 10
      : null,
  };
}

export async function loadSurveyAnalytics(args: {
  tenantId: string | null;
  from: Date;
  to: Date;
  surveyId?: string | null;
  distributionId?: string | null;
  type?: string | null;
  channel?: string | null;
}) {
  const rows = await basePrisma.$queryRaw<Array<SurveyMetricInput & {
    id: string;
    surveyId: string;
    distributionId: string | null;
    surveyTitle: string;
    distributionName: string | null;
    comment: string | null;
    contactId: string | null;
  }>>`
    SELECT r."id", r."surveyId", r."distributionId", r."status", r."score", r."inviteSentAt",
      r."sentAt", r."completedAt", r."comment", r."contactId", r."channel",
      s."title" AS "surveyTitle", s."type", d."name" AS "distributionName"
    FROM "SurveyResponse" r
    JOIN "Survey" s ON s."id" = r."surveyId"
    LEFT JOIN "SurveyDistribution" d ON d."id" = r."distributionId"
    WHERE r."tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND COALESCE(r."inviteSentAt", r."sentAt", r."scheduledFor") >= ${args.from}
      AND COALESCE(r."inviteSentAt", r."sentAt", r."scheduledFor") < ${args.to}
      AND (${!args.surveyId} OR r."surveyId" = ${args.surveyId ?? ""})
      AND (${!args.distributionId} OR r."distributionId" = ${args.distributionId ?? ""})
      AND (${!args.type} OR s."type" = ${args.type ?? ""})
      AND (${!args.channel} OR r."channel" = ${args.channel ?? ""})
    ORDER BY r."completedAt" DESC NULLS LAST, r."sentAt" DESC
    LIMIT 10000
  `;

  const metrics = calculateSurveyMetrics(rows);
  const trendMap = new Map<string, { sent: number; completed: number; scoreTotal: number; scoreCount: number }>();
  for (const row of rows) {
    const date = (row.inviteSentAt ?? row.sentAt ?? row.completedAt)?.toISOString().slice(0, 10);
    if (!date) continue;
    const day = trendMap.get(date) ?? { sent: 0, completed: 0, scoreTotal: 0, scoreCount: 0 };
    if (row.status === "sent" || row.status === "completed") day.sent += 1;
    if (row.status === "completed") day.completed += 1;
    if (row.score !== null) { day.scoreTotal += row.score; day.scoreCount += 1; }
    trendMap.set(date, day);
  }
  const trend = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({
    date,
    sent: value.sent,
    completed: value.completed,
    responseRate: value.sent ? Math.round((value.completed / value.sent) * 1000) / 10 : 0,
    averageScore: value.scoreCount ? Math.round((value.scoreTotal / value.scoreCount) * 10) / 10 : null,
  }));
  return { rows, metrics, trend };
}
