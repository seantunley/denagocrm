import "server-only";
import { prisma } from "./db";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { defaultIntro, type SurveyQuestion, type SurveyType } from "./surveyTypes";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");
export const surveyUrl = (token: string) => `${APP_URL}/s/${token}`;

type SurveyLite = { id: string; title: string; type: string; intro: string | null };

export type SurveyTarget = {
  contactId?: string | null;
  leadId?: string | null;
  jobCardId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

function subjectFor(type: SurveyType, title: string): string {
  switch (type) {
    case "csat":
      return "How was your service? A quick question ⭐";
    case "sales":
      return "Enjoying your new Denago? Tell us how we did ⭐";
    case "nps":
      return "One quick question from Denago Cape Town";
    default:
      return title;
  }
}

/**
 * Send one survey invite to a recipient. Best-effort and self-throttling:
 * one survey of a given type per contact per 30 days, and NPS/ad-hoc respect
 * the marketing opt-out (CSAT/sales are transactional, so they always go).
 * Returns true only when the invite was actually delivered.
 */
export async function sendSurvey(survey: SurveyLite, target: SurveyTarget): Promise<boolean> {
  let { name, email, phone } = target;
  const contactId = target.contactId ?? null;
  let optOut = false;

  if (contactId) {
    const c = await prisma.contact.findUnique({ where: { id: contactId } });
    if (c) {
      email = email ?? c.email;
      phone = phone ?? c.phone;
      name = name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");
      optOut = c.marketingOptOut;
    }
  }
  if (optOut && (survey.type === "nps" || survey.type === "adhoc")) return false;
  if (!email && !phone) return false;

  if (contactId) {
    const recent = await prisma.surveyResponse.findFirst({
      where: {
        contactId,
        survey: { type: survey.type },
        sentAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
    if (recent) return false;
  }

  const channel = email ? "email" : "sms";
  const resp = await prisma.surveyResponse.create({
    data: {
      surveyId: survey.id,
      contactId,
      leadId: target.leadId ?? null,
      jobCardId: target.jobCardId ?? null,
      name: name ?? null,
      channel,
    },
  });

  const link = surveyUrl(resp.token);
  const first = (name ?? "there").split(/\s+/)[0] || "there";
  const intro = survey.intro || defaultIntro(survey.type as SurveyType);

  let ok = false;
  if (email) {
    const r = await sendEmail({
      to: email,
      subject: subjectFor(survey.type as SurveyType, survey.title),
      text: `Hi ${first},\n\n${intro}\n\nTap here to answer (it takes under a minute):\n${link}\n\nThank you,\nDenago Cape Town`,
    });
    ok = r.ok;
  } else if (phone) {
    const r = await sendSms(phone, `Hi ${first}, ${intro} ${link}`);
    ok = r.ok;
  }

  if (!ok) {
    // Mark it failed rather than delete — keeps stats honest and retryable.
    await prisma.surveyResponse.update({ where: { id: resp.id }, data: { status: "failed" } }).catch(() => {});
    return false;
  }

  if (contactId) {
    const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (firstUser) {
      await prisma.communication.create({
        data: {
          type: channel === "email" ? "email" : "sms",
          direction: "outbound",
          subject: `Survey sent: ${survey.title}`,
          body: `"${survey.title}" survey invitation sent via ${channel}.`,
          contactId,
          userId: firstUser.id,
        },
      });
    }
  }

  await logAudit({
    action: "survey.sent",
    summary: `Sent "${survey.title}" survey to ${name ?? email ?? phone}`,
    contactId: contactId ?? undefined,
    userName: "System",
  });
  return true;
}

/** Fire the active survey wired to `trigger` (if any). Never throws. */
export async function triggerSurvey(trigger: string, target: SurveyTarget): Promise<void> {
  try {
    const survey = await prisma.survey.findFirst({
      where: { active: true, trigger },
      orderBy: { createdAt: "desc" },
    });
    if (!survey) return;
    await sendSurvey(survey, target);
  } catch (e) {
    await logError("survey-trigger", e);
  }
}

function summarise(
  questions: SurveyQuestion[],
  answers: Record<string, unknown>,
  score: number | null
): string {
  const lines = questions.map((q) => {
    const a = answers[q.id];
    const val =
      Array.isArray(a) ? a.join(", ") : a === undefined || a === "" || a === null ? "—" : String(a);
    return `${q.label}\n  → ${val}`;
  });
  if (score !== null) lines.unshift(`Score: ${score}`);
  return lines.join("\n\n");
}

/**
 * Record a public submission. Computes the primary score (first NPS or rating)
 * and comment, marks the response complete, and drops a note on the contact's
 * timeline so feedback lives where the rest of the relationship does.
 */
export async function submitResponse(token: string, answers: Record<string, unknown>) {
  const resp = await prisma.surveyResponse.findUnique({
    where: { token },
    include: { survey: true },
  });
  if (!resp || !resp.survey) return { ok: false as const, error: "not_found" as const };
  if (resp.status === "completed")
    return { ok: false as const, error: "done" as const, survey: resp.survey };

  const questions = (resp.survey.questions as unknown as SurveyQuestion[]) ?? [];
  let score: number | null = null;
  let comment: string | null = null;
  for (const q of questions) {
    const a = answers[q.id];
    if (score === null && (q.type === "nps" || q.type === "rating") && typeof a === "number") {
      score = a;
    }
    if (comment === null && q.type === "text" && typeof a === "string" && a.trim()) {
      comment = a.trim();
    }
  }

  await prisma.surveyResponse.update({
    where: { id: resp.id },
    data: {
      answers: answers as object,
      score,
      comment,
      status: "completed",
      completedAt: new Date(),
    },
  });

  if (resp.contactId) {
    const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (firstUser) {
      await prisma.communication.create({
        data: {
          type: "note",
          direction: "inbound",
          subject: `Survey response: ${resp.survey.title}`,
          body: summarise(questions, answers, score),
          contactId: resp.contactId,
          userId: firstUser.id,
        },
      });
    }
  }

  await logAudit({
    action: "survey.completed",
    summary: `Survey completed: ${resp.survey.title}${score !== null ? ` — score ${score}` : ""}`,
    contactId: resp.contactId ?? undefined,
    userName: "Customer",
  });

  return { ok: true as const, survey: resp.survey };
}
