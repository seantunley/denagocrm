import crypto from "node:crypto";
import { basePrisma } from "./db";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { canContactPerson, classifyRetry, type CommunicationChannel, type CommunicationPurpose } from "./communicationPolicy";
import { currentTenantScope } from "./tenantScopeEntry";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");
const BATCH_SIZE = 75;
const STALE_MINUTES = 15;

export type SurveyDistributionStatus = "draft" | "scheduled" | "queued" | "sending" | "paused" | "cancelled" | "completed" | "completed_with_errors";

type SurveySnapshot = {
  title: string;
  type: string;
  intro?: string | null;
  thankYou?: string | null;
  questions: unknown[];
  trigger?: string | null;
  delayHours?: number;
};

type ClaimedInvite = {
  id: string;
  tenantId: string | null;
  distributionId: string;
  surveyId: string;
  surveyVersion: number;
  contactId: string | null;
  token: string;
  name: string | null;
  attemptCount: number;
  reminderCount: number;
  maxReminders: number;
  distributionChannel: string;
  purpose: string;
  snapshot: SurveySnapshot;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
};

function activeTenantId() {
  const scope = currentTenantScope();
  if (!scope || scope.system) throw new Error("Survey distribution queue requires a tenant scope");
  return scope.tenantId;
}

function channelFor(invite: ClaimedInvite): CommunicationChannel | null {
  if (invite.distributionChannel === "email") return invite.email ? "email" : null;
  if (invite.distributionChannel === "sms") return invite.phone || invite.whatsapp ? "sms" : null;
  if (invite.email) return "email";
  if (invite.phone || invite.whatsapp) return "sms";
  return null;
}

function purposeFor(value: string): CommunicationPurpose {
  return value === "survey_marketing" ? "survey_marketing" : "survey_transactional";
}

function inviteText(snapshot: SurveySnapshot, name: string | null, token: string, reminder = false) {
  const first = (name || "there").split(/\s+/)[0] || "there";
  const lead = reminder ? "A quick reminder" : "We would value your feedback";
  return `Hi ${first},\n\n${lead}: ${snapshot.intro || snapshot.title}\n\n${APP_URL}/s/${token}\n\nThank you,\nDenago Cape Town`;
}

