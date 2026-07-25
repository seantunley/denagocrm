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
--
-- Bucketed by survey + published version + channel + purpose + EXACT
-- scheduledFor — deliberately NOT day-sized and NOT one-per-survey. A coarser
-- bucket (earlier reviews used the survey, or a calendar day) would send a
-- recipient scheduled later in the window as soon as the earliest recipient in
-- that bucket became due — up to a day early. Grouping on the exact
-- scheduledFor means every response in a bucket shares one identical send time,
-- so the reconstructed distribution fires at precisely each recipient's
-- original scheduled moment. It also preserves each row's original channel and
-- the survey's governed purpose (nps/adhoc = marketing, else transactional) so
-- an old marketing/research survey isn't silently reclassified as transactional
-- and made to bypass that policy's stricter consent/suppression rules. NULL
-- scheduledFor (send-immediately) rows share a single stable 'immediate' bucket
-- (a literal sentinel, NOT CURRENT_TIMESTAMP, so the INSERT and UPDATE passes
-- below compute the same deterministic id).
INSERT INTO "SurveyDistribution" (
  "id", "tenantId", "surveyId", "surveyVersion", "name", "purpose", "channel", "status",
  "audienceSnapshot", "scheduledFor", "reminderAfterHours", "maxReminders", "totalCount",
  "createdById", "createdAt", "updatedAt"
)
SELECT
  'sd_legacy_' || md5(g."surveyId" || '|' || g."channel" || '|' || g."purpose" || '|' || g."scheduleKey"),
  g."tenantId",
  g."surveyId",
  g."publishedVersion",
  g."title" || ' · legacy scheduled reconciliation (' || g."channel" || ', ' || g."scheduleKey" || ')',
  g."purpose",
  g."channel",
  CASE WHEN MIN(g."scheduledFor") IS NULL OR MIN(g."scheduledFor") <= CURRENT_TIMESTAMP THEN 'queued' ELSE 'scheduled' END,
  jsonb_build_object('source', 'legacy_scheduled_reconciliation', 'reconciledCount', COUNT(*)),
  MIN(g."scheduledFor"),
  48,
  1,
  COUNT(*),
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT
    r."id",
    r."scheduledFor",
    s."id" AS "surveyId",
    s."tenantId",
    s."publishedVersion",
    s."title",
    COALESCE(r."channel", 'any') AS "channel",
    -- Mirrors surveyDistributions.ts's createDistribution: nps/adhoc surveys
    -- are governed as marketing, csat/sales as transactional.
    CASE WHEN s."type" IN ('nps', 'adhoc') THEN 'survey_marketing' ELSE 'survey_transactional' END AS "purpose",
    -- Stable per-exact-time bucket key. Sentinel for NULL so both passes agree.
    COALESCE(r."scheduledFor"::text, 'immediate') AS "scheduleKey"
  FROM "SurveyResponse" r
  JOIN "Survey" s ON s."id" = r."surveyId"
  WHERE r."status" = 'scheduled'
    AND r."distributionId" IS NULL
    AND s."status" = 'published'
    AND s."publishedVersion" IS NOT NULL
    AND s."deletedAt" IS NULL
) g
GROUP BY g."surveyId", g."tenantId", g."publishedVersion", g."title", g."channel", g."purpose", g."scheduleKey"
ON CONFLICT DO NOTHING;

-- Point every migratable orphaned response at its bucket's new distribution,
-- preserving contact, channel and — crucially — its ORIGINAL surveyVersion.
-- Only fill surveyVersion from the survey's current publishedVersion when the
-- response never carried one: overwriting a response that was scheduled against
-- an earlier published version would re-pin it to today's (possibly
-- re-published, different) questions. COALESCE preserves the version the
-- recipient was actually invited against wherever it exists.
UPDATE "SurveyResponse" r
SET "distributionId" = d."id",
    "surveyVersion" = COALESCE(r."surveyVersion", s."publishedVersion"),
    "status" = 'queued'
FROM "Survey" s, "SurveyDistribution" d
WHERE r."surveyId" = s."id"
  AND d."id" = 'sd_legacy_' || md5(
    s."id" || '|' || COALESCE(r."channel", 'any') || '|' ||
    (CASE WHEN s."type" IN ('nps', 'adhoc') THEN 'survey_marketing' ELSE 'survey_transactional' END) || '|' ||
    COALESCE(r."scheduledFor"::text, 'immediate')
  )
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
