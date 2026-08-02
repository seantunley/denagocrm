-- Retire the AutomationRule engine and the hardcoded lifecycleJourneys, leaving
-- the Journey engine as the ONE answer to "when X happens to a lead, send an
-- email / create an activity / move a stage".
--
-- Three engines did that job. AutomationRule (src/lib/automations.ts, the
-- /automations builder) and lifecycleJourneys (src/lib/lifecycleJourneys.ts,
-- hardcoded anniversary + win-back copy behind two AppSettings) are gone from
-- the codebase in the same change as this migration. Their CONFIGURATION is not
-- gone: this converts it into Journey/JourneyVersion rows so nobody loses a rule
-- they had set up, and no tenant loses their anniversary emails.
--
-- Every step is idempotent — deterministic ids and ON CONFLICT DO NOTHING — so
-- re-running is safe.

-- Journey, JourneyVersion and JourneyEvent are all FORCE ROW LEVEL SECURITY
-- (20260727130000_rls_enforce). FORCE applies to the table owner too, so a
-- migration inserting rows for many tenants would insert NOTHING without this:
-- the policy's own escape hatch, the same one basePrisma uses.
SET app.bypass_rls = 'on';

-- ---------------------------------------------------------------------------
-- 1. AutomationRule → Journey + JourneyVersion
-- ---------------------------------------------------------------------------
-- Every AutomationRule trigger is also a Journey trigger under the same name,
-- and every action is a Journey step type under the same name, so the mapping
-- is one rule → one journey with a single step. A rule carrying a trigger or an
-- action outside those sets cannot be represented as a runnable step; it is
-- NOT dropped — it becomes a paused journey whose description holds the whole
-- original row, so it is reviewable by hand and can never fire on its own.

CREATE TEMPORARY TABLE "_rule_convert" AS
SELECT
  r."id",
  r."tenantId",
  r."name",
  r."active",
  r."trigger",
  r."action",
  r."createdAt",
  (r."trigger" IN (
      'lead_created','stage_entered','lead_won','lead_lost',
      'quote_signed','quote_declined','delivered','referral_earned','lead_idle')
   AND r."action" IN (
      'create_activity','send_email','move_stage','assign_user','send_push')
  ) AS convertible,
  -- Trigger configuration. Only two triggers take any.
  CASE r."trigger"
    WHEN 'stage_entered' THEN jsonb_build_object('stageId', r."triggerStageId")
    WHEN 'lead_idle'     THEN jsonb_build_object('idleDays', COALESCE(r."idleDays", 3))
    ELSE '{}'::jsonb
  END AS trigger_config,
  -- conditionSources / minValueCents were the rule's "only fire when" gate.
  -- They become the version's entry conditions, evaluated by the same
  -- evaluateConditions() the builder uses. `in` accepts the raw CSV string
  -- (journeyTypes.ts compare()), which is exactly the shape the rule stored.
  CASE
    WHEN NULLIF(TRIM(COALESCE(r."conditionSources", '')), '') IS NULL
     AND r."minValueCents" IS NULL THEN NULL
    ELSE jsonb_build_object(
      'logic', 'and',
      'conditions',
        COALESCE(
          CASE WHEN NULLIF(TRIM(COALESCE(r."conditionSources", '')), '') IS NOT NULL
            THEN jsonb_build_array(jsonb_build_object(
                   'field', 'lead.source', 'operator', 'in', 'value', r."conditionSources"))
            ELSE '[]'::jsonb END, '[]'::jsonb)
        ||
        COALESCE(
          CASE WHEN r."minValueCents" IS NOT NULL
            THEN jsonb_build_array(jsonb_build_object(
                   'field', 'lead.valueCents', 'operator', 'greater_or_equal',
                   'value', r."minValueCents"))
            ELSE '[]'::jsonb END, '[]'::jsonb)
    )
  END AS entry_conditions,
  -- One step, matching what applyRule() did for that action. jsonb_strip_nulls
  -- removes unset optional keys: the step executor's stringConfig() treats a
  -- missing key and a null the same, but a stored null is noise in the builder.
  jsonb_strip_nulls(jsonb_build_object(
    'startStepId', 'step1',
    'steps', jsonb_build_array(jsonb_build_object(
      'id', 'step1',
      'name', r."name",
      'type', r."action",
      'nextStepId', NULL,
      'config', CASE r."action"
        WHEN 'create_activity' THEN jsonb_build_object(
          'activityType', COALESCE(r."activityType", 'todo'),
          -- applyRule appended the lead's name: `${summary || name} — ${lead.name}`.
          -- {{name}} is the journey template variable for the same thing.
          'summary', COALESCE(NULLIF(TRIM(COALESCE(r."activitySummary", '')), ''), r."name") || ' — {{name}}',
          'dueDays', COALESCE(r."activityDueDays", 1),
          'assignToId', r."assignToId")
        WHEN 'send_email' THEN jsonb_build_object('emailTemplateId', r."emailTemplateId")
        WHEN 'move_stage' THEN jsonb_build_object('stageId', r."targetStageId")
        WHEN 'assign_user' THEN jsonb_build_object('userId', r."assignToId")
        WHEN 'send_push' THEN jsonb_build_object('message', COALESCE(r."pushMessage", '{{name}}'))
        ELSE '{}'::jsonb
      END
    ))
  )) AS definition,
  to_jsonb(r) AS raw_row
