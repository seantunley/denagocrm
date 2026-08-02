-- Retire the AutomationRule engine and the hardcoded lifecycleJourneys, leaving
-- the Journey engine as the ONE answer to "when X happens to a lead, send an
-- email / create an activity / move a stage".
--
-- Three engines did that job. AutomationRule (src/lib/automations.ts, the
-- /automations builder) and lifecycleJourneys (src/lib/lifecycleJourneys.ts,
-- hardcoded anniversary + win-back copy behind two AppSettings) are gone from
-- the codebase in the same change as this migration. Their CONFIGURATION is not
-- gone: this converts it into Journey/JourneyVersion rows so nobody loses a rule
-- they had set up, and no tenant loses their anniversary emails. Their HISTORY
-- is not gone either: AutomationLog is copied into "RetiredAutomationLog" before
-- the drop (section 2).
--
-- RE-RUNNABILITY. This migration ends by DROPping "AutomationRule" and
-- "AutomationLog", so a second run — or a recovery run after PostgreSQL died
-- part-way through — reaches statements whose source tables no longer exist. A
-- plain re-run of the original script failed there with 42P01. Everything that
-- READS a retired table now lives inside a single PL/pgSQL DO block guarded on
-- `to_regclass('"AutomationRule"') IS NOT NULL`. PL/pgSQL does not parse or plan
-- a statement until it executes it, so with the guard false the block returns
-- immediately and the statements referencing the dropped tables are never
-- analysed — a clean no-op rather than an error. The block also holds the DROPs
-- themselves, which makes "archive, then drop" atomic: a crash mid-block rolls
-- back to a state where the source tables are still there and the next run
-- redoes the whole thing.
--
-- Everything OUTSIDE that block (sections 3-5) only touches tables that survive,
-- and is idempotent by deterministic id + ON CONFLICT DO NOTHING.

-- Journey, JourneyVersion and JourneyEvent are all FORCE ROW LEVEL SECURITY
-- (20260727130000_rls_enforce). FORCE applies to the table owner too, so a
-- migration inserting rows for many tenants would insert NOTHING without this:
-- the policy's own escape hatch, the same one basePrisma uses.
SET app.bypass_rls = 'on';

-- ---------------------------------------------------------------------------
-- 1. The archive table for AutomationLog history
-- ---------------------------------------------------------------------------
-- AutomationLog was the ONLY execution record the retired engine ever produced:
-- one row per rule firing, with the lead it fired on and what it did. Dropping
-- it would destroy the entire audit trail of what fired and when — there is no
-- second copy anywhere, and JourneyRun/JourneyStepLog only covers the engine
-- that replaces it, from today forward.
--
-- So the rows are copied here first. This table is RETAINED (it is a real
-- modelled table — `model RetiredAutomationLog` in prisma/schema.prisma — not a
-- temp table), append-only, and never written again after this migration.
--
-- Read it with:
--     SELECT * FROM "RetiredAutomationLog" ORDER BY "createdAt" DESC;
-- or through Prisma on the system path (RLS bypass), which is where audit data
-- is read from:
--     basePrisma.retiredAutomationLog.findMany({ orderBy: { createdAt: "desc" } })
--
-- It is DENORMALISED on purpose: AutomationLog only carried `ruleId`, and the
-- rule table is dropped in the same block, so a bare copy would be a pile of
-- orphaned ids. The rule's name/trigger/action are copied onto each row, plus
-- `journeyId` — the deterministic id of the Journey that rule became below — so
-- the history joins forward to the surviving engine:
--     SELECT l.*, j."name" FROM "RetiredAutomationLog" l
--       LEFT JOIN "Journey" j ON j."id" = l."journeyId";
CREATE TABLE IF NOT EXISTS "RetiredAutomationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT,
    "ruleTrigger" TEXT,
    "ruleAction" TEXT,
    "journeyId" TEXT,
    "leadId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetiredAutomationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RetiredAutomationLog_ruleId_leadId_idx"
  ON "RetiredAutomationLog"("ruleId", "leadId");
CREATE INDEX IF NOT EXISTS "RetiredAutomationLog_tenantId_idx"
  ON "RetiredAutomationLog"("tenantId");
CREATE INDEX IF NOT EXISTS "RetiredAutomationLog_journeyId_idx"
  ON "RetiredAutomationLog"("journeyId");

