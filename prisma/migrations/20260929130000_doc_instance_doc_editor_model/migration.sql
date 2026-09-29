-- Free-form documents move into the one document editor.
--
-- A per-record custom document (draft → final → filed PDF) keeps living in
-- "DocInstance" — same links, same tenant, same RLS policy, same soft delete —
-- and gains a column for the document editor's model. A row with
-- "docModelJson" set is edited and finalised by /doc-editor/document/[id]; a
-- row without it is a legacy Studio (BlockNote) document and is untouched.
--
-- "builderTemplateId" records which DocBuilderTemplate (key "custom") the
-- document was created from. Provenance only: nothing re-reads the template, so
-- editing or deleting it never changes a document already made from it.
--
-- Additive and empty on arrival: every existing row leaves both columns NULL.
-- No new table, so no new RLS policy or grant is needed.

ALTER TABLE "DocInstance" ADD COLUMN IF NOT EXISTS "docModelJson" JSONB;
ALTER TABLE "DocInstance" ADD COLUMN IF NOT EXISTS "builderTemplateId" TEXT;