export async function createSurveyDistribution(args: {
  tenantId: string | null;
  userId: string;
  surveyId: string;
  name: string;
  purpose: "survey_marketing" | "survey_transactional";
  channel: "any" | "email" | "sms";
  contactIds: string[];
  audienceSnapshot: Record<string, unknown>;
  scheduledFor?: Date | null;
  reminderAfterHours?: number;
  maxReminders?: number;
}) {
  const contacts = [...new Set(args.contactIds)].slice(0, 5000);
  if (contacts.length === 0) throw new Error("The selected audience contains no contacts");

  return basePrisma.$transaction(async (tx) => {
    const surveys = await tx.$queryRaw<Array<{ id: string; title: string; status: string; active: boolean; publishedVersion: number | null }>>`
      SELECT "id", "title", "status", "active", "publishedVersion"
      FROM "Survey"
      WHERE "id" = ${args.surveyId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "deletedAt" IS NULL
      FOR SHARE
    `;
    const survey = surveys[0];
    if (!survey || survey.status !== "published" || !survey.active || !survey.publishedVersion) {
      throw new Error("Only an active published survey version can be distributed");
    }

    const eligible = await tx.$queryRaw<Array<{ id: string; firstName: string; lastName: string | null }>>`
      SELECT "id", "firstName", "lastName"
      FROM "Contact"
      WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "deletedAt" IS NULL
        AND "id" = ANY(${contacts}::text[])
    `;
    if (eligible.length === 0) throw new Error("No accessible contacts remain in the selected audience");

    const id = `sd_${crypto.randomUUID()}`;
    const scheduled = Boolean(args.scheduledFor && args.scheduledFor.getTime() > Date.now());
    await tx.$executeRaw`
      INSERT INTO "SurveyDistribution" (
        "id", "tenantId", "surveyId", "surveyVersion", "name", "purpose", "channel", "status",
        "audienceSnapshot", "scheduledFor", "reminderAfterHours", "maxReminders", "totalCount",
        "createdById", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${args.tenantId}, ${args.surveyId}, ${survey.publishedVersion},
        ${args.name.trim() || `${survey.title} distribution`}, ${args.purpose}, ${args.channel},
        ${scheduled ? "scheduled" : "queued"}, ${JSON.stringify(args.audienceSnapshot)}::jsonb,
        ${args.scheduledFor ?? null}, ${Math.max(1, Math.round(args.reminderAfterHours ?? 48))},
        ${Math.max(0, Math.min(3, Math.round(args.maxReminders ?? 1)))}, ${eligible.length},
        ${args.userId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;

    for (const contact of eligible) {
      const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
      await tx.$executeRaw`
        INSERT INTO "SurveyResponse" (
          "id", "tenantId", "surveyId", "surveyVersion", "distributionId", "contactId", "name",
          "status", "scheduledFor", "token", "attemptCount", "reminderCount"
        ) VALUES (
          ${`sr_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.surveyId}, ${survey.publishedVersion},
          ${id}, ${contact.id}, ${fullName}, 'queued', ${args.scheduledFor ?? null},
          ${crypto.randomBytes(24).toString("hex")}, 0, 0
        )
        ON CONFLICT DO NOTHING
      `;
    }
    return id;
  });
}

async function activateDueDistributions(tid: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "SurveyDistribution"
    SET "status" = 'queued', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" IS NOT DISTINCT FROM ${tid}
      AND "status" = 'scheduled'
      AND "scheduledFor" <= CURRENT_TIMESTAMP
  `;
}

async function recoverStaleClaims(tid: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "SurveyResponse" r
    SET "status" = 'failed_temporary', "nextAttemptAt" = CURRENT_TIMESTAMP, "providerStatus" = 'stale_claim_recovered'
    FROM "SurveyDistribution" d
    WHERE r."distributionId" = d."id"
      AND r."tenantId" IS NOT DISTINCT FROM ${tid}
      AND d."tenantId" IS NOT DISTINCT FROM ${tid}
      AND r."status" = 'sending'
      AND r."lastAttemptAt" < CURRENT_TIMESTAMP - (${STALE_MINUTES} * INTERVAL '1 minute')
      AND d."status" IN ('queued', 'sending')
  `;
}

async function claimBatch(tid: string | null, limit: number): Promise<ClaimedInvite[]> {
  return basePrisma.$queryRaw<ClaimedInvite[]>`
    WITH candidates AS (
      SELECT r."id"
      FROM "SurveyResponse" r
      JOIN "SurveyDistribution" d ON d."id" = r."distributionId"
      WHERE r."tenantId" IS NOT DISTINCT FROM ${tid}
        AND d."tenantId" IS NOT DISTINCT FROM ${tid}
        AND r."status" IN ('queued', 'failed_temporary')
        AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= CURRENT_TIMESTAMP)
        AND d."status" IN ('queued', 'sending')
      ORDER BY d."createdAt", r."id"
      FOR UPDATE OF r SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "SurveyResponse" r
      SET "status" = 'sending', "attemptCount" = r."attemptCount" + 1,
        "lastAttemptAt" = CURRENT_TIMESTAMP, "nextAttemptAt" = NULL
      FROM candidates c
      WHERE r."id" = c."id"
      RETURNING r.*
    )
    SELECT r."id", r."tenantId", r."distributionId", r."surveyId", r."surveyVersion",
      r."contactId", r."token", r."name", r."attemptCount", r."reminderCount",
      d."maxReminders", d."channel" AS "distributionChannel", d."purpose", v."snapshot",
      c."email", c."phone", c."whatsapp"
    FROM claimed r
    JOIN "SurveyDistribution" d ON d."id" = r."distributionId"
    JOIN "SurveyVersion" v ON v."surveyId" = r."surveyId" AND v."version" = r."surveyVersion"
      AND v."tenantId" IS NOT DISTINCT FROM ${tid}
    LEFT JOIN "Contact" c ON c."id" = r."contactId" AND c."tenantId" IS NOT DISTINCT FROM ${tid}
  `;
}

async function suppress(invite: ClaimedInvite, reason: string) {
  await basePrisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "SurveyResponse"
      SET "status" = 'suppressed', "suppressionReason" = ${reason}, "providerStatus" = 'suppressed'
      WHERE "id" = ${invite.id}
        AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
        AND "status" = 'sending'
    `;
    if (changed === 1) {
      await tx.$executeRaw`
        UPDATE "SurveyDistribution"
        SET "suppressedCount" = "suppressedCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${invite.distributionId} AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
      `;
    }
  });
}

async function restoreClaimForClosedDistribution(invite: ClaimedInvite, state: string | undefined) {
  const next = state === "paused" ? "queued" : "cancelled";
  await basePrisma.$executeRaw`
    UPDATE "SurveyResponse"
    SET "status" = ${next}, "providerStatus" = ${state ? `distribution_${state}` : "distribution_missing"}
    WHERE "id" = ${invite.id}
      AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
      AND "status" = 'sending'
  `;
}

async function deliver(invite: ClaimedInvite) {
  const distributions = await basePrisma.$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "SurveyDistribution"
    WHERE "id" = ${invite.distributionId}
      AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
    LIMIT 1
  `;
  const state = distributions[0]?.status;
  if (!state || !new Set(["queued", "sending"]).has(state)) {
    await restoreClaimForClosedDistribution(invite, state);
    return;
  }

  const requested = channelFor(invite);
  if (!requested || !invite.contactId) {
    await suppress(invite, requested ? "contact_missing" : "destination_missing");
    return;
  }
  const eligibility = await canContactPerson({
    contactId: invite.contactId,
    tenantId: invite.tenantId,
    purpose: purposeFor(invite.purpose),
    requestedChannel: requested,
    distributionId: invite.distributionId,
  });
  if (!eligibility.allowed || !eligibility.destination) {
    await suppress(invite, eligibility.reason || "policy_blocked");
    return;
  }

  const text = inviteText(invite.snapshot, invite.name, invite.token);
  const result = requested === "email"
    ? await sendEmail({ to: eligibility.destination, subject: invite.snapshot.title, text })
    : await sendSms(eligibility.destination, text);

  if (result.ok) {
    await basePrisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE "SurveyResponse"
        SET "status" = 'sent', "channel" = ${requested}, "inviteSentAt" = CURRENT_TIMESTAMP,
          "sentAt" = CURRENT_TIMESTAMP, "providerStatus" = 'accepted', "nextAttemptAt" = NULL
        WHERE "id" = ${invite.id}
          AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
          AND "status" = 'sending'
      `;
      if (changed === 1) {
        await tx.$executeRaw`
          UPDATE "SurveyDistribution"
          SET "sentCount" = "sentCount" + 1,
            "status" = CASE WHEN "status" = 'queued' THEN 'sending' ELSE "status" END,
            "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${invite.distributionId}
            AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
            AND "status" IN ('queued', 'sending')
        `;
      }
    });
    return;
  }

  const status = classifyRetry(invite.attemptCount);
  const delayMinutes = invite.attemptCount <= 1 ? 5 : 30;
  await basePrisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "SurveyResponse"
      SET "status" = ${status}, "providerStatus" = 'failed',
        "nextAttemptAt" = CASE WHEN ${status} = 'failed_temporary' THEN CURRENT_TIMESTAMP + (${delayMinutes} * INTERVAL '1 minute') ELSE NULL END
      WHERE "id" = ${invite.id}
        AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
        AND "status" = 'sending'
    `;
    if (changed === 1 && status === "failed_permanent") {
      await tx.$executeRaw`
        UPDATE "SurveyDistribution" SET "failedCount" = "failedCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${invite.distributionId} AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
      `;
    }
  });
}

