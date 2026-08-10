-- A handoff was attributed to no node at all.
--
-- The bot is not positioned anywhere once it hands over, so advanceFlow/runWhatsAppBot
-- write the paused session with `nodeId = NULL` — correct for the runtime, and it
-- meant every `flow_handoff` this trigger raises carried a NULL nodeId on the
-- INSERT path. That is the `handoffs` column the per-node funnel displays, so a
-- conversation handed off on its FIRST turn (before any session existed) counted
-- in the summary and pointed at nothing in the graph. The node that gives up on
-- customers was invisible in the one report built to find it.
--
-- The UPDATE path already had the answer — it reads OLD."nodeId", the node the bot
-- was waiting at. The INSERT and restart paths have no OLD row, so the runner now
-- records the node it ended on inside the stored vars, under a reserved key, the
-- same way __flow_version is already carried through this column.
--
-- Two key names because the two runners serialise differently and always have:
-- flowRun.ts stores flat vars (`__handoff_node`), flowSession.ts stores
-- { v, m, fv } (`hn`). This mirrors the existing __flow_version/fv pair exactly
-- rather than inventing a third convention.
--
-- Body is 20260810090000 verbatim apart from the handoff nodeId expression, and
-- CREATE OR REPLACE is inherently re-runnable.

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
  handoff_node TEXT;
BEGIN
  transition_kind := current_setting('app.bot_flow_transition', true);

  IF TG_OP = 'INSERT' THEN
    version_id := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__flow_version', NULLIF(NEW."vars", '')::jsonb ->> 'fv');
    handoff_node := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__handoff_node', NULLIF(NEW."vars", '')::jsonb ->> 'hn');
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
      ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, handoff_node, 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_version_id := COALESCE(NULLIF(OLD."vars", '')::jsonb ->> '__flow_version', NULLIF(OLD."vars", '')::jsonb ->> 'fv');
    version_id := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__flow_version', NULLIF(NEW."vars", '')::jsonb ->> 'fv', old_version_id);
    handoff_node := COALESCE(NULLIF(NEW."vars", '')::jsonb ->> '__handoff_node', NULLIF(NEW."vars", '')::jsonb ->> 'hn');

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
        ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart-handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, handoff_node, 'flow_handoff', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP);
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
      VALUES ('bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'), NEW."tenantId", NEW."channel", NEW."key", version_id, COALESCE(OLD."nodeId", handoff_node), 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP);
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
