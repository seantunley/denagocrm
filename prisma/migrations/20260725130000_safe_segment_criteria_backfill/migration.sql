-- 20260724183000_marketing_audiences_templates casts every non-empty
-- Segment.criteria directly to jsonb ("criteria"::jsonb). Segment.criteria is a
-- free-form historical string column — one malformed row throws and aborts
-- prisma migrate deploy's transaction entirely, rolling back the whole
-- migration (and, since that migration also creates the MarketingAudienceVersion
-- / MarketingTemplateVersion tables, blocking every later migration in this
-- stack behind it). That migration must never be edited in place once shipped
-- (checksum mismatch on replay — see 20260724235000's own note on the same
-- mistake); this is the correction, as a new forward migration.
--
-- denago_safe_jsonb never throws: valid JSON parses as before, and anything
-- else backfills to a distinct, explicitly-flagged marker instead of silently
-- becoming a same-shaped-but-wrong rule (marketingAudiences.ts's matchesNode
-- treats invalidHistoricalCriteria as "exclude until reviewed", not "match
-- everyone").
CREATE OR REPLACE FUNCTION denago_safe_jsonb(input text)
RETURNS jsonb AS $$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Idempotent re-run of the original backfill (WHERE "ruleTree" IS NULL): a
-- no-op wherever 20260724183000 already completed successfully (every
-- historical criteria was valid JSON), and the actual fix wherever that
-- migration previously aborted (this repo has never deployed either version
-- of it yet, but the guard makes this safe regardless).
UPDATE "Segment"
SET "ruleTree" = jsonb_build_object(
  'operator', 'AND',
  'rules', CASE
    WHEN "criteria" IS NULL OR "criteria" = '' THEN '[]'::jsonb
    WHEN denago_safe_jsonb("criteria") IS NOT NULL THEN jsonb_build_array(jsonb_build_object('legacyCriteria', denago_safe_jsonb("criteria")))
    ELSE jsonb_build_array(jsonb_build_object('legacyCriteria', jsonb_build_object('invalidHistoricalCriteria', true, 'raw', "criteria")))
  END,
  'exclusions', '[]'::jsonb
)
WHERE "ruleTree" IS NULL;