const PERMANENT_REMINDER_BLOCKS = new Set([
  "contact_not_found_or_cross_tenant",
  "contact_deleted",
  "marketing_opt_out",
  "consent_withdrawn",
  "missing_email_destination",
  "missing_sms_destination",
]);

async function closeReminderLease(invite: ClaimedInvite, status: string, consumeAll: boolean) {
  await basePrisma.$executeRaw`
    UPDATE "SurveyResponse"
    SET "providerStatus" = ${status},
      "reminderCount" = CASE WHEN ${consumeAll} THEN ${invite.maxReminders} ELSE "reminderCount" END,
      "lastReminderAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${invite.id}
      AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
      AND "providerStatus" = 'reminder_sending'
  `;
}

async function sendDueReminders(tid: string | null, limit = 50) {
  const reminders = await basePrisma.$queryRaw<ClaimedInvite[]>`
    WITH candidates AS (
      SELECT r."id"
      FROM "SurveyResponse" r
      JOIN "SurveyDistribution" d ON d."id" = r."distributionId"
      WHERE r."tenantId" IS NOT DISTINCT FROM ${tid}
        AND d."tenantId" IS NOT DISTINCT FROM ${tid}
        AND r."status" = 'sent'
        AND r."completedAt" IS NULL
        AND r."reminderCount" < d."maxReminders"
        AND r."inviteSentAt" <= CURRENT_TIMESTAMP - (d."reminderAfterHours" * INTERVAL '1 hour')
        AND (r."lastReminderAt" IS NULL OR r."lastReminderAt" <= CURRENT_TIMESTAMP - (d."reminderAfterHours" * INTERVAL '1 hour'))
        AND (r."providerStatus" IS DISTINCT FROM 'reminder_sending' OR r."lastAttemptAt" < CURRENT_TIMESTAMP - (${STALE_MINUTES} * INTERVAL '1 minute'))
        AND d."status" = 'sending'
      ORDER BY r."inviteSentAt", r."id"
      FOR UPDATE OF r SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "SurveyResponse" r
      SET "providerStatus" = 'reminder_sending', "lastAttemptAt" = CURRENT_TIMESTAMP
      FROM candidates c WHERE r."id" = c."id"
      RETURNING r.*
    )
    SELECT r."id", r."tenantId", r."distributionId", r."surveyId", r."surveyVersion",
      r."contactId", r."token", r."name", r."attemptCount", r."reminderCount",
      d."maxReminders", d."channel" AS "distributionChannel", d."purpose", v."snapshot",
      c."email", c."phone", c."whatsapp"
    FROM claimed r
    JOIN "SurveyDistribution" d ON d."id" = r."distributionId"
    JOIN "SurveyVersion" v ON v."surveyId" = r."surveyId" AND v."version" = r."surveyVersion"
      AND v."tenantId" IS NOT DISTINCT FROM ${tid}
    LEFT JOIN "Contact" c ON c."id" = r."contactId" AND c."tenantId" IS NOT DISTINCT FROM ${tid}
  `;

  let sent = 0;
  for (const invite of reminders) {
    const requested = channelFor(invite);
    if (!requested || !invite.contactId) {
      await closeReminderLease(invite, "reminder_destination_missing", true);
      continue;
    }
    const eligibility = await canContactPerson({
      contactId: invite.contactId,
      tenantId: invite.tenantId,
      purpose: purposeFor(invite.purpose),
      requestedChannel: requested,
      distributionId: invite.distributionId,
    });
    if (!eligibility.allowed || !eligibility.destination) {
      const reason = eligibility.reason || "policy_blocked";
      await closeReminderLease(invite, `reminder_${reason}`, PERMANENT_REMINDER_BLOCKS.has(reason));
      continue;
    }
    const text = inviteText(invite.snapshot, invite.name, invite.token, true);
    const result = requested === "email"
      ? await sendEmail({ to: eligibility.destination, subject: `Reminder: ${invite.snapshot.title}`, text })
      : await sendSms(eligibility.destination, text);
    await basePrisma.$executeRaw`
      UPDATE "SurveyResponse"
      SET "providerStatus" = ${result.ok ? "reminder_sent" : "reminder_failed"},
        "reminderCount" = "reminderCount" + CASE WHEN ${result.ok} THEN 1 ELSE 0 END,
        "lastReminderAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${invite.id}
        AND "tenantId" IS NOT DISTINCT FROM ${invite.tenantId}
        AND "providerStatus" = 'reminder_sending'
    `;
    if (result.ok) sent += 1;
  }
  return sent;
}

