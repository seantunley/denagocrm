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

type Recipient = { name: string | null; email: string | null; phone: string | null; optOut: boolean };

async function resolveRecipient(target: SurveyTarget): Promise<Recipient> {
  let name = target.name ?? null;
  let email = target.email ?? null;
  let phone = target.phone ?? null;
  let optOut = false;
  if (target.contactId) {
    const c = await prisma.contact.findUnique({ where: { id: target.contactId } });
    if (c) {
      email = email ?? c.email;
      phone = phone ?? c.phone;
      name = name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");
      optOut = c.marketingOptOut;
    }
  }
  return { name, email, phone, optOut };
}

/** True if this contact was already surveyed with this type in the last 30 days. */
async function recentlySurveyed(contactId: string, type: string): Promise<boolean> {
  const recent = await prisma.surveyResponse.findFirst({
    where: {
      contactId,
      status: { not: "failed" },
      survey: { type },
      sentAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
  });
  return Boolean(recent);
}

/** Compose + deliver an existing invite row. Returns the channel used, or null. */
async function deliverInvite(
  resp: { id: string; token: string; contactId: string | null },
  survey: SurveyLite,
  r: { name: string | null; email: string | null; phone: string | null }
): Promise<"email" | "sms" | null> {
  const link = surveyUrl(resp.token);
  const first = (r.name ?? "there").split(/\s+/)[0] || "there";
  const intro = survey.intro || defaultIntro(survey.type as SurveyType);

  let channel: "email" | "sms" | null = null;
  if (r.email) {
    const res = await sendEmail({
      to: r.email,
      subject: subjectFor(survey.type as SurveyType, survey.title),
      text: `Hi ${first},\n\n${intro}\n\nTap here to answer (it takes under a minute):\n${link}\n\nThank you,\nDenago Cape Town`,
    });
    if (res.ok) channel = "email";
  } else if (r.phone) {
    const res = await sendSms(r.phone, `Hi ${first}, ${intro} ${link}`);
    if (res.ok) channel = "sms";
  }
  if (!channel) return null;

  if (resp.contactId) {
    const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (firstUser) {
      await prisma.communication.create({
        data: {
          type: channel,
          direction: "outbound",
          subject: `Survey sent: ${survey.title}`,
          body: `"${survey.title}" survey invitation sent via ${channel}.`,
          contactId: resp.contactId,
          userId: firstUser.id,
        },
      });
    }
  }
  await logAudit({
    action: "survey.sent",
    summary: `Sent "${survey.title}" survey to ${r.name ?? r.email ?? r.phone}`,
    contactId: resp.contactId ?? undefined,
    userName: "System",
  });
  return channel;
}

/**
 * Send one survey invite to a recipient immediately. Best-effort and
 * self-throttling: one survey of a given type per contact per 30 days, and
 * NPS/ad-hoc respect the marketing opt-out (CSAT/sales are transactional).
 * Returns true only when the invite was actually delivered.
 */
export async function sendSurvey(survey: SurveyLite, target: SurveyTarget): Promise<boolean> {
  const contactId = target.contactId ?? null;
  const { name, email, phone, optOut } = await resolveRecipient(target);
  if (optOut && (survey.type === "nps" || survey.type === "adhoc")) return false;
  if (!email && !phone) return false;
  if (contactId && (await recentlySurveyed(contactId, survey.type))) return false;

  const resp = await prisma.surveyResponse.create({
    data: {
      surveyId: survey.id,
      contactId,
      leadId: target.leadId ?? null,
      jobCardId: target.jobCardId ?? null,
      name: name ?? null,
      channel: email ? "email" : "sms",
    },
  });
  const channel = await deliverInvite(resp, survey, { name, email, phone });
  await prisma.surveyResponse.update({
    where: { id: resp.id },
    data: { status: channel ? "sent" : "failed", channel: channel ?? undefined },
  });
  return Boolean(channel);
}

/**
 * Schedule a survey for later (delayHours after the trigger). Applies the
 * opt-out + 30-day throttle now so we don't queue invites we'd skip, then
 * drops a "scheduled" row that the cron queue dispatches when due.
 */
export async function scheduleSurvey(
  survey: SurveyLite & { delayHours: number },
  target: SurveyTarget
): Promise<boolean> {
  const contactId = target.contactId ?? null;
  const { name, email, phone, optOut } = await resolveRecipient(target);
  if (optOut && (survey.type === "nps" || survey.type === "adhoc")) return false;
  if (!contactId && !email && !phone) return false;
  if (contactId && (await recentlySurveyed(contactId, survey.type))) return false;

  await prisma.surveyResponse.create({
    data: {
      surveyId: survey.id,
      contactId,
      leadId: target.leadId ?? null,
      jobCardId: target.jobCardId ?? null,
      name: name ?? null,
      status: "scheduled",
      scheduledFor: new Date(Date.now() + Math.max(1, survey.delayHours) * 60 * 60 * 1000),
    },
  });
  return true;
}

/** Dispatch any scheduled survey invites that are now due. Called from cron. */
export async function runSurveyQueue(): Promise<number> {
  const due = await prisma.surveyResponse.findMany({
    where: { status: "scheduled", scheduledFor: { lte: new Date() } },
    include: { survey: true },
    take: 200,
  });
  let sent = 0;
  for (const r of due) {
    if (!r.survey || r.survey.deletedAt || !r.survey.active) {
      await prisma.surveyResponse.update({ where: { id: r.id }, data: { status: "failed" } });
      continue;
    }
    const rec = await resolveRecipient({ contactId: r.contactId, name: r.name });
    const channel =
      rec.email || rec.phone
        ? await deliverInvite(r, r.survey, { name: rec.name, email: rec.email, phone: rec.phone })
        : null;
    await prisma.surveyResponse.update({
      where: { id: r.id },
      data: { status: channel ? "sent" : "failed", channel: channel ?? undefined, sentAt: new Date() },
    });
    if (channel) sent += 1;
  }
  return sent;
}

/** Fire the active survey wired to `trigger` (if any). Never throws. */
export async function triggerSurvey(trigger: string, target: SurveyTarget): Promise<void> {
  try {
    const survey = await prisma.survey.findFirst({
      where: { active: true, trigger },
      orderBy: { createdAt: "desc" },
    });
    if (!survey) return;
    if ((survey.delayHours ?? 0) > 0) {
      await scheduleSurvey({ ...survey, delayHours: survey.delayHours }, target);
    } else {
      await sendSurvey(survey, target);
    }
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