FROM "AutomationRule" r;

INSERT INTO "Journey" (
  "id", "tenantId", "name", "description", "category", "status",
  "activeVersion", "createdById", "createdAt", "updatedAt"
)
SELECT
  'jrn_rule_' || md5(c."id"),
  c."tenantId",
  c."name",
  CASE WHEN c.convertible
    THEN 'Migrated from the retired Automations builder.'
    ELSE 'NEEDS REVIEW — migrated from the retired Automations builder, but its '
      || 'trigger/action pair has no journey equivalent so it was left paused '
      || 'and unpublished rather than dropped. Original rule: ' || c.raw_row::text
  END,
  -- 'automation', not 'marketing': the step executor only applies the
  -- marketing opt-out skip to the marketing category, and AutomationRule's
  -- send_email never checked opt-out. Categorising these as marketing would
  -- silently stop emails that fire today.
  'automation',
  CASE WHEN c.convertible AND c."active" THEN 'active' ELSE 'paused' END,
  CASE WHEN c.convertible THEN 1 ELSE NULL END,
  NULL,
  c."createdAt",
  CURRENT_TIMESTAMP
FROM "_rule_convert" c
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "JourneyVersion" (
  "id", "tenantId", "journeyId", "version", "state", "trigger",
  "triggerConfig", "entryConditions", "definition", "createdById",
  "createdAt", "publishedAt"
)
SELECT
  'jrv_rule_' || md5(c."id"),
  c."tenantId",
  'jrn_rule_' || md5(c."id"),
  1,
  -- Only a PUBLISHED version whose number equals Journey.activeVersion is ever
  -- executed (journeyEngineShared.getActiveVersion), so an unconvertible rule
  -- left as a draft cannot run no matter what its journey's status becomes.
  CASE WHEN c.convertible THEN 'published' ELSE 'draft' END,
  c."trigger",
  c.trigger_config,
  c.entry_conditions,
  CASE WHEN c.convertible
    THEN c.definition
    -- An empty definition parses (parseJourneyDefinition allows a null start)
    -- and enqueueJourneyRun refuses to start a run without a start step.
    ELSE '{"startStepId": null, "steps": []}'::jsonb
  END,
  NULL,
  c."createdAt",
  CASE WHEN c.convertible THEN CURRENT_TIMESTAMP ELSE NULL END
FROM "_rule_convert" c
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. lifecycleJourneys → Journey + JourneyVersion
-- ---------------------------------------------------------------------------
-- LIFECYCLE_ANNIVERSARY_ENABLED / LIFECYCLE_WINBACK_ENABLED drove a hardcoded
-- second copy of what journeyScheduling already implements field for field
-- (same month/day match, same years >= 1 rule, same inactive-months logic). A
-- tenant with the setting on AND an active journey was sending BOTH, because
-- the two dedupe stores (Communication.subject LIKE vs JourneyEvent.dedupeKey)
-- cannot see each other.
--
-- So: create the journey ONLY for a tenant that has the setting on and does NOT
-- already have an active journey on that trigger. Creating one for a tenant who
-- already has theirs is precisely the double-send this is meant to end.