-- Same isolation AutomationLog itself had (20260727130000_rls_enforce): the
-- archive holds one tenant's lead ids, so it must not become the one table where
-- tenants can read each other's history.
ALTER TABLE "RetiredAutomationLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RetiredAutomationLog_tenant_isolation" ON "RetiredAutomationLog";
CREATE POLICY "RetiredAutomationLog_tenant_isolation" ON "RetiredAutomationLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "RetiredAutomationLog" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. AutomationRule → Journey + JourneyVersion, AutomationLog → the archive,
--    then drop both. One guarded, atomic block.
-- ---------------------------------------------------------------------------
-- Every AutomationRule trigger is also a Journey trigger under the same name,
-- and every action is a Journey step type under the same name, so the mapping
-- is one rule → one journey with a single step. A rule carrying a trigger or an
-- action outside those sets cannot be represented as a runnable step; it is
-- NOT dropped — it becomes a paused journey whose description holds the whole
-- original row, so it is reviewable by hand and can never fire on its own.
--
-- THE GUARD IS THE RE-RUN FIX. Read the block as if the tables are already
-- gone: to_regclass returns NULL, the block RETURNs, and not one statement
-- below the guard is ever parsed. Nothing here runs twice, and nothing here
-- errors on a second pass.
DO $retire_automation_rules$
BEGIN
  IF to_regclass('"AutomationRule"') IS NULL OR to_regclass('"AutomationLog"') IS NULL THEN
    RAISE NOTICE 'AutomationRule/AutomationLog already retired — nothing to convert or archive.';
    RETURN;
  END IF;

  -- A previous attempt in THIS session may have left the scratch table behind
  -- (temp tables are session-scoped, and this script is executed as one script
  -- by prisma db execute).
  DROP TABLE IF EXISTS "_rule_convert";

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
        || CASE WHEN c."action" = 'send_email'
             THEN ' CONSENT: this journey is categorised `marketing`, so its email is '
               || 'now checked against the one consent gate (canContactPerson). The '
               || 'AutomationRule it came from had NO consent check at all, so some '
               || 'sends that fire today will stop — opted-out, consent-withdrawn, '
               || 'portal-unsubscribed and frequency-capped recipients. That is '
               || 'deliberate: an unsubscribe that a rule can ignore is a POPIA breach.'
             ELSE '' END
      ELSE 'NEEDS REVIEW — migrated from the retired Automations builder, but its '
        || 'trigger/action pair has no journey equivalent so it was left paused '
        || 'and unpublished rather than dropped. Original rule: ' || c.raw_row::text
    END,
    -- CONSENT CATEGORY. This deliberately used to be 'automation' for every
    -- converted rule, to keep the step executor's marketing check off the path
    -- and so avoid stopping any send. That is the exact unsubscribe/POPIA hole
    -- the sibling consent-gate change closes, re-opened by migration: a rule
    -- that mails a lead is direct marketing whatever table it used to live in,
    -- and "we would rather not lose sends" is not a lawful basis.
    --
    -- The rule is NARROWER than a blanket recategorisation, because the category
    -- is a property of the whole journey and each converted rule is exactly one
    -- step: only a rule whose action is `send_email` becomes 'marketing'.
    -- create_activity / move_stage / assign_user contact nobody, and send_push
    -- goes to STAFF devices (sendPushToAll), not to the customer — marking those
    -- 'marketing' would be a false label that also mis-sorts them in the journeys
    -- list and would gate an internal task on a customer's mailing preference.
    CASE WHEN c."action" = 'send_email' THEN 'marketing' ELSE 'automation' END,
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

  -- ARCHIVE BEFORE DROP. This INSERT and the DROP TABLEs below it are in one
  -- block precisely so they cannot come apart: there is no ordering, crash or
  -- re-run in which the drop happens and the copy does not.
  INSERT INTO "RetiredAutomationLog" (
    "id", "tenantId", "ruleId", "ruleName", "ruleTrigger", "ruleAction",
    "journeyId", "leadId", "note", "createdAt", "archivedAt"
  )
  SELECT
    l."id",
    l."tenantId",
    l."ruleId",
    r."name",
    r."trigger",
    r."action",
    -- Non-null only when the rule row still existed, i.e. only when a Journey
    -- with that id was actually created above. A log whose rule was deleted
    -- years ago keeps its ruleId and points at nothing, which is the truth.
    CASE WHEN r."id" IS NOT NULL THEN 'jrn_rule_' || md5(r."id") ELSE NULL END,
    l."leadId",
    l."note",
    l."createdAt",
    CURRENT_TIMESTAMP
  FROM "AutomationLog" l
  LEFT JOIN "AutomationRule" r ON r."id" = l."ruleId"
  ON CONFLICT ("id") DO NOTHING;

  DROP TABLE IF EXISTS "_rule_convert";

  -- Safe only because everything above represents EVERY row: convertible rules
  -- became runnable journeys, unconvertible ones became paused journeys whose
  -- description carries the complete original row, and every AutomationLog row
  -- is now in "RetiredAutomationLog". JourneyRun/JourneyStepLog is the run
  -- history from here on.
  DROP TABLE IF EXISTS "AutomationLog";
  DROP TABLE IF EXISTS "AutomationRule";
END
$retire_automation_rules$;

-- ---------------------------------------------------------------------------
-- 3. lifecycleJourneys → Journey + JourneyVersion
-- ---------------------------------------------------------------------------
-- Nothing from here down reads a retired table, so none of it needs a guard;
-- it is idempotent on its own terms (deterministic ids + ON CONFLICT DO NOTHING,
-- and on a second run the AppSetting flags in section 5 are already 'false' so
-- "_lifecycle_convert" comes back empty and every INSERT matches no rows).
--
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

DROP TABLE IF EXISTS "_lifecycle_convert";

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
  -- 'marketing', like the converted send_email rules above: both of these ARE
  -- marketing, and lifecycleJourneys ran them through canContactPerson(purpose
  -- 'marketing'). The step executor gates a marketing send on the same policy,
  -- so the check survives the engine that hosted it.
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
-- 4. Do not re-send what the old engine already sent
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

-- ---------------------------------------------------------------------------
-- 5. Leave the retired switches off
-- ---------------------------------------------------------------------------
-- The settings now have no reader and no writer. Left in place rather than
-- deleted so the migration is re-runnable and the historical choice is still
-- visible, but set to 'false' so nothing that inspects them (a support script, a
-- restored backup of the old code) concludes the old engine should run.
UPDATE "AppSetting"
SET "value" = 'false'
WHERE "key" IN ('LIFECYCLE_ANNIVERSARY_ENABLED', 'LIFECYCLE_WINBACK_ENABLED')
  AND "value" <> 'false';

DROP TABLE IF EXISTS "_lifecycle_convert";

RESET app.bypass_rls;