async function finalise(tid: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "SurveyDistribution" d
    SET "status" = CASE WHEN d."failedCount" > 0 OR d."suppressedCount" > 0 THEN 'completed_with_errors' ELSE 'completed' END,
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE d."tenantId" IS NOT DISTINCT FROM ${tid}
      AND d."status" = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM "SurveyResponse" r
        WHERE r."distributionId" = d."id"
          AND r."tenantId" IS NOT DISTINCT FROM ${tid}
          AND r."status" IN ('queued', 'sending', 'failed_temporary')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "SurveyResponse" r
        WHERE r."distributionId" = d."id"
          AND r."tenantId" IS NOT DISTINCT FROM ${tid}
          AND r."status" = 'sent'
          AND r."completedAt" IS NULL
          AND r."reminderCount" < d."maxReminders"
      )
  `;
}

export async function runSafeSurveyDistributionQueue(maxTotal = 200) {
  const tid = activeTenantId();
  await activateDueDistributions(tid);
  await recoverStaleClaims(tid);
  let processed = 0;
  while (processed < maxTotal) {
    const batch = await claimBatch(tid, Math.min(BATCH_SIZE, maxTotal - processed));
    if (batch.length === 0) break;
    for (const invite of batch) await deliver(invite);
    processed += batch.length;
  }
  const reminders = await sendDueReminders(tid);
  await finalise(tid);
  return { processed, reminders };
}
