-- Drop the signing-request content fingerprint and its partial unique index.
--
-- Both existed for exactly one caller: createOrReuseSignatureRequestFromDoc(),
-- used by the document editor's "Prepare for signing" button. That button sent
-- a template against whatever record was chosen in the PREVIEW dropdown beside
-- it — a third way to create a signing envelope for a quote, from a design
-- tool — and has been removed. The function went with it.
--
-- Nothing writes the column any more, so the index protects nothing: it can
-- only ever see NULLs. The remaining signing paths serialise on the SOURCE
-- record instead (startRecordSigning takes a FOR UPDATE lock on the Quote /
-- JobCard row and short-circuits on an existing open request), which is a
-- stronger guarantee than a content hash — it covers edits, revisions and
-- status changes too, not just byte-identical re-sends.
--
-- Index first: dropping the column would take it anyway, but doing it
-- explicitly keeps the intent readable in the migration history.
DROP INDEX IF EXISTS "SignatureRequest_open_fingerprint_key";

ALTER TABLE "SignatureRequest" DROP COLUMN IF EXISTS "contentFingerprint";
