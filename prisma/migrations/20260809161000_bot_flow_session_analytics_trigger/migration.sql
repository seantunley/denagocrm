-- Instrument the ONE cross-channel chatbot state machine instead of teaching each
-- provider adapter its own analytics semantics. BotSession already represents the
-- waiting node / human handoff / completion boundary for guided conversations.

CREATE OR REPLACE FUNCTION "record_bot_flow_session_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id TEXT;
  old_version_id TEXT;
  old_node_type TEXT;
  progress_event TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    version_id := COALESCE(
      NULLIF(NEW."vars", '')::jsonb ->> '__flow_version',
      NULLIF(NEW."vars", '')::jsonb ->> 'fv'
    );

    -- Normal first waiting point of a stateful flow.
    IF NEW."status" = 'active' THEN
      INSERT INTO "BotFlowEvent" (
        "id", "tenantId", "channel", "conversationKey", "flowVersionId",
        "nodeId", "eventType", "metadata", "occurredAt"
      ) VALUES (
        'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'start'),
        NEW."tenantId", NEW."channel", NEW."key", version_id,
        NULL, 'flow_started', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
      );

      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" (
          "id", "tenantId", "channel", "conversationKey", "flowVersionId",
          "nodeId", "eventType", "metadata", "occurredAt"
        ) VALUES (
          'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'wait'),
          NEW."tenantId", NEW."channel", NEW."key", version_id,
          NEW."nodeId", 'node_waiting', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
        );
      END IF;

    -- A flow can start and hand off in the same inbound turn. Manual takeover can
    -- also INSERT a paused row, but that row deliberately has no flow version; the
    -- version test keeps manual ownership from becoming a fake bot funnel.
    ELSIF NEW."status" = 'paused' AND NEW."nodeId" IS NULL AND version_id IS NOT NULL THEN
      INSERT INTO "BotFlowEvent" (
        "id", "tenantId", "channel", "conversationKey", "flowVersionId",
        "nodeId", "eventType", "metadata", "occurredAt"
      ) VALUES
      (
        'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'start-handoff'),
        NEW."tenantId", NEW."channel", NEW."key", version_id,
        NULL, 'flow_started', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
      ),
      (
        'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'),
        NEW."tenantId", NEW."channel", NEW."key", version_id,
        NULL, 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_version_id := COALESCE(
      NULLIF(OLD."vars", '')::jsonb ->> '__flow_version',
      NULLIF(OLD."vars", '')::jsonb ->> 'fv'
    );
    version_id := COALESCE(
      NULLIF(NEW."vars", '')::jsonb ->> '__flow_version',
      NULLIF(NEW."vars", '')::jsonb ->> 'fv',
      old_version_id
    );

    -- A previously paused conversation restarted into a stateful flow.
    IF OLD."status" = 'paused' AND NEW."status" = 'active' THEN
      INSERT INTO "BotFlowEvent" (
        "id", "tenantId", "channel", "conversationKey", "flowVersionId",
        "nodeId", "eventType", "metadata", "occurredAt"
      ) VALUES (
        'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart'),
        NEW."tenantId", NEW."channel", NEW."key", version_id,
        NULL, 'flow_started', '{"source":"bot_session","restart":true}'::jsonb, CURRENT_TIMESTAMP
      );
      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" (
          "id", "tenantId", "channel", "conversationKey", "flowVersionId",
          "nodeId", "eventType", "metadata", "occurredAt"
        ) VALUES (
          'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'restart-wait'),
          NEW."tenantId", NEW."channel", NEW."key", version_id,
          NEW."nodeId", 'node_waiting', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
        );
      END IF;
      RETURN NEW;
    END IF;

    -- Progress from one waiting node to another. Resolve the OLD node's type from
    -- the immutable published snapshot so interaction metrics keep their meaning.
    IF OLD."status" = 'active'
       AND NEW."status" = 'active'
       AND OLD."nodeId" IS NOT NULL
       AND OLD."nodeId" IS DISTINCT FROM NEW."nodeId"
    THEN
      IF old_version_id IS NOT NULL THEN
        SELECT ("definition"::jsonb -> 'nodes' -> OLD."nodeId" ->> 'type')
          INTO old_node_type
          FROM "BotFlowVersion"
         WHERE "id" = old_version_id;
      END IF;

      progress_event := CASE old_node_type
        WHEN 'choice' THEN 'choice_selected'
        WHEN 'capture' THEN 'capture_submitted'
        WHEN 'captureFile' THEN 'capture_submitted'
        WHEN 'slots' THEN 'slot_selected'
        ELSE NULL
      END;

      IF progress_event IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" (
          "id", "tenantId", "channel", "conversationKey", "flowVersionId",
          "nodeId", "eventType", "metadata", "occurredAt"
        ) VALUES (
          'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || progress_event),
          NEW."tenantId", NEW."channel", NEW."key", COALESCE(old_version_id, version_id),
          OLD."nodeId", progress_event, jsonb_build_object('source', 'bot_session', 'nodeType', old_node_type), CURRENT_TIMESTAMP
        );
      END IF;

      IF NEW."nodeId" IS NOT NULL THEN
        INSERT INTO "BotFlowEvent" (
          "id", "tenantId", "channel", "conversationKey", "flowVersionId",
          "nodeId", "eventType", "metadata", "occurredAt"
        ) VALUES (
          'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'next-wait'),
          NEW."tenantId", NEW."channel", NEW."key", version_id,
          NEW."nodeId", 'node_waiting', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
        );
      END IF;
    END IF;

    -- Bot handoff writes paused + NULL nodeId. Manual takeover preserves the
    -- current nodeId, so it must not be counted as an AI/flow handoff conversion.
    IF OLD."status" = 'active'
       AND NEW."status" = 'paused'
       AND NEW."nodeId" IS NULL
       AND version_id IS NOT NULL
    THEN
      INSERT INTO "BotFlowEvent" (
        "id", "tenantId", "channel", "conversationKey", "flowVersionId",
        "nodeId", "eventType", "metadata", "occurredAt"
      ) VALUES (
        'bfe_' || md5(random()::text || clock_timestamp()::text || NEW."id" || 'handoff'),
        NEW."tenantId", NEW."channel", NEW."key", version_id,
        OLD."nodeId", 'flow_handoff', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
      );
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_version_id := COALESCE(
      NULLIF(OLD."vars", '')::jsonb ->> '__flow_version',
      NULLIF(OLD."vars", '')::jsonb ->> 'fv'
    );

    -- Normal flow completion deletes an ACTIVE, still-live session. Expiry cleanup
    -- also deletes active rows, but only after expiresAt; exclude it so abandoned
    -- sessions do not masquerade as successful completions. Returning a manually
    -- paused conversation to the bot deletes status=paused and is excluded too.
    IF OLD."status" = 'active'
       AND OLD."expiresAt" >= CURRENT_TIMESTAMP
       AND old_version_id IS NOT NULL
    THEN
      INSERT INTO "BotFlowEvent" (
        "id", "tenantId", "channel", "conversationKey", "flowVersionId",
        "nodeId", "eventType", "metadata", "occurredAt"
      ) VALUES (
        'bfe_' || md5(random()::text || clock_timestamp()::text || OLD."id" || 'complete'),
        OLD."tenantId", OLD."channel", OLD."key", old_version_id,
        OLD."nodeId", 'flow_completed', '{"source":"bot_session"}'::jsonb, CURRENT_TIMESTAMP
      );
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "BotSession_flow_analytics" ON "BotSession";
CREATE TRIGGER "BotSession_flow_analytics"
AFTER INSERT OR UPDATE OR DELETE ON "BotSession"
FOR EACH ROW EXECUTE FUNCTION "record_bot_flow_session_event"();
