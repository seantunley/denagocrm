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
-- Bucketed by survey + EFFECTIVE version + channel + purpose + EXACT
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
--
-- effectiveVersion = COALESCE(r."surveyVersion", s."publishedVersion") is a
-- FIRST-CLASS bucket dimension. A single response carries the version it was
-- actually invited against (surveyVersion), defaulting to the survey's current
-- publishedVersion only when it never carried one. Two responses that share the
-- same survey/channel/purpose/time but were pinned to DIFFERENT versions (e.g.
-- one to v1, one defaulting to today's v3) must NOT collapse into one
-- distribution: a distribution's surveyVersion metadata has to match the
-- version every response inside it is pinned to, or the reconstructed send
-- would advertise the wrong questionnaire snapshot. So effectiveVersion is part
-- of the GROUP BY and of the deterministic distribution id (below), and the
-- distribution's own surveyVersion is set to that effectiveVersion — never to a
-- possibly-newer publishedVersion.
--
-- A response is only reconciled when a frozen SurveyVersion snapshot actually
-- exists for its effectiveVersion (matched within the same tenant). Responses
-- pinned to a version that was never snapshotted are left untouched here and
-- flagged 'legacy_migration_version_unavailable' below, rather than being
-- silently bucketed under a version whose questions can no longer be
-- reconstructed.
INSERT INTO "SurveyDistribution" (
  "id", "tenantId", "surveyId", "surveyVersion", "name", "purpose", "channel", "status",
  "audienceSnapshot", "scheduledFor", "reminderAfterHours", "maxReminders", "totalCount",
  "createdById", "createdAt", "updatedAt"
)
SELECT
  'sd_legacy_' || md5(g."surveyId" || '|' || g."channel" || '|' || g."purpose" || '|' || g."scheduleKey" || '|' || g."effectiveVersion"::text),
  g."tenantId",
  g."surveyId",
  g."effectiveVersion",
  g."title" || ' · legacy scheduled reconciliation (' || g."channel" || ', v' || g."effectiveVersion"::text || ', ' || g."scheduleKey" || ')',
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
    s."title",
    COALESCE(r."channel", 'any') AS "channel",
    -- Mirrors surveyDistributions.ts's createDistribution: nps/adhoc surveys
    -- are governed as marketing, csat/sales as transactional.
    CASE WHEN s."type" IN ('nps', 'adhoc') THEN 'survey_marketing' ELSE 'survey_transactional' END AS "purpose",
    -- Stable per-exact-time bucket key. Sentinel for NULL so both passes agree.
    COALESCE(r."scheduledFor"::text, 'immediate') AS "scheduleKey",
    -- The version this response is pinned to, defaulting to the survey's current
    -- publishedVersion. Drives both the bucket and the distribution's own
    -- surveyVersion so metadata always matches the responses inside it.
    COALESCE(r."surveyVersion", s."publishedVersion") AS "effectiveVersion"
  FROM "SurveyResponse" r
  JOIN "Survey" s ON s."id" = r."surveyId"
  WHERE r."status" = 'scheduled'
    AND r."distributionId" IS NULL
    AND s."status" = 'published'
    AND s."publishedVersion" IS NOT NULL
    AND s."deletedAt" IS NULL
    -- Only reconcile when a frozen snapshot exists for the effective version.
    AND EXISTS (
      SELECT 1 FROM "SurveyVersion" v
      WHERE v."surveyId" = s."id"
        AND v."version" = COALESCE(r."surveyVersion", s."publishedVersion")
        AND v."tenantId" IS NOT DISTINCT FROM s."tenantId"
    )
) g
GROUP BY g."surveyId", g."tenantId", g."title", g."channel", g."purpose", g."scheduleKey", g."effectiveVersion"
ON CONFLICT DO NOTHING;

-- Point every migratable orphaned response at its bucket's new distribution,
-- preserving contact, channel and — crucially — its ORIGINAL surveyVersion.
-- Only fill surveyVersion from the survey's current publishedVersion when the
-- response never carried one: overwriting a response that was scheduled against
-- an earlier published version would re-pin it to today's (possibly
-- re-published, different) questions. COALESCE preserves the version the
-- recipient was actually invited against wherever it exists. The distribution
-- id embeds that same effectiveVersion, so a response always lands in the
-- distribution whose surveyVersion matches the version it is pinned to. The
-- EXISTS guard mirrors the INSERT so only responses whose effectiveVersion was
-- actually snapshotted are queued here; the rest fall through to the
-- version-unavailable flag below.
UPDATE "SurveyResponse" r
SET "distributionId" = d."id",
    "surveyVersion" = COALESCE(r."surveyVersion", s."publishedVersion"),
    "status" = 'queued'
FROM "Survey" s, "SurveyDistribution" d
WHERE r."surveyId" = s."id"
  AND d."id" = 'sd_legacy_' || md5(
    s."id" || '|' || COALESCE(r."channel", 'any') || '|' ||
    (CASE WHEN s."type" IN ('nps', 'adhoc') THEN 'survey_marketing' ELSE 'survey_transactional' END) || '|' ||
    COALESCE(r."scheduledFor"::text, 'immediate') || '|' ||
    COALESCE(r."surveyVersion", s."publishedVersion")::text
  )
  AND r."status" = 'scheduled'
  AND r."distributionId" IS NULL
  AND s."status" = 'published'
  AND s."publishedVersion" IS NOT NULL
  AND s."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "SurveyVersion" v
    WHERE v."surveyId" = s."id"
      AND v."version" = COALESCE(r."surveyVersion", s."publishedVersion")
      AND v."tenantId" IS NOT DISTINCT FROM s."tenantId"
  );

-- Responses whose survey IS published but whose effectiveVersion has no frozen
-- SurveyVersion snapshot cannot be safely bucketed (the exact questionnaire the
-- recipient was invited against no longer exists to reconstruct). Surface them
-- distinctly for manual review instead of silently mis-bucketing them under a
-- newer version. Run BEFORE the generic flag below so this more specific reason
-- wins for these rows.
UPDATE "SurveyResponse" r
SET "providerStatus" = 'legacy_migration_version_unavailable'
FROM "Survey" s
WHERE r."surveyId" = s."id"
  AND r."status" = 'scheduled'
  AND r."distributionId" IS NULL
  AND s."status" = 'published'
  AND s."publishedVersion" IS NOT NULL
  AND s."deletedAt" IS NULL
  AND r."providerStatus" IS DISTINCT FROM 'legacy_migration_version_unavailable'
  AND NOT EXISTS (
    SELECT 1 FROM "SurveyVersion" v
    WHERE v."surveyId" = s."id"
      AND v."version" = COALESCE(r."surveyVersion", s."publishedVersion")
      AND v."tenantId" IS NOT DISTINCT FROM s."tenantId"
  );

-- Anything still status='scheduled' with no distributionId belongs to a
-- survey that isn't currently published (no version to safely pin the
-- response to) — cannot be safely auto-migrated. Flag it distinctly instead
-- of silently leaving it indistinguishable from a normal legacy row, so it
-- surfaces for manual review. Rows already flagged with the more specific
-- version-unavailable reason above are left as-is.
UPDATE "SurveyResponse"
SET "providerStatus" = 'legacy_migration_needs_manual_review'
WHERE "status" = 'scheduled'
  AND "distributionId" IS NULL
  AND "providerStatus" IS DISTINCT FROM 'legacy_migration_needs_manual_review'
  AND "providerStatus" IS DISTINCT FROM 'legacy_migration_version_unavailable';