CREATE TEMPORARY TABLE "_lifecycle_convert" AS
SELECT
  s."tenantId",
  'purchase_anniversary'::text AS trigger,
  'Purchase anniversary'::text AS name,
  'Happy {{years}}-year anniversary with your {{model}}! 🎉'::text AS subject,
  ('Hi {{first_name}},' || E'\n\n' ||
   'It''s been {{years}} year(s) since you got your {{model}} — thank you for being part of the Denago Cape Town family!' || E'\n\n' ||
   'If it''s due some love (a service, new accessories, or a battery health check), we''re a call away on 073 789 3438.' || E'\n\n' ||
   'Warm regards,' || E'\n' || 'Denago Cape Town')::text AS body,
  '{}'::jsonb AS trigger_config
FROM "AppSetting" s
WHERE s."key" = 'LIFECYCLE_ANNIVERSARY_ENABLED' AND s."value" = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM "Journey" j
    JOIN "JourneyVersion" v
      ON v."journeyId" = j."id" AND v."version" = j."activeVersion" AND v."state" = 'published'
    WHERE j."tenantId" IS NOT DISTINCT FROM s."tenantId"
      AND j."status" = 'active'
      AND v."trigger" = 'purchase_anniversary'
  )
UNION ALL
SELECT
  s."tenantId",
  'win_back',
  'Service win-back',
  'We miss you at Denago Cape Town',
  ('Hi {{first_name}},' || E'\n\n' ||
   'It''s been a while since we saw your {{model}}! A quick service keeps it running like new and protects its battery.' || E'\n\n' ||
   'Book now and we''ll take great care of it — call us on 073 789 3438.' || E'\n\n' ||
   'Warm regards,' || E'\n' || 'Denago Cape Town'),
  -- 12 months is the threshold winBackJourney hardcoded.
  '{"inactiveMonths": 12}'::jsonb
FROM "AppSetting" s
WHERE s."key" = 'LIFECYCLE_WINBACK_ENABLED' AND s."value" = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM "Journey" j
    JOIN "JourneyVersion" v
      ON v."journeyId" = j."id" AND v."version" = j."activeVersion" AND v."state" = 'published'
    WHERE j."tenantId" IS NOT DISTINCT FROM s."tenantId"
      AND j."status" = 'active'
      AND v."trigger" = 'win_back'
  );

INSERT INTO "Journey" (
  "id", "tenantId", "name", "description", "category", "status",
  "activeVersion", "createdById", "createdAt", "updatedAt"
)
SELECT
  'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId"),
  l."tenantId",
  l.name,
  'Migrated from the retired hardcoded lifecycle emails. The copy is editable here now.',
  -- 'marketing', unlike the converted rules: both of these ARE marketing, and
  -- lifecycleJourneys ran them through canContactPerson(purpose 'marketing').
  -- The step executor skips a marketing send for an opted-out contact, which is
  -- the closest equivalent the journey engine has. See the note in the report:
  -- portal-level marketing preferences are NOT re-checked by the journey engine.
  'marketing',
  'active',
  1,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_lifecycle_convert" l
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "JourneyVersion" (
  "id", "tenantId", "journeyId", "version", "state", "trigger",
  "triggerConfig", "entryConditions", "definition", "createdById",
  "createdAt", "publishedAt"
)
SELECT
  'jrv_lifecycle_' || md5(l.trigger || ':' || l."tenantId"),
  l."tenantId",
  'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId"),
  1,
  'published',
  l.trigger,
  l.trigger_config,
  NULL,
  jsonb_build_object(
    'startStepId', 'step1',
    'steps', jsonb_build_array(jsonb_build_object(
      'id', 'step1', 'name', l.name, 'type', 'send_email', 'nextStepId', NULL,
      'config', jsonb_build_object('subject', l.subject, 'body', l.body)
    ))
  ),
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_lifecycle_convert" l
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Do not re-send what the old engine already sent
-- ---------------------------------------------------------------------------
-- The journey the step above just activated will be enrolled by the very next
-- 15-minute cron tick, and it cannot see the old engine's dedupe store — which
-- was "is there a Communication whose subject contains [Purchase anniversary]
-- in the last 300 days". A contact emailed this morning would be emailed again
-- this afternoon.
--
-- Seed the journey engine's OWN dedupe store instead: a JourneyEvent already
-- marked processed, carrying exactly the dedupeKey runScheduledJourneyEnrollments
-- will compute. emitJourneyEvent swallows the resulting unique violation as
-- "already seen", so the enrolment is skipped rather than failing.
--
-- The key is sha256 of `${journeyId}:${version}:anniversary:${vehicleId}:${year}`,
-- matching hashJourneyKey in journeyEngineShared.ts.
--
-- This holds under every deploy ordering. If the old engine sends BEFORE this
-- runs, the Communication row exists and the seed suppresses the journey. If it
-- sends AFTER (old code still live), the journey was suppressed anyway. If it
-- never sends, nothing is seeded and the journey sends once. At most one email.

