-- =============================================================================
-- WHICH LEAD DID THIS CONTACT'S NOTE COME FROM?
-- =============================================================================
--
-- Converting a lead copies its notes onto the contact it becomes. The contact
-- timeline also shows the notes of every lead linked to that contact, so a
-- converted lead printed the same sentence twice — once as the contact's note,
-- once as the lead's.
--
-- The first fix compared the TEXT and dropped the lead note when it matched.
-- Review was right that this is not provenance: an existing customer whose own
-- note happens to read the same as a later, unrelated lead's note has TWO genuine
-- CRM events, and text equality silently deletes one of them from the history.
--
-- A timeline is a record of what happened. It should know which lead supplied the
-- copy rather than infer it from a sentence.
--
-- Additive: one nullable column. Nothing is dropped and no existing value changes.

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "notesFromLeadId" TEXT;

-- ── Backfill, once, for contacts converted before this column existed ────────
--
-- These have no provenance recorded and never will — the conversion that copied
-- the note happened months ago. The text heuristic is used HERE, deliberately,
-- because applied once to historical rows it is a cleanup with a bounded blast
-- radius that can be inspected; applied on every render it was a permanent rule
-- that could hide a real note. Same comparison, entirely different risk.
--
-- Narrow on purpose:
--   * the lead must be linked to THIS contact, so an identical note on an
--     unrelated lead is untouched;
--   * the note must be non-empty, or every contact with a blank note would be
--     attributed to some arbitrary lead;
--   * exactly ONE candidate lead, so an ambiguous case is left null rather than
--     guessed. A null simply shows both entries, which is the safe direction.
UPDATE "Contact" c
SET "notesFromLeadId" = candidate.id
FROM (
  SELECT l."contactId", MIN(l."id") AS id, COUNT(*) AS matches
    FROM "Lead" l
    JOIN "Contact" c2 ON c2."id" = l."contactId"
   WHERE l."deletedAt" IS NULL
     AND l."notes" IS NOT NULL
     AND btrim(l."notes") <> ''
     AND btrim(regexp_replace(l."notes", '\s+', ' ', 'g'))
       = btrim(regexp_replace(COALESCE(c2."notes", ''), '\s+', ' ', 'g'))
   GROUP BY l."contactId"
) AS candidate
WHERE c."id" = candidate."contactId"
  AND candidate.matches = 1
  AND c."notesFromLeadId" IS NULL;
