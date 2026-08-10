-- Analytics must never turn a successful customer action into a failed webhook.
--
-- botFlowAnalytics.ts states that rule and its standalone recorder honours it
-- with a try/catch. The BotSession trigger did not: it INSERTs into BotFlowEvent
-- inside the caller's transaction, so anything it raises aborts the customer's
-- turn — the flow position, the outbox rows and the CRM effects all roll back.
--
-- It has at least three ways to raise, none of them the customer's fault:
--
--   * BotFlowEvent."tenantId" is NOT NULL with an FK to Tenant, while
--     BotSession."tenantId" is nullable with no FK. A session row carrying NULL,
--     or naming a Tenant that was never seeded, makes the INSERT fail.
--   * `NULLIF(NEW."vars", '')::jsonb` raises on any value that is not valid JSON.
--     Nothing in the column's type prevents one.
--   * BotFlowEvent has FORCE ROW LEVEL SECURITY and this function is not
--     SECURITY DEFINER, so the INSERT is policy-checked. Every writer sets
--     app.bypass_rls today, but that is an application convention, not a
--     guarantee the database makes.
--
-- Wrapping the body means a failure loses one analytics row instead of the
-- conversation. The WARNING keeps it from being silent.
--
-- Note this deliberately does NOT change what is recorded — the body below is
-- the 20260809181500 function verbatim, moved inside a handler.

CREATE OR REPLACE FUNCTION "record_bot_flow_session_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id TEXT;
  old_version_id TEXT;
  old_node_type TEXT;
  progress_event TEXT;
  transition_kind TEXT;
BEGIN
  transition_kind := current_setting('app.bot_flow_transition', true);

  IF TG_OP = 'INSERT' THEN
    version_id := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__flow_version', NULLIF(NEW."vars", '')::jsonb ->> 'fv');
    IF NEW."status" = 'active' THEN
      INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
      VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'start'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_started', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
        VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'wait'), NEW."tenantId", NEW."channel", NEW."key", version_id, NEW."nodeId", 'node_waiting', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
      END IF;
    ELSIF NEW."status" = 'paused' AND NEW."nodeId" IS NULL AND version_id IS NOT NULL THEN
      INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt") VALUES
      ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'start-handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_started', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP),
      ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_version_id := COALESCE(NULLIF(OLD."vars", '')::jsonb ->> '__flow_version', NULLIF(OLD."vars", '')::jsonb ->> 'fv');
    version_id := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__flow_version', NULLIF(NEW."vars", '')::jsonb ->> 'fv', old_version_id);

    IF transition_kind = 'restart' THEN
      IF NEW."status" = 'active' THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
        VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_started', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
        IF NEW."nodeId" IS NOT NULL THEN
          INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
          VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart-wait'), NEW."tenantId", NEW."channel", NEW."key", version_id, NEW."nodeId", 'node_waiting', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
        END IF;
      ELSIF NEW."status" = 'paused' AND NEW."nodeId" IS NULL AND version_id IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt") VALUES
        ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart-handoff-start'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_started', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP),
        ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart-handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_handoff', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
      END IF;
      RETURN NEW;
    END IF;

    IF OLD."status" = 'paused' AND NEW."status" = 'active' THEN
      INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
      VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'resume'), NEW."tenantId", NEW."channel", NEW."key", version_id, NULL, 'flow_started', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
        VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'resume-wait'), NEW."tenantId", NEW."channel", NEW."key", version_id, NEW."nodeId", 'node_waiting', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
      END IF;
      RETURN NEW;
    END IF;

    IF OLD."status" = 'active' AND NEW."status" = 'active' AND OLD."nodeId" IS NOT NULL AND OLD."nodeId" IS DISTINCT FROM NEW."nodeId" THEN
      IF old_version_id IS NOT NULL THEN
        SELECT ("definition"::jsonb -> 'nodes' -> OLD."nodeId" ->> 'type') INTO old_node_type FROM "BotFlowVersion" WHERE "id" = old_version_id;
      END IF;
      progress_event := CASE old_node_type WHEN 'choice' THEN 'choice_selected' WHEN 'capture' THEN 'capture_submitted' WHEN 'captureFile' THEN 'capture_submitted' WHEN 'slots' THEN 'slot_selected' ELSE NULL END;
      IF progress_event IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
        VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || progress_event), NEW."tenantId", NEW."channel", NEW."key", COALESCE(old_version_id, version_id), OLD."nodeId", progress_event, jsonb_build_object('source','bot_session','nodeType',old_node_type), CURRENT_TIMESTAMP);
      END IF;
      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
        VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'next-wait'), NEW."tenantId", NEW."channel", NEW."key", version_id, NEW."nodeId", 'node_waiting', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
      END IF;
    END IF;

    IF OLD."status" = 'active' AND NEW."status" = 'paused' AND NEW."nodeId" IS NULL AND version_id IS NOT NULL THEN
      INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
      VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, OLD."nodeId", 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF transition_kind = 'restart' THEN RETURN OLD; END IF;
    old_version_id := COALESCE(NULLIF(OLD."vars", '')::jsonb ->> '__flow_version', NULLIF(OLD."vars", '')::jsonb ->> 'fv');
    IF OLD."status" = 'active' AND OLD."expiresAt" >= CURRENT_TIMESTAMP AND old_version_id IS NOT NULL THEN
      INSERT INTO "BotFlowEvent" ("id","tenantId","channel","conversationKey","flowVersionId","nodeId","eventType","metadata","occurredAt")
      VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || OLD."id" || 'complete'), OLD."tenantId", OLD."channel", OLD."key", old_version_id, OLD."nodeId", 'flow_completed', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;

EXCEPTION WHEN OTHERS THEN
  -- One analytics row is worth less than the customer's conversation. Report it
  -- and let the transaction that triggered us commit.
  RAISE WARNING 'record_bot_flow_session_event skipped (%): %', SQLSTATE, SQLERRM;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Top-up backfill. 20260722146000 filled BotSession."tenantId" once, but the
-- column is still nullable with no FK, and the trigger above copies it into a
-- NOT NULL column. Anything written tenantless since then would be a row the
-- tenant-scoped identity index cannot constrain either — Postgres treats NULLs
-- as distinct, so the UNIQUE (tenantId, channel, key) added by 20260809152000
-- does not constrain NULL-tenant rows at all.
-- BotSession carries FORCE ROW LEVEL SECURITY. Where the migrating role does not
-- bypass RLS, this backfill would match ZERO rows, SUCCEED, and be recorded as
-- applied — the exact "recorded but never really ran" shape behind this project's
-- earlier P2022 outage. Same escape hatch basePrisma uses.
SET app.bypass_rls = 'on';
UPDATE "BotSession" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
RESET app.bypass_rls;
