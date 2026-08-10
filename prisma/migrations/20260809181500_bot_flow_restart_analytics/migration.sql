-- Replace the BotSession analytics function with restart-aware semantics. Runtime
-- sets app.bot_flow_transition='restart' in the SAME transaction as the session
-- mutation. A restart is the start of a new funnel, not a progression/completion
-- of the old waiting node.
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

    -- Explicit restart replaces the old funnel boundary. Never classify the old
    -- waiting node as selected/captured merely because the new graph waits elsewhere.
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
END;
$$;
