-- DAX search_messages (roadmap Phase 2): full-text search over what was said to
-- and from a customer. Additive only: one index, no column, no row touched.
--
-- The expression MUST stay character-for-character COMMUNICATION_SEARCH_DOC in
-- src/lib/crmAssistantEvidence.ts — Postgres matches expression indexes
-- textually (tests/assistantEvidence.test.ts asserts the two agree).
--
-- left(…, 100000): to_tsvector fails on a document over 1 MB, and an index on
-- the uncapped body would make filing such an email FAIL, not just its search.
-- left() and coalesce() are immutable; to_tsvector with a constant config is too.
--
-- Not CONCURRENTLY, like every index migration here: apply-migrations runs each
-- statement on its own, and a failed concurrent build leaves an INVALID index
-- that IF NOT EXISTS would then skip for ever. The plain build locks writes to
-- Communication for the seconds it takes.
--
-- pg_trgm (close spellings) is already installed by 20261007092000; search
-- applies it to one customer's few hundred messages, so it needs no index.
CREATE INDEX IF NOT EXISTS "Communication_search_idx"
  ON "Communication" USING GIN (to_tsvector('english', left(coalesce("subject", '') || ' ' || "body", 100000)));
