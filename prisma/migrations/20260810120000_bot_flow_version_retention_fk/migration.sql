-- Force BotFlowVersion -> BotFlow to ON DELETE RESTRICT, whatever is there now.
--
-- 20260809150000_bot_flow_publications exists as THREE different files under the
-- same directory name across this stack: RESTRICT on the lower branches, CASCADE
-- on #420-#424, RESTRICT again at the tip. Prisma records a migration by NAME, so
-- whichever version reaches a database first is the one that database keeps —
-- permanently, with no later run to reconcile it. A preview branch that applied
-- the CASCADE variant would silently keep CASCADE while the repository says
-- RESTRICT, and preview migrations have reached this project's production
-- database before.
--
-- CASCADE here is not cosmetic. BotFlowVersion rows are the immutable published
-- snapshots that live BotSessions pin themselves to. Under CASCADE, deleting a
-- BotFlow deletes the snapshot a customer is mid-conversation on; the runtime
-- then either fails closed (the branches carrying PinnedFlowVersionUnavailableError)
-- or silently resumes that customer's stored node and variables against a
-- DIFFERENT live graph (the branches that do not). Retention is the whole point
-- of the versioning work, so the database has to enforce it rather than trusting
-- whichever migration blob happened to land.
--
-- Reentrant: safe to re-run, and safe on a database that already has RESTRICT.
DO $$
DECLARE
  current_action "char";
BEGIN
  SELECT c.confdeltype INTO current_action
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE c.conname = 'BotFlowVersion_flowId_fkey'
     AND t.relname = 'BotFlowVersion';

  -- Absent: nothing to repair (the table is created with the constraint, so this
  -- only happens on a database that never ran 20260809150000 at all).
  IF current_action IS NULL THEN
    RAISE NOTICE 'BotFlowVersion_flowId_fkey not found — nothing to reconcile';
    RETURN;
  END IF;

  -- 'r' is RESTRICT. Already correct: leave it alone rather than taking an
  -- unnecessary ACCESS EXCLUSIVE lock on a table the runtime reads on every turn.
  IF current_action = 'r' THEN
    RETURN;
  END IF;

  RAISE NOTICE 'Reconciling BotFlowVersion_flowId_fkey from % to RESTRICT', current_action;
  ALTER TABLE "BotFlowVersion" DROP CONSTRAINT "BotFlowVersion_flowId_fkey";
  ALTER TABLE "BotFlowVersion"
    ADD CONSTRAINT "BotFlowVersion_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "BotFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END
$$;
