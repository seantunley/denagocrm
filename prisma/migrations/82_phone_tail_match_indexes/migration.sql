-- Match a phone number by its digits, not by how somebody typed it.
--
-- Inbound WhatsApp/Messenger identity resolution compared the last 9 CHARACTERS
-- with `endsWith`, which needs a contiguous digit run — so a contact stored as
-- "082 123 4567" never matched the same person messaging from +27821234567, and
-- the CRM greeted an existing customer as a stranger. `ensureContact`, which the
-- chatbot calls before booking anything, was weaker still: exact string
-- equality, so any difference in formatting produced a duplicate Contact.
--
-- These indexes back the corrected comparison: strip non-digits, take the last
-- nine. The expression MUST stay character-for-character identical to
-- PHONE_TAIL_SQL in src/lib/phoneMatch.ts — Postgres matches expression indexes
-- textually, so a single character of drift silently downgrades every inbound
-- lookup to a sequential scan of the whole table. tests/phoneMatch.test.ts
-- asserts the two agree.
--
-- Additive and reversible: indexes only, no column is added, altered or
-- rewritten, and no row is touched. Dropping them would slow the lookup down
-- without changing a single answer it gives.
--
-- IMMUTABLE-safe: regexp_replace with a constant pattern and flags, right() and
-- coalesce() are all immutable, which is what allows them to be indexed at all.

CREATE INDEX IF NOT EXISTS "Contact_phone_tail_idx"
  ON "Contact" (right(regexp_replace(coalesce("phone", ''), '[^0-9]', '', 'g'), 9));

CREATE INDEX IF NOT EXISTS "Contact_whatsapp_tail_idx"
  ON "Contact" (right(regexp_replace(coalesce("whatsapp", ''), '[^0-9]', '', 'g'), 9));

CREATE INDEX IF NOT EXISTS "Lead_phone_tail_idx"
  ON "Lead" (right(regexp_replace(coalesce("phone", ''), '[^0-9]', '', 'g'), 9));
