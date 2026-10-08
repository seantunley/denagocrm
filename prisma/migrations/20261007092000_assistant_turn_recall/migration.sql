-- DAX working memory and recall by meaning (no embeddings). Additive only.
--   state  the answer's own summary of the conversation (customer, topic, tags,
--          decided, open) — read back into the next question's prompt.
--   refs   the records the answer's lookups returned ("lead:<id>", …), so
--          recall finds a conversation about a customer however it was worded.
--   tags   state.tags as a column, for cheap overlap matching.
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "state" JSONB;
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "refs" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}';

-- Typo-tolerant word matching in recall ("Kristna" finds "Kristina").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Full-text search over the question and answer. The expression must match the
-- one recall() queries, word for word, or Postgres won't use it. Tags aren't in
-- it: array_to_string isn't IMMUTABLE, so it can't be indexed — tags are
-- matched by array overlap instead.
CREATE INDEX IF NOT EXISTS "AssistantTurn_search_idx"
  ON "AssistantTurn" USING GIN (to_tsvector('english', "question" || ' ' || "answer"));
