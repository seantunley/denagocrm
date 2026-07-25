-- Reconcile legacy scheduled SurveyResponse rows (status='scheduled', no
-- distributionId) that predate the SurveyDistribution model. runSurveyQueue,
-- the dispatcher that used to process them, is now a permanent no-op (see
-- src/lib/surveys.ts: "The legacy survey queue is retired; the tenant cron
-- runs SurveyDistribution") — any row left in this shape would otherwise sit
-- forever, silently never sent, since the new queue only ever joins through
-- SurveyDistribution.
--
-- Every step is idempotent (deterministic ids + WHERE ... IS NULL guards), so
-- re-running this migration is always safe.

-- One distribution per survey that has orphaned legacy rows AND a valid
-- published version to pin them to. Bucketed at the survey level because
-- SurveyDistribution is the unit of scheduling in the new model — there is no
-- per-recipient scheduledFor once a response is "queued", so the earliest of
-- the group's original scheduledFor times becomes the bucket's activation
-- gate. This can send an individually-later-scheduled legacy invite a bit
-- earlier than its original delay; that is preferable to the alternative
-- (never sending it at all).
INSERT INTO "SurveyDistribution" (
  "id", "tenantId", "surveyId", "surveyVersion", "name", "purpose", "channel", "status",
  "audienceSnapshot", "scheduledFor", "reminderAfterHours", "maxReminders", "totalCount",
  "createdById", "createdAt", "updatedAt"
)
SELECT
  'sd_legacy_' || md5(s."id"),
  s."tenantId",
  s."id",
  s."publishedVersion",
  s."title" || ' · legacy scheduled reconciliation',
  'survey_transactional',
  'any',
  CASE WHEN MIN(r."scheduledFor") <= CURRENT_TIMESTAMP THEN 'queued' ELSE 'scheduled' END,
  jsonb_build_object('source', 'legacy_scheduled_reconciliation', 'reconciledCount', COUNT(*)),
  MIN(r."scheduledFor"),
  48,
  1,
  COUNT(*),
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "SurveyResponse" r
JOIN "Survey" s ON s."id" = r."surveyId"
WHERE r."status" = 'scheduled'
  AND r."distributionId" IS NULL
  AND s."status" = 'published'
  AND s."publishedVersion" IS NOT NULL
  AND s."deletedAt" IS NULL
GROUP BY s."id", s."tenantId", s."publishedVersion", s."title"
ON CONFLICT DO NOTHING;

-- Point every migratable orphaned response at its new distribution,
-- preserving token, contact, channel and pinning it to the survey's current
-- published version so it renders the same questions it was originally sent
-- against as closely as the historical record allows.
UPDATE "SurveyResponse" r
SET "distributionId" = d."id",
    "surveyVersion" = s."publishedVersion",
    "status" = 'queued'
FROM "Survey" s, "SurveyDistribution" d
WHERE r."surveyId" = s."id"
  AND d."id" = 'sd_legacy_' || md5(s."id")
  AND r."status" = 'scheduled'
  AND r."distributionId" IS NULL
  AND s."status" = 'published'
  AND s."publishedVersion" IS NOT NULL
  AND s."deletedAt" IS NULL;

-- Anything still status='scheduled' with no distributionId belongs to a
-- survey that isn't currently published (no version to safely pin the
-- response to) — cannot be safely auto-migrated. Flag it distinctly instead
-- of silently leaving it indistinguishable from a normal legacy row, so it
-- surfaces for manual review.
UPDATE "SurveyResponse"
SET "providerStatus" = 'legacy_migration_needs_manual_review'
WHERE "status" = 'scheduled'
  AND "distributionId" IS NULL
  AND "providerStatus" IS DISTINCT FROM 'legacy_migration_needs_manual_review';