INSERT INTO "JourneyEvent" (
  "id", "tenantId", "journeyId", "type", "entityType", "entityId", "payload",
  "status", "attempts", "availableAt", "processedAt", "dedupeKey",
  "createdAt", "updatedAt"
)
SELECT
  'jev_migrated_anniv_' || md5(v."id"),
  l."tenantId",
  'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId"),
  'purchase_anniversary',
  'contact',
  v."contactId",
  jsonb_build_object('migratedFrom', 'lifecycleJourneys', 'vehicleId', v."id"),
  'processed',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  encode(sha256(convert_to(
    'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId")
      || ':1:anniversary:' || v."id" || ':' || EXTRACT(YEAR FROM CURRENT_DATE)::int::text,
    'UTF8')), 'hex'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_lifecycle_convert" l
JOIN "Vehicle" v ON v."tenantId" IS NOT DISTINCT FROM l."tenantId" AND v."deletedAt" IS NULL
WHERE l.trigger = 'purchase_anniversary'
  AND EXISTS (
    SELECT 1 FROM "Communication" c
    WHERE c."contactId" = v."contactId"
      AND c."subject" LIKE '%Purchase anniversary%'
      -- The window anniversaryJourney() itself used.
      AND c."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '300 days'
  )
ON CONFLICT DO NOTHING;

-- Same for win-back. Its dedupeKey is per CONTACT and per half-year window
-- (`${year}-${floor(month/6)+1}`), which is the same shape as the 180-day
-- suppression window winBackJourney() used.
INSERT INTO "JourneyEvent" (
  "id", "tenantId", "journeyId", "type", "entityType", "entityId", "payload",
  "status", "attempts", "availableAt", "processedAt", "dedupeKey",
  "createdAt", "updatedAt"
)
SELECT
  'jev_migrated_winback_' || md5(c."id"),
  l."tenantId",
  'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId"),
  'win_back',
  'contact',
  c."id",
  jsonb_build_object('migratedFrom', 'lifecycleJourneys'),
  'processed',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  encode(sha256(convert_to(
    'jrn_lifecycle_' || md5(l.trigger || ':' || l."tenantId")
      || ':1:winback:' || c."id" || ':'
      || EXTRACT(YEAR FROM CURRENT_DATE)::int::text || '-'
      || (FLOOR((EXTRACT(MONTH FROM CURRENT_DATE)::int - 1) / 6) + 1)::int::text,
    'UTF8')), 'hex'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_lifecycle_convert" l
JOIN "Contact" c ON c."tenantId" IS NOT DISTINCT FROM l."tenantId"
WHERE l.trigger = 'win_back'
  AND EXISTS (
    SELECT 1 FROM "Communication" m
    WHERE m."contactId" = c."id"
      AND m."subject" LIKE '%Win-back%'
      AND m."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '180 days'
  )
ON CONFLICT DO NOTHING;

-- The settings now have no reader and no writer. Left in place rather than
-- deleted so the migration is re-runnable and the historical choice is still
-- visible, but set to 'false' so nothing that inspects them (a support script, a
-- restored backup of the old code) concludes the old engine should run.
UPDATE "AppSetting"
SET "value" = 'false'
WHERE "key" IN ('LIFECYCLE_ANNIVERSARY_ENABLED', 'LIFECYCLE_WINBACK_ENABLED')
  AND "value" <> 'false';

-- ---------------------------------------------------------------------------
-- 4. Drop the retired tables
-- ---------------------------------------------------------------------------
-- Safe only because step 1 represents EVERY row: convertible rules became
-- runnable journeys, and unconvertible ones became paused journeys whose
-- description carries the complete original row. AutomationLog is the run
-- history of an engine that no longer exists; JourneyRun/JourneyStepLog is the
-- run history from here on.
DROP TABLE IF EXISTS "AutomationLog";
DROP TABLE IF EXISTS "AutomationRule";

DROP TABLE IF EXISTS "_rule_convert";
DROP TABLE IF EXISTS "_lifecycle_convert";

RESET app.bypass_rls;
